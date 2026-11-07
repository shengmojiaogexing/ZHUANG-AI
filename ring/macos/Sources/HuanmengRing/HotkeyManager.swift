//
//  HotkeyManager.swift
//  幻梦圆环 · macOS 版
//
//  全局热键（Carbon RegisterEventHotKey）。
//    - 装一个 kEventHotKeyPressed 事件处理器到应用事件目标；
//    - 注册失败返回 false，由 AppController 按候选热键依次尝试；
//    - 命中后回主线程调用 onHotkey（圆环显示 / 隐藏）。
//
//  C 回调通过 Unmanaged.passUnretained(self).toOpaque() 找回 HotkeyManager 实例；
//  HotkeyManager 由 AppController 强引用，生命周期内不会悬挂。
//

import Foundation
// Carbon.HIToolbox 提供 RegisterEventHotKey / InstallEventHandler；
// 额外 import Carbon 保证 CarbonCore 的 OSStatus / OSType 等基础符号可见。
import Carbon
import Carbon.HIToolbox

/// Carbon 热键事件处理器（C 函数指针，不能捕获上下文）。
private let huanmengHotkeyEventHandler: EventHandlerUPP = { _, _, userData in
    guard let userData = userData else { return OSStatus(0) }
    let manager = Unmanaged<HotkeyManager>.fromOpaque(userData).takeUnretainedValue()
    // Carbon 回调可能在事件线程上，统一转主线程再通知业务
    DispatchQueue.main.async {
        manager.onHotkey?()
    }
    return OSStatus(0) // noErr
}

/// 全局热键管理器。
final class HotkeyManager {
    /// 热键触发回调（主线程）
    var onHotkey: (() -> Void)?

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?

    /// 四字符签名 'HMRG'（幻梦圆环 Mac）
    private static let hotkeySignature: OSType = 0x484D5247
    private static let hotkeyID: UInt32 = 1

    deinit {
        unregister()
    }

    /// 注册全局热键；重复调用时会先清掉旧注册。
    /// - Parameters:
    ///   - keyCode: Carbon 虚拟键码（kVK_ANSI_R 等）
    ///   - modifiers: Carbon 修饰键 mask（cmdKey / optionKey / shiftKey / controlKey）
    /// - Returns: 注册成功为 true
    @discardableResult
    func register(keyCode: UInt32, modifiers: UInt32) -> Bool {
        unregister()

        guard installEventHandlerIfNeeded() else {
            return false
        }

        let identifier = EventHotKeyID(signature: HotkeyManager.hotkeySignature, id: HotkeyManager.hotkeyID)
        var newRef: EventHotKeyRef?
        let status = RegisterEventHotKey(
            keyCode,
            modifiers,
            identifier,
            GetApplicationEventTarget(),
            0,
            &newRef
        )
        if status != 0 {
            Log.write("注册全局热键失败：键码=\(keyCode) 修饰键=\(modifiers) 错误码=\(status)")
            return false
        }
        hotKeyRef = newRef
        return true
    }

    func unregister() {
        if let ref = hotKeyRef {
            _ = UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        if let handler = eventHandlerRef {
            _ = RemoveEventHandler(handler)
            eventHandlerRef = nil
        }
    }

    // MARK: - 内部

    /// 安装 kEventHotKeyPressed 处理器；已安装时直接返回 true。
    private func installEventHandlerIfNeeded() -> Bool {
        if eventHandlerRef != nil { return true }

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            huanmengHotkeyEventHandler,
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandlerRef
        )
        if status != 0 {
            Log.write("安装热键事件处理器失败：错误码=\(status)")
            eventHandlerRef = nil
            return false
        }
        return true
    }
}
