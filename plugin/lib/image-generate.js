/* ============================================================
 * image-generate.js — 生图业务编排
 *
 * 【第三方来源声明】本文件中渠道生图相关的参数拼装与响应取图逻辑，
 * 部分衍生自 Blendrr / AI-Assisted-Image-Editing-for-Photoshop
 * （Copyright 2026 deewong7，GPL-3.0），并已由本项目作者改写、裁剪。
 * 完整署名见仓库根目录或同目录的 NOTICE。
 *
 * 在 provider-api 之上补三件事：
 *   1. 一次要 N 张图怎么发（能 n 的传 n，不能 n 的一次并发发出去）；
 *   2. 各家的响应长得五花八门，统一从里面把图挖出来；
 *   3. 系统提示词的拼装（正向要求 + 任务 + 逆向约束）。
 *
 * 原始位置：
 *   index.js:1214-1279  系统提示词
 *   index.js:15766-15945 图像候选挖掘（extractImageFromResponse 等）
 *   index.js:15606-15765 generateSingleImage（多图循环的思路）
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengImageGen = api;
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
            try { return require('./provider-api.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengProviderApi 未加载');
    }

    /* ---------------- 系统提示词 ---------------- */

    function getSystemPrompts(kind, settings) {
        var coreApi = core();
        var safe = settings || coreApi.getSettings();
        if (kind === 'text') {
            return {
                positive: String(safe.textSystemPromptPositive == null ? coreApi.DEFAULTS.textSystemPromptPositive : safe.textSystemPromptPositive).trim(),
                negative: String(safe.textSystemPromptNegative == null ? coreApi.DEFAULTS.textSystemPromptNegative : safe.textSystemPromptNegative).trim()
            };
        }
        return {
            positive: String(safe.imageSystemPromptPositive == null ? coreApi.DEFAULTS.imageSystemPromptPositive : safe.imageSystemPromptPositive).trim(),
            negative: String(safe.imageSystemPromptNegative == null ? coreApi.DEFAULTS.imageSystemPromptNegative : safe.imageSystemPromptNegative).trim()
        };
    }

    /** 生图/对话共用的提示词拼装：正向 + 任务 + 逆向。 */
    function composePrompt(prompt, kind, settings) {
        var configured = getSystemPrompts(kind === 'text' ? 'text' : 'image', settings);
        var parts = [];
        if (configured.positive) parts.push('系统正向要求：\n' + configured.positive);
        if (prompt) parts.push('当前任务：\n' + String(prompt).trim());
        if (configured.negative) parts.push('系统逆向约束（必须避免）：\n' + configured.negative);
        return parts.join('\n\n');
    }

    /* ---------------- 响应取图 ---------------- */

    function isLikelyBase64ImageData(value) {
        if (typeof value !== 'string') return false;
        var trimmed = value.trim();
        if (!trimmed || trimmed.length < 128) return false;
        if (/^data:image\//i.test(trimmed)) return true;
        return /^[A-Za-z0-9+/=\s]+$/.test(trimmed)
            && (trimmed.indexOf('/') > -1 || trimmed.indexOf('+') > -1 || trimmed.indexOf('=') > -1);
    }

    function makeImageDataUrl(value) {
        if (!value) return '';
        if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) return value;
        var normalized = String(value).replace(/\s+/g, '');
        var mimeMatch = normalized.match(/^([A-Za-z]+\/[A-Za-z0-9.+-]+);base64,(.+)$/i);
        if (mimeMatch) return 'data:' + mimeMatch[1] + ';base64,' + mimeMatch[2];
        return 'data:image/png;base64,' + normalized;
    }

    /**
     * 深度遍历响应对象，收集所有像图片的字符串。
     * 覆盖 OpenAI b64_json/url、Gemini inlineData、Vertex predictions、
     * Firefly outputs[].image.url 等形态。
     */
    function collectImageCandidates(value, results) {
        results = results || [];
        if (!value) return results;

        if (typeof value === 'string') {
            var trimmed = value.trim();
            if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) results.push(trimmed);
            else if (isLikelyBase64ImageData(trimmed)) results.push(makeImageDataUrl(trimmed));
            return results;
        }

        if (Array.isArray(value)) {
            value.forEach(function (item) { collectImageCandidates(item, results); });
            return results;
        }

        if (typeof value !== 'object') return results;

        ['url', 'image', 'image_url', 'output', 'b64_json', 'response_url', 'download_url', 'uri', 'src',
            'base64', 'base64Data', 'imageBase64', 'image_data', 'imageData', 'result_image',
            'original_url', 'originalUrl', 'file_url', 'fileUrl', 'result_url', 'resultUrl',
            'thumbnail', 'thumbnail_url', 'thumbnailUrl'].forEach(function (key) {
            if (typeof value[key] === 'string') {
                var fieldValue = value[key];
                results.push(
                    key === 'b64_json' || key.toLowerCase().indexOf('base64') > -1 || key.toLowerCase().indexOf('image_data') > -1
                        ? makeImageDataUrl(fieldValue)
                        : fieldValue
                );
            }
        });

        Object.keys(value).forEach(function (key) {
            var fieldValue = value[key];
            if (typeof fieldValue === 'string') {
                var lowerKey = key.toLowerCase();
                if (lowerKey.indexOf('image') > -1 || lowerKey.indexOf('img') > -1 || lowerKey.indexOf('url') > -1
                    || lowerKey.indexOf('base64') > -1 || lowerKey.indexOf('b64') > -1) {
                    if (/^(https?:\/\/|data:image\/)/i.test(fieldValue.trim()) || isLikelyBase64ImageData(fieldValue)) {
                        results.push(isLikelyBase64ImageData(fieldValue) ? makeImageDataUrl(fieldValue) : fieldValue.trim());
                    }
                }
            } else if (fieldValue && typeof fieldValue === 'object') {
                var nestedKey = key.toLowerCase();
                if (nestedKey.indexOf('image') > -1 || nestedKey.indexOf('img') > -1 || nestedKey.indexOf('url') > -1
                    || nestedKey.indexOf('thumb') > -1 || nestedKey.indexOf('file') > -1 || nestedKey.indexOf('asset') > -1
                    || nestedKey === 'output' || nestedKey === 'original' || nestedKey === 'source') {
                    collectImageCandidates(fieldValue, results);
                }
            }
        });

        ['inlineData', 'inline_data'].forEach(function (key) {
            var inline = value[key];
            if (!inline || typeof inline !== 'object') return;
            var mimeType = inline.mimeType || inline.mime_type || '';
            var data = inline.data;
            if (typeof data === 'string' && data.trim() && /^image\//i.test(mimeType)) {
                results.push('data:' + mimeType + ';base64,' + data.trim());
            }
        });

        if (Array.isArray(value.predictions)) {
            value.predictions.forEach(function (pred) {
                if (!pred || typeof pred !== 'object') return;
                var b64 = pred.bytesBase64Encoded || pred.b64_bytes || pred.bytes || pred.data;
                var mime = pred.mimeType || pred.mime_type || 'image/png';
                if (typeof b64 === 'string' && b64.length > 256) {
                    results.push('data:' + mime + ';base64,' + b64.replace(/\s+/g, ''));
                }
            });
        }

        ['data', 'results', 'images', 'result', 'output', 'outputs', 'items', 'attachments', 'choices',
            'content', 'message', 'payload', 'response', 'data_list', 'dataList', 'image_list', 'imageList',
            'artifacts', 'files', 'candidates', 'parts'].forEach(function (key) {
            collectImageCandidates(value[key], results);
        });

        return results;
    }

    function isLikelyImageResult(value) {
        if (!value) return false;
        if (/^data:image\//i.test(value)) return true;
        try {
            var parsed = new URL(value.replace(/\\\//g, '/'));
            return /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(parsed.pathname)
                || /(?:^|\.)(oaidalleapiprodscus|blob|grs|claude|image|img|cdn|adobe|firefly|storage|xai-imgen)\./i.test(parsed.hostname)
                || /(?:^|\.)(amazonaws|cloudfront|aliyuncs|myqcloud|googleusercontent|digitaloceanspaces|backblazeb2|b-cdn|volces|volccdn|byteimg|ibyteimg)\./i.test(parsed.hostname);
        } catch (error) {
            return /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(value);
        }
    }

    function sanitizeImageCandidate(value) {
        if (typeof value !== 'string') return value;
        if (/^data:image\//i.test(value)) return value.trim();
        var result = value.trim();
        var trailing = /[)\]}>"'`,;:，。；：）】》、»”’]+$/;
        var previous;
        do {
            previous = result;
            result = result.replace(trailing, '');
        } while (result !== previous);
        return result;
    }

    /**
     * 从任意响应里取第一张图。返回 data URL 或远程 URL；取不到返回 null。
     * 这是原插件里最关键的一段「万能取图」逻辑。
     */
    function extractImage(response) {
        var list = extractImages(response);
        return list.length ? list[0] : null;
    }

    /** 取所有图片（去重），顺序即响应里的出现顺序。 */
    function extractImages(response) {
        if (!response) return [];
        var candidates = [];
        try {
            collectImageCandidates(response, candidates);
            var serialized = JSON.stringify(response);
            var escapedUrlMatches = serialized.match(/https?:\\?\/\\?\/[^"'\\\s]+/g) || [];
            escapedUrlMatches.forEach(function (url) {
                candidates.push(url.replace(/\\\//g, '/'));
            });
            var dataMatches = serialized.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || [];
            dataMatches.forEach(function (url) { candidates.push(url); });
        } catch (error) {
            core().log('[image-gen] 解析响应失败:', error);
        }

        var seen = {};
        var output = [];
        candidates.forEach(function (candidate) {
            var value = sanitizeImageCandidate(candidate);
            if (!value || !isLikelyImageResult(value)) return;
            if (seen[value]) return;
            seen[value] = true;
            output.push(value);
        });
        return output;
    }

    /* ---------------- 多图生成 ---------------- */

    function canPassN(provider) {
        var name = String(provider || '').toLowerCase();
        return name === 'google' || name === 'xai' || name === 'newapi' || name === 'newapi-openai'
            || name === 'newapi-gemini' || name === 'volcengine' || name === 'openai';
    }

    /**
     * 生成图像（文生图 / 图生图 / 多参考图）。
     *
     * options:
     *   prompt          提示词（必填）
     *   model           'provider/model' 或裸模型名
     *   provider        可选，覆盖模型名里的渠道
     *   apiKey/baseUrl  可选，覆盖设置里的连接信息
     *   count           要几张（默认 1，最多 8）
     *   imageBase64     主输入图（data URL / 纯 base64）
     *   referenceImages 参考图数组
     *   sizeHint        { width, height } 选区尺寸，决定画幅与档位
     *   imageResolution 'auto' | '1K' | '2K' | '3K' | '4K'
     *   aspectRatio     'auto' 或 '16:9' 等
     *   applySystemPrompt 默认 true
     *   signal          AbortSignal
     *   onProgress      可选 (index, total) => void
     *
     * 返回 { success, images:[{ dataUrl, sourceUrl }], data, error, provider, model }
     */
    async function generateImages(options) {
        var opts = options || {};
        var coreApi = core();
        var api = providerApi();
        if (!opts.prompt || !String(opts.prompt).trim()) {
            return { success: false, error: '请输入提示词', images: [] };
        }

        // 没传模型时用设置里的默认生图模型
        var modelValue = opts.model || coreApi.getSettings().imgModel || coreApi.DEFAULTS.imageModel;
        var parsed = coreApi.parseModelSelection(modelValue);
        var provider = String(opts.provider || parsed.provider || 'grs').toLowerCase();
        var model = coreApi.getModelName(modelValue);
        var count = Math.max(1, Math.min(8, parseInt(opts.count, 10) || 1));
        var prompt = opts.applySystemPrompt === false
            ? String(opts.prompt)
            : composePrompt(opts.prompt, 'image', opts.settings);

        var images = [];
        var lastData = null;
        var errors = [];

        if (canPassN(provider)) {
            // 平台支持一次请求出多张（n）：一个请求就够，平台内部并行
            var single = await api.generateImage({
                provider: provider,
                model: modelValue,
                prompt: prompt,
                apiKey: opts.apiKey,
                baseUrl: opts.baseUrl,
                imageBase64: opts.imageBase64,
                referenceImages: opts.referenceImages,
                sizeHint: opts.sizeHint,
                imageResolution: opts.imageResolution,
                imageSize: opts.imageSize,
                aspectRatio: opts.aspectRatio,
                n: count,
                newApiImageMode: opts.newApiImageMode,
                allow4K: opts.allow4K,
                signal: opts.signal,
                settings: opts.settings
            });
            if (!single.success) {
                errors.push(single.error || '生成失败');
            } else {
                lastData = single.data;
                var foundSingle = extractImages(single.data);
                if (!foundSingle.length) errors.push('请求成功但响应里没有图像');
                else foundSingle.forEach(function (sourceUrl) { images.push({ dataUrl: '', sourceUrl: sourceUrl }); });
            }
            if (typeof opts.onProgress === 'function') {
                try { opts.onProgress(1, 1); } catch (ignore) {}
            }
        } else {
            // 平台不支持 n：把 count 个请求**同时**发出去，
            // 不要一张一张等（原来串行是这样：1/4 完成才开始 2/4）。
            var completed = 0;
            var slots = new Array(count);
            var tasks = [];
            for (var round = 0; round < count; round++) {
                tasks.push((function (requestIndex) {
                    var notify = function () {
                        completed += 1;
                        if (typeof opts.onProgress === 'function') {
                            try { opts.onProgress(completed, count); } catch (ignore) {}
                        }
                    };
                    return api.generateImage({
                        provider: provider,
                        model: modelValue,
                        prompt: prompt,
                        apiKey: opts.apiKey,
                        baseUrl: opts.baseUrl,
                        imageBase64: opts.imageBase64,
                        referenceImages: opts.referenceImages,
                        sizeHint: opts.sizeHint,
                        imageResolution: opts.imageResolution,
                        imageSize: opts.imageSize,
                        aspectRatio: opts.aspectRatio,
                        n: 1,
                        newApiImageMode: opts.newApiImageMode,
                        allow4K: opts.allow4K,
                        signal: opts.signal,
                        settings: opts.settings
                    }).then(function (result) {
                        notify();
                        return { index: requestIndex, result: result };
                    }, function (error) {
                        notify();
                        return { index: requestIndex, error: error };
                    });
                })(round));
            }
            var settled = await Promise.all(tasks);
            settled.forEach(function (item) {
                if (item.error) {
                    errors.push(item.error && item.error.message ? item.error.message : String(item.error));
                    return;
                }
                var result = item.result;
                if (!result || !result.success) {
                    errors.push(result && result.error ? result.error : '生成失败');
                    return;
                }
                lastData = result.data;
                var found = extractImages(result.data);
                if (!found.length) {
                    errors.push('请求成功但响应里没有图像');
                    return;
                }
                slots[item.index] = found;
            });
            // 按请求序号拼回去，保证「第一张」仍然对应第一次请求
            for (var slotIndex = 0; slotIndex < slots.length; slotIndex++) {
                if (!slots[slotIndex]) continue;
                slots[slotIndex].forEach(function (sourceUrl) { images.push({ dataUrl: '', sourceUrl: sourceUrl }); });
            }
        }

        // 远程 URL → data URL（UXP 里后续要写临时文件，必须拿到字节）
        if (typeof opts.onStatus === 'function') {
            try { opts.onStatus('download', images.length); } catch (ignore) {}
        }
        await Promise.all(images.map(function (item) {
            if (/^data:image\//i.test(item.sourceUrl)) {
                item.dataUrl = item.sourceUrl;
                return Promise.resolve();
            }
            return coreApi.fetchAsDataUrl(item.sourceUrl, { signal: opts.signal }).then(function (dataUrl) {
                item.dataUrl = dataUrl;
            }, function (error) {
                errors.push('下载结果图失败: ' + (error && error.message ? error.message : error));
            });
        }));
        images = images.filter(function (item) { return !!item.dataUrl; });

        // 用户中途取消时，前端要能区分「全部失败」和「主动取消」
        var canceled = !!(opts.signal && opts.signal.aborted);

        if (!images.length) {
            return {
                success: false,
                canceled: canceled,
                error: errors[0] || '未生成任何图像',
                errors: errors,
                images: [],
                provider: provider,
                model: model
            };
        }

        return {
            success: true,
            canceled: canceled,
            images: images,
            dataUrl: images[0].dataUrl,
            data: lastData,
            errors: errors,
            provider: provider,
            model: model
        };
    }

    /**
     * 只生成一张并返回 data URL（最常用的简写）。
     */
    async function generateOne(options) {
        var result = await generateImages(Object.assign({}, options, { count: 1 }));
        return result.success ? result.images[0].dataUrl : '';
    }

    return {
        generateImages: generateImages,
        generateOne: generateOne,
        extractImage: extractImage,
        extractImages: extractImages,
        collectImageCandidates: collectImageCandidates,
        isLikelyImageResult: isLikelyImageResult,
        sanitizeImageCandidate: sanitizeImageCandidate,
        composePrompt: composePrompt,
        getSystemPrompts: getSystemPrompts
    };
});
