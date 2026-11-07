/* ZHUANG-AI插件 · 静态数据
 * 预设 / 模型目录 / 渠道连接字段
 */
(function (root) {
    'use strict';

    var BUILT_IN_PRESETS = [
        {
            id: 'portrait',
            name: '人像精修',
            desc: '保留真实肤质，自然提亮',
            icon: 'person',
            prompt: '自然精修这张人像：保留真实肤质、五官特征和人物辨识度；柔化阴影，提亮眼神，统一肤色；不要过度磨皮，不要改变脸型和年龄。'
        },
        {
            id: 'background',
            name: '场景替换',
            desc: '主体不变，换掉背景',
            icon: 'mountain',
            prompt: '保留主体的姿势、服装、透视和光线方向，把背景替换为干净通透的雪山日落场景；主体边缘自然融合，色调统一，不要添加多余物体。'
        },
        {
            id: 'cinema',
            name: '电影调色',
            desc: '青橙对比，通透不脏',
            icon: 'palette',
            prompt: '电影感调色：低饱和青橙对比，保留高光与暗部细节，肤色自然不偏黄，画面通透有层次；不要脏灰，不要过度锐化。'
        },
        {
            id: 'product',
            name: '产品质感',
            desc: '棚拍光，干净背景',
            icon: 'box',
            prompt: '把产品处理成高级棚拍质感：柔和主光加轮廓光，材质细节清晰，背景干净，构图居中，阴影自然；不要改变产品形状和文字。'
        },
        {
            id: 'guofeng',
            name: '国风写真',
            desc: '柔和侧光，低饱和',
            icon: 'flower',
            prompt: '新中式国风写真：柔和侧光，低饱和暖色调，细腻皮肤质感，含蓄留白构图；保留人物特征，不要过度装饰和浓妆。'
        },
        {
            id: 'anime',
            name: '动漫转绘',
            desc: '干净线条，二次元',
            icon: 'star',
            prompt: '转绘成干净的日系动漫风格：清晰线稿，柔和赛璐璐上色，保留人物姿势和构图；不要写实皮肤，不要复杂背景。'
        }
    ];

    var MODEL_GROUPS = [
        {
            label: 'GRS · Nano Banana',
            provider: 'grs',
            models: [
                { value: 'grs/nano-banana-2.1', name: 'Nano Banana 2.1', note: '默认 · 1K/2K/4K' },
                { value: 'grs/nano-banana-2', name: 'Nano Banana 2', note: '1K/2K/4K' },
                { value: 'grs/nano-banana-pro', name: 'Nano Banana Pro', note: '复杂画面' },
                { value: 'grs/nano-banana-2-lite', name: 'Nano Banana 2 Lite', note: '便宜' },
                { value: 'grs/nano-banana-fast', name: 'Nano Banana Fast', note: '特价' },
                { value: 'grs/nano-banana-2-cl', name: 'Nano Banana 2 CL', note: '稳定 · 1K' },
                { value: 'grs/nano-banana-pro-cl', name: 'Nano Banana Pro CL', note: '稳定 · 1K' },
                { value: 'grs/nano-banana-2-2k-cl', name: 'Nano Banana 2 2K CL', note: '稳定 · 2K' },
                { value: 'grs/nano-banana-2-4k-cl', name: 'Nano Banana 2 4K CL', note: '稳定 · 4K' },
                { value: 'grs/nano-banana-pro-vip', name: 'Nano Banana Pro VIP', note: '1K/2K' },
                { value: 'grs/nano-banana-pro-4k-vip', name: 'Nano Banana Pro 4K VIP', note: '4K' }
            ]
        },
        {
            label: 'GRS · GPT Image',
            provider: 'grs',
            models: [
                { value: 'grs/gpt-image-2', name: 'GPT Image 2', note: '1K · 指令跟随' },
                { value: 'grs/gpt-image-2-vip', name: 'GPT Image 2 VIP', note: '1K/2K/4K' },
                { value: 'grs/gpt-image-2.5', name: 'GPT Image 2.5', note: '1K' },
                { value: 'grs/gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', note: '1K/2K/4K' },
                { value: 'grs/gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', note: '1K/2K/4K' },
                { value: 'grs/gpt-image-2.6', name: 'GPT Image 2.6', note: '1K · GIF' }
            ]
        },
        {
            label: 'Google AI Studio',
            provider: 'google',
            models: [
                { value: 'google/gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', note: '快速' },
                { value: 'google/gemini-3-pro-image', name: 'Gemini 3 Pro Image', note: '高质量' }
            ]
        },
        {
            label: 'xAI',
            provider: 'xai',
            models: [
                { value: 'xai/grok-imagine-image-2.0', name: 'Grok Imagine 2.0', note: '官方' },
                { value: 'xai/grok-imagine-image-quality', name: 'Grok Imagine Quality', note: '高质量' }
            ]
        },
        {
            label: '火山方舟 · SeeDream',
            provider: 'volcengine',
            models: [
                { value: 'volcengine/doubao-seedream-4-5-251128', name: 'SeeDream 4.5', note: '2K / 4K' },
                { value: 'volcengine/doubao-seedream-5-0-260128', name: 'SeeDream 5.0', note: '2K / 3K' },
                { value: 'volcengine/doubao-seedream-5-0-pro-260628', name: 'SeeDream 5.0 Pro', note: '精细' }
            ]
        },
        {
            label: 'Vertex AI',
            provider: 'vertex-ai',
            models: [
                { value: 'vertex-ai/gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', note: 'Vertex' },
                { value: 'vertex-ai/gemini-3-pro-image', name: 'Gemini 3 Pro Image', note: 'Vertex' }
            ]
        },
        {
            label: 'OpenAI · 兼容',
            provider: 'openai',
            models: [
                { value: 'openai/gpt-image-1', name: 'GPT Image 1', note: '官方 / 兼容' },
                { value: 'openai/gpt-image-1-mini', name: 'GPT Image 1 Mini', note: '快速' }
            ]
        },
        {
            label: 'New API · 中转',
            provider: 'newapi',
            models: [
                { value: 'newapi/gpt-image-1', name: 'GPT Image 1', note: '中转' },
                { value: 'newapi/gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image', note: '中转' }
            ]
        }
    ];

    var PROVIDERS = {
        grs: {
            name: 'GRS',
            keyField: 'imgApiKey',
            urlField: 'imgApiUrl',
            urlPlaceholder: '留空 = 国内直连',
            supportsUrl: true,
            keyHint: '填 GRS 的 API Key，和幻梦 AI 共用同一份配置。'
        },
        google: {
            name: 'Google AI Studio',
            keyField: 'googleApiKey',
            urlField: 'googleApiUrl',
            urlPlaceholder: 'https://generativelanguage.googleapis.com',
            supportsUrl: true,
            keyHint: '在 Google AI Studio 创建的 API Key；走代理/中转时把地址改成中转根地址。'
        },
        xai: {
            name: 'xAI',
            keyField: 'xaiApiKey',
            urlField: 'xaiApiUrl',
            urlPlaceholder: 'https://api.x.ai',
            supportsUrl: true,
            keyHint: 'xAI 官方 API Key；官方地址一般不用改。'
        },
        volcengine: {
            name: '火山方舟',
            keyField: 'volcengineApiKey',
            urlField: 'volcengineApiUrl',
            urlPlaceholder: 'https://ark.cn-beijing.volces.com/api/v3',
            supportsUrl: true,
            keyHint: '火山方舟的 API Key，模型需在控制台开通。'
        },
        'vertex-ai': {
            name: 'Vertex AI',
            keyField: 'vertexApiKey',
            urlField: 'vertexApiUrl',
            urlPlaceholder: 'https://aiplatform.googleapis.com',
            supportsUrl: true,
            keyHint: 'Vertex AI 的 API Key 或接入地址凭据。'
        },
        grok2api: {
            name: 'grok2api',
            keyField: 'grok2apiApiKey',
            urlField: 'grok2apiApiUrl',
            urlPlaceholder: 'http://127.0.0.1:8000',
            supportsUrl: true,
            keyHint: '本地 grok2api 的 Client Key，不是管理员密码。'
        },
        sub2api: {
            name: 'Sub2API',
            keyField: 'sub2apiApiKey',
            urlField: 'sub2apiApiUrl',
            urlPlaceholder: 'http://127.0.0.1:8080',
            supportsUrl: true,
            keyHint: 'Sub2API 后台创建的 sk-... API Key。'
        },
        firefly: {
            name: 'Firefly 兼容服务',
            keyField: 'fireflyApiKey',
            urlField: 'fireflyApiUrl',
            urlPlaceholder: 'http://127.0.0.1:8787',
            supportsUrl: true,
            optionalKey: true,
            keyHint: '本地 Firefly 兼容服务地址；Key 可以留空。'
        },
        newapi: {
            name: 'New API',
            keyField: 'newApiKey',
            urlField: 'newApiUrl',
            urlPlaceholder: 'http://127.0.0.1:3000',
            supportsUrl: true,
            keyHint: 'New API 的密钥，模型可填 Gemini / GPT 图像模型。'
        },
        'newapi-openai': {
            name: 'New API · OpenAI',
            keyField: 'newApiKey',
            urlField: 'newApiUrl',
            urlPlaceholder: 'http://127.0.0.1:3000',
            supportsUrl: true,
            keyHint: 'New API 的密钥，走 OpenAI 兼容图像接口。'
        },
        'newapi-gemini': {
            name: 'New API · Gemini',
            keyField: 'newApiKey',
            urlField: 'newApiUrl',
            urlPlaceholder: 'http://127.0.0.1:3000',
            supportsUrl: true,
            keyHint: 'New API 的密钥，走 Gemini 兼容接口。'
        },
        openai: {
            name: 'OpenAI',
            keyField: 'openaiApiKey',
            urlField: 'openaiApiUrl',
            urlPlaceholder: 'https://api.openai.com',
            supportsUrl: true,
            keyHint: 'OpenAI 官方或兼容接口的 API Key。'
        }
    };

    function parseProvider(value) {
        var text = String(value || '');
        if (text.indexOf('/') < 0) return 'grs';
        var prefix = text.split('/')[0].toLowerCase();
        if (prefix === 'vertex') return 'vertex-ai';
        return prefix;
    }

    function modelName(value) {
        var text = String(value || '');
        return text.indexOf('/') > -1 ? text.split('/').pop() : text;
    }

    function findModel(value) {
        var wanted = String(value || '').toLowerCase();
        var wantedName = modelName(wanted);
        var hasProvider = wanted.indexOf('/') > -1;
        var wantedProvider = hasProvider ? parseProvider(wanted) : '';

        function entry(groupIndex, current) {
            return {
                value: current.value,
                name: current.name,
                note: current.note,
                provider: MODEL_GROUPS[groupIndex].provider,
                group: MODEL_GROUPS[groupIndex].label
            };
        }

        // 1) 完整 value 精确匹配。像 google/gemini-3.1-flash-image 和
        //    vertex-ai/gemini-3.1-flash-image 模型名相同，不能只按名字找，
        //    否则选 Vertex 会被识别成 Google（API Key 也跟着串台）。
        for (var groupIndex = 0; groupIndex < MODEL_GROUPS.length; groupIndex++) {
            var models = MODEL_GROUPS[groupIndex].models;
            for (var index = 0; index < models.length; index++) {
                if (models[index].value.toLowerCase() === wanted) {
                    return entry(groupIndex, models[index]);
                }
            }
        }

        // 2) 同渠道 + 同模型名（兼容没写全前缀的旧配置）
        if (hasProvider) {
            for (var providerIndex = 0; providerIndex < MODEL_GROUPS.length; providerIndex++) {
                if (MODEL_GROUPS[providerIndex].provider !== wantedProvider) continue;
                var providerModels = MODEL_GROUPS[providerIndex].models;
                for (var modelIndex = 0; modelIndex < providerModels.length; modelIndex++) {
                    if (modelName(providerModels[modelIndex].value).toLowerCase() === wantedName) {
                        return entry(providerIndex, providerModels[modelIndex]);
                    }
                }
            }
        }

        // 3) 最后才按裸模型名兜底。
        for (var fallbackIndex = 0; fallbackIndex < MODEL_GROUPS.length; fallbackIndex++) {
            var fallbackModels = MODEL_GROUPS[fallbackIndex].models;
            for (var fallbackModel = 0; fallbackModel < fallbackModels.length; fallbackModel++) {
                if (modelName(fallbackModels[fallbackModel].value).toLowerCase() === wantedName) {
                    return entry(fallbackIndex, fallbackModels[fallbackModel]);
                }
            }
        }

        return {
            value: value || 'grs/nano-banana-2.1',
            name: modelName(value) || 'Nano Banana 2.1',
            note: '当前配置',
            provider: parseProvider(value),
            group: ''
        };
    }

    function providerInfo(value) {
        var provider = typeof value === 'string' && PROVIDERS[value] ? value : parseProvider(value);
        return Object.assign({ id: provider }, PROVIDERS[provider] || PROVIDERS.grs);
    }

    function clonePreset(preset) {
        return {
            id: preset.id,
            name: preset.name,
            desc: preset.desc,
            icon: preset.icon,
            prompt: preset.prompt,
            builtIn: !!preset.builtIn
        };
    }

    function builtIns() {
        return BUILT_IN_PRESETS.map(function (preset) {
            return clonePreset(Object.assign({}, preset, { builtIn: true }));
        });
    }

    root.ZhuangData = {
        builtInPresets: builtIns,
        modelGroups: MODEL_GROUPS,
        providers: PROVIDERS,
        quickPresetIds: ['portrait', 'background', 'cinema'],
        providerInfo: providerInfo,
        findModel: findModel,
        modelName: modelName,
        parseProvider: parseProvider,
        clonePreset: clonePreset
    };
})(window);
