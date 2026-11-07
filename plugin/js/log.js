/* ZHUANG-AI插件 · 运行日志
 * 只保留最近 240 条，记录生成 / 回贴 / ComfyUI / 对话 / 系统错误。
 * 不记录 API Key、完整提示词或图片 base64。
 */
(function (root) {
    'use strict';

    var KEY = 'zhuang_ai_logs_v1';
    var MAX = 240;
    var listeners = [];
    var items = read();

    function read() {
        try {
            var raw = root.localStorage && root.localStorage.getItem(KEY);
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(function (item) {
                return item && item.time && item.level && item.scope && item.message;
            }).slice(-MAX);
        } catch (error) {
            return [];
        }
    }

    function persist() {
        try {
            root.localStorage.setItem(KEY, JSON.stringify(items.slice(-MAX)));
        } catch (ignore) {}
    }

    function detailText(detail) {
        if (detail == null) return '';
        if (typeof detail === 'string') return detail.slice(0, 1600);
        if (detail instanceof Error) return String(detail.message || detail).slice(0, 1600);
        try {
            var text = JSON.stringify(detail);
            return text && text.length > 1600 ? text.slice(0, 1600) + '…' : (text || '');
        } catch (error) {
            return String(detail).slice(0, 1600);
        }
    }

    function notify() {
        listeners.slice().forEach(function (listener) {
            try { listener(); } catch (ignore) {}
        });
    }

    function add(level, scope, message, detail) {
        var item = {
            id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
            time: Date.now(),
            level: String(level || 'info'),
            scope: String(scope || '系统'),
            message: String(message == null ? '' : message).slice(0, 1200),
            detail: detailText(detail)
        };
        items.push(item);
        if (items.length > MAX) items = items.slice(-MAX);
        persist();
        try { console.log('[ZhuangLog]', item.level, item.scope, item.message, detail || ''); } catch (ignore) {}
        notify();
        return item;
    }

    function info(scope, message, detail) { return add('info', scope, message, detail); }
    function success(scope, message, detail) { return add('success', scope, message, detail); }
    function warn(scope, message, detail) { return add('warn', scope, message, detail); }
    function error(scope, message, detail) { return add('error', scope, message, detail); }

    function list() { return items.slice(); }
    function clear() { items = []; persist(); notify(); }

    function formatText() {
        return items.map(function (item) {
            var date = new Date(item.time);
            var pad = function (value) { return value < 10 ? '0' + value : String(value); };
            var stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
                ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
            var line = '[' + stamp + '][' + item.level.toUpperCase() + '][' + item.scope + '] ' + item.message;
            return item.detail ? line + '\n  ' + item.detail : line;
        }).join('\n');
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return function () {};
        listeners.push(listener);
        return function () {
            listeners = listeners.filter(function (item) { return item !== listener; });
        };
    }

    root.ZhuangLog = {
        add: add,
        info: info,
        success: success,
        warn: warn,
        error: error,
        list: list,
        clear: clear,
        formatText: formatText,
        subscribe: subscribe
    };
})(window);
