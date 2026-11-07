# 幻梦圆环 · C# / WPF 重写版

这是按这次确认的范围重写的圆环项目：**只保留圆环扇区菜单、全局热键、托盘、预设分类/选择/复制/套用到插件，以及现有配置和预设数据兼容。**

![圆环预览](preview.png)

旧版 PowerShell 里的生图、对话、选区、ComfyUI、语音、历史图库没有迁进来；需要这些功能继续用 `ring/windows-powershell/`，或者以后再加。

## 运行

直接双击：

```text
幻梦圆环.exe
```

启动后常驻托盘，不弹主窗口。

- **Alt + 鼠标右键**：在光标位置唤出圆环（旧版习惯）
- 托盘双击 / 菜单「显示圆环」：打开圆环
- 默认热键：`Ctrl+Alt+R`
- 如果 `Ctrl+Alt+R` 被其他程序占用，会自动依次尝试：
  - `Ctrl+Alt+Shift+R`
  - `Ctrl+Shift+Alt+F9`
  - 托盘菜单里会显示实际生效的热键
- `幻梦圆环.exe --show`：启动后直接打开圆环

圆环操作：

- 鼠标往哪个方向偏，对应扇区就向外弹出 `popDistance`，带外缘高光和投影
- 扇区沿半径有明暗、隔项深浅交替，外圈有发丝高光和方向指示线
- 弹出时带 `appearScale → 1` 的 110ms 缩放
- 点分类扇区进入预设
- 点预设：复制提示词 + 通过 WebSocket 发给插件
- `Esc`：预设层返回分类层，分类层关闭
- 右键：返回 / 关闭
- 数字键 `1-9`：选择对应扇区
- 点圆环外：关闭

悬停弹出、阴影、辉光、方向线都读旧版 `appearance` 配置：

- `popDistance` / `gapRatio` / `gapMax`
- `shadowEnabled` / `shadowBlur` / `shadowOffsetY` / `shadowAlpha`
- `showDirectionLine` / `appearScale` / `animation`
- `outerRadius` / `bandRatio` / `opacity` / `theme`

## 和插件共用预设

数据源优先级：

1. 插件在线时，接收插件推来的 `state.payload.presets`
2. 把这份预设写回 `%USERPROFILE%\.huanmeng-presets.json`
3. 插件不在线时，读这个本地文件

所以插件里新增、编辑、删除预设后，圆环在线会立即收到；插件关掉后，圆环重启也能读到最后一次同步的数据。

旧文件会备份一次到：

```text
%USERPROFILE%\.huanmeng-presets.backup.json
```

## 现有配置兼容

读取：

```text
%USERPROFILE%\.huanmeng-ring.json
```

只读取和当前功能相关的字段：

- `port`：桥接端口，默认 `8799`
- `interaction.hotkey`：全局热键，默认 `ctrl+alt+r`
- `interaction.altRightClick` / `altRightClickScope`：Alt+右键开关和作用范围（`global` / `photoshop` / `off`）
- `appearance.outerRadius` / `bandRatio` / `opacity` / `theme` / `animation`
- `appearance.popDistance` / `gapRatio` / `gapMax`
- `appearance.shadowEnabled` / `shadowBlur` / `shadowOffsetY` / `shadowAlpha`
- `appearance.showDirectionLine` / `appearScale`
- `content.presetAction`：旧字段保留读取，但新版固定「复制 + 套用」，这样插件才会自动填提示词

不会改旧配置里的其他字段。

预设文件格式仍然是旧版兼容的：

```json
[
  { "category": "脸部/眼部", "name": "瞳孔提亮", "prompt": "..." }
]
```

## 插件桥接

圆环是 WebSocket 服务端，插件是客户端：

```text
ws://127.0.0.1:8799
```

- 圆环 ← 插件：`state`，读取 `payload.presets`
- 圆环 → 插件：`command` / `applyPreset`，带 `{ name, category }`
- 圆环启动后发 `hello`

插件侧对应 `plugin/js/ring-bridge.js`。

## 构建

本机没有 .NET SDK，所以用 Windows 自带的 .NET Framework 4.8 编译器构建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

生成：

```text
幻梦圆环.exe
```

源码：

```text
src/
├─ Program.cs          入口 / 单实例 / 未处理异常
├─ AppConfig.cs        配置、热键解析、路径、日志
├─ PresetStore.cs      本地/插件预设、分类、备份
├─ BridgeServer.cs     TcpListener WebSocket 服务端
├─ AppController.cs    托盘、热键、桥接、套用预设
└─ RingWindow.cs       圆环扇区、命中、动画、主题
```

要求：Windows 10/11，自带 .NET Framework 4.8。无需安装 SDK。

## 已知边界

- 圆环不负责出图/对话/ComfyUI/选区/语音/图库，这些没有迁移。
- 预设分类完全跟插件/本地预设文件走；圆环不单独编辑预设。
- `Ctrl+Alt+R` 被占用时会自动换备用热键，实际热键以托盘菜单文字为准。
- 如果 `8799` 被旧版圆环占用，新版会启动失败并在托盘提示；先退出旧版。
- 托盘气泡在部分 Windows 通知设置下可能被系统折叠。
