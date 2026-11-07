//
//  AppController.swift
//  幻梦圆环 · macOS 版
//
//    - 旧版托盘 → macOS 菜单栏 NSStatusItem
//    - 旧版全局热键 → Carbon RegisterEventHotKey
//    - 旧版 Alt+右键低级钩子 → CGEventTap 监听 ⌥+右键
//    - 托盘气泡 → 右上角 Toast
//    - WebSocket 桥：插件是客户端，圆环是服务端
//    - 点预设：复制 prompt + 发 applyPreset 给插件
//

import AppKit

final class AppController: NSObject, NSMenuDelegate {
    private let arguments: [String]
    private let config: AppConfig
    private let store: PresetStore
    private let bridge: BridgeServer
    private let ring: RingWindowController
    private let toast = ToastController()
    private let hotkey = HotkeyManager()
    private var altRightTap: AltRightClickTap?

    private var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var showMenuItem: NSMenuItem?
    private var accessibilityMenuItem: NSMenuItem?
    private var activeHotkey = HotkeySpec.defaultMac
    private var hotkeyRegistered = false
    private var showObserver: NSObjectProtocol?
    private var shutdownDone = false

    init(arguments: [String]) {
        self.arguments = arguments
        let config = AppConfig.load()
        let store = PresetStore()
        let bridge = BridgeServer(port: config.port)
        let ring = RingWindowController(config: config, store: store)

        self.config = config
        self.activeHotkey = config.hotkey
        self.store = store
        self.bridge = bridge
        self.ring = ring
        super.init()

        // 此时 self 的存储属性都已就位，可以注入闭包
        ring.isBridgeConnected = { [weak self] in
            self?.bridge.isConnected ?? false
        }
        ring.onApplyPreset = { [weak self] preset in
            self?.applyPreset(preset)
        }
    }

    // MARK: - 启动 / 收尾

    func start() {
        setupStatusItem()
        store.loadLocal()
        setupBridge()
        registerHotkey()
        installAltRightTap()
        observeShowNotification()
        updateStatus()

        if arguments.contains("--show") {
            DispatchQueue.main.async { [weak self] in
                self?.showOrToggleRing()
            }
        }

        Log.write("幻梦圆环已启动：热键=\(activeHotkey.display) 端口=\(config.port) 预设=\(store.count) 条")
    }

    func shutdown() {
        if shutdownDone { return }
        shutdownDone = true

        hotkey.unregister()
        altRightTap?.stop()
        altRightTap = nil
        bridge.stop()
        if let observer = showObserver {
            DistributedNotificationCenter.default().removeObserver(observer)
            showObserver = nil
        }
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
        Log.write("幻梦圆环已退出")
    }

    // MARK: - 菜单栏

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = AppController.makeStatusIcon()
            button.image?.isTemplate = true
            button.toolTip = "幻梦圆环 · 预设"
        }

        let menu = NSMenu()
        menu.delegate = self

        let showItem = NSMenuItem(
            title: "显示圆环 (\(activeHotkey.display))",
            action: #selector(showRingMenuAction),
            keyEquivalent: ""
        )
        showItem.target = self
        menu.addItem(showItem)
        showMenuItem = showItem

        let status = NSMenuItem(title: "插件：未连接", action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        statusMenuItem = status

        menu.addItem(NSMenuItem.separator())

        let reload = NSMenuItem(title: "重载本地预设", action: #selector(reloadPresetsAction), keyEquivalent: "")
        reload.target = self
        menu.addItem(reload)

        let openPreset = NSMenuItem(title: "打开预设文件", action: #selector(openPresetFileAction), keyEquivalent: "")
        openPreset.target = self
        menu.addItem(openPreset)

        let openConfig = NSMenuItem(title: "打开配置文件", action: #selector(openConfigFileAction), keyEquivalent: "")
        openConfig.target = self
        menu.addItem(openConfig)

        menu.addItem(NSMenuItem.separator())

        let accessibility = NSMenuItem(
            title: "辅助功能权限",
            action: #selector(grantAccessibilityAction),
            keyEquivalent: ""
        )
        accessibility.target = self
        menu.addItem(accessibility)
        accessibilityMenuItem = accessibility

        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(title: "退出幻梦圆环", action: #selector(quitAction), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)

        item.menu = menu
        statusItem = item
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        showMenuItem?.title = "显示圆环 (\(activeHotkey.display))"

        let connected = bridge.isConnected
        statusMenuItem?.title = connected ? "插件：已连接" : "插件：未连接"

        if !config.altRightClick {
            accessibilityMenuItem?.title = "⌥右键唤出已在配置里关闭"
            accessibilityMenuItem?.action = nil
            accessibilityMenuItem?.target = nil
        } else if AltRightClickTap.isTrusted() && (altRightTap?.isActive ?? false) {
            accessibilityMenuItem?.title = "辅助功能权限：已授权 ✓"
            accessibilityMenuItem?.action = nil
            accessibilityMenuItem?.target = nil
        } else {
            accessibilityMenuItem?.title = "⚠️ 点这里授予辅助功能权限（⌥右键需要）"
            accessibilityMenuItem?.action = #selector(grantAccessibilityAction)
            accessibilityMenuItem?.target = self
        }
    }

    private static func makeStatusIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            let center = NSPoint(x: rect.midX, y: rect.midY)
            let ringRect = NSRect(x: center.x - 6, y: center.y - 6, width: 12, height: 12)
            let ring = NSBezierPath(ovalIn: ringRect)
            ring.lineWidth = 2.2
            NSColor.black.setStroke()
            ring.stroke()

            NSColor.black.setFill()
            let dotRect = NSRect(x: center.x - 1.6, y: center.y - 1.6, width: 3.2, height: 3.2)
            NSBezierPath(ovalIn: dotRect).fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    // MARK: - 桥接

    private func setupBridge() {
        bridge.onMessage = { [weak self] raw in
            self?.handleBridgeMessage(raw)
        }
        bridge.onConnectionChanged = { [weak self] connected in
            self?.handleBridgeConnection(connected)
        }

        if !bridge.start() {
            Log.write("桥接端口启动失败：\(config.port)")
            toast.show(
                title: "幻梦圆环",
                message: "桥接端口 \(config.port) 启动失败，可能旧圆环还在运行",
                isWarning: true
            )
        }
    }

    private func handleBridgeConnection(_ connected: Bool) {
        ring.setBridgeConnected(connected)
        if connected {
            sendHello()
        }
        updateStatus()
    }

    private func sendHello() {
        let message: [String: Any] = [
            "type": "hello",
            "app": "幻梦圆环",
            "version": "2.0.0",
            "os": "macos"
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else {
            Log.write("发送 hello 失败：JSON 序列化失败")
            return
        }
        _ = bridge.send(text)
    }

    private func handleBridgeMessage(_ raw: String) {
        if raw.isEmpty { return }
        guard let data = raw.data(using: .utf8) else { return }
        do {
            guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return
            }
            if Json.string(message, "type", "") != "state" { return }
            guard let payload = message["payload"] as? [String: Any] else { return }

            if store.applyPluginState(payload) {
                ring.refreshPresets()
                updateStatus()
            }
        } catch {
            Log.write("解析插件 state 失败：\(error.localizedDescription)")
        }
    }

    private func updateStatus() {
        let connected = bridge.isConnected
        statusMenuItem?.title = connected ? "插件：已连接" : "插件：未连接"
        let mode = connected ? "插件在线" : "插件离线"
        statusItem?.button?.toolTip = "幻梦圆环 · \(store.count) 条 · \(mode)"
    }

    // MARK: - 套用预设

    private func applyPreset(_ preset: Preset) {
        let copied = copyText(preset.prompt)
        var applied = false
        if bridge.isConnected {
            applied = sendApplyPreset(preset)
            Log.write("套用预设：\(preset.category) / \(preset.name) 发送=\(applied)")
        }

        let message: String
        if applied && copied {
            message = "已复制并套用：\(preset.name)"
        } else if applied {
            message = "已套用到插件：\(preset.name)"
        } else if copied {
            message = "已复制：\(preset.name)（插件未连接）"
        } else {
            message = "复制失败，插件也未连接：\(preset.name)"
        }
        toast.show(title: "幻梦圆环", message: message, isWarning: !applied)
    }

    private func copyText(_ text: String) -> Bool {
        for attempt in 0..<6 {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            if pasteboard.setString(text, forType: .string) {
                return true
            }
            if attempt == 5 {
                Log.write("复制预设失败")
            }
            Thread.sleep(forTimeInterval: 0.045)
        }
        return false
    }

    private func sendApplyPreset(_ preset: Preset) -> Bool {
        let payload: [String: Any] = [
            "name": preset.name,
            "category": preset.category
        ]
        let message: [String: Any] = [
            "type": "command",
            "id": UUID().uuidString.replacingOccurrences(of: "-", with: ""),
            "action": "applyPreset",
            "payload": payload,
            "resolved": true
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: message)
            guard let text = String(data: data, encoding: .utf8) else { return false }
            return bridge.send(text)
        } catch {
            Log.write("发送套用预设失败：\(error.localizedDescription)")
            return false
        }
    }

    // MARK: - 唤出 / 关闭

    func showOrToggleRing() {
        if ring.isVisible {
            ring.hideRing()
            return
        }
        if store.count == 0 {
            toast.show(
                title: "幻梦圆环",
                message: "没有可用预设，请先启动 Photoshop 插件或检查预设文件",
                isWarning: true
            )
            return
        }
        ring.setBridgeConnected(bridge.isConnected)
        ring.showRing()
    }

    // MARK: - 热键

    private func registerHotkey() {
        var candidates: [HotkeySpec] = [config.hotkey]
        if let altShiftR = HotkeySpec.parse("cmd+alt+shift+r") {
            candidates.append(altShiftR)
        }
        if let altShiftF9 = HotkeySpec.parse("cmd+shift+alt+f9") {
            candidates.append(altShiftF9)
        }

        hotkey.onHotkey = { [weak self] in
            self?.showOrToggleRing()
        }

        for (index, spec) in candidates.enumerated() {
            if hotkey.register(keyCode: spec.keyCode, modifiers: spec.carbonModifiers) {
                activeHotkey = spec
                hotkeyRegistered = true
                showMenuItem?.title = "显示圆环 (\(spec.display))"
                Log.write("热键已注册：\(spec.display)")
                if index > 0 {
                    toast.show(
                        title: "幻梦圆环",
                        message: "\(config.hotkey.display) 被占用，已改用 \(spec.display)",
                        isWarning: false
                    )
                }
                return
            }
            Log.write("热键候选失败：\(spec.display)")
        }

        Log.write("注册热键失败：\(config.hotkey.display)")
        toast.show(
            title: "幻梦圆环",
            message: "热键注册失败，可能被占用；可以从菜单栏打开圆环",
            isWarning: true
        )
    }

    // MARK: - ⌥+右键

    private func installAltRightTap() {
        if !config.altRightClick {
            Log.write("配置关闭了 ⌥右键唤出")
            return
        }

        let tap = AltRightClickTap(
            allowed: { [weak self] in
                self?.isAltRightAllowed() ?? false
            },
            onTrigger: { [weak self] in
                guard let self = self, !self.shutdownDone else { return }
                self.showOrToggleRing()
            }
        )
        altRightTap = tap

        let trusted = AltRightClickTap.isTrusted()
        if !trusted {
            _ = AltRightClickTap.requestTrust()
            Log.write("尚未获得辅助功能权限，弹出授权提示并等待授权")
        }
        if tap.start() {
            Log.write("⌥右键监听已启动")
        } else {
            Log.write("⌥右键监听暂不可用（等待辅助功能权限）")
            toast.show(
                title: "幻梦圆环",
                message: "⌥右键监听没装上（需要辅助功能权限），快捷键和菜单栏仍可用",
                isWarning: true
            )
        }
    }

    private func isAltRightAllowed() -> Bool {
        if !config.altRightClick { return false }
        let scope = config.altRightScope
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if scope == "off" { return false }
        if scope == "photoshop" {
            guard let application = NSWorkspace.shared.frontmostApplication else { return false }
            if let bundleIdentifier = application.bundleIdentifier,
               bundleIdentifier.lowercased().contains("photoshop") {
                return true
            }
            if let name = application.localizedName, name.lowercased().contains("photoshop") {
                return true
            }
            return false
        }
        return true
    }

    // MARK: - 第二个实例通知

    private func observeShowNotification() {
        showObserver = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.huanmeng.ring.show"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.showOrToggleRing()
        }
    }

    // MARK: - 菜单动作

    @objc private func showRingMenuAction() {
        showOrToggleRing()
    }

    @objc private func reloadPresetsAction() {
        store.loadLocal()
        ring.refreshPresets()
        updateStatus()
        toast.show(title: "幻梦圆环", message: "已重载 \(store.count) 条预设", isWarning: false)
    }

    @objc private func openPresetFileAction() {
        if !FileManager.default.fileExists(atPath: AppPaths.presetPath) {
            store.saveLocal(backup: false)
        }
        if FileManager.default.fileExists(atPath: AppPaths.presetPath) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: AppPaths.presetPath)])
        } else {
            Log.write("打开预设文件失败：文件不存在")
            toast.show(title: "幻梦圆环", message: "打不开预设文件", isWarning: true)
        }
    }

    @objc private func openConfigFileAction() {
        AppConfig.writeDefaultConfigIfMissing()
        if FileManager.default.fileExists(atPath: AppPaths.configPath) {
            NSWorkspace.shared.open(URL(fileURLWithPath: AppPaths.configPath))
        } else {
            Log.write("打开配置文件失败：\(AppPaths.configPath)")
            toast.show(title: "幻梦圆环", message: "打不开配置文件", isWarning: true)
        }
    }

    @objc private func grantAccessibilityAction() {
        _ = AltRightClickTap.requestTrust()
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quitAction() {
        shutdown()
        NSApp.terminate(nil)
    }
}
