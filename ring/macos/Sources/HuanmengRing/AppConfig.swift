//
//  AppConfig.swift
//  幻梦圆环 · macOS 版
//
//  配置读取 / 热键解析 / 路径 / 日志 / JSON 工具。
//    - AppPaths：配置文件 / 预设文件 / 包内预设 / 日志位置
//    - Log：带时间戳追加写日志，永不抛错
//    - AppConfig：读取 ~/.huanmeng-ring.json，字段名与旧版逐字一致
//    - Json：JSONSerialization 产物的取值工具
//    - HotkeySpec：把 "ctrl+alt+r" 一类文本解析成 Carbon 热键
//
//  热键在 macOS 上的映射约定：
//    ctrl/control → ⌃ Control（mac 原生含义）
//    alt/option   → ⌥ Option
//    shift        → ⇧ Shift
//    cmd/command/win/windows → ⌘ Command
//  但旧默认热键 "ctrl+alt+r" 是按旧版习惯定的，mac 上按习惯迁移成 ⌥⌘R；
//  想用真正的 Control+Option+R 就写 "control+alt+r"。
//

import Foundation
import Carbon.HIToolbox

// MARK: - 路径

enum AppPaths {
    static let home: String = FileManager.default.homeDirectoryForCurrentUser.path

    /// ~/.huanmeng-ring.json（跨平台共用同一个文件）
    static var configPath: String {
        (home as NSString).appendingPathComponent(".huanmeng-ring.json")
    }

    /// ~/.huanmeng-presets.json（和插件共用）
    static var presetPath: String {
        (home as NSString).appendingPathComponent(".huanmeng-presets.json")
    }

    /// ~/.huanmeng-presets.backup.json（第一次被插件覆盖前备份）
    static var presetBackupPath: String {
        (home as NSString).appendingPathComponent(".huanmeng-presets.backup.json")
    }

    static var logPath: String {
        (NSTemporaryDirectory() as NSString).appendingPathComponent("huanmeng-ring-mac.log")
    }

    /// 包内自带的 presets.json 候选路径：.app/Contents/Resources、可执行文件旁、开发目录
    static var bundledPresetCandidates: [String] {
        var result: [String] = []

        if let resourceURL = Bundle.main.resourceURL {
            result.append(resourceURL.appendingPathComponent("presets.json").path)
        }
        if let executableURL = Bundle.main.executableURL?.resolvingSymlinksInPath() {
            let executableDirectory = executableURL.deletingLastPathComponent()
            // .app/Contents/Resources/presets.json
            result.append(
                executableDirectory
                    .deletingLastPathComponent()
                    .appendingPathComponent("Resources/presets.json")
                    .path
            )
            // 可执行文件同目录（swift run / 便携目录）
            result.append(executableDirectory.appendingPathComponent("presets.json").path)
        }

        let currentDirectory = FileManager.default.currentDirectoryPath
        result.append((currentDirectory as NSString).appendingPathComponent("Resources/presets.json"))
        result.append((currentDirectory as NSString).appendingPathComponent("presets.json"))

        return result
    }

    static func firstExistingBundledPreset() -> String? {
        for path in bundledPresetCandidates where FileManager.default.fileExists(atPath: path) {
            return path
        }
        return nil
    }
}

// MARK: - 日志

enum Log {
    private static let lock = NSLock()
    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    /// 追加一行日志；任何异常都静默吞掉，不能影响主流程。
    static func write(_ message: String) {
        lock.lock()
        defer { lock.unlock() }

        let line = formatter.string(from: Date()) + "  " + message + "\n"
        guard let data = line.data(using: .utf8) else { return }
        let path = AppPaths.logPath

        if FileManager.default.fileExists(atPath: path) {
            if let handle = FileHandle(forWritingAtPath: path) {
                defer { try? handle.close() }
                handle.seekToEndOfFile()
                handle.write(data)
                return
            }
        }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}

// MARK: - JSON 取值

enum Json {
    static func dict(_ source: [String: Any]?, _ key: String) -> [String: Any]? {
        guard let source = source, let value = source[key] as? [String: Any] else { return nil }
        return value
    }

    static func string(_ source: [String: Any]?, _ key: String, _ fallback: String) -> String {
        guard let source = source, let value = source[key] else { return fallback }
        if value is NSNull { return fallback }
        if let text = value as? String { return text.isEmpty ? fallback : text }
        if let number = value as? NSNumber { return number.stringValue }
        return fallback
    }

    static func int(_ source: [String: Any]?, _ key: String, _ fallback: Int) -> Int {
        guard let source = source, let value = source[key] else { return fallback }
        if value is NSNull { return fallback }
        if let number = value as? NSNumber { return number.intValue }
        if let text = value as? String, let number = Int(text) { return number }
        return fallback
    }

    static func double(_ source: [String: Any]?, _ key: String, _ fallback: Double) -> Double {
        guard let source = source, let value = source[key] else { return fallback }
        if value is NSNull { return fallback }
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String, let number = Double(text) { return number }
        return fallback
    }

    static func bool(_ source: [String: Any]?, _ key: String, _ fallback: Bool) -> Bool {
        guard let source = source, let value = source[key] else { return fallback }
        if value is NSNull { return fallback }
        if let boolean = value as? Bool { return boolean }
        if let number = value as? NSNumber { return number.boolValue }
        if let text = value as? String {
            let lowered = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if lowered == "true" || lowered == "1" { return true }
            if lowered == "false" || lowered == "0" { return false }
        }
        return fallback
    }
}

// MARK: - 热键

struct HotkeySpec {
    /// Carbon 虚拟键码（kVK_ANSI_R 等）
    var keyCode: UInt32
    /// Carbon 修饰键 mask（cmdKey / optionKey / shiftKey / controlKey）
    var carbonModifiers: UInt32
    /// 展示用文本，例如 "⌥⌘R"
    var display: String

    /// macOS 默认热键：⌥⌘R（对应旧版 Ctrl+Alt+R 的手感）
    static var defaultMac: HotkeySpec {
        HotkeySpec(
            keyCode: UInt32(kVK_ANSI_R),
            carbonModifiers: UInt32(cmdKey | optionKey),
            display: "⌥⌘R"
        )
    }

    /// 解析 "ctrl+alt+r" / "cmd+option+f9" 一类文本；非法返回 nil。
    static func parse(_ text: String) -> HotkeySpec? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }

        let parts = trimmed
            .lowercased()
            .components(separatedBy: "+")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if parts.isEmpty { return nil }

        var modifiers: UInt32 = 0
        var keyCode: UInt32?
        var keyLabel: String?

        for part in parts {
            switch part {
            case "ctrl", "control":
                modifiers |= UInt32(controlKey)
            case "alt", "option", "opt":
                modifiers |= UInt32(optionKey)
            case "shift":
                modifiers |= UInt32(shiftKey)
            case "cmd", "command", "win", "windows", "meta", "super":
                modifiers |= UInt32(cmdKey)
            default:
                guard let mapped = keyMapping(part) else { return nil }
                keyCode = mapped.code
                keyLabel = mapped.label
            }
        }

        guard let code = keyCode, let label = keyLabel, modifiers != 0 else { return nil }

        // 按 macOS 习惯的顺序显示：⌃ ⌥ ⇧ ⌘
        var display = ""
        if modifiers & UInt32(controlKey) != 0 { display += "⌃" }
        if modifiers & UInt32(optionKey) != 0 { display += "⌥" }
        if modifiers & UInt32(shiftKey) != 0 { display += "⇧" }
        if modifiers & UInt32(cmdKey) != 0 { display += "⌘" }
        display += label

        return HotkeySpec(keyCode: code, carbonModifiers: modifiers, display: display)
    }

    /// 单个按键文本 → Carbon 键码 / 展示标签
    private static func keyMapping(_ token: String) -> (code: UInt32, label: String)? {
        if token.count == 1 {
            switch token {
            case "a": return (UInt32(kVK_ANSI_A), "A")
            case "b": return (UInt32(kVK_ANSI_B), "B")
            case "c": return (UInt32(kVK_ANSI_C), "C")
            case "d": return (UInt32(kVK_ANSI_D), "D")
            case "e": return (UInt32(kVK_ANSI_E), "E")
            case "f": return (UInt32(kVK_ANSI_F), "F")
            case "g": return (UInt32(kVK_ANSI_G), "G")
            case "h": return (UInt32(kVK_ANSI_H), "H")
            case "i": return (UInt32(kVK_ANSI_I), "I")
            case "j": return (UInt32(kVK_ANSI_J), "J")
            case "k": return (UInt32(kVK_ANSI_K), "K")
            case "l": return (UInt32(kVK_ANSI_L), "L")
            case "m": return (UInt32(kVK_ANSI_M), "M")
            case "n": return (UInt32(kVK_ANSI_N), "N")
            case "o": return (UInt32(kVK_ANSI_O), "O")
            case "p": return (UInt32(kVK_ANSI_P), "P")
            case "q": return (UInt32(kVK_ANSI_Q), "Q")
            case "r": return (UInt32(kVK_ANSI_R), "R")
            case "s": return (UInt32(kVK_ANSI_S), "S")
            case "t": return (UInt32(kVK_ANSI_T), "T")
            case "u": return (UInt32(kVK_ANSI_U), "U")
            case "v": return (UInt32(kVK_ANSI_V), "V")
            case "w": return (UInt32(kVK_ANSI_W), "W")
            case "x": return (UInt32(kVK_ANSI_X), "X")
            case "y": return (UInt32(kVK_ANSI_Y), "Y")
            case "z": return (UInt32(kVK_ANSI_Z), "Z")
            case "0": return (UInt32(kVK_ANSI_0), "0")
            case "1": return (UInt32(kVK_ANSI_1), "1")
            case "2": return (UInt32(kVK_ANSI_2), "2")
            case "3": return (UInt32(kVK_ANSI_3), "3")
            case "4": return (UInt32(kVK_ANSI_4), "4")
            case "5": return (UInt32(kVK_ANSI_5), "5")
            case "6": return (UInt32(kVK_ANSI_6), "6")
            case "7": return (UInt32(kVK_ANSI_7), "7")
            case "8": return (UInt32(kVK_ANSI_8), "8")
            case "9": return (UInt32(kVK_ANSI_9), "9")
            default: return nil
            }
        }

        switch token {
        case "f1": return (UInt32(kVK_F1), "F1")
        case "f2": return (UInt32(kVK_F2), "F2")
        case "f3": return (UInt32(kVK_F3), "F3")
        case "f4": return (UInt32(kVK_F4), "F4")
        case "f5": return (UInt32(kVK_F5), "F5")
        case "f6": return (UInt32(kVK_F6), "F6")
        case "f7": return (UInt32(kVK_F7), "F7")
        case "f8": return (UInt32(kVK_F8), "F8")
        case "f9": return (UInt32(kVK_F9), "F9")
        case "f10": return (UInt32(kVK_F10), "F10")
        case "f11": return (UInt32(kVK_F11), "F11")
        case "f12": return (UInt32(kVK_F12), "F12")
        case "f13": return (UInt32(kVK_F13), "F13")
        case "f14": return (UInt32(kVK_F14), "F14")
        case "f15": return (UInt32(kVK_F15), "F15")
        case "f16": return (UInt32(kVK_F16), "F16")
        case "f17": return (UInt32(kVK_F17), "F17")
        case "f18": return (UInt32(kVK_F18), "F18")
        case "f19": return (UInt32(kVK_F19), "F19")
        case "f20": return (UInt32(kVK_F20), "F20")
        case "space": return (UInt32(kVK_Space), "Space")
        case "enter", "return": return (UInt32(kVK_Return), "Return")
        case "esc", "escape": return (UInt32(kVK_Escape), "Esc")
        case "tab": return (UInt32(kVK_Tab), "Tab")
        case "backspace", "delete": return (UInt32(kVK_Delete), "Delete")
        default: return nil
        }
    }
}

// MARK: - 配置

/// 只读和当前功能相关的字段，其余字段原样保留不写回。
final class AppConfig {
    var port: Int = 8799
    var hotkey: HotkeySpec = .defaultMac

    var outerRadius: Double = 182.0
    var bandRatio: Double = 0.499
    var opacity: Double = 0.9
    var popDistance: Double = 8.0
    var gapRatio: Double = 0.1257
    var gapMax: Double = 6.0
    var shadowEnabled: Bool = true
    var shadowBlur: Double = 14.0
    var shadowOffsetY: Double = 6.0
    var shadowAlpha: Double = 0.496
    var showDirectionLine: Bool = true
    var appearScale: Double = 0.86
    var theme: String = "slate"
    var animation: Bool = true

    var presetAction: String = "both"

    var altRightClick: Bool = true
    var altRightScope: String = "global"

    static func load() -> AppConfig {
        let config = AppConfig()
        guard FileManager.default.fileExists(atPath: AppPaths.configPath) else { return config }

        do {
            var data = try Data(contentsOf: URL(fileURLWithPath: AppPaths.configPath))
            // 旧版偶尔会留 UTF-8 BOM，JSONSerialization 不认，先剥掉
            if data.count >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
                data = data.subdata(in: 3..<data.count)
            }
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return config
            }

            let port = Json.int(root, "port", 8799)
            config.port = (port >= 1024 && port <= 65535) ? port : 8799

            let interaction = Json.dict(root, "interaction")
            let hotkeyText = Json.string(interaction, "hotkey", "ctrl+alt+r")
            let normalizedHotkey = hotkeyText
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            if normalizedHotkey == "ctrl+alt+r" {
                // 旧默认热键，mac 上按用户习惯迁移成 ⌥⌘R（旧 macOS 版也是这个组合）
                config.hotkey = .defaultMac
            } else if let parsed = HotkeySpec.parse(hotkeyText) {
                config.hotkey = parsed
            } else {
                config.hotkey = .defaultMac
            }
            config.altRightClick = Json.bool(interaction, "altRightClick", true)
            config.altRightScope = Json.string(interaction, "altRightClickScope", "global")

            let appearance = Json.dict(root, "appearance")
            config.outerRadius = Json.double(appearance, "outerRadius", 182.0)
            config.bandRatio = Json.double(appearance, "bandRatio", 0.499)
            config.opacity = Json.double(appearance, "opacity", 0.9)
            config.popDistance = Json.double(appearance, "popDistance", 8.0)
            config.gapRatio = Json.double(appearance, "gapRatio", 0.1257)
            config.gapMax = Json.double(appearance, "gapMax", 6.0)
            config.shadowEnabled = Json.bool(appearance, "shadowEnabled", true)
            config.shadowBlur = Json.double(appearance, "shadowBlur", 14.0)
            config.shadowOffsetY = Json.double(appearance, "shadowOffsetY", 6.0)
            config.shadowAlpha = Json.double(appearance, "shadowAlpha", 0.496)
            config.showDirectionLine = Json.bool(appearance, "showDirectionLine", true)
            config.appearScale = Json.double(appearance, "appearScale", 0.86)
            config.theme = Json.string(appearance, "theme", "slate")
            config.animation = Json.bool(appearance, "animation", true)

            let content = Json.dict(root, "content")
            config.presetAction = Json.string(content, "presetAction", "both")
        } catch {
            Log.write("读取配置失败：\(error.localizedDescription)")
            return config
        }

        config.outerRadius = clamp(config.outerRadius, 120, 280)
        config.bandRatio = clamp(config.bandRatio, 0.25, 0.75)
        config.opacity = clamp(config.opacity, 0.5, 1.0)
        config.popDistance = clamp(config.popDistance, 0, 30)
        config.gapRatio = clamp(config.gapRatio, 0, 0.4)
        config.gapMax = clamp(config.gapMax, 0, 12)
        config.shadowBlur = clamp(config.shadowBlur, 0, 40)
        config.shadowAlpha = clamp(config.shadowAlpha, 0, 1)
        config.appearScale = clamp(config.appearScale, 0.5, 1.0)
        return config
    }

    /// 菜单栏「打开配置文件」在文件不存在时先写一份默认配置。
    static func writeDefaultConfigIfMissing() {
        guard !FileManager.default.fileExists(atPath: AppPaths.configPath) else { return }

        let config = AppConfig()
        let root: [String: Any] = [
            "port": config.port,
            "interaction": [
                "hotkey": "ctrl+alt+r",
                "altRightClick": config.altRightClick,
                "altRightClickScope": config.altRightScope
            ],
            "appearance": [
                "outerRadius": config.outerRadius,
                "bandRatio": config.bandRatio,
                "opacity": config.opacity,
                "popDistance": config.popDistance,
                "gapRatio": config.gapRatio,
                "gapMax": config.gapMax,
                "shadowEnabled": config.shadowEnabled,
                "shadowBlur": config.shadowBlur,
                "shadowOffsetY": config.shadowOffsetY,
                "shadowAlpha": config.shadowAlpha,
                "showDirectionLine": config.showDirectionLine,
                "appearScale": config.appearScale,
                "theme": config.theme,
                "animation": config.animation
            ],
            "content": [
                "presetAction": config.presetAction
            ]
        ]

        do {
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: AppPaths.configPath), options: .atomic)
            Log.write("已写入默认配置文件：\(AppPaths.configPath)")
        } catch {
            Log.write("写入默认配置失败：\(error.localizedDescription)")
        }
    }

    private static func clamp(_ value: Double, _ lower: Double, _ upper: Double) -> Double {
        if value < lower { return lower }
        if value > upper { return upper }
        return value
    }
}
