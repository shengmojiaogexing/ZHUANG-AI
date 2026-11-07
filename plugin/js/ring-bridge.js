/* ZHUANG-AI插件 · 幻梦圆环桥
 *
 * 圆环是 WebSocket 服务端（127.0.0.1:8799），插件是客户端。
 * 插件把预设分类/条目推给圆环；用户在圆环菜单里点预设，
 * 圆环回一条 applyPreset，插件负责把提示词填进创作台。
 */
(function (root) {
    'use strict';

    var ENDPOINT = 'ws://127.0.0.1:8799';
    var RETRY_MIN = 1200;
    var RETRY_MAX = 12000;

    var socket = null;
    var retryTimer = null;
    var retryDelay = RETRY_MIN;
    var connected = false;
    var started = false;
    var handlers = {};

    function status(on, detail) {
        connected = !!on;
        if (typeof handlers.onStatus === 'function') {
            try { handlers.onStatus(connected, detail || ''); } catch (ignore) {}
        }
    }

    function send(payload) {
        if (!connected || !socket || socket.readyState !== 1) return false;
        try {
            socket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            return false;
        }
    }

    function buildState() {
        if (typeof handlers.getState !== 'function') return null;
        try { return handlers.getState(); } catch (error) {
            console.warn('[圆环] 组装状态失败', error);
            return null;
        }
    }

    function pushState() {
        if (!connected) return false;
        var state = buildState();
        if (!state) return false;
        return send({ type: 'state', payload: state });
    }

    function scheduleRetry() {
        if (!started || retryTimer) return;
        retryTimer = setTimeout(function () {
            retryTimer = null;
            connect();
        }, retryDelay);
        retryDelay = Math.min(RETRY_MAX, Math.round(retryDelay * 1.6));
    }

    function handleMessage(raw) {
        var message = null;
        try { message = JSON.parse(String(raw || '{}')); } catch (error) { return; }
        if (!message || message.type !== 'command') return;
        var action = String(message.action || '');
        var payload = message.payload || {};

        if (action === 'applyPreset') {
            if (typeof handlers.onApplyPreset === 'function') {
                try {
                    var result = handlers.onApplyPreset(payload);
                    if (result && result.catch) result.catch(function (error) {
                        console.warn('[圆环] 套用预设失败', error);
                    });
                } catch (error) {
                    console.warn('[圆环] 套用预设失败', error);
                }
            }
            return;
        }
        if (action === 'clearPrompt') {
            if (typeof handlers.onClearPrompt === 'function') {
                try { handlers.onClearPrompt(); } catch (ignore) {}
            }
            return;
        }
        if (action === 'exportPresets') {
            pushState();
        }
        // hello / ping / 其他动作不在这个精简面板里处理。
    }

    function connect() {
        if (!started || socket) return;
        if (typeof root.WebSocket !== 'function') {
            status(false, '当前 UXP 不支持 WebSocket');
            return;
        }
        var next;
        try {
            next = new root.WebSocket(ENDPOINT);
        } catch (error) {
            status(false, '无法创建连接');
            scheduleRetry();
            return;
        }
        socket = next;

        next.onopen = function () {
            if (socket !== next) return;
            retryDelay = RETRY_MIN;
            status(true, '');
            pushState();
        };

        next.onmessage = function (event) {
            handleMessage(event && event.data);
        };

        next.onerror = function () {
            try { next.close(); } catch (ignore) {}
        };

        next.onclose = function () {
            if (socket !== next) return;
            socket = null;
            status(false, '圆环未启动');
            scheduleRetry();
        };
    }

    function start(options) {
        handlers = options || {};
        if (started) {
            if (connected) pushState();
            return;
        }
        started = true;
        status(false, '正在连接幻梦圆环');
        connect();
    }

    function reconnect() {
        if (socket) {
            try { socket.close(); } catch (ignore) {}
            socket = null;
        }
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        retryDelay = RETRY_MIN;
        connect();
    }

    root.ZhuangRingBridge = {
        start: start,
        reconnect: reconnect,
        pushState: pushState,
        isConnected: function () { return connected; }
    };
})(window);
