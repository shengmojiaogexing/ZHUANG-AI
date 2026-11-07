//
//  main.swift
//  幻梦圆环 · macOS 版
//
//    - 未处理异常写日志（NSSetUncaughtExceptionHandler）
//    - 启动参数 --show：启动后直接唤出圆环
//
//  第二个实例带 --show 启动时，用 DistributedNotificationCenter 通知已运行实例唤出圆环。
//

import AppKit
import Darwin

let launchArguments = CommandLine.arguments

// MARK: - 单实例

let instanceLockPath = (AppPaths.home as NSString).appendingPathComponent(".huanmeng-ring.lock")
let instanceLockFD: Int32 = open(instanceLockPath, O_CREAT | O_RDWR, 0o644)

var alreadyRunning = false
if instanceLockFD >= 0 {
    if flock(instanceLockFD, LOCK_EX | LOCK_NB) != 0 {
        alreadyRunning = true
    }
} else {
    Log.write("单实例锁打开失败：\(String(cString: strerror(errno)))")
}

if alreadyRunning {
    if launchArguments.contains("--show") {
        DistributedNotificationCenter.default().postNotification(
            name: NSNotification.Name("com.huanmeng.ring.show"),
            object: nil,
            userInfo: nil,
            deliverImmediately: true
        )
        Log.write("已有实例在运行，已通知它显示圆环")
    } else {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.messageText = "幻梦圆环已经在运行。"
        alert.informativeText = "你可以在菜单栏找到它；按 ⌥⌘R 或按住 ⌥ 点右键唤出圆环。"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
    exit(0)
}

// MARK: - 未处理异常

NSSetUncaughtExceptionHandler { exception in
    Log.write("未处理异常：\(exception.name.rawValue) / \(exception.reason ?? "")")
    let stack = exception.callStackSymbols.joined(separator: "\n")
    Log.write(stack)
}

// MARK: - 启动

let application = NSApplication.shared
let applicationDelegate = AppDelegate()
application.delegate = applicationDelegate
application.setActivationPolicy(.accessory)
application.run()
