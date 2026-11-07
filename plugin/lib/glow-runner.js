/* ============================================================
 * glow-runner.js — 辉光的「读图 → 算 → 回写」流程
 *
 * 算法在 glow-engine.js（纯 CPU、纯 ImageData，不碰 PS）。
 * 这里只做：
 *   1. 收集/归一化面板参数
 *   2. 抓取选区像素（默认 720px 代理，辉光是低频层，回写时再精确放大）
 *   3. 调引擎算出辉光层
 *   4. 以「屏幕」混合写回一个新像素图层
 *
 * 原插件没用 placeEvent 放辉光：辉光是纯发光层，必须像素级对齐、
 * 且要精确混合模式，所以走 createPixelLayer + putPixels。
 *
 * 原始位置：index.js:5851-6070（collectGlowUiParams / placeRgbaImageDataIntoDoc /
 *           runGlowAction / 预览）
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengGlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    function ps() {
        if (root.HuanmengPS) return root.HuanmengPS;
        if (typeof require === 'function') {
            try { return require('../00-核心/ps-host.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengPS 未加载');
    }

    function engine() {
        if (root.GlowEngine) return root.GlowEngine;
        if (typeof require === 'function') {
            // glow-engine.js 是 <script> 风格，赋值到 window.GlowEngine；
            // Node 下 require 它再回读全局即可。
            try { require('./glow-engine.js'); } catch (ignore) {}
            if (root.GlowEngine) return root.GlowEngine;
        }
        throw new Error('GlowEngine 未加载');
    }

    /**
     * 默认参数 = 面板初始值。
     * 引擎真正读的是这些键（style/strength/radius/threshold/...），
     * 其中 colorHex/colorAmount 控制染色，star 系列 / streak 系列只在对应风格下生效。
     */
    var DEFAULTS = {
        style: 'shine',          // shine | starburst | anamorphic | none
        strength: 47,
        radius: 81,
        threshold: 81,
        saturation: 0,
        brightnessBias: 0,
        colorShift: 0,
        colorHex: '#ffd27a',
        colorAmount: 0,
        colorEnabled: true,
        chromatic: 0,
        chromaticEnabled: true,
        starLength: 58,
        starCount: 6,
        starRotation: 0,
        starVisible: 68,
        streakLength: 86,
        streakVisible: 62
    };

    function normalizeParams(params) {
        return Object.assign({}, DEFAULTS, params || {});
    }

    /** 只算预览，不写文档。返回 { previewImageData, glowLayerImageData, params }。 */
    function renderPreview(sourceImageData, params, isPreview) {
        return engine().createPreview(sourceImageData, normalizeParams(params), isPreview !== false);
    }

    /**
     * 把辉光应用到 Photoshop 新图层。
     *
     * options:
     *   params     辉光参数（见 DEFAULTS）
     *   bounds     目标范围；不传则选区优先、其次整幅画布
     *   documentId 目标文档
     *   maxDimension 计算用的代理尺寸（默认 720；越大越清晰也越慢）
     *   layerName  图层名
     *
     * @returns {Promise<{layer, bounds, params, proxy:{width,height}}>}
     */
    async function applyGlow(options) {
        var opts = options || {};
        var psApi = ps();
        if (!psApi.isAvailable()) throw new Error('Photoshop API 不可用，请在 Photoshop 中加载插件');

        // 1) 目标范围：选区优先，无选区用整幅画布
        var bounds = opts.bounds || await psApi.getTargetBounds();
        if (!bounds) throw new Error('请先打开文档或建立选区');

        // 2) 读宿主像素（代理尺寸），辉光是低频层，不必全分辨率算
        var maxDimension = Number(opts.maxDimension) > 0 ? Number(opts.maxDimension) : 720;
        var source = await psApi.captureImageData(bounds, { maxDimension: maxDimension });
        if (!source || !source.width) throw new Error('读取源画面失败');

        var params = normalizeParams(opts.params);

        // 3) CPU 引擎：源蒙版 + 多尺度模糊 + 光学层 + 保护性合成
        var result = engine().createPreview(source, params, false);
        var glowData = result.glowLayerImageData;

        // 4) 精确缩放到原选区并写回（屏幕混合）
        var layerName = opts.layerName || ('辉光 · ' + Math.round(params.strength) + '%');
        var layer = await psApi.createPixelLayerWithImage(
            glowData,
            bounds,
            layerName,
            opts.documentId,
            { blendMode: 'screen', commandName: '精确回写辉光图层' }
        );

        return {
            layer: layer,
            bounds: bounds,
            params: params,
            proxy: { width: source.width, height: source.height }
        };
    }

    /**
     * 把任意 RGBA（比如已算好的预览）作为「屏幕」图层写回。
     * 给「先预览、确认后再应用」的界面用。
     */
    async function applyGlowImageData(glowImageData, bounds, documentId, layerName) {
        return ps().createPixelLayerWithImage(
            glowImageData, bounds, layerName || '辉光', documentId,
            { blendMode: 'screen', commandName: '精确回写辉光图层' }
        );
    }

    return {
        DEFAULTS: DEFAULTS,
        normalizeParams: normalizeParams,
        renderPreview: renderPreview,
        applyGlow: applyGlow,
        applyGlowImageData: applyGlowImageData
    };
});
