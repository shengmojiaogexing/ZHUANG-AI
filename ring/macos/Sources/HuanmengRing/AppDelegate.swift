//
//  AppDelegate.swift
//  幻梦圆环 · macOS 版
//
//  只做三件事：创建 AppController、退出时收尾、启动异常兜底。
//  旧版在构造里完成托盘/热键/桥接，这里拆成 init + start() 两步，
//  避免初始化顺序问题，也方便 --show 延后到主循环里执行。
//

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: AppController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = AppController(arguments: CommandLine.arguments)
        self.controller = controller
        controller.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return true
    }
}
