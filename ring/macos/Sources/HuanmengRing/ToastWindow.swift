//
//  ToastWindow.swift
//  幻梦圆环 · macOS 版
//
//  菜单栏气泡提示：右上角无边框透明 NSPanel + SwiftUI 圆角深色背景，
//  2.2 秒后自动淡出的时长和用法：
//  套用预设成功 / 失败、桥接端口失败、热键被占用等都从这里弹提示。
//
//  只复用同一个面板；所有方法都应在主线程调用（非主线程会自动转回主线程）。
//

import AppKit
import Foundation
import SwiftUI

final class ToastController {
    private var panel: ToastPanel?
    private var hostingView: NSHostingView<ToastView>?
    private var hideWorkItem: DispatchWorkItem?
    /// 连续弹气泡时用来作废旧定时器，避免旧气泡把新气泡提前隐藏
    private var showSequence = 0

    private static let displayDuration: TimeInterval = 2.2
    /// 淡出时长
    private static let fadeDuration: TimeInterval = 0.22

    /// 右上角弹一个气泡，约 2.2 秒后淡出关闭。
    func show(title: String, message: String, isWarning: Bool) {
        // 防御：万一从后台线程调用，转回主线程
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in
                self?.show(title: title, message: message, isWarning: isWarning)
            }
            return
        }

        showSequence += 1
        let sequence = showSequence

        let panel = ensurePanel()
        guard let hosting = hostingView else { return }

        hosting.rootView = ToastView(title: title, message: message, isWarning: isWarning)
        hosting.layoutSubtreeIfNeeded()

        // 宽度固定 320（ToastView 内设定），高度按内容自适应
        var fitting = hosting.fittingSize
        if fitting.width < 1.0 || fitting.height < 1.0 {
            fitting = CGSize(width: 320.0, height: 76.0)
        }
        let width = max(CGFloat(240.0), fitting.width)
        let height = max(CGFloat(56.0), fitting.height)

        // 右上角，避开菜单栏（visibleFrame 已去掉菜单栏 / Dock）
        let screen = NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let originX = visible.maxX - width - 16.0
        let originY = visible.maxY - height - 12.0
        panel.setFrame(
            NSRect(x: originX, y: originY, width: width, height: height),
            display: true
        )

        panel.alphaValue = 1.0
        // 不激活 App 地显示（面板 level 已是 .floating）
        panel.orderFrontRegardless()

        hideWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.fadeOut(sequence: sequence)
        }
        hideWorkItem = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + ToastController.displayDuration,
            execute: workItem
        )
    }

    // MARK: - 淡出

    private func fadeOut(sequence: Int) {
        guard sequence == showSequence, let panel = panel, panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = ToastController.fadeDuration
            panel.animator().alphaValue = 0.0
        }, completionHandler: { [weak self] in
            guard let self = self else { return }
            // 淡出期间又来了新气泡：不要把新气泡隐藏掉
            guard self.showSequence == sequence else { return }
            self.panel?.orderOut(nil)
            self.panel?.alphaValue = 1.0
        })
    }

    // MARK: - 面板创建（只创建一次，复用）

    private func ensurePanel() -> ToastPanel {
        if let panel = panel { return panel }

        let initialFrame = NSRect(x: 0, y: 0, width: 340.0, height: 76.0)
        let panel = ToastPanel(
            contentRect: initialFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovable = false
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

        let hosting = NSHostingView(rootView: ToastView(title: "", message: "", isWarning: false))
        hosting.frame = initialFrame
        hosting.autoresizingMask = [.width, .height]
        panel.contentView = hosting

        self.panel = panel
        self.hostingView = hosting
        return panel
    }
}

/// 气泡面板：纯展示，不接收键盘 / 鼠标
private final class ToastPanel: NSPanel {
    override var canBecomeKey: Bool { return false }
    override var canBecomeMain: Bool { return false }
}

// MARK: - 气泡内容

/// 圆角深色半透明气泡：标题 + 正文。浅色主题下也保持深色（贴近系统通知观感）。
struct ToastView: View {
    let title: String
    let message: String
    let isWarning: Bool

    /// 气泡固定用深色配色
    private var theme: RingTheme {
        return RingTheme.slate
    }

    /// 警示用橙色，普通提示用主题 Accent
    private var accentColor: Color {
        if isWarning {
            return Color(.sRGB, red: 1.0, green: 0.62, blue: 0.25, opacity: 1.0)
        }
        return theme.accent
    }

    var body: some View {
        HStack(alignment: .top, spacing: 9.0) {
            Circle()
                .fill(accentColor)
                .frame(width: 8.0, height: 8.0)
                .padding(.top, 4.0)

            VStack(alignment: .leading, spacing: 3.0) {
                Text(title)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(theme.text)
                Text(message)
                    .font(.system(size: 11.5))
                    .foregroundColor(theme.sub)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0.0)
        }
        .padding(.horizontal, 14.0)
        .padding(.vertical, 11.0)
        .frame(width: 320.0, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12.0, style: .continuous)
                .fill(theme.hub.opacity(0.94))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12.0, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1.0)
        )
    }
}
