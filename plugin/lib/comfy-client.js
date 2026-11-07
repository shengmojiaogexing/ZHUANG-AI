/**
 * 幻梦AI · ComfyUI 客户端（传输层）
 *
 * 这一层只干一件事：把 ComfyUI 的 HTTP 接口包成好用的函数，并把各种失败
 * 翻译成用户看得懂的话。它不碰 DOM，也不碰 Photoshop，出了问题定位范围小。
 *
 * 接口全部来自 ComfyUI 官方 HTTP API，实测于 ComfyUI 0.37.0：
 *   GET  /system_stats              探活 + 版本
 *   GET  /object_info               全部节点定义（本机实测 972 节点 / 1.8MB / 163ms）
 *   POST /prompt                    下单，body {prompt, client_id}
 *   GET  /history/{prompt_id}       取结果
 *   GET  /view?filename=&subfolder=&type=   取图（返回二进制）
 *   POST /upload/image              上传参考图（multipart）
 *   POST /interrupt                 中断当前任务
 *   GET  /queue                     队列状态
 *
 * ⚠️ 本机实测 ComfyUI 默认不开 CORS（access-control-allow-origin 为空）。
 *    如果 UXP 的 fetch 按浏览器规则强制校验 CORS，所有请求都会以
 *    TypeError: Failed to fetch 失败。届时只需改本文件的 request()，
 *    换成走幻梦圆环代理即可，上层 comfy-form / comfy-panel 不用动。
 */
(function () {
    'use strict';

    const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
    const CONFIG_KEY = 'huanmeng_comfy_config_v1';
    const CLIENT_ID_KEY = 'huanmeng_comfy_client_id_v1';

    // 探活要快，别让用户干等
    const TIMEOUT_FAST = 8000;
    // object_info 有 1.8MB，给宽一点
    const TIMEOUT_INFO = 30000;
    // 下单本身很快，慢的是出图，出图靠轮询，不占这里的超时
    const TIMEOUT_SUBMIT = 20000;
    // 取图可能几 MB
    const TIMEOUT_IMAGE = 60000;

    function readConfig() {
        try {
            const raw = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
            return raw && typeof raw === 'object' ? raw : {};
        } catch (error) {
            return {};
        }
    }

    function writeConfig(patch) {
        const next = Object.assign({}, readConfig(), patch || {});
        try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
        } catch (error) {
            console.warn('[comfy] 配置写入失败:', error);
        }
        return next;
    }

    /**
     * 把用户手填的地址收拾干净。
     * 常见输入：127.0.0.1:8188 / http://127.0.0.1:8188/ / localhost:8188
     * 都补成带协议、不带尾斜杠的形式。
     */
    function normalizeBaseUrl(input) {
        let url = String(input == null ? '' : input).trim();
        if (!url) return DEFAULT_BASE_URL;
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        return url.replace(/\/+$/, '');
    }

    function getBaseUrl() {
        const config = readConfig();
        return normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
    }

    function setBaseUrl(url) {
        const normalized = normalizeBaseUrl(url);
        writeConfig({ baseUrl: normalized });
        return normalized;
    }

    /**
     * ComfyUI 用 client_id 把执行事件路由到对应的浏览器标签。
     * 我们走轮询，这个 id 不是必需的，但给一个稳定的值没坏处，
     * 也让 ComfyUI 后台日志里能认出是谁在提交。
     */
    function getClientId() {
        let id = '';
        try {
            id = localStorage.getItem(CLIENT_ID_KEY) || '';
        } catch (error) {
            id = '';
        }
        if (!id) {
            id = 'huanmeng-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
            try {
                localStorage.setItem(CLIENT_ID_KEY, id);
            } catch (error) {
                // 存不下就算了，进程内用着就行
            }
        }
        return id;
    }

    /**
     * 统一构造错误对象。
     * kind 给上层做分支用，message 直接是能展示给小白的中文。
     */
    function makeError(kind, message, detail) {
        const error = new Error(message);
        error.kind = kind;
        if (detail) error.detail = detail;
        return error;
    }

    function describeNetworkFailure(url) {
        // 界面上不显示服务地址（地址在「设置 → ComfyUI」里配置），这里也不回显 url。
        return '连不上 ComfyUI。\n'
            + '请依次确认：\n'
            + '① ComfyUI 是否已经启动（它的窗口开着吗）；\n'
            + '② 服务地址填对了没有（本地地址在「设置 → ComfyUI」里改）；\n'
            + '③ 如果上面都没问题，多半是 ComfyUI 没开跨域访问。\n'
            + '   在 ComfyUI 的启动参数里加上 --enable-cors-header 然后重启，\n'
            + '   Desktop 版在「设置 → 服务器配置 → 额外启动参数」里填。';
    }

    /**
     * 带超时的 fetch。
     * 不用 AbortController：UXP 对它的支持随版本浮动，Promise.race 更稳。
     * 代价是超时后请求仍在后台跑，但对我们这种一次性调用无所谓。
     */
    function fetchWithTimeout(url, options, timeoutMs) {
        const timer = new Promise(function (resolve, reject) {
            setTimeout(function () {
                reject(makeError('timeout', 'ComfyUI 响应超时（已等待 ' + Math.round(timeoutMs / 1000) + ' 秒）。\n'
                    + '它可能正在出图或卡住了。稍等一下重试；如果一直这样，去 ComfyUI 窗口里点「中断」。', { url: url }));
            }, timeoutMs);
        });
        return Promise.race([fetch(url, options), timer]);
    }

    // ------------------------------------------------------ 字节与编码
    //
    // 走圆环代理时数据是以 base64 传输的，两头都要在「字符串 / 字节」之间转。
    // 优先用 TextEncoder/TextDecoder，但它们不是每个 UXP 版本都有，所以各带一个
    // 自带实现兜底 —— 不能因为缺一个 API 就让中文提示词变成乱码。

    function encodeUtf8(text) {
        const value = String(text == null ? '' : text);
        if (typeof TextEncoder !== 'undefined') {
            try { return new TextEncoder().encode(value); } catch (error) { /* 退到自带实现 */ }
        }
        const out = [];
        for (let index = 0; index < value.length; index++) {
            let code = value.charCodeAt(index);
            // 代理对要合成一个码点，否则 emoji 和生僻字会被编坏
            if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
                const next = value.charCodeAt(index + 1);
                if (next >= 0xDC00 && next <= 0xDFFF) {
                    code = ((code - 0xD800) << 10) + (next - 0xDC00) + 0x10000;
                    index += 1;
                }
            }
            if (code < 0x80) out.push(code);
            else if (code < 0x800) out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
            else if (code < 0x10000) out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
            else out.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        }
        return new Uint8Array(out);
    }

    function decodeUtf8(bytes) {
        const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        if (typeof TextDecoder !== 'undefined') {
            try { return new TextDecoder('utf-8').decode(array); } catch (error) { /* 退到自带实现 */ }
        }
        let out = '';
        let index = 0;
        while (index < array.length) {
            const byte = array[index];
            let code = 0;
            let extra = 0;
            if (byte < 0x80) { code = byte; extra = 0; }
            else if ((byte & 0xE0) === 0xC0) { code = byte & 0x1F; extra = 1; }
            else if ((byte & 0xF0) === 0xE0) { code = byte & 0x0F; extra = 2; }
            else if ((byte & 0xF8) === 0xF0) { code = byte & 0x07; extra = 3; }
            else { index += 1; continue; }   // 坏字节，跳过
            if (index + extra >= array.length) break;
            for (let k = 0; k < extra; k++) {
                code = (code << 6) | (array[index + 1 + k] & 0x3F);
            }
            index += extra + 1;
            if (code > 0xFFFF) {
                code -= 0x10000;
                out += String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
            } else {
                out += String.fromCharCode(code);
            }
        }
        return out;
    }

    function bytesToBase64(bytes) {
        const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        let binary = '';
        const chunk = 0x8000;
        for (let index = 0; index < array.length; index += chunk) {
            binary += String.fromCharCode.apply(null, array.subarray(index, index + chunk));
        }
        return btoa(binary);
    }

    function parseErrorMessage(url) {
        return 'ComfyUI 返回的内容看不懂（解析失败）。\n'
            + '这通常说明地址填到了别的服务上——比如填成了 WebUI 的端口。';
    }

    /** 按 as 把字节解成调用方要的形态 */
    function decodeBody(bytes, as, url) {
        if (as === 'bytes') return bytes;
        const text = decodeUtf8(bytes);
        if (as === 'text') return text;
        if (!text) {
            // 空 body 当 JSON 解是错的。这里必须抛而不是返回 null ——
            // 返回 null 会和「圆环不可用」的那个 null 撞上，调用方就分不清了。
            throw makeError('parse', parseErrorMessage(url), { url: url, raw: '' });
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            throw makeError('parse', parseErrorMessage(url), { url: url, raw: text.slice(0, 200) });
        }
    }

    function tryParseJson(bytes) {
        try { return JSON.parse(decodeUtf8(bytes)); } catch (error) { return null; }
    }

    // ------------------------------------------------------ 传输选择
    //
    // 'unknown' 还没定 | 'direct' 直连 | 'ring' 经幻梦圆环代发

    let transport = 'unknown';

    function getTransport() { return transport; }

    function ringBridge() {
        const api = (typeof window !== 'undefined' && window.HuanmengRingBridge) || null;
        if (!api || typeof api.comfyRequest !== 'function') return null;
        return api;
    }

    function isRingUsable() {
        const bridge = ringBridge();
        if (!bridge) return false;
        if (typeof bridge.isConnected !== 'function') return false;
        try { return bridge.isConnected() === true; } catch (error) { return false; }
    }

    /**
     * 只有「根本没握上手」才值得退回代理。
     * 超时和服务器明确报的错都是正常结果，重试一遍只是浪费时间。
     */
    function isTransportFailure(error) {
        return !!error && error.kind === 'network';
    }

    async function directRequest(url, method, opts, as, timeoutMs, base) {
        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: method,
                headers: opts.headers,
                body: opts.body
            }, timeoutMs);
        } catch (error) {
            if (error && error.kind) throw error;
            throw makeError('network', describeNetworkFailure(base), { url: url, raw: String(error && error.message || error) });
        }

        if (!response.ok) {
            let bodyText = '';
            try {
                bodyText = await response.text();
            } catch (error) {
                bodyText = '';
            }
            // 尽量把 body 解成对象一起带出去。
            // 实测：ComfyUI 校验工作流失败时返回的是 **HTTP 400 + body 里的 node_errors**，
            // 不是 HTTP 200。不把解析结果传下去的话，调用方只剩一大坨原始 JSON 能甩给用户，
            // 而这恰恰是客户最容易撞上的场景（导入的工作流跟本地模型对不上）。
            let parsed = null;
            try {
                parsed = bodyText ? JSON.parse(bodyText) : null;
            } catch (error) {
                parsed = null;
            }
            const snippet = bodyText ? bodyText.slice(0, 300) : '（无响应内容）';
            const httpError = makeError('http', 'ComfyUI 返回错误 ' + response.status + '。\n' + snippet, {
                status: response.status,
                url: url,
                body: bodyText
            });
            // parsed 单独挂在 error.parsed 上，不走 makeError 的 detail 袋子。
            // 这里踩过一次坑：makeError 的第三个参数挂的是 error.detail，
            // 而 translatePromptError 读的是 error.parsed —— 于是友好文案永远不生效，
            // 用户看到的还是原始 JSON。更麻烦的是，离线单测因为自己手搓了一个
            // 带 .parsed 的错误对象，照样通过，只有真机才暴露。
            httpError.parsed = parsed;
            throw httpError;
        }

        try {
            if (as === 'bytes') {
                const buffer = await response.arrayBuffer();
                return new Uint8Array(buffer);
            }
            if (as === 'text') return await response.text();
            return await response.json();
        } catch (error) {
            throw makeError('parse', parseErrorMessage(url), { url: url, raw: String(error && error.message || error) });
        }
    }

    /**
     * 走幻梦圆环代发。
     * 圆环没在跑就返回 **null**（不是抛）—— 调用方据此决定是切传输还是抛原错误。
     *
     * 圆环那边一律按原始字节 base64 回来，不区分 JSON 和图片，
     * 免得两头对「这是个 JSON 还是二进制」的判断不一致。
     */
    async function ringRequest(url, method, opts, as, timeoutMs) {
        const bridge = ringBridge();
        if (!bridge) return null;

        // 请求体两条路：
        //   · __bytes：已经是字节（multipart 上传就是这种 —— 绝不能过 encodeUtf8，
        //     二进制经 UTF-8 编码会被搞坏）
        //   · body：字符串（JSON 之类），编码成 UTF-8 字节再 base64
        let bodyBase64 = '';
        if (opts.__bytes) {
            bodyBase64 = bytesToBase64(opts.__bytes);
        } else if (opts.body) {
            bodyBase64 = bytesToBase64(encodeUtf8(String(opts.body)));
        }

        const contentType = (opts.headers && opts.headers['Content-Type'])
            || (opts.contentType) || '';

        const result = await bridge.comfyRequest({
            url: url,
            method: method,
            bodyBase64: bodyBase64,
            contentType: contentType,
            // 比直连多给几秒：中间多了一趟进程间往返
            timeoutMs: timeoutMs + 5000
        });

        if (result.unavailable) return null;

        if (result.blocked) {
            throw makeError('blocked', result.error || '幻梦圆环拒绝了这个代理请求。');
        }

        if (!result.ok) {
            if (!result.status) {
                // 圆环自己就没连上 ComfyUI
                throw makeError('network', '圆环也没能连上 ComfyUI。\n'
                    + (result.error || '') + '\n\n请确认 ComfyUI 正在运行，上面那个地址也对。', { url: url });
            }
            // 和直连那条路保持一致：body 解出来挂到 error.parsed 上，
            // 上层（queuePrompt）才翻译得出「缺模型」这种人话
            const httpError = makeError('http', 'ComfyUI 返回错误 ' + result.status + '。', {
                status: result.status,
                url: url
            });
            httpError.parsed = tryParseJson(result.bytes);
            if (!httpError.parsed && result.error) httpError.message = result.error;
            throw httpError;
        }

        return decodeBody(result.bytes, as, url);
    }

    /**
     * 发一个请求。
     * as = 'json' | 'text' | 'bytes'
     *
     * 传输自动选：
     *   - 直连能通就一直直连，不折腾圆环
     *   - 直连被浏览器层拦掉（UXP 的 fetch 强制校验 CORS，而 ComfyUI 默认不下发
     *     access-control-allow-origin 头）→ 自动改走幻梦圆环代发
     *   - 定下来之后不再反复试：每次先失败一次再重试，会让 1.8MB 的
     *     /object_info 白等好几秒
     */
    async function request(path, options) {
        const opts = options || {};
        const as = opts.as || 'json';
        const base = getBaseUrl();
        const url = path.indexOf('http') === 0 ? path : base + path;
        const timeoutMs = opts.timeout || TIMEOUT_FAST;
        const method = opts.method || 'GET';

        if (transport === 'ring' || (opts.preferRing === true && isRingUsable())) {
            const viaRing = await ringRequest(url, method, opts, as, timeoutMs);
            if (viaRing !== null) return viaRing;
            // 圆环刚才还在、一转眼不可用 —— 掉回下面直连
        }

        try {
            const value = await directRequest(url, method, opts, as, timeoutMs, base);
            if (transport === 'unknown') transport = 'direct';
            return value;
        } catch (error) {
            if (!isTransportFailure(error)) throw error;

            const fallback = await ringRequest(url, method, opts, as, timeoutMs);
            if (fallback === null) throw error; // 圆环也不在，把原来那个错误抛出去

            transport = 'ring';
            console.log('[comfy] 直连被拦（多半是 CORS），已自动改走幻梦圆环代发');
            return fallback;
        }
    }

    // ---------------------------------------------------------------- 探活

    /**
     * 拿系统信息。用来做「测试连接」。
     * 返回里的 comfyui_version 能直接显示给用户，出问题时也好排查。
     */
    async function systemStats() {
        return request('/system_stats', { as: 'json', timeout: TIMEOUT_FAST });
    }

    // ---------------------------------------------------------- 节点定义

    // /object_info 有 1.8MB，每次进面板都拉一遍太浪费。
    // 只放内存，不进 localStorage：那个配额通常只有 5~10MB，塞不下，
    // 而且 QuotaExceededError 会连带把别的配置写坏。
    let objectInfoCache = null;
    let objectInfoCacheAt = 0;
    const OBJECT_INFO_TTL = 5 * 60 * 1000;

    async function objectInfo(forceRefresh) {
        const now = Date.now();
        if (!forceRefresh && objectInfoCache && (now - objectInfoCacheAt) < OBJECT_INFO_TTL) {
            return objectInfoCache;
        }
        const info = await request('/object_info', { as: 'json', timeout: TIMEOUT_INFO });
        if (!info || typeof info !== 'object') {
            throw makeError('parse', 'ComfyUI 返回的节点列表格式不对，无法生成参数界面。');
        }
        objectInfoCache = info;
        objectInfoCacheAt = now;
        return info;
    }

    function clearObjectInfoCache() {
        objectInfoCache = null;
        objectInfoCacheAt = 0;
    }

    // ------------------------------------------------------ 已保存的工作流

    /**
     * 列出 ComfyUI 里保存的工作流（就是工作流浏览器里那些）。
     *
     * ⚠️ 它们是**界面格式**，不转成 API 格式不能直接跑 ——
     * 转换在 comfy-convert.js 里做。
     */
    async function listUserWorkflows(folder) {
        const dir = folder || 'workflows';
        const result = await request('/userdata?dir=' + encodeURIComponent(dir) + '&full_info=true', {
            as: 'json',
            timeout: TIMEOUT_INFO
        });
        if (!Array.isArray(result)) return [];

        return result.filter(function (item) {
            if (!item || typeof item.path !== 'string') return false;
            if (item.path.toLowerCase().indexOf('.json') < 0) return false;
            // 自动备份目录不进列表：那些是 ComfyUI 自己每几分钟存的快照，
            // 一个工作流能有几十份，混进来会把列表淹掉
            if (item.path.indexOf('_wf_backups') >= 0) return false;
            return true;
        }).map(function (item) {
            return {
                name: item.path,
                size: Number(item.size) || 0,
                modified: Number(item.modified) || 0
            };
        }).sort(function (a, b) {
            return b.modified - a.modified; // 最近改的排前面
        });
    }

    /**
     * 读一份已保存的工作流，返回原始文本。
     *
     * ⚠️ 路径编码有讲究：要把 **「workflows/名字.json」整串当一个片段**编码，
     * 斜杠变成 %2F。实测写成 /userdata/workflows/名字 是 404 ——
     * 路由是 /userdata/{file} 单参数，斜杠会被当成路径分隔符吃掉。
     */
    async function readUserWorkflow(name, folder) {
        const dir = folder || 'workflows';
        const full = dir + '/' + String(name || '');
        return request('/userdata/' + encodeURIComponent(full), {
            as: 'text',
            timeout: TIMEOUT_INFO
        });
    }

    // ------------------------------------------------------------ 出图

    /**
     * 把 ComfyUI 的 node_errors 说成人话。
     *
     * 实测结构：{ 节点号: { errors: [{ type, message, details }], class_type } }
     * 其中 details 往往才是最有用的那半句 ——
     * 比如缺模型时 message 只有干巴巴的 "Value not in list"，
     * 真正的信息 "ckpt_name: 'xxx.safetensors' not in [...]" 在 details 里。
     * 只取 message 的话，用户看完还是不知道该干嘛。
     */
    function describeNodeErrors(nodeErrors) {
        const ids = Object.keys(nodeErrors || {});
        if (ids.length === 0) return '工作流没有通过 ComfyUI 的校验，但没有给出具体原因。';

        const firstId = ids[0];
        const firstNode = nodeErrors[firstId] || {};
        const errors = Array.isArray(firstNode.errors) ? firstNode.errors : [];
        const detail = errors[0] || {};

        const lines = [];
        const where = '#' + firstId + (firstNode.class_type ? '（' + firstNode.class_type + '）' : '');

        // 「引用的图片不在了」要单独说 —— 它是**唯一**一种用户当场就能自己修好的情况，
        // 而下面那段通用文案（缺模型 / 去 ComfyUI 里跑通）对它完全是误导：
        // 用户会跑去 ComfyUI 里找模型，而真正该做的是重新选一张图。
        //
        // 实测成因：别的插件（如 SD-PPP）往 ComfyUI 的 input 目录里放的临时图，
        // 后来被它自己清掉了，工作流里却还留着那个文件名。
        const detailText = String(detail.details || '') + ' ' + String(detail.message || '');
        if (/Invalid image file/i.test(detailText)) {
            lines.push('这个工作流要用的图片不在了。');
            lines.push('');
            lines.push('具体是：' + (detail.details || detail.message || '引用的图片文件无效'));
            lines.push('出问题的节点：' + where);
            lines.push('');
            lines.push('多半是别的插件（比如 SD-PPP）先前放在 ComfyUI 里的临时图，后来被清掉了，');
            lines.push('而这个工作流里还记着那个文件名。');
            lines.push('');
            lines.push('怎么修：在下面的「输入图」里给它重新选一张 ——');
            lines.push('  · 点「取选区」：用 Photoshop 当前选区（推荐，直接就能用）');
            lines.push('  · 点「选文件」：从磁盘上挑一张');
            return lines.join('\n');
        }

        lines.push('ComfyUI 不接受这个工作流：');
        if (detail.message) lines.push(detail.message);
        if (detail.details) lines.push(detail.details);
        if (!detail.message && !detail.details) lines.push(detail.type || '节点参数不合法');
        lines.push('出问题的节点：' + where);
        if (ids.length > 1) lines.push('另外还有 ' + (ids.length - 1) + ' 个节点也有问题。');

        lines.push('');
        lines.push('最常见的原因是缺模型文件或缺自定义节点。');
        lines.push('请先在 ComfyUI 里手动把这个工作流跑通一次 —— 在 ComfyUI 里能跑，插件里才能跑。');
        return lines.join('\n');
    }

    /**
     * 把 /prompt 的失败翻译成人话。
     * 非 ComfyUI 结构化的错误（网络断了、超时）原样返回，那些错误本身就是人话。
     */
    function translatePromptError(error) {
        if (!error || !error.parsed || typeof error.parsed !== 'object') return error;
        const body = error.parsed;

        if (body.node_errors && Object.keys(body.node_errors).length > 0) {
            return makeError('workflow', describeNodeErrors(body.node_errors), { nodeErrors: body.node_errors });
        }
        if (body.error && body.error.message) {
            return makeError('workflow',
                'ComfyUI 拒绝了这个工作流：' + body.error.message + '\n'
                + (body.error.details ? body.error.details + '\n' : '')
                + '\n请先在 ComfyUI 里手动把它跑通一次，确认它本身没问题。',
                { body: body });
        }
        return error;
    }

    /**
     * 提交一个 API 格式的工作流。
     * 返回 { promptId, number }。node_errors 非空说明工作流本身有问题，
     * 直接抛出来，别让用户对着一个永远不动的进度条发呆。
     */
    async function queuePrompt(workflow) {
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
            throw makeError('input', '工作流内容不对。请确认导入的是 ComfyUI 导出的「API 格式」JSON。');
        }
        if (Object.keys(workflow).length === 0) {
            throw makeError('input', '工作流是空的，里面没有任何节点。');
        }

        const payload = { prompt: workflow, client_id: getClientId() };
        let result = null;
        try {
            result = await request('/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                as: 'json',
                timeout: TIMEOUT_SUBMIT
            });
        } catch (error) {
            // ⚠️ 校验失败走的是 HTTP 400 的异常分支，不在下面的 result 判断里。
            // 最早的版本只在成功路径处理 node_errors，结果真机一测发现：
            // 用户拿到的是「ComfyUI 返回错误 400」加一坨原始 JSON，
            // 精心写的友好提示一行都没执行 —— 而缺模型正是客户最常撞的问题。
            throw translatePromptError(error);
        }

        // 保险：万一某个 ComfyUI 版本改成 HTTP 200 + node_errors 返回，这里也兜住
        const nodeErrors = result && result.node_errors;
        if (nodeErrors && Object.keys(nodeErrors).length > 0) {
            throw makeError('workflow', describeNodeErrors(nodeErrors), { nodeErrors: nodeErrors });
        }

        const promptId = result && (result.prompt_id || result.promptId);
        if (!promptId) {
            throw makeError('parse', 'ComfyUI 没有返回任务号，无法跟踪这次出图。');
        }
        return { promptId: String(promptId), number: result.number };
    }

    /**
     * 查一次历史记录。
     * 没跑完的任务在 history 里还查不到（返回空对象），这是正常的，
     * 所以这里返回 null 而不是报错，由调用方决定要不要继续等。
     */
    async function history(promptId) {
        const id = String(promptId || '');
        if (!id) throw makeError('input', '缺少任务号。');
        const all = await request('/history/' + encodeURIComponent(id), { as: 'json', timeout: TIMEOUT_FAST });
        if (!all || typeof all !== 'object') return null;
        const entry = all[id];
        return entry || null;
    }

    /**
     * 从一条 history 记录里把执行状态和错误信息抠出来。
     *
     * ComfyUI 的失败信息藏得比较深：status.messages 里混着各种事件，
     * 真正有用的 'execution_error' 要一条条翻。用户看到的应该是一句人话，
     * 不是一个 status_str: "error"。
     */
    function readHistoryOutcome(entry) {
        if (!entry) return { done: false, ok: false, message: '' };

        const status = entry.status || {};
        const messages = Array.isArray(status.messages) ? status.messages : [];
        const completed = status.completed === true;
        const statusStr = String(status.status_str || '');

        // 优先找明确的执行错误
        for (let index = messages.length - 1; index >= 0; index--) {
            const item = messages[index];
            const payload = Array.isArray(item) ? item[1] : null;
            const type = Array.isArray(item) ? item[0] : '';
            if (type === 'execution_error' && payload) {
                return {
                    done: true,
                    ok: false,
                    message: 'ComfyUI 执行失败：' + (payload.exception_message || payload.exception_type || '未知错误')
                        + (payload.node_type ? '\n出问题的节点：' + payload.node_type + ' (#' + payload.node_id + ')' : ''),
                    detail: payload
                };
            }
        }

        if (completed && statusStr === 'success') return { done: true, ok: true, message: '' };
        if (statusStr === 'error') {
            return { done: true, ok: false, message: 'ComfyUI 报告任务出错，但没有给出具体原因。请到 ComfyUI 窗口看日志。', detail: status };
        }
        return { done: false, ok: false, message: '' };
    }

    /**
     * 把 history 记录里所有输出图片摊平成一个数组。
     * outputs 的结构是 { 节点号: { images: [{filename, subfolder, type}] } }，
     * 也可能出现 gifs / videos（做视频的工作流），一并收了。
     */
    function collectOutputImages(entry) {
        const outputs = (entry && entry.outputs) || {};
        const collected = [];
        Object.keys(outputs).forEach(function (nodeId) {
            const nodeOutput = outputs[nodeId] || {};
            ['images', 'gifs', 'videos'].forEach(function (key) {
                const list = nodeOutput[key];
                if (!Array.isArray(list)) return;
                list.forEach(function (item) {
                    if (!item || !item.filename) return;
                    collected.push({
                        nodeId: nodeId,
                        filename: item.filename,
                        subfolder: item.subfolder || '',
                        type: item.type || 'output',
                        kind: key,
                        animated: item.format === 'video/h264-mp4' || /\.(mp4|webm|gif)$/i.test(item.filename)
                    });
                });
            });
        });
        return collected;
    }

    /**
     * 取一张输出图，返回 Uint8Array。
     * 注意普通图片走这里、视频也走这里，字节层不做区分。
     */
    async function viewImage(descriptor) {
        const item = descriptor || {};
        if (!item.filename) throw makeError('input', '取图时缺少文件名。');
        const query = new URLSearchParams();
        query.set('filename', item.filename);
        query.set('subfolder', item.subfolder || '');
        query.set('type', item.type || 'output');
        return request('/view?' + query.toString(), { as: 'bytes', timeout: TIMEOUT_IMAGE });
    }

    /**
     * 中断当前正在跑的任务。
     * 失败不抛——用户点「中断」时正在气头上，再弹个报错只会更烦。
     */
    async function interrupt() {
        try {
            await request('/interrupt', { method: 'POST', as: 'json', timeout: TIMEOUT_FAST });
            return true;
        } catch (error) {
            console.warn('[comfy] 中断请求失败:', error);
            return false;
        }
    }

    /**
     * 队列状态。轮询时用来判断「还在排队」还是「已经在跑了」，
     * 好给用户一句比进度条更有信息量的话。
     */
    async function queueState() {
        try {
            const state = await request('/queue', { as: 'json', timeout: TIMEOUT_FAST });
            return {
                running: Array.isArray(state && state.queue_running) ? state.queue_running.length : 0,
                pending: Array.isArray(state && state.queue_pending) ? state.queue_pending.length : 0
            };
        } catch (error) {
            return { running: 0, pending: 0 };
        }
    }

    // ---------------------------------------------------------- 上传图片

    /**
     * 上传一张参考图给 ComfyUI 的 input 目录。
     *
     * bytes 传 Uint8Array，我们把文件名一起带上。
     * 不直接用 UXP 的 File 对象：把它塞进 FormData 在部分 UXP 版本上
     * 会被当成普通字符串，服务端收到的是一段 "[object File]"。
     */
    /**
     * 按**字节**判断真实图片格式。
     * 不能信文件名：Photoshop 的 encodeImageData 带 quality 参数时返回的是 JPEG
     * （实测文件头 FF D8 FF），而调用方给的默认名字可能是 .png。
     * 扩展名和 Content-Type 必须跟着真实字节走，否则「.png 的 JPEG」会在
     * 信任扩展名的环节出问题。
     */
    function detectImageFormat(bytes) {
        const b = bytes || new Uint8Array(0);
        if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
            return { ext: '.jpg', mime: 'image/jpeg' };
        }
        if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
            return { ext: '.png', mime: 'image/png' };
        }
        if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
            && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
            return { ext: '.webp', mime: 'image/webp' };
        }
        return { ext: '.png', mime: 'image/png' };
    }

    /**
     * 从图片字节里读出像素尺寸，读不出返回 null。
     *
     * 为什么需要：把出图「放回原位」时要知道它多大，才能算出等比内接的矩形。
     * 为什么不问 ComfyUI：它只在历史里给文件名，没有尺寸；
     * 为什么不让浏览器解：UXP 里没有可靠的解码器（实测几 MB 的 data URL 用
     * `new Image()` 拿到的 naturalWidth 是 0），而**表头是明文的，几十个字节就能读出来**。
     *
     * 只认这三种：PNG（IHDR）、JPEG（SOF 段）、WebP（VP8/VP8L/VP8X）。
     * 认不出就返回 null，由调用方自己决定怎么办 —— 不要在这里猜一个尺寸。
     */
    function readImageSize(bytes) {
        const b = bytes || new Uint8Array(0);
        if (b.length < 16) return null;

        // PNG：文件头 8 字节 + 长度 4 + 'IHDR' 4，紧跟着就是宽高（大端 4+4）
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
            const width = readUint32BE(b, 16);
            const height = readUint32BE(b, 20);
            return width > 0 && height > 0 ? { width: width, height: height } : null;
        }

        // JPEG：从头扫段，找 SOF0~SOFn（C0~CF，但要跳过 C4/DHT、C8/JPG、CC/DAC）。
        // 段结构：FF <标记> <长度2字节> <内容>；长度含它自己那 2 个字节。
        if (b[0] === 0xFF && b[1] === 0xD8) {
            let offset = 2;
            while (offset + 9 < b.length) {
                if (b[offset] !== 0xFF) { offset += 1; continue; }
                const marker = b[offset + 1];
                if (marker === 0xFF) { offset += 1; continue; }          // 填充字节
                if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; }
                if (marker === 0xD9 || marker === 0xDA) break;           // 到了图像数据，不再有 SOF
                const length = readUint16BE(b, offset + 2);
                if (length < 2) break;
                const isSof = marker >= 0xC0 && marker <= 0xCF
                    && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
                if (isSof) {
                    // SOF 内容：精度 1 → 高 2 → 宽 2 → 通道数 1
                    const height = readUint16BE(b, offset + 5);
                    const width = readUint16BE(b, offset + 7);
                    return width > 0 && height > 0 ? { width: width, height: height } : null;
                }
                offset += 2 + length;
            }
            return null;
        }

        // WebP：RIFF....WEBP，再按 VP8 / VP8L / VP8X 三种块各读各的
        if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
            const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
            if (chunk === 'VP8X') {
                // 画布宽高各 3 字节（值减一），跟在 4 字节 flags 后面
                const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
                const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
                return width > 0 && height > 0 ? { width: width, height: height } : null;
            }
            if (chunk === 'VP8 ') {
                const width = readUint16BE(b, 26) & 0x3FFF;
                const height = readUint16BE(b, 28) & 0x3FFF;
                return width > 0 && height > 0 ? { width: width, height: height } : null;
            }
            if (chunk === 'VP8L') {
                const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
                return { width: 1 + (bits & 0x3FFF), height: 1 + ((bits >> 14) & 0x3FFF) };
            }
        }

        return null;
    }

    function readUint32BE(bytes, offset) {
        return (bytes[offset] * 0x1000000)
            + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
    }

    function readUint16BE(bytes, offset) {
        return (bytes[offset] << 8) | bytes[offset + 1];
    }

    /**
     * 把「取选区」记下的位置做成一份**快照**，供出图后的「放回原位」用。
     *
     * 为什么必须是快照、不能直接引用那份记录：用户完全可能出完图又去取别的选区，
     * 那时记录已经被改写成新位置了 —— 直接引用会把这张图贴到一个跟它毫无关系的地方。
     * 复制一份出去，位置在**提交那一刻**就定死。
     *
     * 没有位置（没点过「取选区」）或数据不合法时返回 null，由调用方决定怎么提示。
     * 纯函数，不碰网络也不碰 DOM —— 抽出来是为了能离线测「复制」这个关键性质。
     */
    function snapshotPlaceTarget(captureBounds, captureDocId) {
        if (!captureBounds || captureDocId == null) return null;
        const left = Number(captureBounds.left);
        const top = Number(captureBounds.top);
        const right = Number(captureBounds.right);
        const bottom = Number(captureBounds.bottom);
        if (!Number.isFinite(left) || !Number.isFinite(top)
            || !Number.isFinite(right) || !Number.isFinite(bottom)) return null;
        if (right <= left || bottom <= top) return null;
        return {
            bounds: {
                left: left, top: top, right: right, bottom: bottom,
                width: right - left, height: bottom - top
            },
            documentId: captureDocId
        };
    }

    // ⚠️ 这里**故意不设尺寸上限**。两段历史，别再往回收：
    //
    //   ① 最早照搬主面板「自动校色」的规矩（200 万像素不校色 / 80 万以上关对位），
    //      结果用户真实选区是 3228×3228 ≈ 1040 万像素，一上来就被判成「太大」跳过 ——
    //      界面看着就像功能没生效。那个上限还是从一条**用户从来没用过**的路径上抄来的
    //      （主面板的自动校色整个是关着的状态）。
    //   ② 改成 2400 万兜底之后，用户明确要求去掉：换机器了，慢不再是问题。
    //
    // 去掉是安全的，不是妥协：
    //   · 工具箱里**手动**的融合校色本来就没有任何尺寸上限、按整层全分辨率跑 ——
    //     去掉之后是**和它对齐**，不引入新的风险类别。
    //   · 真遇到极端大的选区，像素缓冲分配失败会被 index.js 捕获，
    //     退化成「校色失败、图仍然放上去」，不会硬崩。
    //
    // 顺带记一下校准过的开销（免得下次又想当然地加限制）：
    // 贵的是 applyWavelet 的 36 遍全图模糊，跟尺寸成正比、躲不掉；
    // 对位只用 128px 代理（很便宜、几乎与尺寸无关），共用遮罩只有 3 遍。
    // 所以「按尺寸关掉对位/遮罩」既救不了速度、又白丢效果。

    /**
     * 「这次要不要自动校色」的判定，以及该用什么参数。
     *
     * 返回 { apply, reason, pixels, options }：
     *   apply=false 时 reason 说明为什么不做（调用方据此给用户一句话），
     *   apply=true  时 options 直接交给 window.HuanmengColorMatch.matchImageData。
     *
     * pixels 只用于诊断日志（写清楚当时多大），**不参与是否校色的判断**。
     *
     * 纯判定，不碰 DOM 也不碰网络 —— 抽出来是为了能离线测。
     */
    function colorMatchPlan(options) {
        const opts = options || {};
        if (opts.enabled !== true) return { apply: false, reason: 'off' };

        const bounds = opts.bounds || {};
        const width = Number(bounds.width);
        const height = Number(bounds.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return { apply: false, reason: 'no-bounds' };
        }

        return {
            apply: true,
            reason: '',
            pixels: Math.round(width) * Math.round(height),
            // 参数就是工具箱里手动「融合校色」用的那套。
            options: {
                method: opts.method === 'reinhard' ? 'reinhard' : 'wavelet',
                strength: 100,
                alignmentEnabled: true,
                sharedMaskEnabled: true,
                featherRadius: 12,
                alignmentMaxOffset: 80
            }
        };
    }

    /**
     * 一页条数。给「列表太长」用 —— UXP 里 `overflow-y: auto` **不生效**
     * （内容只会被裁掉，滚不动），所以不能靠限高 + 滚动来收，只能限**条数**。
     *
     * 返回 { items, total, shown, hasMore, page }：
     *   items   = 这一页要渲染的条目
     *   hasMore = 后面还有没有
     *   page    = 实际用的页码（越界会被夹回来）
     *
     * 纯函数，不碰 DOM —— 抽出来是为了能离线测「越界、空表、正好整除」这些边界。
     */
    function slicePage(items, pageSize, page) {
        const list = Array.isArray(items) ? items : [];
        const size = Math.max(1, Math.round(Number(pageSize) || 1));
        const total = list.length;
        const lastPage = Math.max(0, Math.ceil(total / size) - 1);
        let wanted = Math.round(Number(page) || 0);
        if (!Number.isFinite(wanted) || wanted < 0) wanted = 0;
        if (wanted > lastPage) wanted = lastPage;
        const start = wanted * size;
        return {
            items: list.slice(start, start + size),
            total: total,
            shown: start + Math.min(size, Math.max(0, total - start)),
            hasMore: (start + size) < total,
            page: wanted
        };
    }

    /**
     * 「这次要不要自动放回」的判定，返回该放回的结果序号；不放回返回 -1。
     *
     * 三个条件缺一不可，任何一个不满足都只能**安静地不自动放**：
     *   ① 用户打开了「出图后自动放回原位」
     *   ② 提交时记下了位置（没点过「取选区」就没有原位可放）
     *   ③ 确实有出图
     *
     * 只放**第一张**：一份工作流可能有好几个输出节点（SaveImage 各存一张），
     * 全放会一次在文档上叠一堆图层，还得自己挑哪张是哪张。
     * 其余几张仍然可以在结果卡片上逐张手动放。
     *
     * 纯判定，不碰 DOM 也不碰网络 —— 抽出来是为了能离线测这三个条件。
     */
    function autoPlaceIndex(options) {
        const opts = options || {};
        if (opts.enabled !== true) return -1;
        if (!opts.hasTarget) return -1;
        const count = Number(opts.resultCount);
        if (!Number.isFinite(count) || count < 1) return -1;
        return 0;
    }

    /**
     * 算一个「等比缩放到能放进 target 里」的矩形，居中。
     *
     * 出图尺寸常常和原选区不一样（放大节点会改尺寸），直接拉成选区大小会**变形**。
     * 所以按短边算一个统一的缩放系数，等比缩，再居中。
     *
     * 纯几何，不碰网络也不碰 DOM —— 单独抽出来是为了能离线测。
     */
    function fitRectInside(imageWidth, imageHeight, target) {
        const iw = Number(imageWidth);
        const ih = Number(imageHeight);
        const box = target || {};
        const bw = Number(box.width != null ? box.width : (Number(box.right) - Number(box.left)));
        const bh = Number(box.height != null ? box.height : (Number(box.bottom) - Number(box.top)));
        if (!(iw > 0) || !(ih > 0) || !(bw > 0) || !(bh > 0)) return null;

        const scale = Math.min(bw / iw, bh / ih);
        const width = Math.max(1, Math.round(iw * scale));
        const height = Math.max(1, Math.round(ih * scale));
        const left = Math.round(Number(box.left) || 0) + Math.round((bw - width) / 2);
        const top = Math.round(Number(box.top) || 0) + Math.round((bh - height) / 2);
        return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
    }

    /**
     * multipart 的 filename 头只认 ASCII。中文文件名会被 UTF-8 编码后按 Latin-1 解，
     * 落盘成「å¹»æ¢¦æµè¯å¾.png」这种乱码（实测）。
     * 保不住原名，就保一个可读的 ASCII 前缀 + 时间戳。
     * forcedExt 优先（来自字节检测），其次才保留原扩展名。
     */
    function asciiFilename(filename, forcedExt) {
        const raw = String(filename || '');
        const extMatch = /\.([A-Za-z0-9]+)$/.exec(raw);
        const ext = forcedExt || (extMatch ? '.' + extMatch[1].toLowerCase() : '.png');
        const base = raw.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 24);
        return (base || 'huanmeng') + '-' + Date.now().toString(36) + ext;
    }

    async function uploadImage(bytes, filename, subfolder) {
        if (!bytes || !bytes.length) throw makeError('input', '要上传的图片是空的。');
        const format = detectImageFormat(bytes);
        const name = asciiFilename(filename, format.ext);

        // multipart body 全程手搓，不用 FormData，两个原因：
        //   1. 走圆环代理时，FormData 会被 String() 成 "[object FormData]"，
        //      字节根本传不过去 —— 实测「选区传不回 ComfyUI」就是这么来的
        //   2. UXP 的 fetch 对 FormData 的序列化本身就不能打包票
        const boundary = '----huanmeng' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const field = function (fieldName, value) {
            return '--' + boundary + '\r\n'
                + 'Content-Disposition: form-data; name="' + fieldName + '"\r\n\r\n'
                + value + '\r\n';
        };
        const head = '--' + boundary + '\r\n'
            + 'Content-Disposition: form-data; name="image"; filename="' + name + '"\r\n'
            + 'Content-Type: ' + format.mime + '\r\n\r\n';
        const tail = '\r\n'
            + field('overwrite', 'true')
            + field('type', 'input')
            + (subfolder ? field('subfolder', subfolder) : '')
            + '--' + boundary + '--\r\n';

        const headBytes = encodeUtf8(head);
        const tailBytes = encodeUtf8(tail);
        const total = new Uint8Array(headBytes.length + bytes.length + tailBytes.length);
        total.set(headBytes, 0);
        total.set(bytes, headBytes.length);
        total.set(tailBytes, headBytes.length + bytes.length);
        const contentType = 'multipart/form-data; boundary=' + boundary;

        // ⚠️ 直连路径的 body 用 **ArrayBuffer**，不要用 Blob。
        // UXP 的 fetch 在「Blob body + 手写 Content-Type」时会把 Blob 的 MIME 追加到
        // 请求头后面，实测 ComfyUI 收到的是：
        //   multipart/form-data; boundary=..., multipart/form-data
        // aiohttp 解析不出起始分隔符，/upload/image 直接 500
        //（服务端日志：ValueError: Could not find starting boundary b'------huanmeng..., multipart/form-data'）。
        // UXP 文档里 fetch 的 body 支持 ArrayBuffer / TypedArray，直接发原始字节最稳。
        // 曾经用二进制字符串当 body 也不行：fetch 会按 UTF-8 编码，PNG 魔数会被改坏。
        // 代理路径用 __bytes（原样 base64，不经 UTF-8）。
        let result = null;
        try {
            result = await request('/upload/image', {
                method: 'POST',
                headers: { 'Content-Type': contentType },
                contentType: contentType,
                body: total.buffer,
                __bytes: total,
                as: 'json',
                timeout: TIMEOUT_IMAGE,
                // 二进制上传优先走圆环代理（那条路字节级验证过）；
                // 圆环不在或没连上时自动退直连。
                preferRing: true
            });
        } catch (firstError) {
            // 兜底：万一某个 UXP 版本不认 ArrayBuffer body，退回 Blob。
            // 这次不手写 Content-Type，让 Blob 自带的 type 生成请求头，
            // 避免再触发「两个 Content-Type 被拼在一起」的问题。
            const fallbackBlob = new Blob([total], { type: contentType });
            result = await request('/upload/image', {
                method: 'POST',
                headers: {},
                contentType: contentType,
                body: fallbackBlob,
                __bytes: total,
                as: 'json',
                timeout: TIMEOUT_IMAGE,
                preferRing: true
            });
        }

        if (!result || !result.name) {
            throw makeError('parse', '图片上传后 ComfyUI 没有返回文件名。');
        }
        return { name: result.name, subfolder: result.subfolder || '', type: result.type || 'input' };
    }

    /**
     * 探一次 WebSocket。
     *
     * 为什么需要它：fetch 失败时，「连不上」和「跨域被拦」在 JS 里是**同一个**
     * TypeError: Failed to fetch，光看错误分不出来。但 WebSocket 不受 CORS 约束，
     * 所以：fetch 挂 + WebSocket 通 = 铁证，是跨域问题。
     *
     * 这个插件本来就在用 WebSocket 连圆环（127.0.0.1:8799），这条路是确定可用的。
     */
    function probeWebSocket(url, timeoutMs) {
        return new Promise(function (resolve) {
            let settled = false;
            let socket = null;

            const finish = function (result) {
                if (settled) return;
                settled = true;
                try { if (socket && socket.close) socket.close(); } catch (error) { /* 关不掉就算了 */ }
                resolve(result);
            };

            const timer = setTimeout(function () {
                finish({ ok: false, reason: '超时（' + Math.round(timeoutMs / 1000) + ' 秒没握手成功）' });
            }, timeoutMs);

            try {
                socket = new WebSocket(url);
            } catch (error) {
                clearTimeout(timer);
                finish({ ok: false, reason: '构造 WebSocket 直接抛错：' + (error && error.message ? error.message : error) });
                return;
            }

            socket.onopen = function () {
                clearTimeout(timer);
                finish({ ok: true, reason: '' });
            };
            socket.onerror = function () {
                clearTimeout(timer);
                finish({ ok: false, reason: 'WebSocket 握手失败' });
            };
        });
    }

    /**
     * 连接诊断：把「连不上」拆成几种可区分的情况。
     *
     * 依次试这些东西，靠组合判断：
     *   1. 直连 fetch            —— 通就没问题
     *   2. 经圆环代发            —— 通说明只是跨域被拦，但已经绕过去了
     *   3. fetch + no-cors       —— 能通说明服务器活着，只是跨域头没给
     *   4. WebSocket             —— 不受 CORS 约束，能握手说明网络和权限都没问题
     *
     * 判定：
     *   1 通                     → ok（直连）
     *   2 通                     → ok-ring（经圆环代发，用户不用做任何事）
     *   3 或 4 通、1/2 不通       → cors（跨域被拦，且圆环不在）
     *   全不通                    → unreachable（根本没连上）
     */
    async function diagnose() {
        const base = getBaseUrl();
        const report = {
            base: base,
            steps: [],
            verdict: 'unreachable',
            title: '',
            advice: '',
            transport: transport
        };

        // ---- 第一步：直连
        try {
            const stats = await directRequest(base + '/system_stats', 'GET', {}, 'json', TIMEOUT_FAST, base);
            report.steps.push({ name: '直连 /system_stats', ok: true, note: '' });
            report.verdict = 'ok';
            report.title = '连接正常（直连）';
            report.transport = 'direct';
            report.system = (stats && stats.system) || {};
            transport = 'direct';
            return report;
        } catch (error) {
            report.steps.push({
                name: '直连 /system_stats',
                ok: false,
                note: (error && error.message ? error.message.split('\n')[0] : String(error))
                    + (error && error.detail && error.detail.raw ? ' ｜ 原始错误：' + error.detail.raw : '')
            });
        }

        // ---- 第二步：经圆环代发
        if (isRingUsable()) {
            try {
                const stats = await ringRequest(base + '/system_stats', 'GET', {}, 'json', TIMEOUT_FAST);
                report.steps.push({ name: '经圆环代发 /system_stats', ok: true, note: '幻梦圆环已连接' });
                report.verdict = 'ok-ring';
                report.title = '连接正常（经幻梦圆环代发）';
                report.transport = 'ring';
                report.system = (stats && stats.system) || {};
                report.advice = '直连被浏览器层的跨域校验拦掉了，已经自动改走幻梦圆环代发 —— 能正常用，不需要你做任何事。\n'
                    + '（想让直连也能通的话，给 ComfyUI 的启动参数加上 --enable-cors-header。）';
                transport = 'ring';
                return report;
            } catch (error) {
                report.steps.push({
                    name: '经圆环代发 /system_stats',
                    ok: false,
                    note: (error && error.message ? error.message.split('\n')[0] : String(error))
                });
            }
        } else {
            report.steps.push({ name: '经圆环代发', ok: false, note: '幻梦圆环没在运行（或插件没连上它）' });
        }

        // ---- 第三步：no-cors 试探（能拿到 opaque 响应就说明服务器是活的）
        let noCorsOk = false;
        try {
            const response = await fetchWithTimeout(base + '/system_stats', { mode: 'no-cors' }, TIMEOUT_FAST);
            noCorsOk = true;
            report.steps.push({ name: 'fetch mode:no-cors', ok: true, note: '响应类型 ' + (response && response.type) });
        } catch (error) {
            report.steps.push({
                name: 'fetch mode:no-cors',
                ok: false,
                note: String(error && error.message ? error.message : error).split('\n')[0]
            });
        }

        // ---- 第四步：WebSocket 试探（不受 CORS 约束）
        const wsUrl = base.replace(/^http/i, 'ws') + '/ws?clientId=' + encodeURIComponent(getClientId());
        const ws = await probeWebSocket(wsUrl, 6000);
        report.steps.push({ name: 'WebSocket ' + wsUrl.replace(/\?.*$/, ''), ok: ws.ok, note: ws.reason });

        if (noCorsOk || ws.ok) {
            report.verdict = 'cors';
            report.title = 'ComfyUI 是通的，但跨域（CORS）访问被拦了，而且圆环不在';
            report.advice = '地址没错、ComfyUI 也开着，卡在浏览器层的跨域校验上。\n'
                + 'ComfyUI 默认不开跨域（本机实测 access-control-allow-origin 为空），而 UXP 的 fetch 会强制校验它。\n\n'
                + '你现在有两条路：\n'
                + '① 把幻梦圆环跑起来 —— 插件会自动改走圆环代发，你什么都不用再配；\n'
                + '② 给 ComfyUI 开跨域 —— 启动参数加 --enable-cors-header\n'
                + '   （ComfyUI Desktop 在「设置 → 服务器配置 → 额外启动参数」里填，填完重启 ComfyUI）\n\n'
                + '（WebSocket 能握手但 fetch 不行，这是跨域问题最典型的特征。）';
            return report;
        }

        report.verdict = 'unreachable';
        report.title = '连 ComfyUI 的端口都没握上手';
        report.advice = '直连、圆环代发、WebSocket 全都失败了，所以这不是跨域问题，是根本没连上。\n'
            + '请依次确认：\n'
            + '① ComfyUI 现在开着吗（它的窗口在不在）；\n'
            + '② 上面那个地址对不对（当前：' + base + '）；\n'
            + '③ ComfyUI 的端口是不是 8188（它可能因为端口占用自动换过端口）；\n'
            + '④ 防火墙/杀毒软件有没有拦。';
        return report;
    }

    window.HuanmengComfyClient = {
        DEFAULT_BASE_URL: DEFAULT_BASE_URL,
        normalizeBaseUrl: normalizeBaseUrl,
        getBaseUrl: getBaseUrl,
        setBaseUrl: setBaseUrl,
        getClientId: getClientId,

        diagnose: diagnose,
        probeWebSocket: probeWebSocket,
        getTransport: getTransport,
        isRingUsable: isRingUsable,

        systemStats: systemStats,
        objectInfo: objectInfo,
        clearObjectInfoCache: clearObjectInfoCache,
        listUserWorkflows: listUserWorkflows,
        readUserWorkflow: readUserWorkflow,

        queuePrompt: queuePrompt,
        history: history,
        readHistoryOutcome: readHistoryOutcome,
        collectOutputImages: collectOutputImages,
        describeNodeErrors: describeNodeErrors,
        translatePromptError: translatePromptError,
        viewImage: viewImage,
        interrupt: interrupt,
        queueState: queueState,

        uploadImage: uploadImage,

        // 纯字节/几何工具（不碰网络）。放回原位要用：先读图多大，再算等比内接的矩形。
        readImageSize: readImageSize,
        fitRectInside: fitRectInside,
        snapshotPlaceTarget: snapshotPlaceTarget,
        autoPlaceIndex: autoPlaceIndex,
        slicePage: slicePage,
        colorMatchPlan: colorMatchPlan,

        // 给测试台用的内部句柄，正常 UI 不该调
        __request: request,
        __encodeUtf8: encodeUtf8,
        __decodeUtf8: decodeUtf8,
        __bytesToBase64: bytesToBase64,
        __detectImageFormat: detectImageFormat,
        __asciiFilename: asciiFilename,
        __setTransport: function (value) { transport = value; }
    };
})();
