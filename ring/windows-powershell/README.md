# 幻梦圆环 · Windows PowerShell 版

功能最全的一版圆环：托盘常驻 + 全局热键 + 圆环扇区菜单，并保留生图、对话、选区、ComfyUI、语音、历史图库等完整功能。纯 PowerShell / WinForms 实现，不依赖 .NET SDK 或第三方运行库。

> 只想用「圆环选预设」这一套精简功能时，用 `../windows-csharp/` 的 C# 重写版；两者共用同一套配置和预设数据。

## 运行

Windows 10 / 11 自带 PowerShell 5.1，直接运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\HuanmengRing.ps1
```

常用参数：

```powershell
# 启动并直接唤出圆环
powershell -NoProfile -ExecutionPolicy Bypass -File .\HuanmengRing.ps1 --show

# 自检（环境 / 配置 / 端口 / 依赖）
powershell -NoProfile -ExecutionPolicy Bypass -File .\HuanmengRing.ps1 --doctor

# 用配置文件里的密钥发一句「你好」测试对话接口
powershell -NoProfile -ExecutionPolicy Bypass -File .\HuanmengRing.ps1 --chat-test
```

启动后常驻托盘：全局热键唤出圆环，`Alt + 鼠标右键` 在光标位置唤出；也可以在托盘菜单里「显示圆环」。

## 和插件共用数据

- 配置：`%USERPROFILE%\.huanmeng-ring.json`（与 macOS 版同名同格式）
- 预设：`%USERPROFILE%\.huanmeng-presets.json`
- 桥接端口：`8799`（圆环是 WebSocket 服务端，插件是客户端）

插件在线时会把预设推给圆环；圆环点预设后通过 WebSocket 发 `applyPreset`，插件自动填提示词。

## 目录

```text
windows-powershell/
├─ HuanmengRing.ps1        入口
├─ lib/                    功能模块（菜单 / 托盘 / 气泡 / API / ComfyUI / 语音 / 图库 …）
└─ presets.json            内置预设（首次运行时复制到用户目录）
```

## 许可证

以 GPL-3.0 发布，见仓库根目录 [LICENSE](../../LICENSE)。
