//
//  RingModel.swift
//  幻梦圆环 · macOS 版
//
//  圆环界面的「数据 + 状态」：当前层级（分类 / 预设）、悬停项、几何参数、
//  出现动画参数、插件桥连接状态。
//
//  RingView 只从这里读状态、照数绘制；这里不碰任何窗口 / 命中 / 绘制的具体实现。
//

import Foundation
import Combine
import CoreGraphics

/// 分类层：title = 分类名，subtitle = "N 条预设"，preset = nil
/// 预设层：title = 预设名，subtitle = 分类名，preset = 预设本体
struct RingItem {
    let title: String
    let subtitle: String
    let preset: Preset?

    init(title: String, subtitle: String, preset: Preset? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.preset = preset
    }
}

/// 圆环界面状态（ObservableObject）。所有属性只在主线程改。
final class RingModel: ObservableObject {

    @Published var items: [RingItem] = []
    @Published var level: Int = 0              // 0 = 分类层，1 = 预设层
    @Published var category: String = ""
    @Published var hover: Int = -1


    @Published var connected: Bool = false


    @Published var center: CGPoint = .zero
    @Published var outer: Double = 182.0
    @Published var inner: Double = 91.0
    @Published var viewSize: CGSize = .zero


    @Published var opacity: Double = 0.9
    @Published var scale: Double = 1.0

    /// 当前悬停项；没有悬停或越界时返回 nil
    var hoveredItem: RingItem? {
        guard hover >= 0, hover < items.count else { return nil }
        return items[hover]
    }

    var hubRadius: Double {
        max(60.0, inner - 8.0)
    }

    func reset() {
        level = 0
        category = ""
        hover = -1
        items = []
    }
}

enum RingMath {
    /// 每格角度（度）
    static func step(count: Int) -> Double {
        guard count > 0 else { return 360.0 }
        return 360.0 / Double(count)
    }

    /// 扇区间隙：Math.Min(gapMax, Math.Max(0, step * gapRatio))
    static func gap(step: Double, gapRatio: Double, gapMax: Double) -> Double {
        min(gapMax, max(0.0, step * gapRatio))
    }

    /// 两点距离
    static func distance(from center: CGPoint, to point: CGPoint) -> Double {
        let dx = Double(point.x - center.x)
        let dy = Double(point.y - center.y)
        return (dx * dx + dy * dy).squareRoot()
    }

    static func angleDegrees(from center: CGPoint, to point: CGPoint) -> Double {
        let dx = Double(point.x - center.x)
        let dy = Double(point.y - center.y)
        var angle = atan2(dy, dx) * 180.0 / Double.pi
        if angle < 0 { angle += 360.0 }
        return angle
    }

    static func sectorIndex(angleDegrees angle: Double, count: Int, gap: Double) -> Int {
        guard count > 0 else { return -1 }
        let stepValue = step(count: count)
        var fromStart = angle - (270.0 + gap / 2.0)
        while fromStart < 0 { fromStart += 360.0 }
        var index = Int(floor(fromStart / stepValue))
        if index < 0 { index = 0 }
        if index >= count { index = count - 1 }
        return index
    }

    static func easeOutQuad(_ t: Double) -> Double {
        let clamped = min(1.0, max(0.0, t))
        return clamped * (2.0 - clamped)
    }


    static func shortCategory(_ category: String) -> String {
        if category.isEmpty { return "未分类" }

        let characters = Array(category)
        let tail: [Character]
        if let slash = characters.lastIndex(of: "/") {
            tail = Array(characters[slash...].dropFirst())
        } else {
            tail = characters
        }

        switch category {
        case "人像精修": return "人像"
        case "服装整理": return "服装整"
        case "背景处理": return "背景处"
        case "创意增强": return "创意"
        case "清晰度增强": return "清晰"
        case "材质增强": return "材质"
        default: break
        }

        if tail.count <= 2 { return String(tail) }
        return String(tail.prefix(2))
    }

    /// 预设短名：不超过 9 个字符原样显示，否则前 8 个字符 + "…"。
    static func shortPreset(_ name: String) -> String {
        if name.isEmpty { return "" }
        let characters = Array(name)
        if characters.count <= 9 { return name }
        return String(characters.prefix(8)) + "…"
    }
}
