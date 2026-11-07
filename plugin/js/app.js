/* ZHUANG-AI插件 · 面板逻辑 */
(function (root) {
    'use strict';

    var PAGE_META = {
        create: { title: '创作', subtitle: '左下角预设包，写需求直接回 PS' },
        chat: { title: '对话', subtitle: '带选区问修图问题' },
        tools: { title: '工具', subtitle: '校色、辉光、特效、超分' },
        tool: { title: '工具', subtitle: '当前文档与选区' },
        comfy: { title: 'ComfyUI', subtitle: '本机 / 局域网工作流' },
        history: { title: '历史', subtitle: '生成过的图都在这里' },
        presets: { title: '预设', subtitle: '表情包面板：左键套用、右键编辑' },
        logs: { title: '运行日志', subtitle: '生成、回贴、ComfyUI 和报错' },
        settings: { title: '设置', subtitle: '模型、ComfyUI 与回贴偏好' }
    };

    var RESOLUTIONS = ['1K', '2K', '3K', '4K'];
    // 历史最多保留 30 次，一页直接全显示；不要每 6 张一页，
    // 否则下方会留下大片空白，看起来像“页面没铺满”。
    var HISTORY_PAGE_SIZE = 30;
    var contextRefreshPromise = null;

    var state = {
        page: 'create',
        busy: false,
        context: {
            available: false,
            doc: null,
            bounds: null,
            hasSelection: false,
            docName: '',
            error: ''
        },
        settings: null,
        ui: null,
        presets: [],
        prompt: '',
        currentPresetId: '',
        presetCategory: '',
        presetSearch: '',
        quickPresetCategory: '',
        settingsTab: 'appearance',
        ringConnected: false,
        logFilter: 'all',
        imageCount: 1,
        referenceImages: [],
        referenceBusy: false,
        historyPage: 0,
        history: [],
        results: {},
        lastResult: null,
        abortController: null,
        modelPanelOpen: false,
        modalType: '',
        editingPresetId: '',
        confirmOptions: null,
        viewer: null
    };

    function $(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function formatClock(timestamp) {
        var date = new Date(Number(timestamp) || Date.now());
        var now = new Date();
        var time = pad(date.getHours()) + ':' + pad(date.getMinutes());
        if (date.getFullYear() === now.getFullYear() &&
            date.getMonth() === now.getMonth() &&
            date.getDate() === now.getDate()) {
            return '今天 ' + time;
        }
        return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + time;
    }

    function debounce(fn, wait) {
        var timer = null;
        return function () {
            var context = this;
            var args = arguments;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(context, args); }, wait);
        };
    }

    function friendlyError(error) {
        var message = error && error.message ? error.message : String(error || '未知错误');
        if (root.HuanmengCore && root.HuanmengCore.friendlyError) {
            message = root.HuanmengCore.friendlyError(message);
        }
        return message;
    }

    function isUserCancelled(error) {
        var message = error && error.message ? error.message : String(error || '');
        return /cancel|cancelled|canceled|取消/i.test(message);
    }

    function toast(message, kind) {
        var node = $('toast');
        if (!node) return;
        node.textContent = String(message || '');
        node.className = 'toast is-visible' + (kind === 'error' ? ' is-error' : '');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(function () {
            node.className = 'toast';
        }, 2600);
    }

    /* ---------------- 设置读取 ---------------- */

    function readSettings() {
        var core = root.HuanmengCore.getSettings();
        var ui = root.ZhuangStore.readUi();
        var model = core.imgModel || 'grs/nano-banana-2.1';
        var resolution = String(core.imgResolution || '2K').toUpperCase();
        if (resolution === 'AUTO') resolution = '2K';
        if (RESOLUTIONS.indexOf(resolution) < 0) resolution = '2K';
        return {
            model: model,
            modelMeta: root.ZhuangData.findModel(model),
            resolution: resolution,
            autoPlace: ui.autoPlace !== false,
            autoColorMatch: ui.autoColorMatch === true,
            storageToken: ui.storageToken,
            storagePath: ui.storagePath,
            lastPresetId: ui.lastPresetId,
            draft: ui.draft
        };
    }

    function saveCore(patch) {
        root.HuanmengCore.saveSettings(patch || {});
        state.settings = readSettings();
    }

    function providerForModel(model) {
        return root.ZhuangData.providerInfo(root.ZhuangData.findModel(model).provider);
    }

    function providerKey(providerId) {
        var info = root.ZhuangData.providerInfo(providerId);
        var settings = root.HuanmengCore.getSettings();
        var value = settings[info.keyField] || '';
        if (!value && info.id === 'grs') value = settings.chatApiKey || '';
        if (!value && info.id === 'openai') value = settings.chatApiKey || '';
        return value;
    }

    function hasApiKey() {
        if (root.ZHUANG_DEMO) return true;
        if (!state.settings) return false;
        var info = providerForModel(state.settings.model);
        if (info.optionalKey) return true;
        return !!String(providerKey(info.id) || '').trim();
    }

    function currentProviderUrl(providerId) {
        var info = root.ZhuangData.providerInfo(providerId);
        if (!info.supportsUrl || !info.urlField) return '';
        var settings = root.HuanmengCore.getSettings();
        var value = String(settings[info.urlField] || '').trim();
        if (value) return value;
        var defaults = root.HuanmengCore.DEFAULTS || {};
        if (info.id === 'grs') {
            return settings.grsRegion === 'overseas'
                ? (defaults.grsDefaultBaseUrl || '')
                : (defaults.grsChinaBaseUrl || '');
        }
        var fallback = {
            google: 'googleBaseUrl',
            xai: 'xaiBaseUrl',
            volcengine: 'volcengineBaseUrl',
            'vertex-ai': 'vertexBaseUrl',
            openai: 'openaiBaseUrl',
            newapi: 'newApiBaseUrl',
            'newapi-openai': 'newApiBaseUrl',
            'newapi-gemini': 'newApiBaseUrl',
            grok2api: 'grok2apiBaseUrl',
            sub2api: 'sub2apiBaseUrl',
            firefly: 'fireflyBaseUrl'
        }[info.id];
        return fallback && defaults[fallback] ? defaults[fallback] : '';
    }

    /* ---------------- 连接 / 文档上下文 ---------------- */

    function setConnection(mode, text) {
        var badge = $('psBadge');
        var label = $('psBadgeText');
        var rail = $('railPs');
        if (badge) {
            badge.className = 'connection' + (mode === 'on' ? ' is-on' : (mode === 'error' ? ' is-error' : ''));
        }
        if (label) label.textContent = text;
        if (rail) {
            rail.className = 'rail-ps' + (mode === 'on' ? ' is-on' : '');
        }
    }

    function contextFromDocument(doc, selection, canvas) {
        if (!doc) {
            return {
                available: true,
                doc: null,
                bounds: null,
                hasSelection: false,
                docName: '',
                error: ''
            };
        }
        var bounds = selection || canvas;
        return {
            available: true,
            doc: doc,
            bounds: bounds,
            hasSelection: !!selection,
            docName: doc.name || '未命名文档',
            width: bounds ? Math.round(bounds.width) : 0,
            height: bounds ? Math.round(bounds.height) : 0,
            error: ''
        };
    }

    function refreshContext(options) {
        if (contextRefreshPromise) return contextRefreshPromise;
        var silent = !!(options && options.silent);
        if (!silent) {
            var title = $('docTitle');
            var meta = $('docMeta');
            if (title) title.textContent = '正在读取文档…';
            if (meta) meta.textContent = '选区会自动作为参考图';
        }
        contextRefreshPromise = doRefreshContext();
        contextRefreshPromise.then(function () {
            contextRefreshPromise = null;
        }, function () {
            contextRefreshPromise = null;
        });
        return contextRefreshPromise;
    }

    async function doRefreshContext() {
        if (root.ZHUANG_DEMO && root.ZhuangDemo) {
            state.context = root.ZhuangDemo.context;
            setConnection('on', 'PS 已连接');
            renderDocContext();
            return state.context;
        }

        try {
            if (!root.HuanmengPS.isAvailable()) {
                state.context = {
                    available: false,
                    doc: null,
                    bounds: null,
                    hasSelection: false,
                    docName: '',
                    error: 'Photoshop API 不可用'
                };
                setConnection('error', 'PS 未连接');
                renderDocContext();
                return state.context;
            }
            var doc = root.HuanmengPS.getActiveDocument();
            var selection = null;
            var canvas = null;
            if (doc) {
                selection = await root.HuanmengPS.getSelectionBounds();
                canvas = await root.HuanmengPS.getCanvasBounds();
            }
            state.context = contextFromDocument(doc, selection, canvas);
            setConnection('on', 'PS 已连接');
            renderDocContext();
            return state.context;
        } catch (error) {
            state.context = {
                available: false,
                doc: null,
                bounds: null,
                hasSelection: false,
                docName: '',
                error: friendlyError(error)
            };
            setConnection('error', 'PS 未连接');
            renderDocContext();
            return state.context;
        }
    }



    function renderDocContext() {
        var context = state.context || {};
        var title = $('docTitle');
        var meta = $('docMeta');
        if (!title || !meta) return;

        if (!context.available) {
            title.textContent = '未连接 Photoshop';
            meta.textContent = '请在 Photoshop 的 UXP 面板中打开插件';
            renderComposerMeta();
            return;
        }
        if (!context.doc) {
            title.textContent = '未打开文档';
            meta.textContent = '可以直接生成，完成后会新开文档';
            renderComposerMeta();
            return;
        }
        title.textContent = context.docName || '未命名文档';
        var size = (context.width || 0) + '×' + (context.height || 0);
        meta.textContent = context.hasSelection
            ? '选区 ' + size + ' · 将作为参考图'
            : '未检测到选区 · 使用整幅画布 ' + size;
        var strip = $('docStrip');
        if (strip) strip.classList.toggle('has-selection', !!context.hasSelection);
        renderComposerMeta();
    }

    /* ---------------- 页面切换 ---------------- */

    function setPage(page) {
        if (!PAGE_META[page]) return;
        if (page !== 'settings') state.modelPanelOpen = false;
        state.page = page;
        if (page !== 'create') {
            // 离开创作页时收起浮层，回来时不会留一个展开的旧面板
            togglePresetDrawer(false);
            var openedCount = $('countPopover');
            if (openedCount) openedCount.classList.add('hidden');
        }
        var pages = document.querySelectorAll('.page');
        for (var index = 0; index < pages.length; index++) {
            pages[index].classList.toggle('is-active', pages[index].id === 'page-' + page);
        }
        var railItems = document.querySelectorAll('.rail-item[data-page]');
        for (var railIndex = 0; railIndex < railItems.length; railIndex++) {
            railItems[railIndex].classList.toggle('is-active', railItems[railIndex].getAttribute('data-page') === page);
        }
        var title = $('pageTitle');
        var subtitle = $('pageSubtitle');
        if (title) title.textContent = 'ZHUANG-AI插件';
        if (subtitle) subtitle.textContent = PAGE_META[page].title + ' · ' + PAGE_META[page].subtitle;

        if (page === 'history') renderHistory();
        if (page === 'presets') renderPresets();
        if (page === 'logs') renderLogs();
        if (page === 'settings') renderSettings();
        if (page === 'create') {
            renderComposerMeta();
            refreshContext({ silent: true });
            scrollChatToBottom();
        }
        if (root.ZhuangWorkspace && typeof root.ZhuangWorkspace.onPage === 'function') {
            root.ZhuangWorkspace.onPage(page);
        }
        if (root.ZhuangScroll && typeof root.ZhuangScroll.scheduleRefresh === 'function') {
            refreshScrollSoon();
        }
    }

    /**
     * 页面切完再补几次滚动测量：
     * 页面从 display:none 变成可见时，容器高度可能还是 0，自绘滚动条会漏初始化；
     * 这里在布局稳定后的几个时间点重试，确保右侧滑块一定出现。
     */
    function refreshScrollSoon() {
        if (!root.ZhuangScroll) return;
        var api = root.ZhuangScroll;
        if (typeof api.scheduleRefresh === 'function') api.scheduleRefresh();
        var attempts = [40, 160, 460, 1200];
        attempts.forEach(function (delay) {
            setTimeout(function () {
                var pageEl = document.querySelector('.page.is-active');
                if (typeof api.refreshPage === 'function') {
                    api.refreshPage(pageEl);
                } else if (typeof api.refresh === 'function') {
                    api.refresh(pageEl || document);
                }
            }, delay);
        });
    }

    function scrollChatToBottom() {
        var scroller = $('chatScroll');
        if (!scroller) return;
        if (root.ZhuangScroll && typeof root.ZhuangScroll.scrollToBottom === 'function') {
            root.ZhuangScroll.scrollToBottom(scroller);
            return;
        }
        scroller.scrollTop = scroller.scrollHeight;
    }

    /* ---------------- 创作台顶部 / 输入框 ---------------- */

    function renderComposerMeta() {
        var settings = state.settings || readSettings();
        state.settings = settings;
        var preset = state.currentPresetId ? root.ZhuangStore.findPreset(state.currentPresetId) : null;
        var presetName = $('currentPresetName');
        var hint = $('autoPlaceHint');
        if (presetName) presetName.textContent = preset ? preset.name : '未选择预设';
        if (hint) {
            if (!settings.autoPlace) hint.textContent = '仅生成，不自动回贴';
            else if (!state.context.available) hint.textContent = '生成后仅预览';
            else if (!state.context.doc) hint.textContent = '生成后新开文档';
            else hint.textContent = '生成后自动回贴';
        }
        var setupBanner = $('setupBanner');
        if (setupBanner) setupBanner.classList.toggle('hidden', hasApiKey());
        var runLabel = $('runLabel');
        if (runLabel) runLabel.textContent = state.busy ? '生成中' : '运行';
        var runBtn = $('runBtn');
        if (runBtn) runBtn.classList.toggle('is-busy', state.busy);
    }

    function presetCardHtml(preset, options) {
        var opts = options || {};
        var current = preset.id === state.currentPresetId;
        var quick = opts.mode === 'quick';
        var attr = quick ? 'data-quick-preset' : 'data-preset-card';
        return '<div class="preset-card' + (current ? ' is-current' : '') + '" ' +
            attr + '="' + escapeHtml(preset.id) + '" role="button" tabindex="0"' +
            ' title="' + (quick ? '点击套用' : '左键套用 · 右键编辑') + '">' +
            '<div class="preset-card-icon">' + root.ZhuangIcons.svg(preset.icon) + '</div>' +
            '<div class="preset-card-name">' + escapeHtml(preset.name) + '</div>' +
            '<div class="preset-card-cat">' + escapeHtml(preset.category || '未分类') + '</div>' +
            (quick ? '' :
                '<div class="preset-card-actions">' +
                '<div class="icon-mini" data-preset-edit="' + escapeHtml(preset.id) +
                '" role="button" tabindex="0" title="编辑">' + root.ZhuangIcons.svg('edit') + '</div>' +
                '<div class="icon-mini is-danger" data-preset-delete="' + escapeHtml(preset.id) +
                '" role="button" tabindex="0" title="删除">' + root.ZhuangIcons.svg('trash') + '</div></div>') +
            (current ? '<div class="preset-card-current">当前</div>' : '') +
            '</div>';
    }

    function presetTabsHtml(categories, current, total, attrName) {
        var html = '<div class="preset-tabs">' +
            '<div class="preset-tab' + (!current ? ' is-active' : '') + '" ' + attrName +
            '="" role="button" tabindex="0">全部<em>' + total + '</em></div>';
        categories.forEach(function (item) {
            html += '<div class="preset-tab' + (item.name === current ? ' is-active' : '') + '" ' +
                attrName + '="' + escapeHtml(item.name) + '" role="button" tabindex="0">' +
                escapeHtml(item.name) + '<em>' + item.count + '</em></div>';
        });
        return html + '</div>';
    }

    function renderQuickPresets() {
        var host = $('presetDrawer');
        if (!host) host = $('quickPresets');
        if (!host) return;
        var presets = root.ZhuangStore.allPresets();
        var categories = root.ZhuangStore.presetCategories();
        var current = state.quickPresetCategory;
        if (current && !categories.some(function (item) { return item.name === current; })) {
            current = state.quickPresetCategory = '';
        }
        var list = current
            ? presets.filter(function (preset) { return preset.category === current; })
            : presets;
        var cards = list.slice(0, 8).map(function (preset) {
            return presetCardHtml(preset, { mode: 'quick' });
        }).join('');
        if (!cards) cards = '<div class="preset-empty">这个分类还没有预设</div>';
        var visibleCategories = categories.slice(0, 7);
        host.innerHTML = '<div class="preset-quick">' +
            '<div class="preset-quick-head">' +
            '<span class="preset-quick-title">预设表情包</span>' +
            '<span class="preset-panel-hint">点一下直接填提示词</span>' +
            '<span class="preset-quick-more" data-action="goto-presets" role="button" tabindex="0">全部 ›</span>' +
            '<span class="preset-panel-close" data-action="close-preset-drawer" role="button" tabindex="0" title="关闭" aria-label="关闭预设面板">' +
            root.ZhuangIcons.svg('close') + '</span>' +
            '</div>' +
            '<div class="preset-grid preset-grid-quick">' + cards + '</div>' +
            presetTabsHtml(visibleCategories, current, presets.length, 'data-quick-category') +
            '</div>';
        root.ZhuangIcons.hydrate(host);
    }

    function togglePresetDrawer(open) {
        var drawer = $('presetDrawer');
        if (!drawer) return;
        var shouldOpen = typeof open === 'boolean' ? open : drawer.classList.contains('hidden');
        drawer.classList.toggle('hidden', !shouldOpen);
        if (shouldOpen) renderQuickPresets();
    }

    function applyQuickPreset(id) {
        var preset = root.ZhuangStore.findPreset(id);
        if (!preset) return;
        applyPreset(id, { stay: true });
        renderQuickPresets();
        togglePresetDrawer(false);
        toast('已套用：' + preset.name);
    }

    function renderCountPopover() {
        var host = $('countPopover');
        if (!host) return;
        var html = '<div class="popover-head"><div class="count-popover-title">生成数量</div>' +
            '<span class="popover-close" data-action="close-count-popover" role="button" tabindex="0" title="关闭" aria-label="关闭数量面板">' +
            root.ZhuangIcons.svg('close') + '</span></div><div class="count-options">';
        for (var n = 1; n <= 8; n++) {
            html += '<div class="count-option' + (n === Number(state.imageCount) ? ' is-active' : '') +
                '" data-count-value="' + n + '" role="button" tabindex="0">' + n + '</div>';
        }
        host.innerHTML = html + '</div><div class="count-popover-hint">多张会同时生成</div>';
    }

    function renderGenerationTools() {
        var badge = $('countBadge');
        if (badge) badge.textContent = String(state.imageCount);
        renderCountPopover();
        var disabled = state.referenceImages.length >= 3 || state.referenceBusy;
        var add = $('addReference');
        if (add) {
            add.classList.toggle('is-disabled', disabled);
            add.classList.toggle('is-busy', state.referenceBusy);
        }
        var smart = $('addSmartReference');
        if (smart) {
            smart.classList.toggle('is-disabled', disabled);
            smart.classList.toggle('is-busy', state.referenceBusy);
        }
        renderReferenceStrip();
    }

    function renderReferenceStrip() {
        var strip = $('refStrip');
        if (!strip) return;
        if (!state.referenceImages.length) {
            strip.innerHTML = '';
            strip.classList.add('hidden');
            return;
        }
        var html = '';
        state.referenceImages.forEach(function (item) {
            var src = item.thumb || item.dataUrl;
            html += '<div class="ref-thumb" title="' + escapeHtml(item.name || '参考图') + '">' +
                '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(item.name || '参考图') + '">' +
                '<span class="ref-remove" role="button" tabindex="0" data-ref-remove="' +
                escapeHtml(item.id) + '">×</span></div>';
        });
        strip.innerHTML = html;
        strip.classList.remove('hidden');
    }

    function readUxpFileAsDataUrl(file) {
        return new Promise(function (resolve, reject) {
            var uxp = require('uxp');
            var formats = uxp.storage && uxp.storage.formats;
            var readOptions = formats && formats.binary ? { format: formats.binary } : undefined;
            Promise.resolve(file.read(readOptions)).then(function (buffer) {
                var bytes;
                if (typeof buffer === 'string') {
                    if (/^data:image\//i.test(buffer)) {
                        resolve({ dataUrl: buffer, name: file.name || '参考图' });
                        return;
                    }
                    reject(new Error('文件读取格式不正确'));
                    return;
                }
                if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
                else if (buffer && buffer.buffer instanceof ArrayBuffer) {
                    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.buffer.byteLength);
                } else {
                    reject(new Error('文件读取为空'));
                    return;
                }
                if (!bytes.length) {
                    reject(new Error('文件读取为空'));
                    return;
                }
                if (bytes.length > 16 * 1024 * 1024) {
                    reject(new Error('参考图不能超过 16MB'));
                    return;
                }
                var mime = root.HuanmengCore.detectImageMimeType(bytes) || 'image/png';
                var base64 = root.HuanmengCore.uint8ArrayToBase64(bytes);
                resolve({ dataUrl: 'data:' + mime + ';base64,' + base64, name: file.name || '参考图' });
            }).catch(reject);
        });
    }

    function pickReferenceInBrowser() {
        return new Promise(function (resolve, reject) {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/webp,image/gif';
            input.onchange = function () {
                var file = input.files && input.files[0];
                if (!file) {
                    resolve(null);
                    return;
                }
                if (file.size > 16 * 1024 * 1024) {
                    reject(new Error('参考图不能超过 16MB'));
                    return;
                }
                var reader = new FileReader();
                reader.onload = function () {
                    resolve({ dataUrl: String(reader.result || ''), name: file.name || '参考图' });
                };
                reader.onerror = function () { reject(new Error('读取参考图失败')); };
                reader.readAsDataURL(file);
            };
            input.click();
        });
    }

    async function addReferenceImage() {
        if (state.referenceImages.length >= 3) {
            toast('最多添加 3 张参考图');
            return;
        }
        try {
            var picked = null;
            if (typeof require === 'function') {
                try {
                    var uxp = require('uxp');
                    var fs = uxp.storage && uxp.storage.localFileSystem;
                    if (fs && typeof fs.getFileForOpening === 'function') {
                        var file = await fs.getFileForOpening({ types: ['png', 'jpg', 'jpeg', 'webp', 'gif'] });
                        if (!file) return;
                        picked = await readUxpFileAsDataUrl(file);
                    }
                } catch (uxpError) {
                    if (/cancel/i.test(String(uxpError && uxpError.message || uxpError))) return;
                    throw uxpError;
                }
            }
            if (!picked) picked = await pickReferenceInBrowser();
            if (!picked || !picked.dataUrl) return;
            var item = {
                id: 'ref_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
                name: picked.name || '参考图',
                dataUrl: picked.dataUrl,
                thumb: picked.dataUrl
            };
            state.referenceImages.push(item);
            renderGenerationTools();
            toast('已添加参考图');
            root.ZhuangImageTools.thumbnailFromDataUrl(picked.dataUrl, 140).then(function (thumb) {
                if (thumb) {
                    item.thumb = thumb;
                    renderReferenceStrip();
                }
            }).catch(function (ignore) {});
        } catch (error) {
            toast(friendlyError(error), 'error');
        }
    }

    async function addSelectionReference() {
        if (state.referenceBusy) return;
        if (state.referenceImages.length >= 3) {
            toast('最多添加 3 张参考图');
            return;
        }
        if (!root.HuanmengPS || !root.HuanmengPS.isAvailable()) {
            toast('Photoshop 未连接，读不到选区', 'error');
            return;
        }
        state.referenceBusy = true;
        renderGenerationTools();
        try {
            var context = await refreshContext({ silent: true });
            if (!context.doc) throw new Error('请先打开一张图');
            var bounds = await root.HuanmengPS.getSelectionBounds();
            if (!bounds) throw new Error('当前没有选区，先在 Photoshop 里框选一块区域');
            var base64 = await root.HuanmengPS.captureSelectionBase64(bounds, {
                documentId: context.doc.id,
                // 直接在 Photoshop 里按最长边 1400px 读取：大画布不必先读全尺寸再缩放，抓取更快
                maxDimension: 1400
            });
            if (!base64) throw new Error('选区读取为空');
            var compact = 'data:image/png;base64,' + base64;
            var item = {
                id: 'ref_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
                name: '选区 ' + Math.round(bounds.width) + '×' + Math.round(bounds.height),
                dataUrl: compact,
                thumb: compact
            };
            state.referenceImages.push(item);
            renderGenerationTools();
            if (root.ZhuangLog) {
                root.ZhuangLog.info('参考图', '从选区读取参考图', {
                    document: context.docName || '',
                    width: Math.round(bounds.width),
                    height: Math.round(bounds.height)
                });
            }
            toast('已从选区添加参考图');
        } catch (error) {
            if (root.ZhuangLog) root.ZhuangLog.error('参考图', '读取选区失败', error && error.message);
            toast(friendlyError(error), 'error');
        } finally {
            state.referenceBusy = false;
            renderGenerationTools();
        }
    }

    async function addCanvasReference() {
        if (state.referenceBusy) return;
        if (state.referenceImages.length >= 3) {
            toast('最多添加 3 张参考图');
            return;
        }
        if (!root.HuanmengPS || !root.HuanmengPS.isAvailable()) {
            toast('Photoshop 未连接，抓不到画布', 'error');
            return;
        }
        state.referenceBusy = true;
        renderGenerationTools();
        try {
            var context = await refreshContext({ silent: true });
            if (!context.doc) throw new Error('请先打开一张图');
            var bounds = await root.HuanmengPS.getCanvasBounds();
            if (!bounds) throw new Error('读不到当前画布');
            var base64 = await root.HuanmengPS.captureSelectionBase64(bounds, {
                documentId: context.doc.id,
                // 直接在 Photoshop 里按最长边 1400px 读取：整幅画布不必读全尺寸，抓取明显更快
                maxDimension: 1400
            });
            if (!base64) throw new Error('画布读取为空');
            var compact = 'data:image/png;base64,' + base64;
            var item = {
                id: 'ref_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
                name: '画布 ' + Math.round(bounds.width) + '×' + Math.round(bounds.height),
                dataUrl: compact,
                thumb: compact
            };
            state.referenceImages.push(item);
            renderGenerationTools();
            if (root.ZhuangLog) {
                root.ZhuangLog.info('参考图', '从画布读取参考图', {
                    document: context.docName || '',
                    width: Math.round(bounds.width),
                    height: Math.round(bounds.height)
                });
            }
            toast('已抓取当前画布作为参考图');
        } catch (error) {
            if (root.ZhuangLog) root.ZhuangLog.error('参考图', '抓取画布失败', error && error.message);
            toast(friendlyError(error), 'error');
        } finally {
            state.referenceBusy = false;
            renderGenerationTools();
        }
    }

    async function addSmartReference() {
        if (state.referenceBusy) return;
        if (state.referenceImages.length >= 3) {
            toast('最多添加 3 张参考图');
            return;
        }
        if (root.HuanmengPS && root.HuanmengPS.isAvailable()) {
            var context = null;
            try {
                context = await refreshContext({ silent: true });
            } catch (ignore) {}
            if (context && context.doc && context.hasSelection) {
                await addSelectionReference();
                return;
            }
            if (context && context.doc) {
                await addCanvasReference();
                return;
            }
        }
        await addReferenceImage();
    }

    function bindGenerationTools() {
        var countBtn = $('openCountPopover');
        var countPopover = $('countPopover');
        if (countBtn && countPopover) {
            countBtn.addEventListener('click', function (event) {
                event.stopPropagation();
                togglePresetDrawer(false);
                countPopover.classList.toggle('hidden');
            });
            countPopover.addEventListener('click', function (event) {
                if (event.target.closest('[data-action="close-count-popover"]')) {
                    countPopover.classList.add('hidden');
                    return;
                }
                var option = event.target.closest('[data-count-value]');
                if (!option) return;
                var next = parseInt(option.getAttribute('data-count-value'), 10);
                if (!isFinite(next)) return;
                state.imageCount = Math.max(1, Math.min(8, next));
                root.ZhuangStore.saveUi({ imageCount: state.imageCount });
                renderGenerationTools();
                countPopover.classList.add('hidden');
            });
        }
        var modelIcon = $('modelSettingsIcon');
        if (modelIcon) {
            modelIcon.addEventListener('click', function () {
                var popoverNode = $('countPopover');
                if (popoverNode) popoverNode.classList.add('hidden');
                state.settingsTab = 'model';
                setPage('settings');
            });
        }
        var add = $('addReference');
        if (add) {
            add.addEventListener('click', function () {
                if (state.referenceImages.length >= 3 || state.referenceBusy) return;
                addReferenceImage();
            });
        }
        var smart = $('addSmartReference');
        if (smart) {
            smart.addEventListener('click', function () {
                if (state.referenceImages.length >= 3 || state.referenceBusy) return;
                addSmartReference();
            });
        }
        var strip = $('refStrip');
        if (strip) {
            strip.addEventListener('click', function (event) {
                var node = event.target.closest('[data-ref-remove]');
                if (!node) return;
                var id = node.getAttribute('data-ref-remove');
                state.referenceImages = state.referenceImages.filter(function (item) { return item.id !== id; });
                renderGenerationTools();
            });
        }
    }

    function applyPreset(id, options) {
        var preset = root.ZhuangStore.findPreset(id);
        if (!preset) {
            toast('这个预设不存在了', 'error');
            return;
        }
        state.currentPresetId = preset.id;
        state.prompt = preset.prompt;
        var input = $('promptInput');
        if (input) input.value = preset.prompt;
        root.ZhuangStore.saveUi({ lastPresetId: preset.id, draft: preset.prompt });
        renderComposerMeta();
        if (!options || options.stay !== true) setPage('create');
        if (input) {
            setTimeout(function () {
                try { input.focus(); } catch (ignore) {}
            }, 40);
        }
    }

    function clearCurrentPreset() {
        state.currentPresetId = '';
        root.ZhuangStore.saveUi({ lastPresetId: '' });
        renderComposerMeta();
    }

    /* ---------------- 幻梦圆环 ---------------- */

    function buildRingState() {
        var settings = state.settings || readSettings();
        var context = state.context || {};
        var groups = root.ZhuangStore.ringPresetGroups();
        var modelOptions = [];
        root.ZhuangData.modelGroups.forEach(function (group) {
            group.models.forEach(function (model) {
                modelOptions.push({
                    value: model.value,
                    text: group.label + ' · ' + model.name
                });
            });
        });
        return {
            document: context.doc ? {
                name: context.docName || '未命名文档',
                width: context.width || 0,
                height: context.height || 0,
                hasSelection: !!context.hasSelection
            } : null,
            params: {
                model: settings.model,
                resolution: settings.resolution,
                count: 1
            },
            options: {
                model: modelOptions,
                resolution: RESOLUTIONS.map(function (item) { return { value: item, text: item }; }),
                count: [1]
            },
            presets: groups
        };
    }

    function pushRingState() {
        if (root.ZhuangRingBridge) root.ZhuangRingBridge.pushState();
    }

    function applyPresetFromRing(payload) {
        var data = payload || {};
        var preset = root.ZhuangStore.findPresetByName(data.name, data.category);
        if (!preset) {
            toast('圆环里的这条预设已不存在，请重新连接', 'error');
            pushRingState();
            return false;
        }
        applyPreset(preset.id);
        toast('已套用：' + preset.name);
        return true;
    }

    function clearPromptFromRing() {
        state.prompt = '';
        var input = $('promptInput');
        if (input) input.value = '';
        clearCurrentPreset();
        root.ZhuangStore.saveUi({ draft: '' });
        toast('提示词已清空');
    }

    function startRingBridge() {
        if (!root.ZhuangRingBridge) return;
        root.ZhuangRingBridge.start({
            getState: buildRingState,
            onApplyPreset: applyPresetFromRing,
            onClearPrompt: clearPromptFromRing,
            onStatus: function (connected) {
                state.ringConnected = !!connected;
                renderQuickPresets();
                if (state.page === 'presets') renderPresets();
            }
        });
    }

    function bindComposer() {
        var prompt = $('promptInput');
        if (prompt) {
            prompt.addEventListener('input', function () {
                state.prompt = prompt.value;
                saveDraftSoon();
            });
            prompt.addEventListener('keydown', function (event) {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    runGeneration();
                }
            });
        }

        var runBtn = $('runBtn');
        if (runBtn) {
            runBtn.addEventListener('click', function () { runGeneration(); });
        }
        var refresh = $('refreshContext');
        if (refresh) {
            refresh.addEventListener('click', function () {
                refreshContext().then(function (context) {
                    if (!context.available) {
                        toast('没有连上 Photoshop', 'error');
                    } else if (!context.doc) {
                        toast('没有打开的文档');
                    } else if (context.hasSelection) {
                        toast('已读取选区 ' + context.width + '×' + context.height);
                    } else {
                        toast('未检测到选区，将使用整幅画布');
                    }
                });
            });
        }
        var presetChip = $('currentPresetChip');
        if (presetChip) {
            presetChip.addEventListener('click', function () { setPage('presets'); });
        }
        var openPresets = $('openPresetLibrary');
        if (openPresets) {
            openPresets.addEventListener('click', function () { setPage('presets'); });
        }
        var setupBanner = $('setupBanner');
        if (setupBanner) {
            setupBanner.addEventListener('click', function (event) {
                if (event.target.closest('[data-action="goto-settings"]')) setPage('settings');
            });
        }

        var openDrawer = $('openPresetDrawer');
        if (openDrawer) {
            openDrawer.addEventListener('click', function () {
                var popoverNode = $('countPopover');
                if (popoverNode) popoverNode.classList.add('hidden');
                togglePresetDrawer();
            });
        }

        var drawer = $('presetDrawer');
        if (drawer) {
            drawer.addEventListener('click', function (event) {
                var tab = event.target.closest('[data-quick-category]');
                if (tab) {
                    state.quickPresetCategory = tab.getAttribute('data-quick-category') || '';
                    renderQuickPresets();
                    return;
                }
                if (event.target.closest('[data-action="close-preset-drawer"]')) {
                    togglePresetDrawer(false);
                    return;
                }
                if (event.target.closest('[data-action="goto-presets"]')) {
                    togglePresetDrawer(false);
                    setPage('presets');
                    return;
                }
                var card = event.target.closest('[data-quick-preset]');
                if (card) {
                    applyQuickPreset(card.getAttribute('data-quick-preset'));
                }
            });
        }

        document.addEventListener('click', function (event) {
            var popover = $('countPopover');
            if (popover && !popover.classList.contains('hidden') &&
                !event.target.closest('#countPopover') && !event.target.closest('#openCountPopover')) {
                popover.classList.add('hidden');
            }
            var drawer = $('presetDrawer');
            if (drawer && !drawer.classList.contains('hidden') &&
                !event.target.closest('#presetDrawer') && !event.target.closest('#openPresetDrawer')) {
                togglePresetDrawer(false);
            }
        });
    }

    var saveDraftSoon = debounce(function () {
        root.ZhuangStore.saveUi({ draft: state.prompt });
    }, 350);

    /* ---------------- 生成流程 ---------------- */

    function setBusy(busy) {
        state.busy = busy;
        var runBtn = $('runBtn');
        if (runBtn) runBtn.classList.toggle('is-busy', busy);
        var label = $('runLabel');
        if (label) label.textContent = busy ? '生成中' : '运行';
    }

    function addUserMessage(prompt) {
        var host = $('chatMessages');
        if (!host) return;
        host.insertAdjacentHTML('beforeend',
            '<div class="msg msg-user">' +
            '<div class="avatar avatar-user">你</div>' +
            '<div class="bubble"><div class="bubble-text">' + escapeHtml(prompt) + '</div></div>' +
            '</div>');
        scrollChatToBottom();
    }

    function addProgressMessage(text) {
        var host = $('chatMessages');
        if (!host) return null;
        var id = 'progress_' + Date.now();
        host.insertAdjacentHTML('beforeend',
            '<div class="msg" id="' + id + '">' +
            '<div class="avatar avatar-assistant">Z</div>' +
            '<div class="bubble bubble-assistant progress-bubble">' +
            '<div class="typing"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>' +
            '<div class="progress-line"><span class="spinner"></span><span data-progress-text>' + escapeHtml(text) + '</span>' +
            '<span class="cancel-link" data-cancel-generation>取消</span></div>' +
            '</div></div>');
        var node = $(id);
        var cancel = node ? node.querySelector('[data-cancel-generation]') : null;
        if (cancel) {
            cancel.addEventListener('click', function () {
                if (state.abortController) {
                    try { state.abortController.abort(); } catch (ignore) {}
                }
                cancel.textContent = '正在取消';
                cancel.style.color = '#b1b7b2';
            });
        }
        scrollChatToBottom();
        return {
            node: node,
            setText: function (value) {
                var textNode = node ? node.querySelector('[data-progress-text]') : null;
                if (textNode) textNode.textContent = value;
            },
            remove: function () {
                if (node && node.parentNode) node.parentNode.removeChild(node);
            }
        };
    }

    function addErrorBubble(message, retryable) {
        var host = $('chatMessages');
        if (!host) return;
        host.insertAdjacentHTML('beforeend',
            '<div class="msg">' +
            '<div class="avatar avatar-assistant">Z</div>' +
            '<div class="bubble bubble-assistant bubble-error">' +
            '<div class="bubble-title">这次没生成成功</div>' +
            '<div class="error-detail">' + escapeHtml(message) + '</div>' +
            '<div class="result-actions">' +
            (retryable ? '<div class="result-action" role="button" tabindex="0" data-chat-action="retry">重试</div>' : '') +
            '<div class="result-action" role="button" tabindex="0" data-chat-action="open-settings">检查设置</div>' +
            '</div></div></div>');
        scrollChatToBottom();
    }

    function resultTag(result) {
        if (result.placed) return { text: '已回贴', className: 'result-tag' };
        if (result.placeError) return { text: '回贴失败', className: 'result-tag is-error' };
        return { text: '未回贴', className: 'result-tag' };
    }

    function resultCardHtml(result) {
        var tag = resultTag(result);
        var previewUrl = result.thumb || (/^https?:\/\//i.test(result.sourceUrl || '') ? result.sourceUrl : '');
        var image = previewUrl
            ? '<img class="result-image" src="' + escapeHtml(previewUrl) + '" alt="生成结果预览">' +
              '<div class="result-view">' + root.ZhuangIcons.svg('eye') + '<span>查看图片</span></div>'
            : '<div class="result-image-empty">' + root.ZhuangIcons.svg('image') + '<span>预览不可用，仍可回贴 / 保存</span></div>';
        var errorLine = result.placeError
            ? '<div class="result-place-error">回贴失败：' + escapeHtml(result.placeError) + '</div>'
            : '';
        return '<div class="msg" data-result-card="' + escapeHtml(result.id) + '">' +
            '<div class="avatar avatar-assistant">Z</div>' +
            '<div class="bubble bubble-assistant result-bubble">' +
            '<div class="result-image-wrap" role="button" tabindex="0" data-chat-action="view" data-result-id="' + escapeHtml(result.id) + '">' +
            image +
            '</div>' +
            '<div class="result-meta">' +
            '<div class="result-copy"><div class="result-title">生成完成</div>' +
            '<div class="result-sub">' + escapeHtml(result.modelName || result.model || 'AI 模型') + ' · ' +
            escapeHtml(result.resolution || '2K') + (result.presetName ? ' · ' + escapeHtml(result.presetName) : '') +
            (result.colorMatched ? ' · 已校色' : '') + '</div></div>' +
            '<div class="' + tag.className + '">' + tag.text + '</div>' +
            '</div>' +
            errorLine +
            '<div class="result-actions">' +
            '<div class="result-action is-primary" role="button" tabindex="0" data-chat-action="view" data-result-id="' + escapeHtml(result.id) + '">' +
            root.ZhuangIcons.svg('eye') + '<span>查看图片</span></div>' +
            '<div class="result-action" role="button" tabindex="0" data-chat-action="place" data-result-id="' + escapeHtml(result.id) + '">' +
            root.ZhuangIcons.svg('send') + '<span>' + (result.placed ? '再贴一次' : '回贴 PS') + '</span></div>' +
            '<div class="result-action" role="button" tabindex="0" data-chat-action="save" data-result-id="' + escapeHtml(result.id) + '">' +
            root.ZhuangIcons.svg('download') + '<span>保存</span></div>' +
            '</div></div></div>';
    }

    function bindResultImageFallback(card) {
        if (!card) return;
        var image = card.querySelector('.result-image');
        if (!image) return;
        image.addEventListener('error', function () {
            var wrap = image.parentNode;
            if (!wrap) return;
            wrap.innerHTML = '<div class="result-image-empty">' + root.ZhuangIcons.svg('image') +
                '<span>预览不可用，仍可保存 / 回贴</span></div>';
        });
    }

    function addResultMessage(result) {
        var host = $('chatMessages');
        if (!host) return;
        host.insertAdjacentHTML('beforeend', resultCardHtml(result));
        var card = host.querySelector('[data-result-card="' + result.id + '"]');
        bindResultImageFallback(card);
        scrollChatToBottom();
    }

    function rerenderResultCard(result) {
        var host = $('chatMessages');
        if (!host) return;
        var old = host.querySelector('[data-result-card="' + result.id + '"]');
        if (!old) return;
        old.outerHTML = resultCardHtml(result);
        var next = host.querySelector('[data-result-card="' + result.id + '"]');
        bindResultImageFallback(next);
    }

    function dataUrlFromResult(result) {
        if (!result) return Promise.resolve('');
        if (result.dataUrl) return Promise.resolve(result.dataUrl);
        if (result.historyId) {
            var item = root.ZhuangStore.findHistory(result.historyId);
            if (item) return root.ZhuangStore.readHistoryImage(item);
        }
        if (result.storage) return root.ZhuangStore.readHistoryImage(result);
        return Promise.resolve(result.thumb || '');
    }

    async function capturePreviewFromDocument(bounds, documentId) {
        // UXP 下 canvas.toDataURL 经常不可用；优先使用 Photoshop 自己的成像 API。
        try {
            var preview = await root.HuanmengPS.capturePreviewDataUrl(bounds, {
                maxDimension: 720,
                documentId: documentId
            });
            if (preview) return preview;
        } catch (error) {
            console.warn('[app] Photoshop 预览编码失败，回退到 canvas', error);
        }
        try {
            var rgba = await root.HuanmengPS.captureImageData(bounds, {
                maxDimension: 720,
                documentId: documentId
            });
            return root.ZhuangImageTools.thumbnailFromRgba(rgba, 720);
        } catch (error) {
            return '';
        }
    }

    async function runDemoGeneration(prompt, progress) {
        var wait = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
        progress.setText('正在读取选区…');
        await wait(320);
        progress.setText('正在请求模型…');
        await wait(900);
        progress.setText('正在回贴…');
        await wait(420);
        if (!root.ZhuangDemo || typeof root.ZhuangDemo.makeResult !== 'function') {
            throw new Error('演示数据未加载');
        }
        return root.ZhuangDemo.makeResult(prompt, state.currentPresetId, state.settings);
    }

    async function runGeneration() {
        if (state.busy) return;
        var input = $('promptInput');
        var prompt = String((input && input.value) || state.prompt || '').trim();
        if (!prompt) {
            toast('先写一句你想改什么');
            if (input) {
                try { input.focus(); } catch (ignore) {}
            }
            return;
        }
        state.prompt = prompt;
        root.ZhuangStore.saveUi({ draft: prompt });

        var runPresetId = state.currentPresetId;
        var runPresetName = runPresetId ? (root.ZhuangStore.findPreset(runPresetId) || {}).name || '' : '';
        var runModel = state.settings.model;
        var runModelName = state.settings.modelMeta.name;
        var runResolution = state.settings.resolution;
        var runAutoPlace = state.settings.autoPlace;
        var runAutoColorMatch = state.settings.autoColorMatch;
        var runCount = Math.max(1, Math.min(8, Number(state.imageCount) || 1));
        var runReferenceImages = state.referenceImages.map(function (item) { return item.dataUrl; })
            .filter(Boolean);
        var runSettings = Object.assign({}, root.HuanmengCore.getSettings());

        if (!root.ZHUANG_DEMO && !hasApiKey()) {
            toast('先在设置里填 API Key');
            setPage('settings');
            setTimeout(function () {
                var keyInput = $('apiKeyInput');
                if (keyInput) {
                    try { keyInput.focus(); } catch (ignore) {}
                }
            }, 80);
            return;
        }

        addUserMessage(prompt);
        // 发出去就清空输入框（和微信发消息一样），提示词留在聊天气泡里
        state.prompt = '';
        if (input) input.value = '';
        root.ZhuangStore.saveUi({ draft: '' });
        var progress = addProgressMessage('准备生成…');
        setBusy(true);
        state.abortController = new AbortController();
        if (root.ZhuangLog) {
            root.ZhuangLog.info('生成', '开始生成', {
                model: runModelName,
                count: runCount,
                references: runReferenceImages.length,
                preset: runPresetName || '无',
                autoPlace: !!runAutoPlace
            });
        }

        try {
            var context = await refreshContext();
            if (context.doc && !context.hasSelection) {
                toast('未检测到选区，本次使用整幅画布');
            }
            if (root.ZhuangLog) {
                root.ZhuangLog.info('选区', context.doc ? '已读取当前文档' : '无打开文档', {
                    document: context.docName || '',
                    documentId: context.doc ? context.doc.id : null,
                    hasSelection: !!context.hasSelection,
                    bounds: context.bounds || null
                });
            }
            var resultData = null;

            if (root.ZHUANG_DEMO && root.ZhuangDemo) {
                resultData = await runDemoGeneration(prompt, progress);
                resultData.prompt = prompt;
                resultData.presetName = runPresetName;
                resultData.model = runModel;
                resultData.modelName = runModelName;
                resultData.resolution = runResolution;
                resultData.createdAt = Date.now();
                state.results[resultData.id] = resultData;
                state.lastResult = resultData;
                addGeneratedResult(resultData, context, progress, prompt);
                return;
            }

            var imageBase64 = null;
            if (context.available && context.doc && context.bounds) {
                progress.setText('正在读取选区…');
                var base64 = await root.HuanmengPS.captureSelectionBase64(context.bounds, {
                    documentId: context.doc.id
                });
                if (!base64) throw new Error('选区读取为空，请重新框选后再试');
                imageBase64 = 'data:image/png;base64,' + base64;
            }

            progress.setText(runCount > 1
                ? '正在同时生成 ' + runCount + ' 张…'
                : '正在请求模型…');
            if (root.ZhuangLog) {
                root.ZhuangLog.info('生成', '请求模型', {
                    model: runModelName,
                    provider: providerForModel(runModel).id,
                    endpoint: currentProviderUrl(providerForModel(runModel).id),
                    count: runCount,
                    resolution: runResolution,
                    hasImage: !!imageBase64
                });
            }
            var generated = await root.HuanmengImageGen.generateImages({
                model: runModel,
                prompt: prompt,
                count: runCount,
                imageResolution: runResolution,
                imageBase64: imageBase64 || undefined,
                referenceImages: runReferenceImages.length ? runReferenceImages : undefined,
                sizeHint: context.bounds || null,
                settings: runSettings,
                signal: state.abortController.signal,
                onProgress: function (index, total) {
                    progress.setText('正在同时生成 · 已完成 ' + index + '/' + total);
                },
                onStatus: function (phase) {
                    if (phase === 'download') progress.setText('正在下载结果图…');
                }
            });

            if (!generated.success || !generated.images || !generated.images.length) {
                if (generated.canceled) {
                    var cancelError = new Error('已取消生成');
                    cancelError.name = 'AbortError';
                    throw cancelError;
                }
                throw new Error(generated.error || '模型没有返回图片');
            }
            var generatedFailed = Array.isArray(generated.errors) ? generated.errors.length : 0;
            var generatedCanceled = !!generated.canceled;
            if (root.ZhuangLog) {
                root.ZhuangLog.success('生成', '模型返回图片', {
                    images: generated.images.length,
                    model: runModelName
                });
                if (generatedFailed) {
                    root.ZhuangLog.warn('生成', '部分请求失败', {
                        failed: generatedFailed,
                        succeed: generated.images.length,
                        total: runCount
                    });
                }
            }

            var dataUrl = generated.images[0].dataUrl;
            var sourceUrl = generated.images[0].sourceUrl || '';
            var thumb = '';
            var placed = false;
            var placeError = '';
            var placedDocumentId = context.doc ? context.doc.id : null;
            var placedBounds = context.bounds || null;
            var colorMatchInfo = null;

            if (runAutoPlace) {
                progress.setText(runAutoColorMatch ? '正在回贴并融合校色…' : '正在回贴到 Photoshop…');
                var returnToDocumentId = null;
                try {
                    if (!root.HuanmengPS.isAvailable()) {
                        throw new Error('Photoshop 未连接');
                    }
                    var activeBeforePlace = root.HuanmengPS.getActiveDocument();
                    if (activeBeforePlace &&
                        (!context.doc || Number(activeBeforePlace.id) !== Number(context.doc.id))) {
                        returnToDocumentId = activeBeforePlace.id;
                    }
                    if (context.doc && context.bounds) {
                        var placeOptions = { mode: 'stretch' };
                        if (runAutoColorMatch) {
                            placeOptions.colorMatch = {
                                method: 'wavelet',
                                strength: 100,
                                onResult: function (info) { colorMatchInfo = info; }
                            };
                        }
                        await root.HuanmengPlace.placeImageAtBounds(
                            dataUrl,
                            context.bounds,
                            'ZHUANG-AI插件 · ' + (runPresetName || '生成'),
                            context.doc.id,
                            placeOptions
                        );
                        placed = true;
                    } else {
                        var newDoc = await root.HuanmengPlace.createDocumentFromDataUrl(dataUrl, 'ZHUANG-AI插件 · 生成');
                        placed = true;
                        if (newDoc) {
                            placedDocumentId = newDoc.id;
                            placedBounds = null;
                        }
                    }
                    if (root.ZhuangLog) {
                        root.ZhuangLog.success('回贴', '已回贴到原文件', {
                            document: context.docName || '',
                            documentId: placedDocumentId
                        });
                    }
                } catch (placeFailure) {
                    placeError = friendlyError(placeFailure);
                    if (root.ZhuangLog) {
                        root.ZhuangLog.error('回贴', '回贴失败', placeError);
                    }
                }

                // 回贴成功后再从 Photoshop 抓一张小图。UXP 的 canvas.toDataURL
                // 并不总是可用，而 PS 自己的 encodeImageData 是稳定路径。
                if (placed) {
                    progress.setText('正在生成预览…');
                    try {
                        if (placedDocumentId && placedBounds) {
                            thumb = await capturePreviewFromDocument(placedBounds, placedDocumentId);
                        } else {
                            var active = root.HuanmengPS.getActiveDocument();
                            var activeCanvas = active ? await root.HuanmengPS.getCanvasBounds() : null;
                            if (active && activeCanvas) thumb = await capturePreviewFromDocument(activeCanvas, active.id);
                        }
                    } catch (ignore) {}
                }

                // 用户在生成期间切到了别的文件修图：回贴完成后把焦点还回去，
                // 不要把正在修的文件强行切走。
                if (returnToDocumentId) {
                    try {
                        await root.HuanmengPS.runInModal(async function () {
                            await root.HuanmengPS.selectDocument(returnToDocumentId);
                        }, '恢复生成前正在编辑的文档');
                        if (root.ZhuangLog) {
                            root.ZhuangLog.info('回贴', '已切回生成期间正在编辑的文件', {
                                documentId: returnToDocumentId
                            });
                        }
                    } catch (returnError) {
                        if (root.ZhuangLog) {
                            root.ZhuangLog.warn('回贴', '切回编辑文件失败', returnError && returnError.message);
                        }
                    }
                }
            }

            if (!thumb) {
                progress.setText('正在准备预览…');
                thumb = await root.ZhuangImageTools.thumbnailFromDataUrl(dataUrl, 720);
            }

            var result = {
                id: 'result_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                dataUrl: dataUrl,
                sourceUrl: sourceUrl,
                thumb: thumb,
                prompt: prompt,
                presetName: runPresetName,
                model: runModel,
                modelName: runModelName,
                resolution: runResolution,
                placed: placed,
                colorMatched: !!(colorMatchInfo && colorMatchInfo.applied),
                placeError: placeError,
                bounds: placedBounds,
                documentId: placedDocumentId,
                documentName: context.docName || '',
                createdAt: Date.now()
            };
            state.results[result.id] = result;
            state.lastResult = result;
            addResultMessage(result);

            try {
                var historyItem = await root.ZhuangStore.addHistory({
                    prompt: result.prompt,
                    presetName: result.presetName,
                    model: result.model,
                    modelName: result.modelName,
                    resolution: result.resolution,
                    placed: result.placed,
                    colorMatched: result.colorMatched,
                    placeError: result.placeError,
                    bounds: result.bounds,
                    documentId: result.documentId,
                    documentName: result.documentName
                }, dataUrl, thumb);
                result.historyId = historyItem.id;
            } catch (historyError) {
                console.warn('[app] 历史保存失败', historyError);
                if (root.ZhuangLog) {
                    root.ZhuangLog.warn('历史', '保存历史失败', historyError && historyError.message);
                }
            }

            // 数量 > 1 时，第一张按设置回贴；其余先以结果卡片展示，
            // 用户点「回贴 PS」再决定贴哪张，避免多张图叠在同一处。
            for (var extraIndex = 1; extraIndex < generated.images.length; extraIndex++) {
                progress.setText('正在整理第 ' + (extraIndex + 1) + '/' + generated.images.length + ' 张…');
                var extraImage = generated.images[extraIndex];
                var extraThumb = '';
                try {
                    extraThumb = await root.ZhuangImageTools.thumbnailFromDataUrl(extraImage.dataUrl, 720);
                } catch (ignoreThumb) {}
                if (!extraThumb) extraThumb = extraImage.sourceUrl || '';
                var extraResult = {
                    id: 'result_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                    dataUrl: extraImage.dataUrl,
                    sourceUrl: extraImage.sourceUrl || '',
                    thumb: extraThumb,
                    prompt: prompt,
                    presetName: runPresetName,
                    model: runModel,
                    modelName: runModelName,
                    resolution: runResolution,
                    placed: false,
                    colorMatched: false,
                    placeError: '',
                    bounds: null,
                    documentId: null,
                    documentName: context.docName || '',
                    createdAt: Date.now() + extraIndex
                };
                state.results[extraResult.id] = extraResult;
                addResultMessage(extraResult);
                try {
                    var extraHistory = await root.ZhuangStore.addHistory({
                        prompt: extraResult.prompt,
                        presetName: extraResult.presetName,
                        model: extraResult.model,
                        modelName: extraResult.modelName,
                        resolution: extraResult.resolution,
                        placed: false,
                        colorMatched: false,
                        placeError: '',
                        bounds: null,
                        documentId: null,
                        documentName: extraResult.documentName
                    }, extraImage.dataUrl, extraThumb);
                    extraResult.historyId = extraHistory.id;
                } catch (extraHistoryError) {
                    console.warn('[app] 额外结果历史保存失败', extraHistoryError);
                }
            }

            if (progress) progress.remove();
            var totalImages = generated.images.length;
            var failNote = generatedFailed ? '（' + generatedFailed + ' 张失败）' : '';
            var cancelNote = generatedCanceled ? '，已取消剩余' : '';
            if (totalImages > 1) {
                toast('已生成 ' + totalImages + ' 张' + failNote +
                    (placed ? '，第一张已回贴' : '，点结果卡片可回贴') + cancelNote);
            } else if (placed) {
                toast((result.colorMatched ? '已回贴并融合校色' : '已回贴到 Photoshop') + failNote + cancelNote);
            } else if (placeError) {
                toast('已生成，回贴失败' + failNote, 'error');
            } else {
                toast('生成完成' + failNote);
            }
        } catch (error) {
            if (progress) progress.remove();
            if (error && error.name === 'AbortError') {
                if (root.ZhuangLog) root.ZhuangLog.warn('生成', '用户取消生成');
                toast('已取消生成');
            } else {
                if (root.ZhuangLog) root.ZhuangLog.error('生成', '生成失败', error && error.message);
                addErrorBubble(friendlyError(error), true);
                toast('生成失败', 'error');
            }
        } finally {
            if (progress) progress.remove();
            setBusy(false);
            state.abortController = null;
            refreshContext();
        }
    }

    function addGeneratedResult(result, context, progress, prompt) {
        if (progress) progress.remove();
        addResultMessage(result);
        if (result.placed) {
            toast(result.colorMatched ? '已回贴并融合校色' : '已回贴到 Photoshop');
        } else if (result.placeError) {
            toast('已生成，回贴失败', 'error');
        } else {
            toast('生成完成');
        }
    }

    /* ---------------- 结果操作 ---------------- */

    function findCurrentResult(id) {
        return state.results[id] || (state.lastResult && state.lastResult.id === id ? state.lastResult : null);
    }

    async function placeResult(result) {
        if (root.ZHUANG_DEMO) {
            result.placed = true;
            result.placeError = '';
            rerenderResultCard(result);
            toast('演示模式：已模拟回贴');
            return;
        }
        if (!root.HuanmengPS.isAvailable()) {
            toast('Photoshop 未连接，无法回贴', 'error');
            return;
        }
        var dataUrl = await dataUrlFromResult(result);
        if (!dataUrl) throw new Error('找不到原图，无法回贴');
        var layerName = 'ZHUANG-AI插件 · ' + (result.presetName || '回贴');
        var active = root.HuanmengPS.getActiveDocument();
        var placed = false;
        var targetBounds = result.bounds || null;
        var targetDocumentId = result.documentId || null;
        var colorMatchInfo = null;
        var placeOptions = { mode: 'stretch' };
        if (state.settings.autoColorMatch) {
            placeOptions.colorMatch = {
                method: 'wavelet',
                strength: 100,
                onResult: function (info) { colorMatchInfo = info; }
            };
        }

        if (targetBounds && targetDocumentId) {
            var originalDoc = root.HuanmengPS.getDocumentById(targetDocumentId);
            if (originalDoc) {
                await root.HuanmengPlace.placeImageAtBounds(dataUrl, targetBounds, layerName, targetDocumentId, placeOptions);
                placed = true;
            }
        }
        if (!placed && active) {
            var bounds = await root.HuanmengPS.getTargetBounds();
            if (bounds) {
                await root.HuanmengPlace.placeImageAtBounds(dataUrl, bounds, layerName, active.id, placeOptions);
                placed = true;
                targetBounds = bounds;
                targetDocumentId = active.id;
            }
        }
        if (!placed) {
            var created = await root.HuanmengPlace.createDocumentFromDataUrl(dataUrl, layerName);
            placed = !!created;
            targetBounds = null;
            targetDocumentId = created ? created.id : null;
        }
        result.placed = true;
        result.colorMatched = !!(colorMatchInfo && colorMatchInfo.applied);
        result.placeError = '';
        result.bounds = targetBounds;
        result.documentId = targetDocumentId;
        if (result.id) rerenderResultCard(result);
        if (result.historyId) root.ZhuangStore.updateHistory(result.historyId, {
            placed: true,
            colorMatched: result.colorMatched
        });
        else if (result.storage) root.ZhuangStore.updateHistory(result.id, {
            placed: true,
            colorMatched: result.colorMatched
        });
        if (root.ZhuangLog) {
            root.ZhuangLog.success('回贴', '结果卡片手动回贴', {
                documentId: targetDocumentId,
                colorMatched: !!result.colorMatched
            });
        }
        toast(result.colorMatched ? '已回贴并融合校色' : '已回贴到 Photoshop');
        refreshContext();
    }

    async function saveResult(result) {
        if (root.ZHUANG_DEMO) {
            toast('演示模式：已模拟保存');
            return;
        }
        var dataUrl = await dataUrlFromResult(result);
        if (!dataUrl) throw new Error('找不到原图，无法保存');
        try {
            var saved = await root.ZhuangStore.saveImageToDirectory(dataUrl, 'ZHUANG-AI');
            toast('已保存：' + saved.name);
        } catch (error) {
            if (error && error.code === 'NO_STORAGE_FOLDER') {
                var chosen = null;
                try {
                    chosen = await root.ZhuangStore.chooseStorageFolder();
                } catch (pickError) {
                    if (isUserCancelled(pickError)) return;
                    throw pickError;
                }
                if (!chosen) return;
                var next = await root.ZhuangStore.saveImageToDirectory(dataUrl, 'ZHUANG-AI');
                toast('已保存：' + next.name);
                if (state.page === 'settings') renderSettings();
            } else {
                throw error;
            }
        }
    }

    async function openViewer(kind, id) {
        var target = kind === 'history' ? root.ZhuangStore.findHistory(id) : findCurrentResult(id);
        if (!target) {
            toast('记录不存在', 'error');
            return;
        }
        var preview = target.thumb || '';
        if (!preview && /^https?:\/\//i.test(target.sourceUrl || '')) {
            preview = target.sourceUrl;
        }
        if (!preview) {
            preview = await dataUrlFromResult(target);
        }
        if (!preview) {
            toast('这张图没有可用预览，仍可尝试保存', 'error');
        }
        state.viewer = { kind: kind, id: id };
        var title = kind === 'history' ? '历史图片' : '生成结果';
        var modelText = target.modelName || target.model || 'AI 模型';
        var dateText = kind === 'history' ? formatClock(target.createdAt) : '刚刚生成';
        var prompt = target.prompt || '（没有记录提示词）';
        var deleteButton = kind === 'history'
            ? '<div class="btn btn-danger" data-viewer-action="delete">删除</div>'
            : '';
        var modal = '<div class="viewer-card">' +
            '<div class="viewer-head"><div class="viewer-title">' + title + '</div>' +
            '<div class="modal-close" data-modal-close role="button" tabindex="0">' + root.ZhuangIcons.svg('close') + '</div></div>' +
            '<div class="viewer-stage">' +
            (preview ? '<img class="viewer-image" src="' + escapeHtml(preview) + '" alt="图片预览">' : '') +
            '</div>' +
            '<div class="viewer-body">' +
            '<div class="viewer-prompt">' + escapeHtml(prompt) + '</div>' +
            '<div class="viewer-meta"><span>' + escapeHtml(modelText) + '</span><span>' +
            escapeHtml(target.resolution || '2K') + '</span><span>' + escapeHtml(dateText) + '</span></div>' +
            '</div>' +
            '<div class="viewer-actions">' +
            '<div class="btn btn-primary" data-viewer-action="place">回贴 PS</div>' +
            '<div class="btn btn-ghost" data-viewer-action="save">保存图片</div>' +
            deleteButton +
            '</div></div>';
        showModal(modal);
        var image = $('modalRoot').querySelector('.viewer-image');
        if (image) {
            image.addEventListener('error', function () {
                image.style.display = 'none';
            });
        }
    }

    async function handleViewerAction(action) {
        if (!state.viewer) return;
        var target = state.viewer.kind === 'history'
            ? root.ZhuangStore.findHistory(state.viewer.id)
            : findCurrentResult(state.viewer.id);
        if (!target) {
            closeModal();
            toast('记录不存在', 'error');
            return;
        }
        if (action === 'place') {
            closeModal();
            try {
                await placeResult(target);
            } catch (error) {
                toast(friendlyError(error), 'error');
            }
            return;
        }
        if (action === 'save') {
            closeModal();
            try {
                await saveResult(target);
            } catch (error) {
                toast(friendlyError(error), 'error');
            }
            return;
        }
        if (action === 'delete' && state.viewer.kind === 'history') {
            var id = state.viewer.id;
            closeModal();
            openConfirm({
                title: '删除这张图？',
                desc: '会同时删除历史记录和本地原图，无法恢复。',
                confirmText: '删除',
                danger: true,
                onConfirm: async function () {
                    await root.ZhuangStore.removeHistory(id);
                    state.historyPage = 0;
                    renderHistory();
                    toast('已删除');
                }
            });
        }
    }

    function bindChat() {
        var host = $('chatMessages');
        if (!host) return;
        host.addEventListener('click', function (event) {
            var actionNode = event.target.closest('[data-chat-action]');
            if (!actionNode) return;
            var action = actionNode.getAttribute('data-chat-action');
            if (action === 'retry') {
                runGeneration();
                return;
            }
            if (action === 'open-settings') {
                setPage('settings');
                return;
            }
            var resultId = actionNode.getAttribute('data-result-id');
            var result = findCurrentResult(resultId);
            if (!result) {
                toast('结果已失效，请重新生成', 'error');
                return;
            }
            if (action === 'view') {
                openViewer('current', resultId);
            } else if (action === 'place') {
                placeResult(result).catch(function (error) { toast(friendlyError(error), 'error'); });
            } else if (action === 'save') {
                saveResult(result).catch(function (error) { toast(friendlyError(error), 'error'); });
            }
        });
    }

    /* ---------------- 历史页 ---------------- */

    function renderHistory() {
        var host = $('page-history');
        if (!host) return;
        state.history = root.ZhuangStore.historyList();
        var total = state.history.length;
        var pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
        if (state.historyPage >= pages) state.historyPage = pages - 1;
        if (state.historyPage < 0) state.historyPage = 0;
        var start = state.historyPage * HISTORY_PAGE_SIZE;
        var items = state.history.slice(start, start + HISTORY_PAGE_SIZE);
        var grid = '';
        items.forEach(function (item) {
            var thumb = item.thumb
                ? '<img src="' + escapeHtml(item.thumb) + '" alt="历史图片预览">'
                : '<div class="history-thumb-empty">' + root.ZhuangIcons.svg('image') + '</div>';
            grid += '<div class="history-card" data-history-id="' + escapeHtml(item.id) + '" role="button" tabindex="0">' +
                '<div class="history-thumb">' + thumb +
                (item.placed ? '<span class="history-placed">已回贴</span>' : '') + '</div>' +
                '<div class="history-body"><div class="history-prompt">' + escapeHtml(item.prompt || '无提示词') + '</div>' +
                '<div class="history-meta"><span class="history-model">' +
                escapeHtml(item.modelName || item.model || 'AI 模型') + '</span><span class="history-date">' +
                escapeHtml(formatClock(item.createdAt)) + '</span></div></div></div>';
        });
        if (!grid) {
            grid = '<div class="empty-state">' +
                '<div class="empty-icon">' + root.ZhuangIcons.svg('image') + '</div>' +
                '<div class="empty-title">还没有生成记录</div>' +
                '<div class="empty-text">每次生成都会自动留一张原图和缩略图，方便回看和再次回贴。</div>' +
                '<div class="btn btn-primary empty-action" data-action="goto-create">去创作</div>' +
                '</div>';
        }
        var pager = '';
        if (pages > 1) {
            pager = '<div class="pager">' +
                '<div class="pager-btn ' + (state.historyPage <= 0 ? 'is-disabled' : '') + '" role="button" tabindex="0" data-history-page="' + (state.historyPage - 1) + '">' + root.ZhuangIcons.svg('chevronLeft') + '</div>' +
                '<span>' + (state.historyPage + 1) + ' / ' + pages + '</span>' +
                '<div class="pager-btn ' + (state.historyPage >= pages - 1 ? 'is-disabled' : '') + '" role="button" tabindex="0" data-history-page="' + (state.historyPage + 1) + '">' + root.ZhuangIcons.svg('chevronRight') + '</div>' +
                '</div>';
        }
        host.innerHTML = '<div class="page-scroll">' +
            '<div class="page-head"><div class="page-head-copy">' +
            '<div class="page-head-title">历史记录</div>' +
            '<div class="page-head-desc">保留最近 30 次生成，原图存在插件数据目录。</div></div>' +
            '<div class="head-actions">' +
            (total ? '<div class="btn btn-ghost" data-action="clear-history">清空</div>' : '') +
            '</div></div>' +
            (total ? '<div class="history-summary"><span>共 ' + total + ' 张</span><span>点击图片查看</span></div>' : '') +
            '<div class="history-grid">' + grid + '</div>' + pager +
            '</div>';
        root.ZhuangIcons.hydrate(host);
    }

    function bindHistoryPage() {
        var host = $('page-history');
        if (!host) return;
        host.addEventListener('click', function (event) {
            var pageNode = event.target.closest('[data-history-page]');
            if (pageNode) {
                var page = Number(pageNode.getAttribute('data-history-page'));
                if (!pageNode.classList.contains('is-disabled') && page >= 0) {
                    state.historyPage = page;
                    renderHistory();
                }
                return;
            }
            var actionNode = event.target.closest('[data-action]');
            if (actionNode) {
                var action = actionNode.getAttribute('data-action');
                if (action === 'goto-create') setPage('create');
                if (action === 'clear-history') {
                    openConfirm({
                        title: '清空全部历史？',
                        desc: '会删除所有历史记录和本地原图，这个操作不能撤销。',
                        confirmText: '全部清空',
                        danger: true,
                        onConfirm: async function () {
                            await root.ZhuangStore.clearHistory();
                            state.historyPage = 0;
                            state.history = [];
                            renderHistory();
                            toast('历史已清空');
                        }
                    });
                }
                return;
            }
            var card = event.target.closest('[data-history-id]');
            if (card) openViewer('history', card.getAttribute('data-history-id'));
        });
    }

    /* ---------------- 日志页 ---------------- */

    var LOG_FILTERS = [
        { id: 'all', label: '全部' },
        { id: 'info', label: '信息' },
        { id: 'warn', label: '警告' },
        { id: 'error', label: '错误' }
    ];

    function logFilterMatch(item, filter) {
        if (filter === 'all') return true;
        if (filter === 'info') return item.level === 'info' || item.level === 'success';
        return item.level === filter;
    }

    function logTime(timestamp) {
        var date = new Date(timestamp);
        var pad = function (value) { return value < 10 ? '0' + value : String(value); };
        return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
            pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    function renderLogs() {
        var host = $('page-logs');
        if (!host) return;
        var logs = root.ZhuangLog ? root.ZhuangLog.list().reverse() : [];
        var filter = state.logFilter || 'all';
        var visible = logs.filter(function (item) { return logFilterMatch(item, filter); });
        var chips = LOG_FILTERS.map(function (entry) {
            var count = logs.filter(function (item) { return logFilterMatch(item, entry.id); }).length;
            return '<div class="log-filter' + (entry.id === filter ? ' is-active' : '') +
                '" data-log-filter="' + entry.id + '" role="button" tabindex="0">' +
                entry.label + '<span>' + count + '</span></div>';
        }).join('');
        var rows = visible.map(function (item) {
            var levelLabel = item.level === 'success' ? '成功'
                : item.level === 'warn' ? '警告'
                    : item.level === 'error' ? '错误' : '信息';
            return '<div class="log-row log-' + escapeHtml(item.level) + '">' +
                '<div class="log-head">' +
                '<span class="log-time">' + escapeHtml(logTime(item.time)) + '</span>' +
                '<span class="log-level">' + levelLabel + '</span>' +
                '<span class="log-scope">' + escapeHtml(item.scope) + '</span>' +
                '</div>' +
                '<div class="log-message">' + escapeHtml(item.message) + '</div>' +
                (item.detail ? '<div class="log-detail">' + escapeHtml(item.detail) + '</div>' : '') +
                '</div>';
        }).join('');
        host.innerHTML = '<div class="page-scroll">' +
            '<div class="page-head"><div class="page-head-copy">' +
            '<div class="page-head-title">运行日志</div>' +
            '<div class="page-head-desc">最近 ' + logs.length + ' 条，只留在本机，不记录 Key 和图片。</div></div>' +
            '<div class="head-actions">' +
            '<div class="btn btn-ghost" data-action="open-settings">设置</div>' +
            '<div class="btn btn-ghost" data-action="copy-logs">复制</div>' +
            '<div class="btn btn-ghost" data-action="clear-logs">清空</div>' +
            '</div></div>' +
            '<div class="log-filters">' + chips + '</div>' +
            '<div class="log-list">' +
            (rows || '<div class="log-empty">' + root.ZhuangIcons.svg('clock') +
                '<span>当前筛选下还没有日志。</span></div>') +
            '</div></div>';
        root.ZhuangIcons.hydrate(host);
    }

    function copyLogs() {
        if (!root.ZhuangLog) return;
        var text = root.ZhuangLog.formatText();
        if (!text) {
            toast('暂时没有日志');
            return;
        }
        var fallback = function () {
            try {
                var area = document.createElement('textarea');
                area.value = text;
                area.style.position = 'fixed';
                area.style.left = '-9999px';
                document.body.appendChild(area);
                area.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(area);
                toast(ok ? '日志已复制' : '复制失败', ok ? 'success' : 'error');
            } catch (error) {
                toast('复制失败', 'error');
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                toast('日志已复制');
            }).catch(fallback);
        } else {
            fallback();
        }
    }

    function bindLogsPage() {
        var host = $('page-logs');
        if (!host) return;
        host.addEventListener('click', function (event) {
            var filterNode = event.target.closest('[data-log-filter]');
            if (filterNode) {
                state.logFilter = filterNode.getAttribute('data-log-filter') || 'all';
                renderLogs();
                return;
            }
            var actionNode = event.target.closest('[data-action]');
            if (!actionNode) return;
            var action = actionNode.getAttribute('data-action');
            if (action === 'open-settings') setPage('settings');
            if (action === 'copy-logs') copyLogs();
            if (action === 'clear-logs') {
                openConfirm({
                    title: '清空运行日志？',
                    desc: '只清空日志记录，不影响生成历史和设置。',
                    confirmText: '清空日志',
                    danger: true,
                    onConfirm: function () {
                        if (root.ZhuangLog) root.ZhuangLog.clear();
                        renderLogs();
                        toast('日志已清空');
                    }
                });
            }
        });
    }

    /* ---------------- 预设页 ---------------- */

    function renderPresets() {
        var host = $('page-presets');
        if (!host) return;
        state.presets = root.ZhuangStore.allPresets();
        var categories = root.ZhuangStore.presetCategories();
        var selected = state.presetCategory;
        if (selected && !categories.some(function (item) { return item.name === selected; })) {
            selected = state.presetCategory = '';
        }
        var list = selected
            ? state.presets.filter(function (preset) { return preset.category === selected; })
            : state.presets;
        var cards = list.map(function (preset) {
            return presetCardHtml(preset, { mode: 'page' });
        }).join('');
        cards += '<div class="preset-card preset-card-new" data-action="add-preset" role="button" tabindex="0">' +
            '<div class="preset-card-icon">' + root.ZhuangIcons.svg('plus') + '</div>' +
            '<div class="preset-card-name">新建</div>' +
            '<div class="preset-card-cat">自定义预设</div></div>';
        var query = state.presetSearch || '';
        host.innerHTML = '<div class="page-scroll">' +
            '<div class="page-head"><div class="page-head-copy">' +
            '<div class="page-head-title">预设表情包</div>' +
            '<div class="page-head-desc">左键套用、右键编辑；圆环连上也能在圆环里选。</div></div>' +
            '<div class="head-actions"><div class="btn btn-primary" data-action="add-preset" role="button" tabindex="0">' +
            root.ZhuangIcons.svg('plus') + '新建</div></div></div>' +
            '<div class="preset-search">' +
            '<span class="preset-search-icon">' + root.ZhuangIcons.svg('search') + '</span>' +
            '<input class="preset-search-input" id="presetSearchInput" type="text" autocomplete="off" ' +
            'maxlength="60" placeholder="搜索预设名称、分类或提示词" value="' + escapeHtml(query) + '">' +
            '<span class="preset-search-clear' + (query ? '' : ' hidden') +
            '" data-action="clear-preset-search" role="button" tabindex="0" title="清空搜索">' +
            root.ZhuangIcons.svg('close') + '</span>' +
            '</div>' +
            presetTabsHtml(categories, selected, state.presets.length, 'data-preset-category') +
            '<div class="preset-grid">' + cards + '</div>' +
            '<div class="preset-search-empty hidden" data-preset-search-empty>' +
            '<div class="preset-search-empty-title" data-preset-search-empty-text></div>' +
            '<div class="preset-search-empty-hint">换个关键词，或点「新建」存一条。</div></div>' +
            '<div class="preset-page-foot">' +
            '<span class="ring-status' + (state.ringConnected ? ' is-on' : '') + '">' +
            '<span class="ring-status-dot"></span>' +
            (state.ringConnected ? '幻梦圆环已连接' : '圆环未连接（不影响直接选预设）') + '</span>' +
            '<span class="preset-panel-hint">左键套用 · 右键编辑</span>' +
            '</div></div>';
        root.ZhuangIcons.hydrate(host);
        applyPresetSearchFilter();
    }

    /** 预设页搜索：只切换卡片显隐，不重渲染整页，输入时不会丢焦点。 */
    function applyPresetSearchFilter() {
        var host = $('page-presets');
        if (!host) return;
        var query = String(state.presetSearch || '').trim();
        var lower = query.toLowerCase();
        var cards = host.querySelectorAll('[data-preset-card]');
        var matched = 0;
        for (var index = 0; index < cards.length; index++) {
            var card = cards[index];
            var preset = root.ZhuangStore.findPreset(card.getAttribute('data-preset-card'));
            var haystack = preset
                ? (preset.name + ' ' + (preset.category || '') + ' ' + (preset.prompt || '')).toLowerCase()
                : '';
            var hit = !lower || haystack.indexOf(lower) !== -1;
            card.classList.toggle('hidden', !hit);
            if (hit) matched++;
        }
        var empty = host.querySelector('[data-preset-search-empty]');
        if (empty) {
            empty.classList.toggle('hidden', !query || matched > 0);
            var label = empty.querySelector('[data-preset-search-empty-text]');
            if (label) label.textContent = query ? '没有找到「' + query + '」相关的预设' : '';
        }
        var clear = host.querySelector('[data-action="clear-preset-search"]');
        if (clear) clear.classList.toggle('hidden', !query);
    }

    function openCategoryPicker() {
        var categories = root.ZhuangStore.presetCategories();
        var total = root.ZhuangStore.allPresets().length;
        var items = '<div class="category-option' + (!state.presetCategory ? ' is-active' : '') +
            '" data-preset-category="" role="button" tabindex="0">' +
            '<span>全部分类</span><span class="category-count">' + total + '</span></div>';
        categories.forEach(function (item) {
            items += '<div class="category-option' + (state.presetCategory === item.name ? ' is-active' : '') +
                '" data-preset-category="' + escapeHtml(item.name) + '" role="button" tabindex="0">' +
                '<span>' + escapeHtml(item.name) + '</span><span class="category-count">' + item.count + '</span>' +
                (state.presetCategory === item.name ? root.ZhuangIcons.svg('check') : '') + '</div>';
        });
        var html = '<div class="modal-card category-modal">' +
            '<div class="modal-head"><div><div class="modal-title">选择预设分类</div>' +
            '<div class="modal-desc">只保留幻梦圆环的预设分类</div></div>' +
            '<div class="modal-close" data-modal-close role="button" tabindex="0">' + root.ZhuangIcons.svg('close') + '</div></div>' +
            '<div class="category-list">' + items + '</div></div>';
        state.modalType = 'category';
        showModal(html);
    }

    function bindPresetsPage() {
        var host = $('page-presets');
        if (!host) return;

        function presetOf(node) {
            return node ? root.ZhuangStore.findPreset(node.getAttribute('data-preset-card')) : null;
        }

        function applyCard(node) {
            var preset = presetOf(node);
            if (!preset) return;
            applyPreset(preset.id);
            toast('已套用：' + preset.name);
        }

        function editCard(node) {
            var preset = presetOf(node);
            if (preset) openPresetModal(preset);
        }

        // 左键套用、右键编辑（右键在 UXP 里不一定触发，卡片上另有「编辑」小按钮兜底）
        host.addEventListener('contextmenu', function (event) {
            var card = event.target.closest('[data-preset-card]');
            if (!card) return;
            event.preventDefault();
            editCard(card);
        });

        host.addEventListener('input', function (event) {
            if (!event.target || event.target.id !== 'presetSearchInput') return;
            state.presetSearch = event.target.value || '';
            applyPresetSearchFilter();
        });

        host.addEventListener('click', function (event) {
            var clearSearch = event.target.closest('[data-action="clear-preset-search"]');
            if (clearSearch) {
                event.stopPropagation();
                state.presetSearch = '';
                var searchInput = $('presetSearchInput');
                if (searchInput) {
                    searchInput.value = '';
                    try { searchInput.focus(); } catch (ignore) {}
                }
                applyPresetSearchFilter();
                return;
            }
            var deleteNode = event.target.closest('[data-preset-delete]');
            if (deleteNode) {
                event.stopPropagation();
                var id = deleteNode.getAttribute('data-preset-delete');
                var preset = root.ZhuangStore.findPreset(id);
                openConfirm({
                    title: '删除预设？',
                    desc: preset ? '「' + preset.name + '」会从预设列表移除。' : '这个预设会从列表移除。',
                    confirmText: '删除',
                    danger: true,
                    onConfirm: function () {
                        root.ZhuangStore.removePreset(id);
                        if (state.currentPresetId === id) clearCurrentPreset();
                        renderPresets();
                        renderQuickPresets();
                        pushRingState();
                        toast('预设已删除');
                    }
                });
                return;
            }
            var editNode = event.target.closest('[data-preset-edit]');
            if (editNode) {
                event.stopPropagation();
                editCard(editNode.closest('[data-preset-card]'));
                return;
            }
            var tab = event.target.closest('[data-preset-category]');
            if (tab) {
                state.presetCategory = tab.getAttribute('data-preset-category') || '';
                renderPresets();
                return;
            }
            var addNode = event.target.closest('[data-action="add-preset"]');
            if (addNode) {
                openPresetModal(null);
                return;
            }
            var card = event.target.closest('[data-preset-card]');
            if (card) applyCard(card);
        });

        host.addEventListener('keydown', function (event) {
            if (event.target && event.target.id === 'presetSearchInput') {
                if (event.key === 'Escape') {
                    state.presetSearch = '';
                    event.target.value = '';
                    applyPresetSearchFilter();
                    event.stopPropagation();
                }
                return;
            }
            var card = event.target.closest('[data-preset-card]');
            if (!card) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            // 阻止冒泡到 document 的全局 Enter 处理，避免重复触发
            event.stopPropagation();
            if (event.shiftKey) {
                editCard(card);
                return;
            }
            applyCard(card);
        });
    }

    /* ---------------- 设置页 ---------------- */

    function modelOptionsHtml() {
        var html = '';
        var current = root.ZhuangData.findModel(state.settings.model);
        var currentProvider = current.provider;
        var known = false;
        root.ZhuangData.modelGroups.forEach(function (group) {
            group.models.forEach(function (model) {
                if (root.ZhuangData.modelName(state.settings.model).toLowerCase() ===
                    root.ZhuangData.modelName(model.value).toLowerCase() &&
                    currentProvider === group.provider) {
                    known = true;
                }
            });
        });
        if (!known) {
            html += '<div class="model-group-label">当前配置</div>' +
                '<div class="model-option is-selected" role="button" tabindex="0" data-model-value="' +
                escapeHtml(current.value) + '"><div class="model-option-copy"><div class="model-option-name">' +
                escapeHtml(current.name) + '</div></div><div class="model-option-note">已保存</div>' +
                '<div class="model-option-check">' + root.ZhuangIcons.svg('check') + '</div></div>';
        }
        root.ZhuangData.modelGroups.forEach(function (group) {
            html += '<div class="model-group-label">' + escapeHtml(group.label) + '</div>';
            group.models.forEach(function (model) {
                var selected = root.ZhuangData.modelName(state.settings.model).toLowerCase() ===
                    root.ZhuangData.modelName(model.value).toLowerCase() &&
                    currentProvider === group.provider;
                html += '<div class="model-option' + (selected ? ' is-selected' : '') + '" role="button" tabindex="0" data-model-value="' +
                    escapeHtml(model.value) + '"><div class="model-option-copy"><div class="model-option-name">' +
                    escapeHtml(model.name) + '</div></div><div class="model-option-note">' +
                    escapeHtml(model.note || '') + '</div><div class="model-option-check">' +
                    (selected ? root.ZhuangIcons.svg('check') : '') + '</div></div>';
            });
        });
        var provider = root.ZhuangData.providerInfo(currentProvider);
        var customValue = current.group ? '' : root.ZhuangData.modelName(state.settings.model);
        html += '<div class="model-custom">' +
            '<div class="model-custom-label">自定义模型名 · ' + escapeHtml(provider.name) + '</div>' +
            '<div class="model-custom-row">' +
            '<input class="input model-custom-input" id="customModelInput" type="text" ' +
            'placeholder="例如 gemini-2.5-flash-image" value="' + escapeHtml(customValue) + '">' +
            '<div class="btn btn-primary model-custom-apply" data-action="apply-custom-model" role="button" tabindex="0">使用</div>' +
            '</div><div class="model-custom-hint">用于官方新模型或中转站的自定义模型名，按当前渠道发送。</div></div>';
        return html;
    }

    function applyAppearance() {
        var ui = state.ui || {};
        var scale = Number(ui.fontScale) || 1;
        if (scale < 0.9) scale = 0.9;
        if (scale > 1.5) scale = 1.5;
        var theme = ['white', 'gray', 'dark'].indexOf(ui.theme) >= 0 ? ui.theme : 'gray';
        var rootEl = document.documentElement;
        rootEl.style.setProperty('--wx-font-scale', String(scale));
        rootEl.classList.remove('theme-white', 'theme-gray', 'theme-dark');
        rootEl.classList.add('theme-' + theme);
        // UXP 对「行内自定义属性」的支持因版本而异，再写一份 <style> 兜底
        var styleNode = document.getElementById('appearance-style');
        if (!styleNode) {
            styleNode = document.createElement('style');
            styleNode.id = 'appearance-style';
            (document.head || rootEl).appendChild(styleNode);
        }
        styleNode.textContent = ':root{--wx-font-scale:' + scale + ';}';
    }

    function setFontScale(scale, save) {
        var next = Math.max(0.9, Math.min(1.5, Number(scale) || 1));
        state.ui = Object.assign({}, state.ui, { fontScale: next });
        if (save) root.ZhuangStore.saveUi({ fontScale: next });
        applyAppearance();
        var valueNode = document.querySelector('#page-settings [data-font-scale] [data-range-value]');
        var fieldValueNode = document.getElementById('fontScaleValue');
        var track = document.querySelector('#page-settings [data-font-scale] [data-range-track]');
        var fill = track ? track.querySelector('.range-fill') : null;
        var thumb = track ? track.querySelector('.range-thumb') : null;
        var pct = Math.round(next * 100);
        var ratio = Math.max(0, Math.min(100, (pct - 90) / 60 * 100));
        if (valueNode) valueNode.textContent = pct + '%';
        if (fieldValueNode) fieldValueNode.textContent = pct + '%';
        if (fill) fill.style.width = ratio + '%';
        if (thumb) thumb.style.left = ratio + '%';
        if (track) track.setAttribute('aria-valuenow', String(pct));
    }

    function bindFontScaleSlider() {
        var track = document.querySelector('#page-settings [data-font-scale] [data-range-track]');
        if (!track) return;
        var min = 90;
        var max = 150;
        var step = 5;
        var dragging = false;
        function valueFromEvent(event) {
            var rect = track.getBoundingClientRect();
            var ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
            return min + ratio * (max - min);
        }
        function onMove(event) {
            if (dragging) setFontScale(valueFromEvent(event) / 100, false);
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            root.ZhuangStore.saveUi({ fontScale: state.ui.fontScale });
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        track.addEventListener('mousedown', function (event) {
            event.preventDefault();
            dragging = true;
            setFontScale(valueFromEvent(event) / 100, false);
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        track.addEventListener('keydown', function (event) {
            var current = Math.round((Number(state.ui.fontScale) || 1) * 100);
            var next = current;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - step;
            else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + step;
            else if (event.key === 'Home') next = min;
            else if (event.key === 'End') next = max;
            else return;
            event.preventDefault();
            setFontScale(Math.max(min, Math.min(max, next)) / 100, true);
        });
    }

    function renderSettings() {
        var host = $('page-settings');
        if (!host) return;
        state.settings = readSettings();
        state.ui = root.ZhuangStore.readUi();
        var provider = providerForModel(state.settings.model);
        var key = providerKey(provider.id);
        var url = currentProviderUrl(provider.id);
        var historyCount = root.ZhuangStore.historyList().length;
        var modelPanel = state.modelPanelOpen
            ? '<div class="model-panel is-open">' + modelOptionsHtml() + '</div>'
            : '<div class="model-panel"></div>';
        var storageValue = state.settings.storagePath || '未选择，保存时会询问';
        var comfyLocalUrl = '';
        if (root.ZhuangWorkspace && root.ZhuangWorkspace.comfy) {
            try {
                comfyLocalUrl = root.ZhuangWorkspace.comfy.getLocalUrl() || '';
            } catch (ignore) {}
        }

        var fontPct = Math.round((Number(state.ui.fontScale) || 1) * 100);
        var fontRatio = Math.max(0, Math.min(100, (fontPct - 90) / 60 * 100));
        var themeName = state.ui.theme || 'gray';
        var themeOptions = [
            { id: 'gray', label: '亮灰护眼' },
            { id: 'white', label: '白色' },
            { id: 'dark', label: '黑色' }
        ];
        var themeOptionsHtml = themeOptions.map(function (option) {
            return '<div class="theme-option' + (themeName === option.id ? ' is-active' : '') +
                '" data-theme-option="' + option.id + '" role="button" tabindex="0">' +
                '<span class="theme-swatch theme-swatch-' + option.id + '"></span>' +
                '<span>' + option.label + '</span></div>';
        }).join('');

        var settingsTabs = [
            { id: 'appearance', label: '外观' },
            { id: 'model', label: '模型' },
            { id: 'connection', label: '连接' },
            { id: 'comfy', label: 'ComfyUI' },
            { id: 'generate', label: '生成' }
        ];
        var settingsTab = state.settingsTab || 'appearance';
        if (settingsTabs.every(function (item) { return item.id !== settingsTab; })) {
            settingsTab = 'appearance';
            state.settingsTab = settingsTab;
        }
        var settingsTabsHtml = settingsTabs.map(function (tab) {
            return '<div class="settings-tab' + (tab.id === settingsTab ? ' is-active' : '') +
                '" data-settings-tab="' + tab.id + '" role="button" tabindex="0">' + tab.label + '</div>';
        }).join('');
        function settingsSectionClass(id) {
            return 'settings-section' + (id === settingsTab ? ' is-active' : '');
        }

        var html = '<div class="page-scroll settings-page">' +            '<div class="settings-head">' +
            '<div class="settings-head-copy">' +
            '<div class="settings-head-title">设置</div>' +
            '<div class="settings-head-desc">改完自动保存，也可以点右上角保存</div>' +
            '</div>' +
            '<div class="btn btn-primary settings-save-btn" data-action="save-connection" role="button" tabindex="0">' +
            root.ZhuangIcons.svg('check') + '保存</div>' +
            '</div>' +

            '<div class="settings-tabs">' + settingsTabsHtml + '</div>' +

            '<div class="' + settingsSectionClass('appearance') + '" data-settings-section="appearance">' +
            '<div class="settings-card">' +
            '<div class="setting-field">' +
            '<div class="field-label"><span>文字大小</span><span class="field-note" id="fontScaleValue">' + fontPct + '%</span></div>' +
            '<div class="range-row" data-font-scale>' +
            '<div class="range-head"><span class="range-label">界面字号</span><span class="range-value" data-range-value>' + fontPct + '%</span></div>' +
            '<div class="range-track" data-range-track data-range-min="90" data-range-max="150" data-range-step="5" role="slider" tabindex="0" aria-valuemin="90" aria-valuemax="150" aria-valuenow="' + fontPct + '">' +
            '<div class="range-fill" style="width:' + fontRatio + '%"></div>' +
            '<div class="range-thumb" style="left:' + fontRatio + '%"></div>' +
            '</div>' +
            '</div>' +
            '<div class="field-hint">朝右拖变大，朝左拖变小（90%–150%）</div>' +
            '</div>' +
            '<div class="setting-field">' +
            '<div class="field-label"><span>配色</span><span class="field-note">三种配色</span></div>' +
            '<div class="theme-options">' + themeOptionsHtml + '</div>' +
            '</div>' +
            '</div>' +
            '</div>' +

            '<div class="' + settingsSectionClass('model') + '" data-settings-section="model">' +
            '<div class="settings-card">' +
            '<div class="setting-row" data-action="toggle-model" role="button" tabindex="0">' +
            '<div class="setting-icon">' + root.ZhuangIcons.svg('chip') + '</div>' +
            '<div class="setting-copy"><div class="setting-label">API 模型选择</div>' +
            '<div class="setting-value">' + escapeHtml(state.settings.modelMeta.name) + ' · ' +
            escapeHtml(provider.name) + '</div></div>' +
            '<div class="setting-end">切换</div><div class="setting-chevron">' +
            root.ZhuangIcons.svg('chevronDown') + '</div></div>' +
            modelPanel +
            '<div class="setting-row" data-action="choose-folder" role="button" tabindex="0">' +
            '<div class="setting-icon">' + root.ZhuangIcons.svg('folder') + '</div>' +
            '<div class="setting-copy"><div class="setting-label">存储目录</div>' +
            '<div class="setting-value' + (state.settings.storagePath ? '' : ' is-empty') + '">' +
            escapeHtml(storageValue) + '</div></div>' +
            '<div class="setting-end">选择</div></div>' +
            '<div class="setting-row" data-action="open-history" role="button" tabindex="0">' +
            '<div class="setting-icon">' + root.ZhuangIcons.svg('history') + '</div>' +
            '<div class="setting-copy"><div class="setting-label">历史记录</div>' +
            '<div class="setting-value">已保存 ' + historyCount + ' 张 · 最近 30 次</div></div>' +
            '<div class="setting-chevron">' + root.ZhuangIcons.svg('chevronRight') + '</div></div>' +
            '<div class="setting-row" data-action="add-preset" role="button" tabindex="0">' +
            '<div class="setting-icon">' + root.ZhuangIcons.svg('bookmark') + '</div>' +
            '<div class="setting-copy"><div class="setting-label">预设添加</div>' +
            '<div class="setting-value">把常用提示词存成一条预设</div></div>' +
            '<div class="setting-end">添加</div></div>' +
            '</div>' +
            '</div>' +

            '<div class="' + settingsSectionClass('connection') + '" data-settings-section="connection">' +
            '<div class="settings-card">' +
            '<div class="setting-field">' +
            '<div class="field-label"><span>API Key</span><span class="field-note">只存本机</span></div>' +
            '<input class="input" id="apiKeyInput" data-provider="' + escapeHtml(provider.id) + '" data-initial="' + escapeHtml(key) + '" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 ' + escapeHtml(provider.name) + ' 的 Key" value="' + escapeHtml(key) + '">' +
            '<div class="field-hint">' + escapeHtml(provider.keyHint) + '</div></div>' +
            (provider.supportsUrl ? '<div class="setting-field">' +
                '<div class="field-label"><span>接口地址</span><span class="field-note">一般不用改</span></div>' +
                '<input class="input" id="apiUrlInput" data-provider="' + escapeHtml(provider.id) + '" data-initial="' + escapeHtml(url) + '" type="text" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(provider.urlPlaceholder || '') + '" value="' + escapeHtml(url) + '">' +
                '</div>' : '') +
            '<div class="settings-card-foot">' +
            '<span class="connection-save-status" id="connectionStatus">修改后会自动保存，也可以点右上角保存</span>' +
            root.ZhuangIcons.svg('check') +
            '</div>' +
            '</div>' +
            '</div>' +

            '<div class="' + settingsSectionClass('comfy') + '" data-settings-section="comfy">' +
            '<div class="settings-card">' +
            '<div class="setting-field">' +
            '<div class="field-label"><span>ComfyUI 地址</span><span class="field-note">本机 / 局域网</span></div>' +
            '<input class="input" id="comfyLocalUrlInput" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8188" value="' + escapeHtml(comfyLocalUrl) + '">' +
            '<div class="field-hint">填本机或局域网里的 ComfyUI 地址，例如 http://127.0.0.1:8188。</div>' +
            '</div>' +
            '</div>' +
            '</div>' +

            '<div class="' + settingsSectionClass('generate') + '" data-settings-section="generate">' +
            '<div class="settings-card">' +
            '<div class="setting-row is-static">' +
            '<div class="setting-icon">' + root.ZhuangIcons.svg('image') + '</div>' +
            '<div class="setting-copy"><div class="setting-label">分辨率</div>' +
            '<div class="setting-value">按选区自动匹配画幅</div></div>' +
            '<div class="segmented">' + RESOLUTIONS.map(function (resolution) {
                return '<div class="segment' + (resolution === state.settings.resolution ? ' is-active' : '') +
                    '" role="button" tabindex="0" data-resolution="' + resolution + '">' + resolution + '</div>';
            }).join('') + '</div></div>' +
            '<div class="setting-row is-static">' +
            '<div class="setting-icon">' + root.ZhuangIcons.svg('check') + '</div>' +
            '<div class="setting-copy"><div class="setting-label">生成后自动回贴</div>' +
            '<div class="setting-value">关掉后只生成并存入历史</div></div>' +
            '<div class="switch' + (state.settings.autoPlace ? ' is-on' : '') + '" role="switch" tabindex="0" data-action="toggle-autoplace" aria-checked="' + (state.settings.autoPlace ? 'true' : 'false') + '">' +
            '<span class="switch-knob"></span></div></div>' +
            '<div class="setting-row is-static">' +
            '<div class="setting-icon">' + root.ZhuangIcons.svg('palette') + '</div>' +
            '<div class="setting-copy"><div class="setting-label">回贴时融合校色</div>' +
            '<div class="setting-value">把回图颜色拉回原画面，慢一点</div></div>' +
            '<div class="switch' + (state.settings.autoColorMatch ? ' is-on' : '') + '" role="switch" tabindex="0" data-action="toggle-colormatch" aria-checked="' + (state.settings.autoColorMatch ? 'true' : 'false') + '">' +
            '<span class="switch-knob"></span></div></div>' +
            '</div>' +
            '</div>' +

            '<div class="settings-foot">ZHUANG-AI插件 · 2.1.0 · 修图面板<br>与幻梦共用 huanmeng_config</div>' +
            '</div>';

        var oldScroll = host.querySelector('.page-scroll');
        var scrollTop = oldScroll
            ? (root.ZhuangScroll && root.ZhuangScroll.getScrollTop ? root.ZhuangScroll.getScrollTop(oldScroll) : oldScroll.scrollTop)
            : 0;
        host.innerHTML = html;
        var newScroll = host.querySelector('.page-scroll');
        root.ZhuangIcons.hydrate(host);
        bindSettingsInputs();
        if (root.ZhuangScroll) {
            root.ZhuangScroll.refresh(host);
            if (newScroll && scrollTop > 0) root.ZhuangScroll.setScrollTop(newScroll, scrollTop);
        } else if (newScroll && scrollTop > 0) {
            newScroll.scrollTop = scrollTop;
        }
    }

    function setConnectionStatus(text, kind) {
        var node = $('connectionStatus');
        if (!node) return;
        node.textContent = text;
        node.className = 'connection-save-status' + (kind ? ' is-' + kind : '');
    }

    function bindSettingsInputs() {
        var keyInput = $('apiKeyInput');
        if (keyInput) {
            var keyProvider = keyInput.getAttribute('data-provider');
            var commitKey = function () {
                if (keyInput.value === keyInput.getAttribute('data-initial')) return;
                saveConnectionField('key', keyProvider, keyInput.value);
                keyInput.setAttribute('data-initial', keyInput.value);
            };
            var saveKeySoon = debounce(commitKey, 450);
            keyInput.addEventListener('input', function () {
                setConnectionStatus('有未保存修改', 'dirty');
                saveKeySoon();
            });
            keyInput.addEventListener('blur', commitKey);
        }
        var urlInput = $('apiUrlInput');
        if (urlInput) {
            var urlProvider = urlInput.getAttribute('data-provider');
            var commitUrl = function () {
                if (urlInput.value === urlInput.getAttribute('data-initial')) return;
                saveConnectionField('url', urlProvider, urlInput.value);
                urlInput.setAttribute('data-initial', urlInput.value);
            };
            var saveUrlSoon = debounce(commitUrl, 450);
            urlInput.addEventListener('input', function () {
                setConnectionStatus('有未保存修改', 'dirty');
                saveUrlSoon();
            });
            urlInput.addEventListener('blur', commitUrl);
        }

        var comfyUrlInput = $('comfyLocalUrlInput');
        if (comfyUrlInput) {
            var commitComfyUrl = function () {
                if (!root.ZhuangWorkspace || !root.ZhuangWorkspace.comfy) return;
                var normalized = root.ZhuangWorkspace.comfy.setLocalUrl(comfyUrlInput.value);
                if (normalized) comfyUrlInput.value = normalized;
            };
            var saveComfyUrlSoon = debounce(commitComfyUrl, 450);
            comfyUrlInput.addEventListener('input', saveComfyUrlSoon);
            comfyUrlInput.addEventListener('blur', commitComfyUrl);
        }

        bindFontScaleSlider();
    }

    function saveConnectionField(kind, providerId, value) {
        var info = root.ZhuangData.providerInfo(providerId);
        var patch = {};
        if (kind === 'key') {
            patch[info.keyField] = String(value || '').trim();
        } else if (info.supportsUrl && info.urlField) {
            patch[info.urlField] = String(value || '').trim();
            if (info.id === 'grs') {
                patch.grsRegion = String(value || '').trim() ? 'custom' : 'domestic';
            }
        }
        saveCore(patch);
        renderComposerMeta();
        setConnectionStatus('已保存', 'saved');
    }

    function saveAllConnection() {
        var keyInput = $('apiKeyInput');
        var urlInput = $('apiUrlInput');
        var providerId = keyInput
            ? keyInput.getAttribute('data-provider')
            : (urlInput ? urlInput.getAttribute('data-provider') : providerForModel(state.settings.model).id);
        if (keyInput) {
            saveConnectionField('key', providerId, keyInput.value);
            keyInput.setAttribute('data-initial', keyInput.value);
        }
        if (urlInput) {
            saveConnectionField('url', providerId, urlInput.value);
            urlInput.setAttribute('data-initial', urlInput.value);
        }
        state.settings = readSettings();
        setConnectionStatus('已保存', 'saved');
        renderComposerMeta();
        toast(urlInput ? 'API Key 和地址已保存' : 'API Key 已保存');
    }

    function applyModel(value) {
        var meta = root.ZhuangData.findModel(value);
        root.HuanmengCore.saveSettings({ imgModel: meta.value });
        state.settings = readSettings();
        state.modelPanelOpen = false;
        renderComposerMeta();
        renderSettings();
        toast('模型已切换到 ' + meta.name);
    }

    function setResolution(value) {
        if (RESOLUTIONS.indexOf(value) < 0) return;
        root.HuanmengCore.saveSettings({ imgResolution: value });
        state.settings = readSettings();
        renderSettings();
        renderComposerMeta();
    }

    function toggleAutoPlace() {
        var ui = root.ZhuangStore.readUi();
        root.ZhuangStore.saveUi({ autoPlace: !ui.autoPlace });
        state.settings = readSettings();
        renderSettings();
        renderComposerMeta();
    }

    function toggleColorMatch() {
        var ui = root.ZhuangStore.readUi();
        root.ZhuangStore.saveUi({ autoColorMatch: !ui.autoColorMatch });
        state.settings = readSettings();
        renderSettings();
        renderComposerMeta();
    }

    async function chooseFolder() {
        try {
            var result = await root.ZhuangStore.chooseStorageFolder();
            if (!result) return;
            state.settings = readSettings();
            state.ui = root.ZhuangStore.readUi();
            renderSettings();
            toast('存储目录已更新');
        } catch (error) {
            if (isUserCancelled(error)) return;
            toast(friendlyError(error), 'error');
        }
    }

    function bindSettingsPage() {
        var host = $('page-settings');
        if (!host) return;
        host.addEventListener('click', function (event) {
            var settingsTabNode = event.target.closest('[data-settings-tab]');
            if (settingsTabNode) {
                var tabId = settingsTabNode.getAttribute('data-settings-tab');
                state.settingsTab = tabId;
                var tabNodes = host.querySelectorAll('[data-settings-tab]');
                for (var ti = 0; ti < tabNodes.length; ti++) {
                    tabNodes[ti].classList.toggle('is-active', tabNodes[ti].getAttribute('data-settings-tab') === tabId);
                }
                var sectionNodes = host.querySelectorAll('[data-settings-section]');
                for (var si = 0; si < sectionNodes.length; si++) {
                    sectionNodes[si].classList.toggle('is-active', sectionNodes[si].getAttribute('data-settings-section') === tabId);
                }
                var settingsScroller = host.querySelector('.page-scroll');
                if (settingsScroller) {
                    if (root.ZhuangScroll && root.ZhuangScroll.scrollToTop) root.ZhuangScroll.scrollToTop(settingsScroller);
                    else settingsScroller.scrollTop = 0;
                }
                return;
            }
            var themeNode = event.target.closest('[data-theme-option]');
            if (themeNode) {
                state.ui = Object.assign({}, state.ui, { theme: themeNode.getAttribute('data-theme-option') });
                root.ZhuangStore.saveUi({ theme: state.ui.theme });
                applyAppearance();
                renderSettings();
                toast('配色已切换');
                return;
            }
            var modelNode = event.target.closest('[data-model-value]');
            if (modelNode) {
                applyModel(modelNode.getAttribute('data-model-value'));
                return;
            }
            var resolutionNode = event.target.closest('[data-resolution]');
            if (resolutionNode) {
                setResolution(resolutionNode.getAttribute('data-resolution'));
                return;
            }
            var actionNode = event.target.closest('[data-action]');
            if (!actionNode) return;
            var action = actionNode.getAttribute('data-action');
            if (action === 'toggle-model') {
                state.modelPanelOpen = !state.modelPanelOpen;
                renderSettings();
            } else if (action === 'choose-folder') {
                chooseFolder();
            } else if (action === 'open-history') {
                setPage('history');
            } else if (action === 'add-preset') {
                openPresetModal(null);
            } else if (action === 'toggle-autoplace') {
                toggleAutoPlace();
            } else if (action === 'toggle-colormatch') {
                toggleColorMatch();
            } else if (action === 'save-connection') {
                saveAllConnection();
            } else if (action === 'apply-custom-model') {
                var customInput = $('customModelInput');
                var customModel = String(customInput && customInput.value || '').trim();
                if (!customModel) {
                    toast('先填一个模型名');
                    return;
                }
                var currentProvider = providerForModel(state.settings.model).id;
                var nextValue = customModel.indexOf('/') > -1
                    ? customModel
                    : currentProvider + '/' + customModel;
                applyModel(nextValue);
            }
        });
    }

    /* ---------------- 弹窗 ---------------- */

    function showModal(innerHtml) {
        var modal = $('modalRoot');
        if (!modal) return;
        modal.innerHTML = innerHtml;
        modal.classList.add('is-open');
        document.body.classList.add('has-modal');
        root.ZhuangIcons.hydrate(modal);
    }

    function closeModal() {
        var modal = $('modalRoot');
        if (!modal) return;
        modal.classList.remove('is-open');
        modal.innerHTML = '';
        document.body.classList.remove('has-modal');
        state.modalType = '';
        state.editingPresetId = '';
        state.confirmOptions = null;
        state.viewer = null;
    }

    function openPresetModal(preset) {
        state.modalType = 'preset';
        state.editingPresetId = preset ? preset.id : '';
        var title = preset ? '编辑预设' : '新建预设';
        var desc = preset ? '改完会同步到幻梦圆环。' : '存进幻梦圆环的分类里，两边共用。';
        var name = preset ? preset.name : '';
        var prompt = preset ? preset.prompt : (state.prompt || '');
        var category = preset ? preset.category : (state.presetCategory || '未分类');
        var html = '<div class="modal-card">' +
            '<div class="modal-head"><div><div class="modal-title">' + title + '</div>' +
            '<div class="modal-desc">' + desc + '</div></div>' +
            '<div class="modal-close" data-modal-close role="button" tabindex="0">' + root.ZhuangIcons.svg('close') + '</div></div>' +
            '<div class="modal-body">' +
            '<div class="field"><div class="field-label"><span>名字</span><span class="field-note">最多 20 字</span></div>' +
            '<input class="input" id="presetNameInput" type="text" maxlength="20" placeholder="例如：室内自然光" value="' + escapeHtml(name) + '"></div>' +
            '<div class="field"><div class="field-label"><span>分类</span><span class="field-note">填圆环里的分类</span></div>' +
            '<input class="input" id="presetCategoryInput" type="text" maxlength="30" placeholder="例如：脸部/眼部" value="' + escapeHtml(category) + '"></div>' +
            '<div class="field"><div class="field-label"><span>提示词</span><span class="field-note">最多 1000 字</span></div>' +
            '<textarea class="input" id="presetPromptInput" maxlength="1000" placeholder="写下你常用的修图要求">' + escapeHtml(prompt) + '</textarea></div>' +
            '</div>' +
            '<div class="modal-foot"><div class="btn btn-ghost" data-modal-close>取消</div>' +
            '<div class="btn btn-primary" data-modal-action="save-preset">保存预设</div></div>' +
            '</div>';
        showModal(html);
        setTimeout(function () {
            var nameInput = $('presetNameInput');
            if (nameInput) {
                try { nameInput.focus(); } catch (ignore) {}
            }
        }, 40);
    }

    function openConfirm(options) {
        state.modalType = 'confirm';
        state.confirmOptions = options || {};
        var html = '<div class="modal-card">' +
            '<div class="modal-head"><div><div class="modal-title">' + escapeHtml(options.title || '确认操作') + '</div>' +
            '<div class="modal-desc">' + escapeHtml(options.desc || '这个操作不能撤销。') + '</div></div>' +
            '<div class="modal-close" data-modal-close role="button" tabindex="0">' + root.ZhuangIcons.svg('close') + '</div></div>' +
            '<div class="modal-foot"><div class="btn btn-ghost" data-modal-close>取消</div>' +
            '<div class="btn ' + (options.danger ? 'btn-danger' : 'btn-primary') + '" data-modal-action="confirm">' +
            escapeHtml(options.confirmText || '确定') + '</div></div></div>';
        showModal(html);
    }

    async function savePresetFromModal() {
        var name = ($('presetNameInput') || {}).value || '';
        var category = ($('presetCategoryInput') || {}).value || '';
        var prompt = ($('presetPromptInput') || {}).value || '';
        try {
            if (state.editingPresetId) {
                root.ZhuangStore.updatePreset(state.editingPresetId, { name: name, category: category, prompt: prompt });
                toast('预设已更新');
            } else {
                root.ZhuangStore.addPreset({ name: name, category: category, prompt: prompt });
                toast('预设已添加');
            }
            closeModal();
            state.presets = root.ZhuangStore.allPresets();
            renderQuickPresets();
            renderComposerMeta();
            if (state.page === 'settings') renderSettings();
            if (state.page === 'presets') renderPresets();
            pushRingState();
        } catch (error) {
            toast(friendlyError(error), 'error');
        }
    }

    function bindModal() {
        var modal = $('modalRoot');
        if (!modal) return;
        modal.addEventListener('click', function (event) {
            if (event.target === modal) {
                closeModal();
                return;
            }
            var closeNode = event.target.closest('[data-modal-close]');
            if (closeNode) {
                closeModal();
                return;
            }
            var categoryNode = event.target.closest('[data-preset-category]');
            if (categoryNode) {
                state.presetCategory = categoryNode.getAttribute('data-preset-category') || '';
                closeModal();
                renderPresets();
                return;
            }
            var actionNode = event.target.closest('[data-modal-action]');
            if (actionNode) {
                var action = actionNode.getAttribute('data-modal-action');
                if (action === 'save-preset') {
                    savePresetFromModal();
                    return;
                }
                if (action === 'confirm' && state.confirmOptions && typeof state.confirmOptions.onConfirm === 'function') {
                    var handler = state.confirmOptions.onConfirm;
                    closeModal();
                    Promise.resolve(handler()).catch(function (error) {
                        toast(friendlyError(error), 'error');
                    });
                }
                return;
            }
            var viewerNode = event.target.closest('[data-viewer-action]');
            if (viewerNode) {
                handleViewerAction(viewerNode.getAttribute('data-viewer-action'));
            }
        });
    }

    /* ---------------- 全局事件 ---------------- */

    function bindGlobal() {
        document.addEventListener('click', function (event) {
            var pageNode = event.target.closest('.rail-item[data-page], .brand[data-page]');
            if (pageNode) {
                setPage(pageNode.getAttribute('data-page'));
            }
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                var modal = $('modalRoot');
                if (modal && modal.classList.contains('is-open')) {
                    closeModal();
                    return;
                }
                var popover = $('countPopover');
                if (popover && !popover.classList.contains('hidden')) {
                    popover.classList.add('hidden');
                    return;
                }
                var drawer = $('presetDrawer');
                if (drawer && !drawer.classList.contains('hidden')) {
                    togglePresetDrawer(false);
                }
                return;
            }
            if (event.key !== 'Enter' && event.key !== ' ') return;
            var target = event.target;
            if (!target || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
            var pressable = target.closest('[role="button"]');
            if (!pressable) return;
            event.preventDefault();
            pressable.click();
        });

        window.addEventListener('beforeunload', function () {
            root.ZhuangStore.saveUi({ draft: state.prompt });
        });
    }

    /* ---------------- 启动 ---------------- */

    async function init() {
        root.ZhuangIcons.hydrate(document);
        state.ui = root.ZhuangStore.readUi();
        applyAppearance();
        state.settings = readSettings();
        state.imageCount = (state.ui && state.ui.imageCount) || 1;
        state.presets = root.ZhuangStore.allPresets();
        state.currentPresetId = state.ui.lastPresetId || '';
        if (state.currentPresetId && !root.ZhuangStore.findPreset(state.currentPresetId)) {
            state.currentPresetId = '';
        }
        state.prompt = state.ui.draft || '';
        var input = $('promptInput');
        if (input) input.value = state.prompt;

        bindComposer();
        bindGenerationTools();
        bindChat();
        bindHistoryPage();
        bindLogsPage();
        bindPresetsPage();
        bindSettingsPage();
        bindModal();
        bindGlobal();
        renderQuickPresets();
        renderComposerMeta();
        renderGenerationTools();
        startRingBridge();

        if (root.ZhuangLog) {
            root.ZhuangLog.info('系统', '插件启动', { version: '2.1.0' });
            root.ZhuangLog.subscribe(function () {
                if (state.page === 'logs') renderLogs();
            });
            window.addEventListener('error', function (event) {
                root.ZhuangLog.error('系统', '脚本异常', {
                    message: event.message || '未知错误',
                    source: event.filename || '',
                    line: event.lineno || 0
                });
            });
            window.addEventListener('unhandledrejection', function (event) {
                var reason = event.reason;
                root.ZhuangLog.error('系统', '未处理的 Promise 异常',
                    reason && reason.message ? reason.message : reason);
            });
        }

        if (root.ZhuangWorkspace && typeof root.ZhuangWorkspace.mount === 'function') {
            root.ZhuangWorkspace.mount({
                toast: toast,
                refreshContext: refreshContext,
                friendlyError: friendlyError,
                setPage: setPage
            });
        }

        await refreshContext();

        var startPage = 'create';
        if (root.ZHUANG_DEMO && root.ZhuangDemo && root.ZhuangDemo.startPage) {
            startPage = root.ZhuangDemo.startPage;
        }
        setPage(startPage);

        if (root.ZhuangDemo && root.ZhuangDemo.startResult) {
            addUserMessage('把背景换成雪山日落，保留人物和光线');
            var demoResult = root.ZhuangDemo.makeResult('把背景换成雪山日落，保留人物和光线', 'background', state.settings);
            demoResult.createdAt = Date.now() - 12000;
            state.results[demoResult.id] = demoResult;
            state.lastResult = demoResult;
            addResultMessage(demoResult);
            if (root.ZhuangDemo.startPage === 'create') setTimeout(scrollChatToBottom, 80);
        }

        if (root.ZhuangScroll) {
            refreshScrollSoon();
            setTimeout(scrollChatToBottom, 120);
            setTimeout(scrollChatToBottom, 450);
        }

        root.ZhuangApp = {
            state: state,
            setPage: setPage,
            applyPreset: applyPreset,
            runGeneration: runGeneration,
            refreshContext: refreshContext,
            toast: toast
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);
