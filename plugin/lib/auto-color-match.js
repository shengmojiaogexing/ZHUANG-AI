/* ============================================================
 * auto-color-match.js — 回图校色的「业务编排」
 *
 * 算法本身在 color-match.service.js（纯图像、无宿主依赖），
 * 这里只负责三件事：
 *   1. 回图落盘前的自动校色（带像素上限保护）
 *   2. 工具箱里的手动「融合校色」（读图层 → 读原画面 → 校正 → 写回）
 *   3. 「这次要不要校色」的纯判定（给 ComfyUI / 生图流程共用）
 *
 * 原始位置：
 *   index.js:2202-2352  calibrateReturnedImageDataUrl / maybeAutoColorMatchReturnedImage
 *                       / runManualColorMatch
 *   comfy-client.js:929-954  colorMatchPlan（纯判定）
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengColorMatchApply = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    function core() {
        if (root.HuanmengCore) return root.HuanmengCore;
        if (typeof require === 'function') {
            try { return require('../00-核心/core.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengCore 未加载');
    }

    function ps() {
        if (root.HuanmengPS) return root.HuanmengPS;
        if (typeof require === 'function') {
            try { return require('../00-核心/ps-host.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengPS 未加载');
    }

    function place() {
        if (root.HuanmengPlace) return root.HuanmengPlace;
        if (typeof require === 'function') {
            try { return require('../04-图片放回/place-image.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengPlace 未加载');
    }

    function engine() {
        var found = root.HuanmengColorMatch;
        if (found && typeof found.matchImageData === 'function') return found;
        if (typeof require === 'function') {
            // color-match.service.js 是 <script> 风格，API 挂在 window 上
            try { require('./color-match.service.js'); } catch (ignore) {}
            found = root.HuanmengColorMatch;
            if (found && typeof found.matchImageData === 'function') return found;
        }
        return found || null;
    }

    function normalizeMethod(method) {
        return method === 'reinhard' ? 'reinhard' : 'wavelet';
    }

    /**
     * 把回图校准到参考图的色彩。
     * referenceDataUrl 为空时退化成「统一转成 sRGB PNG」。
     *
     * @param {string} dataUrl 回图
     * @param {string} referenceDataUrl 原画面（可选）
     * @param {object|string} options { method, strength, ... } 或旧式方法名
     */
    async function calibrateReturnedImage(dataUrl, referenceDataUrl, options) {
        var colorApi = engine();
        if (!colorApi) return dataUrl;
        if (referenceDataUrl) {
            var opts = options && typeof options === 'object'
                ? Object.assign({}, options)
                : { method: normalizeMethod(options), strength: 100 };
            opts.method = normalizeMethod(opts.method);
            return colorApi.matchDataUrls(referenceDataUrl, dataUrl, opts);
        }
        return colorApi.normalizeToSrgbPng(dataUrl);
    }

    /**
     * 自动校色的判定与执行。
     *
     * 原插件 3.1.1 在「生成回图」阶段把自动校色整体关掉了
     * （maybeAutoColorMatchReturnedImage 里直接 return），
     * 但保留了完整实现；这里把它开放成可配置开关，默认关闭，保持原行为。
     *
     * options:
     *   enabled      是否启用（默认 false，与 3.1.1 一致）
     *   method       'wavelet' | 'reinhard'
     *   strength     0-100
     *   reference    原画面 data URL
     *   settings     { autoColorMatchEnabled, autoColorMatchMethod }
     *   maxPixels    自动校色的像素上限（默认 200 万）
     */
    async function autoColorMatchReturnedImage(dataUrl, options) {
        var opts = options || {};
        var settings = opts.settings || core().getSettings();
        if (opts.enabled === false) return { dataUrl: dataUrl, applied: false, reason: 'off' };
        if (settings.autoColorMatchEnabled === false) return { dataUrl: dataUrl, applied: false, reason: 'settings-off' };

        var colorApi = engine();
        if (!colorApi) return { dataUrl: dataUrl, applied: false, reason: 'engine-missing' };

        var reference = opts.reference || '';
        var maxPixels = Number(opts.maxPixels) > 0 ? Number(opts.maxPixels) : 2000000;
        try {
            var info = typeof colorApi.inspectDataUrl === 'function'
                ? await colorApi.inspectDataUrl(dataUrl) : null;
            var pixels = (info && Number(info.pixels)) || 0;
            if (pixels > maxPixels) {
                return {
                    dataUrl: dataUrl,
                    applied: false,
                    reason: 'too-large',
                    pixels: pixels,
                    message: '回图 ' + info.width + '×' + info.height + ' 超过自动校色安全上限（200 万像素）'
                };
            }
            var method = normalizeMethod(opts.method || settings.autoColorMatchMethod);
            var result = await calibrateReturnedImage(dataUrl, reference, {
                method: method,
                strength: 100,
                // 大图关掉对位与共用遮罩，避免 36 遍全图模糊拖死面板
                alignmentEnabled: pixels > 0 && pixels <= 800000,
                sharedMaskEnabled: pixels > 0 && pixels <= 800000,
                featherRadius: 12,
                alignmentMaxOffset: 80
            });
            return { dataUrl: result, applied: true, reason: '', pixels: pixels, method: method };
        } catch (error) {
            return {
                dataUrl: dataUrl,
                applied: false,
                reason: 'failed',
                message: error && error.message ? error.message : String(error)
            };
        }
    }

    /**
     * 「这次要不要校色」的纯判定，ComfyUI 与回图流程共用。
     * 返回 { apply, reason, pixels, options }。
     */
    function colorMatchPlan(options) {
        var opts = options || {};
        if (opts.enabled !== true) return { apply: false, reason: 'off' };
        var bounds = opts.bounds || {};
        var width = Number(bounds.width);
        var height = Number(bounds.height);
        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
            return { apply: false, reason: 'no-bounds' };
        }
        return {
            apply: true,
            reason: '',
            pixels: Math.round(width) * Math.round(height),
            options: {
                method: normalizeMethod(opts.method),
                strength: 100,
                alignmentEnabled: true,
                sharedMaskEnabled: true,
                featherRadius: 12,
                alignmentMaxOffset: 80
            }
        };
    }

    /** 把判定结果翻译成一句人话（成功/失败/未执行都要说清楚）。 */
    function describeColorMatchOutcome(plan, outcome, method) {
        var label = normalizeMethod(method) === 'reinhard' ? 'Lab 整体校色' : '小波低频校色';
        if (!plan || !plan.apply) return { text: '', warn: false };
        if (!outcome) return { text: ' · 校色未回报结果', warn: true };
        if (outcome.applied) return { text: ' · 已' + label, warn: false };
        var reasonMap = {
            'no-reference': '读原画面失败',
            failed: outcome.message || '校色失败',
            'engine-missing': '校色引擎未加载'
        };
        return { text: ' · 未校色（' + (reasonMap[outcome.reason] || outcome.reason || '未知原因') + '）', warn: true };
    }

    /**
     * 工具箱里的手动「融合校色」。
     *
     * 把「当前 AI 回图图层」的颜色匹配到它下方原画面，并写回同一图层。
     * 没有参考图时会临时隐藏该图层，读一次合成结果作为参考。
     *
     * @returns {Promise<{success, method, strength, message}>}
     */
    async function matchActiveLayer(options) {
        var opts = options || {};
        var psApi = ps();
        var colorApi = engine();
        if (!colorApi) throw new Error('校色引擎未加载');
        if (!psApi.isAvailable()) throw new Error('Photoshop API 不可用，请在 Photoshop 中加载插件');

        var doc = psApi.getActiveDocument();
        var layer = doc && doc.activeLayers && doc.activeLayers[0];
        if (!doc || !layer) throw new Error('请先选择一个 AI 回图图层');

        var bounds = await psApi.getActiveLayerBounds();
        if (!bounds) throw new Error('无法读取当前图层范围');
        var method = normalizeMethod(opts.method);
        var strength = core().clamp(opts.strength == null ? 100 : opts.strength, 0, 100);

        // 已经采好样的快路径：直接在同尺寸像素上算，精度最高
        if (opts.outputFullSample && opts.referenceFullSample) {
            var referenceSample = opts.referenceFullSample;
            var outputSample = opts.outputFullSample;
            if (referenceSample.width !== outputSample.width || referenceSample.height !== outputSample.height) {
                referenceSample = psApi.resizeRgba(referenceSample, outputSample.width, outputSample.height);
            }
            var corrected = colorApi.matchImageData(referenceSample, outputSample, {
                method: method, strength: strength
            });
            await psApi.putImageDataToLayer(layer, corrected, bounds, doc.id);
            layer.name = '融合校色 · ' + (method === 'reinhard' ? 'Lab' : '小波低频') + ' · ' + Math.round(strength) + '%';
            return { success: true, method: method, strength: strength, message: '融合校色完成' };
        }

        // 1) 输出：当前图层自己的像素（不是合成结果 —— 否则透明区会把背景烤进来）
        var outputBase64 = await psApi.captureSelectionBase64(bounds, { layerId: layer.id, documentId: doc.id });
        if (!outputBase64) throw new Error('无法读取当前图层像素');

        // 2) 参考：没有就隐藏当前图层，读下方合成画面
        var reference = opts.referenceDataUrl || '';
        if (!reference) {
            var wasVisible = layer.visible !== false;
            await psApi.runInModal(async function () { layer.visible = false; }, '读取图层下方原画面');
            try {
                // 不传 layerId = 读合成结果（此时该图层已被隐藏）
                var composite = await psApi.captureSelectionBase64(bounds, { documentId: doc.id });
                reference = composite ? 'data:image/png;base64,' + composite : '';
            } finally {
                await psApi.runInModal(async function () { layer.visible = wasVisible; }, '恢复活动图层');
            }
        }
        if (!reference) throw new Error('没有可用的原图参考；请先读取选区或确保图层下方有画面');

        // 3) 校正 + 写回
        var correctedUrl = await calibrateReturnedImage(
            'data:image/png;base64,' + outputBase64,
            reference,
            { method: method, strength: strength }
        );
        await place().placeImageAtBounds(
            correctedUrl,
            bounds,
            '融合校色 · ' + (method === 'reinhard' ? 'Lab' : '小波低频') + ' · ' + Math.round(strength) + '%',
            doc.id,
            { commandName: '精确回写融合校色' }
        );
        return { success: true, method: method, strength: strength, message: '融合校色完成' };
    }

    return {
        normalizeMethod: normalizeMethod,
        calibrateReturnedImage: calibrateReturnedImage,
        autoColorMatchReturnedImage: autoColorMatchReturnedImage,
        colorMatchPlan: colorMatchPlan,
        describeColorMatchOutcome: describeColorMatchOutcome,
        matchActiveLayer: matchActiveLayer
    };
});
