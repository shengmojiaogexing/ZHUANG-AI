/* ============================================================
 * place-image.js — 把生成结果「精确放回」Photoshop
 *
 * 这是整个插件回图链路的正确做法（旧版那套「设选区 + placeEvent +
 * 反复读 bounds」的 500 行代码已经被它取代）：
 *
 *   1. data URL 写入 UXP 临时文件
 *   2. （可选）置入前先读目标范围的原画面 —— 校色参考必须在盖住之前读
 *   3. executeAsModal：
 *        placeEvent 置入 → 读实际边界 → 按目标矩形缩放 → 移到 left/top → 栅格化 → 改名
 *   4. （可选）置入后用 RGBA 校色并 putPixels 回写同一图层
 *   5. （默认）回贴收尾：把回贴图层放进图层组，并给组加一个 reveal-all 蒙版；
 *      options.groupMask === false 可关闭，任何一步失败都会回退为普通图层
 *      （只记 warn，不影响回贴本身）。
 *
 * 为什么必须这样：placeEvent 默认居中、按文档大小缩放，直接放必然错位；
 * 而 UXP 里 executeAsModal 不能嵌套，所以「读参考」只能在 modal 外先做。
 *
 * 原始位置：index.js:15988-16245（putImageDataAtBounds / applyColorMatchToLayer /
 *           replaceLayerPixels），旧对齐逻辑在 index.js:16381-17100。
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengPlace = api;
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

    function colorMatchEngine() {
        if (root.HuanmengColorMatch) return root.HuanmengColorMatch;
        if (typeof require === 'function') {
            // color-match.service.js 把 API 挂在 window.HuanmengColorMatch 上
            try { require('../05-放回校色/color-match.service.js'); } catch (ignore) {}
            if (root.HuanmengColorMatch) return root.HuanmengColorMatch;
        }
        return null;
    }

    /* ---------------- 校色结果回报 ---------------- */

    /**
     * 校色失败是「静默降级」：图会保留，只是没校色。
     * 所以必须通过 onResult 把真实结果回报给调用方，不能拿图层名当证据。
     */
    function reportColorMatch(colorMatch, info) {
        if (!colorMatch || typeof colorMatch.onResult !== 'function') return;
        try { colorMatch.onResult(info); } catch (ignore) {}
    }

    /**
     * 给刚置入的图层做融合校色：拿它和原画面比，把色彩拉齐，再写回同一图层。
     * 采样全部走宿主像素（getPixels），不走 canvas 解码。
     */
    async function applyColorMatchToLayer(layer, bounds, reference, options, documentId) {
        var engine = colorMatchEngine();
        if (!engine || typeof engine.matchImageData !== 'function') throw new Error('校色引擎未加载');
        // 取图层自己的像素（不是合成结果），避免把底下背景烤进这个图层
        var output = await ps().captureImageData(bounds, { layerId: layer.id, documentId: documentId });
        var corrected = engine.matchImageData(reference, output, options || {});
        await replaceLayerPixels(layer, corrected, bounds, documentId);
        return layer;
    }

    /** 把整块 RGBA 覆盖回已有图层（不新建图层，历史记录里还是一步）。 */
    async function replaceLayerPixels(layer, imageData, bounds, documentId) {
        var normalized = ps().normalizeBounds(bounds);
        if (!normalized) throw new Error('回写范围无效');
        return ps().putImageDataToLayer(layer, imageData, normalized, documentId);
    }

    /* ---------------- 精确置入 ---------------- */

    /**
     * 把一张图精确放到 bounds 指定的矩形里。
     *
     * @param {string} dataUrl      图片 data URL（png/jpeg/webp）
     * @param {object} bounds       { left, top, right, bottom, width, height }
     * @param {string} layerName    图层名
     * @param {number} documentId   目标文档 id（不传 = 当前活动文档）
     * @param {object} options
     *   mode        'stretch'（默认，铺满矩形）| 'fit'（等比缩放居中，不拉伸）
     *   colorMatch  { method:'wavelet'|'reinhard', strength:100, onResult(info) }
     *               传入即启用「置入后融合校色」
     *   commandName 历史记录里的步骤名
     *   groupMask   默认 true：回贴完成后把图层收进图层组并给组加 reveal-all 蒙版；
     *               传 false 可关闭（兼容旧调用）
     * @returns {Promise<object>} 置入后的图层对象（收尾失败时仍是普通图层）
     */
    async function placeImageAtBounds(dataUrl, bounds, layerName, documentId, options) {
        var opts = options || {};
        var psApi = ps();
        var host = psApi.requireAvailable();
        var normalized = psApi.normalizeBounds(bounds);
        if (!normalized) throw new Error('回图目标范围无效');
        if (!psApi.init()) throw new Error('Photoshop 回图 API 不可用');

        var colorMatch = opts.colorMatch && typeof opts.colorMatch === 'object' ? opts.colorMatch : null;
        var documentIdNumber = Number(documentId);
        var hasDocumentId = isFinite(documentIdNumber);

        var temp = await psApi.writeTempFileFromDataUrl(dataUrl, 'huanmeng_return');
        try {
            // 1) 校色参考必须在置入之前读：置入后同一位置就被新图层盖住了，
            //    再读就是拿图跟自己比，校色等于没做且不报错。
            var reference = null;
            if (colorMatch) {
                try {
                    reference = await psApi.captureImageData(normalized, {
                        documentId: hasDocumentId ? documentIdNumber : undefined
                    });
                } catch (error) {
                    core().log('[place] 自动校色：读取原画面失败，本次跳过校色', error);
                    reference = null;
                }
            }

            // 2) 目标矩形：stretch 就是 bounds；fit 按图片真实宽高等比内接
            var targetRect = normalized;
            if (String(opts.mode || '').toLowerCase() === 'fit') {
                var size = psApi.getImageSizeFromDataUrl(dataUrl);
                var fitted = size ? psApi.fitRectInside(size.width, size.height, normalized) : null;
                if (fitted) targetRect = fitted;
            }

            // 3) 置入 + 缩放 + 移动 + 栅格化（全部在一次 modal 里）
            var placed = await psApi.runInModal(async function () {
                var targetDocument = null;
                if (hasDocumentId) {
                    targetDocument = psApi.getDocumentById(documentIdNumber);
                    if (!targetDocument) throw new Error('生成时绑定的 Photoshop 原文档已关闭，为避免错贴已停止');
                }
                if (!targetDocument) targetDocument = host.app.activeDocument;
                if (!targetDocument) throw new Error('没有可用于回图的 Photoshop 文档');

                if (!host.app.activeDocument || Number(host.app.activeDocument.id) !== Number(targetDocument.id)) {
                    await host.action.batchPlay([{
                        _obj: 'select',
                        _target: [{ _ref: 'document', _id: targetDocument.id }]
                    }], { synchronousExecution: true });
                }

                var token = temp.sessionToken();
                await host.action.batchPlay([{
                    _obj: 'placeEvent',
                    null: { _path: token, _kind: 'local' },
                    linked: false,
                    freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
                    offset: {
                        _obj: 'offset',
                        horizontal: { _unit: 'pixelsUnit', _value: 0 },
                        vertical: { _unit: 'pixelsUnit', _value: 0 }
                    }
                }], { synchronousExecution: true });

                var placedBounds = await psApi.readActiveLayerBoundsRaw();
                if (placedBounds.width <= 0 || placedBounds.height <= 0) {
                    throw new Error('Photoshop 返回的置入图层尺寸无效');
                }

                // 按目标矩形 / 实际置入矩形 的比例缩放（左上角为锚点）
                var scaleX = targetRect.width / placedBounds.width * 100;
                var scaleY = targetRect.height / placedBounds.height * 100;
                if (Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01) {
                    await host.action.batchPlay([{
                        _obj: 'transform',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSCorner0' },
                        width: { _unit: 'percentUnit', _value: scaleX },
                        height: { _unit: 'percentUnit', _value: scaleY },
                        interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubicAutomatic' }
                    }], { synchronousExecution: true });
                }

                // 缩放后重新读边界，再平移到 left/top
                var afterScale = await psApi.readActiveLayerBoundsRaw();
                var moveX = targetRect.left - afterScale.left;
                var moveY = targetRect.top - afterScale.top;
                if (Math.abs(moveX) > 0.01 || Math.abs(moveY) > 0.01) {
                    await host.action.batchPlay([{
                        _obj: 'move',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                        to: {
                            _obj: 'offset',
                            horizontal: { _unit: 'pixelsUnit', _value: moveX },
                            vertical: { _unit: 'pixelsUnit', _value: moveY }
                        }
                    }], { synchronousExecution: true });
                }

                await psApi.rasterizeActiveLayer();

                // 栅格化后再对齐一次。某些 16 位 / 大文档在 rasterize 后
                // 边界会差几个像素，之前只在校色前对齐，肉眼看就是“位置偏了”。
                var finalBounds = null;
                try {
                    finalBounds = await psApi.readActiveLayerBoundsRaw();
                    var finalX = targetRect.left - finalBounds.left;
                    var finalY = targetRect.top - finalBounds.top;
                    if (Math.abs(finalX) > 0.01 || Math.abs(finalY) > 0.01) {
                        await host.action.batchPlay([{
                            _obj: 'move',
                            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                            to: {
                                _obj: 'offset',
                                horizontal: { _unit: 'pixelsUnit', _value: finalX },
                                vertical: { _unit: 'pixelsUnit', _value: finalY }
                            }
                        }], { synchronousExecution: true });
                    }
                } catch (finalError) {
                    core().log('[place] 栅格化后二次对齐失败，保留已置入图层:', finalError);
                }

                if (root && root.ZhuangLog && finalBounds) {
                    root.ZhuangLog.info('回贴', '置入对齐', {
                        target: targetRect,
                        imported: placedBounds,
                        final: finalBounds
                    });
                }

                var activeDocument = host.app.activeDocument;
                var layer = activeDocument && activeDocument.activeLayers && activeDocument.activeLayers[0];
                if (!layer) throw new Error('Photoshop 未返回回图图层');
                layer.name = layerName || '幻梦 AI 回图';
                return { layer: layer, documentId: activeDocument.id };
            }, opts.commandName || '幻梦 AI 精确回图');

            // 4) 校色（可选）：用 layer.id 操作同一图层，不受后面的建组影响，
            //    所以「置入 → 校色 → 建组」的顺序不变。
            var resultLayer = placed.layer;
            if (colorMatch) {
                if (!reference) {
                    reportColorMatch(colorMatch, { applied: false, reason: 'no-reference', message: '读原画面失败' });
                } else {
                    // 校色失败不能连图都没了：图已经放进文档，退回未校色版本
                    try {
                        resultLayer = await applyColorMatchToLayer(
                            placed.layer, targetRect, reference, colorMatch, placed.documentId
                        );
                        reportColorMatch(colorMatch, { applied: true, reason: '', message: '' });
                    } catch (error) {
                        core().log('[place] 自动校色失败，保留未校色的回图:', error);
                        reportColorMatch(colorMatch, {
                            applied: false,
                            reason: 'failed',
                            message: error && error.message ? error.message : String(error)
                        });
                        resultLayer = placed.layer;
                    }
                }
            }

            // 5) 回贴收尾：普通图层 → 图层组 + reveal-all 蒙版。
            //    放在校色之后；这步自己兜底，失败只会回退成普通图层，
            //    绝不会让整次回贴失败（见 finalizePlacedLayer）。
            var finalized = await finalizePlacedLayer(
                resultLayer, layerName, placed.documentId, opts
            );
            return finalized.layer || resultLayer;
        } finally {
            await temp.cleanup();
        }
    }

    /* ---------------- 回贴收尾：图层组 + 蒙版 ---------------- */

    var DEFAULT_GROUP_NAME = 'ZHUANG-AI插件回图';

    function warnLog(message, detail) {
        if (root && root.ZhuangLog && typeof root.ZhuangLog.warn === 'function') {
            try { root.ZhuangLog.warn('回贴', message, detail); } catch (ignore) {}
        }
    }

    function infoLog(message, detail) {
        if (root && root.ZhuangLog && typeof root.ZhuangLog.info === 'function') {
            try { root.ZhuangLog.info('回贴', message, detail); } catch (ignore) {}
        }
    }

    function errorText(error) {
        if (!error) return '';
        return error.message ? String(error.message) : String(error);
    }

    /** 组操作后原 DOM 图层对象可能过时：尽量返回文档里的新对象，失败就返回原对象。 */
    function refreshLayerRef(psApi, layer, documentId) {
        if (!layer || typeof psApi.findLayerById !== 'function' || typeof psApi.getDocumentById !== 'function') {
            return layer;
        }
        try {
            var document = psApi.getDocumentById(documentId);
            if (!document) return layer;
            var fresh = psApi.findLayerById(document, layer.id);
            return fresh || layer;
        } catch (ignore) {
            return layer;
        }
    }

    /**
     * 回贴收尾（用户需求第 5 条）：把回贴好的普通图层放进一个图层组，
     * 并给图层组自动加一个白色 reveal-all 蒙版（用户可以直接在蒙版上涂抹）。
     *
     * 约定：
     *   · 组名 = layerName，没有就用 'ZHUANG-AI插件回图'；被移入的图层名保持不变。
     *   · options.groupMask === false 时整段跳过（兼容旧调用）。
     *   · 建组或加蒙版任何一步失败：回退为原来的普通图层，用
     *     ZhuangLog.warn('回贴', '图层组/蒙版创建失败，已保留普通图层', …) 记录，
     *     绝不抛错、绝不删图——回贴本身不能因为收尾失败而失败。
     *
     * @returns {Promise<{layer:object, group:object|null, grouped:boolean, masked:boolean, skipped:boolean}>}
     */
    async function finalizePlacedLayer(layer, layerName, documentId, options) {
        var opts = options || {};
        var groupName = layerName || DEFAULT_GROUP_NAME;
        var outcome = { layer: layer, group: null, grouped: false, masked: false, skipped: false };
        if (!layer) return outcome;
        if (opts.groupMask === false) {
            outcome.skipped = true;
            return outcome;
        }

        var psApi;
        try { psApi = ps(); } catch (ignore) { return outcome; }
        if (typeof psApi.createLayerGroupContaining !== 'function'
            || typeof psApi.addRevealAllMask !== 'function') {
            warnLog('图层组/蒙版创建失败，已保留普通图层', { reason: 'ps-host 缺少建组/蒙版辅助函数' });
            return outcome;
        }

        var group = null;
        try {
            group = await psApi.createLayerGroupContaining(layer, groupName, documentId);
            if (!group) throw new Error('Photoshop 未返回图层组');
        } catch (groupError) {
            // ps-host 内部已尽量删掉「建组成功但移入失败」的空组，这里只记录
            warnLog('图层组/蒙版创建失败，已保留普通图层', {
                step: 'create-group',
                error: errorText(groupError)
            });
            return outcome;
        }
        outcome.group = group;
        outcome.grouped = true;

        try {
            var maskResult = await psApi.addRevealAllMask(group, documentId);
            outcome.masked = true;
            outcome.layer = refreshLayerRef(psApi, layer, documentId);
            infoLog('已建立图层组并添加蒙版', {
                group: groupName,
                groupId: typeof psApi.layerIdOf === 'function' ? psApi.layerIdOf(group) : (group && group.id),
                mask: maskResult && maskResult.method ? maskResult.method : 'ok'
            });
            return outcome;
        } catch (maskError) {
            warnLog('图层组/蒙版创建失败，已保留普通图层', {
                step: 'add-mask',
                error: errorText(maskError)
            });
            // 回退成普通图层：删蒙版（若有）→ 取消编组把图层提回原位。
            // 回退本身也失败时只能保留在组里，仍然不能抛错、不能删图。
            try {
                if (typeof psApi.ungroupPlacedLayer === 'function') {
                    var restored = await psApi.ungroupPlacedLayer(layer, group, documentId);
                    if (!restored) {
                        warnLog('回贴图层组回退失败，图层仍保留在组内', {
                            groupId: typeof psApi.layerIdOf === 'function' ? psApi.layerIdOf(group) : (group && group.id)
                        });
                    }
                }
            } catch (rollbackError) {
                warnLog('回贴图层组回退失败，图层仍保留在组内', { error: errorText(rollbackError) });
            }
            outcome.group = null;
            outcome.grouped = false;
            outcome.masked = false;
            return outcome;
        }
    }

    /** 把 RGBA 内存图作为新像素图层放回（辉光/特效/超分切片用）。 */
    async function placeRgbaImage(imageData, bounds, layerName, documentId, options) {
        return ps().createPixelLayerWithImage(imageData, bounds, layerName, documentId, options || {});
    }

    /**
     * 新建文档打开生成结果（没有选区/不想回贴时用）。
     *
     * 默认**不删**临时文件：文档是「从文件打开」的，删掉源文件后
     * 某些操作（另存为/恢复）会指向一个不存在的路径。UXP 的临时目录
     * 由宿主回收，留下的成本比"文档行为异常"低。
     * 确定不需要时传 options.cleanup = true。
     */
    async function createDocumentFromDataUrl(dataUrl, name, options) {
        var psApi = ps();
        psApi.requireAvailable();
        var opts = options || {};
        var temp = await psApi.writeTempFileFromDataUrl(dataUrl, 'huanmeng_open');
        try {
            var document = await psApi.openFileAsDocument(temp.file);
            if (!document) throw new Error('Photoshop 未返回新文档');
            return document;
        } finally {
            if (opts.cleanup === true) await temp.cleanup();
        }
    }

    /**
     * 一步到位：有选区目标就精确回贴，没有就新开文档。
     * @returns {Promise<{mode:'placed'|'document', layer?, document?}>}
     */
    async function placeOrOpen(dataUrl, options) {
        var opts = options || {};
        if (opts.bounds) {
            var layer = await placeImageAtBounds(
                dataUrl, opts.bounds, opts.layerName, opts.documentId, opts
            );
            return { mode: 'placed', layer: layer };
        }
        var document = await createDocumentFromDataUrl(dataUrl, opts.name || '幻梦 AI 生成');
        return { mode: 'document', document: document };
    }

    /**
     * 兼容层：ComfyUI 面板认这个全局钩子。
     * 它只传 dataUrl / 矩形 / 图层名 / 文档 id / { colorMatch }。
     */
    if (typeof root !== 'undefined') {
        root.HuanmengPhotoshopPlace = {
            placeImageAtBounds: placeImageAtBounds
        };
    }

    return {
        placeImageAtBounds: placeImageAtBounds,
        placeRgbaImage: placeRgbaImage,
        replaceLayerPixels: replaceLayerPixels,
        applyColorMatchToLayer: applyColorMatchToLayer,
        createDocumentFromDataUrl: createDocumentFromDataUrl,
        placeOrOpen: placeOrOpen
    };
});
