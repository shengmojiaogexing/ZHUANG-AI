// ============================================================
// 【第三方来源声明】模型目录、分辨率档位与请求参数中，SeeDream 4.5 / 5.0 /
// 5.0 Pro（火山方舟）、Nano Banana Pro / Nano Banana 2（Google AI Studio）、
// Grok Imagine 2.0（xAI 官方）部分取自 Blendrr / AI-Assisted-Image-Editing-for-
// Photoshop（Copyright 2026 deewong7，GPL-3.0），并已由本项目作者改写、裁剪。
// 完整署名见仓库根目录或同目录的 NOTICE。
// ============================================================

// ============================================================
// provider-models.js — 各云端渠道的模型目录与请求用法
//
// 职责：纯数据 + 纯函数。给出「有哪些模型」「每个模型支持哪些分辨率」
//       「按选区尺寸该选哪一档」「请求体长什么样」。
// 边界：不发请求、不碰 Photoshop、不读设置、不动界面。
//       实际的 fetch 由 src/app/index.js 的 API.* 负责，
//       这一层因此可以在 node 下直接跑测试。
//
// ============================================================

(function(global) {
    'use strict';

    // ------------------------------------------------------------
    // 官方模型 ID，逐字一致
    // ------------------------------------------------------------
    var SEEDREAM_45 = 'doubao-seedream-4-5-251128';
    var SEEDREAM_50 = 'doubao-seedream-5-0-260128';
    var SEEDREAM_50_PRO = 'doubao-seedream-5-0-pro-260628';
    var NANO_BANANA_PRO = 'gemini-3-pro-image';
    var NANO_BANANA_2 = 'gemini-3.1-flash-image';
    var NANO_BANANA_2_PREVIEW = 'gemini-3.1-flash-image-preview';
    var GROK_IMAGINE = 'grok-imagine-image';
    var GROK_IMAGINE_2 = 'grok-imagine-image-2.0';

    // 像素基准
    var BASE_RESOLUTION = { '1K': 1024, '2K': 2048, '3K': 3072, '4K': 4096 };

    // 每个模型自己的分辨率梯（顺序 = 由低到高，capResolution 取末位兜底）
    // 与 providers/bytedance.js 的 MODEL_RESOLUTIONS、utils.js 的
    // getModelResolutionLadder 一致。
    var MODEL_RESOLUTION_LADDER = {};
    MODEL_RESOLUTION_LADDER[SEEDREAM_45] = ['2K', '4K'];
    MODEL_RESOLUTION_LADDER[SEEDREAM_50] = ['2K', '3K'];
    MODEL_RESOLUTION_LADDER[SEEDREAM_50_PRO] = ['1K', '2K'];
    MODEL_RESOLUTION_LADDER[GROK_IMAGINE] = ['1K', '2K'];
    MODEL_RESOLUTION_LADDER[GROK_IMAGINE_2] = ['1K', '2K'];
    // Google 图像模型 1K/2K/4K 都收（gemini-3-pro-image 支持到 4K）
    MODEL_RESOLUTION_LADDER[NANO_BANANA_PRO] = ['1K', '2K', '4K'];
    MODEL_RESOLUTION_LADDER[NANO_BANANA_2] = ['1K', '2K', '4K'];
    MODEL_RESOLUTION_LADDER[NANO_BANANA_2_PREVIEW] = ['1K', '2K', '4K'];

    var DEFAULT_LADDER = ['1K', '2K', '4K'];

    // 渠道归属：模型 ID → Dream 的「平台 / 渠道」标识
    var MODEL_PROVIDER = {};
    [SEEDREAM_45, SEEDREAM_50, SEEDREAM_50_PRO].forEach(function(id) { MODEL_PROVIDER[id] = 'volcengine'; });
    [NANO_BANANA_PRO, NANO_BANANA_2, NANO_BANANA_2_PREVIEW].forEach(function(id) { MODEL_PROVIDER[id] = 'google'; });
    [GROK_IMAGINE, GROK_IMAGINE_2].forEach(function(id) { MODEL_PROVIDER[id] = 'xai'; });

    // 界面目录项（value 带渠道前缀，供 Dream 的「平台 / 渠道」下拉直接使用）
    var SEEDREAM_OPTIONS = [
        { value: 'volcengine/' + SEEDREAM_45, text: 'SeeDream 4.5 (火山方舟 · 2K/4K)' },
        { value: 'volcengine/' + SEEDREAM_50, text: 'SeeDream 5.0 (火山方舟 · 2K/3K)' },
        { value: 'volcengine/' + SEEDREAM_50_PRO, text: 'SeeDream 5.0 Pro (火山方舟 · 1K/2K)' }
    ];
    var GOOGLE_IMAGE_OPTIONS = [
        { value: 'google/' + NANO_BANANA_PRO, text: 'Nano Banana Pro (Google AI Studio)' },
        { value: 'google/' + NANO_BANANA_2, text: 'Nano Banana 2 (Google AI Studio)' },
        { value: 'google/' + NANO_BANANA_2_PREVIEW, text: 'Nano Banana 2 Preview (Google AI Studio)' }
    ];
    var XAI_IMAGE_OPTIONS = [
        { value: 'xai/' + GROK_IMAGINE_2, text: 'Grok Imagine 2.0 (xAI 官方)' }
    ];

    // ------------------------------------------------------------
    // 模型判定
    // ------------------------------------------------------------
    function isSeedreamModel(modelId) {
        return !!MODEL_RESOLUTION_LADDER[String(modelId || '')] &&
            String(modelId).indexOf('seedream') >= 0;
    }

    function isGoogleImageModel(modelId) {
        return !!MODEL_PROVIDER[String(modelId || '')] && MODEL_PROVIDER[String(modelId)] === 'google';
    }

    function isGrokImagineModel(modelId) {
        return !!MODEL_PROVIDER[String(modelId || '')] && MODEL_PROVIDER[String(modelId)] === 'xai';
    }

    function isSupportedModel(modelId) {
        return !!MODEL_PROVIDER[String(modelId || '')];
    }

    function getProviderForModel(modelId) {
        return MODEL_PROVIDER[String(modelId || '')] || '';
    }

    function getResolutionLadder(modelId) {
        return (MODEL_RESOLUTION_LADDER[String(modelId || '')] || DEFAULT_LADDER).slice();
    }

    function parseResolutionTier(resolution) {
        var match = /^(\d+)K$/i.exec(String(resolution == null ? '' : resolution).trim());
        return match ? Number(match[1]) : NaN;
    }

    // ------------------------------------------------------------
    // 分辨率收敛
    // ------------------------------------------------------------
    // 档位收敛：允许的梯里没有就取梯的最后一档（最高档），
    // 关掉 4K 开关时先把 4K 从梯里摘掉。
    function capResolution(resolution, modelId, options) {
        var allow4K = (options || {}).allow4KGeneration === true;
        var ladder = getResolutionLadder(modelId);
        var allowed = allow4K ? ladder : ladder.filter(function(value) { return value !== '4K'; });
        var normalized = String(resolution == null ? '' : resolution).trim().toUpperCase();

        if (allowed.indexOf(normalized) >= 0) return normalized;
        return allowed[allowed.length - 1] || '2K';
    }

    // SeeDream 档位收敛：
    // 请求档位低于该模型最低档就抬到最低档，否则抬到最高档。
    function normalizeSeedreamResolution(resolution, modelId) {
        var ladder = getResolutionLadder(modelId);
        var normalized = String(resolution == null ? '' : resolution).trim().toUpperCase();
        if (ladder.indexOf(normalized) >= 0) return normalized;

        var requested = parseResolutionTier(normalized);
        var minTier = ladder[0];
        var maxTier = ladder[ladder.length - 1];
        if (!isFinite(requested) || requested <= parseResolutionTier(minTier)) return minTier;
        return maxTier;
    }

    // Grok 只认 1k/2k，4k 降到 2k。
    function normalizeXaiResolution(resolution) {
        if (!resolution) return '1k';
        var normalized = String(resolution).toLowerCase();
        if (normalized === '1k' || normalized === '2k') return normalized;
        if (normalized === '4k') return '2k';
        return '1k';
    }

    // 按选区长边自动选档。
    function pickTier(longEdge, modelId, options) {
        var opts = options || {};
        var upgradeFactor = isFinite(opts.upgradeFactor) ? Number(opts.upgradeFactor) : 1.5;
        var edge = Number(longEdge) || 0;

        var tier;
        if (edge <= BASE_RESOLUTION['1K'] * upgradeFactor) {
            // SeeDream 4.5 起就是 2K，没有 1K 档
            tier = isSeedreamModel(modelId) && getResolutionLadder(modelId).indexOf('1K') < 0 ? '2K' : '1K';
        } else if (edge <= BASE_RESOLUTION['2K'] * upgradeFactor) {
            tier = '2K';
        } else if (String(modelId) === SEEDREAM_50_PRO) {
            tier = '2K';
        } else if (String(modelId) === SEEDREAM_50) {
            tier = '3K';
        } else {
            tier = '4K';
        }

        return capResolution(tier, modelId, opts);
    }

    function normalizeAspectRatio(aspectRatio) {
        var value = String(aspectRatio == null ? '' : aspectRatio).trim();
        if (!value || value === 'auto' || value === 'default' || value === 'none') return '';
        return value;
    }

    // ------------------------------------------------------------
    // 请求体构造
    // ------------------------------------------------------------
    function toBase64(data) {
        return String(data == null ? '' : data).replace(/^data:image\/\w+;base64,/, '');
    }

    function toDataUrl(data) {
        var value = String(data == null ? '' : data);
        return /^data:image\//i.test(value) ? value : 'data:image/png;base64,' + value;
    }

    // SeeDream：
    //   画幅不是请求参数，而是拼进提示词文本（", aspect ratio: 16:9"）。
    //   size 直接发档位字符串；5.0 Pro 不支持 sequential_image_generation，故对它不发。
    function buildSeedreamRequest(options) {
        var opts = options || {};
        var model = String(opts.model || SEEDREAM_45);
        var prompt = String(opts.prompt || '');
        var aspectRatio = normalizeAspectRatio(opts.aspectRatio);
        if (aspectRatio) prompt += ', aspect ratio: ' + aspectRatio;

        var referenceImages = (opts.referenceImages || []).filter(Boolean);
        var image;
        if (opts.textToImage) {
            if (referenceImages.length >= 1) image = referenceImages.map(toDataUrl);
        } else if (referenceImages.length >= 1) {
            image = referenceImages.map(toDataUrl);
            if (opts.imageBase64) image.push(toDataUrl(opts.imageBase64));
        } else if (opts.imageBase64) {
            image = toDataUrl(opts.imageBase64);
        }

        var body = {
            model: model,
            prompt: prompt,
            size: normalizeSeedreamResolution(opts.resolution, model),
            watermark: false,
            response_format: 'b64_json',
            optimize_prompt_options: { mode: 'standard' }
        };
        if (typeof image !== 'undefined') body.image = image;
        if (model !== SEEDREAM_50_PRO) body.sequential_image_generation = 'disabled';
        return body;
    }

    // Google：
    //   参考图与主图都作为 inlineData 塞进 parts，文本放最后；
    //   imageConfig.imageSize 才是分辨率，aspectRatio 只在非自动时发；
    //   四类安全阈值全开 BLOCK_NONE，否则棚拍/人体类提示词会被拦。
    function buildGoogleRequest(options) {
        var opts = options || {};
        var model = String(opts.model || NANO_BANANA_PRO);
        var useVertex = opts.useVertexApi === true;
        var prompt = String(opts.prompt || '');

        var parts = [];
        (opts.referenceImages || []).filter(Boolean).forEach(function(data) {
            parts.push({ inlineData: { mimeType: 'image/png', data: toBase64(data) } });
        });
        if (!opts.textToImage && opts.imageBase64) {
            parts.push({ inlineData: { mimeType: 'image/png', data: toBase64(opts.imageBase64) } });
        }
        parts.push({ text: prompt });

        var imageConfig = {};
        if (opts.resolution) imageConfig.imageSize = String(opts.resolution).toUpperCase();
        if (useVertex) {
            imageConfig.imageOutputOptions = { mimeType: 'image/png' };
            imageConfig.personGeneration = 'ALLOW_ALL';
        }
        var aspectRatio = normalizeAspectRatio(opts.aspectRatio);
        if (aspectRatio) imageConfig.aspectRatio = aspectRatio;

        return {
            contents: [{ role: 'user', parts: parts }],
            generationConfig: {
                responseModalities: ['IMAGE'],
                temperature: isFinite(opts.temperature) ? Number(opts.temperature) : 1.0,
                maxOutputTokens: 32768,
                topP: isFinite(opts.topP) ? Number(opts.topP) : 0.90,
                imageConfig: imageConfig
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }
            ]
        };
    }

    var GOOGLE_AI_STUDIO_ENDPOINT = 'https://generativelanguage.googleapis.com';
    var GOOGLE_VERTEX_ENDPOINT = 'https://aiplatform.googleapis.com';

    // Vertex 走 publishers 路径且 key 在 query 上，
    // AI Studio 走 v1beta 路径且 key 走 x-goog-api-key 头。
    function buildGoogleUrl(options) {
        var opts = options || {};
        var model = String(opts.model || NANO_BANANA_PRO).replace(/^models\//i, '');
        var apiName = opts.apiName || 'generateContent';
        if (opts.useVertexApi === true) {
            var vertexBase = String(opts.vertexBaseUrl || GOOGLE_VERTEX_ENDPOINT).replace(/\/+$/, '');
            return vertexBase + '/v1/publishers/google/models/' + model + ':' + apiName +
                (opts.apiKey ? '?key=' + encodeURIComponent(opts.apiKey) : '');
        }
        var studioBase = String(opts.studioBaseUrl || GOOGLE_AI_STUDIO_ENDPOINT)
            .replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/v1beta$/i, '');
        return studioBase + '/v1beta/models/' + model + ':' + apiName;
    }

    // 取图路径：candidates[0].content.parts[].inlineData.data
    function extractGoogleImage(payload) {
        var candidates = (payload && payload.candidates) || [];
        for (var i = 0; i < candidates.length; i++) {
            var parts = (candidates[i] && candidates[i].content && candidates[i].content.parts) || [];
            for (var j = 0; j < parts.length; j++) {
                var inline = parts[j] && parts[j].inlineData;
                if (inline && inline.data) return inline.data;
            }
        }
        return null;
    }

    function extractGoogleErrorMessage(payload) {
        if (!payload) return '';
        var feedback = payload.promptFeedback || {};
        if (typeof feedback.blockReasonMessage === 'string' && feedback.blockReasonMessage.trim()) {
            return '提示词被拦截：' + feedback.blockReasonMessage.trim();
        }
        if (typeof feedback.blockReason === 'string' && feedback.blockReason.trim()) {
            return '提示词被拦截：' + feedback.blockReason.trim();
        }
        if (payload.error && payload.error.message) return String(payload.error.message);
        if (typeof payload.error === 'string') return payload.error;
        return '';
    }

    // 文生图走 generations，带原图则走 edits；
    // aspect_ratio 只在文生图时发（edits 不接受）；未开 NSFW 时前置一句约束。
    function buildXaiRequest(options) {
        var opts = options || {};
        var textToImage = opts.textToImage === true;
        var prompt = String(opts.prompt || '');
        if (!opts.nsfw) prompt = 'No NSFW content allowed.' + prompt;

        var body = {
            model: String(opts.model || GROK_IMAGINE),
            prompt: prompt,
            response_format: 'b64_json',
            resolution: normalizeXaiResolution(opts.resolution)
        };
        if (textToImage) {
            var aspectRatio = normalizeAspectRatio(opts.aspectRatio);
            if (aspectRatio) body.aspect_ratio = aspectRatio;
        } else if (opts.imageBase64) {
            body.image = { url: toDataUrl(opts.imageBase64) };
        }
        return body;
    }

    function buildXaiUrl(baseUrl, textToImage) {
        var base = String(baseUrl || 'https://api.x.ai/v1').replace(/\/+$/, '');
        if (!/\/v\d+$/.test(base)) base += '/v1';
        return base + '/images/' + (textToImage ? 'generations' : 'edits');
    }

    var api = {
        // 模型 ID
        SEEDREAM_45: SEEDREAM_45,
        SEEDREAM_50: SEEDREAM_50,
        SEEDREAM_50_PRO: SEEDREAM_50_PRO,
        NANO_BANANA_PRO: NANO_BANANA_PRO,
        NANO_BANANA_2: NANO_BANANA_2,
        NANO_BANANA_2_PREVIEW: NANO_BANANA_2_PREVIEW,
        GROK_IMAGINE: GROK_IMAGINE,
        GROK_IMAGINE_2: GROK_IMAGINE_2,
        BASE_RESOLUTION: BASE_RESOLUTION,
        MODEL_RESOLUTION_LADDER: MODEL_RESOLUTION_LADDER,
        // 目录
        SEEDREAM_OPTIONS: SEEDREAM_OPTIONS,
        GOOGLE_IMAGE_OPTIONS: GOOGLE_IMAGE_OPTIONS,
        XAI_IMAGE_OPTIONS: XAI_IMAGE_OPTIONS,
        // 判定
        isSeedreamModel: isSeedreamModel,
        isGoogleImageModel: isGoogleImageModel,
        isGrokImagineModel: isGrokImagineModel,
        isSupportedModel: isSupportedModel,
        getProviderForModel: getProviderForModel,
        getResolutionLadder: getResolutionLadder,
        // 分辨率
        capResolution: capResolution,
        pickTier: pickTier,
        normalizeSeedreamResolution: normalizeSeedreamResolution,
        normalizeXaiResolution: normalizeXaiResolution,
        normalizeAspectRatio: normalizeAspectRatio,
        // 请求体
        buildSeedreamRequest: buildSeedreamRequest,
        buildGoogleRequest: buildGoogleRequest,
        buildGoogleUrl: buildGoogleUrl,
        extractGoogleImage: extractGoogleImage,
        extractGoogleErrorMessage: extractGoogleErrorMessage,
        buildXaiRequest: buildXaiRequest,
        buildXaiUrl: buildXaiUrl
    };

    global.HuanmengProviderModels = api;

    // node 下（测试）也要能 require
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
