//
//  RingWindow.swift
//  幻梦圆环 · macOS 版
//
//  圆环窗口：透明、无边框、置顶、不激活 App 的 NSPanel + NSHostingView(RingView)。
//  负责唤出 / 收起、按鼠标所在屏幕铺满定位、28ms 轮询鼠标悬停、命中判定、
//  键盘与鼠标交互、110ms 缩放淡入动画。
//

import AppKit
import Foundation
import SwiftUI

final class RingWindowController {
    // MARK: - 外部注入（AppController 赋值）

    /// 查询插件桥是否连接（由 AppController 注入）
    var isBridgeConnected: (() -> Bool)?
    /// 选中预设后的回调（由 AppController 注入；本控制器保证先收起圆环再回调）
    var onApplyPreset: ((Preset) -> Void)?

    // MARK: - 内部状态

    private let config: AppConfig
    private let store: PresetStore
    private let model = RingModel()

    private var panel: RingPanel?
    private var canvasView: RingCanvasView?

    private var hoverTimer: Timer?
    /// 110ms 出现动画
    private var appearTimer: Timer?
    private var appearStart: Date?
    private var isHiding = false
    /// 本地键盘监听（面板成为 key 窗口时接管按键；窗口 keyDown 兜底）
    private var keyMonitor: Any?

    private static let hoverInterval: TimeInterval = 0.028
    private static let appearDuration: TimeInterval = 0.11
    private static let appearFrameInterval: TimeInterval = 1.0 / 60.0

    init(config: AppConfig, store: PresetStore) {
        self.config = config
        self.store = store
    }

    deinit {
        hoverTimer?.invalidate()
        appearTimer?.invalidate()
        if let monitor = keyMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    /// 圆环当前是否显示
    var isVisible: Bool {
        panel?.isVisible == true
    }

    // MARK: - 对外方法

    /// 以鼠标位置为中心唤出圆环，窗口覆盖鼠标所在的那块屏幕。
    func showRing() {
        guard !isVisible else { return }

        let mouseLocation = NSEvent.mouseLocation
        guard let screen = RingWindowController.screen(containing: mouseLocation) else { return }
        let windowFrame = screen.frame

        let panel = ensurePanel()
        guard let canvas = canvasView else { return }
        panel.setFrame(windowFrame, display: false)

        model.level = 0
        model.category = ""
        model.hover = -1
        model.viewSize = windowFrame.size
        if let connected = isBridgeConnected?() {
            model.connected = connected
        }

        // 鼠标位置 → 视图坐标（视图原点左上、y 向下）
        let cursor = RingWindowController.viewPoint(
            forScreenPoint: mouseLocation,
            windowFrame: windowFrame
        )
        let cursorX = Double(cursor.x)
        let cursorY = Double(cursor.y)

        let width = Double(windowFrame.width)
        let height = Double(windowFrame.height)
        var radius = config.outerRadius
        let available = min(width, height)
        if radius * 2.0 + 90.0 > available {
            radius = max(110.0, (available - 90.0) / 2.0)
        }
        let outer = radius
        var inner = radius * (1.0 - config.bandRatio)
        if inner < 54.0 { inner = 54.0 }
        let safe = radius + 42.0

        let centerX: Double
        let centerY: Double
        if cursorX < safe || cursorX > width - safe || cursorY < safe || cursorY > height - safe {
            // 光标贴着屏幕边缘时，按光标画会把圆环切掉一半；
            // 这种情况下宁可退到屏幕中心，保证整个圆环可见。
            centerX = width / 2.0
            centerY = height / 2.0
        } else {
            centerX = cursorX
            centerY = cursorY
        }

        model.outer = outer
        model.inner = inner
        model.center = CGPoint(x: CGFloat(centerX), y: CGFloat(centerY))

        // 先按层重建扇区并刷新一次悬停，再显示窗口
        rebuildItems()
        updateHoverFromMouse()

        if config.animation {
            model.opacity = 0.0
            model.scale = config.appearScale
        } else {
            model.opacity = config.opacity
            model.scale = 1.0
        }

        panel.alphaValue = 1.0
        // 不激活 App 把面板提到最前，再尝试成为 key 窗口以接收键盘：
        // .nonactivatingPanel + orderFrontRegardless 不会把前台从 Photoshop 抢走。
        panel.orderFrontRegardless()
        panel.makeKeyAndOrderFront(nil)
        panel.makeKey()
        _ = panel.makeFirstResponder(canvas)

        startHoverTimer()
        installKeyMonitor()
        if config.animation {
            startAppearAnimation()
        }
    }

    func hideRing() {
        guard !isHiding else { return }
        isHiding = true
        defer { isHiding = false }

        stopHoverTimer()
        stopAppearAnimation()
        removeKeyMonitor()

        _ = panel?.makeFirstResponder(nil)
        panel?.orderOut(nil)

        model.reset()
        model.opacity = config.opacity
        model.scale = 1.0
    }

    func refreshPresets() {
        guard isVisible else { return }
        if model.level == 1 && store.inCategory(model.category).isEmpty {
            model.level = 0
            model.category = ""
        }
        rebuildItems()
        updateHoverFromMouse()
    }

    func setBridgeConnected(_ connected: Bool) {
        model.connected = connected
    }

    // MARK: - 面板创建

    private func ensurePanel() -> RingPanel {
        if let panel = panel { return panel }

        let initialFrame = NSRect(x: 0, y: 0, width: 800, height: 600)
        let panel = RingPanel(
            contentRect: initialFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.isMovable = false
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.acceptsMouseMovedEvents = false

        let canvas = RingCanvasView(frame: initialFrame)
        canvas.controller = self
        canvas.autoresizingMask = [.width, .height]

        // SwiftUI 只负责画；鼠标 / 键盘事件由 RingCanvasView 接管
        let hosting = NSHostingView(rootView: RingView(model: model, config: config))
        hosting.frame = canvas.bounds
        hosting.autoresizingMask = [.width, .height]
        canvas.addSubview(hosting)

        panel.contentView = canvas

        self.panel = panel
        self.canvasView = canvas
        return panel
    }

    // MARK: - 扇区数据

    private func rebuildItems() {
        var items: [RingItem] = []
        if model.level == 0 {
            for category in store.categories {
                items.append(RingItem(
                    title: category,
                    subtitle: "\(store.countInCategory(category)) 条预设"
                ))
            }
        } else {
            for preset in store.inCategory(model.category) {
                items.append(RingItem(
                    title: preset.name,
                    subtitle: preset.category,
                    preset: preset
                ))
            }
        }
        model.items = items
        model.hover = -1
    }

    // MARK: - 悬停轮询

    private func updateHoverFromMouse() {
        guard !isHiding, let panel = panel, !model.items.isEmpty else { return }

        let mouseLocation = NSEvent.mouseLocation
        let point = RingWindowController.viewPoint(
            forScreenPoint: mouseLocation,
            windowFrame: panel.frame
        )
        let distance = RingMath.distance(from: model.center, to: point)
        if distance < model.inner || distance > model.outer + config.popDistance {
            setHover(-1)
            return
        }

        let angle = RingMath.angleDegrees(from: model.center, to: point)
        let count = model.items.count
        let step = RingMath.step(count: count)
        let gap = RingMath.gap(step: step, gapRatio: config.gapRatio, gapMax: config.gapMax)
        let index = RingMath.sectorIndex(angleDegrees: angle, count: count, gap: gap)
        setHover(index)
    }

    private func setHover(_ index: Int) {
        let clamped = (index >= 0 && index < model.items.count) ? index : -1
        if model.hover == clamped { return }
        model.hover = clamped
    }


    fileprivate func handleMouseUp(at point: CGPoint) {
        guard !isHiding, !model.items.isEmpty else { return }

        let distance = RingMath.distance(from: model.center, to: point)
        if distance < model.inner {
            if distance < model.hubRadius {
                hubClick()
            }
            return
        }
        if distance > model.outer + config.popDistance {
            // 点圆环外：关闭
            hideRing()
            return
        }

        let angle = RingMath.angleDegrees(from: model.center, to: point)
        let count = model.items.count
        let step = RingMath.step(count: count)
        let gap = RingMath.gap(step: step, gapRatio: config.gapRatio, gapMax: config.gapMax)
        let index = RingMath.sectorIndex(angleDegrees: angle, count: count, gap: gap)
        activate(index)
    }

    fileprivate func handleRightClick() {
        if model.level == 1 {
            goBackToCategories()
        } else {
            hideRing()
        }
    }


    /// 返回 true 表示按键已消费
    fileprivate func handleKeyDown(_ event: NSEvent) -> Bool {
        guard isVisible else { return false }

        switch event.keyCode {
        case 53: // Esc：预设层返回分类层，分类层关闭
            if model.level == 1 {
                goBackToCategories()
            } else {
                hideRing()
            }
            return true
        case 51, 123: // Backspace / ←：预设层返回分类层
            if model.level == 1 {
                goBackToCategories()
                return true
            }
            return false
        default:
            break
        }

        // 数字键 1-9（主键盘、小键盘统一按字符判断）
        if let characters = event.charactersIgnoringModifiers,
           let first = characters.first,
           let number = Int(String(first)),
           number >= 1, number <= 9 {
            if number - 1 < model.items.count {
                activate(number - 1)
                return true
            }
        }
        return false
    }

    // MARK: - 选择 / 返回

    private func activate(_ index: Int) {
        guard index >= 0, index < model.items.count else { return }
        if model.level == 0 {
            // 分类层：进入该分类的预设层
            model.category = model.items[index].title
            model.level = 1
            model.hover = -1
            rebuildItems()
            updateHoverFromMouse()
            return
        }
        guard let preset = model.items[index].preset else { return }
        hideRing()
        onApplyPreset?(preset)
    }

    private func hubClick() {
        if model.level == 1 {
            goBackToCategories()
        } else {
            hideRing()
        }
    }

    private func goBackToCategories() {
        model.level = 0
        model.category = ""
        model.hover = -1
        rebuildItems()
        updateHoverFromMouse()
    }

    // MARK: - 定时器

    private func startHoverTimer() {
        stopHoverTimer()
        let timer = Timer(timeInterval: RingWindowController.hoverInterval, repeats: true) { [weak self] _ in
            self?.updateHoverFromMouse()
        }
        // .common 模式：窗口拖动 / 菜单跟踪期间也继续跑
        RunLoop.main.add(timer, forMode: .common)
        hoverTimer = timer
    }

    private func stopHoverTimer() {
        hoverTimer?.invalidate()
        hoverTimer = nil
    }


    private func startAppearAnimation() {
        stopAppearAnimation()
        appearStart = Date()
        let timer = Timer(
            timeInterval: RingWindowController.appearFrameInterval,
            repeats: true
        ) { [weak self] _ in
            self?.tickAppearAnimation()
        }
        RunLoop.main.add(timer, forMode: .common)
        appearTimer = timer
    }

    private func tickAppearAnimation() {
        guard let start = appearStart else {
            stopAppearAnimation()
            return
        }
        let elapsed = Date().timeIntervalSince(start)
        let progress = min(1.0, max(0.0, elapsed / RingWindowController.appearDuration))
        let eased = RingMath.easeOutQuad(progress)
        // 透明度 0 → config.opacity；缩放 appearScale → 1
        model.opacity = config.opacity * eased
        model.scale = config.appearScale + (1.0 - config.appearScale) * eased
        if progress >= 1.0 {
            model.opacity = config.opacity
            model.scale = 1.0
            stopAppearAnimation()
        }
    }

    private func stopAppearAnimation() {
        appearTimer?.invalidate()
        appearTimer = nil
        appearStart = nil
    }

    // MARK: - 本地键盘监听

    private func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            guard self.isVisible else { return event }
            // 只接管发给我们圆环面板的按键，其它窗口的按键原样放行
            guard let eventWindow = event.window, eventWindow === self.panel else { return event }
            // 处理完返回 nil：事件不会再走 RingCanvasView.keyDown，不会重复触发
            return self.handleKeyDown(event) ? nil : event
        }
    }

    private func removeKeyMonitor() {
        if let monitor = keyMonitor {
            NSEvent.removeMonitor(monitor)
            keyMonitor = nil
        }
    }

    // MARK: - 坐标 / 屏幕工具

    /// 屏幕坐标（原点左下）→ 视图坐标（原点左上、y 向下）
    private static func viewPoint(forScreenPoint screenPoint: NSPoint, windowFrame: NSRect) -> CGPoint {
        CGPoint(
            x: screenPoint.x - windowFrame.minX,
            y: windowFrame.maxY - screenPoint.y
        )
    }

    /// 取鼠标所在屏幕；找不到时退回主屏 / 第一块屏幕
    private static func screen(containing point: NSPoint) -> NSScreen? {
        for screen in NSScreen.screens where screen.frame.contains(point) {
            return screen
        }
        return NSScreen.main ?? NSScreen.screens.first
    }
}

// MARK: - 面板 / 画布视图

/// 透明置顶面板：圆环显示期间可以成为 key 窗口（不激活 App 的方式），以便接收键盘。
private final class RingPanel: NSPanel {
    override var canBecomeKey: Bool { return true }
    override var canBecomeMain: Bool { return false }
}

/// 圆环画布：把鼠标 / 键盘事件转给 RingWindowController。
private final class RingCanvasView: NSView {
    weak var controller: RingWindowController?

    override var isFlipped: Bool { return true }
    override var acceptsFirstResponder: Bool { return true }

    /// 面板是 .nonactivatingPanel，第一次点击也要直接响应（不吞掉去激活 App）
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }

    /// 鼠标事件全部自己接管（SwiftUI 视图只负责画，不参与命中判定）
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return bounds.contains(local) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        // 非激活面板：点一下也保证成为 key，后续键盘操作才有效
        window?.makeKey()
        _ = window?.makeFirstResponder(self)
    }

    override func mouseUp(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        controller?.handleMouseUp(at: point)
    }

    override func rightMouseDown(with event: NSEvent) {
        controller?.handleRightClick()
    }

    override func keyDown(with event: NSEvent) {
        if controller?.handleKeyDown(event) == true { return }
        super.keyDown(with: event)
    }
}
