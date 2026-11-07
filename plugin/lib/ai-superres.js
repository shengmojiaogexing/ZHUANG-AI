/* ============================================================
 * ai-superres.js — AI 切片超分（Nano Banana 2 4K）
 *
 * 思路：把选区按「单块输入上限」切成若干块，每块单独放大 4K，
 * 再按放大后的目标矩形逐块贴回原位，最后得到一张 2x/3x/4x 的图。
 *
 * 关键参数（与原插件一致）：
 *   · 输出上限 4096px / 输入上限 3000px（4096 ÷ 倍数 与 3000 取小）
 *   · 切片步长 = 单块输入上限 - 重叠像素，最小 256
 *   · 每块都带同一段「只提升清晰度、不许重绘」的提示词
 *
 * 原始位置：index.js:443-449（提示词）、12853-13024（切片计划与执行）
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengSuperRes = api;
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

    function imageGen() {
        if (root.HuanmengImageGen) return root.HuanmengImageGen;
        if (typeof require === 'function') {
            try { return require('../01-生图API/image-generate.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengImageGen 未加载');
    }

    function place() {
        if (root.HuanmengPlace) return root.HuanmengPlace;
        if (typeof require === 'function') {
            try { return require('../04-图片放回/place-image.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengPlace 未加载');
    }

    /** 每块切片共用的提示词：只提清晰度，不许改内容。 */
    var TILE_PROMPT = [
        'Perform high-quality super-resolution and detail enhancement on this tile.',
        'Increase clarity, edge quality, micro-detail stability, texture definition, and clean high-frequency detail while preserving the exact content.',
        'Do not redraw the composition, do not change identity, face, pose, clothing, object count, layout, camera, lighting direction, or crop.',
        'Do not add or remove objects. Do not invent text, logos, watermarks, or decorative symbols.',
        'Keep border details continuous and neutral so adjacent tiles can be stitched seamlessly without visible seams.'
    ].join('\n');

    /**
     * 计算切片计划（纯函数，可离线测）。
     *
     * @param {object} bounds  { left, top, width, height }（或 left/top/right/bottom）
     * @param {number} factor  2 | 3 | 4
     * @param {number} overlap 重叠像素（0-512）
     * @returns {object} { factor, overlap, sourceWidth, sourceHeight, targetWidth,
     *                     targetHeight, tileInputMax, maxOutputTile, tiles:[...] }
     */
    function planTiles(bounds, factor, overlap) {
        var safeFactor = Math.max(2, Math.min(4, Number(factor) || 2));
        var safeOverlap = Math.max(0, Math.min(512, Number(overlap) || 128));
        var maxOutputTile = 4096;
        var preferredInputTile = 3000;
        var tileInputMax = Math.min(preferredInputTile, Math.floor(maxOutputTile / safeFactor));
        var step = Math.max(256, tileInputMax - safeOverlap);
        var tiles = [];

        var sourceWidth = Math.round(bounds.width || (bounds.right - bounds.left));
        var sourceHeight = Math.round(bounds.height || (bounds.bottom - bounds.top));
        var baseLeft = Number(bounds.left) || 0;
        var baseTop = Number(bounds.top) || 0;

        for (var y = 0; y < sourceHeight; y += step) {
            var top = Math.max(0, Math.min(y, Math.max(0, sourceHeight - tileInputMax)));
            var bottom = Math.min(sourceHeight, top + tileInputMax);
            for (var x = 0; x < sourceWidth; x += step) {
                var left = Math.max(0, Math.min(x, Math.max(0, sourceWidth - tileInputMax)));
                var right = Math.min(sourceWidth, left + tileInputMax);

                var sourceBounds = {
                    left: baseLeft + left,
                    top: baseTop + top,
                    right: baseLeft + right,
                    bottom: baseTop + bottom,
                    width: right - left,
                    height: bottom - top
                };
                tiles.push({
                    index: tiles.length + 1,
                    sourceBounds: sourceBounds,
                    targetBounds: {
                        left: Math.round(baseLeft + left * safeFactor),
                        top: Math.round(baseTop + top * safeFactor),
                        right: Math.round(baseLeft + right * safeFactor),
                        bottom: Math.round(baseTop + bottom * safeFactor),
                        width: Math.round((right - left) * safeFactor),
                        height: Math.round((bottom - top) * safeFactor)
                    }
                });
                if (right >= sourceWidth) break;
            }
            if (bottom >= sourceHeight) break;
        }

        return {
            factor: safeFactor,
            overlap: safeOverlap,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            targetWidth: Math.round(sourceWidth * safeFactor),
            targetHeight: Math.round(sourceHeight * safeFactor),
            tileInputMax: tileInputMax,
            maxOutputTile: maxOutputTile,
            tiles: tiles
        };
    }

    /**
     * 执行 AI 超分。
     *
     * options:
     *   bounds      要放大的选区（必填）
     *   factor      2/3/4
     *   overlap     重叠像素，默认 128
     *   model       默认 nano-banana-2-4k-cl
     *   apiKey/baseUrl/imageResolution（默认 4K）
     *   documentId  目标文档
     *   onProgress  (done, total, tile) => void
     *   signal      AbortSignal
     *
     * @returns {Promise<{groupName, plan, layers}>}
     */
    async function runSuperResolution(options) {
        var opts = options || {};
        var psApi = ps();
        if (!opts.bounds) throw new Error('请先读取要超清的选区');
        var plan = opts.plan || planTiles(opts.bounds, opts.factor, opts.overlap);
        if (!plan.tiles.length) throw new Error('切片计划无效');

        var model = opts.model || 'nano-banana-2-4k-cl';
        var groupName = opts.groupName || ('AI超清 ' + plan.factor + 'x ' + core().formatTimestamp());
        var layers = [];

        // 【拆分包修正】原实现边贴边读下一块，2x 时第 1 块的输出矩形会盖住
        // 第 2 块的源区域，后续切片读到的是"已经被放大的上一块"，拼出来是脏的。
        // 修正方式：每贴完一块就把它临时隐藏，全部贴完再统一显示。
        // 这样每次 captureSelectionBase64 读到的都是未被污染的原始画面。
        var hidden = [];
        try {
            for (var i = 0; i < plan.tiles.length; i++) {
                var tile = plan.tiles[i];
                if (opts.signal && opts.signal.aborted) throw new Error('已取消');

                // 1) 读这一块的原像素（此前贴上的切片都处于隐藏状态）
                var tileBase64 = await psApi.captureSelectionBase64(tile.sourceBounds, {
                    documentId: opts.documentId
                });
                if (!tileBase64) throw new Error('第 ' + tile.index + ' 个切片读取失败');

                // 2) 单独放大（固定 4K 档、比例 auto，让模型按切片真实比例出图）
                var generated = await imageGen().generateImages({
                    prompt: TILE_PROMPT,
                    model: model,
                    provider: opts.provider,
                    apiKey: opts.apiKey,
                    baseUrl: opts.baseUrl,
                    count: 1,
                    imageBase64: 'data:image/png;base64,' + tileBase64,
                    sizeHint: tile.sourceBounds,
                    imageResolution: opts.imageResolution || '4K',
                    aspectRatio: 'auto',
                    applySystemPrompt: false,
                    signal: opts.signal,
                    settings: opts.settings
                });
                if (!generated.success) {
                    throw new Error('第 ' + tile.index + ' 个切片生成失败：' + (generated.error || '未知错误'));
                }

                // 3) 贴到放大后的目标矩形（普通混合，逐块拼接）
                var layer = await place().placeImageAtBounds(
                    generated.images[0].dataUrl,
                    tile.targetBounds,
                    groupName + ' tile ' + tile.index,
                    opts.documentId,
                    { groupMask: false, commandName: 'AI超清切片 ' + tile.index + '/' + plan.tiles.length }
                );
                layers.push(layer);
                hidden.push(layer);

                // 4) 立刻隐藏，保证下一块采样干净
                if (i < plan.tiles.length - 1) {
                    await psApi.setLayerVisible(layer, false);
                }

                if (typeof opts.onProgress === 'function') {
                    try { opts.onProgress(tile.index, plan.tiles.length, tile); } catch (ignore) {}
                }
            }
        } finally {
            // 无论成功失败，已贴的切片都要恢复显示，不能给用户留一堆隐藏层
            for (var h = 0; h < hidden.length; h++) {
                try { await psApi.setLayerVisible(hidden[h], true); } catch (ignore) {}
            }
        }

        return { groupName: groupName, plan: plan, layers: layers };
    }

    return {
        TILE_PROMPT: TILE_PROMPT,
        planTiles: planTiles,
        runSuperResolution: runSuperResolution
    };
});
