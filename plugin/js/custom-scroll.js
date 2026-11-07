/* ZHUANG-AI插件 · 自绘滚动条（UXP 原生滚动条无法定制，只能自己接管滚动）
 *
 * 原理：
 *   - 目标容器 overflow:hidden，原生滚动条消失；
 *   - 把原内容包进 .uxp-scroll-inner，用 transform: translateY 实现滚动；
 *   - 右侧画一条自绘轨道 + 圆形滑块；
 *   - 滚轮 / 拖拽滑块 / 点击轨道 / 键盘（↑↓ PgUp PgDn Home End）全部自己处理；
 *   - 嵌套滚动容器：内层滚到边界时把事件让给外层。
 *
 * 性能约定（本版重点）：
 *   1. 只测「变化过」的实例：MutationObserver 定位变化节点最近的滚动容器并标脏，
 *      在 requestAnimationFrame 内合并成一次 measure；不再全量刷新、不再 1.5s 轮询。
 *   2. 只测「可见」实例：clientHeight=0（页面隐藏/布局未完成）的数据不测，等
 *      页面激活、ResizeObserver、图片 load、重试链或首次交互时再补测。
 *   3. measure 内部比较新旧 maxScroll / thumb 高度 / 位置，没有变化就不写 style，
 *      避免每次追加内容都产生布局抖动。
 *   4. scrollToBottom 只做一次 dirty 标记 + 一次 rAF 贴底，保留「贴底后内容继续增长
 *      自动跟随」的行为，但不再连开 60ms/220ms 两次全量 measure。
 *   5. 容器若被外部 innerHTML 整体重写（Comfy 工作流列表的写法），measure 会检测到
 *      包裹层丢失并自动重建 .uxp-scroll-inner / .uxp-scroll-bar，滑块不会消失。
 *
 * 对外 API（window.ZhuangScroll）：
 *   refresh(root)        扫描并初始化新容器（不重复 measure 已存在的实例）
 *   scheduleRefresh()    合并后的重扫（兼容旧调用）
 *   scrollToBottom(el)   滚到底部（聊天用，内容变多时自动贴底）
 *   scrollToTop(el)      滚到顶部
 *   getScrollTop(el)     读取自定义滚动位置
 *   setScrollTop(el,v)   设置自定义滚动位置
 *   ensure(el)           初始化/重测指定容器或容器内部（页面激活时调用，返回 inst）
 *   refreshPage(pageEl)  重扫并重测某个页面（接受 'comfy' / 'page-comfy' / 元素）
 *   stats()              只读调试信息（实例数 / 待测数）
 */
(function (root) {
    'use strict';
    if (!root || root.ZhuangScroll) return;

    var SELECTORS = [
        '.chat-scroll',
        '.page-scroll',
        '.modal-body',
        '.category-list',
        '.comfy-wf-list',
        '.comfy-select-menu'
    ];
    var SELECTOR = SELECTORS.join(',');
    var HIDDEN_RETRY_DELAYS = [100, 300, 800, 1500];   // 容器隐藏时补初始化的重试链（约 2.7s）
    var PAGE_VISIBLE_SETTLE = [100, 300];              // 页面刚显示时补测两次，等 UXP 异步布局
    var BAR_INSET = 8;                                 // .uxp-scroll-bar 上下各 inset 4px

    var instances = [];
    var dirtyList = [];
    var flushScheduled = false;
    var refreshTimer = null;
    var pageEnsureTimer = null;
    var pageEnsureQueue = [];
    var resizeObserver = null;

    /* ---------------- 基础工具 ---------------- */

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function toPx(value) {
        var n = parseFloat(value);
        return isFinite(n) ? n : 0;
    }

    function styleOf(el) {
        try {
            if (root.getComputedStyle) return root.getComputedStyle(el);
            if (document.defaultView && document.defaultView.getComputedStyle) {
                return document.defaultView.getComputedStyle(el);
            }
        } catch (ignoreStyle) {}
        return null;
    }

    function matches(el, selector) {
        if (!el || el.nodeType !== 1) return false;
        if (el.matches) return el.matches(selector);
        if (el.msMatchesSelector) return el.msMatchesSelector(selector);
        if (el.webkitMatchesSelector) return el.webkitMatchesSelector(selector);
        return false;
    }

    function closestOf(el, selector) {
        while (el && el.nodeType === 1) {
            if (matches(el, selector)) return el;
            el = el.parentNode;
        }
        return null;
    }

    function classHas(value, name) {
        return (' ' + String(value || '') + ' ').indexOf(' ' + name + ' ') !== -1;
    }

    function isInDocument(el) {
        if (!el) return false;
        if (typeof el.isConnected === 'boolean') return el.isConnected;
        return !!(document.documentElement && document.documentElement.contains(el));
    }

    function nextFrame(fn) {
        if (typeof root.requestAnimationFrame === 'function') {
            return root.requestAnimationFrame(fn);
        }
        return setTimeout(fn, 16);
    }

    /* ---------------- 脏实例合并测量（核心性能优化） ---------------- */

    function scheduleFlush() {
        if (flushScheduled) return;
        flushScheduled = true;
        nextFrame(flushDirty);
    }

    function markDirty(inst) {
        if (!inst || inst.dead) return;
        if (!inst.dirty) {
            inst.dirty = true;
            dirtyList.push(inst);
        }
        scheduleFlush();
    }

    function markDirtyEl(el) {
        if (el && el.__uxpScroll) markDirty(el.__uxpScroll);
    }

    function flushDirty() {
        flushScheduled = false;
        if (!dirtyList.length) return;
        var list = dirtyList;
        dirtyList = [];
        for (var i = 0; i < list.length; i++) {
            var inst = list[i];
            inst.dirty = false;
            if (inst.dead) continue;
            var el = inst.el;
            if (!el || !el.parentNode) continue;
            if (el.clientHeight > 0) measure(inst);
        }
    }

    function markVisibleDirty() {
        for (var i = 0; i < instances.length; i++) {
            var inst = instances[i];
            if (!inst.dead && inst.el && inst.el.parentNode && inst.el.clientHeight > 0) markDirty(inst);
        }
    }

    /* ---------------- 布局样式复制 ---------------- */

    function innerStylesFrom(cs) {
        if (!cs) return null;
        if (cs.display === 'grid') {
            return {
                display: 'grid',
                gridTemplateColumns: cs.gridTemplateColumns,
                gap: cs.gap
            };
        }
        if (cs.display === 'flex') {
            return {
                display: 'flex',
                flexDirection: cs.flexDirection,
                flexWrap: cs.flexWrap,
                gap: cs.gap
            };
        }
        return null;
    }

    function applyInnerStyles(inner, styles) {
        if (!styles) return;
        if (styles.display === 'grid') {
            inner.style.display = 'grid';
            inner.style.gridTemplateColumns = styles.gridTemplateColumns;
            inner.style.gap = styles.gap;
        } else if (styles.display === 'flex') {
            inner.style.display = 'flex';
            inner.style.flexDirection = styles.flexDirection;
            inner.style.flexWrap = styles.flexWrap;
            inner.style.gap = styles.gap;
        }
        inner.style.width = '100%';
    }

    /* ---------------- 测量 / 应用 ---------------- */

    function measure(inst) {
        if (!inst || inst.dead) return;
        var el = inst.el;
        if (!el || !el.parentNode) return;
        // 外部 innerHTML 整体重写后，包裹层可能已经丢失：先修复再测
        ensureWrapped(inst);
        var clientHeight = el.clientHeight;
        if (clientHeight <= 0) {
            // 页面隐藏 / UXP 布局未完成：保持旧状态，等可见性信号再测
            return;
        }

        var viewHeight = Math.max(1, clientHeight - inst.padTop - inst.padBottom);
        var inner = inst.inner;
        var contentHeight = Math.max(inner.scrollHeight || 0, inner.offsetHeight || 0);
        var oldMax = inst.maxScroll;
        var oldTop = inst.scrollTop;
        var maxScroll = Math.max(0, contentHeight - viewHeight);
        var nextTop = inst.scrollTop;

        if (inst.pendingBottom) {
            nextTop = maxScroll;
            inst.pendingBottom = false;
        } else if (oldMax > 0 && oldMax - inst.scrollTop <= 8 && maxScroll > 0) {
            // 原本贴底：内容长高后继续跟随（聊天追加消息的行为）
            nextTop = maxScroll;
        }
        if (nextTop < 0) nextTop = 0;
        else if (nextTop > maxScroll) nextTop = maxScroll;

        inst.viewHeight = viewHeight;
        inst.contentHeight = contentHeight;
        inst.maxScroll = maxScroll;
        inst.scrollTop = nextTop;

        var hideBar = maxScroll <= 0;
        if (inst.barHidden !== hideBar) {
            inst.barHidden = hideBar;
            inst.bar.classList.toggle('is-hidden', hideBar);
        }

        if (!hideBar) {
            var trackHeight = Math.max(24, clientHeight - BAR_INSET);
            var thumbHeight = clamp(trackHeight * (viewHeight / contentHeight), 26, trackHeight);
            inst.trackHeight = trackHeight;
            if (!(Math.abs(thumbHeight - inst.thumbHeight) < 0.5)) {
                inst.thumbHeight = thumbHeight;
                inst.thumb.style.height = thumbHeight + 'px';
            }
            var space = Math.max(1, trackHeight - thumbHeight);
            var thumbPos = (nextTop / maxScroll) * space;
            if (!(Math.abs(thumbPos - inst.thumbPos) < 0.5)) {
                inst.thumbPos = thumbPos;
                inst.thumb.style.transform = 'translateY(' + thumbPos + 'px)';
            }
        } else {
            inst.trackHeight = 0;
        }

        apply(inst);
    }

    function apply(inst) {
        if (inst.appliedScrollTop === inst.scrollTop) return;
        inst.appliedScrollTop = inst.scrollTop;
        inst.inner.style.transform = 'translateY(' + (-inst.scrollTop) + 'px)';
    }

    function updateThumb(inst) {
        if (inst.maxScroll <= 0) return;
        var space = Math.max(1, inst.trackHeight - inst.thumbHeight);
        var pos = (inst.scrollTop / inst.maxScroll) * space;
        if (Math.abs(pos - inst.thumbPos) < 0.5) return;
        inst.thumbPos = pos;
        inst.thumb.style.transform = 'translateY(' + pos + 'px)';
    }

    function scrollTo(inst, value) {
        var maxScroll = inst.maxScroll > 0 ? inst.maxScroll : 0;
        var next = clamp(value, 0, maxScroll);
        if (next === inst.scrollTop) {
            apply(inst);
            return false;
        }
        inst.scrollTop = next;
        apply(inst);
        updateThumb(inst);
        return true;
    }

    function scrollBy(inst, delta) {
        return scrollTo(inst, inst.scrollTop + delta);
    }

    /* ---------------- 包裹层创建 / 修复 ---------------- */

    function makeBar() {
        var bar = document.createElement('div');
        bar.className = 'uxp-scroll-bar is-hidden';
        var thumb = document.createElement('div');
        thumb.className = 'uxp-scroll-thumb';
        bar.appendChild(thumb);
        return { bar: bar, thumb: thumb };
    }

    function wrapChildren(el) {
        var inner = document.createElement('div');
        inner.className = 'uxp-scroll-inner';
        while (el.firstChild) inner.appendChild(el.firstChild);
        return inner;
    }

    // 容器被外部 innerHTML 重写后，把当前内容重新包进新的滚动层（滑块不会丢）
    function ensureWrapped(inst) {
        var el = inst.el;
        var innerOk = inst.inner && inst.inner.parentNode === el;
        var barOk = inst.bar && inst.bar.parentNode === el;
        if (innerOk && barOk) return;
        if (!el) return;

        var nativeTop = el.scrollTop || 0;
        if (inst.inner && inst.inner.parentNode === el) {
            while (inst.inner.firstChild) el.insertBefore(inst.inner.firstChild, inst.inner);
            el.removeChild(inst.inner);
        }
        for (var i = el.children.length - 1; i >= 0; i--) {
            var child = el.children[i];
            if (child.classList && (child.classList.contains('uxp-scroll-bar') ||
                child.classList.contains('uxp-scroll-inner'))) {
                el.removeChild(child);
            }
        }

        var inner = wrapChildren(el);
        applyInnerStyles(inner, inst.innerStyles);
        var parts = makeBar();
        el.appendChild(inner);
        el.appendChild(parts.bar);
        if (nativeTop > 0) inst.scrollTop = nativeTop;
        el.scrollTop = 0;
        el.scrollLeft = 0;

        inst.inner = inner;
        inst.bar = parts.bar;
        inst.thumb = parts.thumb;
        inst.appliedScrollTop = null;
        inst.thumbHeight = 0;
        inst.thumbPos = 0;
        inst.barHidden = null;
        bindBarEvents(inst);
    }

    /* ---------------- 事件绑定 ---------------- */

    function markScrolling(inst) {
        var el = inst.el;
        el.classList.add('is-scrolling');
        if (inst.scrollingTimer) clearTimeout(inst.scrollingTimer);
        inst.scrollingTimer = setTimeout(function () {
            inst.scrollingTimer = null;
            el.classList.remove('is-scrolling');
        }, 750);
    }

    function onWheel(inst, event) {
        var target = event.target;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName || '')) return;
        var delta = event.deltaY;
        if (typeof delta !== 'number' || !isFinite(delta)) {
            delta = event.wheelDelta ? -event.wheelDelta : 0;
        }
        if (!delta) return;
        if (event.deltaMode === 1) delta *= 18;
        else if (event.deltaMode === 2) delta *= (inst.viewHeight || 300) * 0.9;
        var before = inst.scrollTop;
        var step = Math.min(120, Math.max(24, Math.abs(delta)));
        scrollBy(inst, delta > 0 ? step : -step);
        if (inst.scrollTop !== before) {
            markScrolling(inst);
            if (event.preventDefault) event.preventDefault();
            if (event.stopPropagation) event.stopPropagation();
        }
    }

    function isTypingTarget(target) {
        if (!target || target.nodeType !== 1) return false;
        var tag = String(target.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (target.isContentEditable) return true;
        return !!(target.closest && target.closest('[contenteditable="true"]'));
    }

    function isInnerInteractive(target, container) {
        if (!target || target.nodeType !== 1 || target === container) return false;
        if (!target.closest) return false;
        return !!target.closest('[role="button"], button, a, input, textarea, select, [contenteditable="true"]');
    }

    function onKeyDown(inst, event) {
        var key = event.key;
        var target = event.target;
        // 输入框 / 文本域里的按键交给系统处理：否则空格、方向键、Home/End 会被滚动条吞掉
        if (isTypingTarget(target)) return;
        // 子元素是可交互控件（预设卡片、按钮）时，空格应该触发它的点击/套用，而不是滚页面；
        // 方向键 / PageUp/PgDn / Home/End 仍允许滚动列表
        if (key === ' ' && isInnerInteractive(target, inst.el)) return;
        var step = 42;
        var page = Math.max(80, (inst.viewHeight || 300) * 0.9);
        var delta = 0;
        if (key === 'ArrowDown') delta = step;
        else if (key === 'ArrowUp') delta = -step;
        else if (key === 'PageDown' || key === ' ') delta = page;
        else if (key === 'PageUp') delta = -page;
        else if (key === 'Home') delta = -inst.maxScroll;
        else if (key === 'End') delta = inst.maxScroll;
        else return;
        if (scrollBy(inst, delta)) {
            if (event.preventDefault) event.preventDefault();
            if (event.stopPropagation) event.stopPropagation();
        }
    }

    function bindBarEvents(inst) {
        var el = inst.el;

        // 拖拽滑块
        inst.thumb.addEventListener('mousedown', function (event) {
            event.preventDefault();
            event.stopPropagation();
            inst.dragging = true;
            inst.dragStartY = event.clientY;
            inst.dragStartScroll = inst.scrollTop;
            el.classList.add('is-scrolling');
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        });

        function onDragMove(event) {
            if (!inst.dragging) return;
            var space = Math.max(1, inst.trackHeight - inst.thumbHeight);
            var dy = event.clientY - inst.dragStartY;
            scrollTo(inst, inst.dragStartScroll + (dy / space) * inst.maxScroll);
            if (event.preventDefault) event.preventDefault();
        }

        function onDragEnd() {
            inst.dragging = false;
            el.classList.remove('is-scrolling');
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
        }

        // 点击轨道跳转
        inst.bar.addEventListener('mousedown', function (event) {
            if (event.target === inst.thumb) return;
            event.preventDefault();
            event.stopPropagation();
            var rect = inst.bar.getBoundingClientRect();
            var ratio = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
            scrollTo(inst, ratio * inst.maxScroll);
        });
    }

    function bindEl(inst) {
        var el = inst.el;
        var lastWheelAt = 0;

        function wheelHandler(event) {
            lastWheelAt = Date.now();
            onWheel(inst, event);
        }
        var wheelBound = false;
        try {
            el.addEventListener('wheel', wheelHandler, { passive: false });
            wheelBound = true;
        } catch (ignoreWheelOptions) {}
        if (!wheelBound) el.addEventListener('wheel', wheelHandler);
        // 某些 UXP 版本只发 mousewheel；和 wheel 同时出现时避免重复滚动
        el.addEventListener('mousewheel', function (event) {
            if (Date.now() - lastWheelAt < 60) return;
            onWheel(inst, event);
        });
        el.addEventListener('keydown', function (event) { onKeyDown(inst, event); });

        // 防止某些版本仍让原生滚动改变 scrollTop，导致和 transform 叠加
        el.addEventListener('scroll', function () {
            if (el.scrollTop !== 0) el.scrollTop = 0;
            if (el.scrollLeft !== 0) el.scrollLeft = 0;
        });

        // 尺寸变化（UXP 布局异步）时下一帧补测
        el.addEventListener('resize', function () { markDirty(inst); });
        el.addEventListener('mouseenter', function () { markDirty(inst); });
        el.addEventListener('focus', function () { markDirty(inst); });
    }

    /* ---------------- 初始化 / 隐藏页重试 ---------------- */

    function clearPending(el) {
        var state = el.__uxpPending;
        if (state) {
            if (state.timer) clearTimeout(state.timer);
            el.__uxpPending = null;
        }
    }

    function queuePending(el, attempt) {
        if (el.__uxpPending) return;
        var state = { attempt: attempt || 0, timer: null };
        el.__uxpPending = state;
        var delay = HIDDEN_RETRY_DELAYS[Math.min(state.attempt, HIDDEN_RETRY_DELAYS.length - 1)];
        state.timer = setTimeout(function () {
            state.timer = null;
            if (el.__uxpPending !== state) return;
            el.__uxpPending = null;
            if (!el.parentNode || el.__uxpScroll) return;
            if (el.clientHeight > 0) {
                createInstance(el);
                return;
            }
            if (state.attempt < HIDDEN_RETRY_DELAYS.length - 1) {
                queuePending(el, state.attempt + 1);
            }
            // 超过重试窗口仍未可见：交给页面激活钩子 / ResizeObserver / 首次交互兜底
        }, delay);
    }

    function observeResize(inst) {
        if (!resizeObserver) return;
        try {
            resizeObserver.observe(inst.el);
        } catch (ignoreRO) {}
    }

    function createInstance(el) {
        clearPending(el);
        var cs = styleOf(el);
        var initialScrollTop = el.scrollTop || 0;
        var innerStyles = innerStylesFrom(cs);

        var inner = wrapChildren(el);
        applyInnerStyles(inner, innerStyles);
        var parts = makeBar();
        el.appendChild(inner);
        el.appendChild(parts.bar);
        el.classList.add('uxp-scroll');
        // 原生滚动置零，完全由 transform 接管
        el.scrollTop = 0;
        el.scrollLeft = 0;
        if (!el.getAttribute('tabindex')) el.setAttribute('tabindex', '0');

        var inst = {
            el: el,
            inner: inner,
            bar: parts.bar,
            thumb: parts.thumb,
            innerStyles: innerStyles,
            padTop: cs ? toPx(cs.paddingTop) : 0,
            padBottom: cs ? toPx(cs.paddingBottom) : 0,
            scrollTop: initialScrollTop,
            maxScroll: 0,
            viewHeight: 0,
            contentHeight: 0,
            trackHeight: 0,
            thumbHeight: 0,
            thumbPos: 0,
            barHidden: null,
            appliedScrollTop: null,
            dirty: false,
            dead: false,
            dragging: false,
            pendingBottom: false,
            scrollingTimer: null
        };
        el.__uxpScroll = inst;
        instances.push(inst);
        bindEl(inst);
        bindBarEvents(inst);
        observeResize(inst);
        measure(inst);

        // 首次测量时内容可能还没排完（图片/字体/UXP 异步布局）：再补测一次
        setTimeout(function () {
            if (inst.dead || !inst.el.parentNode) return;
            markDirty(inst);
        }, 160);
        return inst;
    }

    function initElement(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.__uxpScroll) return el.__uxpScroll;
        if (!el.parentNode) return null;
        if (el.clientHeight <= 0) {
            if (!el.__uxpPending) queuePending(el, 0);
            return null;
        }
        return createInstance(el);
    }

    /* ---------------- 扫描 / 页面激活 ---------------- */

    function collectContainers(scope) {
        var list = [];
        if (!scope) return list;
        if (scope.nodeType === 1 && matches(scope, SELECTOR)) list.push(scope);
        if (scope.querySelectorAll) {
            var found = scope.querySelectorAll(SELECTOR);
            for (var i = 0; i < found.length; i++) list.push(found[i]);
        }
        return list;
    }

    function markContainersDirty(scope) {
        var list = collectContainers(scope);
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (el.__uxpScroll && el.clientHeight > 0) markDirty(el.__uxpScroll);
        }
    }

    function scanScope(scope) {
        var list = collectContainers(scope);
        for (var i = 0; i < list.length; i++) initElement(list[i]);
        return list;
    }

    function pruneInstances() {
        for (var i = instances.length - 1; i >= 0; i--) {
            var inst = instances[i];
            if (inst.dead) {
                instances.splice(i, 1);
                continue;
            }
            if (!isInDocument(inst.el)) {
                inst.dead = true;
                if (inst.el && inst.el.__uxpScroll === inst) inst.el.__uxpScroll = null;
                if (resizeObserver && inst.el) {
                    try { resizeObserver.unobserve(inst.el); } catch (ignoreUnobserve) {}
                }
                instances.splice(i, 1);
            }
        }
    }

    function refresh(scope) {
        scanScope(scope || document);
        pruneInstances();
    }

    function scheduleRefresh() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            refresh(document);
        }, 80);
    }

    // 页面从 display:none 变为可见：UXP 布局是异步的，多补测几次
    function ensurePage(pageEl, attempt, token) {
        attempt = attempt || 0;
        if (!pageEl || !pageEl.parentNode) return;
        if (typeof token === 'number' && pageEl.__uxpEnsureToken !== token) return;
        if (pageEl.clientHeight > 0) {
            var list = collectContainers(pageEl);
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                initElement(el);
                if (el.__uxpScroll && el.clientHeight > 0) markDirty(el.__uxpScroll);
            }
            if (attempt < PAGE_VISIBLE_SETTLE.length) {
                setTimeout(function () { ensurePage(pageEl, attempt + 1, token); }, PAGE_VISIBLE_SETTLE[attempt]);
            }
        } else if (attempt < HIDDEN_RETRY_DELAYS.length) {
            // class 已切到 is-active，但 clientHeight 还是 0：继续等布局
            setTimeout(function () { ensurePage(pageEl, attempt + 1, token); }, HIDDEN_RETRY_DELAYS[attempt]);
        }
    }

    function schedulePageEnsure(pageEl) {
        if (!pageEl) return;
        // 每次激活递增 token：连续快速切页时旧的重试链会自动失效
        pageEl.__uxpEnsureToken = (pageEl.__uxpEnsureToken || 0) + 1;
        var token = pageEl.__uxpEnsureToken;
        for (var i = 0; i < pageEnsureQueue.length; i++) {
            if (pageEnsureQueue[i].page === pageEl) {
                pageEnsureQueue[i].token = token;
                return;
            }
        }
        pageEnsureQueue.push({ page: pageEl, token: token });
        if (pageEnsureTimer) return;
        pageEnsureTimer = setTimeout(function () {
            pageEnsureTimer = null;
            var list = pageEnsureQueue;
            pageEnsureQueue = [];
            for (var j = 0; j < list.length; j++) {
                ensurePage(list[j].page, 0, list[j].token);
            }
        }, 0);
    }

    /* ---------------- 对外 API ---------------- */

    function getInstance(el) {
        return el && el.__uxpScroll ? el.__uxpScroll : null;
    }

    function ensure(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.__uxpScroll) {
            markDirty(el.__uxpScroll);
            return el.__uxpScroll;
        }
        if (matches(el, SELECTOR)) {
            var inst = initElement(el);
            if (inst) markDirty(inst);
            return inst;
        }
        scanScope(el);
        markContainersDirty(el);
        return null;
    }

    function resolveInstance(el) {
        var inst = getInstance(el);
        if (inst) return inst;
        if (!el || el.nodeType !== 1) return null;
        ensure(el);
        return getInstance(el);
    }

    function refreshPage(target) {
        var el = target;
        if (typeof target === 'string') {
            el = document.getElementById(target) ||
                document.getElementById('page-' + target) ||
                (document.querySelector ? document.querySelector(target) : null);
        }
        if (!el) return;
        if (el.nodeType !== 1) {
            refresh(el);
            return;
        }
        if (el.classList && el.classList.contains('page')) {
            ensurePage(el, 0);
            return;
        }
        if (matches(el, SELECTOR)) {
            ensure(el);
            return;
        }
        scanScope(el);
        markContainersDirty(el);
    }

    function scrollToBottom(el) {
        var inst = resolveInstance(el);
        if (!inst) {
            if (el) el.scrollTop = el.scrollHeight;
            return;
        }
        inst.pendingBottom = true;
        if (inst.maxScroll > 0) scrollTo(inst, inst.maxScroll);
        // 合并到下一帧的 measure：内容刚追加时只读一次布局，而不是每次调用都读
        markDirty(inst);
    }

    function scrollToTop(el) {
        var inst = resolveInstance(el);
        if (inst) {
            inst.pendingBottom = false;
            scrollTo(inst, 0);
            return;
        }
        if (el) el.scrollTop = 0;
    }

    function getScrollTop(el) {
        var inst = getInstance(el);
        return inst ? inst.scrollTop : (el ? el.scrollTop : 0);
    }

    function setScrollTop(el, value) {
        var inst = resolveInstance(el);
        if (inst) {
            inst.pendingBottom = false;
            if (inst.maxScroll <= 0 && inst.contentHeight <= 0) measure(inst);
            scrollTo(inst, Number(value) || 0);
            return;
        }
        if (el) el.scrollTop = Number(value) || 0;
    }

    function stats() {
        return { instances: instances.length, dirty: dirtyList.length };
    }

    var api = {
        refresh: refresh,
        scheduleRefresh: scheduleRefresh,
        scrollToBottom: scrollToBottom,
        scrollToTop: scrollToTop,
        getScrollTop: getScrollTop,
        setScrollTop: setScrollTop,
        ensure: ensure,
        refreshPage: refreshPage,
        stats: stats
    };
    root.ZhuangScroll = api;

    /* ---------------- 监听 / 兜底 ---------------- */

    // DOM 变化：只定位并标记变化的滚动容器，不再全量 refresh
    try {
        if (root.MutationObserver && document.body) {
            var observer = new root.MutationObserver(function (mutations) {
                for (var i = 0; i < mutations.length; i++) {
                    var m = mutations[i];
                    var target = m.target;
                    // 自绘滑块的 class/style 变化不触发测量
                    if (target && target.nodeType === 1 && target.closest && target.closest('.uxp-scroll-bar')) continue;
                    if (m.type === 'childList') {
                        var container = target && target.nodeType === 1
                            ? (target.__uxpScroll ? target : closestOf(target, SELECTOR))
                            : null;
                        if (container) {
                            markDirtyEl(container);
                        } else if (target && target.nodeType === 1) {
                            // 页面 / 弹层整块重渲染：重新扫描新出现的容器
                            scanScope(target);
                        }
                        var added = m.addedNodes;
                        for (var j = 0; j < added.length; j++) {
                            var node = added[j];
                            if (!node || node.nodeType !== 1) continue;
                            var host = node.__uxpScroll ? node : closestOf(node, SELECTOR);
                            if (host) markDirtyEl(host);
                            if (matches(node, SELECTOR)) initElement(node);
                            else if (node.querySelector && node.querySelector(SELECTOR)) scanScope(node);
                        }
                    } else if (m.type === 'attributes') {
                        var attr = m.attributeName;
                        if (attr === 'class') {
                            var oldValue = m.oldValue || '';
                            var newValue = target.className ? String(target.className) : '';
                            var wasHidden = classHas(oldValue, 'hidden');
                            var nowHidden = classHas(newValue, 'hidden');
                            if (wasHidden !== nowHidden) {
                                if (target.__uxpScroll) markDirty(target.__uxpScroll);
                                else if (matches(target, SELECTOR)) initElement(target);
                                else {
                                    var near = closestOf(target, SELECTOR);
                                    if (near) markDirtyEl(near);
                                    else markContainersDirty(target);
                                }
                            }
                            if (target.classList && target.classList.contains('page')) {
                                var wasActive = classHas(oldValue, 'is-active');
                                var isActive = classHas(newValue, 'is-active');
                                if (isActive && !wasActive) schedulePageEnsure(target);
                            }
                        } else if (attr === 'style' || attr === 'hidden') {
                            if (target.__uxpScroll) markDirty(target.__uxpScroll);
                            else if (matches(target, SELECTOR)) initElement(target);
                            else if (target.classList && target.classList.contains('page')) schedulePageEnsure(target);
                        }
                    }
                }
            });
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'hidden', 'style'],
                attributeOldValue: true
            });
        } else {
            // 没有 MutationObserver 的老版本兜底：只测可见实例，频率降低
            setInterval(markVisibleDirty, 1200);
        }
    } catch (ignoreObserver) {
        setInterval(markVisibleDirty, 1200);
    }

    // 容器尺寸变化（隐藏->可见、窗口拖动）时补测
    try {
        if (root.ResizeObserver) {
            resizeObserver = new root.ResizeObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    var el = entries[i].target;
                    if (el && el.__uxpScroll && el.clientHeight > 0) markDirty(el.__uxpScroll);
                }
            });
            for (var roIndex = 0; roIndex < instances.length; roIndex++) observeResize(instances[roIndex]);
        }
    } catch (ignoreResizeObserver) {
        resizeObserver = null;
    }

    if (root.addEventListener) {
        root.addEventListener('resize', markVisibleDirty);
    }

    // 图片/字体改变高度；隐藏页第一次交互时补初始化
    if (document.addEventListener) {
        document.addEventListener('load', function (event) {
            var node = event.target;
            if (!node || node.nodeType !== 1) return;
            var host = closestOf(node, SELECTOR);
            if (host) markDirtyEl(host);
        }, true);
        document.addEventListener('mouseover', function (event) {
            lazyEnsure(event.target);
        }, true);
        document.addEventListener('wheel', function (event) {
            lazyEnsure(event.target);
        }, true);
        document.addEventListener('focusin', function (event) {
            lazyEnsure(event.target);
        }, true);
    }

    function lazyEnsure(node) {
        if (!node || node.nodeType !== 1) return;
        if (node.__uxpScroll) return;
        var host = closestOf(node, SELECTOR);
        if (host && !host.__uxpScroll) initElement(host);
    }

    // 初始扫描（页面首次渲染后才会有容器）
    setTimeout(function () { refresh(document); }, 40);
    setTimeout(function () { refresh(document); }, 300);
})(typeof window !== 'undefined' ? window : this);
