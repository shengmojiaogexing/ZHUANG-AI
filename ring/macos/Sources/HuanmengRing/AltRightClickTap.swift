//
//  AltRightClickTap.swift
//  幻梦圆环 · macOS 版
//
//  macOS 用 CGEventTap 监听右键按下：
//    - 只在 .rightMouseDown 上挂着，命中 ⌥ 且 allowed() 为 true 时吞掉事件（不弹右键菜单），
//      并回主线程 onTrigger()；
//    - 事件 tap 被系统禁用（超时 / 用户输入）时重新 enable；
//    - 需要「辅助功能」权限：未授权时 start() 返回 false，并每 ~2 秒自动重试，
//      用户授权后无需重启应用；同时监听应用重新激活的事件再试一次。
//
//

import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

/// CGEventTap 的 C 回调（不能捕获上下文）。
private func huanmengAltRightEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
    let tap = Unmanaged<AltRightClickTap>.fromOpaque(userInfo).takeUnretainedValue()
    return tap.handleEvent(type: type, event: event)
}

/// ⌥ + 右键监听。
final class AltRightClickTap {
    private let allowed: () -> Bool
    /// 命中时回调（主线程）
    private let onTrigger: () -> Void

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var runLoop: CFRunLoop?
    private var retryTimer: Timer?
    private var activationObserver: NSObjectProtocol?
    /// 权限提示只记一次，避免每 2 秒刷日志
    private var didLogPermissionHint = false
    /// eventTap 可能在主线程 start/stop 与 tap 回调线程之间来回读写，用锁保护
    private let stateLock = NSLock()

    init(allowed: @escaping () -> Bool, onTrigger: @escaping () -> Void) {
        self.allowed = allowed
        self.onTrigger = onTrigger
    }

    deinit {
        stop()
    }

    // MARK: - 权限

    /// 当前进程是否已有辅助功能权限（不弹提示）。
    static func isTrusted() -> Bool {
        return AXIsProcessTrusted()
    }

    /// 弹系统「辅助功能」授权提示；返回当前是否已授权。
    static func requestTrust() -> Bool {
        // 社区通用写法：kAXTrustedCheckOptionPrompt 在 macOS SDK 里按 Unmanaged<CFString>! 导入。
        // 若换到把它导入成 CFString 的 SDK，改成 [kAXTrustedCheckOptionPrompt as String: true] 即可。
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    // MARK: - 生命周期

    /// 是否已经在监听。
    var isActive: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return eventTap != nil
    }

    /// 开始监听；缺少辅助功能权限时返回 false，并安排自动重试。
    @discardableResult
    func start() -> Bool {
        if isActive {
            // 中途可能被系统禁用，顺手重新启用
            reenableIfNeeded()
            return true
        }

        guard AltRightClickTap.isTrusted() else {
            if !didLogPermissionHint {
                didLogPermissionHint = true
                Log.write("Alt+右键需要辅助功能权限，授权后会自动生效")
            }
            scheduleRetry()
            observeActivation()
            return false
        }

        if installTap() {
            cancelRetry()
            return true
        }
        // 权限有了但 tap 还是创建失败（可能被安全输入禁用），继续重试
        scheduleRetry()
        observeActivation()
        return false
    }

    /// 停止监听，清理 tap / runloop source / 定时器 / 激活通知。
    func stop() {
        cancelRetry()
        removeActivationObserver()

        stateLock.lock()
        let source = runLoopSource
        let tap = eventTap
        let loop = runLoop
        runLoopSource = nil
        eventTap = nil
        runLoop = nil
        stateLock.unlock()

        if let source = source, let loop = loop {
            CFRunLoopRemoveSource(loop, source, .commonModes)
        }
        if let tap = tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
    }

    // MARK: - 事件处理（供 C 回调调用）

    fileprivate func handleEvent(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // 事件 tap 被系统禁用：重新启用，事件继续往下走
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            reenableIfNeeded()
            return Unmanaged.passUnretained(event)
        }

        guard type == .rightMouseDown else {
            return Unmanaged.passUnretained(event)
        }

        // 只在右键按下时检查 Option；命中才回调 UI 并吞掉事件
        if event.flags.contains(.maskAlternate) && allowed() {
            DispatchQueue.main.async { [weak self] in
                self?.onTrigger()
            }
            return nil
        }
        return Unmanaged.passUnretained(event)
    }

    // MARK: - 内部

    /// 创建并启用 CGEventTap。必须在主线程调用（start() 由 AppController 在主线程调）。
    private func installTap() -> Bool {
        let mask = CGEventMask(1) << CGEventType.rightMouseDown.rawValue
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: huanmengAltRightEventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            Log.write("Alt+右键事件监听创建失败")
            clearState()
            return false
        }

        // source 创建失败时不要让 eventTap 留着（否则 isActive 会误报 true）
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CGEvent.tapEnable(tap: tap, enable: false)
            clearState()
            return false
        }
        let currentRunLoop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(currentRunLoop, source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        stateLock.lock()
        eventTap = tap
        runLoopSource = source
        runLoop = currentRunLoop
        stateLock.unlock()

        didLogPermissionHint = false
        Log.write("Alt+右键监听已开启")
        return true
    }

    /// 系统禁用 tap 后重新启用。
    private func reenableIfNeeded() {
        stateLock.lock()
        let tap = eventTap
        stateLock.unlock()
        if let tap = tap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
    }

    /// 清理 tap 状态（不碰定时器）。
    private func clearState() {
        stateLock.lock()
        let source = runLoopSource
        let tap = eventTap
        let loop = runLoop
        runLoopSource = nil
        eventTap = nil
        runLoop = nil
        stateLock.unlock()

        if let source = source, let loop = loop {
            CFRunLoopRemoveSource(loop, source, .commonModes)
        }
        if let tap = tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
    }

    /// 每 2 秒重试一次 start()：用户中途在系统设置里勾选授权后无需重启应用。
    private func scheduleRetry() {
        if retryTimer != nil { return }
        let timer = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if AltRightClickTap.isTrusted() {
                _ = self.start()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
    }

    private func cancelRetry() {
        if let timer = retryTimer {
            timer.invalidate()
            retryTimer = nil
        }
    }

    /// 应用重新激活时（比如从系统设置切回来）立刻再试一次。
    private func observeActivation() {
        if activationObserver != nil { return }
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            if AltRightClickTap.isTrusted() {
                _ = self.start()
            }
        }
    }

    private func removeActivationObserver() {
        if let observer = activationObserver {
            NotificationCenter.default.removeObserver(observer)
            activationObserver = nil
        }
    }
}
