//
//  RingView.swift
//  幻梦圆环 · macOS 版
//
//  圆环绘制：SwiftUI Canvas 全量手绘（扇区、扇区文字、外圈细线、方向线、
//  中心圆盘、空预设状态、底部提示）。
//
//  注意：扇区路径用「按角度采样折线」拼内外弧再闭合，不用 Path.addArc ——
//  SwiftUI 里角度方向和坐标系（y 向下）容易搞反，采样折线的结果完全可控。
//

import Foundation
import CoreGraphics
import SwiftUI


/// 0xRRGGBB → Color（sRGB）
private func ringColor(_ red: Int, _ green: Int, _ blue: Int) -> Color {
    Color(
        .sRGB,
        red: Double(red) / 255.0,
        green: Double(green) / 255.0,
        blue: Double(blue) / 255.0,
        opacity: 1.0
    )
}

struct RingTheme {
    let sector: Color
    let sectorAlt: Color
    let hover: Color
    let hub: Color
    let text: Color
    let sub: Color
    let stroke: Color
    let accent: Color

    /// slate —— 默认深色主题
    static let slate = RingTheme(
        sector: ringColor(0x2B, 0x31, 0x35),
        sectorAlt: ringColor(0x25, 0x2A, 0x2E),
        hover: ringColor(0x18, 0x8A, 0x50),
        hub: ringColor(0x1D, 0x23, 0x27),
        text: ringColor(0xF2, 0xF5, 0xF2),
        sub: ringColor(0x9D, 0xAB, 0xA2),
        stroke: ringColor(0x45, 0x4D, 0x50),
        accent: ringColor(0x35, 0xC2, 0x7A)
    )

    /// light —— 浅色主题
    static let light = RingTheme(
        sector: ringColor(0xF7, 0xF8, 0xF6),
        sectorAlt: ringColor(0xEE, 0xF2, 0xEE),
        hover: ringColor(0xE8, 0xF4, 0xEC),
        hub: ringColor(0xFF, 0xFF, 0xFF),
        text: ringColor(0x2F, 0x38, 0x32),
        sub: ringColor(0x8A, 0x93, 0x8C),
        stroke: ringColor(0xDF, 0xE4, 0xDF),
        accent: ringColor(0x14, 0x8A, 0x50)
    )

    static func forName(_ theme: String) -> RingTheme {
        theme.lowercased() == "light" ? RingTheme.light : RingTheme.slate
    }
}

// MARK: - 路径构建（按角度采样，不用 Path.addArc）

enum RingGeometry {
    /// 采样步长（度）：1.5° 一段折线，肉眼几乎等价于真弧
    static let sampleStepDegrees: Double = 1.5

    static func point(center: CGPoint, angleDegrees: Double, radius: Double) -> CGPoint {
        let radians = angleDegrees * Double.pi / 180.0
        return CGPoint(
            x: center.x + CGFloat(cos(radians) * radius),
            y: center.y + CGFloat(sin(radians) * radius)
        )
    }

    ///
    /// 注意整圈环带：外圆、内圆做成**两个独立子路径**，绘制时配 `FillStyle(eoFill: true)`
    /// （even-odd）才能把中间挖空；若用同方向的「外弧 + 反向内弧」折线，非零环绕规则
    /// 会把整块圆盘填满，count == 1 的扇区和阴影就会变成实心圆。
    static func sectorPath(
        center: CGPoint,
        inner: Double,
        outer: Double,
        start: Double,
        end: Double,
        full: Bool
    ) -> Path {
        var path = Path()
        if full {
            // 整圈：外圆 + 内圆两个独立椭圆子路径（填充时用 even-odd 挖洞）
            path.addEllipse(in: CGRect(
                x: center.x - CGFloat(outer),
                y: center.y - CGFloat(outer),
                width: CGFloat(outer * 2.0),
                height: CGFloat(outer * 2.0)
            ))
            path.addEllipse(in: CGRect(
                x: center.x - CGFloat(inner),
                y: center.y - CGFloat(inner),
                width: CGFloat(inner * 2.0),
                height: CGFloat(inner * 2.0)
            ))
        } else {
            // 扇区：外弧 start→end，直线收到内弧 end，内弧反向回 start，闭合
            appendArc(&path, center: center, radius: outer, start: start, end: end, moveToStart: true)
            appendArc(&path, center: center, radius: inner, start: end, end: start, moveToStart: false)
            path.closeSubpath()
        }
        return path
    }

    static func fullRingPath(center: CGPoint, outer: Double, inner: Double) -> Path {
        sectorPath(center: center, inner: inner, outer: outer, start: 0.0, end: 360.0, full: true)
    }

    /// 向已有 path 追加一段采样圆弧；moveToStart = false 时从当前点直接连线过去
    private static func appendArc(
        _ path: inout Path,
        center: CGPoint,
        radius: Double,
        start: Double,
        end: Double,
        moveToStart: Bool
    ) {
        let span = end - start
        let steps = max(1, Int((abs(span) / sampleStepDegrees).rounded(.up)))
        for index in 0...steps {
            let angle = start + span * Double(index) / Double(steps)
            let position = RingGeometry.point(center: center, angleDegrees: angle, radius: radius)
            if index == 0 && moveToStart {
                path.move(to: position)
            } else {
                path.addLine(to: position)
            }
        }
    }
}

// MARK: - 圆环视图

/// 圆环视图：只读 RingModel / AppConfig，全部用 Canvas 手绘。
/// 窗口 / 命中 / 键盘都在 RingWindowController，这里只负责画。
struct RingView: View {
    @ObservedObject var model: RingModel
    let config: AppConfig

    var body: some View {
        Canvas { context, size in
            self.drawAll(context: &context, size: size)
        }
        .opacity(model.opacity)
        .scaleEffect(CGFloat(model.scale), anchor: scaleAnchor)
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }

    private var scaleAnchor: UnitPoint {
        guard model.viewSize.width > 0, model.viewSize.height > 0 else { return .center }
        return UnitPoint(
            x: model.center.x / model.viewSize.width,
            y: model.center.y / model.viewSize.height
        )
    }


    private func drawAll(context: inout GraphicsContext, size: CGSize) {
        let theme = RingTheme.forName(config.theme)
        let center = model.center
        let outer = model.outer
        let inner = model.inner

        guard !model.items.isEmpty else {
            drawEmpty(context: &context, size: size, theme: theme)
            return
        }

        // 整圈环带（count == 1 / 阴影）必须用 even-odd 填充，两个椭圆子路径才能挖出内圈。
        // 普通扇区是单个闭合子路径，两种规则结果一样，统一用它即可。
        let ringFillStyle = FillStyle(eoFill: true)

        // 1) 阴影：同形状环带整体下移 shadowOffsetY，黑色 alpha = shadowAlpha，模糊 shadowBlur
        if config.shadowEnabled {
            var shadowContext = context
            shadowContext.addFilter(.blur(radius: CGFloat(max(2.0, config.shadowBlur))))
            let shadowCenter = CGPoint(x: center.x, y: center.y + CGFloat(config.shadowOffsetY))
            let shadowPath = RingGeometry.fullRingPath(
                center: shadowCenter,
                outer: outer + 2.0,
                inner: inner
            )
            shadowContext.fill(
                shadowPath,
                with: .color(Color.black.opacity(config.shadowAlpha)),
                style: ringFillStyle
            )
        }

        // 2) 扇区：从 -90°（正上方）开始，每格 360/count，左右各留 gap/2
        let count = model.items.count
        let step = RingMath.step(count: count)
        let gap = RingMath.gap(step: step, gapRatio: config.gapRatio, gapMax: config.gapMax)
        let baseRadius = (inner + outer) / 2.0
        let fontSize: Double = model.level == 0 ? 10.5 : 10.0
        let pop = config.popDistance

        for index in 0..<count {
            let start = -90.0 + Double(index) * step + gap / 2.0
            let end = -90.0 + Double(index + 1) * step - gap / 2.0
            let baseFill = (index % 2 == 1) ? theme.sectorAlt : theme.sector
            let isHover = (index == model.hover)

            if isHover {
                // 悬停：外扩 popDistance、填 Hover 色、描边 Accent 2.2，带 Accent 辉光
                var hoverContext = context
                hoverContext.addFilter(.shadow(
                    color: theme.accent.opacity(0.62),
                    radius: 16.0,
                    x: 0.0,
                    y: 0.0
                ))
                let path = RingGeometry.sectorPath(
                    center: center,
                    inner: inner,
                    outer: outer + pop,
                    start: start,
                    end: end,
                    full: count == 1
                )
                hoverContext.fill(path, with: .color(theme.hover), style: ringFillStyle)
                hoverContext.stroke(path, with: .color(theme.accent), lineWidth: 2.2)
            } else {
                let path = RingGeometry.sectorPath(
                    center: center,
                    inner: inner,
                    outer: outer,
                    start: start,
                    end: end,
                    full: count == 1
                )
                context.fill(path, with: .color(baseFill), style: ringFillStyle)
                context.stroke(path, with: .color(theme.stroke), lineWidth: 1.0)
            }
        }

        // 3) 外圈细线（半径 outer，Stroke 色，线宽 1）
        let borderRadius = CGFloat(outer)
        let borderPath = Path(ellipseIn: CGRect(
            x: center.x - borderRadius,
            y: center.y - borderRadius,
            width: borderRadius * 2.0,
            height: borderRadius * 2.0
        ))
        context.stroke(borderPath, with: .color(theme.stroke), lineWidth: 1.0)

        // 4) 方向线：悬停扇区中线，inner-4 → outer-6，Accent 0.6 透明度、线宽 2
        if config.showDirectionLine, model.hover >= 0, model.hover < count {
            let midAngle = -90.0 + (Double(model.hover) + 0.5) * step
            let lineStart = RingGeometry.point(center: center, angleDegrees: midAngle, radius: inner - 4.0)
            let lineEnd = RingGeometry.point(center: center, angleDegrees: midAngle, radius: outer - 6.0)
            var directionLine = Path()
            directionLine.move(to: lineStart)
            directionLine.addLine(to: lineEnd)
            context.stroke(
                directionLine,
                with: .color(theme.accent.opacity(0.6)),
                lineWidth: 2.0
            )
        }

        // 5) 扇区文字（分类短名 / 预设短名；悬停时随 pop*0.5 外移）
        for index in 0..<count {
            let label: String
            if model.level == 0 {
                label = RingMath.shortCategory(model.items[index].title)
            } else {
                label = RingMath.shortPreset(model.items[index].title)
            }
            if label.isEmpty { continue }

            let angle = -90.0 + (Double(index) + 0.5) * step
            let isHover = (index == model.hover)
            let labelRadius = isHover ? baseRadius + pop * 0.5 : baseRadius
            let position = RingGeometry.point(center: center, angleDegrees: angle, radius: labelRadius)
            let text = Text(label)
                .font(.system(size: CGFloat(fontSize), weight: .semibold))
                .foregroundColor(theme.text)
            context.draw(text, at: position, anchor: .center)
        }

        // 6) 中心圆盘 + 7) 底部提示
        drawHub(context: &context, theme: theme)
        drawHint(context: &context, size: size, theme: theme)
    }


    private func drawHub(context: inout GraphicsContext, theme: RingTheme) {
        let center = model.center
        let radius = model.hubRadius
        let hubRect = CGRect(
            x: center.x - CGFloat(radius),
            y: center.y - CGFloat(radius),
            width: CGFloat(radius * 2.0),
            height: CGFloat(radius * 2.0)
        )
        let hubPath = Path(ellipseIn: hubRect)

        if config.shadowEnabled {
            // 中心圆盘的投影：黑色、模糊 max(4, shadowBlur)、向下偏移 shadowOffsetY、opacity shadowAlpha
            var hubContext = context
            hubContext.addFilter(.shadow(
                color: Color.black.opacity(config.shadowAlpha),
                radius: CGFloat(max(4.0, config.shadowBlur)),
                x: 0.0,
                y: CGFloat(max(0.0, config.shadowOffsetY))
            ))
            hubContext.fill(hubPath, with: .color(theme.hub))
            hubContext.stroke(hubPath, with: .color(theme.accent), lineWidth: 1.2)
        } else {
            context.fill(hubPath, with: .color(theme.hub))
            context.stroke(hubPath, with: .color(theme.accent), lineWidth: 1.2)
        }

        let dotRect = CGRect(
            x: center.x - 3.5,
            y: center.y - CGFloat(radius) + 16.0,
            width: 7.0,
            height: 7.0
        )
        context.fill(Path(ellipseIn: dotRect), with: .color(theme.accent))

        let title: String
        let subtitle: String
        if let item = model.hoveredItem {
            title = item.title
            subtitle = item.subtitle
        } else if model.level == 0 {
            title = "预设"
            subtitle = "选择分类 · \(model.items.count) 类"
        } else {
            title = model.category
            subtitle = "选择预设 · 点中心返回"
        }

        // 标题：字号 16 SemiBold、Text 色、宽 radius*1.8 居中、top = cy - 23
        drawCenteredText(
            title,
            font: .system(size: 16.0, weight: .semibold),
            color: theme.text,
            centerX: center.x,
            topY: center.y - 23.0,
            context: &context
        )
        // 副标题：字号 9.2、Sub 色、top = cy + 3
        drawCenteredText(
            subtitle,
            font: .system(size: 9.2),
            color: theme.sub,
            centerX: center.x,
            topY: center.y + 3.0,
            context: &context
        )
        // 连接状态：字号 7.6、已连接用 Accent / 未连接用 Sub、top = cy + radius - 25
        drawCenteredText(
            model.connected ? "插件已连接" : "插件未连接",
            font: .system(size: 7.6),
            color: model.connected ? theme.accent : theme.sub,
            centerX: center.x,
            topY: center.y + CGFloat(radius) - 25.0,
            context: &context
        )
    }


    private func drawEmpty(context: inout GraphicsContext, size: CGSize, theme: RingTheme) {
        let center = model.center

        // 中心圆盘：150×150，Hub 填充 + Stroke 描边
        let hubRect = CGRect(
            x: center.x - 75.0,
            y: center.y - 75.0,
            width: 150.0,
            height: 150.0
        )
        let hubPath = Path(ellipseIn: hubRect)
        context.fill(hubPath, with: .color(theme.hub))
        context.stroke(hubPath, with: .color(theme.stroke), lineWidth: 1.0)

        // 标题：字号 14 SemiBold、Text 色、宽 130 居中、top = cy - 18
        drawCenteredText(
            "没有预设",
            font: .system(size: 14.0, weight: .semibold),
            color: theme.text,
            centerX: center.x,
            topY: center.y - 18.0,
            context: &context
        )
        // 副标题：字号 8、Sub 色、宽 190 居中、top = cy + 6
        let subText = model.connected ? "插件已连接，但没收到预设" : "先启动 Photoshop 插件"
        drawCenteredText(
            subText,
            font: .system(size: 8.0),
            color: theme.sub,
            centerX: center.x,
            topY: center.y + 6.0,
            context: &context
        )

        drawHint(context: &context, size: size, theme: theme)
    }


    private func drawHint(context: inout GraphicsContext, size: CGSize, theme: RingTheme) {
        let center = model.center
        var topY = center.y + CGFloat(model.outer) + 30.0
        if topY > size.height - 34.0 { topY = size.height - 34.0 }
        drawCenteredText(
            "Esc 关闭    ·    右键返回    ·    数字键 1-9 选择",
            font: .system(size: 8.0),
            color: theme.sub,
            centerX: center.x,
            topY: topY,
            context: &context
        )
    }

    // MARK: - 文字绘制小工具

    private func drawCenteredText(
        _ content: String,
        font: Font,
        color: Color,
        centerX: CGFloat,
        topY: CGFloat,
        context: inout GraphicsContext
    ) {
        let text = Text(content)
            .font(font)
            .foregroundColor(color)
        context.draw(text, at: CGPoint(x: centerX, y: topY), anchor: .top)
    }
}
