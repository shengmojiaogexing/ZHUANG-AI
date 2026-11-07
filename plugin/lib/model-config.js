/* ============================================================
 * model-config.js — 画幅 / 分辨率推导
 *
 * 输入「选区尺寸 + 用户选的档位」，输出该发给模型的
 * { width, height, aspectRatio, size, imageSize }。
 *
 * 这一层全是纯函数，不碰网络也不碰 PS，方便离线算预览框、
 * 也方便给超分/特效复用。
 *
 * 原始位置：index.js:1406-1639
 *   normalizeSupportedAspectRatio / normalizeXaiResolution
 *   getNanoBananaImageSize / normalizeSizeHint / getAspectRatioLabelByHint
 *   buildDimensionsFromAspect / getGptImageSizeByAspect / parseSizeToDimensions
 *   getModelImageConfig
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengModelConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    function core() {
        if (root.HuanmengCore) return root.HuanmengCore;
        if (typeof require === 'function') {
            try { return require('./core.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengCore 未加载');
    }

    var ASPECT_PRESETS = [
        { label: '1:1', value: 1 },
        { label: '4:3', value: 4 / 3 },
        { label: '3:4', value: 3 / 4 },
        { label: '3:2', value: 3 / 2 },
        { label: '2:3', value: 2 / 3 },
        { label: '16:9', value: 16 / 9 },
        { label: '9:16', value: 9 / 16 }
    ];

    var RESOLUTION_LEVEL = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };

    function normalizeSizeHint(sizeHint) {
        if (!sizeHint || typeof sizeHint !== 'object') return null;
        var width = Number(sizeHint.width);
        var height = Number(sizeHint.height);
        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;
        return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    }

    function getAspectRatioValue(aspectRatio) {
        var text = String(aspectRatio || '1:1').trim();
        var parts = text.split(':');
        if (parts.length !== 2) return 1;
        var left = Number(parts[0]);
        var right = Number(parts[1]);
        if (!isFinite(left) || !isFinite(right) || left <= 0 || right <= 0) return 1;
        return left / right;
    }

    /** 把任意比例吸附到云端支持的 7 个预设之一。 */
    function normalizeSupportedAspectRatio(aspectRatio) {
        var requested = getAspectRatioValue(aspectRatio);
        var closest = ASPECT_PRESETS[0];
        ASPECT_PRESETS.forEach(function (preset) {
            if (Math.abs(preset.value - requested) < Math.abs(closest.value - requested)) closest = preset;
        });
        return closest.label;
    }

    function gcd(a, b) {
        var x = Math.abs(Math.round(a));
        var y = Math.abs(Math.round(b));
        while (y) {
            var temp = x % y;
            x = y;
            y = temp;
        }
        return x || 1;
    }

    /** 按选区真实比例给出最简标签（可能是 7:5 这种，不是预设）。 */
    function getSelectionAspectRatioLabel(sizeHint) {
        var hint = normalizeSizeHint(sizeHint);
        if (!hint) return '1:1';
        var divisor = gcd(hint.width, hint.height);
        return Math.max(1, Math.round(hint.width / divisor)) + ':' + Math.max(1, Math.round(hint.height / divisor));
    }

    function getAspectRatioLabelByHint(sizeHint) {
        return getSelectionAspectRatioLabel(sizeHint);
    }

    function normalizeImageResolution(value) {
        var text = String(value || core().DEFAULTS.imageResolution).trim().toUpperCase();
        if (text === '1K' || text === '2K' || text === '3K' || text === '4K') return text;
        return core().DEFAULTS.imageResolution;
    }

    function getBaseResolutionByImageSize(imageSize) {
        if (imageSize === '4K') return 4096;
        if (imageSize === '2K') return 2048;
        return 1024;
    }

    function getPreferredImageSizeByHint(sizeHint) {
        var hint = normalizeSizeHint(sizeHint);
        if (!hint) return '1K';
        var longSide = Math.max(hint.width, hint.height);
        if (longSide >= 3000) return '4K';
        if (longSide >= 1500) return '2K';
        return '1K';
    }

    function getNanoBananaImageSize(modelValue) {
        var key = core().getModelKey(modelValue);
        var coreApi = core();
        if (coreApi && typeof coreApi.getGrsMaxResolution === 'function') {
            return coreApi.getGrsMaxResolution(key);
        }
        if (key.indexOf('4k') > -1 || key === 'nano-banana-2-4k-cl' || key === 'nano-banana-pro-4k-vip') return '4K';
        if (key.indexOf('2k') > -1) return '2K';
        return '1K';
    }

    /**
     * GRS 只认 1K / 2K / 4K；把界面档位（可能含 3K）夹到模型能力内，
     * 3K 优先落到 4K（能力够时），否则落到 2K / 1K。
     */
    function clampGrsResolution(preferred, capability) {
        var order = ['1K', '2K', '3K', '4K'];
        var prefIndex = order.indexOf(String(preferred || '').toUpperCase());
        if (prefIndex < 0) prefIndex = 0;
        var capIndex = order.indexOf(String(capability || '').toUpperCase());
        if (capIndex < 0) capIndex = 0;
        if (prefIndex > capIndex) prefIndex = capIndex;
        // 3K 不在 GRS 支持的档位里：能力够 4K 就用 4K，否则退到 2K / 1K
        if (prefIndex === 2) {
            if (capIndex >= 3) prefIndex = 3;
            else if (capIndex >= 1) prefIndex = 1;
            else prefIndex = 0;
        }
        return order[prefIndex];
    }

    function getGrsMaxResolution(modelValue) {
        var coreApi = core();
        if (coreApi && typeof coreApi.getGrsMaxResolution === 'function') {
            return coreApi.getGrsMaxResolution(coreApi.getModelKey(modelValue));
        }
        return '1K';
    }

    function clampNanoImageSizeByCapability(preferredSize, capabilitySize) {
        var preferred = RESOLUTION_LEVEL[preferredSize] || 1;
        var capability = RESOLUTION_LEVEL[capabilitySize] || 1;
        if (preferred >= 4 && capability >= 4) return '4K';
        if (preferred >= 2 && capability >= 2) return '2K';
        return '1K';
    }

    function buildDimensionsFromAspect(baseResolution, aspectRatio) {
        var base = Math.max(256, Number(baseResolution) || 1024);
        var ratio = Math.max(0.2, Math.min(5, getAspectRatioValue(aspectRatio)));
        var width = base;
        var height = base;
        if (ratio >= 1) {
            width = base;
            height = Math.round((base / ratio) / 8) * 8;
        } else {
            height = base;
            width = Math.round((base * ratio) / 8) * 8;
        }
        return { width: Math.max(256, width), height: Math.max(256, height) };
    }

    function getGptImageSizeByAspect(aspectRatio) {
        var ratio = getAspectRatioValue(aspectRatio);
        if (ratio >= 1.2) return '1536x1024';
        if (ratio <= 0.83) return '1024x1536';
        return '1024x1024';
    }

    function parseSizeToDimensions(sizeText) {
        var match = String(sizeText || '').match(/^(\d+)\s*x\s*(\d+)$/i);
        if (!match) return { width: 1024, height: 1024 };
        return {
            width: Math.max(256, Number(match[1]) || 1024),
            height: Math.max(256, Number(match[2]) || 1024)
        };
    }

    function normalizeXaiResolution(imageResolution, sizeHint) {
        var selected = normalizeImageResolution(imageResolution);
        if (selected === '2K' || selected === '3K' || selected === '4K') return '2k';
        if (selected === '1K') return '1k';
        return getPreferredImageSizeByHint(sizeHint) === '1K' ? '1k' : '2k';
    }

    /**
     * 把一个模型 + 选区尺寸 + 档位，翻译成请求参数。
     * 返回 { width, height, aspectRatio, size, imageSize }：
     *   · Nano Banana 系列：size='auto'，真正发的是 imageSize（1K/2K/4K）
     *   · GPT Image 系列：size 是 '1536x1024' 这种固定档
     *   · 其它（xAI / NewAPI）：size='auto'，由各渠道自己决定
     */
    function getModelImageConfig(modelValue, sizeHint, imageResolution) {
        var coreApi = core();
        var modelKey = coreApi.getModelKey(modelValue);
        var aspectRatio = getAspectRatioLabelByHint(sizeHint);
        var selectedResolution = normalizeImageResolution(imageResolution);
        var explicitImageSize = selectedResolution === coreApi.DEFAULTS.imageResolution ? '' : selectedResolution;

        if (coreApi.isGrsNanoBananaModel(modelKey)) {
            var maxCapability = getNanoBananaImageSize(modelKey);
            var preferred = explicitImageSize || getPreferredImageSizeByHint(sizeHint);
            var imageSize = clampGrsResolution(preferred, maxCapability);
            var dimensions = buildDimensionsFromAspect(getBaseResolutionByImageSize(imageSize), aspectRatio);
            return {
                width: dimensions.width,
                height: dimensions.height,
                aspectRatio: aspectRatio,
                size: 'auto',
                imageSize: imageSize
            };
        }

        if (coreApi.isGrsGptImageModel(modelKey)) {
            var gptCapability = getGrsMaxResolution(modelKey);
            var gptImageSize = clampGrsResolution(explicitImageSize || '1K', gptCapability);
            var explicit = explicitImageSize
                ? buildDimensionsFromAspect(getBaseResolutionByImageSize(gptImageSize), aspectRatio)
                : null;
            var size = explicit ? explicit.width + 'x' + explicit.height : getGptImageSizeByAspect(aspectRatio);
            var parsed = parseSizeToDimensions(size);
            return {
                width: parsed.width,
                height: parsed.height,
                aspectRatio: aspectRatio,
                size: size,
                imageSize: gptImageSize
            };
        }

        var fallback = explicitImageSize
            ? buildDimensionsFromAspect(getBaseResolutionByImageSize(explicitImageSize), aspectRatio)
            : null;
        var fallbackSize = fallback ? fallback.width + 'x' + fallback.height : getGptImageSizeByAspect(aspectRatio);
        var fallbackDimensions = parseSizeToDimensions(fallbackSize);
        return {
            width: fallbackDimensions.width,
            height: fallbackDimensions.height,
            aspectRatio: aspectRatio,
            size: 'auto',
            imageSize: explicitImageSize || '1K'
        };
    }

    /** 给界面用：把模型配置算成一个能直接显示的尺寸标签。 */
    function describeModelSize(modelValue, sizeHint, imageResolution) {
        var config = getModelImageConfig(modelValue, sizeHint, imageResolution);
        if (config.size && config.size !== 'auto') return config.size + ' · ' + config.aspectRatio;
        return config.width + '×' + config.height + ' · ' + config.aspectRatio + ' · ' + config.imageSize;
    }

    return {
        ASPECT_PRESETS: ASPECT_PRESETS,
        normalizeSizeHint: normalizeSizeHint,
        getAspectRatioValue: getAspectRatioValue,
        normalizeSupportedAspectRatio: normalizeSupportedAspectRatio,
        getSelectionAspectRatioLabel: getSelectionAspectRatioLabel,
        getAspectRatioLabelByHint: getAspectRatioLabelByHint,
        normalizeImageResolution: normalizeImageResolution,
        getBaseResolutionByImageSize: getBaseResolutionByImageSize,
        getPreferredImageSizeByHint: getPreferredImageSizeByHint,
        getNanoBananaImageSize: getNanoBananaImageSize,
        clampGrsResolution: clampGrsResolution,
        getGrsMaxResolution: getGrsMaxResolution,
        clampNanoImageSizeByCapability: clampNanoImageSizeByCapability,
        buildDimensionsFromAspect: buildDimensionsFromAspect,
        getGptImageSizeByAspect: getGptImageSizeByAspect,
        parseSizeToDimensions: parseSizeToDimensions,
        normalizeXaiResolution: normalizeXaiResolution,
        getModelImageConfig: getModelImageConfig,
        describeModelSize: describeModelSize
    };
});
