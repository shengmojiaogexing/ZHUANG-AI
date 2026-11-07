/* ============================================================
 * ps-host.js — Photoshop UXP 宿主适配层
 *
 * 把「跟 Photoshop 打交道」的所有动作集中在这一个文件里：
 *   · 初始化 require('photoshop') / require('uxp')
 *   · executeAsModal 包装
 *   · 选区 / 画布 / 图层边界
 *   · 读像素（getPixels）→ RGBA
 *   · 写像素（putPixels）/ 新建像素图层 / 置入文件
 *   · 把 data URL 写成临时文件
 *
 * 拆出来的原因：上层（生图、对话、校色、辉光、超分）都要读写像素，
 * 但都不该各自记一遍 executeAsModal 不能嵌套、16bit 要强制 8bit 这些坑。
 *
 * 原始位置：
 *   index.js:554-563    psAPI 结构
 *   index.js:774-824    initCompatibility
 *   index.js:1983-2201  选区 / 像素读取 / 图层范围
 *   index.js:5197-5351  RGBA 转换、按范围抓图、编码
 *   index.js:5912-5983  新建像素图层并 putPixels
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengPS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    function core() {
        if (root.HuanmengCore) return root.HuanmengCore;
        if (typeof require === 'function') {
            try { return require('./core.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengCore 未加载');
    }

    var state = {
        uxp: null,
        app: null,
        core: null,
        action: null,
        imaging: null,
        constants: null,
        isAvailable: false,
        initialized: false,
        initError: null
    };

    /* ---------------- 初始化 ---------------- */

    /**
     * 加载 Photoshop 模块。可以重复调用，只真正执行一次。
     * 返回是否可用（在 H5 / 浏览器里会是 false）。
     */
    function init() {
        if (state.initialized) return state.isAvailable;
        state.initialized = true;
        try {
            if (typeof require !== 'function') throw new Error('当前环境没有 require（不是 UXP 宿主）');
            var photoshop = require('photoshop');
            state.uxp = require('uxp');
            state.app = photoshop.app;
            state.core = photoshop.core;
            state.action = photoshop.action;
            state.imaging = photoshop.imaging;
            state.constants = photoshop.constants;
            state.isAvailable = !!(state.app && state.core);
        } catch (error) {
            state.initError = error;
            state.isAvailable = false;
        }
        return state.isAvailable;
    }

    function isAvailable() {
        return init();
    }

    function getError() {
        return state.initError;
    }

    function modules() {
        init();
        return state;
    }

    function requireAvailable() {
        if (!init()) {
            throw new Error('Photoshop API 不可用。请在 Photoshop 的 UXP 面板中运行，或检查 require("photoshop") 是否被宿主放行。');
        }
        return state;
    }

    /* ---------------- modal ---------------- */

    /**
     * 在 executeAsModal 中执行。
     * 注意：executeAsModal 不能嵌套；在 modal 内部需要再读像素时，
     * 先把参数准备好，回到外层再调用本函数。
     *
     * 另外把所有 modal 串成一条队列：预览抓图、工具动作、回贴可能在同一帧
     * 先后触发，两个 executeAsModal 重叠会让 Photoshop 报
     * “saveDocumentSelection may modify the state of Photoshop...”。
     */
    var modalChain = Promise.resolve();

    function runInModal(fn, commandName) {
        var host = requireAvailable();
        var run = function () {
            return host.core.executeAsModal(fn, { commandName: commandName || '幻梦 AI' });
        };
        var result = modalChain.then(run, run);
        modalChain = result.then(function () {}, function () {});
        return result;
    }

    /* ---------------- 文档 / 范围 ---------------- */

    function getActiveDocument() {
        var host = requireAvailable();
        return host.app.activeDocument || null;
    }

    function getDocumentById(documentId) {
        var host = requireAvailable();
        var id = Number(documentId);
        if (!isFinite(id)) return host.app.activeDocument || null;
        var documents = host.app.documents || [];
        for (var i = 0; i < documents.length; i++) {
            if (Number(documents[i].id) === id) return documents[i];
        }
        return null;
    }

    function normalizeBounds(raw) {
        if (!raw) return null;
        var left = core().toNumber(raw.left);
        var top = core().toNumber(raw.top);
        var right = core().toNumber(raw.right);
        var bottom = core().toNumber(raw.bottom);
        if (![left, top, right, bottom].every(isFinite) || right <= left || bottom <= top) return null;
        return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
    }

    /**
     * 当前选区像素范围；没有选区返回 null。
     *
     * 注意：新版 Photoshop 读 doc.selection.bounds 时会在内部触发
     * saveDocumentSelection（保存选区状态）。这个事件只允许发生在
     * executeAsModal 的作用域内，否则会弹
     * “saveDocumentSelection may modify the state of Photoshop...”。
     * 所以选区读取也必须进 modal，不能只包像素读取。
     */
    async function getSelectionBounds() {
        var host = requireAvailable();
        return runInModal(async function () {
            // 优先用 DOM。原项目一直走这条，兼容性最好。
            try {
                var doc = state.app.activeDocument;
                var selection = doc && doc.selection;
                var bounds = selection && selection.bounds;
                if (bounds) {
                    // UXP 在不同版本里可能返回普通数字或 UnitValue（{ _value, _unit }）。
                    // 直接 Number(UnitValue) 会得到 NaN，表现就是“明明有选区却总用整幅画布”。
                    var domBounds = normalizeBounds({
                        left: core().toNumber(bounds.left),
                        top: core().toNumber(bounds.top),
                        right: core().toNumber(bounds.right),
                        bottom: core().toNumber(bounds.bottom)
                    });
                    if (domBounds) return domBounds;
                }
            } catch (error) {
                core().log('[ps-host] DOM 读取选区失败，尝试 batchPlay:', error);
            }

            // 某些版本里 doc.selection.bounds 在有选区时也会返回 null
            //（尤其是切换过文档、或刚执行完“选择主体”之后）。再试一次 batchPlay，
            // 避免整幅画布被当成回图范围。
            try {
                var result = await host.action.batchPlay([{
                    _obj: 'get',
                    _target: [{ _property: 'bounds' }, { _ref: 'selection' }]
                }], { synchronousExecution: true });
                var first = result && result[0];
                var raw = first && (first.bounds || first.selectionBounds || first);
                return raw ? normalizeBounds({
                    left: core().toNumber(raw.left),
                    top: core().toNumber(raw.top),
                    right: core().toNumber(raw.right),
                    bottom: core().toNumber(raw.bottom)
                }) : null;
            } catch (batchError) {
                return null;
            }
        }, '读取选区范围');
    }

    /** 无选区时用整幅画布作为范围。 */
    async function getCanvasBounds() {
        var doc = getActiveDocument();
        if (!doc) return null;
        var width = core().toNumber(doc.width);
        var height = core().toNumber(doc.height);
        if (!width || !height) return null;
        return { left: 0, top: 0, right: width, bottom: height, width: width, height: height };
    }

    /** 选区优先，其次整幅画布。 */
    async function getTargetBounds() {
        var bounds = await getSelectionBounds();
        return bounds || await getCanvasBounds();
    }

    async function getActiveLayerBounds() {
        var host = requireAvailable();
        return runInModal(async function () {
            var result = await host.action.batchPlay([{
                _obj: 'get',
                _target: [{ _property: 'boundsNoEffects' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
            }], { synchronousExecution: true, modalBehavior: 'execute' });
            var raw = result && result[0] && (result[0].boundsNoEffects || result[0].bounds);
            return normalizeBounds({
                left: core().toNumber(raw && raw.left),
                top: core().toNumber(raw && raw.top),
                right: core().toNumber(raw && raw.right),
                bottom: core().toNumber(raw && raw.bottom)
            });
        }, '读取活动图层范围');
    }

    async function deselectAll() {
        if (!init()) return;
        try {
            await runInModal(async function () {
                var doc = state.app.activeDocument;
                if (doc && doc.selection) await doc.selection.deselect();
            }, '取消选区');
        } catch (ignore) {}
    }

    function selectDocument(documentId) {
        var host = requireAvailable();
        var doc = getDocumentById(documentId);
        if (!doc) throw new Error('目标文档已关闭');
        if (!host.app.activeDocument || Number(host.app.activeDocument.id) !== Number(doc.id)) {
            return host.action.batchPlay([{
                _obj: 'select',
                _target: [{ _ref: 'document', _id: doc.id }]
            }], { synchronousExecution: true });
        }
        return Promise.resolve();
    }

    /* ---------------- 读像素 ---------------- */

    function isSixteenBitDocument() {
        var host = state;
        if (!host.app || !host.constants) return false;
        var raw = host.app.activeDocument && host.app.activeDocument.bitsPerChannel;
        if (raw && typeof raw === 'object' && raw._value !== undefined) raw = raw._value;
        var sixteen = host.constants && host.constants.BitsPerChannelType && host.constants.BitsPerChannelType.SIXTEEN;
        if (raw === sixteen) return true;
        if (typeof raw === 'number') return raw === 16;
        var text = String(raw || '').toUpperCase();
        return text === '16' || text.indexOf('SIXTEEN') > -1;
    }

    function disposeImageData(imageData) {
        if (imageData && typeof imageData.dispose === 'function') {
            try { imageData.dispose(); } catch (ignore) {}
        }
    }

    /** UXP 的 pixel buffer → { width, height, data: Uint8ClampedArray(RGBA) }。 */
    function rgbaFromBuffer(rawData, width, height, components) {
        var pixelCount = Math.max(1, width * height);
        var source = rawData instanceof Uint8Array
            ? rawData
            : (rawData && rawData.buffer instanceof ArrayBuffer
                ? new Uint8Array(rawData.buffer, rawData.byteOffset || 0, rawData.byteLength || rawData.buffer.byteLength)
                : new Uint8Array(rawData || 0));
        var channels = Math.max(1, Number(components) || Math.round(source.length / pixelCount) || 4);
        var rgba = new Uint8ClampedArray(pixelCount * 4);
        if (channels === 4 && source.length >= rgba.length) {
            rgba.set(source.subarray(0, rgba.length));
        } else {
            for (var pixel = 0; pixel < pixelCount; pixel++) {
                var src = pixel * channels;
                var dst = pixel * 4;
                if (channels === 1) {
                    rgba[dst] = source[src] || 0;
                    rgba[dst + 1] = source[src] || 0;
                    rgba[dst + 2] = source[src] || 0;
                } else {
                    rgba[dst] = source[src] || 0;
                    rgba[dst + 1] = source[src + 1] || 0;
                    rgba[dst + 2] = source[src + 2] || 0;
                }
                rgba[dst + 3] = channels > 3 ? (source[src + 3] || 0) : 255;
            }
        }
        return { width: width, height: height, data: rgba };
    }

    /**
     * 读取指定范围（可指定图层/文档）的像素，可选按最长边缩放。
     * 返回 { width, height, data(RGBA), scale }。
     *
     * 为什么用 getPixels 而不是 canvas：UXP 里 new Image() 解不了几 MB 的
     * data URL（naturalWidth 为 0），宿主像素是唯一可靠来源。
     */
    async function captureImageData(bounds, options) {
        var host = requireAvailable();
        var opts = options || {};
        var normalized = normalizeBounds(bounds);
        if (!normalized) throw new Error('画面范围无效');

        var sourceWidth = Math.max(1, Math.round(normalized.width));
        var sourceHeight = Math.max(1, Math.round(normalized.height));
        var limit = Math.max(1, Number(opts.maxDimension) || Math.max(sourceWidth, sourceHeight));
        var scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
        var targetWidth = Math.max(1, Math.round(sourceWidth * scale));
        var targetHeight = Math.max(1, Math.round(sourceHeight * scale));

        var documentId = Number(opts.documentId);
        if (!isFinite(documentId)) {
            if (!host.app.activeDocument) throw new Error('没有活动文档');
            documentId = host.app.activeDocument.id;
        }
        var layerId = Number(opts.layerId);

        return runInModal(async function () {
            var imageData = null;
            try {
                var request = {
                    documentID: documentId,
                    sourceBounds: {
                        left: normalized.left, top: normalized.top,
                        right: normalized.right, bottom: normalized.bottom
                    },
                    targetSize: { width: targetWidth, height: targetHeight },
                    colorSpace: 'RGB',
                    colorProfile: 'sRGB IEC61966-2.1',
                    componentSize: 8,
                    applyAlpha: true
                };
                if (isFinite(layerId)) request.layerID = layerId;
                var result = await host.imaging.getPixels(request);
                imageData = result && result.imageData;
                if (!imageData || typeof imageData.getData !== 'function') throw new Error('Photoshop 未返回可读像素');
                var raw = await imageData.getData({ chunky: true });
                var width = Math.max(1, Number(imageData.width) || targetWidth);
                var height = Math.max(1, Number(imageData.height) || targetHeight);
                var output = rgbaFromBuffer(raw, width, height, imageData.components);
                output.scale = width / sourceWidth;
                return output;
            } finally {
                disposeImageData(imageData);
            }
        }, isFinite(layerId) ? '读取图层像素' : '读取画面像素');
    }

    /**
     * 像素 → base64（不带 data: 前缀）。16bit 会自动降级重试。
     *
     * options:
     *   layerId     读指定图层（不传 = 合成结果）
     *   documentId  指定文档（不传 = 活动文档）
     *   maxDimension 可选：按最长边缩到该像素内再编码（抓参考图用）
     *
     * 注意：读「图层自己」和读「合成结果」是两件事。
     * 校色取样必须用 layerId，否则会把底下背景一起烤进去。
     */
    async function captureSelectionBase64(bounds, options) {
        var host = requireAvailable();
        var opts = options || {};
        var target = bounds || await getSelectionBounds();
        if (!target) throw new Error('没有可用选区');

        var layerId = Number(opts.layerId);
        var documentId = Number(opts.documentId);
        if (!isFinite(documentId) && host.app.activeDocument) documentId = host.app.activeDocument.id;

        // 可选：最长边降采样。让 Photoshop 在读像素时直接缩放，
        // 大画布不用先读全尺寸再编码/解码，抓参考图会快很多。
        var sourceWidth = Math.max(0, Number(target.right) - Number(target.left) || 0);
        var sourceHeight = Math.max(0, Number(target.bottom) - Number(target.top) || 0);
        var limit = Math.max(0, Number(opts.maxDimension) || 0);
        var maxSide = Math.max(sourceWidth, sourceHeight);
        var scale = limit > 0 && maxSide > limit ? limit / maxSide : 1;
        var targetWidth = Math.max(1, Math.round(sourceWidth * scale));
        var targetHeight = Math.max(1, Math.round(sourceHeight * scale));

        function buildRequest(forceSrgb) {
            var request = {
                sourceBounds: { left: target.left, top: target.top, right: target.right, bottom: target.bottom },
                applyAlpha: true,
                componentSize: 8
            };
            if (scale < 1) request.targetSize = { width: targetWidth, height: targetHeight };
            if (isFinite(documentId)) request.documentID = documentId;
            if (isFinite(layerId)) request.layerID = layerId;
            if (forceSrgb) {
                request.colorSpace = 'RGB';
                request.colorProfile = 'sRGB IEC61966-2.1';
            }
            return request;
        }

        return runInModal(async function () {
            var imageData = null;
            var six = isSixteenBitDocument();
            try {
                imageData = await host.imaging.getPixels(buildRequest(false))
                    .then(function (result) { return result && result.imageData; });
                if (!imageData) throw new Error('Photoshop 未返回可读像素');
                var encoded = await host.imaging.encodeImageData({ imageData: imageData, base64: true, quality: 100 });
                return String(encoded || '').replace(/^data:image\/\w+;base64,/, '');
            } catch (error) {
                if (!six) throw error;
                // 16bit 文档：强制 RGB/sRGB 8bit 再试一次
                disposeImageData(imageData);
                imageData = await host.imaging.getPixels(buildRequest(true))
                    .then(function (result) { return result && result.imageData; });
                if (!imageData) throw new Error('Photoshop 未返回可读像素');
                var fallback = await host.imaging.encodeImageData({ imageData: imageData, base64: true, quality: 100 });
                return String(fallback || '').replace(/^data:image\/\w+;base64,/, '');
            } finally {
                disposeImageData(imageData);
            }
        }, isFinite(layerId) ? '读取图层像素' : '读取选区像素');
    }

    /**
     * RGBA → 小尺寸 JPEG data URL。
     * UXP 部分版本没有可用的 canvas.toDataURL，但 Photoshop 自己的
     * createImageDataFromBuffer + encodeImageData 一直可用。
     * 这是结果预览/历史缩略图在 UXP 下的可靠通道。
     */
    async function encodeRgbaToJpegDataUrl(imageData) {
        var host = requireAvailable();
        if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
            throw new Error('预览像素无效');
        }
        if (!host.imaging || typeof host.imaging.createImageDataFromBuffer !== 'function'
            || typeof host.imaging.encodeImageData !== 'function') {
            throw new Error('当前 Photoshop 不支持预览编码');
        }
        var width = Math.max(1, Math.round(Number(imageData.width)));
        var height = Math.max(1, Math.round(Number(imageData.height)));
        var source = imageData.data;
        var pixelCount = width * height;
        var rgbBytes = new Uint8Array(pixelCount * 3);
        for (var pixel = 0; pixel < pixelCount; pixel++) {
            rgbBytes[pixel * 3] = source[pixel * 4];
            rgbBytes[pixel * 3 + 1] = source[pixel * 4 + 1];
            rgbBytes[pixel * 3 + 2] = source[pixel * 4 + 2];
        }
        var photoshopImageData = null;
        try {
            photoshopImageData = await host.imaging.createImageDataFromBuffer(rgbBytes, {
                width: width,
                height: height,
                components: 3,
                chunky: true,
                colorSpace: 'RGB',
                colorProfile: 'sRGB IEC61966-2.1'
            });
            var encoded = await host.imaging.encodeImageData({
                imageData: photoshopImageData,
                base64: true
            });
            var payload = String(encoded || '').replace(/^data:image\/\w+;base64,/, '');
            if (!payload) throw new Error('Photoshop 未返回预览数据');
            return 'data:image/jpeg;base64,' + payload;
        } finally {
            disposeImageData(photoshopImageData);
        }
    }

    /** 从 Photoshop 抓一小块画面并直接编码成可显示的缩略图。 */
    async function capturePreviewDataUrl(bounds, options) {
        var opts = options || {};
        var rgba = await captureImageData(bounds, {
            maxDimension: opts.maxDimension || 720,
            documentId: opts.documentId,
            layerId: opts.layerId
        });
        return encodeRgbaToJpegDataUrl(rgba);
    }

    /* ---------------- 写像素 ---------------- */

    /** 把 RGBA 内存图写进指定图层（不新建图层）。 */
    async function putImageDataToLayer(layer, imageData, bounds, documentId) {
        var host = requireAvailable();
        var normalized = normalizeBounds(bounds);
        if (!normalized) throw new Error('回写范围无效');
        var width = Math.max(1, Math.round(normalized.width));
        var height = Math.max(1, Math.round(normalized.height));
        var resized = (Number(imageData && imageData.width) === width && Number(imageData && imageData.height) === height)
            ? imageData
            : resizeRgba(imageData, width, height);
        var bytes = new Uint8Array(resized.data.buffer, resized.data.byteOffset || 0, resized.data.byteLength);
        var docId = Number(documentId);
        if (!isFinite(docId)) docId = host.app.activeDocument && host.app.activeDocument.id;

        return runInModal(async function () {
            var photoshopImageData = null;
            try {
                photoshopImageData = await host.imaging.createImageDataFromBuffer(bytes, {
                    width: width, height: height, components: 4, chunky: true,
                    colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1'
                });
                await host.imaging.putPixels({
                    documentID: docId,
                    layerID: layer.id,
                    imageData: photoshopImageData,
                    replace: true,
                    targetBounds: { left: Math.round(normalized.left), top: Math.round(normalized.top) }
                });
                return layer;
            } finally {
                disposeImageData(photoshopImageData);
            }
        }, '回写图像像素');
    }

    /**
     * 新建像素图层并写入 RGBA。
     * options.blendMode = 'screen' 时同时设置屏幕混合（辉光用）。
     */
    async function createPixelLayerWithImage(imageData, bounds, layerName, documentId, options) {
        var host = requireAvailable();
        var opts = options || {};
        var normalized = normalizeBounds(bounds);
        if (!normalized) throw new Error('图像回写范围无效');
        var targetWidth = Math.max(1, Math.round(normalized.width));
        var targetHeight = Math.max(1, Math.round(normalized.height));
        var resized = (Number(imageData && imageData.width) === targetWidth && Number(imageData && imageData.height) === targetHeight)
            ? imageData
            : resizeRgba(imageData, targetWidth, targetHeight);
        var bytes = new Uint8Array(resized.data.buffer, resized.data.byteOffset || 0, resized.data.byteLength);
        var requestedId = Number(documentId);

        return runInModal(async function () {
            var targetDocument = isFinite(requestedId) ? getDocumentById(requestedId) : null;
            if (isFinite(requestedId) && !targetDocument) {
                throw new Error('预览绑定的 Photoshop 文档已关闭，为避免错贴已停止');
            }
            if (!targetDocument) targetDocument = host.app.activeDocument;
            if (!targetDocument) throw new Error('原 Photoshop 文档已关闭');

            var layer = null;
            var photoshopImageData = null;
            try {
                var useScreen = opts.blendMode === 'screen';
                var blendMode = useScreen && host.constants && host.constants.BlendMode
                    ? host.constants.BlendMode.SCREEN
                    : undefined;
                layer = typeof targetDocument.createPixelLayer === 'function'
                    ? await targetDocument.createPixelLayer({ name: layerName, blendMode: blendMode })
                    : await targetDocument.createLayer({ name: layerName, blendMode: blendMode });
                if (!layer) throw new Error('无法创建回写像素图层');
                photoshopImageData = await host.imaging.createImageDataFromBuffer(bytes, {
                    width: targetWidth, height: targetHeight, components: 4, chunky: true,
                    colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1'
                });
                await host.imaging.putPixels({
                    documentID: targetDocument.id,
                    layerID: layer.id,
                    imageData: photoshopImageData,
                    replace: true,
                    targetBounds: { left: Math.round(normalized.left), top: Math.round(normalized.top) }
                });
                if (useScreen) {
                    await host.action.batchPlay([{
                        _obj: 'set',
                        _target: [{ _ref: 'layer', _id: layer.id }],
                        to: {
                            _obj: 'layer',
                            mode: { _enum: 'blendMode', _value: 'screen' },
                            opacity: { _unit: 'percentUnit', _value: 100 }
                        }
                    }], { synchronousExecution: true });
                }
                layer.name = layerName;
                return layer;
            } catch (error) {
                if (layer) {
                    try { await layer.delete(); } catch (ignore) {}
                }
                throw error;
            } finally {
                disposeImageData(photoshopImageData);
            }
        }, opts.commandName || '精确回写图像图层');
    }

    /** 设置当前图层混合模式（'normal' / 'screen' ...）。 */
    async function setActiveLayerBlendMode(mode) {
        var host = requireAvailable();
        var value = String(mode || 'normal').toLowerCase();
        return runInModal(async function () {
            await host.action.batchPlay([{
                _obj: 'set',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: value } }
            }], { synchronousExecution: true, modalBehavior: 'execute' });
        }, '设置图层混合模式');
    }

    /**
     * 切换指定图层可见性。
     * 超分切片时用来「贴一块、藏一块」，避免下一块读源像素时读到已贴的结果。
     */
    async function setLayerVisible(layer, visible) {
        requireAvailable();
        if (!layer) return;
        return runInModal(async function () {
            layer.visible = visible !== false;
        }, visible === false ? '隐藏切片图层' : '恢复切片图层');
    }

    /* ---------------- 图层组 / 蒙版（回贴收尾用） ---------------- */

    function messageOf(error) {
        if (!error) return '';
        if (error.message) return String(error.message);
        return String(error);
    }

    /**
     * batchPlay 对「描述符本身无效」会 reject；对「目标不存在/命令无法执行」
     * 会 resolve 一个 {_obj:'error', message, result} 对象。统一转成异常，
     * 这样建组/蒙版流程才能感知失败并回退。
     */
    function checkBatchPlayErrors(result, fallbackMessage) {
        var first = result && result[0];
        if (!first) return result;
        if (first._obj === 'error' || (typeof first.result === 'number' && first.result !== 0)) {
            var error = new Error(first.message || fallbackMessage || 'Photoshop 命令执行失败');
            error.batchPlayResult = first.result;
            throw error;
        }
        return result;
    }

    /** 兼容 DOM Layer（.id）和 batchPlay 返回的图层/组描述符（.layerID / ._id）。 */
    function layerIdOf(target) {
        if (!target) return NaN;
        var raw = target.id;
        if (raw === undefined || raw === null) raw = target.layerID;
        if (raw === undefined || raw === null) raw = target._id;
        var id = Number(raw);
        return isFinite(id) ? id : NaN;
    }

    function collectionToArray(collection) {
        var list = [];
        if (!collection) return list;
        try {
            if (typeof collection.length === 'number') {
                for (var i = 0; i < collection.length; i++) list.push(collection[i]);
                return list;
            }
            if (typeof collection.forEach === 'function') {
                collection.forEach(function (item) { list.push(item); });
            }
        } catch (ignore) {}
        return list;
    }

    /**
     * 读图层/文档的子图层集合。
     * 返回 null 表示「读不出来」（老版本/对象已过期），空数组表示确实是空组——
     * 这个区别很重要：清理空组时不能把「读不出来」当成空。
     */
    function childLayersMaybe(node) {
        if (!node) return null;
        try {
            if (node.layers === undefined || node.layers === null) return null;
            return collectionToArray(node.layers);
        } catch (ignore) {
            return null;
        }
    }

    function childLayers(node) {
        return childLayersMaybe(node) || [];
    }

    /** 按 id 在文档里找 Layer（广度优先，带 guard 防止异常结构死循环）。 */
    function findLayerById(document, layerId) {
        var id = Number(layerId);
        if (!document || !isFinite(id)) return null;
        var roots;
        try { roots = collectionToArray(document.layers); } catch (ignore) { roots = []; }
        var stack = roots.slice();
        var guard = 0;
        while (stack.length > 0 && guard < 5000) {
            guard++;
            var current = stack.shift();
            if (!current) continue;
            if (Number(layerIdOf(current)) === id) return current;
            var children = childLayers(current);
            for (var i = 0; i < children.length; i++) stack.push(children[i]);
        }
        return null;
    }

    function layerParentOf(layer) {
        if (!layer) return null;
        try { return layer.parent || null; } catch (ignore) { return null; }
    }

    /** group 的直接子层里是否有 layerId。 */
    function groupContainsLayer(group, layerId) {
        var id = Number(layerId);
        if (!group || !isFinite(id)) return false;
        var children = childLayers(group);
        for (var i = 0; i < children.length; i++) {
            if (Number(layerIdOf(children[i])) === id) return true;
        }
        return false;
    }

    function readActiveLayer(document) {
        var doc = document || state.app.activeDocument;
        if (!doc) return null;
        try {
            var active = collectionToArray(doc.activeLayers);
            return active.length > 0 ? active[0] : null;
        } catch (ignore) {
            return null;
        }
    }

    /**
     * 读当前活动图层 id。
     * 优先 batchPlay get（刚执行完 select 时最可靠），读不到再退回 DOM。
     */
    async function readActiveLayerId(document) {
        var host = requireAvailable();
        try {
            var result = await host.action.batchPlay([{
                _obj: 'get',
                _target: [{ _property: 'layerID' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
            }], { synchronousExecution: true });
            var first = result && result[0];
            if (first && first._obj !== 'error') {
                var id = Number(first.layerID !== undefined ? first.layerID : first.layerId);
                if (isFinite(id)) return id;
            }
        } catch (ignore) {}
        var domId = layerIdOf(readActiveLayer(document));
        return isFinite(domId) ? domId : NaN;
    }

    /** 取目标文档：优先 documentId；否则活动文档；绑定的文档已关闭则抛错。 */
    function resolveDocument(documentId) {
        var id = Number(documentId);
        if (isFinite(id)) {
            var bound = getDocumentById(id);
            if (!bound) throw new Error('生成时绑定的 Photoshop 文档已关闭');
            return bound;
        }
        var active = getActiveDocument();
        if (!active) throw new Error('没有可用的 Photoshop 文档');
        return active;
    }

    /** 确保目标文档是前台文档（batchPlay 的 layer 引用默认落在活动文档上）。 */
    async function ensureActiveDocument(document) {
        var host = requireAvailable();
        if (!document) throw new Error('目标文档不可用');
        var active = host.app.activeDocument;
        if (active && Number(active.id) === Number(document.id)) return document;
        await host.action.batchPlay([{
            _obj: 'select',
            _target: [{ _ref: 'document', _id: document.id }]
        }], { synchronousExecution: true });
        var current = host.app.activeDocument;
        if (!current || Number(current.id) !== Number(document.id)) {
            throw new Error('无法切换到目标 Photoshop 文档');
        }
        return document;
    }

    /** 确认 candidate 就是「包含 layerId 的新组」；读不出子层时返回 null 表示不确定。 */
    function confirmedGroup(document, candidate, layerId) {
        if (!candidate) return null;
        var candidateId = layerIdOf(candidate);
        if (!isFinite(candidateId) || Number(candidateId) === Number(layerId)) return null;
        if (groupContainsLayer(candidate, layerId)) return candidate;
        var fresh = findLayerById(document, candidateId);
        if (groupContainsLayer(fresh, layerId)) return fresh;
        var source = findLayerById(document, layerId);
        var parent = layerParentOf(source);
        if (parent && Number(layerIdOf(parent)) === candidateId) return candidate;
        return null;
    }

    /** 在顶层按「组名 + 包含该图层」找组（batchPlay 建组后活动层不可靠时兜底）。 */
    function findGroupContaining(document, name, layerId) {
        var roots;
        try { roots = collectionToArray(document.layers); } catch (ignore) { roots = []; }
        for (var i = 0; i < roots.length; i++) {
            var current = roots[i];
            if (!current) continue;
            if (String(current.name || '') !== String(name || '')) continue;
            if (groupContainsLayer(current, layerId)) return current;
        }
        return null;
    }

    /**
     * 删除顶层里「刚建的空组」（建组成功但移入失败时的清理）。
     * 只删「确认子层可读且为空」的组，读不出子层的一律不碰，避免误删/误伤。
     */
    async function removeEmptyGroupByName(document, name) {
        var roots;
        try { roots = collectionToArray(document.layers); } catch (ignore) { roots = []; }
        for (var i = 0; i < roots.length && i < 5; i++) {
            var current = roots[i];
            if (!current) continue;
            if (String(current.name || '') !== String(name || '')) continue;
            var children = childLayersMaybe(current);
            if (!children || children.length > 0) continue;
            var id = layerIdOf(current);
            if (!isFinite(id)) continue;
            try {
                if (typeof current.delete === 'function') { current.delete(); return true; }
            } catch (ignore) {}
            try {
                await requireAvailable().action.batchPlay([{
                    _obj: 'delete',
                    _target: [{ _ref: 'layer', _id: id }]
                }], { synchronousExecution: true });
                return true;
            } catch (ignore) {}
        }
        return false;
    }

    /**
     * 把已放好的普通图层包进一个新图层组，返回组对象（DOM Layer），组名 = name。
     *
     * 为什么优先 DOM：UXP 的 Document.createLayerGroup({ fromLayers }) 从 PS 22.5
     * 起就支持「建组的同时把指定图层放进去」，一次调用完成，不需要
     * Layer.move(..., PLACEINSIDE)。后者在 UXP 上存在版本差异，社区多次报告
     * 会抛 “Cannot read properties of undefined (reading 'id')”，不能作为主路径。
     *
     * DOM 不可用/失败时退回 batchPlay 一次事件：
     *   { _obj:'make', _target:[{_ref:'layerSection'}],
     *     from:{_ref:'layer',_id:图层id},
     *     using:{_obj:'layerSection', name:组名} }
     * make 的 from 直接带上图层，同样避开 Layer.move。
     *
     * 返回值保证：要么图层在新建组里，要么抛错（此时图层尽量保持原样，
     * 组若已建但为空会被删掉）。调用方（place-image.js）失败时按普通图层继续。
     */
    async function createLayerGroupContaining(layer, name, documentId) {
        var host = requireAvailable();
        var layerId = layerIdOf(layer);
        if (!isFinite(layerId)) throw new Error('回贴图层 id 无效，无法建组');
        var groupName = name || 'ZHUANG-AI插件回图';

        return runInModal(async function () {
            var targetDocument = resolveDocument(documentId);
            await ensureActiveDocument(targetDocument);

            var sourceLayer = findLayerById(targetDocument, layerId);
            if (!sourceLayer) throw new Error('回贴图层已不存在，无法建组');

            // 幂等保护：已经在某个组里就不再包一层
            var parent = layerParentOf(sourceLayer);
            if (parent && isFinite(layerIdOf(parent))) return parent;

            var domError = null;
            if (typeof targetDocument.createLayerGroup === 'function') {
                try {
                    var domGroup = await targetDocument.createLayerGroup({
                        name: groupName,
                        fromLayers: sourceLayer
                    });
                    var domConfirmed = confirmedGroup(targetDocument, domGroup, layerId);
                    if (domConfirmed) return domConfirmed;
                    var domChildren = childLayersMaybe(domGroup);
                    if (domChildren && domChildren.length === 0) {
                        // 组建出来了但图层没被移进去：删掉空组，图层留在原处
                        await removeEmptyGroupByName(targetDocument, groupName);
                        domError = new Error('DOM 建组后图层未移入组');
                    } else if (domGroup && isFinite(layerIdOf(domGroup))) {
                        // 组对象有效、只是当前版本读不出子层集合：按成功处理，
                        // 避免再建一个组（后续蒙版/回退都有兜底）。
                        core().log('[ps-host] 建组后无法确认组内图层，按成功处理:', layerId);
                        return domGroup;
                    } else {
                        domError = new Error('DOM 建组未返回有效图层组');
                    }
                } catch (domFailure) {
                    domError = domFailure;
                }
            }

            // batchPlay 兜底
            try {
                var makeResult = await host.action.batchPlay([{
                    _obj: 'make',
                    _target: [{ _ref: 'layerSection' }],
                    from: { _ref: 'layer', _id: layerId },
                    using: { _obj: 'layerSection', name: groupName },
                    _isCommand: true,
                    _options: { dialogOptions: 'dontDisplay' }
                }], { synchronousExecution: true });
                checkBatchPlayErrors(makeResult, '创建图层组失败');
            } catch (makeError) {
                await removeEmptyGroupByName(targetDocument, groupName);
                throw new Error('创建回贴图层组失败：' + messageOf(makeError));
            }

            var activeId = await readActiveLayerId(targetDocument);
            var active = isFinite(activeId) ? findLayerById(targetDocument, activeId) : null;
            var group = confirmedGroup(targetDocument, active, layerId)
                || findGroupContaining(targetDocument, groupName, layerId);
            if (!group) {
                await removeEmptyGroupByName(targetDocument, groupName);
                var hint = domError ? '（DOM 失败：' + messageOf(domError) + '）' : '';
                throw new Error('创建回贴图层组失败：未确认图层已移入组' + hint);
            }
            return group;
        }, '创建回贴图层组');
    }

    /**
     * 读目标图层「是否有用户图层蒙版」。用于判断蒙版描述符是否真的生效。
     * 返回 true / false / null（null = 当前版本读不出来，不当作失败）。
     */
    async function readUserMaskState(layerId) {
        var host = requireAvailable();
        var id = Number(layerId);
        if (!isFinite(id)) return null;
        try {
            var result = await host.action.batchPlay([{
                _obj: 'multiGet',
                _target: {
                    _ref: [
                        { _ref: 'layer', _id: id },
                        { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }
                    ]
                },
                extendedReference: [['hasUserMask', 'userMaskEnabled']],
                options: { failOnMissingProperty: false, failOnMissingElement: false }
            }], { synchronousExecution: true });
            var first = result && result[0];
            if (!first || first._obj === 'error') return null;
            var values = [first.hasUserMask, first.userMaskEnabled];
            var definite = null;
            for (var i = 0; i < values.length; i++) {
                if (typeof values[i] === 'boolean') definite = definite === null ? values[i] : (definite || values[i]);
            }
            return definite;
        } catch (ignore) {
            return null;
        }
    }

    /**
     * 给图层或图层组添加「白色 reveal-all 图层蒙版」。
     *
     * UXP DOM 没有蒙版 API，只能走 batchPlay。PS 26 实测：用 make channel mask 会弹
     * 「命令“建立”当前不可用」，所以只用 ScriptListener 的「显示全部」set 写法：
     *   set _target=channel(selection) → to channel { userMask: revealAll }
     * 第一种写法去掉 color；若版本仍不接受再带一个 white color 兜底。
     * 蒙版描述符作用在「当前活动图层」上，所以调用前先把目标组选中并校验。
     * 全部失败抛错，由 place-image.js 回退成普通图层。
     *
     * @returns {Promise<{masked:boolean, method:string, verified:boolean}>}
     */
    async function addRevealAllMask(target, documentId) {
        var host = requireAvailable();
        var targetId = layerIdOf(target);
        if (!isFinite(targetId)) throw new Error('蒙版目标图层 id 无效');

        return runInModal(async function () {
            var targetDocument = resolveDocument(documentId);
            await ensureActiveDocument(targetDocument);

            try {
                await host.action.batchPlay([{
                    _obj: 'select',
                    _target: [{ _ref: 'layer', _id: targetId }],
                    makeVisible: false
                }], { synchronousExecution: true });
            } catch (selectError) {
                throw new Error('无法选中回贴图层组：' + messageOf(selectError));
            }
            var activeId = await readActiveLayerId(targetDocument);
            if (activeId !== targetId) {
                throw new Error('无法选中回贴图层组，未添加蒙版');
            }

            // 正确写法来自 ScriptListener 的「添加图层蒙版 → 显示全部（Reveal All）」：
            //   set channel(fsel) → to channel { userMask: revealAll }
            // 注意：不要用 make channel mask —— PS 26 会弹「命令“建立”当前不可用」，
            // 而且 make 的描述符在 UXP 里并不一定接受 kind=mask。
            var attempts = [
                {
                    label: 'set-channel-selection-reveal-all',
                    descriptor: {
                        _obj: 'set',
                        _target: [{ _ref: 'channel', _property: 'selection' }],
                        to: {
                            _obj: 'channel',
                            userMask: { _enum: 'userMask', _value: 'revealAll' }
                        },
                        _options: { dialogOptions: 'dontDisplay' }
                    }
                },
                {
                    label: 'set-channel-selection-reveal-all-color',
                    descriptor: {
                        _obj: 'set',
                        _target: [{ _ref: 'channel', _property: 'selection' }],
                        to: {
                            _obj: 'channel',
                            userMask: { _enum: 'userMask', _value: 'revealAll' },
                            color: { _enum: 'color', _value: 'white' }
                        },
                        _options: { dialogOptions: 'dontDisplay' }
                    }
                }
            ];

            var lastError = null;
            for (var i = 0; i < attempts.length; i++) {
                try {
                    var result = await host.action.batchPlay([attempts[i].descriptor], {
                        synchronousExecution: true
                    });
                    checkBatchPlayErrors(result, '添加图层蒙版失败');
                    var hasMask = await readUserMaskState(targetId);
                    if (hasMask === false) {
                        lastError = new Error('蒙版描述符被接受但未生成蒙版（' + attempts[i].label + '）');
                        continue;
                    }
                    return {
                        masked: true,
                        method: attempts[i].label,
                        verified: hasMask === true
                    };
                } catch (attemptError) {
                    lastError = attemptError;
                }
            }
            throw lastError || new Error('无法给回贴图层组添加蒙版');
        }, '添加回贴蒙版');
    }

    /** 删掉指定图层上的用户蒙版（回退用，失败静默）。 */
    async function deleteUserMaskOnLayer(host, layerId) {
        var id = Number(layerId);
        if (!host || !isFinite(id)) return false;
        try {
            await host.action.batchPlay([{
                _obj: 'select',
                _target: [{ _ref: 'layer', _id: id }],
                makeVisible: false
            }], { synchronousExecution: true });
            var result = await host.action.batchPlay([{
                _obj: 'delete',
                _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
                _options: { dialogOptions: 'dontDisplay' }
            }], { synchronousExecution: true });
            checkBatchPlayErrors(result, '删除图层蒙版失败');
            return true;
        } catch (ignore) {
            return false;
        }
    }

    /**
     * 回退：把已经放进组里的图层还原成普通图层。
     *
     * 做法：选中组 → 取消图层编组（子层提升到组原来的位置）；若组上有蒙版
     * 导致第一次失败，先删蒙版再重试一次。最后校验图层确实不在该组里。
     * 全程不抛错，返回是否回退成功（失败时调用方只能保留现状+记日志）。
     */
    async function ungroupPlacedLayer(layer, group, documentId) {
        var layerId = layerIdOf(layer);
        var groupId = layerIdOf(group);
        if (!isFinite(groupId)) return false;
        try {
            return await runInModal(async function () {
                var host = requireAvailable();
                var targetDocument = resolveDocument(documentId);
                await ensureActiveDocument(targetDocument);

                async function tryUngroup() {
                    await host.action.batchPlay([{
                        _obj: 'select',
                        _target: [{ _ref: 'layer', _id: groupId }],
                        makeVisible: false
                    }], { synchronousExecution: true });
                    var result = await host.action.batchPlay([{
                        _obj: 'ungroupLayersEvent',
                        _target: [{ _ref: 'layer', _id: groupId }],
                        _options: { dialogOptions: 'dontDisplay' }
                    }], { synchronousExecution: true });
                    checkBatchPlayErrors(result, '取消图层编组失败');
                }

                try {
                    await tryUngroup();
                } catch (firstError) {
                    await deleteUserMaskOnLayer(host, groupId);
                    try {
                        await tryUngroup();
                    } catch (retryError) {
                        core().log('[ps-host] 取消图层编组重试失败:', retryError);
                    }
                }

                // 校验：图层不在该组里了
                var freshLayer = findLayerById(targetDocument, layerId);
                var parent = layerParentOf(freshLayer);
                if (parent && Number(layerIdOf(parent)) === groupId) return false;
                // 组若还在（且为空）就顺手删掉
                var groupStill = findLayerById(targetDocument, groupId);
                if (groupStill) {
                    await removeEmptyGroupByName(targetDocument, String(groupStill.name || ''));
                }
                return true;
            }, '回退回贴图层组');
        } catch (error) {
            core().log('[ps-host] 回贴图层组回退失败，保留图层组:', error);
            return false;
        }
    }

    /* ---------------- 临时文件 / 置入 ---------------- */

    /** 把 data URL 写入 UXP 临时目录，返回 { file, ext, sessionToken() }。 */
    async function writeTempFileFromDataUrl(dataUrl, prefix) {
        var host = requireAvailable();
        var parts = core().dataUrlToParts(dataUrl);
        if (!parts) throw new Error('不是有效的 Base64 图像数据');
        if (!host.uxp || !host.uxp.storage) throw new Error('UXP storage 不可用');
        var ext = parts.mimeType.indexOf('jpeg') > -1 ? 'jpg'
            : parts.mimeType.indexOf('webp') > -1 ? 'webp' : 'png';
        var bytes = core().base64ToUint8Array(parts.base64);
        var fs = host.uxp.storage.localFileSystem;
        var folder = await fs.getTemporaryFolder();
        var file = await folder.createFile(
            (prefix || 'huanmeng') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.' + ext,
            { overwrite: true }
        );
        var binary = host.uxp.storage.formats && host.uxp.storage.formats.binary;
        await file.write(bytes, binary ? { format: binary } : undefined);
        return {
            file: file,
            ext: ext,
            mimeType: parts.mimeType,
            sessionToken: function () { return fs.createSessionToken(file); },
            cleanup: async function () { try { await file.delete(); } catch (ignore) {} }
        };
    }

    /** 用 placeEvent 把一个本地文件置入当前文档（不缩放）。 */
    async function placeFile(fileToken) {
        var host = requireAvailable();
        await host.action.batchPlay([{
            _obj: 'placeEvent',
            null: { _path: fileToken, _kind: 'local' },
            linked: false,
            freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
            offset: {
                _obj: 'offset',
                horizontal: { _unit: 'pixelsUnit', _value: 0 },
                vertical: { _unit: 'pixelsUnit', _value: 0 }
            }
        }], { synchronousExecution: true });
    }

    /** 读取当前活动图层的实际边界。 */
    async function readActiveLayerBoundsRaw() {
        var host = requireAvailable();
        var result = await host.action.batchPlay([{
            _obj: 'get',
            _target: [{ _property: 'boundsNoEffects' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
        }], { synchronousExecution: true });
        var raw = result && result[0] && (result[0].boundsNoEffects || result[0].bounds);
        if (!raw) throw new Error('无法读取置入图层范围');
        function value(input) {
            if (input && typeof input === 'object' && input._value !== undefined) return Number(input._value) || 0;
            return Number(input) || 0;
        }
        var left = value(raw.left), top = value(raw.top), right = value(raw.right), bottom = value(raw.bottom);
        return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
    }

    async function rasterizeActiveLayer() {
        var host = requireAvailable();
        await host.action.batchPlay([{
            _obj: 'rasterizeLayer',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
        }], { synchronousExecution: true });
    }

    /** 打开一个临时文件为文档（生成结果另开画布时用）。 */
    async function openFileAsDocument(file) {
        var host = requireAvailable();
        return runInModal(async function () {
            return host.app.open(file);
        }, '打开 AI 生成图像');
    }

    /* ---------------- 纯几何 ---------------- */

    /** 双线性缩放 RGBA。 */
    function resizeRgba(sourceImageData, targetWidth, targetHeight) {
        var sourceWidth = Math.max(1, Number(sourceImageData && sourceImageData.width) || 1);
        var sourceHeight = Math.max(1, Number(sourceImageData && sourceImageData.height) || 1);
        var width = Math.max(1, Math.round(targetWidth));
        var height = Math.max(1, Math.round(targetHeight));
        if (sourceWidth === width && sourceHeight === height) return sourceImageData;
        var source = sourceImageData.data;
        var output = new Uint8ClampedArray(width * height * 4);
        var xScale = sourceWidth / width;
        var yScale = sourceHeight / height;
        for (var y = 0; y < height; y++) {
            var sy = Math.max(0, Math.min(sourceHeight - 1, (y + 0.5) * yScale - 0.5));
            var y0 = Math.floor(sy);
            var y1 = Math.min(sourceHeight - 1, y0 + 1);
            var fy = sy - y0;
            for (var x = 0; x < width; x++) {
                var sx = Math.max(0, Math.min(sourceWidth - 1, (x + 0.5) * xScale - 0.5));
                var x0 = Math.floor(sx);
                var x1 = Math.min(sourceWidth - 1, x0 + 1);
                var fx = sx - x0;
                var p00 = (y0 * sourceWidth + x0) * 4;
                var p10 = (y0 * sourceWidth + x1) * 4;
                var p01 = (y1 * sourceWidth + x0) * 4;
                var p11 = (y1 * sourceWidth + x1) * 4;
                var dst = (y * width + x) * 4;
                for (var c = 0; c < 4; c++) {
                    var topPixel = source[p00 + c] + (source[p10 + c] - source[p00 + c]) * fx;
                    var bottomPixel = source[p01 + c] + (source[p11 + c] - source[p01 + c]) * fx;
                    output[dst + c] = Math.round(topPixel + (bottomPixel - topPixel) * fy);
                }
            }
        }
        return { width: width, height: height, data: output };
    }

    /** 等比内接矩形（放回时「不拉伸、居中」用）。 */
    function fitRectInside(sourceWidth, sourceHeight, targetBounds) {
        var tw = Number(targetBounds && targetBounds.width);
        var th = Number(targetBounds && targetBounds.height);
        if (!(tw > 0) || !(th > 0) || !(sourceWidth > 0) || !(sourceHeight > 0)) return null;
        var scale = Math.min(tw / sourceWidth, th / sourceHeight);
        var width = Math.round(sourceWidth * scale);
        var height = Math.round(sourceHeight * scale);
        var left = Number(targetBounds.left) + Math.round((tw - width) / 2);
        var top = Number(targetBounds.top) + Math.round((th - height) / 2);
        return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
    }

    /** 从 data URL 的图片头读出宽高（不依赖图片解码）。 */
    function getImageSizeFromDataUrl(dataUrl) {
        var parts = core().dataUrlToParts(dataUrl);
        if (!parts) return null;
        var bytes = core().base64ToUint8Array(parts.base64);
        try {
            if (bytes[0] === 0x89 && bytes[1] === 0x50) {
                var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                return { width: view.getUint32(16), height: view.getUint32(20) };
            }
            if (bytes[0] === 0xff && bytes[1] === 0xd8) {
                var offset = 2;
                while (offset + 9 < bytes.length) {
                    if (bytes[offset] !== 0xff) { offset++; continue; }
                    var marker = bytes[offset + 1];
                    var length = (bytes[offset + 2] << 8) + bytes[offset + 3];
                    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                        return {
                            height: (bytes[offset + 5] << 8) + bytes[offset + 6],
                            width: (bytes[offset + 7] << 8) + bytes[offset + 8]
                        };
                    }
                    offset += 2 + length;
                }
            }
            if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
                var webp = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                return { width: webp.getUint16(26, true), height: webp.getUint16(28, true) };
            }
        } catch (ignore) {}
        return null;
    }

    return {
        init: init,
        isAvailable: isAvailable,
        getError: getError,
        modules: modules,
        requireAvailable: requireAvailable,

        runInModal: runInModal,
        getActiveDocument: getActiveDocument,
        getDocumentById: getDocumentById,
        selectDocument: selectDocument,
        normalizeBounds: normalizeBounds,
        getSelectionBounds: getSelectionBounds,
        getCanvasBounds: getCanvasBounds,
        getTargetBounds: getTargetBounds,
        getActiveLayerBounds: getActiveLayerBounds,
        deselectAll: deselectAll,

        captureImageData: captureImageData,
        captureSelectionBase64: captureSelectionBase64,
        capturePreviewDataUrl: capturePreviewDataUrl,
        encodeRgbaToJpegDataUrl: encodeRgbaToJpegDataUrl,
        rgbaFromBuffer: rgbaFromBuffer,
        isSixteenBitDocument: isSixteenBitDocument,
        disposeImageData: disposeImageData,

        putImageDataToLayer: putImageDataToLayer,
        createPixelLayerWithImage: createPixelLayerWithImage,
        setActiveLayerBlendMode: setActiveLayerBlendMode,
        setLayerVisible: setLayerVisible,

        createLayerGroupContaining: createLayerGroupContaining,
        addRevealAllMask: addRevealAllMask,
        ungroupPlacedLayer: ungroupPlacedLayer,
        findLayerById: findLayerById,
        layerIdOf: layerIdOf,

        writeTempFileFromDataUrl: writeTempFileFromDataUrl,
        placeFile: placeFile,
        readActiveLayerBoundsRaw: readActiveLayerBoundsRaw,
        rasterizeActiveLayer: rasterizeActiveLayer,
        openFileAsDocument: openFileAsDocument,

        resizeRgba: resizeRgba,
        fitRectInside: fitRectInside,
        getImageSizeFromDataUrl: getImageSizeFromDataUrl
    };
});
