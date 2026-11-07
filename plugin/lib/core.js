/* ============================================================
 * core.js — 预拆分包的基础层
 *
 * 从 幻梦AI 3.1.1 的 src/app/index.js 里抽出的「公共部分」：
 *   · 设置读写（与插件完全相同的 localStorage 键：huanmeng_config）
 *   · 供应商默认地址 / 默认模型 / 默认系统提示词
 *   · URL、模型名、Base64、DataURL、超时请求等纯工具
 *
 * 这一层不碰 Photoshop、不碰 DOM、不发业务请求。
 * 其它所有模块都通过 window.HuanmengCore（或 require）使用它。
 *
 * 原始位置：
 *   index.js:90-238   常量（地址、模型、系统提示词）
 *   index.js:1070-1165 模型名解析
 *   index.js:1287-1306 URL 规范化
 *   index.js:1948-1968 toNumber / normalizeApiKey
 *   index.js:4107-4248 Config（只保留 settings 部分）
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var VERSION = '3.1.1-split';

    /* ---------------- 供应商默认值 ---------------- */
    var DEFAULTS = {
        grsDefaultBaseUrl: 'https://grsaiapi.com',
        grsChinaBaseUrl: 'https://grsai.dakka.com.cn',
        grsRegion: 'domestic',
        openaiBaseUrl: 'https://api.openai.com',
        googleBaseUrl: 'https://generativelanguage.googleapis.com',
        xaiBaseUrl: 'https://api.x.ai',
        grok2apiBaseUrl: 'http://127.0.0.1:8000',
        sub2apiBaseUrl: 'http://127.0.0.1:8080',
        newApiBaseUrl: 'http://127.0.0.1:3000',
        fireflyBaseUrl: 'http://127.0.0.1:8787',
        volcengineBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        volcengineImageModel: 'doubao-seedream-4-0-250828',
        volcengineChatModel: 'doubao-seed-1-6-250615',
        vertexBaseUrl: 'https://aiplatform.googleapis.com',
        vertexImageModel: 'gemini-2.5-flash-image',
        vertexChatModel: 'gemini-2.5-flash',
        grsChatModel: 'grs/gemini-3.1-pro',
        imageModel: 'nano-banana-2.1',
        imageResolution: 'auto',
        serverApiUrl: 'https://www.syyyy.online',
        textSystemPromptPositive: '准确理解用户目标，优先给出可直接执行、结构清晰且与当前图像工作流相关的回答。',
        textSystemPromptNegative: '不要编造不存在的接口结果、文件状态或执行结果；不要忽略用户明确的格式、范围和安全约束。',
        imageSystemPromptPositive: '严格遵循用户的编辑目标；存在输入图时优先保持主体身份、姿势、构图、透视与未指定区域不变，输出单张完整成图。',
        imageSystemPromptNegative: '避免身份漂移、五官和肢体畸形、无关物体、错误文字、水印、边框、拼图、构图漂移、过曝、脏污和低清晰度。'
    };

    /* ---------------- 日志 ---------------- */
    var logger = (root.console || { log: function () {} });

    function setLogger(next) {
        if (next && typeof next.log === 'function') logger = next;
    }

    function log() {
        try {
            if (logger && typeof logger.log === 'function') logger.log.apply(logger, arguments);
        } catch (ignore) {}
    }

    /* ---------------- 设置 ---------------- */
    var CONFIG_KEY = 'huanmeng_config';
    var memorySettings = null;

    function readStoredConfig() {
        try {
            var storage = root.localStorage;
            if (!storage) return null;
            var raw = storage.getItem(CONFIG_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (error) {
            log('[core] 读取配置失败:', error);
            return null;
        }
    }

    /**
     * 读取设置。优先级：configure() 传入的 > localStorage 里的 > 默认值。
     * 与插件一致：设置存放在 huanmeng_config 的 settings 字段里。
     */
    function getSettings() {
        if (memorySettings) return memorySettings;
        var config = readStoredConfig();
        memorySettings = Object.assign({}, DEFAULTS, (config && config.settings) || {});
        return memorySettings;
    }

    /** 覆盖/合并设置（不会写盘）。 */
    function configure(patch) {
        var base = getSettings();
        memorySettings = Object.assign({}, base, patch && patch.settings ? patch.settings : (patch || {}));
        return memorySettings;
    }

    /** 合并并写回 localStorage（与插件共用同一份配置）。 */
    function saveSettings(patch) {
        var next = Object.assign({}, getSettings(), patch || {});
        memorySettings = next;
        try {
            var storage = root.localStorage;
            if (!storage) return false;
            var config = readStoredConfig() || {};
            config.settings = Object.assign({}, config.settings || {}, next);
            storage.setItem(CONFIG_KEY, JSON.stringify(config));
            return true;
        } catch (error) {
            log('[core] 保存配置失败:', error);
            return false;
        }
    }

    function resetSettingsCache() {
        memorySettings = null;
    }

    /* ---------------- 数值 / 文本工具 ---------------- */

    /** UXP 的 UnitValue / 普通数字都能转成 number。 */
    function toNumber(value) {
        if (value && typeof value === 'object' && value._value !== undefined) {
            return Number(value._value) || 0;
        }
        return Number(value) || 0;
    }

    function clamp(value, min, max) {
        var numeric = Number(value);
        if (!isFinite(numeric)) numeric = min;
        return numeric < min ? min : (numeric > max ? max : numeric);
    }

    function normalizeApiKey(key) {
        return String(key == null ? '' : key).replace(/\s+/g, '').trim();
    }

    function normalizeBaseUrl(baseUrl, fallbackBaseUrl) {
        var raw = String(baseUrl || fallbackBaseUrl || '').trim();
        return raw.replace(/\/+$/, '');
    }

    function joinApiUrl(baseUrl, path) {
        // 用户填接口地址时经常带 /v1；下面的 endpoint 自己已经带 /v1，
        // 不剥掉就会变成 /v1/v1/...，请求直接 404。这是非 GRS 渠道
        // 填了 Key/URL 却仍然不能用的最常见原因。
        var base = normalizeBaseUrl(baseUrl, '').replace(/\/v1(beta)?$/i, '');
        var suffix = String(path || '');
        if (!suffix) return base;
        return base + (suffix.charAt(0) === '/' ? suffix : '/' + suffix);
    }

    /* ---------------- 模型名 ---------------- */

    function getModelName(modelValue) {
        if (!modelValue) return 'gemini-2.0-flash-exp';
        var text = String(modelValue);
        if (text.indexOf('/') > -1) return text.split('/').pop();
        return text;
    }

    function getModelKey(modelValue) {
        return String(getModelName(modelValue) || '').trim().toLowerCase();
    }

    /**
     * 解析「provider/model」形式的选择值。
     * 与插件 index.js:1083-1152 完全一致，包括 newapi 的 gemini 判别。
     */
    function parseModelSelection(modelValue) {
        var raw = String(modelValue || '').trim();
        if (!raw) return { raw: '', provider: '', model: '' };
        var lower = raw.toLowerCase();

        var prefixes = [
            ['grs/', 'grs'],
            ['openai/', 'openai'],
            ['google/', 'google'],
            ['xai/', 'xai'],
            ['grok2api/', 'grok2api'],
            ['sub2api/', 'sub2api'],
            ['firefly/', 'firefly'],
            ['volcengine/', 'volcengine'],
            ['vertex-ai/', 'vertex-ai'],
            ['vertex/', 'vertex-ai'],
            ['newapi-openai/', 'newapi-openai'],
            ['newapi-gemini/', 'newapi-gemini']
        ];
        for (var i = 0; i < prefixes.length; i++) {
            if (lower.indexOf(prefixes[i][0]) === 0) {
                return {
                    raw: raw,
                    provider: prefixes[i][1],
                    model: getModelName(raw.slice(prefixes[i][0].length))
                };
            }
        }
        if (lower.indexOf('newapi/') === 0) {
            var parsedModel = getModelName(raw.slice(7));
            return {
                raw: raw,
                provider: String(parsedModel || '').toLowerCase().indexOf('gemini') > -1 ? 'newapi-gemini' : 'newapi-openai',
                model: parsedModel
            };
        }

        var model = getModelName(raw);
        var modelKey = String(model || '').toLowerCase();
        if (modelKey.indexOf('gemini') > -1) return { raw: raw, provider: 'google', model: model };
        if (isGrsNanoBananaModel(modelKey) || isGrsGptImageModel(modelKey)) {
            return { raw: raw, provider: 'grs', model: model };
        }
        if (modelKey.indexOf('gpt') === 0) return { raw: raw, provider: 'openai', model: model };
        return { raw: raw, provider: '', model: model };
    }

    function buildModelValue(provider, modelName) {
        var clean = String(getModelName(modelName) || '').trim();
        if (!clean) return '';
        if (!provider) return clean;
        return String(provider).toLowerCase() + '/' + clean;
    }

    var GRS_GPT_IMAGE_MODELS = [
        'gpt-image-2', 'gpt-imagine-2', 'gpt-image-2-vip',
        'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.6'
    ];

    /**
     * GRS 模型支持的最高分辨率档（来自 grsai.com 模型列表）。
     * 连字符/大小写都不敏感：键统一用小写模型名。
     */
    var GRS_MODEL_MAX_RESOLUTION = {
        'nano-banana-2.1': '4K',
        'nano-banana-2': '4K',
        'nano-banana-pro': '4K',
        'nano-banana-2-lite': '1K',
        'nano-banana-fast': '1K',
        'nano-banana-2-cl': '1K',
        'nano-banana-pro-cl': '1K',
        'nano-banana-2-2k-cl': '2K',
        'nano-banana-2-4k-cl': '4K',
        'nano-banana-pro-vip': '2K',
        'nano-banana-pro-4k-vip': '4K',
        'gpt-image-2': '1K',
        'gpt-imagine-2': '1K',
        'gpt-image-2-vip': '4K',
        'gpt-image-2.5': '1K',
        'gpt-image-2.5-flare': '4K',
        'gpt-image-2.5-sunburst': '4K',
        'gpt-image-2.6': '1K'
    };

    function getGrsMaxResolution(modelKey) {
        var key = String(modelKey || '').trim().toLowerCase();
        key = getModelKey(key);
        return GRS_MODEL_MAX_RESOLUTION[key] || '1K';
    }

    function isGrsGptImageModel(modelKey) {
        return GRS_GPT_IMAGE_MODELS.indexOf(String(modelKey || '').toLowerCase()) > -1;
    }

    function isGrsNanoBananaModel(modelKey) {
        return String(modelKey || '').toLowerCase().indexOf('nano-banana') === 0;
    }

    function isGrsChatModel(modelKey) {
        var key = String(modelKey || '').toLowerCase();
        return key.indexOf('gpt-5') === 0 || key.indexOf('gemini') === 0 || key.indexOf('claude') === 0;
    }

    function isNewApiProvider(provider) {
        var value = String(provider || '').toLowerCase();
        return value === 'newapi' || value.indexOf('newapi-') === 0;
    }

    function getProviderModels() {
        return root.HuanmengProviderModels || null;
    }

    /* ---------------- Base64 / DataURL ---------------- */

    function base64ToUint8Array(base64) {
        var text = String(base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
        var binary = (typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary'));
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function uint8ArrayToBase64(bytes) {
        var binary = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return (typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64'));
    }

    function arrayBufferToBase64(buffer) {
        return uint8ArrayToBase64(new Uint8Array(buffer));
    }

    function base64ToArrayBuffer(base64) {
        return base64ToUint8Array(base64).buffer;
    }

    function detectImageMimeType(buffer, headerValue) {
        var header = String(headerValue || '').split(';')[0].trim().toLowerCase();
        if (/^image\/(?:png|jpe?g|webp|gif)$/.test(header)) {
            return header === 'image/jpg' ? 'image/jpeg' : header;
        }
        var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
        if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
            && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
        if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
        return 'image/png';
    }

    function dataUrlToParts(dataUrl) {
        var match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
        if (!match) return null;
        return { mimeType: match[1].toLowerCase(), base64: match[2] };
    }

    function toDataUrl(base64, mimeType) {
        var text = String(base64 || '');
        if (/^data:image\//i.test(text)) return text;
        return 'data:' + (mimeType || 'image/png') + ';base64,' + text.replace(/\s+/g, '');
    }

    /** 把远程 URL 下载成 data URL（UXP 里没有图片解码器，回图必须走这一手）。 */
    async function fetchAsDataUrl(url, options) {
        var opts = options || {};
        if (/^data:/i.test(String(url || ''))) return String(url);
        var response = await fetchWithTimeout(url, {
            method: 'GET',
            signal: opts.signal,
            timeout: opts.timeout || 120000
        });
        if (!response.ok) throw new Error('图片下载失败: ' + response.status);
        var buffer = await response.arrayBuffer();
        var mimeType = detectImageMimeType(buffer, response.headers && response.headers.get && response.headers.get('content-type'));
        return 'data:' + mimeType + ';base64,' + arrayBufferToBase64(buffer);
    }

    /* ---------------- HTTP ---------------- */

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function abortError() {
        var error = new Error('请求已取消');
        error.name = 'AbortError';
        return error;
    }

    /**
     * 带超时的 fetch，并支持外部 AbortSignal。
     * 返回原生 Response；超时/取消统一抛 AbortError。
     */
    async function fetchWithTimeout(url, options) {
        var opts = options || {};
        var timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 180000;
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeout);
        var external = opts.signal;
        if (external) {
            if (external.aborted) {
                clearTimeout(timer);
                throw abortError();
            }
            external.addEventListener('abort', function () { controller.abort(); }, { once: true });
        }
        try {
            return await fetch(url, {
                method: opts.method || 'GET',
                headers: opts.headers,
                body: opts.body,
                signal: controller.signal
            });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw external && external.aborted ? abortError() : Object.assign(new Error('请求超时'), { name: 'AbortError' });
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 统一的 JSON 请求：永不抛异常，返回 { ok, status, data, text, error }。
     * 出错时尽量把服务端错误消息带出来。
     */
    async function requestJson(url, options) {
        var opts = options || {};
        try {
            var response = await fetchWithTimeout(url, opts);
            var text = await response.text();
            var data = null;
            try { data = text ? JSON.parse(text) : null; } catch (parseError) {}
            if (!response.ok) {
                return {
                    ok: false,
                    status: response.status,
                    data: data,
                    text: text,
                    error: extractApiError(data, text) || ('请求失败: ' + response.status)
                };
            }
            return { ok: true, status: response.status, data: data, text: text };
        } catch (error) {
            return { ok: false, status: 0, data: null, text: '', error: error && error.message ? error.message : String(error) };
        }
    }

    function extractApiError(data, text, fallback) {
        if (data && data.error) {
            if (typeof data.error === 'string') return data.error;
            if (data.error.message) return String(data.error.message);
        }
        if (data && data.message) return String(data.message);
        var raw = String(text || '');
        if (raw) {
            try {
                var parsed = JSON.parse(raw);
                if (parsed && parsed.error) {
                    return typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || raw.slice(0, 300));
                }
            } catch (ignore) {}
            return raw.slice(0, 300);
        }
        return fallback || '';
    }

    /** 把常见英文错误翻译成用户能看懂的提示（沿用插件里的几个判定）。 */
    function friendlyError(message) {
        var text = String(message || '');
        if (text.indexOf('invalid_api_key') > -1) return 'API 密钥无效，请检查密钥';
        if (text.indexOf('quota_exceeded') > -1) return 'API 配额已用尽，请稍后再试';
        if (text.indexOf('rate_limit_exceeded') > -1) return '请求频率过高，请稍后再试';
        return text;
    }

    function uniqueId(prefix) {
        return (prefix || 'hm') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    function formatTimestamp(date) {
        return (date || new Date()).toLocaleString('zh-CN');
    }

    return {
        VERSION: VERSION,
        DEFAULTS: DEFAULTS,
        CONFIG_KEY: CONFIG_KEY,

        setLogger: setLogger,
        log: log,

        getSettings: getSettings,
        configure: configure,
        saveSettings: saveSettings,
        resetSettingsCache: resetSettingsCache,

        toNumber: toNumber,
        clamp: clamp,
        normalizeApiKey: normalizeApiKey,
        normalizeBaseUrl: normalizeBaseUrl,
        joinApiUrl: joinApiUrl,

        getModelName: getModelName,
        getModelKey: getModelKey,
        parseModelSelection: parseModelSelection,
        buildModelValue: buildModelValue,
        isGrsGptImageModel: isGrsGptImageModel,
        isGrsNanoBananaModel: isGrsNanoBananaModel,
        isGrsChatModel: isGrsChatModel,
        getGrsMaxResolution: getGrsMaxResolution,
        GRS_MODEL_MAX_RESOLUTION: GRS_MODEL_MAX_RESOLUTION,
        isNewApiProvider: isNewApiProvider,
        getProviderModels: getProviderModels,

        base64ToUint8Array: base64ToUint8Array,
        uint8ArrayToBase64: uint8ArrayToBase64,
        arrayBufferToBase64: arrayBufferToBase64,
        base64ToArrayBuffer: base64ToArrayBuffer,
        detectImageMimeType: detectImageMimeType,
        dataUrlToParts: dataUrlToParts,
        toDataUrl: toDataUrl,
        fetchAsDataUrl: fetchAsDataUrl,

        sleep: sleep,
        fetchWithTimeout: fetchWithTimeout,
        requestJson: requestJson,
        extractApiError: extractApiError,
        friendlyError: friendlyError,
        abortError: abortError,

        uniqueId: uniqueId,
        formatTimestamp: formatTimestamp
    };
});
