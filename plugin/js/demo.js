/* 仅浏览器预览用，不参与 UXP 面板加载 */
(function (root) {
    'use strict';

    root.ZHUANG_DEMO = true;

    function encodeSvg(svg) {
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }

    function mountainScene() {
        return encodeSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">' +
            '<defs>' +
            '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14252e"/><stop offset=".52" stop-color="#526b70"/><stop offset=".78" stop-color="#d9a074"/><stop offset="1" stop-color="#f1c795"/></linearGradient>' +
            '<linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8e8a77"/><stop offset="1" stop-color="#182a2a"/></linearGradient>' +
            '<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff3c4" stop-opacity=".9"/><stop offset=".55" stop-color="#ffd992" stop-opacity=".52"/><stop offset="1" stop-color="#ffd992" stop-opacity="0"/></radialGradient>' +
            '<linearGradient id="vignette" x1="0" y1="0" x2="1" y2="1"><stop offset=".4" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#06100c" stop-opacity=".55"/></linearGradient>' +
            '</defs>' +
            '<rect width="1200" height="800" fill="url(#sky)"/>' +
            '<circle cx="825" cy="465" r="210" fill="url(#sun)"/>' +
            '<path d="M0 472 162 350 295 449 456 292 642 464 790 342 963 456 1100 352 1200 423V800H0Z" fill="#30494c"/>' +
            '<path d="M456 292 495 338 470 353 438 342 415 365 380 386 361 367Z" fill="#dce8e4" opacity=".82"/>' +
            '<path d="M162 350 197 395 169 401 144 388 119 409 91 399Z" fill="#dce8e4" opacity=".7"/>' +
            '<path d="M0 530 178 455 338 533 520 441 696 534 864 466 1042 539 1200 466V800H0Z" fill="#1b3432"/>' +
            '<path d="M0 588 146 548 310 596 472 531 628 601 796 552 958 603 1112 548 1200 573V800H0Z" fill="url(#water)"/>' +
            '<path d="M0 682 216 643 438 686 656 638 890 691 1098 642 1200 669V800H0Z" fill="#0b1b18"/>' +
            '<g fill="#081512">' +
            '<path d="M895 697c12-13 21-14 31 0 7 10 9 24 8 51h-47c-1-27 1-41 8-51Z"/>' +
            '<circle cx="911" cy="678" r="12"/>' +
            '<path d="M898 747h27l8 53h-12l-8-43-7 43h-13Z"/>' +
            '<path d="m929 748 35-26 4 6-34 27Z"/>' +
            '<path d="M963 723v83M949 804h31" stroke="#081512" stroke-width="3"/>' +
            '</g>' +
            '<rect width="1200" height="800" fill="url(#vignette)"/>' +
            '<rect y="760" width="1200" height="40" fill="#071310" opacity=".55"/>' +
            '</svg>'
        );
    }

    function portraitScene() {
        return encodeSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1100" viewBox="0 0 900 1100">' +
            '<defs><radialGradient id="bg" cx=".62" cy=".35" r=".8"><stop offset="0" stop-color="#7c6f58"/><stop offset=".55" stop-color="#3b443b"/><stop offset="1" stop-color="#141d19"/></radialGradient>' +
            '<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffdca4" stop-opacity=".9"/><stop offset="1" stop-color="#ffdca4" stop-opacity="0"/></linearGradient></defs>' +
            '<rect width="900" height="1100" fill="url(#bg)"/>' +
            '<circle cx="560" cy="365" r="142" fill="#d7a77e"/>' +
            '<path d="M418 365c0-105 62-161 144-161 84 0 145 57 145 162 0 43-10 82-28 108-8-80-31-117-75-142-20 43-62 70-113 78-19 3-34 1-45-2-18-48-28-29-28-43Z" fill="#1b211d"/>' +
            '<path d="M315 1100c8-247 91-389 247-389 157 0 238 142 247 389Z" fill="#0d1512"/>' +
            '<path d="M557 704c58 18 111 72 139 153" fill="none" stroke="url(#rim)" stroke-width="22" stroke-linecap="round"/>' +
            '<circle cx="507" cy="378" r="8" fill="#1c211d"/><circle cx="611" cy="378" r="8" fill="#1c211d"/>' +
            '<path d="M531 453c18 12 38 12 56 0" fill="none" stroke="#8f5f4e" stroke-width="5" stroke-linecap="round"/>' +
            '<rect width="900" height="1100" fill="#07100c" opacity=".06"/>' +
            '</svg>'
        );
    }

    function productScene() {
        return encodeSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1100" viewBox="0 0 900 1100">' +
            '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f0e8"/><stop offset="1" stop-color="#d8d2c6"/></linearGradient>' +
            '<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#33463d"/><stop offset=".55" stop-color="#1b2c24"/><stop offset="1" stop-color="#0e1c16"/></linearGradient>' +
            '<linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9c3b6"/><stop offset="1" stop-color="#a8a295"/></linearGradient></defs>' +
            '<rect width="900" height="1100" fill="url(#bg)"/>' +
            '<rect y="775" width="900" height="325" fill="url(#floor)"/>' +
            '<ellipse cx="466" cy="812" rx="245" ry="58" fill="#6b675e" opacity=".18"/>' +
            '<rect x="393" y="274" width="150" height="470" rx="27" fill="url(#glass)"/>' +
            '<rect x="421" y="217" width="94" height="90" rx="15" fill="#1b2b24"/>' +
            '<rect x="437" y="186" width="62" height="45" rx="10" fill="#b69b73"/>' +
            '<rect x="420" y="471" width="96" height="134" rx="9" fill="#ece8dc"/>' +
            '<rect x="438" y="507" width="60" height="4" rx="2" fill="#2f3e34"/>' +
            '<rect x="438" y="522" width="44" height="3" rx="1.5" fill="#a99f8e"/>' +
            '<rect x="438" y="534" width="52" height="3" rx="1.5" fill="#a99f8e"/>' +
            '<path d="M375 744h186v48H375Z" fill="#dbd5c8"/>' +
            '<rect x="710" y="202" width="100" height="148" fill="#e8e2d6" opacity=".7"/>' +
            '<rect x="728" y="228" width="64" height="78" fill="#c6bca9" opacity=".6"/>' +
            '<circle cx="743" cy="252" r="19" fill="#8a9c8e" opacity=".55"/>' +
            '</svg>'
        );
    }

    function neonScene() {
        return encodeSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">' +
            '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#071b24"/><stop offset=".65" stop-color="#113742"/><stop offset="1" stop-color="#0a171c"/></linearGradient>' +
            '<linearGradient id="road" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c3337"/><stop offset="1" stop-color="#071012"/></linearGradient></defs>' +
            '<rect width="1200" height="800" fill="url(#sky)"/>' +
            '<rect x="80" y="210" width="220" height="340" fill="#0a1418"/>' +
            '<rect x="330" y="150" width="170" height="400" fill="#0c1a1e"/>' +
            '<rect x="760" y="190" width="180" height="360" fill="#091417"/>' +
            '<rect x="970" y="130" width="160" height="420" fill="#0b181c"/>' +
            '<g fill="#48d8c2" opacity=".8"><rect x="110" y="250" width="38" height="7"/><rect x="110" y="280" width="62" height="4"/><rect x="110" y="315" width="28" height="6"/><rect x="800" y="240" width="50" height="5"/><rect x="800" y="275" width="22" height="7"/></g>' +
            '<g fill="#ff9a6b" opacity=".8"><rect x="360" y="200" width="84" height="6"/><rect x="360" y="235" width="44" height="4"/><rect x="1000" y="190" width="70" height="5"/></g>' +
            '<circle cx="610" cy="378" r="155" fill="#45d6c2" opacity=".12"/>' +
            '<circle cx="610" cy="378" r="90" fill="#ff8b68" opacity=".18"/>' +
            '<path d="M0 560h1200v240H0Z" fill="url(#road)"/>' +
            '<path d="M472 800 563 560h74l91 240Z" fill="#14282a"/>' +
            '<path d="M563 560h74v240h-74Z" fill="#244448" opacity=".65"/>' +
            '<path d="M602 600v52M602 690v40M602 760v40" stroke="#ffd88c" stroke-width="6" stroke-linecap="round" opacity=".8"/>' +
            '<path d="M0 780h1200v20H0Z" fill="#081214"/>' +
            '<rect width="1200" height="800" fill="#000" opacity=".08"/>' +
            '</svg>'
        );
    }

    var SAMPLES = {
        mountain: mountainScene(),
        portrait: portraitScene(),
        product: productScene(),
        neon: neonScene()
    };

    var startHash = String(root.location && root.location.hash || '').replace('#', '').toLowerCase();
    var startPage = 'create';
    var startResult = true;
    if (startHash === 'settings') { startPage = 'settings'; startResult = false; }
    else if (startHash === 'history') { startPage = 'history'; startResult = false; }
    else if (startHash === 'presets') { startPage = 'presets'; startResult = false; }
    else if (startHash === 'empty') { startPage = 'create'; startResult = false; }

    var now = Date.now();
    var demoHistory = [
        {
            id: 'demo_h_1',
            createdAt: now - 1000 * 60 * 24,
            prompt: '把背景换成雪山日落，保留人物和光线。',
            presetName: '场景替换',
            model: 'grs/nano-banana-2',
            modelName: 'Nano Banana 2',
            resolution: '2K',
            placed: true,
            storage: 'none',
            thumb: SAMPLES.mountain
        },
        {
            id: 'demo_h_2',
            createdAt: now - 1000 * 60 * 60 * 5,
            prompt: '自然精修人像，保留真实肤质和五官。',
            presetName: '人像精修',
            model: 'grs/nano-banana-2-cl',
            modelName: 'Nano Banana 2 高清',
            resolution: '2K',
            placed: true,
            storage: 'none',
            thumb: SAMPLES.portrait
        },
        {
            id: 'demo_h_3',
            createdAt: now - 1000 * 60 * 60 * 27,
            prompt: '产品棚拍质感，柔和主光和轮廓光。',
            presetName: '产品质感',
            model: 'grs/nano-banana-pro',
            modelName: 'Nano Banana Pro',
            resolution: '2K',
            placed: false,
            storage: 'none',
            thumb: SAMPLES.product
        },
        {
            id: 'demo_h_4',
            createdAt: now - 1000 * 60 * 60 * 49,
            prompt: '赛博朋克夜景，霓虹反光，电影感。',
            presetName: '电影调色',
            model: 'grs/nano-banana-2',
            modelName: 'Nano Banana 2',
            resolution: '2K',
            placed: true,
            storage: 'none',
            thumb: SAMPLES.neon
        }
    ];

    try {
        localStorage.removeItem('zhuang_ai_presets_v1');
        localStorage.removeItem('zhuang_ai_ring_presets_seeded_v1');
        localStorage.setItem('zhuang_ai_history_v1', JSON.stringify(demoHistory));
        localStorage.setItem('zhuang_ai_ui_v1', JSON.stringify({
            autoPlace: true,
            storageToken: '',
            storagePath: 'D:\\PS插件\\ZHUANG-AI\\输出',
            lastPresetId: 'background',
            draft: '把背景换成雪山日落，保留人物和光线。'
        }));
        localStorage.setItem('huanmeng_config', JSON.stringify({
            settings: {
                imgModel: 'grs/nano-banana-2.1',
                imgResolution: '2K',
                imgApiKey: 'demo-key',
                grsRegion: 'domestic'
            }
        }));
    } catch (error) {
        console.warn('[demo] 写入演示数据失败', error);
    }

    root.ZhuangDemo = {
        startPage: startPage,
        startResult: startResult,
        context: {
            available: true,
            doc: { id: 1, name: '雪山人像.psd' },
            docName: '雪山人像.psd',
            bounds: { left: 200, top: 200, right: 1400, bottom: 1000, width: 1200, height: 800 },
            hasSelection: true,
            width: 1200,
            height: 800,
            error: ''
        },
        samples: SAMPLES,
        makeResult: function (prompt, presetId, settings) {
            var preset = presetId && root.ZhuangStore ? root.ZhuangStore.findPreset(presetId) : null;
            return {
                id: 'demo_result_' + Date.now(),
                dataUrl: SAMPLES.mountain,
                thumb: SAMPLES.mountain,
                prompt: prompt || '把背景换成雪山日落，保留人物和光线。',
                presetName: preset ? preset.name : '场景替换',
                model: settings ? settings.model : 'grs/nano-banana-2.1',
                modelName: settings ? settings.modelMeta.name : 'Nano Banana 2.1',
                resolution: settings ? settings.resolution : '2K',
                placed: true,
                placeError: '',
                bounds: { left: 200, top: 200, right: 1400, bottom: 1000, width: 1200, height: 800 },
                documentId: 1,
                documentName: '雪山人像.psd',
                createdAt: Date.now()
            };
        }
    };
})(window);
