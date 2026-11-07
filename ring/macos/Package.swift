// swift-tools-version:5.9
// 幻梦圆环 · macOS 版
//
//  功能范围：圆环扇区菜单 / 全局热键 / 菜单栏常驻 / 预设分类・选择・复制・套用 / 插件 WebSocket 桥
//
// 构建：bash scripts/build-app.sh（swift build + 手工组装 .app）

import PackageDescription

let package = Package(
    name: "HuanmengRing",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "HuanmengRing", targets: ["HuanmengRing"])
    ],
    targets: [
        .executableTarget(
            name: "HuanmengRing",
            path: "Sources/HuanmengRing"
        )
    ]
)
