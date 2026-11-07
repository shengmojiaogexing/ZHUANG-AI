/* ============================================================
 * vfx.js — 图片特效的两条路线
 *
 * 路线 A（本地 CPU）：空间特效 SpaceFX
 *   热浪 / 气流 / 刀光，用位移+高光模拟，不用出网、不用额度。
 *   算法在 space-fx-engine.js，这里负责读选区 → render → 写回图层。
 *
 * 路线 B（AI 生成）：VFX 提示词 + 生成 + 回贴
 *   把「颜色 / 特效类型 / 运动轨迹 / 材质 / 粒子 / 烟雾」拼成一段
 *   强约束的英文提示词，再连同原图发给生图模型，最后精确回贴。
 *
 * 原始位置：
 *   index.js:493-546       DEFAULT_VFX_CONFIG / 预置项 / 提示词母版
 *   index.js:4346-4386     buildVfxPrompt
 *   index.js:6773-6792     generateToolImage（工具类生成）
 *   index.js:4601-4627     applyVfxBlendModeToActiveLayer
 * ============================================================ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HuanmengVfx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

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

    function imageGen() {
        if (root.HuanmengImageGen) return root.HuanmengImageGen;
        if (typeof require === 'function') {
            try { return require('../01-生图API/image-generate.js'); } catch (ignore) {}
        }
        throw new Error('HuanmengImageGen 未加载');
    }

    function spaceFxEngine() {
        if (root.HuanmengSpaceFx) return root.HuanmengSpaceFx;
        if (typeof require === 'function') {
            // 同样是 <script> 风格：require 后从全局读
            try { require('./space-fx-engine.js'); } catch (ignore) {}
            if (root.HuanmengSpaceFx) return root.HuanmengSpaceFx;
        }
        throw new Error('HuanmengSpaceFx 未加载');
    }

    /* ---------------- 配置 ---------------- */

    var DEFAULT_CONFIG = {
        color: '#00f0ff',
        saturation: 82,
        brightness: 100,
        effectPreset: 'energy-trail',
        effectCustomName: '',
        motionPathText: '',
        trajectoryReferenceImage: null,
        materialPreset: 'plasma',
        materialCustomName: '',
        particleText: '',
        smokeEnabled: false,
        smokeText: ''
    };

    var EFFECT_PRESETS = [
        { value: 'energy-trail', label: 'Energy Trail', uiLabel: '能量拖尾' },
        { value: 'neon-outline', label: 'Neon Outline', uiLabel: '霓虹描边' },
        { value: 'glitch-shards', label: 'Glitch Shards', uiLabel: '故障碎片' },
        { value: 'magic-circle', label: 'Magic Circle', uiLabel: '魔法阵' },
        { value: 'light-ribbon', label: 'Light Ribbon', uiLabel: '光带丝带' },
        { value: 'custom', label: 'Custom', uiLabel: '自定义' }
    ];

    var MATERIAL_PRESETS = [
        { value: 'plasma', label: 'plasma light', uiLabel: '等离子光感' },
        { value: 'glassy', label: 'glassy light', uiLabel: '玻璃质光感' },
        { value: 'electric-particles', label: 'electric particles', uiLabel: '电流粒子' },
        { value: 'liquid-fire', label: 'liquid fire', uiLabel: '液态火焰' },
        { value: 'dusty-aura', label: 'dusty aura', uiLabel: '尘雾光环' },
        { value: 'custom', label: 'Custom', uiLabel: '自定义' }
    ];

    var PROMPT_BASE_TEMPLATE = [
        'Preserve the original subject exactly.',
        'Do not change the face, identity, pose, clothing, body proportions, camera framing, or main composition.',
        '',
        'This is a cinematic VFX augmentation task applied on top of the original image,',
        'not a character redraw, not a costume redesign, and not a scene replacement.',
        '',
        'Generate visual effects around the subject with realistic spatial interaction:',
        'the effect must wrap in front of and behind the subject,',
        'create natural occlusion, lighting interaction, grounded reflection, procedural fluid turbulence, and dense volumetric depth,',
        'keep the face unobstructed and readable,',
        'avoid fully covering the subject,',
        'add strong cinematic rim light from the effect onto the character,',
        'and create natural contact haze, environment light bounce, and floor reflection where appropriate.',
        '',
        'The overall result should feel premium, cinematic, layered, intense, realistically composited, and physically grounded,',
        'like a high-end VFX poster, Unreal Engine 5 / Houdini / EmberGen / Niagara hero frame, or commercial key visual,',
        'not a cheap game effect or flat neon overlay.',
        '',
        'Avoid:',
        'face changes, extra fingers, extra limbs, extra characters, perfect circular halos, random symbols, text, logo, watermark, overexposure, muddy glow.'
    ].join('\n');

    function clamp(value, min, max, fallback) {
        var numeric = Number(value);
        if (!isFinite(numeric)) numeric = fallback;
        return numeric < min ? min : (numeric > max ? max : numeric);
    }

    function normalizeText(value, fallback) {
        var text = String(value == null ? '' : value).trim();
        return text || fallback;
    }

    function normalizeHexColor(color, fallback) {
        var value = String(color || '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(value)) {
            return ('#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3]).toLowerCase();
        }
        return fallback || '#00f0ff';
    }

    function hexToRgbText(hex) {
        var color = normalizeHexColor(hex);
        return 'rgb(' + parseInt(color.slice(1, 3), 16) + ', '
            + parseInt(color.slice(3, 5), 16) + ', '
            + parseInt(color.slice(5, 7), 16) + ')';
    }

    function normalizeConfig(config) {
        var source = config || {};
        return {
            color: normalizeHexColor(source.color, DEFAULT_CONFIG.color),
            saturation: clamp(source.saturation, 0, 100, 82),
            brightness: clamp(source.brightness, 0, 200, 100),
            effectPreset: EFFECT_PRESETS.some(function (item) { return item.value === source.effectPreset; })
                ? source.effectPreset : 'energy-trail',
            effectCustomName: normalizeText(source.effectCustomName, ''),
            motionPathText: normalizeText(source.motionPathText, ''),
            trajectoryReferenceImage: source.trajectoryReferenceImage || null,
            materialPreset: MATERIAL_PRESETS.some(function (item) { return item.value === source.materialPreset; })
                ? source.materialPreset : 'plasma',
            materialCustomName: normalizeText(source.materialCustomName, ''),
            particleText: normalizeText(source.particleText, ''),
            smokeEnabled: source.smokeEnabled === true,
            smokeText: normalizeText(source.smokeText, '')
        };
    }

    function effectLabel(value) {
        var found = EFFECT_PRESETS.filter(function (item) { return item.value === value; })[0];
        return found ? found.label : 'energy trail';
    }

    function materialLabel(value) {
        var found = MATERIAL_PRESETS.filter(function (item) { return item.value === value; })[0];
        return found ? found.label : 'plasma light';
    }

    /* ---------------- 提示词 ---------------- */

    /**
     * 生成 VFX 提示词。核心是「只加特效，不动主体」的强约束，
     * 以及把轨迹参考图、烟雾开关这些条件写成明确句子。
     */
    function buildPrompt(config) {
        var normalized = normalizeConfig(config);
        var effectType = normalized.effectPreset === 'custom'
            ? normalizeText(normalized.effectCustomName, 'cinematic energy effect')
            : effectLabel(normalized.effectPreset);
        var materialStyle = normalized.materialPreset === 'custom'
            ? normalizeText(normalized.materialCustomName, 'plasma light')
            : materialLabel(normalized.materialPreset);
        var baseMotionShape = normalizeText(normalized.motionPathText, 'flowing arc around the body');
        var motionShape = normalized.trajectoryReferenceImage
            ? baseMotionShape + ', following the uploaded red trajectory guide reference'
            : baseMotionShape;
        var particleStyle = normalizeText(normalized.particleText, 'glowing particles and trailing sparks');
        var smokeStyle = normalized.smokeEnabled
            ? normalizeText(normalized.smokeText,
                'dense volumetric smoke clouds, procedural fluid dynamics turbulence, intense bloom effect, ray-traced light bounce on environment and floor reflection')
            : 'no smoke or haze';

        return [
            PROMPT_BASE_TEMPLATE,
            '',
            'VFX generation area rule:',
            'Use the current image/selection only as the visual source. Do not force square ratio, do not crop to a small local patch, and do not restrict the effect to a tiny mask area. Let the effect expand naturally across the needed surrounding space while preserving the subject and composition.',
            '',
            'Effect parameters:',
            '- Color: ' + normalized.color + ' (' + hexToRgbText(normalized.color) + ')',
            '- Effect type: ' + effectType,
            '- Motion path: ' + motionShape,
            '- Material style: ' + materialStyle,
            '- Particle details: ' + particleStyle,
            '- Smoke details: ' + smokeStyle,
            '',
            'Add a ' + normalized.color + ' ' + effectType + ' around the subject,',
            'moving in a ' + motionShape + ' pattern,',
            'rendered as ' + materialStyle + ',',
            'with ' + particleStyle + ',',
            normalized.smokeEnabled
                ? 'and accompanied by ' + smokeStyle + '.'
                : 'with a clean, restrained finish and no extra smoke.',
            '',
            'The final effect must feel volumetric, premium, cinematic, spatially grounded, naturally composited into the original image, and driven by industrial-grade turbulence, bloom, reflection, and light bounce.'
        ].join('\n');
    }

    /* ---------------- 路线 B：AI 生成特效 ---------------- */

    /**
     * 用 AI 给选区加特效，并精确回贴。
     *
     * options:
     *   config      VFX 配置（见 DEFAULT_CONFIG）
     *   source      可选 { dataUrl, bounds }；不传则读当前选区/画布
     *   model / apiKey / baseUrl / imageResolution 同生图
     *   placeBack   默认 true；false 时只返回结果不写文档
     */
    async function generateVfx(options) {
        var opts = options || {};
        var psApi = ps();
        var source = opts.source;
        if (!source) {
            var bounds = await psApi.getTargetBounds();
            if (!bounds) throw new Error('请先打开文档或建立选区');
            var base64 = await psApi.captureSelectionBase64(bounds);
            if (!base64) throw new Error('读取选区像素失败');
            source = { dataUrl: 'data:image/png;base64,' + base64, bounds: bounds };
        }

        var prompt = opts.prompt || buildPrompt(opts.config);
        var result = await imageGen().generateImages({
            prompt: prompt,
            model: opts.model,
            provider: opts.provider,
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
            count: 1,
            imageBase64: source.dataUrl,
            sizeHint: source.bounds,
            imageResolution: opts.imageResolution,
            aspectRatio: 'auto',
            applySystemPrompt: false,
            signal: opts.signal,
            settings: opts.settings
        });
        if (!result.success) throw new Error(result.error || '特效生成失败');

        var dataUrl = result.images[0].dataUrl;
        if (opts.placeBack === false) {
            return { dataUrl: dataUrl, prompt: prompt, bounds: source.bounds };
        }
        var layer = await place().placeImageAtBounds(
            dataUrl,
            source.bounds,
            'VFX · ' + (opts.config && opts.config.effectPreset ? effectLabel(normalizeConfig(opts.config).effectPreset) : '生成特效'),
            opts.documentId
        );
        return { dataUrl: dataUrl, prompt: prompt, bounds: source.bounds, layer: layer };
    }

    /* ---------------- 路线 A：本地空间特效 ---------------- */

    /**
     * 本地 CPU 位移特效（热浪 / 气流 / 刀光）。
     * 不联网、不消耗额度，直接在选区像素上算，再作为新图层写回。
     *
     * options:
     *   preset      'heat' | 'airflow' | 'slash'，或直接给 settings
     *   settings    { effect, intensity, range, feather, angle, detail, glow, ... }
     *   bounds / documentId
     *   maxDimension 计算代理尺寸（默认 1600）
     */
    async function applySpaceFx(options) {
        var opts = options || {};
        var psApi = ps();
        var engine = spaceFxEngine();
        var settings = opts.settings || (opts.preset ? engine.preset(opts.preset) : { effect: 'heat' });

        var bounds = opts.bounds || await psApi.getTargetBounds();
        if (!bounds) throw new Error('请先打开文档或建立选区');
        var maxDimension = Number(opts.maxDimension) > 0 ? Number(opts.maxDimension) : 1600;
        var source = await psApi.captureImageData(bounds, { maxDimension: maxDimension });

        var rendered = engine.render(source, settings);
        var layer = await psApi.createPixelLayerWithImage(
            rendered.imageData,
            bounds,
            opts.layerName || ('空间特效 · ' + (rendered.settings.label || rendered.settings.effect)),
            opts.documentId,
            { blendMode: 'normal', commandName: '回写空间特效' }
        );
        return {
            layer: layer,
            bounds: bounds,
            settings: rendered.settings,
            displacementMap: rendered.displacementMap
        };
    }

    return {
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        EFFECT_PRESETS: EFFECT_PRESETS,
        MATERIAL_PRESETS: MATERIAL_PRESETS,
        normalizeConfig: normalizeConfig,
        normalizeHexColor: normalizeHexColor,
        hexToRgbText: hexToRgbText,
        buildPrompt: buildPrompt,
        generateVfx: generateVfx,
        applySpaceFx: applySpaceFx
    };
});
