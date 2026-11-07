/* ============================================================
 * chat-service.js — 文字对话 / 带图问答
 *
 * 负责「对话」这件事本身，不负责画界面：
 *   · 维护多轮历史（默认记住 8 轮，与原插件 CHAT_MEMORY_ROUNDS 一致）
 *   · 把选区图片拼成 OpenAI / Gemini 都能吃的多模态消息
 *   · 调 provider-api 发请求，从响应里抽文本
 *
 * 原始位置：
 *   index.js:1214-1252  系统提示词
 *   index.js:15166-15247 响应取文本 + buildChatContextMessages
 *   index.js:15249-15429 chat()（去掉 DOM / 按钮 / 日志后的业务部分）
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengChat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    function core() {
        if (root.HuanmengCore) return root.HuanmengCore;
        if (typeof require === 'function') {
            try { return require('../00-核心/core.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengCore 未加载');
    }

    function providerApi() {
        if (root.HuanmengProviderApi) return root.HuanmengProviderApi;
        if (typeof require === 'function') {
            try { return require('../01-生图API/provider-api.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengProviderApi 未加载');
    }

    var DEFAULT_MEMORY_ROUNDS = 8;

    /** 对话用的系统提示词（正向 + 逆向）。 */
    function buildSystemPrompt(settings) {
        var coreApi = core();
        var safe = settings || coreApi.getSettings();
        var positive = String(safe.textSystemPromptPositive == null
            ? coreApi.DEFAULTS.textSystemPromptPositive : safe.textSystemPromptPositive).trim();
        var negative = String(safe.textSystemPromptNegative == null
            ? coreApi.DEFAULTS.textSystemPromptNegative : safe.textSystemPromptNegative).trim();
        return [
            positive ? '正向要求：\n' + positive : '',
            negative ? '逆向约束（必须避免）：\n' + negative : ''
        ].filter(Boolean).join('\n\n');
    }

    /**
     * 组装一次请求的 messages。
     * history 里只保留 user/assistant 的纯文本，且去掉「[已添加选区图片]」标记，
     * 避免历史里的图片占位符污染后续请求。
     */
    function buildMessages(prompt, imageBase64, history, options) {
        var opts = options || {};
        var rounds = Math.max(0, Number(opts.memoryRounds) || DEFAULT_MEMORY_ROUNDS);
        var systemPrompt = opts.systemPrompt != null ? String(opts.systemPrompt) : buildSystemPrompt(opts.settings);
        var text = String(prompt || '请描述这张图片').trim();

        var recent = (Array.isArray(history) ? history : [])
            .filter(function (message) {
                return message && (message.role === 'user' || message.role === 'assistant')
                    && typeof message.content === 'string' && message.content.trim();
            })
            .slice(-(rounds * 2))
            .map(function (message) {
                return {
                    role: message.role,
                    content: message.content.replace(/\n\n\[已添加选区图片\]$/, '').trim()
                };
            })
            .filter(function (message) { return !!message.content; });

        var current = { role: 'user', content: text };
        if (imageBase64) {
            var imageUrl = /^data:image\//i.test(imageBase64)
                ? imageBase64
                : 'data:image/png;base64,' + String(imageBase64).replace(/\s+/g, '');
            current.content = [
                { type: 'text', text: text },
                { type: 'image_url', image_url: { url: imageUrl } }
            ];
        }

        var messages = recent.concat(current);
        if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt });
        return messages;
    }

    /**
     * 创建一个会话对象。
     *
     * var session = HuanmengChat.createSession({ model: 'grs/gemini-3.1-pro' });
     * await session.send({ text: '这张图的光比怎么样', imageBase64 });
     */
    function createSession(config) {
        var settings = config || {};
        var state = {
            model: settings.model || core().DEFAULTS.grsChatModel,
            provider: settings.provider || '',
            apiKey: settings.apiKey || '',
            baseUrl: settings.baseUrl || '',
            systemPrompt: settings.systemPrompt,
            memoryRounds: settings.memoryRounds == null ? DEFAULT_MEMORY_ROUNDS : settings.memoryRounds,
            history: Array.isArray(settings.history) ? settings.history.slice() : []
        };

        function getHistory() {
            return state.history.slice();
        }

        function clear() {
            state.history = [];
        }

        /**
         * 发送一条消息。图片可选。
         * 返回 { success, text, data, error }；成功后自动写入历史。
         */
        async function send(message) {
            var payload = typeof message === 'string' ? { text: message } : (message || {});
            var text = String(payload.text || '').trim();
            var image = payload.imageBase64 || '';
            if (!text && !image) return { success: false, error: '请输入消息或读取选区' };

            var messages = buildMessages(text, image, state.history, {
                memoryRounds: state.memoryRounds,
                systemPrompt: state.systemPrompt,
                settings: settings.settings
            });

            var displayText = text + (image ? (text ? '\n\n' : '') + '[已添加选区图片]' : '');
            state.history.push({ role: 'user', content: displayText, timestamp: core().formatTimestamp() });

            var result = await providerApi().chat({
                provider: state.provider || undefined,
                model: state.model,
                apiKey: state.apiKey || undefined,
                baseUrl: state.baseUrl || undefined,
                prompt: text || '请描述这张图片',
                messages: messages,
                signal: payload.signal,
                settings: settings.settings
            });

            if (!result.success) {
                state.history.push({
                    role: 'assistant',
                    content: '发送失败：' + (result.error || '未知错误'),
                    timestamp: core().formatTimestamp()
                });
                return { success: false, error: result.error || '未知错误', data: result.data };
            }

            var reply = result.text || '';
            if (!reply) {
                state.history.push({
                    role: 'assistant',
                    content: '发送失败：无法从响应中提取文本',
                    timestamp: core().formatTimestamp()
                });
                return { success: false, error: '无法从响应中提取文本', data: result.data };
            }

            state.history.push({ role: 'assistant', content: reply, timestamp: core().formatTimestamp() });
            return { success: true, text: reply, data: result.data };
        }

        return {
            send: send,
            getHistory: getHistory,
            clear: clear,
            setModel: function (modelValue) { state.model = modelValue; },
            setProvider: function (provider) { state.provider = provider; },
            getState: function () { return state; }
        };
    }

    /* ---------------- 与 Photoshop 选区配合 ---------------- */

    /**
     * 读取当前选区（优先）或整幅画布，返回 data URL，可直接塞给 session.send。
     * 需要在 Photoshop UXP 里运行。
     */
    async function readSelectionImage(options) {
        var opts = options || {};
        var ps = root.HuanmengPS;
        if (!ps) {
            if (typeof require === 'function') {
                try { ps = require('../00-核心/ps-host.js'); } catch (ignore) {}
            }
        }
        if (!ps || !ps.isAvailable()) throw new Error('Photoshop API 不可用');

        var bounds = opts.bounds || await ps.getTargetBounds();
        if (!bounds) throw new Error('没有可用选区，也没有活动文档');
        var base64 = await ps.captureSelectionBase64(bounds);
        if (!base64) throw new Error('读取选区像素失败');
        return { dataUrl: 'data:image/png;base64,' + base64, bounds: bounds };
    }

    /** 一句话给图片做分析（无需自己管会话）。 */
    async function analyzeImage(options) {
        var opts = options || {};
        var session = createSession({
            model: opts.model,
            provider: opts.provider,
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
            memoryRounds: 0,
            settings: opts.settings
        });
        return session.send({ text: opts.prompt || '请描述这张图片', imageBase64: opts.imageBase64, signal: opts.signal });
    }

    return {
        DEFAULT_MEMORY_ROUNDS: DEFAULT_MEMORY_ROUNDS,
        buildSystemPrompt: buildSystemPrompt,
        buildMessages: buildMessages,
        createSession: createSession,
        readSelectionImage: readSelectionImage,
        analyzeImage: analyzeImage
    };
});
