/* ZHUANG-AI插件 · 对话与工具箱
 * 对话、放回校色、辉光、图片特效、超分辨率、ComfyUI。
 */
(function (root) {
    'use strict';

    var api = null;
    var state = {
        chatBusy: false,
        chatVision: true,
        chatHistory: [],
        chatAbort: null,
        tool: 'glow',
        toolBusy: false,
        preview: { docId: null, dataUrl: '', label: '当前画面' },
        previewBusy: false,
        values: {
            color: { method: 'wavelet', strength: 100 },
            glow: { style: 'shine', strength: 47, radius: 81 },
            vfx: { mode: 'local', preset: 'heat', intensity: 48, effect: 'energy-trail', color: '#00f0ff' },
            superres: { factor: 2, overlap: 128 }
        },
        comfy: {
            localBaseUrl: 'http://127.0.0.1:8188',
            baseUrl: 'http://127.0.0.1:8188',
            workflowText: '',
            workflow: null,
            workflowLabel: '未载入',
            workflowName: '',
            workflows: [],
            loading: false,
            loadingWorkflow: false,
            paramModel: null,
            paramValues: {},
            paramWorkflowName: '',
            listVisible: true
        }
    };

    var CHAT_MODELS = {
        grs: { model: 'grs/gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
        google: { model: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        'vertex-ai': { model: 'vertex-ai/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        volcengine: { model: 'volcengine/doubao-seed-1-6-250615', name: 'Doubao Seed 1.6' },
        openai: { model: 'openai/gpt-4o-mini', name: 'GPT-4o mini' },
        xai: { model: 'xai/grok-3-mini', name: 'Grok 3 mini' },
        newapi: { model: 'newapi-gemini/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        'newapi-gemini': { model: 'newapi-gemini/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        'newapi-openai': { model: 'newapi-openai/gpt-4o-mini', name: 'GPT-4o mini' }
    };

    var TOOL_DEFS = [
        { id: 'glow', name: '辉光', desc: '柔光、白光、星芒、横向拉丝', icon: 'sun', tag: '本地' },
        { id: 'vfx', name: '图片特效', desc: '热浪 / 气流 / 刀光，或 AI 能量特效', icon: 'bolt', tag: '本地 / AI' },
        { id: 'superres', name: 'AI 超分', desc: '2x / 3x / 4x 切片放大，再拼回原位', icon: 'expand', tag: 'AI' }
    ];

    /* ---------------- ComfyUI 本地服务 / 内置工作流 ---------------- */

    var COMFY_LOCAL_URL_KEY = 'zhuang_ai_comfy_local_url_v1';
    var COMFY_DEFAULT_LOCAL_URL = 'http://127.0.0.1:8188';

    function readStored(key, fallback) {
        try {
            var value = localStorage.getItem(key);
            return value == null || value === '' ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function writeStored(key, value) {
        try { localStorage.setItem(key, String(value)); } catch (error) {}
    }

    function builtinWorkflowItems() {
        var bundle = root.ZHUANG_BUILTIN_WORKFLOWS;
        return bundle && Array.isArray(bundle.items) ? bundle.items : [];
    }

    function builtinWorkflowById(id) {
        var items = builtinWorkflowItems();
        for (var index = 0; index < items.length; index++) {
            if (items[index].id === id) return items[index];
        }
        return null;
    }

    function builtinWorkflowByName(name) {
        var items = builtinWorkflowItems();
        for (var index = 0; index < items.length; index++) {
            if (items[index].name === name) return items[index];
        }
        return null;
    }

    function builtinWorkflowDefault() {
        var bundle = root.ZHUANG_BUILTIN_WORKFLOWS;
        var item = bundle && bundle.defaultId ? builtinWorkflowById(bundle.defaultId) : null;
        if (item) return item;
        var items = builtinWorkflowItems();
        return items.length ? items[0] : null;
    }

    function comfyBaseForChannel(client) {
        var base = client.setBaseUrl(state.comfy.localBaseUrl || COMFY_DEFAULT_LOCAL_URL);
        state.comfy.baseUrl = base;
        return base;
    }

    function comfyLocalUrl() {
        return state.comfy.localBaseUrl || COMFY_DEFAULT_LOCAL_URL;
    }

    function setComfyLocalUrl(value) {
        var client = comfyClient();
        var normalized = client.normalizeBaseUrl(value || COMFY_DEFAULT_LOCAL_URL);
        if (!normalized) normalized = COMFY_DEFAULT_LOCAL_URL;
        state.comfy.localBaseUrl = normalized;
        writeStored(COMFY_LOCAL_URL_KEY, normalized);
        if (typeof client.clearObjectInfoCache === 'function') client.clearObjectInfoCache();
        state.comfy.baseUrl = client.setBaseUrl(normalized);
        return normalized;
    }

    function core() {
        if (root.HuanmengCore) return root.HuanmengCore;
        throw new Error('HuanmengCore 未加载');
    }

    function ps() {
        if (root.HuanmengPS) return root.HuanmengPS;
        throw new Error('HuanmengPS 未加载');
    }

    function $(id) {
        return document.getElementById(id);
    }

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function icon(name) {
        return root.ZhuangIcons.svg(name);
    }

    function prettyError(error) {
        var message = error && error.message ? error.message : String(error || '未知错误');
        if (api && typeof api.friendlyError === 'function') return api.friendlyError(message);
        return message;
    }

    /* ComfyUI 的错误里可能带服务地址；界面不显示地址，统一遮掉。 */
    function comfyErrorText(error) {
        return String(prettyError(error) || '')
            .replace(/https?:\/\/[^\s，。；、）)]+/gi, '[地址已隐藏]')
            .replace(/\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/g, '[地址已隐藏]');
    }

    function toast(message, kind) {
        if (api && typeof api.toast === 'function') api.toast(message, kind);
    }

    function requirePS() {
        if (!ps().isAvailable()) throw new Error('Photoshop API 不可用，请在 Photoshop 面板里使用');
    }

    function providerKey(providerId) {
        var info = root.ZhuangData.providerInfo(providerId);
        var settings = core().getSettings();
        var value = settings[info.keyField] || '';
        if (!value && info.id === 'grs') value = settings.chatApiKey || '';
        if (!value && info.id === 'openai') value = settings.chatApiKey || '';
        return value;
    }

    function chatModelInfo() {
        var imageMeta = root.ZhuangData.findModel(core().getSettings().imgModel);
        var config = CHAT_MODELS[imageMeta.provider] || CHAT_MODELS.grs;
        var info = root.ZhuangData.providerInfo(root.ZhuangData.parseProvider(config.model));
        return {
            model: config.model,
            name: config.name,
            provider: info
        };
    }

    function updateChatModelLabel() {
        var info = chatModelInfo();
        var label = $('chatModelLabel');
        var dot = document.querySelector('.chat-model-label .model-mini-dot');
        if (label) {
            label.textContent = info.name;
            label.title = '对话模型：' + info.name + '（跟随当前图片渠道）';
        }
        if (dot) dot.classList.toggle('is-off', !providerKey(info.provider.id));
    }

    /* ================= 对话 ================= */

    function scrollChat() {
        var scroller = $('chatPageScroll');
        if (!scroller) return;
        if (root.ZhuangScroll && typeof root.ZhuangScroll.scrollToBottom === 'function') {
            root.ZhuangScroll.scrollToBottom(scroller);
            return;
        }
        scroller.scrollTop = scroller.scrollHeight;
    }

    function appendChatMessage(role, text, options) {
        var host = $('chatPageMessages');
        if (!host) return null;
        var opts = options || {};
        var html = '';
        if (role === 'user') {
            html = '<div class="msg msg-user" data-chat-dynamic>' +
                '<div class="avatar avatar-user">你</div>' +
                '<div class="bubble"><div class="bubble-text">' + esc(text) + '</div>' +
                (opts.image ? '<div class="chat-attachment">' + icon('eye') + '<span>已带当前画面</span></div>' : '') +
                '</div></div>';
        } else if (role === 'error') {
            html = '<div class="msg" data-chat-dynamic>' +
                '<div class="avatar avatar-assistant">Z</div>' +
                '<div class="bubble bubble-assistant bubble-error">' +
                '<div class="bubble-title">这次没回答出来</div>' +
                '<div class="error-detail">' + esc(text) + '</div></div></div>';
        } else {
            html = '<div class="msg" data-chat-dynamic>' +
                '<div class="avatar avatar-assistant">Z</div>' +
                '<div class="bubble bubble-assistant">' +
                '<div class="bubble-text chat-answer">' + esc(text) + '</div></div></div>';
        }
        host.insertAdjacentHTML('beforeend', html);
        scrollChat();
        return host.lastElementChild;
    }

    function appendChatProgress(text) {
        var host = $('chatPageMessages');
        if (!host) return null;
        var id = 'chat_progress_' + Date.now();
        host.insertAdjacentHTML('beforeend',
            '<div class="msg" data-chat-dynamic id="' + id + '">' +
            '<div class="avatar avatar-assistant">Z</div>' +
            '<div class="bubble bubble-assistant progress-bubble">' +
            '<div class="typing"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>' +
            '<div class="progress-line"><span class="spinner"></span><span data-chat-progress-text>' + esc(text) + '</span>' +
            '<span class="cancel-link" data-chat-cancel>取消</span></div></div></div>');
        var node = $(id);
        var cancel = node ? node.querySelector('[data-chat-cancel]') : null;
        if (cancel) {
            cancel.addEventListener('click', function () {
                if (state.chatAbort) {
                    try { state.chatAbort.abort(); } catch (ignore) {}
                }
                cancel.textContent = '正在取消';
                cancel.style.color = '#b1b7b2';
            });
        }
        scrollChat();
        return {
            node: node,
            setText: function (value) {
                var target = node ? node.querySelector('[data-chat-progress-text]') : null;
                if (target) target.textContent = value;
            },
            remove: function () {
                if (node && node.parentNode) node.parentNode.removeChild(node);
            }
        };
    }

    function setChatBusy(busy) {
        state.chatBusy = busy;
        var button = $('chatSend');
        var label = $('chatSendLabel');
        if (button) button.classList.toggle('is-busy', busy);
        if (label) label.textContent = busy ? '回答中' : '发送';
    }

    async function sendChat() {
        if (state.chatBusy) return;
        var input = $('chatInput');
        var text = String((input && input.value) || '').trim();
        if (!text) {
            toast('先写一个问题');
            if (input) input.focus();
            return;
        }
        var info = chatModelInfo();
        if (!providerKey(info.provider.id)) {
            toast('当前对话渠道缺少 API Key，请先在设置里配置');
            return;
        }

        var hasImage = !!state.chatVision;
        if (root.ZhuangLog) {
            root.ZhuangLog.info('对话', '发送对话请求', {
                model: info.model,
                hasImage: hasImage
            });
        }
        appendChatMessage('user', text, { image: hasImage });
        if (input) input.value = '';
        setChatBusy(true);
        var progress = appendChatProgress(hasImage ? '正在读取当前画面…' : '正在思考…');
        state.chatAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;

        try {
            var imageBase64 = null;
            if (hasImage) {
                requirePS();
                var bounds = await ps().getTargetBounds();
                if (!bounds) throw new Error('没有可用选区，也没有活动文档');
                var base64 = await ps().captureSelectionBase64(bounds);
                if (!base64) throw new Error('读取画面失败');
                imageBase64 = 'data:image/png;base64,' + base64;
                if (progress) progress.setText('正在请求对话模型…');
            } else if (progress) {
                progress.setText('正在请求对话模型…');
            }

            var session = root.HuanmengChat.createSession({
                model: info.model,
                settings: core().getSettings(),
                history: state.chatHistory,
                memoryRounds: 8
            });
            var result = await session.send({
                text: text,
                imageBase64: imageBase64,
                signal: state.chatAbort ? state.chatAbort.signal : undefined
            });
            state.chatHistory = session.getHistory();
            if (progress) progress.remove();
            if (result.success) {
                if (root.ZhuangLog) root.ZhuangLog.success('对话', '对话返回', { model: info.model });
                appendChatMessage('assistant', result.text);
            } else {
                if (root.ZhuangLog) root.ZhuangLog.error('对话', '对话返回失败', result.error || '未知错误');
                appendChatMessage('error', result.error || '未知错误');
            }
        } catch (error) {
            if (progress) progress.remove();
            if (error && error.name === 'AbortError') {
                if (root.ZhuangLog) root.ZhuangLog.warn('对话', '用户取消对话');
                toast('已取消');
            } else {
                if (root.ZhuangLog) root.ZhuangLog.error('对话', '对话请求失败', error && error.message);
                appendChatMessage('error', prettyError(error));
            }
        } finally {
            if (progress) progress.remove();
            setChatBusy(false);
            state.chatAbort = null;
        }
    }

    function clearChat() {
        if (state.chatAbort) {
            try { state.chatAbort.abort(); } catch (ignore) {}
        }
        state.chatHistory = [];
        var host = $('chatPageMessages');
        if (host) {
            var dynamic = host.querySelectorAll('[data-chat-dynamic]');
            for (var index = 0; index < dynamic.length; index++) {
                dynamic[index].parentNode.removeChild(dynamic[index]);
            }
        }
        var input = $('chatInput');
        if (input) input.value = '';
        toast('对话已清空');
    }

    function bindChat() {
        var send = $('chatSend');
        if (send) send.addEventListener('click', sendChat);
        var clear = $('chatClear');
        if (clear) clear.addEventListener('click', clearChat);
        var vision = $('chatVisionToggle');
        if (vision) {
            vision.addEventListener('click', function () {
                state.chatVision = !state.chatVision;
                vision.classList.toggle('is-on', state.chatVision);
            });
        }
        var input = $('chatInput');
        if (input) {
            input.addEventListener('keydown', function (event) {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    sendChat();
                }
            });
        }
        var quick = $('chatQuickPrompts');
        if (quick) {
            quick.addEventListener('click', function (event) {
                var node = event.target.closest('[data-chat-quick]');
                if (!node) return;
                if (input) {
                    input.value = node.getAttribute('data-chat-quick');
                    input.focus();
                }
            });
        }
    }

    /* ================= 工具入口 ================= */

    function toolDef(id) {
        for (var index = 0; index < TOOL_DEFS.length; index++) {
            if (TOOL_DEFS[index].id === id) return TOOL_DEFS[index];
        }
        return TOOL_DEFS[0];
    }

    function renderTools() {
        var host = $('page-tools');
        if (!host) return;
        var rows = TOOL_DEFS.map(function (tool) {
            return '<div class="tool-card" data-tool-id="' + esc(tool.id) + '" role="button" tabindex="0">' +
                '<div class="tool-card-icon">' + icon(tool.icon) + '</div>' +
                '<div class="tool-card-copy"><div class="tool-card-name">' + esc(tool.name) +
                '</div><div class="tool-card-desc">' + esc(tool.desc) + '</div></div>' +
                '<div class="tool-card-tag">' + esc(tool.tag) + '</div>' +
                '<div class="tool-card-arrow">' + icon('chevronRight') + '</div></div>';
        }).join('');
        host.innerHTML = '<div class="page-scroll">' +
            '<div class="page-head"><div class="page-head-copy">' +
            '<div class="page-head-title">工具箱</div>' +
            '<div class="page-head-desc">都使用当前文档；选区优先，没有选区时用整幅画布。</div></div></div>' +
            '<div class="tool-list">' + rows + '</div>' +
            '<div class="tool-footnote">校色、辉光、本地特效在电脑上计算；AI 特效、超分会走当前模型。ComfyUI 在左侧独立入口。</div>' +
            '</div>';
    }

    function setToolStatus(text, kind) {
        var node = document.querySelector('.page.is-active [data-tool-status]');
        if (!node) return;
        node.textContent = text || '';
        node.className = 'tool-status' + (kind ? ' is-' + kind : '');
    }

    function setToolBusy(busy, label) {
        state.toolBusy = busy;
        var button = document.querySelector('.page.is-active [data-tool-run]') || document.querySelector('[data-tool-run]');
        if (!button) return;
        button.classList.toggle('is-disabled', busy);
        var span = button.querySelector('[data-tool-run-label]');
        if (span) span.textContent = busy ? (label || '处理中…') : (button.getAttribute('data-label') || '开始处理');
    }

    function previewMarkup() {
        var dataUrl = state.preview.dataUrl;
        return '<div class="tool-preview" data-tool-preview' + (dataUrl ? ' data-preview-open' : '') + '>' +
            '<div class="tool-preview-empty"' + (dataUrl ? ' hidden' : '') + '>' +
            icon('image') + '<span>打开文档后显示当前画面</span></div>' +
            '<img class="tool-preview-image' + (dataUrl ? '' : ' hidden') + '" data-tool-preview-image' +
            (dataUrl ? ' src="' + esc(dataUrl) + '"' : '') + ' alt="当前画面预览">' +
            '<div class="tool-preview-meta"><span data-tool-preview-label>' + esc(state.preview.label || '当前画面') + '</span>' +
            '<span class="tool-preview-action">点击查看</span></div>' +
            '</div>';
    }

    function updatePreviewDom() {
        var wrap = document.querySelector('.page.is-active [data-tool-preview]') ||
            document.querySelector('[data-tool-preview]');
        if (!wrap) return;
        var image = wrap.querySelector('[data-tool-preview-image]');
        var empty = wrap.querySelector('.tool-preview-empty');
        var label = wrap.querySelector('[data-tool-preview-label]');
        if (state.preview.dataUrl) {
            wrap.setAttribute('data-preview-open', '');
            if (image) {
                image.src = state.preview.dataUrl;
                image.classList.remove('hidden');
            }
            if (empty) empty.classList.add('hidden');
        } else {
            wrap.removeAttribute('data-preview-open');
            if (image) {
                image.removeAttribute('src');
                image.classList.add('hidden');
            }
            if (empty) empty.classList.remove('hidden');
        }
        if (label) label.textContent = state.preview.label || '当前画面';
    }

    async function refreshToolPreview(force, label) {
        if (state.previewBusy) return;
        if (!force && state.preview.dataUrl) {
            updatePreviewDom();
            return;
        }
        if (root.ZHUANG_DEMO && root.ZhuangDemo && root.ZhuangDemo.samples) {
            state.preview = {
                docId: null,
                dataUrl: root.ZhuangDemo.samples.mountain,
                label: label || '当前画面'
            };
            updatePreviewDom();
            return;
        }
        if (!ps().isAvailable()) {
            state.preview = { docId: null, dataUrl: '', label: label || '当前画面' };
            updatePreviewDom();
            return;
        }
        state.previewBusy = true;
        try {
            var doc = ps().getActiveDocument();
            if (!doc) {
                state.preview = { docId: null, dataUrl: '', label: label || '当前画面' };
                updatePreviewDom();
                return;
            }
            var bounds = await ps().getCanvasBounds();
            if (!bounds) throw new Error('没有画布');
            var dataUrl = await ps().capturePreviewDataUrl(bounds, {
                maxDimension: 720,
                documentId: doc.id
            });
            state.preview = {
                docId: doc.id,
                dataUrl: dataUrl,
                label: label || '当前画面'
            };
            updatePreviewDom();
        } catch (error) {
            console.warn('[workspace] 预览失败', error);
        } finally {
            state.previewBusy = false;
        }
    }

    function openPreviewModal() {
        if (!state.preview.dataUrl) return;
        var modal = $('modalRoot');
        if (!modal) return;
        modal.innerHTML = '<div class="preview-modal-card">' +
            '<div class="preview-modal-head"><div class="preview-modal-title">' + esc(state.preview.label || '画面预览') + '</div>' +
            '<div class="modal-close" data-modal-close role="button" tabindex="0">' + icon('close') + '</div></div>' +
            '<div class="preview-modal-stage"><img src="' + esc(state.preview.dataUrl) + '" alt="画面预览"></div>' +
            '</div>';
        modal.classList.add('is-open');
        document.body.classList.add('has-modal');
    }

    function choiceGroup(path, label, options, hint) {
        var parts = path.split('.');
        var value = parts.length === 2 ? state.values[parts[0]][parts[1]] : '';
        var html = '<div class="tool-section"><div class="tool-section-title">' + esc(label) + '</div>' +
            '<div class="segmented tool-segmented">';
        options.forEach(function (option) {
            html += '<div class="segment' + (option.value === value ? ' is-active' : '') +
                '" role="button" tabindex="0" data-tool-choice="' + esc(path) +
                '" data-tool-value="' + esc(option.value) + '">' + esc(option.label) + '</div>';
        });
        html += '</div>';
        if (hint) html += '<div class="tool-hint">' + esc(hint) + '</div>';
        return html + '</div>';
    }

    /* ---------------- 自定义数值滑块（UXP 里不用原生 input[type=range]） ---------------- */

    function rangeClampValue(min, max, step, value) {
        var lo = Number(min);
        var hi = Number(max);
        var unit = Number(step) > 0 ? Number(step) : 1;
        var next = Number(value);
        if (!isFinite(lo)) lo = 0;
        if (!isFinite(hi)) hi = 100;
        if (hi < lo) {
            var swap = lo;
            lo = hi;
            hi = swap;
        }
        if (!isFinite(next)) next = lo;
        next = Math.round((next - lo) / unit) * unit + lo;
        next = Math.min(hi, Math.max(lo, next));
        return Math.round(next * 1000) / 1000;
    }

    function rangePercent(min, max, value) {
        var lo = Number(min);
        var hi = Number(max);
        var current = Number(value);
        if (!isFinite(lo) || !isFinite(hi) || hi <= lo || !isFinite(current)) return 0;
        var ratio = (current - lo) / (hi - lo);
        if (!isFinite(ratio)) ratio = 0;
        return Math.max(0, Math.min(1, ratio)) * 100;
    }

    function rangeText(value, suffix) {
        return String(value) + (suffix ? suffix : '');
    }

    function rangeRowOf(track) {
        if (!track) return null;
        if (typeof track.closest === 'function') return track.closest('.range-row');
        var node = track.parentNode;
        while (node && node.classList && !node.classList.contains('range-row')) node = node.parentNode;
        return node || null;
    }

    function applyRangeValue(track, value) {
        var row = rangeRowOf(track);
        if (!row) return;
        var path = row.getAttribute('data-range-choice') || '';
        var min = Number(track.getAttribute('data-range-min'));
        var max = Number(track.getAttribute('data-range-max'));
        var step = Number(track.getAttribute('data-range-step'));
        var suffix = track.getAttribute('data-range-suffix') || '';
        var next = rangeClampValue(min, max, step, value);
        var percent = rangePercent(min, max, next);
        setValue(path, next);
        var fill = track.querySelector('.range-fill');
        var thumb = track.querySelector('.range-thumb');
        if (fill) fill.style.width = percent.toFixed(2) + '%';
        if (thumb) thumb.style.left = percent.toFixed(2) + '%';
        track.setAttribute('aria-valuenow', String(next));
        var valueNode = row.querySelector('[data-range-value]');
        if (valueNode) valueNode.textContent = rangeText(next, suffix);
        return next;
    }

    function rangeGroup(path, label, min, max, step, suffix, hint) {
        var parts = String(path || '').split('.');
        var raw = parts.length === 2 && state.values[parts[0]]
            ? state.values[parts[0]][parts[1]]
            : min;
        var value = rangeClampValue(min, max, step, raw);
        var percent = rangePercent(min, max, value);
        var percentText = percent.toFixed(2) + '%';
        return '<div class="range-row" data-range-choice="' + esc(path) + '">' +
            '<div class="range-head"><span class="range-label">' + esc(label) + '</span>' +
            '<span class="range-value" data-range-value>' + esc(rangeText(value, suffix)) + '</span></div>' +
            '<div class="range-track" data-range-track="' + esc(path) +
            '" data-range-min="' + esc(min) + '" data-range-max="' + esc(max) +
            '" data-range-step="' + esc(step) + '" data-range-suffix="' + esc(suffix || '') +
            '" role="slider" tabindex="0" aria-valuemin="' + esc(min) + '" aria-valuemax="' + esc(max) +
            '" aria-valuenow="' + esc(value) + '">' +
            '<div class="range-fill" style="width:' + percentText + '"></div>' +
            '<div class="range-thumb" style="left:' + percentText + '"></div>' +
            '</div>' +
            (hint ? '<div class="range-hint">' + esc(hint) + '</div>' : '') +
            '</div>';
    }

    function runButton(toolId, label) {
        return '<div class="tool-actions"><div class="btn btn-primary tool-run" role="button" tabindex="0" data-tool-run="' +
            esc(toolId) + '" data-label="' + esc(label) + '">' +
            '<span data-tool-run-label>' + esc(label) + '</span></div></div>';
    }

    function detailShell(tool, body) {
        return '<div class="page-scroll">' +
            '<div class="tool-detail-head">' +
            '<div class="back-link" role="button" tabindex="0" data-tool-back>' + icon('chevronLeft') + '<span>工具</span></div>' +
            '<div class="tool-detail-title">' + esc(tool.name) + '</div>' +
            '<div class="tool-detail-desc">' + esc(tool.desc) + '</div>' +
            '</div>' +
            previewMarkup() +
            '<div class="tool-panel">' + body + '</div>' +
            '<div class="tool-status" data-tool-status></div>' +
            '</div>';
    }

    function renderColorTool() {
        var body = choiceGroup('color.method', '校色方法',
            [{ value: 'wavelet', label: '小波低频' }, { value: 'reinhard', label: 'Lab 整体' }],
            '小波只替换低频色彩，保留更多细节；Lab 适合整体偏色。') +
            rangeGroup('color.strength', '强度', 0, 100, 1, '%',
                '对当前选中的回图图层生效，原图层保留，校色结果直接写回。') +
            runButton('color', '融合校色');
        return detailShell(toolDef('color'), body);
    }

    function renderGlowTool() {
        var body = choiceGroup('glow.style', '风格',
            [{ value: 'shine', label: '柔光' }, { value: 'whiteSoft', label: '白光' },
                { value: 'starburst', label: '星芒' }, { value: 'anamorphic', label: '拉丝' }]) +
            rangeGroup('glow.strength', '强度', 0, 100, 1, '%') +
            rangeGroup('glow.radius', '半径', 1, 200, 1, ' px',
                '辉光在本地 CPU 计算，写入一个新的屏幕混合图层。') +
            runButton('glow', '添加辉光');
        return detailShell(toolDef('glow'), body);
    }

    function renderVfxTool() {
        var v = state.values.vfx;
        var body = choiceGroup('vfx.mode', '路线',
            [{ value: 'local', label: '本地特效' }, { value: 'ai', label: 'AI 特效' }]);
        if (v.mode === 'local') {
            body += choiceGroup('vfx.preset', '预设',
                [{ value: 'heat', label: '热浪' }, { value: 'airflow', label: '气流' }, { value: 'slash', label: '刀光' }]) +
                rangeGroup('vfx.intensity', '强度', 0, 100, 1, '%',
                    '本地位移特效不联网、不消耗额度。') +
                runButton('vfx', '应用本地特效');
        } else {
            body += choiceGroup('vfx.effect', '特效',
                [{ value: 'energy-trail', label: '能量拖尾' }, { value: 'neon-outline', label: '霓虹描边' },
                    { value: 'magic-circle', label: '魔法阵' }]) +
                choiceGroup('vfx.color', '颜色',
                    [{ value: '#00f0ff', label: '青蓝' }, { value: '#ff7a3d', label: '橙红' },
                        { value: '#b36bff', label: '紫' }],
                    '会保留主体，只围绕当前画面加特效；走当前生图模型。') +
                runButton('vfx', '生成 AI 特效');
        }
        return detailShell(toolDef('vfx'), body);
    }

    function renderSuperresTool() {
        var body = choiceGroup('superres.factor', '放大倍数',
            [{ value: 2, label: '2×' }, { value: 3, label: '3×' }, { value: 4, label: '4×' }],
            '模型必须支持 4K；当前使用设置里的生图模型。') +
            choiceGroup('superres.overlap', '重叠像素',
                [{ value: 64, label: '64' }, { value: 128, label: '128' }, { value: 256, label: '256' }],
                '块数随选区面积增长，每一块都会消耗一次生图额度。') +
            runButton('superres', '开始 AI 超分');
        return detailShell(toolDef('superres'), body);
    }

    function comfyBody() {
        var comfy = state.comfy;
        var html = '<div class="tool-section">' +
            '<div class="tool-inline-actions comfy-action-row">' +
            '<div class="btn btn-ghost" data-tool-action="comfy-test" role="button" tabindex="0">测试连接</div>' +
            '<div class="btn btn-ghost" data-tool-action="comfy-refresh" role="button" tabindex="0">刷新工作流</div>' +
            '</div>' +
            '<div class="tool-hint">连接本机或局域网里的 ComfyUI，服务地址在「设置 → ComfyUI」里配置。</div>' +
            '</div>';
        html += '<div class="tool-section">' +
            '<div class="tool-section-title">ComfyUI 工作流 <span class="comfy-auto-badge">自动读取</span></div>' +
            '<div class="comfy-wf-list' + (comfy.listVisible ? '' : ' hidden') + '" id="comfyWorkflowList">' +
            '<div class="comfy-wf-empty">正在读取 ComfyUI 的工作流…</div></div>' +
            '<div class="tool-hint" id="comfyInfo">' + esc(comfy.workflowLabel) + '</div>' +
            '</div>' +
            '<div class="tool-section comfy-params-section">' +
            '<div class="comfy-params-head"><span>工作流参数</span>' +
            '<span class="comfy-params-note">只显示 # 标记</span></div>' +
            '<div class="comfy-params" id="comfyParams"><div class="comfy-wf-empty">载入工作流后显示参数</div></div>' +
            '</div>' +
            '<div class="tool-hint">列表来自本地 ComfyUI 的 workflows 目录，内置默认工作流始终排在最前；点一份就自动读取并转换。</div>' +
            runButton('comfy', '运行工作流');
        return html;
    }

    function formatWorkflowTime(timestamp) {
        if (!timestamp) return '';
        var date = new Date(timestamp);
        if (!isFinite(date.getTime())) return '';
        var pad = function (value) { return value < 10 ? '0' + value : String(value); };
        return (date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function workflowShortName(name) {
        var text = String(name || '').replace(/^.*\//, '').replace(/\.json$/i, '');
        return text || String(name || '未命名');
    }

    function syncComfyListVisibility() {
        var host = $('comfyWorkflowList');
        if (!host) return;
        host.classList.toggle('hidden', !state.comfy.listVisible);
    }

    function renderComfyWorkflowList() {
        var host = $('comfyWorkflowList');
        if (!host) return;
        syncComfyListVisibility();
        if (state.comfy.loading) {
            host.innerHTML = '<div class="comfy-wf-empty">正在读取 ComfyUI 的工作流…</div>';
            return;
        }
        var html = '';
        var builtins = builtinWorkflowItems();
        var defaultBuiltin = builtinWorkflowDefault();
        for (var builtinIndex = 0; builtinIndex < builtins.length; builtinIndex++) {
            var builtin = builtins[builtinIndex];
            var builtinActive = builtin.name === state.comfy.workflowName;
            html += '<div class="comfy-wf-row is-builtin' + (builtinActive ? ' is-active' : '') +
                '" data-comfy-workflow="' + esc(builtin.name) + '" role="button" tabindex="0"' +
                (builtin.description ? ' title="' + esc(builtin.description) + '"' : '') + '>' +
                '<span class="comfy-wf-dot"></span>' +
                '<div class="comfy-wf-copy"><div class="comfy-wf-name">' + esc(builtin.name) + '</div>' +
                '<div class="comfy-wf-meta">内置工作流' + (builtin === defaultBuiltin ? ' · 默认保存' : '') + '</div></div>' +
                '<span class="comfy-wf-badge">' + esc(builtin.badge || '内置') + '</span>' +
                (builtinActive ? '<span class="comfy-wf-current">当前</span>' : '') +
                '</div>';
        }
        var serverItems = state.comfy.workflows || [];
        if (serverItems.length) {
            html += '<div class="comfy-wf-group-label">本地保存的工作流</div>';
        }
        serverItems.forEach(function (item) {
            var active = item.name === state.comfy.workflowName;
            var time = formatWorkflowTime(item.modified);
            html += '<div class="comfy-wf-row' + (active ? ' is-active' : '') +
                '" data-comfy-workflow="' + esc(item.name) + '" role="button" tabindex="0">' +
                '<span class="comfy-wf-dot"></span>' +
                '<div class="comfy-wf-copy"><div class="comfy-wf-name">' + esc(workflowShortName(item.name)) + '</div>' +
                '<div class="comfy-wf-meta">' + (time ? esc(time) : '已保存') +
                (item.size ? ' · ' + Math.max(1, Math.round(item.size / 1024)) + ' KB' : '') + '</div></div>' +
                (active ? '<span class="comfy-wf-current">当前</span>' : '') +
                '</div>';
        });
        if (!html) {
            host.innerHTML = '<div class="comfy-wf-empty">没有读到工作流。先在 ComfyUI 里保存一份，再点「刷新工作流」。</div>';
            return;
        }
        host.innerHTML = html;
    }

    function comfyForm() {
        if (!root.HuanmengComfyForm) throw new Error('工作流参数模块未加载');
        return root.HuanmengComfyForm;
    }

    function currentParamValue(param) {
        if (Object.prototype.hasOwnProperty.call(state.comfy.paramValues, param.key)) {
            return state.comfy.paramValues[param.key];
        }
        return param.value;
    }

    function paramControlHtml(param) {
        var value = currentParamValue(param);
        var key = esc(param.key);
        var kind = esc(param.kind);
        var title = param.tooltip ? ' title="' + esc(param.tooltip) + '"' : '';
        var html = '';
        if (param.kind === 'combo') {
            var current = String(value == null ? '' : value);
            return '<div class="comfy-select" data-param-combo="' + key + '">' +
                '<div class="comfy-select-trigger" data-param-combo-trigger="' + key +
                '" role="button" tabindex="0"' + title + '>' +
                '<span class="comfy-select-value">' + esc(current || '请选择') + '</span>' +
                icon('chevronDown') + '</div></div>';
        }
        if (param.kind === 'bool') {
            var boolValue = value === true || value === 'true';
            return '<div class="comfy-bool" data-param-bool="' + key + '"' + title + '>' +
                '<div class="comfy-bool-option' + (boolValue ? ' is-active' : '') +
                '" data-param-bool-value="true" role="button" tabindex="0">开</div>' +
                '<div class="comfy-bool-option' + (boolValue ? '' : ' is-active') +
                '" data-param-bool-value="false" role="button" tabindex="0">关</div></div>';
        }
        if (param.kind === 'string' && param.multiline) {
            return '<textarea class="comfy-param-control comfy-param-textarea" data-param-key="' +
                key + '" data-param-kind="string"' + title + '>' + esc(value == null ? '' : value) + '</textarea>';
        }
        if (param.isSeed) {
            return '<div class="comfy-param-seed">' +
                '<input class="comfy-param-control" type="text" inputmode="numeric" data-param-key="' +
                key + '" data-param-kind="' + kind + '" value="' + esc(value == null ? '' : value) + '"' + title + '>' +
                '<div class="comfy-param-random" data-param-random="' + key + '" role="button" tabindex="0">随机</div>' +
                '</div>';
        }
        return '<input class="comfy-param-control" type="text" inputmode="' +
            (param.kind === 'int' ? 'numeric' : 'decimal') + '" data-param-key="' + key +
            '" data-param-kind="' + kind + '" value="' + esc(value == null ? '' : value) + '"' + title + '>';
    }

    function isComfyImageParam(param, node) {
        if (!param || param.kind !== 'combo') return false;
        var choices = Array.isArray(param.choices) ? param.choices : [];
        var hasImageChoice = choices.some(function (choice) {
            return /\.(png|jpe?g|webp|gif)$/i.test(String(choice));
        });
        var classType = String(node && node.classType || '');
        var imageNode = /LoadImage|ImageInput|LoadImageMask|ImageLoader|Load\s*Image/i.test(classType);
        return hasImageChoice || imageNode;
    }

    /* 运行前检查 # 参数：主图 / 必填下拉没选就拦下，别让服务端报 500。 */
    function comfyParamIssue() {
        var model = state.comfy.paramModel;
        var marked = model && model.marked ? model.marked : [];
        for (var index = 0; index < marked.length; index++) {
            var entry = marked[index];
            var param = entry.param;
            if (!param) continue;
            var raw = state.comfy.paramValues[param.key];
            var text = raw == null ? '' : String(raw).trim();
            if (isComfyImageParam(param, entry.node) && !text) {
                return { kind: 'image', num: entry.num, label: entry.label || param.name };
            }
            if (param.kind === 'combo') {
                var choices = Array.isArray(param.choices) ? param.choices : [];
                if (choices.indexOf('') < 0 && !text) {
                    return { kind: 'combo', num: entry.num, label: entry.label || param.name };
                }
            }
        }
        return null;
    }

    function paramRowHtml(param, label, imageInput) {
        var control = paramControlHtml(param);
        var action = imageInput
            ? '<div class="comfy-selection-btn" data-comfy-selection-image="' + esc(param.key) +
                '" role="button" tabindex="0">读取选区</div>'
            : '';
        return '<div class="comfy-param-row' + (imageInput ? ' is-image' : '') + '">' +
            '<div class="comfy-param-label"><span class="comfy-param-name">' +
            esc(label || param.name) + '</span>' + action + '</div>' +
            '<div class="comfy-param-image">' + control + '</div>' +
            '</div>';
    }

    function findComfyParam(key) {
        var model = state.comfy.paramModel;
        if (!model || !model.nodes) return null;
        for (var n = 0; n < model.nodes.length; n++) {
            var params = model.nodes[n].params || [];
            for (var p = 0; p < params.length; p++) {
                if (params[p].key === key) return params[p];
            }
        }
        return null;
    }

    function closeComfyMenus() {
        var wraps = document.querySelectorAll('.comfy-select.is-open');
        for (var i = 0; i < wraps.length; i++) {
            var menu = wraps[i].querySelector('.comfy-select-menu');
            if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
            wraps[i].classList.remove('is-open');
        }
    }

    function openComfyCombo(trigger) {
        var key = trigger.getAttribute('data-param-combo-trigger');
        var param = findComfyParam(key);
        if (!param) return;
        var wrap = trigger.parentNode;
        var already = wrap.classList.contains('is-open');
        closeComfyMenus();
        if (already) return;

        var choices = Array.isArray(param.choices) ? param.choices : [];
        var current = String(currentParamValue(param));
        var menu = document.createElement('div');
        menu.className = 'comfy-select-menu';
        var html = '';
        if (!choices.length) {
            html = '<div class="comfy-select-empty">没有可选项</div>';
        } else {
            choices.forEach(function (choice) {
                var value = String(choice);
                html += '<div class="comfy-select-option' + (value === current ? ' is-selected' : '') +
                    '" data-param-option="' + esc(key) + '" data-param-option-value="' +
                    esc(value) + '" role="button" tabindex="0">' + esc(value) + '</div>';
            });
        }
        menu.innerHTML = html;
        wrap.appendChild(menu);
        wrap.classList.add('is-open');
    }

    function renderComfyParams() {
        var host = $('comfyParams');
        if (!host) return;
        var model = state.comfy.paramModel;
        var marked = model && model.marked ? model.marked : [];
        if (!marked.length) {
            host.innerHTML = '<div class="comfy-wf-empty">只显示 # 标记参数；这份工作流没有标记参数。</div>';
            return;
        }
        var html = '';
        marked.forEach(function (entry) {
            html += paramRowHtml(entry.param,
                entry.label ? '#' + ('0' + entry.num).slice(-2) + ' ' + entry.label : entry.param.name,
                isComfyImageParam(entry.param, entry.node));
        });
        host.innerHTML = html;
    }

    async function uploadComfySelection(paramKey, button) {
        if (!root.HuanmengPS || !root.HuanmengPS.isAvailable()) {
            toast('Photoshop 未连接，读不到选区', 'error');
            return;
        }
        var param = findComfyParam(paramKey);
        if (!param) return;
        var oldText = button ? button.textContent : '';
        if (button) {
            button.classList.add('is-busy');
            button.textContent = '读取中…';
        }
        try {
            var context = await api.refreshContext({ silent: true });
            if (!context.doc) throw new Error('请先打开一张图');
            var bounds = await root.HuanmengPS.getSelectionBounds();
            if (!bounds) throw new Error('当前没有选区，先在 Photoshop 里框选主图区域');
            var base64 = await root.HuanmengPS.captureSelectionBase64(bounds, {
                documentId: context.doc.id
            });
            if (!base64) throw new Error('选区读取为空');
            var bytes = core().base64ToUint8Array(base64);
            var client = comfyClient();
            comfyBaseForChannel(client);
            var uploaded = await client.uploadImage(
                bytes,
                'huanmeng-selection-' + Date.now() + '.png'
            );
            var name = uploaded.name || '';
            if (!name) throw new Error('ComfyUI 没有返回上传文件名');
            state.comfy.paramValues[paramKey] = name;
            if (!Array.isArray(param.choices)) param.choices = [];
            if (param.choices.indexOf(name) < 0) param.choices.push(name);
            var row = button ? button.closest('.comfy-param-row') : null;
            var valueNode = row ? row.querySelector('.comfy-select-value') : null;
            if (valueNode) valueNode.textContent = name;
            if (button) {
                button.classList.remove('is-busy');
                button.textContent = '重新读取';
            }
            if (root.ZhuangLog) {
                root.ZhuangLog.success('ComfyUI', '已把选区上传为主图', {
                    document: context.docName || '',
                    width: Math.round(bounds.width),
                    height: Math.round(bounds.height),
                    filename: name
                });
            }
            setToolStatus('已读取选区并设为「' + (param.name || '主图') + '」：' + name, 'success');
            toast('已读取选区，主图已上传');
        } catch (error) {
            if (button) {
                button.classList.remove('is-busy');
                button.textContent = oldText || '读取选区';
            }
            if (root.ZhuangLog) root.ZhuangLog.error('ComfyUI', '读取选区为主图失败', comfyErrorText(error));
            setToolStatus(comfyErrorText(error), 'error');
            toast(comfyErrorText(error), 'error');
        }
    }

    async function comfyRefreshWorkflows(autoLoad) {
        var client = comfyClient();
        var base = comfyBaseForChannel(client);
        state.comfy.loading = true;
        renderComfyWorkflowList();
        setToolStatus('正在读取工作流列表…', 'busy');
        try {
            var list = await client.listUserWorkflows();
            state.comfy.workflows = Array.isArray(list) ? list : [];
            state.comfy.loading = false;
            renderComfyWorkflowList();
            if (root.ZhuangLog) {
                root.ZhuangLog.info('ComfyUI', '读取工作流列表', {
                    count: state.comfy.workflows.length,
                    baseUrl: base
                });
            }
            var selected = null;
            if (state.comfy.workflowName) {
                if (builtinWorkflowByName(state.comfy.workflowName)) {
                    selected = { name: state.comfy.workflowName };
                } else {
                    for (var i = 0; i < state.comfy.workflows.length; i++) {
                        if (state.comfy.workflows[i].name === state.comfy.workflowName) {
                            selected = state.comfy.workflows[i];
                            break;
                        }
                    }
                }
            }
            if (!selected) {
                var defaultBuiltin = builtinWorkflowDefault();
                if (defaultBuiltin) selected = { name: defaultBuiltin.name };
                else if (state.comfy.workflows.length) selected = state.comfy.workflows[0];
            }
            if (!selected) {
                if (root.ZhuangLog) root.ZhuangLog.warn('ComfyUI', '没有保存的工作流');
                setToolStatus('本地 ComfyUI 上没有保存的工作流，也没有内置工作流。', 'error');
                return;
            }
            if (autoLoad || !state.comfy.workflow || !state.comfy.workflowName) {
                await comfyLoadWorkflow(selected.name);
            } else {
                setToolStatus('读到 ' + state.comfy.workflows.length + ' 份本地工作流、' +
                    builtinWorkflowItems().length + ' 份内置工作流，点一份切换。', 'success');
            }
        } catch (error) {
            state.comfy.loading = false;
            renderComfyWorkflowList();
            if (root.ZhuangLog) root.ZhuangLog.error('ComfyUI', '读取工作流列表失败', comfyErrorText(error));
            setToolStatus(comfyErrorText(error), 'error');
        }
    }

    async function comfyLoadWorkflow(name, hideList) {
        if (state.comfy.loadingWorkflow) return;
        var client = comfyClient();
        var convert = root.HuanmengComfyConvert;
        if (!convert) throw new Error('工作流转换模块未加载');
        var builtin = builtinWorkflowByName(name);
        state.comfy.loadingWorkflow = true;
        state.comfy.workflowName = name;
        renderComfyWorkflowList();
        setToolStatus('正在读取「' + workflowShortName(name) + '」…', 'busy');
        try {
            var parsed = null;
            if (builtin) {
                parsed = builtin.data;
            } else {
                var text = await client.readUserWorkflow(name);
                parsed = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
            }
            var api = null;
            var problems = [];
            var markers = {};
            var objectInfo = null;
            if (convert.isApiFormat(parsed)) {
                api = parsed;
                markers = convert.markersFromApi ? convert.markersFromApi(api) : {};
                try {
                    objectInfo = await client.objectInfo();
                } catch (infoError) {
                    core().log('[comfy] 读取节点定义失败，跳过参数表单:', infoError);
                }
            } else if (convert.isUiFormat(parsed)) {
                setToolStatus('正在读取节点定义并转换工作流…', 'busy');
                objectInfo = await client.objectInfo();
                var converted = convert.toApi(parsed, objectInfo);
                problems = converted.problems || [];
                markers = converted.markers || {};
                if (!converted.ok || !converted.api) {
                    var reason = convert.summarizeProblems
                        ? convert.summarizeProblems(problems)
                        : '工作流转换失败';
                    throw new Error(reason || '工作流转换失败');
                }
                api = converted.api;
            } else {
                throw new Error('这不是 ComfyUI 工作流 JSON');
            }
            var count = api && typeof api === 'object' && !Array.isArray(api) ? Object.keys(api).length : 0;
            if (!count) throw new Error('工作流里没有节点');

            var previousName = state.comfy.paramWorkflowName;
            if (previousName !== name) {
                state.comfy.paramValues = {};
            }
            var model = null;
            if (objectInfo && root.HuanmengComfyForm) {
                model = root.HuanmengComfyForm.buildParamModel(objectInfo, api, {
                    markers: markers,
                    markedOnly: false
                });
                model.nodes.forEach(function (node) {
                    node.params.forEach(function (param) {
                        if (!Object.prototype.hasOwnProperty.call(state.comfy.paramValues, param.key)) {
                            state.comfy.paramValues[param.key] = param.value;
                        }
                    });
                });
            }
            state.comfy.workflow = api;
            state.comfy.workflowText = JSON.stringify(api);
            state.comfy.paramModel = model;
            state.comfy.paramWorkflowName = name;
            var markedCount = model && model.marked ? model.marked.length : 0;
            state.comfy.workflowLabel = workflowShortName(name) + ' · ' + count + ' 个节点' +
                (markedCount ? ' · ' + markedCount + ' 个 # 参数' : ' · 无 # 参数') +
                (problems.length ? ' · ' + problems.length + ' 个提示' : '');
            state.comfy.loadingWorkflow = false;
            if (hideList) state.comfy.listVisible = false;
            renderComfyWorkflowList();
            renderComfyParams();
            var info = $('comfyInfo');
            if (info) info.textContent = state.comfy.workflowLabel;
            if (root.ZhuangLog) {
                root.ZhuangLog.success('ComfyUI', '载入工作流', {
                    workflow: workflowShortName(name),
                    nodes: count,
                    params: model && model.stats ? model.stats.paramCount : 0,
                    warnings: problems.length
                });
            }
            setToolStatus('已载入「' + workflowShortName(name) + '」' + (builtin ? '（内置）' : '') + '，参数和运行都就绪。', 'success');
        } catch (error) {
            state.comfy.loadingWorkflow = false;
            state.comfy.workflow = null;
            state.comfy.paramModel = null;
            state.comfy.paramValues = {};
            state.comfy.paramWorkflowName = '';
            state.comfy.workflowLabel = workflowShortName(name) + ' · 载入失败';
            renderComfyWorkflowList();
            renderComfyParams();
            var infoNode = $('comfyInfo');
            if (infoNode) infoNode.textContent = state.comfy.workflowLabel;
            if (root.ZhuangLog) root.ZhuangLog.error('ComfyUI', '载入工作流失败', comfyErrorText(error));
            setToolStatus(comfyErrorText(error), 'error');
            throw error;
        }
    }

    function renderComfyPage() {
        var host = $('page-comfy');
        if (!host) return;
        host.innerHTML = '<div class="page-scroll">' +
            '<div class="page-head"><div class="page-head-copy">' +
            '<div class="page-head-title">ComfyUI</div>' +
            '<div class="page-head-desc">连接本地 ComfyUI 工作流，运行后把第一张图放回当前选区。</div></div></div>' +
            previewMarkup() +
            '<div class="tool-panel">' + comfyBody() + '</div>' +
            '<div class="tool-status" data-tool-status></div>' +
            '</div>';
    }

    function renderTool() {
        var host = $('page-tool');
        if (!host) return;
        if (state.tool === 'color') state.tool = 'glow';
        var tool = toolDef(state.tool);
        var body = '';
        if (state.tool === 'glow') body = renderGlowTool();
        else if (state.tool === 'vfx') body = renderVfxTool();
        else body = renderSuperresTool();
        host.innerHTML = body;
        if (api && typeof api.setPage === 'function') {
            var subtitle = document.getElementById('pageSubtitle');
            if (subtitle) subtitle.textContent = '工具 · ' + tool.name;
        }
    }

    function ensureContext() {
        if (!api || typeof api.refreshContext !== 'function') throw new Error('上下文初始化失败');
        return api.refreshContext().then(function (context) {
            if (!context.available) throw new Error('Photoshop 未连接');
            if (!context.doc) throw new Error('请先打开一张图');
            return context;
        });
    }

    async function runColor() {
        requirePS();
        var doc = ps().getActiveDocument();
        var layer = doc && doc.activeLayers && doc.activeLayers[0];
        if (!doc || !layer) throw new Error('请先选中一个回图图层');
        setToolStatus('正在读取当前图层…', 'busy');
        var bounds = await ps().getActiveLayerBounds();
        if (!bounds) throw new Error('无法读取图层范围');
        var outputSample = await ps().captureImageData(bounds, {
            maxDimension: 1200,
            documentId: doc.id,
            layerId: layer.id
        });
        setToolStatus('正在读取图层下方的原画面…', 'busy');
        var wasVisible = layer.visible !== false;
        await ps().runInModal(async function () { layer.visible = false; }, '读取图层下方画面');
        var referenceSample = null;
        try {
            referenceSample = await ps().captureImageData(bounds, {
                maxDimension: 1200,
                documentId: doc.id
            });
        } finally {
            await ps().runInModal(async function () { layer.visible = wasVisible; }, '恢复活动图层');
        }
        if (!referenceSample) throw new Error('读不到图层下方画面');
        setToolStatus('正在融合颜色…', 'busy');
        var values = state.values.color;
        await root.HuanmengColorMatchApply.matchActiveLayer({
            method: values.method,
            strength: values.strength,
            outputFullSample: outputSample,
            referenceFullSample: referenceSample
        });
        setToolStatus('融合校色完成，结果已写回当前图层。', 'success');
        toast('融合校色完成');
        refreshToolPreview(true, '处理结果');
    }

    async function runGlow() {
        var context = await ensureContext();
        var values = state.values.glow;
        setToolStatus('正在计算辉光，稍等几秒…', 'busy');
        var result = await root.HuanmengGlow.applyGlow({
            params: {
                style: values.style,
                strength: values.strength,
                radius: values.radius,
                threshold: 81
            },
            bounds: context.bounds,
            documentId: context.doc.id,
            maxDimension: 720
        });
        setToolStatus('辉光已写入新图层：' + (result.layer && result.layer.name || '辉光'), 'success');
        toast('辉光已添加');
        refreshToolPreview(true, '处理结果');
    }

    async function runVfx() {
        var context = await ensureContext();
        var values = state.values.vfx;
        if (values.mode === 'local') {
            setToolStatus('正在计算本地特效…', 'busy');
            var preset = root.HuanmengSpaceFx && root.HuanmengSpaceFx.preset
                ? Object.assign({}, root.HuanmengSpaceFx.preset(values.preset), { intensity: values.intensity })
                : { effect: values.preset, intensity: values.intensity };
            var local = await root.HuanmengVfx.applySpaceFx({
                settings: preset,
                bounds: context.bounds,
                documentId: context.doc.id,
                maxDimension: 1600
            });
            setToolStatus('本地特效已写入新图层：' + (local.layer && local.layer.name || '特效'), 'success');
            toast('本地特效已应用');
            refreshToolPreview(true, '处理结果');
            return;
        }

        setToolStatus('AI 正在生成特效，可能需要 1–2 分钟…', 'busy');
        var base64 = await ps().captureSelectionBase64(context.bounds, { documentId: context.doc.id });
        if (!base64) throw new Error('读取当前画面失败');
        var result = await root.HuanmengVfx.generateVfx({
            config: {
                color: values.color,
                effectPreset: values.effect,
                materialPreset: 'plasma',
                motionPathText: 'flowing arc around the subject',
                particleText: 'glowing particles and trailing sparks'
            },
            source: { dataUrl: 'data:image/png;base64,' + base64, bounds: context.bounds },
            model: core().getSettings().imgModel,
            imageResolution: core().getSettings().imgResolution,
            documentId: context.doc.id,
            placeBack: true,
            settings: core().getSettings()
        });
        setToolStatus('AI 特效已回贴：' + (result.layer && result.layer.name || 'VFX'), 'success');
        toast('AI 特效已生成');
        refreshToolPreview(true, '处理结果');
    }

    async function runSuperres() {
        var context = await ensureContext();
        var values = state.values.superres;
        var plan = root.HuanmengSuperRes.planTiles(context.bounds, values.factor, values.overlap);
        setToolStatus('共 ' + plan.tiles.length + ' 块，开始 AI 超分…', 'busy');
        var result = await root.HuanmengSuperRes.runSuperResolution({
            bounds: context.bounds,
            factor: values.factor,
            overlap: values.overlap,
            model: core().getSettings().imgModel,
            imageResolution: '4K',
            documentId: context.doc.id,
            settings: core().getSettings(),
            onProgress: function (done, total) {
                setToolStatus('AI 超分 ' + done + '/' + total + '…', 'busy');
            }
        });
        setToolStatus('AI 超分完成：' + result.layers.length + ' 块已拼回。', 'success');
        toast('AI 超分完成');
        refreshToolPreview(true, '处理结果');
    }

    /* ================= ComfyUI ================= */

    function comfyClient() {
        if (!root.HuanmengComfyClient) throw new Error('ComfyUI 模块未加载');
        return root.HuanmengComfyClient;
    }

    async function comfyTest() {
        var client = comfyClient();
        var base = comfyBaseForChannel(client);
        setToolStatus('正在连接 ComfyUI…', 'busy');
        var stats = await client.systemStats();
        var system = stats && stats.system || {};
        if (root.ZhuangLog) {
            root.ZhuangLog.success('ComfyUI', '连接正常', {
                baseUrl: base,
                version: system.comfyui_version || ''
            });
        }
        setToolStatus('连接正常 · ComfyUI ' + (system.comfyui_version || '已就绪'), 'success');
        toast('ComfyUI 已连接');
    }

    async function comfyRun() {
        var client = comfyClient();
        if (!state.comfy.workflow) {
            var defaultItem = builtinWorkflowDefault();
            if (state.comfy.workflowName) await comfyLoadWorkflow(state.comfy.workflowName);
            else if (defaultItem) await comfyLoadWorkflow(defaultItem.name);
            else if (state.comfy.workflows.length) await comfyLoadWorkflow(state.comfy.workflows[0].name);
            else await comfyRefreshWorkflows(true);
        }
        if (!state.comfy.workflow) throw new Error('请先读取一个 ComfyUI 工作流');
        var paramIssue = comfyParamIssue();
        if (paramIssue) {
            var paramTag = '#' + ('0' + paramIssue.num).slice(-2) + ' ' + paramIssue.label;
            if (paramIssue.kind === 'image') {
                throw new Error('运行前请先选主图：点「' + paramTag + '」旁边的「读取选区」上传 PS 选区，或在下拉里选一张已有图片。');
            }
            throw new Error('运行前请先选好「' + paramTag + '」。');
        }
        var context = await ensureContext();
        var base = comfyBaseForChannel(client);
        var runWorkflow = state.comfy.workflow;
        if (root.HuanmengComfyForm && state.comfy.paramModel) {
            try {
                runWorkflow = root.HuanmengComfyForm.applyParamValues(
                    state.comfy.workflow,
                    state.comfy.paramValues
                );
            } catch (ignore) {
                runWorkflow = state.comfy.workflow;
            }
        }
        setToolStatus('正在提交 ComfyUI 任务…', 'busy');
        if (root.ZhuangLog) {
            root.ZhuangLog.info('ComfyUI', '提交工作流', {
                workflow: workflowShortName(state.comfy.workflowName),
                params: state.comfy.paramModel && state.comfy.paramModel.stats
                    ? state.comfy.paramModel.stats.paramCount : 0
            });
        }
        var queued = await client.queuePrompt(runWorkflow);
        var promptId = queued.promptId;
        if (root.ZhuangLog) root.ZhuangLog.info('ComfyUI', '任务已提交', { promptId: promptId });
        setToolStatus('任务 #' + promptId + ' 已提交，等待出图…', 'busy');
        var entry = null;
        var outcome = null;
        for (var attempt = 0; attempt < 240; attempt++) {
            await core().sleep(1500);
            entry = await client.history(promptId);
            outcome = client.readHistoryOutcome(entry);
            if (outcome.done) break;
            if (attempt % 5 === 0) setToolStatus('任务 #' + promptId + ' 排队 / 生成中…', 'busy');
        }
        if (!outcome || !outcome.done) throw new Error('ComfyUI 超时，任务可能还在跑');
        if (!outcome.ok) throw new Error(outcome.message || 'ComfyUI 执行失败');
        var outputs = client.collectOutputImages(entry).filter(function (item) { return !item.animated; });
        if (!outputs.length) throw new Error('工作流没有返回图片');
        setToolStatus('正在读取结果图…', 'busy');
        var bytes = await client.viewImage(outputs[0]);
        var mime = core().detectImageMimeType(bytes);
        var dataUrl = 'data:' + mime + ';base64,' + core().uint8ArrayToBase64(bytes);
        var placeOptions = { mode: 'fit' };
        var colorMatched = false;
        if (root.ZhuangStore && root.ZhuangStore.readUi().autoColorMatch) {
            placeOptions.colorMatch = {
                method: 'wavelet',
                strength: 100,
                onResult: function (info) { colorMatched = !!(info && info.applied); }
            };
        }
        await root.HuanmengPlace.placeImageAtBounds(
            dataUrl,
            context.bounds,
            'ComfyUI · ' + outputs[0].filename,
            context.doc.id,
            placeOptions
        );
        if (root.ZhuangLog) {
            root.ZhuangLog.success('ComfyUI', 'ComfyUI 结果已回贴', {
                promptId: promptId,
                filename: outputs[0].filename,
                colorMatched: colorMatched
            });
        }
        setToolStatus('ComfyUI 完成，结果已等比放回选区' + (colorMatched ? '并融合校色。' : '。'), 'success');
        toast(colorMatched ? 'ComfyUI 结果已回贴并校色' : 'ComfyUI 结果已回贴');
        refreshToolPreview(true, '处理结果');
    }

    /* ================= 运行调度 / 事件 ================= */

    async function runTool(toolId) {
        if (state.toolBusy) return;
        var labels = {
            color: '正在校色…',
            glow: '正在计算…',
            vfx: '正在处理…',
            superres: '正在超分…',
            comfy: '正在运行…'
        };
        setToolBusy(true, labels[toolId] || '处理中…');
        try {
            if (toolId === 'glow') await runGlow();
            else if (toolId === 'vfx') await runVfx();
            else if (toolId === 'superres') await runSuperres();
            else if (toolId === 'comfy') await comfyRun();
        } catch (error) {
            var errorText = toolId === 'comfy' ? comfyErrorText(error) : prettyError(error);
            if (root.ZhuangLog) root.ZhuangLog.error('工具', (labels[toolId] || '处理') + '失败', errorText);
            setToolStatus(errorText, 'error');
            toast(errorText, 'error');
        } finally {
            setToolBusy(false);
        }
    }

    function setValue(path, value) {
        var parts = path.split('.');
        if (parts.length !== 2) return;
        var group = state.values[parts[0]];
        if (!group) return;
        group[parts[1]] = value;
    }

    function bindTools() {
        var toolsHost = $('page-tools');
        if (toolsHost) {
            toolsHost.addEventListener('click', function (event) {
                var node = event.target.closest('[data-tool-id]');
                if (!node) return;
                state.tool = node.getAttribute('data-tool-id');
                if (api && api.setPage) api.setPage('tool');
            });
        }

        var toolHost = $('page-tool');
        if (!toolHost) return;
        toolHost.addEventListener('click', function (event) {
            var preview = event.target.closest('[data-preview-open]');
            if (preview) {
                openPreviewModal();
                return;
            }
            var back = event.target.closest('[data-tool-back]');
            if (back) {
                if (api && api.setPage) api.setPage('tools');
                return;
            }
            var choice = event.target.closest('[data-tool-choice]');
            if (choice) {
                var value = choice.getAttribute('data-tool-value');
                if (choice.getAttribute('data-tool-choice') === 'superres.factor' ||
                    choice.getAttribute('data-tool-choice') === 'superres.overlap' ||
                    choice.getAttribute('data-tool-choice') === 'vfx.intensity' ||
                    choice.getAttribute('data-tool-choice') === 'glow.strength' ||
                    choice.getAttribute('data-tool-choice') === 'glow.radius' ||
                    choice.getAttribute('data-tool-choice') === 'color.strength') {
                    value = Number(value);
                }
                setValue(choice.getAttribute('data-tool-choice'), value);
                renderTool();
                return;
            }
            var run = event.target.closest('[data-tool-run]');
            if (run) runTool(run.getAttribute('data-tool-run'));
        });

        /* ---------- 工具页数值滑块：mousedown 拖动 + 键盘 ---------- */

        var rangeDrag = null;

        function rangeTrackWidth(track) {
            var rect = null;
            if (track && typeof track.getBoundingClientRect === 'function') {
                try { rect = track.getBoundingClientRect(); } catch (ignore) { rect = null; }
            }
            var width = rect && isFinite(rect.width) && rect.width > 0 ? rect.width : 0;
            if (!width && track && track.offsetWidth) width = track.offsetWidth;
            return { rect: rect, width: width };
        }

        function rangeValueFromEvent(track, event) {
            var min = Number(track.getAttribute('data-range-min'));
            var max = Number(track.getAttribute('data-range-max'));
            var step = Number(track.getAttribute('data-range-step'));
            var size = rangeTrackWidth(track);
            if (!(size.width > 0)) return null;
            var pos = NaN;
            var clientX = event && typeof event.clientX === 'number' ? event.clientX : NaN;
            if (isFinite(clientX) && size.rect && isFinite(size.rect.left)) {
                pos = clientX - size.rect.left;
            }
            if (!isFinite(pos)) {
                /* 兜底：没有 clientX 时按 offsetX 往上累加到轨道 */
                var offset = event && typeof event.offsetX === 'number' ? event.offsetX : NaN;
                if (isFinite(offset)) {
                    var node = event ? event.target : null;
                    while (node && node !== track) {
                        offset += node.offsetLeft || 0;
                        node = node.parentNode;
                    }
                    pos = offset;
                }
            }
            if (!isFinite(pos)) return null;
            var ratio = pos / size.width;
            return rangeClampValue(min, max, step, min + ratio * (max - min));
        }

        function rangeStopDrag() {
            if (!rangeDrag) return;
            rangeDrag.track.classList.remove('is-dragging');
            var row = rangeRowOf(rangeDrag.track);
            if (row) row.classList.remove('is-dragging');
            rangeDrag = null;
            document.removeEventListener('mousemove', rangeOnMove);
            document.removeEventListener('mouseup', rangeOnUp);
        }

        function rangeOnMove(event) {
            if (!rangeDrag) return;
            var next = rangeValueFromEvent(rangeDrag.track, event);
            if (next == null || next === rangeDrag.value) return;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            rangeDrag.value = next;
            applyRangeValue(rangeDrag.track, next);
        }

        function rangeOnUp() {
            rangeStopDrag();
        }

        function rangeStartDrag(track, event) {
            if (!track || typeof track.getAttribute !== 'function') return;
            rangeStopDrag(); /* 多个滑块同时存在时只拖动当前一个 */
            var current = Number(track.getAttribute('aria-valuenow'));
            if (!isFinite(current)) current = Number(track.getAttribute('data-range-min'));
            if (!isFinite(current)) current = 0;
            rangeDrag = { track: track, value: current };
            track.classList.add('is-dragging');
            var row = rangeRowOf(track);
            if (row) row.classList.add('is-dragging');
            document.addEventListener('mousemove', rangeOnMove);
            document.addEventListener('mouseup', rangeOnUp);
            if (typeof track.focus === 'function') {
                try { track.focus(); } catch (ignore) {}
            }
            /* 按下即跳到位，拖动期间只更新滑块本身，不 re-render 工具页 */
            var next = rangeValueFromEvent(track, event);
            if (next != null) {
                rangeDrag.value = next;
                applyRangeValue(track, next);
            }
        }

        toolHost.addEventListener('mousedown', function (event) {
            if (event.button != null && event.button !== 0) return;
            var track = event.target.closest ? event.target.closest('[data-range-track]') : null;
            if (!track) return;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            rangeStartDrag(track, event);
        });

        toolHost.addEventListener('keydown', function (event) {
            var track = event.target.closest ? event.target.closest('[data-range-track]') : null;
            if (!track) return;
            var min = Number(track.getAttribute('data-range-min'));
            var max = Number(track.getAttribute('data-range-max'));
            var step = Number(track.getAttribute('data-range-step'));
            if (!isFinite(step) || step <= 0) step = 1;
            var current = Number(track.getAttribute('aria-valuenow'));
            if (!isFinite(current)) current = isFinite(min) ? min : 0;
            var multiplier = event.shiftKey ? 10 : 1;
            var key = event.key;
            var next = null;
            if (key === 'ArrowLeft' || key === 'ArrowDown') next = current - step * multiplier;
            else if (key === 'ArrowRight' || key === 'ArrowUp') next = current + step * multiplier;
            else if (key === 'Home') next = min;
            else if (key === 'End') next = max;
            if (next == null) return;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            applyRangeValue(track, next);
        });

        var comfyHost = $('page-comfy');
        if (!comfyHost) return;
        comfyHost.addEventListener('click', function (event) {
            if (event.target.closest('[data-preview-open]')) {
                openPreviewModal();
                return;
            }
            var gotoSettings = event.target.closest('[data-comfy-goto-settings]');
            if (gotoSettings) {
                if (api && typeof api.setPage === 'function') api.setPage('settings');
                return;
            }
            var selectionButton = event.target.closest('[data-comfy-selection-image]');
            if (selectionButton) {
                closeComfyMenus();
                uploadComfySelection(
                    selectionButton.getAttribute('data-comfy-selection-image'),
                    selectionButton
                );
                return;
            }
            var option = event.target.closest('[data-param-option]');
            if (option) {
                var optionKey = option.getAttribute('data-param-option');
                var optionValue = option.getAttribute('data-param-option-value') || '';
                state.comfy.paramValues[optionKey] = optionValue;
                var selectWrap = option.closest('.comfy-select');
                var selectTrigger = selectWrap ? selectWrap.querySelector('[data-param-combo-trigger]') : null;
                var valueNode = selectTrigger ? selectTrigger.querySelector('.comfy-select-value') : null;
                if (valueNode) valueNode.textContent = optionValue;
                closeComfyMenus();
                return;
            }
            var comboTrigger = event.target.closest('[data-param-combo-trigger]');
            if (comboTrigger) {
                openComfyCombo(comboTrigger);
                return;
            }
            var boolOption = event.target.closest('[data-param-bool-value]');
            if (boolOption) {
                var boolWrap = boolOption.closest('[data-param-bool]');
                var boolKey = boolWrap ? boolWrap.getAttribute('data-param-bool') : '';
                var boolValue = boolOption.getAttribute('data-param-bool-value') === 'true';
                if (boolKey) state.comfy.paramValues[boolKey] = boolValue;
                if (boolWrap) {
                    var boolOptions = boolWrap.querySelectorAll('[data-param-bool-value]');
                    for (var bi = 0; bi < boolOptions.length; bi++) {
                        boolOptions[bi].classList.toggle(
                            'is-active',
                            boolOptions[bi].getAttribute('data-param-bool-value') === String(boolValue));
                    }
                }
                return;
            }
            if (!event.target.closest('.comfy-select')) closeComfyMenus();
            var workflowRow = event.target.closest('[data-comfy-workflow]');
            if (workflowRow) {
                var workflowName = workflowRow.getAttribute('data-comfy-workflow');
                if (workflowName &&
                    (workflowName !== state.comfy.workflowName || !state.comfy.workflow)) {
                    comfyLoadWorkflow(workflowName, true).catch(function (error) {
                        toast(comfyErrorText(error), 'error');
                    });
                } else if (workflowName) {
                    state.comfy.listVisible = false;
                    syncComfyListVisibility();
                }
                return;
            }
            var randomButton = event.target.closest('[data-param-random]');
            if (randomButton) {
                var randomKey = randomButton.getAttribute('data-param-random');
                var form = comfyForm();
                var randomValue = form.randomSeed();
                state.comfy.paramValues[randomKey] = randomValue;
                var seedInput = randomButton.parentNode
                    ? randomButton.parentNode.querySelector('[data-param-key]')
                    : null;
                if (seedInput) seedInput.value = String(randomValue);
                return;
            }
            var action = event.target.closest('[data-tool-action]');
            if (action) {
                var actionName = action.getAttribute('data-tool-action');
                if (actionName === 'comfy-test') comfyTest().catch(function (error) {
                    setToolStatus(comfyErrorText(error), 'error');
                    toast('连接失败', 'error');
                });
                else if (actionName === 'comfy-refresh') {
                    state.comfy.listVisible = true;
                    syncComfyListVisibility();
                    comfyRefreshWorkflows(true).catch(function (error) {
                        setToolStatus(comfyErrorText(error), 'error');
                    });
                }
                return;
            }
            var run = event.target.closest('[data-tool-run]');
            if (run) runTool(run.getAttribute('data-tool-run'));
        });
        var updateComfyField = function (target) {
            if (!target) return;
            var key = target.getAttribute && target.getAttribute('data-param-key');
            if (!key) return;
            var kind = target.getAttribute('data-param-kind') || 'string';
            try {
                state.comfy.paramValues[key] = comfyForm().coerceValue(kind, target.value);
            } catch (ignore) {
                state.comfy.paramValues[key] = target.value;
            }
        };
        comfyHost.addEventListener('input', function (event) {
            updateComfyField(event.target);
        });
        comfyHost.addEventListener('change', function (event) {
            updateComfyField(event.target);
        });
    }

    /* ================= 挂载 ================= */

    function mount(appApi) {
        api = appApi;
        state.comfy.localBaseUrl = readStored(COMFY_LOCAL_URL_KEY, '');
        if (!state.comfy.localBaseUrl) {
            var storedBase = '';
            if (root.HuanmengComfyClient) {
                try { storedBase = root.HuanmengComfyClient.getBaseUrl(); } catch (ignore) {}
            }
            if (!storedBase) storedBase = COMFY_DEFAULT_LOCAL_URL;
            state.comfy.localBaseUrl = storedBase;
        }
        state.comfy.baseUrl = state.comfy.localBaseUrl;
        if (root.HuanmengComfyClient) {
            try { root.HuanmengComfyClient.setBaseUrl(state.comfy.baseUrl); } catch (ignore) {}
        }
        bindChat();
        bindTools();
        updateChatModelLabel();
    }

    function onPage(page) {
        if (page === 'chat') {
            updateChatModelLabel();
            scrollChat();
        } else if (page === 'tools') {
            renderTools();
        } else if (page === 'tool') {
            renderTool();
            refreshToolPreview(false);
        } else if (page === 'comfy') {
            renderComfyPage();
            refreshToolPreview(false);
            comfyRefreshWorkflows(true).catch(function (error) {
                setToolStatus(comfyErrorText(error), 'error');
            });
        }
    }

    root.ZhuangWorkspace = {
        mount: mount,
        onPage: onPage,
        sendChat: sendChat,
        state: state,
        comfy: {
            getLocalUrl: comfyLocalUrl,
            setLocalUrl: setComfyLocalUrl
        }
    };
})(window);
