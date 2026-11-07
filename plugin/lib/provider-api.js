/* ============================================================
 * provider-api.js — 生图 / 对话的「供应商请求层」
 *
 * 一个文件吃下 10 个渠道的 HTTP 细节，向上只暴露两个方法：
 *   HuanmengProviderApi.generateImage(options)  // 文生图 / 图生图
 *   HuanmengProviderApi.chat(options)           // 文字对话（可带图）
 *
 * 支持的渠道（与原插件 index.js:2354-4105 的 API 对象一一对应）：
 *   grs        GRS（grsai.dakka.com.cn）nano-banana / gpt-image，轮询取图
 *   google     Google AI Studio（Gemini 图像模型）
 *   xai        xAI 官方 images/generations + edits
 *   grok2api   本地 grok2api 网关
 *   sub2api    Sub2API 聚合网关
 *   firefly    Firefly 兼容服务（先上传参考图）
 *   volcengine 火山方舟（SeeDream 走 provider-models 的请求体）
 *   vertex     Vertex AI（publishers 路径）
 *   newapi     New API（OpenAI 兼容；可走 images 或 chat）
 *   openai     OpenAI 兼容 images（扩展，原插件只支持 openai 对话）
 *
 * 约定：
 *   · 所有方法返回 { success:true, data } 或 { success:false, error }，不抛异常；
 *   · 超时/取消统一走 options.signal；
 *   · 图像输入统一用 data URL（也接受纯 base64 / 远程 URL）。
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengProviderApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    function core() {
        if (root.HuanmengCore) return root.HuanmengCore;
        if (typeof require === 'function') {
            try { return require('../00-核心/core.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengCore 未加载');
    }

    function modelConfig() {
        if (root.HuanmengModelConfig) return root.HuanmengModelConfig;
        if (typeof require === 'function') {
            try { return require('../00-核心/model-config.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengModelConfig 未加载');
    }

    function providerModels() {
        var api = core().getProviderModels();
        if (api) return api;
        if (typeof require === 'function') {
            try { return require('../00-核心/provider-models.js'); } catch (ignore) {}
        }
        return null;
    }

    function settingsOf(options) {
        return (options && options.settings) || core().getSettings();
    }

    /* ---------------- URL / 图像工具 ---------------- */

    /** base 末尾的 /v1 先去掉，避免拼出 /v1/v1/...（原插件的地址规范化约定）。 */
    function apiUrl(baseUrl, path) {
        var base = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
        return core().joinApiUrl(base, path);
    }

    function normalizeImageInput(image) {
        var text = String(image || '').trim();
        if (!text) return '';
        if (/^data:image\//i.test(text)) return text;
        if (/^https?:\/\//i.test(text)) return text;
        return 'data:image/png;base64,' + text.replace(/\s+/g, '');
    }

    function collectImages(options, limit) {
        var list = [];
        if (options && options.imageBase64) list.push(normalizeImageInput(options.imageBase64));
        var refs = options && Array.isArray(options.referenceImages) ? options.referenceImages : [];
        refs.forEach(function (item) { list.push(normalizeImageInput(item)); });
        return list.filter(Boolean).slice(0, limit || 16);
    }

    function toBase64Only(dataUrl) {
        var text = String(dataUrl || '');
        var index = text.indexOf(',');
        return index > -1 ? text.slice(index + 1) : text;
    }

    function normalizeGrsModelName(modelValue) {
        var name = core().getModelName(modelValue);
        if (String(name).toLowerCase() === 'gpt-imagine-2') return 'gpt-image-2';
        return name;
    }

    /* ---------------- 路由解析 ---------------- */

    /**
     * 把「provider/模型」+ 设置翻译成一次请求需要的全部连接信息。
     * 对应原插件 resolveImageApiRouting（index.js:1667-1803）。
     */
    function resolveRoute(modelValue, settings) {
        var coreApi = core();
        var safe = settings || coreApi.getSettings();
        var parsed = coreApi.parseModelSelection(modelValue);
        var provider = String(parsed.provider || '').toLowerCase();
        var model = parsed.model || coreApi.getModelName(modelValue);

        function make(name, apiKey, baseUrl, apiType, extra) {
            return Object.assign({
                provider: name,
                model: model,
                apiKey: apiKey || '',
                baseUrl: baseUrl || '',
                apiType: apiType || name
            }, extra || {});
        }

        if (coreApi.isNewApiProvider(provider)) {
            return make(provider, safe.newApiKey, safe.newApiUrl || coreApi.DEFAULTS.newApiBaseUrl, 'newapi', {
                missingKeyMessage: '请先在设置中配置 NewAPI 地址和密钥'
            });
        }
        if (provider === 'xai') {
            return make('xai', safe.xaiApiKey, safe.xaiApiUrl || coreApi.DEFAULTS.xaiBaseUrl, 'xai-images', {
                missingKeyMessage: '请先在设置中配置 xAI API Key'
            });
        }
        if (provider === 'grok2api') {
            return make('grok2api', safe.grok2apiApiKey, safe.grok2apiApiUrl || coreApi.DEFAULTS.grok2apiBaseUrl, 'grok2api-images', {
                missingKeyMessage: '请填写 grok2api 后台 Client Keys 创建的 g2a_... 密钥（不是管理员密码，也不是 xAI 官方 Key）'
            });
        }
        if (provider === 'sub2api') {
            return make('sub2api', safe.sub2apiApiKey, safe.sub2apiApiUrl || coreApi.DEFAULTS.sub2apiBaseUrl, 'sub2api-images', {
                missingKeyMessage: '请在 Sub2API 用户后台创建并填写 sk-... API Key'
            });
        }
        if (provider === 'firefly') {
            return make('firefly', safe.fireflyApiKey, safe.fireflyApiUrl || coreApi.DEFAULTS.fireflyBaseUrl, 'firefly-images', {
                apiKeyOptional: true,
                missingKeyMessage: '请先在设置中配置 Firefly 服务地址'
            });
        }
        if (provider === 'volcengine') {
            return make('volcengine', safe.volcengineApiKey, safe.volcengineApiUrl || coreApi.DEFAULTS.volcengineBaseUrl, 'volcengine-images', {
                missingKeyMessage: '请先在设置中配置火山方舟 API Key'
            });
        }
        if (provider === 'vertex-ai' || provider === 'vertex') {
            return make('vertex-ai', safe.vertexApiKey, safe.vertexApiUrl || coreApi.DEFAULTS.vertexBaseUrl, 'vertex', {
                missingKeyMessage: '请先在设置中配置 Vertex AI API Key'
            });
        }
        if (provider === 'google') {
            return make('google', safe.googleApiKey, safe.googleApiUrl || coreApi.DEFAULTS.googleBaseUrl, 'google', {
                missingKeyMessage: '请先在设置中配置 Google API Key'
            });
        }
        if (provider === 'openai') {
            return make('openai', safe.openaiApiKey || safe.chatApiKey, safe.openaiApiUrl || safe.chatApiUrl || coreApi.DEFAULTS.openaiBaseUrl, 'openai-images', {
                missingKeyMessage: '请先在设置中配置 OpenAI API Key'
            });
        }

        // 默认：GRS
        var grsBase = safe.grsRegion === 'overseas'
            ? coreApi.DEFAULTS.grsDefaultBaseUrl
            : (safe.grsRegion === 'domestic'
                ? coreApi.DEFAULTS.grsChinaBaseUrl
                : (safe.imgApiUrl || coreApi.DEFAULTS.grsChinaBaseUrl));
        return make('grs', safe.imgApiKey || safe.chatApiKey, grsBase, 'grs', {
            missingKeyMessage: '请先在设置中配置 GRS API 密钥'
        });
    }

    function validateRoute(route) {
        if (!route) return { valid: false, message: '无法解析模型渠道' };
        if (!route.apiKey && !route.apiKeyOptional) {
            return { valid: false, message: route.missingKeyMessage || '缺少 API 密钥' };
        }
        if ((core().isNewApiProvider(route.provider) || route.provider === 'vertex-ai' || route.provider === 'google') && !route.baseUrl && route.provider !== 'google') {
            return { valid: false, message: route.missingKeyMessage || '缺少服务地址' };
        }
        return { valid: true, route: route };
    }

    /* ---------------- 通用请求 ---------------- */

    async function postJson(url, body, options) {
        var opts = options || {};
        var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        var result = await core().requestJson(url, {
            method: opts.method || 'POST',
            headers: headers,
            body: body == null ? undefined : JSON.stringify(body),
            timeout: opts.timeout || 240000,
            signal: opts.signal
        });
        return result;
    }

    function fail(provider, message, extra) {
        return Object.assign({ success: false, error: (provider ? provider + '：' : '') + message }, extra || {});
    }

    /* ---------------- GRS ---------------- */

    async function pollGrsResult(baseUrl, apiKey, taskId, signal) {
        var maxAttempts = 120;
        var interval = 2500;
        var url = apiUrl(baseUrl, '/v1/draw/result');
        var lastMessage = '';
        for (var attempt = 0; attempt < maxAttempts; attempt++) {
            if (signal && signal.aborted) return { success: false, error: '请求已取消' };
            if (attempt > 0) await core().sleep(interval);

            var result = await core().requestJson(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                body: JSON.stringify({ id: taskId }),
                timeout: 60000,
                signal: signal
            });
            if (!result.ok) {
                // 网络抖动 / 服务端 5xx 都继续轮询；4xx 才认定任务真的查不了
                if (result.status === 0 || result.status >= 500) continue;
                return { success: false, error: '轮询任务失败: ' + (result.error || result.status) };
            }
            // 有的网关把结果包在 { data: {...} } 里，有的是 { data: [...] }；
            // 只有「对象且不是数组」才拆包，否则会把图片数组当成任务体。
            var payload = result.data;
            if (payload && payload.data && !Array.isArray(payload.data) && typeof payload.data === 'object') {
                payload = payload.data;
            }
            var status = String(payload && (payload.status || payload.state) || '').toLowerCase();
            lastMessage = (payload && (payload.message || payload.error || payload.failure_reason)) || '';

            // 只要已经带回图，不管状态字段写的是什么都算成功
            if (hasImagePayload(payload)) return { success: true, data: result.data };

            if (status === 'failed' || status === 'failure' || status === 'error'
                || status === 'cancelled' || status === 'canceled' || status === 'violation') {
                return {
                    success: false,
                    error: lastMessage || (status === 'violation' ? '内容违规，已被拒绝生成' : '绘图任务失败')
                };
            }
            if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'done') {
                return { success: false, error: '任务已完成但未返回可用图像。' + lastMessage };
            }
        }
        return { success: false, error: '任务仍在处理中，请稍后重试' };
    }

    /** 判断轮询响应里是否已经带回图像（避免把成功任务误判成"进行中"）。 */
    function hasImagePayload(payload) {
        if (!payload) return false;
        if (typeof payload === 'string') {
            return /^(https?:\/\/|data:image\/)/i.test(payload.trim());
        }
        if (Array.isArray(payload)) {
            return payload.some(function (item) {
                return hasImagePayload(item);
            });
        }
        if (typeof payload !== 'object') return false;

        var direct = ['url', 'image', 'image_url', 'img', 'b64_json', 'output', 'result_url', 'download_url', 'file_url'];
        for (var i = 0; i < direct.length; i++) {
            if (typeof payload[direct[i]] === 'string' && payload[direct[i]].trim()) return true;
        }
        // GRS 成功时的真实结构是 { status:"succeeded", results:[{url:"..."}] }。
        // 这里必须认 results；否则会把已经成功的任务误判成“没有可用图像”。
        var collections = ['data', 'result', 'results', 'output', 'outputs', 'images', 'artifacts'];
        for (var j = 0; j < collections.length; j++) {
            var value = payload[collections[j]];
            if (value == null) continue;
            if (Array.isArray(value)) {
                if (value.length && hasImagePayload(value)) return true;
            } else if (typeof value === 'object') {
                if (hasImagePayload(value)) return true;
            } else if (typeof value === 'string' && /^(https?:\/\/|data:image\/)/i.test(value.trim())) {
                return true;
            }
        }
        return false;
    }

    /**
     * GRS 生图：POST /v1/api/generate，再轮询 /v1/draw/result。
     * 对应 index.js:3941-4081（generateImage 的 GRS 分支）。
     */
    async function generateGrs(options) {
        var coreApi = core();
        var route = resolveRoute(options.model, settingsOf(options));
        var apiKey = coreApi.normalizeApiKey(options.apiKey || route.apiKey);
        if (!apiKey) return fail('GRS', route.missingKeyMessage || '缺少 API 密钥');
        var baseUrl = options.baseUrl || route.baseUrl;
        var model = coreApi.getModelName(options.model);
        var modelKey = coreApi.getModelKey(model);
        var images = collectImages(options, 16);
        var config = modelConfig().getModelImageConfig(model, options.sizeHint, options.imageResolution || options.imageSize);

        // 文本模型走 chat（有些界面把 GRS 的 gemini 当对话模型用）
        if (coreApi.isGrsChatModel(modelKey) && !images.length && options.preferChat) {
            return chat(Object.assign({}, options, {
                provider: 'grs', apiKey: apiKey, baseUrl: baseUrl, model: model
            }));
        }

        var body = {
            model: normalizeGrsModelName(model),
            prompt: options.prompt || '',
            // 关键：文生图时保持 'auto'，让 GRS 按输入图比例出图；否则回贴会错位。
            aspectRatio: options.aspectRatio || config.aspectRatio || 'auto',
            imageSize: options.imageSize || config.imageSize || '1K',
            replyType: 'json'
        };
        if (images.length) body.images = images;

        var url = apiUrl(baseUrl, '/v1/api/generate');
        var result = await postJson(url, body, {
            signal: options.signal,
            timeout: 180000,
            // GRS 的 /v1/api/generate 必须带 Bearer；少了这一行会被服务端判定为
            // “apikey is empty”，即使设置里已经保存了 Key。
            headers: { 'Authorization': 'Bearer ' + apiKey }
        });
        if (!result.ok) return fail('GRS 生图失败', core().friendlyError(result.error));

        var data = result.data || {};
        // 首次响应可能已经是终止态
        var payload = data && data.data && typeof data.data === 'object' ? data.data : data;
        var initialStatus = String(payload && (payload.status || payload.state) || '').toLowerCase();
        if (initialStatus === 'failed' || initialStatus === 'violation' || initialStatus === 'error'
            || initialStatus === 'cancelled' || initialStatus === 'canceled') {
            return {
                success: false,
                error: payload.error || payload.message
                    || (initialStatus === 'violation' ? '内容违规，已被拒绝生成' : '绘图任务失败')
            };
        }

        // 有些 GRS 线路会同步返回最终结果（status=succeeded + results[]），
        // 此时不要再轮询，否则会多等一轮，甚至把 results 误判成空图。
        if (hasImagePayload(payload)) {
            return {
                success: true,
                data: data,
                provider: 'grs',
                endpoint: url,
                taskId: payload.id || payload.taskId || payload.task_id || ''
            };
        }

        var taskId = payload && (payload.id || payload.taskId || payload.task_id || payload.requestId
            || (payload.data && (payload.data.id || payload.data.taskId)));
        if (taskId) {
            var polled = await pollGrsResult(baseUrl, apiKey, taskId, options.signal);
            if (!polled.success) return polled;
            return { success: true, data: polled.data, provider: 'grs', endpoint: url, taskId: taskId };
        }
        return { success: true, data: data, provider: 'grs', endpoint: url, taskId: '' };
    }

    /* ---------------- Google ---------------- */

    function safeBase64FromInline(inline) {
        if (!inline || typeof inline !== 'object') return '';
        var mime = inline.mimeType || inline.mime_type || 'image/png';
        var data = inline.data;
        if (typeof data !== 'string' || !data.trim()) return '';
        return 'data:' + mime + ';base64,' + data.trim();
    }

    async function generateGoogle(options) {
        var coreApi = core();
        var pm = providerModels();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        if (!apiKey) return fail('Google', '缺少 Google API Key');
        var model = coreApi.getModelName(options.model) || 'gemini-2.5-flash-image';
        var images = collectImages(options, 8);
        var config = modelConfig().getModelImageConfig(model, options.sizeHint, options.imageResolution);

        var allow4K = options.allow4K !== false;
        var hint = options.sizeHint;
        var longEdge = hint ? Math.max(Number(hint.width) || 0, Number(hint.height) || 0) : 0;
        var requested = String(options.imageResolution || options.imageSize || '').trim().toUpperCase();
        var tuned = pm && pm.isGoogleImageModel
            ? ((!requested || requested === 'AUTO') && longEdge > 0
                ? pm.pickTier(longEdge, model, { allow4KGeneration: allow4K })
                : pm.capResolution(requested || '2K', model, { allow4KGeneration: allow4K }))
            : (requested || '1K');

        var body;
        var url;
        if (pm && pm.isGoogleImageModel && pm.isGoogleImageModel(model)) {
            body = pm.buildGoogleRequest({
                model: model,
                prompt: options.prompt || '',
                imageBase64: options.imageBase64,
                referenceImages: options.referenceImages || [],
                resolution: tuned,
                aspectRatio: options.aspectRatio,
                textToImage: !options.imageBase64 && !(options.referenceImages || []).length,
                temperature: options.temperature,
                topP: options.topP
            });
            url = pm.buildGoogleUrl({
                model: model,
                apiKey: apiKey,
                useVertexApi: false,
                studioBaseUrl: options.baseUrl
            });
        } else {
            // 兜底：通用 Gemini generateContent
            var parts = images.map(function (image) {
                return { inlineData: { mimeType: 'image/png', data: toBase64Only(image) } };
            });
            parts.push({ text: options.prompt || '' });
            body = {
                contents: [{ role: 'user', parts: parts }],
                generationConfig: {
                    responseModalities: ['TEXT', 'IMAGE'],
                    imageConfig: { aspectRatio: modelConfig().normalizeSupportedAspectRatio(config.aspectRatio) }
                }
            };
            var googleBase = String(options.baseUrl || coreApi.DEFAULTS.googleBaseUrl)
                .replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/v1beta$/i, '');
            url = googleBase + '/v1beta/models/'
                + String(model).replace(/^models\//i, '') + ':generateContent';
        }

        var result = await postJson(url, body, {
            headers: { 'x-goog-api-key': apiKey },
            signal: options.signal,
            timeout: 300000
        });
        if (!result.ok) {
            var message = result.error || ('HTTP ' + result.status);
            if (result.status === 401 || result.status === 403) message = 'Google API 密钥无效或无权限：' + message;
            if (result.status === 429) message = 'Google 配额或频率受限：' + message;
            return fail('Google 生图失败', message);
        }
        var data = result.data || {};
        var payloadMessage = pm && pm.extractGoogleErrorMessage ? pm.extractGoogleErrorMessage(data) : '';
        if (payloadMessage) return fail('Google', payloadMessage);
        return { success: true, data: data, provider: 'google', endpoint: url };
    }

    /* ---------------- xAI / grok2api / Sub2API ---------------- */

    async function generateXai(options) {
        var coreApi = core();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        if (!apiKey) return { success: false, error: 'xAI API Key 无效，请检查设置' };
        var baseUrl = options.baseUrl || coreApi.DEFAULTS.xaiBaseUrl;
        var sourceImages = collectImages(options, 3);
        var model = coreApi.getModelName(options.model) || 'grok-imagine-image-quality';
        var aspect = modelConfig().normalizeSupportedAspectRatio(
            options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto'
                ? options.aspectRatio
                : modelConfig().getAspectRatioLabelByHint(options.sizeHint)
        );
        var body = {
            model: model,
            prompt: options.prompt || '',
            n: Math.max(1, Math.min(10, Number(options.n) || 1)),
            resolution: modelConfig().normalizeXaiResolution(options.imageResolution || options.imageSize, options.sizeHint),
            response_format: 'url'
        };
        var endpoint = '/v1/images/generations';
        if (sourceImages.length === 1) {
            endpoint = '/v1/images/edits';
            body.image = { type: 'image_url', url: sourceImages[0] };
        } else if (sourceImages.length > 1) {
            endpoint = '/v1/images/edits';
            body.images = sourceImages.map(function (image) { return { type: 'image_url', url: image }; });
        } else {
            body.aspect_ratio = aspect;
        }

        var url = core().joinApiUrl(baseUrl, endpoint);
        var result = await postJson(url, body, {
            headers: { Authorization: 'Bearer ' + apiKey },
            timeout: 240000,
            signal: options.signal
        });
        if (!result.ok) return { success: false, error: 'xAI 请求失败: ' + (result.error || result.status) };
        return { success: true, data: result.data, provider: 'xai', endpoint: url };
    }

    async function generateGrok2Api(options) {
        var coreApi = core();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        if (!apiKey) {
            return { success: false, error: '缺少 grok2api Client Key：请在 grok2api → Client Keys 创建 g2a_...，不要填写管理员密码或 xAI 官方 Key' };
        }
        var baseUrl = String(options.baseUrl || coreApi.DEFAULTS.grok2apiBaseUrl).replace(/\/v1$/i, '');
        var sourceImages = collectImages(options, 8);
        var selectedModel = coreApi.getModelName(options.model) || 'grok-imagine-image-2.0';
        var editModel = /-lite$/i.test(selectedModel) ? 'grok-imagine-image-edit' : selectedModel;
        var aspect = modelConfig().normalizeSupportedAspectRatio(
            options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto'
                ? options.aspectRatio
                : modelConfig().getAspectRatioLabelByHint(options.sizeHint)
        );
        var body = {
            model: sourceImages.length ? editModel : selectedModel,
            prompt: options.prompt || '',
            n: Math.max(1, Math.min(10, Number(options.n) || 1)),
            aspect_ratio: aspect,
            resolution: modelConfig().normalizeXaiResolution(options.imageResolution || options.imageSize, options.sizeHint),
            response_format: 'url',
            stream: false
        };
        if (sourceImages.length === 1) body.image = { url: sourceImages[0] };
        if (sourceImages.length > 1) body.images = sourceImages.map(function (image) { return { url: image }; });

        var endpoint = sourceImages.length ? '/v1/images/edits' : '/v1/images/generations';
        var url = core().joinApiUrl(baseUrl, endpoint);
        var result = await postJson(url, body, {
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer ' + apiKey
            },
            timeout: 240000,
            signal: options.signal
        });
        if (!result.ok) {
            if (result.status === 401) {
                return { success: false, error: 'grok2api 鉴权失败（401）：请填写 Client Keys 页面创建的 g2a_... 密钥；管理员密码和 xAI 官方 Key 均不能用于此处' };
            }
            return { success: false, error: 'grok2api 请求失败: ' + (result.error || result.status) };
        }
        return { success: true, data: result.data, provider: 'grok2api', endpoint: url };
    }

    async function generateSub2Api(options) {
        var coreApi = core();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        if (!apiKey) return { success: false, error: '缺少 Sub2API API Key：请在用户 API Key 页面创建 sk-... 密钥' };
        var baseUrl = String(options.baseUrl || coreApi.DEFAULTS.sub2apiBaseUrl).replace(/\/v1$/i, '');
        // Sub2API 的 edits 端点最多 3 张源图
        var sourceImages = collectImages(options, 3);
        var selectedModel = coreApi.getModelName(options.model) || 'grok-imagine-image-quality';
        var aspect = modelConfig().normalizeSupportedAspectRatio(
            options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto'
                ? options.aspectRatio
                : modelConfig().getAspectRatioLabelByHint(options.sizeHint)
        );
        var body = {
            model: sourceImages.length ? 'grok-imagine-edit' : selectedModel,
            prompt: options.prompt || '',
            n: Math.max(1, Math.min(10, Number(options.n) || 1)),
            aspect_ratio: aspect,
            resolution: modelConfig().normalizeXaiResolution(options.imageResolution || options.imageSize, options.sizeHint),
            response_format: 'url'
        };
        if (sourceImages.length === 1) body.image = { url: sourceImages[0] };
        if (sourceImages.length > 1) body.images = sourceImages.map(function (image) { return { url: image }; });

        var endpoint = sourceImages.length ? '/v1/images/edits' : '/v1/images/generations';
        var url = core().joinApiUrl(baseUrl, endpoint);
        var result = await postJson(url, body, {
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer ' + apiKey
            },
            timeout: 240000,
            signal: options.signal
        });
        if (!result.ok) {
            if (result.status === 401) return { success: false, error: 'Sub2API 鉴权失败（401）：请填写用户后台创建的 sk-... API Key' };
            if (result.status === 503) return { success: false, error: 'Sub2API 暂无可用的 Grok 图片账号或图片权限: ' + (result.error || '') };
            return { success: false, error: 'Sub2API 请求失败: ' + (result.error || result.status) };
        }
        return { success: true, data: result.data, provider: 'sub2api', endpoint: url };
    }

    /* ---------------- Firefly ---------------- */

    async function generateFirefly(options) {
        var coreApi = core();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        var baseUrl = options.baseUrl || coreApi.DEFAULTS.fireflyBaseUrl;
        if (!baseUrl) return { success: false, error: 'Firefly 服务地址无效' };

        var source = collectImages(options, 1)[0] || '';
        var config = modelConfig().getModelImageConfig(options.model, options.sizeHint, options.imageResolution);
        var headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
        var body = {
            channel: 'firefly',
            model: coreApi.getModelName(options.model) || 'google:firefly:colligo:gemini-flash',
            prompt: options.prompt || '',
            aspectRatio: modelConfig().normalizeSupportedAspectRatio(
                options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto'
                    ? options.aspectRatio : config.aspectRatio),
            resolution: 'full',
            size: { width: config.width, height: config.height },
            groundSearchEnabled: false,
            generationQuality: 'low'
        };

        if (source) {
            var mediaType = (core().dataUrlToParts(source) || {}).mimeType || 'image/png';
            var uploadHeaders = { 'Content-Type': mediaType };
            if (apiKey) uploadHeaders.Authorization = 'Bearer ' + apiKey;
            var upload = await core().requestJson(apiUrl(baseUrl, '/v1/storage/image'), {
                method: 'POST',
                headers: uploadHeaders,
                body: core().base64ToArrayBuffer(toBase64Only(source)),
                timeout: 240000,
                signal: options.signal
            });
            if (!upload.ok) return { success: false, error: 'Firefly 参考图上传失败: ' + (upload.error || upload.status) };
            var uploaded = upload.data && Array.isArray(upload.data.images) ? upload.data.images[0] : null;
            if (!uploaded || !uploaded.id) return { success: false, error: 'Firefly 上传成功，但未返回图片 ID' };
            body.referenceImageId = uploaded.id;
            if (upload.data.accountHandle) body.accountHandle = upload.data.accountHandle;
        }

        var url = apiUrl(baseUrl, '/v1/images/generations');
        var result = await postJson(url, body, { headers: headers, timeout: 240000, signal: options.signal });
        if (!result.ok) return { success: false, error: 'Firefly 请求失败: ' + (result.error || result.status) };
        return { success: true, data: result.data, provider: 'firefly', endpoint: url };
    }

    /* ---------------- 火山方舟 ---------------- */

    async function generateVolcengine(options) {
        var coreApi = core();
        var pm = providerModels();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        if (!apiKey) return { success: false, error: '请先配置火山方舟 API Key' };
        var baseUrl = options.baseUrl || coreApi.DEFAULTS.volcengineBaseUrl;
        var model = coreApi.getModelName(options.model) || coreApi.DEFAULTS.volcengineImageModel;
        var images = collectImages(options, 10);
        var resolution = modelConfig().normalizeImageResolution(options.imageResolution || options.imageSize || '2K');
        var allow4K = options.allow4K !== false;

        if (pm && pm.isSeedreamModel && pm.isSeedreamModel(model)) {
            var hint = options.sizeHint;
            var longEdge = hint ? Math.max(Number(hint.width) || 0, Number(hint.height) || 0) : 0;
            var chosen = String(options.imageResolution || '').toLowerCase() === 'auto' || !options.imageResolution;
            var tuned = chosen && longEdge > 0
                ? pm.pickTier(longEdge, model, { allow4KGeneration: allow4K })
                : pm.capResolution(resolution, model, { allow4KGeneration: allow4K });
            var body = pm.buildSeedreamRequest({
                model: model,
                prompt: options.prompt || '',
                resolution: tuned,
                aspectRatio: options.aspectRatio,
                imageBase64: options.imageBase64,
                referenceImages: options.referenceImages || [],
                textToImage: !options.imageBase64 && !(options.referenceImages || []).length
            });
            var url = core().joinApiUrl(baseUrl, '/images/generations');
            var result = await postJson(url, body, {
                headers: { Authorization: 'Bearer ' + apiKey },
                signal: options.signal,
                timeout: 300000
            });
            if (!result.ok) return { success: false, error: 'SeeDream 生图失败: ' + (result.error || result.status) };
            if (result.data && result.data.error) {
                return { success: false, error: 'SeeDream 生图失败: ' + core().extractApiError(result.data, '') };
            }
            return { success: true, data: result.data, provider: 'volcengine', endpoint: url };
        }

        var fallback = {
            model: model,
            prompt: options.prompt || '',
            size: resolution === '4K' ? '4K' : resolution === '1K' ? '1K' : '2K',
            response_format: 'url',
            watermark: false
        };
        if (images.length) fallback.image = images.length === 1 ? images[0] : images;
        var fallbackUrl = core().joinApiUrl(baseUrl, '/images/generations');
        var fallbackResult = await postJson(fallbackUrl, fallback, {
            headers: { Authorization: 'Bearer ' + apiKey },
            signal: options.signal,
            timeout: 300000
        });
        if (!fallbackResult.ok) return { success: false, error: '火山方舟生图失败: ' + (fallbackResult.error || fallbackResult.status) };
        return { success: true, data: fallbackResult.data, provider: 'volcengine', endpoint: fallbackUrl };
    }

    /* ---------------- Vertex / NewAPI / OpenAI ---------------- */

    async function generateVertex(options) {
        var coreApi = core();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        if (!apiKey) return { success: false, error: 'Vertex AI API Key 无效或未配置' };
        var baseUrl = options.baseUrl || coreApi.DEFAULTS.vertexBaseUrl;

        if (options.useVertexApi === false) {
            // 走 AI Studio 兼容端点
            return generateGoogle(Object.assign({}, options, { apiKey: apiKey }));
        }

        var model = coreApi.getModelName(options.model) || coreApi.DEFAULTS.vertexImageModel;
        var config = modelConfig().getModelImageConfig(model, options.sizeHint, options.imageResolution);
        var url = buildVertexUrl(baseUrl, model, 'generateContent', apiKey);
        var images = collectImages(options, 4);
        var parts = images.map(function (image) {
            return { inlineData: { mimeType: 'image/png', data: toBase64Only(image) } };
        });
        parts.push({ text: options.prompt || '' });
        var body = {
            contents: [{ role: 'user', parts: parts }],
            generationConfig: {
                responseModalities: ['IMAGE', 'TEXT'],
                imageConfig: {
                    aspectRatio: modelConfig().normalizeSupportedAspectRatio(config.aspectRatio),
                    imageOutputOptions: { mimeType: 'image/png' },
                    personGeneration: 'ALLOW_ALL'
                }
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }
            ]
        };
        var result = await postJson(url, body, {
            headers: { 'x-goog-api-key': apiKey, Authorization: 'Bearer ' + apiKey },
            signal: options.signal,
            timeout: 240000
        });
        if (!result.ok) return { success: false, error: 'Vertex AI 生图失败: ' + (result.error || result.status) };
        return { success: true, data: result.data, provider: 'vertex-ai', endpoint: url };
    }

    function buildVertexUrl(baseUrl, modelName, apiName, apiKey) {
        var coreApi = core();
        var base = coreApi.normalizeBaseUrl(baseUrl, coreApi.DEFAULTS.vertexBaseUrl);
        var model = String(modelName || '').replace(/^models\//i, '').trim();
        var action = apiName || 'generateContent';
        var url = base;
        if (url.indexOf(':' + action) === -1 && url.indexOf(':generateContent') === -1 && url.indexOf(':predict') === -1) {
            if (url.indexOf('/publishers/google/models/') > -1) {
                url = url.replace(/\/+$/, '') + (url.replace(/\/+$/, '').endsWith('/' + model) ? ':' + action : '/' + model + ':' + action);
            } else if (url.indexOf('/models/') > -1) {
                url = url.replace(/\/+$/, '') + (url.replace(/\/+$/, '').endsWith('/' + model) ? ':' + action : '/' + model + ':' + action);
            } else {
                url = coreApi.joinApiUrl(base, '/v1/publishers/google/models/' + model + ':' + action);
            }
        }
        if (apiKey && url.indexOf('key=') === -1) {
            url += (url.indexOf('?') > -1 ? '&' : '?') + 'key=' + encodeURIComponent(apiKey);
        }
        return url;
    }

    async function generateNewApi(options) {
        var coreApi = core();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        if (!apiKey) return { success: false, error: 'NewAPI 密钥无效，请检查 API 密钥设置' };
        var baseUrl = options.baseUrl || coreApi.DEFAULTS.newApiBaseUrl;
        if (!baseUrl) return { success: false, error: 'NewAPI 地址无效，请先在设置中填写 NewAPI 地址' };
        var config = modelConfig().getModelImageConfig(options.model, options.sizeHint, options.imageResolution);
        var images = collectImages(options, 16);
        var endpoint = images.length ? '/v1/images/edits' : '/v1/images/generations';
        var body = {
            model: coreApi.getModelName(options.model),
            prompt: options.prompt || '',
            n: Math.max(1, Math.min(10, Number(options.n) || 1))
        };
        var size = options.size || config.size;
        if (size && size !== 'auto') body.size = size;
        if (images.length) {
            body.images = images.map(function (image) { return { image_url: image }; });
        }
        var url = apiUrl(baseUrl, endpoint);
        var result = await postJson(url, body, {
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer ' + apiKey
            },
            timeout: 240000,
            signal: options.signal
        });
        if (!result.ok) {
            return {
                success: false,
                error: 'NewAPI ' + (images.length ? '图像编辑' : '图像生成') + '请求失败: ' + (result.error || result.status)
            };
        }
        return { success: true, data: result.data, provider: 'newapi', endpoint: url };
    }

    async function generateOpenAiImages(options) {
        var coreApi = core();
        var apiKey = coreApi.normalizeApiKey(options.apiKey);
        if (!apiKey) return { success: false, error: 'OpenAI API Key 无效' };
        var baseUrl = options.baseUrl || coreApi.DEFAULTS.openaiBaseUrl;
        var config = modelConfig().getModelImageConfig(options.model, options.sizeHint, options.imageResolution);
        var body = {
            model: coreApi.getModelName(options.model) || 'gpt-image-1',
            prompt: options.prompt || '',
            n: Math.max(1, Math.min(10, Number(options.n) || 1)),
            size: options.size || (config.size !== 'auto' ? config.size : '1024x1024')
        };
        var url = apiUrl(baseUrl, '/v1/images/generations');
        var result = await postJson(url, body, {
            headers: { Authorization: 'Bearer ' + apiKey },
            signal: options.signal,
            timeout: 240000
        });
        if (!result.ok) return { success: false, error: 'OpenAI 生图失败: ' + (result.error || result.status) };
        return { success: true, data: result.data, provider: 'openai', endpoint: url };
    }

    /* ---------------- 统一生图入口 ---------------- */

    async function generateImage(options) {
        var opts = options || {};
        var coreApi = core();
        // 没传模型时用设置里的默认生图模型（不是 getModelName(undefined) 的兜底值）
        var modelValue = opts.model || coreApi.getSettings().imgModel || coreApi.DEFAULTS.imageModel;
        var parsed = coreApi.parseModelSelection(modelValue);
        var provider = String(opts.provider || parsed.provider || '').toLowerCase();
        var route = resolveRoute(modelValue, settingsOf(opts));
        var merged = Object.assign({}, route, opts, {
            provider: provider || route.provider,
            model: coreApi.getModelName(modelValue) || route.model
        });
        // 显式传入的 key/baseUrl 优先
        merged.apiKey = opts.apiKey || route.apiKey;
        merged.baseUrl = opts.baseUrl || route.baseUrl;

        try {
            if (merged.provider === 'grs') return await generateGrs(merged);
            if (merged.provider === 'google') return await generateGoogle(merged);
            if (merged.provider === 'xai') return await generateXai(merged);
            if (merged.provider === 'grok2api') return await generateGrok2Api(merged);
            if (merged.provider === 'sub2api') return await generateSub2Api(merged);
            if (merged.provider === 'firefly') return await generateFirefly(merged);
            if (merged.provider === 'volcengine') return await generateVolcengine(merged);
            if (merged.provider === 'vertex-ai' || merged.provider === 'vertex') return await generateVertex(merged);
            if (merged.provider === 'openai') return await generateOpenAiImages(merged);
            if (coreApi.isNewApiProvider(merged.provider)) {
                var mode = String(opts.newApiImageMode || 'auto').toLowerCase();
                var imagesResult = mode === 'chat' ? { success: false, error: 'skip images api' } : await generateNewApi(merged);
                if (imagesResult.success) return imagesResult;
                if (mode === 'images') return imagesResult;
                // auto：images 失败后回落 chat
                return await chat(Object.assign({}, merged, { provider: merged.provider }));
            }
            return {
                success: false,
                error: '当前模型不受支持：' + (opts.model || '(空)') + '。请使用 GRS、Google、xAI、grok2api、Sub2API、Firefly、火山方舟、Vertex 或 NewAPI 模型。'
            };
        } catch (error) {
            if (error && error.name === 'AbortError') return { success: false, error: '请求已取消' };
            return { success: false, error: error && error.message ? error.message : String(error) };
        }
    }

    /* ---------------- 对话 ---------------- */

    function messagesFrom(options) {
        if (Array.isArray(options.messages) && options.messages.length) return options.messages;
        return [{ role: 'user', content: options.prompt || '' }];
    }

    function toGoogleContents(messages) {
        return messages.map(function (message) {
            var role = message.role === 'assistant' ? 'model' : (message.role === 'system' ? 'user' : 'user');
            var parts = [];
            if (typeof message.content === 'string') {
                parts.push({ text: message.content });
            } else if (Array.isArray(message.content)) {
                message.content.forEach(function (part) {
                    if (part.type === 'text' || part.text) {
                        parts.push({ text: part.text || part.content || '' });
                    } else if (part.type === 'image_url' && part.image_url) {
                        var url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
                        var match = String(url || '').match(/^data:(image\/\w+);base64,(.+)$/);
                        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                    }
                });
            }
            return { role: role, parts: parts };
        });
    }

    /**
     * 文字对话 / 视觉问答。
     * 返回 { success, data, text }，text 已从各家响应里抽好。
     */
    async function chat(options) {
        var opts = options || {};
        var coreApi = core();
        var modelValue = opts.model || coreApi.getSettings().chatModel || coreApi.DEFAULTS.grsChatModel;
        var route = resolveRoute(modelValue, settingsOf(opts));
        var provider = String(opts.provider || route.provider || 'grs').toLowerCase();
        var apiKey = coreApi.normalizeApiKey(opts.apiKey || route.apiKey);
        var baseUrl = opts.baseUrl || route.baseUrl;
        var model = coreApi.getModelName(modelValue) || route.model;
        var messages = messagesFrom(opts);

        if (!apiKey && provider !== 'firefly') return { success: false, error: route.missingKeyMessage || '缺少 API 密钥' };

        try {
            var url;
            var body;

            if (provider === 'google') {
                url = 'https://generativelanguage.googleapis.com/v1beta/models/'
                    + String(model).replace(/^models\//i, '') + ':generateContent';
                body = {
                    contents: toGoogleContents(messages),
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }
                    ]
                };
                var googleResult = await postJson(url, body, {
                    headers: { 'x-goog-api-key': apiKey },
                    signal: opts.signal
                });
                if (!googleResult.ok) return { success: false, error: 'Google 请求失败: ' + (googleResult.error || googleResult.status) };
                return { success: true, data: googleResult.data, text: extractChatText(googleResult.data), provider: provider };
            }

            if (provider === 'vertex-ai' || provider === 'vertex') {
                url = buildVertexUrl(baseUrl, model, 'generateContent', apiKey);
                body = { contents: toGoogleContents(messages) };
                var vertexResult = await postJson(url, body, {
                    headers: { 'x-goog-api-key': apiKey, Authorization: 'Bearer ' + apiKey },
                    signal: opts.signal
                });
                if (!vertexResult.ok) return { success: false, error: 'Vertex AI 请求失败: ' + (vertexResult.error || vertexResult.status) };
                return { success: true, data: vertexResult.data, text: extractChatText(vertexResult.data), provider: 'vertex-ai' };
            }

            // OpenAI 兼容：GRS / NewAPI / 火山方舟 / grok2api / Sub2API
            var path = coreApi.isNewApiProvider(provider) || provider === 'grs'
                || provider === 'openai' || provider === 'xai'
                ? '/v1/chat/completions'
                : '/chat/completions';
            url = apiUrl(baseUrl, path);
            body = {
                model: model,
                stream: false,
                messages: messages
            };
            // OpenAI 兼容分支同样必须带 Bearer。漏掉时 GRS / NewAPI 等会把
            // 请求当作匿名调用，返回 “apikey is empty”。
            var chatHeaders = { 'Content-Type': 'application/json' };
            if (apiKey) chatHeaders.Authorization = 'Bearer ' + apiKey;
            var result = await postJson(url, body, { signal: opts.signal, headers: chatHeaders });
            if (!result.ok) {
                return { success: false, error: provider + ' 请求失败: ' + (result.error || result.status) };
            }
            return { success: true, data: result.data, text: extractChatText(result.data), provider: provider };
        } catch (error) {
            if (error && error.name === 'AbortError') return { success: false, error: '请求已取消' };
            return { success: false, error: error && error.message ? error.message : String(error) };
        }
    }

    function textFromContentParts(content) {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.map(function (part) {
            if (!part) return '';
            if (typeof part === 'string') return part;
            if (typeof part.text === 'string') return part.text;
            if (part.content && typeof part.content.text === 'string') return part.content.text;
            if (typeof part.content === 'string') return part.content;
            return '';
        }).filter(Boolean).join('\n').trim();
    }

    /**
     * 从各家响应里抽文本。
     * 覆盖 OpenAI（choices[].message/delta）、Gemini（candidates[].content.parts[].text）、
     * 以及 { message } / { data } 包裹的网关。对应 index.js:15166-15215。
     */
    function extractChatText(responseData) {
        if (!responseData) return '';
        if (responseData.choices && responseData.choices[0]) {
            var choice = responseData.choices[0];
            if (choice.message) {
                var messageContent = textFromContentParts(choice.message.content);
                if (messageContent) return messageContent;
            }
            if (choice.delta) {
                var deltaContent = textFromContentParts(choice.delta.content);
                if (deltaContent) return deltaContent;
            }
            var choiceText = textFromContentParts(choice.text || choice.content);
            if (choiceText) return choiceText;
        }
        if (responseData.candidates && responseData.candidates[0]
            && responseData.candidates[0].content && responseData.candidates[0].content.parts) {
            var parts = responseData.candidates[0].content.parts;
            var text = '';
            for (var i = 0; i < parts.length; i++) {
                if (parts[i] && parts[i].text) text += parts[i].text + '\n';
            }
            if (text.trim()) return text.trim();
        }
        if (responseData.message) {
            var messageText = textFromContentParts(responseData.message.content || responseData.message.text);
            if (messageText) return messageText;
        }
        if (responseData.data) {
            var dataText = textFromContentParts(responseData.data.text || responseData.data.content
                || (responseData.data.message && responseData.data.message.content));
            if (dataText) return dataText;
        }
        return textFromContentParts(responseData.content || responseData.text || responseData.output_text);
    }

    /* ---------------- 模型列表 ---------------- */

    async function listModels(options) {
        var opts = options || {};
        var coreApi = core();
        var route = resolveRoute(opts.model || opts.provider, settingsOf(opts));
        var provider = String(opts.provider || route.provider || 'grs').toLowerCase();
        var apiKey = coreApi.normalizeApiKey(opts.apiKey || route.apiKey);
        var baseUrl = opts.baseUrl || route.baseUrl;
        if (!apiKey) return { success: false, error: route.missingKeyMessage || '缺少 API 密钥' };

        var url;
        if (provider === 'grs') url = coreApi.joinApiUrl(baseUrl, '/v1beta/models');
        else if (coreApi.isNewApiProvider(provider) || provider === 'openai') url = apiUrl(baseUrl, '/v1/models');
        else if (provider === 'xai') url = coreApi.joinApiUrl(baseUrl, '/v1/models');
        else return { success: false, error: '该渠道不支持模型列表' };

        var result = await core().requestJson(url, {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + apiKey },
            timeout: 180000,
            signal: opts.signal
        });
        if (!result.ok) return { success: false, error: result.error || ('HTTP ' + result.status) };
        return { success: true, data: result.data };
    }

    return {
        resolveRoute: resolveRoute,
        validateRoute: validateRoute,
        generateImage: generateImage,
        chat: chat,
        listModels: listModels,
        extractChatText: extractChatText,

        // 单独暴露，方便只接某一个渠道或写测试
        providers: {
            grs: generateGrs,
            google: generateGoogle,
            xai: generateXai,
            grok2api: generateGrok2Api,
            sub2api: generateSub2Api,
            firefly: generateFirefly,
            volcengine: generateVolcengine,
            vertex: generateVertex,
            newapi: generateNewApi,
            openai: generateOpenAiImages
        },

        buildVertexUrl: buildVertexUrl,
        buildUrl: apiUrl,
        normalizeImageInput: normalizeImageInput,
        collectImages: collectImages
    };
});
