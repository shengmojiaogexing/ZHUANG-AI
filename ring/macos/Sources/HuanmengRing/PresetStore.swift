//
//  PresetStore.swift
//  幻梦圆环 · macOS 版
//
//    - Preset：分类 / 名称 / 提示词，分类为空时归一为「未分类」
//    - loadLocal：首次运行把包内 presets.json 复制到 ~/.huanmeng-presets.json，再解析
//    - applyPluginState：把插件推来的 state.payload.presets 合并成本地预设并落盘
//    - saveLocal：写盘前备份（只在备份文件不存在时备份一次），tmp + 替换写
//    - toJson / 分类顺序：按条目首次出现顺序去重
//
//  JSON 统一走 AppConfig.swift 里的 Json 取值工具；文件位置统一走 AppPaths。
//

import Foundation

// MARK: - 预设条目

struct Preset {
    let category: String
    let name: String
    let prompt: String

    init(category: String, name: String, prompt: String) {
        self.category = category.isEmpty ? "未分类" : category
        self.name = name
        self.prompt = prompt
    }
}

// MARK: - 预设仓库

/// 预设读写与插件 state 合并。主线程使用（AppController / RingWindow 都只在主线程读它）。
final class PresetStore {
    /// 全部预设（顺序即文件 / 插件下发顺序）
    private(set) var items: [Preset] = []

    private var lastSavedJson: String = ""

    /// 预设数量
    var count: Int {
        items.count
    }

    var categories: [String] {
        var result: [String] = []
        var seen = Set<String>()
        for item in items {
            if !seen.contains(item.category) {
                seen.insert(item.category)
                result.append(item.category)
            }
        }
        return result
    }

    // MARK: 读取

    func loadLocal() {
        items = []
        do {
            let manager = FileManager.default
            if !manager.fileExists(atPath: AppPaths.presetPath),
               let bundled = AppPaths.firstExistingBundledPreset() {
                try manager.copyItem(atPath: bundled, toPath: AppPaths.presetPath)
            }
            if manager.fileExists(atPath: AppPaths.presetPath) {
                var data = try Data(contentsOf: URL(fileURLWithPath: AppPaths.presetPath))
                // 旧版可能把 BOM 一起写进来，JSONSerialization 不认，先剥掉
                if data.count >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
                    data = data.subdata(in: 3..<data.count)
                }
                items = try PresetStore.parsePresetArray(data)
            }
        } catch {
            Log.write("读取本地预设失败：\(error.localizedDescription)")
        }
        lastSavedJson = toJson()
    }

    /// 解析本地 presets.json（数组结构，非法 JSON 抛错，交给 loadLocal 统一记日志）。
    private static func parsePresetArray(_ data: Data) throws -> [Preset] {
        var result: [Preset] = []
        if data.isEmpty { return result }

        let object = try JSONSerialization.jsonObject(with: data, options: [])
        guard let rows = object as? [Any] else { return result }
        for rawRow in rows {
            guard let row = rawRow as? [String: Any] else { continue }
            let name = Json.string(row, "name", "")
            let prompt = Json.string(row, "prompt", "")
            let category = Json.string(row, "category", "未分类")
            if name.isEmpty || prompt.isEmpty { continue }
            result.append(Preset(category: category, name: name, prompt: prompt))
        }
        return result
    }

    // MARK: 插件 state 合并

    /// 把插件发来的 state.payload 合并进本地预设；返回是否真的更新了数据。
    func applyPluginState(_ payload: [String: Any]) -> Bool {
        guard let presetsValue = payload["presets"], let rawGroups = presetsValue as? [Any] else {
            return false
        }
        if rawGroups.isEmpty { return false }

        var next: [Preset] = []
        for rawGroup in rawGroups {
            guard let group = rawGroup as? [String: Any] else { continue }
            let category = Json.string(group, "category", "未分类")
            guard let itemsValue = group["items"], let rawItems = itemsValue as? [Any] else { continue }
            for rawItem in rawItems {
                guard let item = rawItem as? [String: Any] else { continue }
                let name = Json.string(item, "name", "")
                let prompt = Json.string(item, "prompt", "")
                if name.isEmpty || prompt.isEmpty { continue }
                next.append(Preset(category: category, name: name, prompt: prompt))
            }
        }
        if next.isEmpty { return false }

        items = next
        saveLocal(backup: true)
        return true
    }

    // MARK: 查询

    func inCategory(_ category: String) -> [Preset] {
        var result: [Preset] = []
        for item in items where item.category == category {
            result.append(item)
        }
        return result
    }

    func countInCategory(_ category: String) -> Int {
        var count = 0
        for item in items where item.category == category {
            count += 1
        }
        return count
    }

    // MARK: 保存

    /// - Parameter backup: 覆盖插件预设前是否把旧文件备份到 ~/.huanmeng-presets.backup.json，
    ///   且只在备份文件不存在时备份一次。
    func saveLocal(backup: Bool) {
        do {
            let json = toJson()
            let manager = FileManager.default
            if json == lastSavedJson && manager.fileExists(atPath: AppPaths.presetPath) {
                return
            }

            if backup
                && manager.fileExists(atPath: AppPaths.presetPath)
                && !manager.fileExists(atPath: AppPaths.presetBackupPath) {
                do {
                    try manager.copyItem(atPath: AppPaths.presetPath, toPath: AppPaths.presetBackupPath)
                } catch {
                    Log.write("备份预设失败：\(error.localizedDescription)")
                }
            }

            let temp = AppPaths.presetPath + ".tmp"
            try Data(json.utf8).write(to: URL(fileURLWithPath: temp))
            if manager.fileExists(atPath: AppPaths.presetPath) {
                try manager.removeItem(atPath: AppPaths.presetPath)
            }
            try manager.moveItem(atPath: temp, toPath: AppPaths.presetPath)
            lastSavedJson = json
        } catch {
            Log.write("写入本地预设失败：\(error.localizedDescription)")
        }
    }

    func toJson() -> String {
        var rows: [[String: String]] = []
        rows.reserveCapacity(items.count)
        for item in items {
            rows.append([
                "category": item.category,
                "name": item.name,
                "prompt": item.prompt
            ])
        }

        guard JSONSerialization.isValidJSONObject(rows),
              let data = try? JSONSerialization.data(withJSONObject: rows, options: []),
              let text = String(data: data, encoding: .utf8) else {
            // 理论上 rows 只含 String，不会失败；真失败时返回上一次成功的 JSON，
            // 避免 saveLocal 把内容写成 "[]" 覆盖掉用户预设。
            Log.write("序列化预设失败")
            return lastSavedJson
        }
        return text
    }
}
