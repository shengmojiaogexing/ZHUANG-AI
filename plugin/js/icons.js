/* ZHUANG-AI插件 · 单色 SVG 图标
 * 全部内联，无外链、无渐变、无多色。图标颜色跟随 currentColor。
 */
(function (root) {
    'use strict';

    function line(paths, extra) {
        return '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' +
            (extra || '') + '>' + paths + '</g>';
    }

    var ICONS = {
        chat: line('<path d="M4.2 5.2A2.2 2.2 0 0 1 6.4 3h11.2a2.2 2.2 0 0 1 2.2 2.2v8.4a2.2 2.2 0 0 1-2.2 2.2H9.1l-4.1 3v-3.5a2.2 2.2 0 0 1-.8-1.7Z"/><path d="M8.2 8.2h7.6M8.2 11.4h4.8"/>'),
        brush: line('<path d="m14.7 4.1 5.2 5.2-8.8 8.8-5.2-5.2Z"/><path d="m9.1 15.2-3.7 1.2 1.2-3.7"/><path d="M4.2 20.2c1.5.2 2.7-.2 3.5-1.1"/>'),
        sun: line('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>'),
        bolt: '<path fill="currentColor" d="M13.4 2.4 4.8 13h6.1l-.5 8.6L20 10.5h-6.2Z"/>',
        expand: line('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="m9 9-5-5M15 9l5-5M9 15l-5 5M15 15l5 5"/>'),
        workflow: line('<rect x="3" y="3.5" width="5" height="5" rx="1.2"/><rect x="16" y="7.5" width="5" height="5" rx="1.2"/><rect x="3" y="15.5" width="5" height="5" rx="1.2"/><path d="M8 6h4a4 4 0 0 1 4 4v0M8 18h4a4 4 0 0 0 4-4v0"/>'),
        history: line('<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8"/><path d="M3.5 4.2v4.1h4.1"/><path d="M12 7.7v4.7l3.1 1.8"/>'),
        bookmark: line('<path d="M6.2 3.8h11.6a1 1 0 0 1 1 1v15.1l-6.8-4.2-6.8 4.2V4.8a1 1 0 0 1 1-1Z"/>'),
        sliders: line('<path d="M4 7h5.2M15.2 7H20M4 12h10.2M20 12h-1.6M4 17h2.2M11.2 17H20"/><circle cx="12.3" cy="7" r="2.1"/><circle cx="17.3" cy="12" r="2.1"/><circle cx="8.5" cy="17" r="2.1"/>'),
        image: line('<rect x="3.2" y="4.2" width="17.6" height="15.6" rx="2.6"/><circle cx="8.4" cy="9.1" r="1.6"/><path d="m4.8 17.4 4.9-5 3.4 3.4 2.5-2.5 3.6 3.7"/>'),
        smile: line('<circle cx="12" cy="12" r="8.4"/><path d="M8.1 14.1c.9 1.7 2.2 2.5 3.9 2.5s3-.8 3.9-2.5"/><circle cx="9.2" cy="9.6" r=".9" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.6" r=".9" fill="currentColor" stroke="none"/>'),
        refresh: line('<path d="M20 11a8 8 0 0 0-13.6-5.3L3.6 8.5"/><path d="M3.6 4.1v4.4h4.4"/><path d="M4 13a8 8 0 0 0 13.6 5.3l2.8-2.8"/><path d="M20.4 19.9v-4.4h-4.4"/>'),
        chevronDown: line('<path d="m6 9 6 6 6-6"/>'),
        chevronRight: line('<path d="m9 6 6 6-6 6"/>'),
        chevronLeft: line('<path d="m15 6-6 6 6 6"/>'),
        plus: line('<path d="M12 5v14M5 12h14"/>'),
        close: line('<path d="m6 6 12 12M18 6 6 18"/>'),
        send: '<path fill="currentColor" d="M4.2 4.1a1 1 0 0 1 1.1-.2l15 7.2a1 1 0 0 1 0 1.8l-15 7.2a1 1 0 0 1-1.4-1.1l1.2-5.6 8.1-1.4-8.1-1.4-1.2-5.6a1 1 0 0 1 .3-.9Z"/>',
        folder: line('<path d="M3.4 7.2a2 2 0 0 1 2-2h4l2 2.2h7.2a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2Z"/>'),
        trash: line('<path d="M4.4 6.8h15.2M9.2 6.8V4.4h5.6v2.4M6.5 6.8l.8 12.5a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12.5M10 11v5.8M14 11v5.8"/>'),
        check: line('<path d="m4.6 12.4 4.6 4.6L19.6 6.6"/>'),
        person: line('<circle cx="12" cy="8" r="3.6"/><path d="M4.9 20.1c.7-3.8 3.5-5.8 7.1-5.8s6.4 2 7.1 5.8"/>'),
        mountain: line('<path d="m3.2 19.2 6.1-10 4.2 6.6 2.1-3.1 5.2 6.5Z"/><circle cx="17.3" cy="6.4" r="2.1"/>'),
        palette: line('<path d="M12 3.2a8.8 8.8 0 1 0 0 17.6c1.5 0 2.1-.9 2.1-1.9 0-1.2-.8-1.6-.8-2.5 0-.9.7-1.5 1.7-1.5h1.6a3.2 3.2 0 0 0 3.2-3.2A8.8 8.8 0 0 0 12 3.2Z"/><circle cx="7.8" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="6.9" r=".9" fill="currentColor" stroke="none"/><circle cx="14.1" cy="7.2" r=".9" fill="currentColor" stroke="none"/><circle cx="16.6" cy="10.4" r=".9" fill="currentColor" stroke="none"/>'),
        box: line('<path d="m12 3.2 8 4.5v8.6l-8 4.5-8-4.5V7.7Z"/><path d="m4.3 7.9 7.7 4.3 7.7-4.3M12 12.2v8.3"/>'),
        chip: line('<rect x="6.2" y="6.2" width="11.6" height="11.6" rx="2"/><rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1"/><path d="M9.2 3.1v3.1M14.8 3.1v3.1M9.2 17.8v3.1M14.8 17.8v3.1M3.1 9.2h3.1M3.1 14.8h3.1M17.8 9.2h3.1M17.8 14.8h3.1"/>'),
        layers: line('<path d="M12 3.4 21 8.2l-9 4.8-9-4.8Z"/><path d="m3 12.2 9 4.8 9-4.8"/><path d="m3 16.2 9 4.8 9-4.8"/>'),
        flower: line('<path d="M12 11.8c-1.3-3.1-1.8-6.7 1.8-7.3 3.3-.5 3.9 3.2 1.5 5.3M12 11.8c3.1-1.3 6.7-1.8 7.3 1.8.5 3.3-3.2 3.9-5.3 1.5M12 11.8c1.3 3.1 1.8 6.7-1.8 7.3-3.3.5-3.9-3.2-1.5-5.3M12 11.8c-3.1 1.3-6.7 1.8-7.3-1.8-.5-3.3 3.2-3.9 5.3-1.5"/><circle cx="12" cy="11.8" r="1.3"/>'),
        sparkle: '<path fill="currentColor" d="M12 2.8c.4 3.9 2.5 6 6.4 6.4-3.9.4-6 2.5-6.4 6.4-.4-3.9-2.5-6-6.4-6.4 3.9-.4 6-2.5 6.4-6.4Zm6.5 11.3c.2 1.8 1.1 2.7 2.9 2.9-1.8.2-2.7 1.1-2.9 2.9-.2-1.8-1.1-2.7-2.9-2.9 1.8-.2 2.7-1.1 2.9-2.9Z"/>',
        star: '<path fill="currentColor" d="m12 3.2 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8Z"/>',
        eye: line('<path d="M2.8 12s3.4-5.2 9.2-5.2 9.2 5.2 9.2 5.2-3.4 5.2-9.2 5.2S2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.7"/>'),
        download: line('<path d="M12 3.8v10.4M7.6 10l4.4 4.4 4.4-4.4M4.2 16.2v2.6a1.6 1.6 0 0 0 1.6 1.6h12.4a1.6 1.6 0 0 0 1.6-1.6v-2.6"/>'),
        clock: line('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4v5l3.2 1.9"/>'),
        search: line('<circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4.6 4.6"/>'),
        warning: line('<path d="M12 3.8 21 19.5H3Z"/><path d="M12 9.2v4.4"/><circle cx="12" cy="16.5" r=".9" fill="currentColor" stroke="none"/>'),
        link: line('<path d="M9.6 14.4 14.4 9.6"/><path d="M8.2 17.8H7a4.4 4.4 0 0 1 0-8.8h2.7M15.8 6.2H17a4.4 4.4 0 0 1 0 8.8h-2.7"/>'),
        edit: line('<path d="m4.4 19.6 4.3-1 10-10a2.1 2.1 0 0 0-3-3l-10 10-1.3 4Z"/><path d="m13.7 6.7 3 3"/>'),
        more: '<g fill="currentColor"><circle cx="5.2" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.8" cy="12" r="1.4"/></g>',
        play: '<path fill="currentColor" d="M8.3 5.2a1 1 0 0 1 1.5-.9l9.1 6.8a1 1 0 0 1 0 1.8l-9.1 6.8a1 1 0 0 1-1.5-.9Z"/>',
        dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>'
    };

    function svg(name, className) {
        var body = ICONS[name] || ICONS.dot;
        return '<svg class="icon' + (className ? ' ' + className : '') +
            '" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
            body + '</svg>';
    }

    function hydrate(scope) {
        var target = scope || document;
        var nodes = target.querySelectorAll('[data-icon]');
        for (var index = 0; index < nodes.length; index++) {
            var node = nodes[index];
            var name = node.getAttribute('data-icon');
            if (node.getAttribute('data-icon-ready') === name) continue;
            node.innerHTML = svg(name, node.getAttribute('data-icon-class') || '');
            node.setAttribute('data-icon-ready', name);
        }
    }

    root.ZhuangIcons = {
        svg: svg,
        hydrate: hydrate
    };
})(window);
