<#
============================================================
  HuanmengRing.ps1 — 幻梦圆环（Windows）

  托盘常驻小助手：全局热键唤出圆环菜单，选参数、套预设、出图、读选区。
  PS 没开也能单独用（自己调接口出图、自己攒对话）。

  运行方式：
    powershell -NoProfile -ExecutionPolicy Bypass -File HuanmengRing.ps1
    powershell ... -File HuanmengRing.ps1 --doctor        自检
    powershell ... -File HuanmengRing.ps1 --chat-test     测一下对话接口通不通
    powershell ... -File HuanmengRing.ps1 --show          启动并把圆环弹出来

  参数：
    --chat-test   用配置文件里的密钥发一句「你好」过去，把结果打在控制台
============================================================
#>

param(
    [switch]$Doctor,
    [switch]$ChatTest,
    [switch]$Show,
    [switch]$Version,
    [switch]$Debug
)

$ErrorActionPreference = 'Stop'

$script:HuanmengVersion = '3.1.1'
$script:AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:LibRoot = Join-Path $script:AppRoot 'lib'

# ------------------------------------------------------------
#  模块加载
# ------------------------------------------------------------

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# WinForms 事件回调里抛出的任何异常都会走到这里（而不是默认的弹框/崩进程）。
# 没有这一条的话，圆环重绘、托盘点击、滑杆拖动里任何一个 bug 都会让进程
# 「图标消失、无声退出」—— 那正是「经常性卡退」的真面目。
# 这里把异常记进崩溃日志（%TEMP%\huanmeng-ring-crash.log），进程继续活着。
[System.Windows.Forms.Application]::add_ThreadException({
    param($sender, $e)
    $log = Join-Path $env:TEMP 'huanmeng-ring-crash.log'
    try {
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
        $line = "$stamp  未处理异常: $($e.Exception.Message)`r`n$($e.Exception.StackTrace)"
        [System.IO.File]::AppendAllText($log, "$line`r`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
})

# 先 dot-source Native.ps1（它负责 Add-Type 出 [Huanmeng.Win32]），
# 再调 DPI —— 顺序反了会直接报「找不到类型」。
. (Join-Path $script:LibRoot 'Native.ps1')

# 高分屏：必须在建任何窗口之前设。设晚了圆环会被系统按 96dpi 拉伸成糊的。
[Huanmeng.Win32]::EnableDpiAwareness()

. (Join-Path $script:LibRoot 'Config.ps1')
. (Join-Path $script:LibRoot 'Api.ps1')
# Gallery 紧跟在 Api 后面：它只依赖 Config 和 Api 里的东西
# （Read-JsonFile / Write-TextFile / Get-OutputFolder），放一起读起来顺
. (Join-Path $script:LibRoot 'Gallery.ps1')
. (Join-Path $script:LibRoot 'Async.ps1')
. (Join-Path $script:LibRoot 'Bridge.ps1')
# Comfy 紧跟 Bridge：它是桥上的一个消息类型（插件直连 ComfyUI 被 CORS 拦时，
# 改由圆环代发），要调 Bridge.ps1 里的 Send-BridgeComfyResponse。
. (Join-Path $script:LibRoot 'Comfy.ps1')
. (Join-Path $script:LibRoot 'RingMenu.ps1')
. (Join-Path $script:LibRoot 'Bubble.ps1')
# Speech 放在 Bubble 之后：气泡建麦克风按钮时要调 Test-VoiceButtonVisible，
# 而 Bubble.ps1 里那段只在运行时执行，顺序其实无所谓 —— 但读起来顺一点。
. (Join-Path $script:LibRoot 'Speech.ps1')
. (Join-Path $script:LibRoot 'Agent.ps1')
. (Join-Path $script:LibRoot 'Menu.ps1')
. (Join-Path $script:LibRoot 'Actions.ps1')
. (Join-Path $script:LibRoot 'Doctor.ps1')
. (Join-Path $script:LibRoot 'Prefs.ps1')

# 后台 runspace 里能用的库。只放真正需要的 —— 那个环境是干净的，
# 多 dot-source 一份就多一份启动开销。
Set-AsyncLibs -Paths @(
    (Join-Path $script:LibRoot 'Config.ps1'),
    (Join-Path $script:LibRoot 'Api.ps1'),
    # Gallery.ps1 必须在这里：收编旧图走后台 —— 出图目录常被 OneDrive 接管，
    # 几千个文件 stat 一遍是好几秒，放绘制路径上就是卡死
    (Join-Path $script:LibRoot 'Gallery.ps1'),
    # Agent.ps1 必须在这里：agent 循环整个跑在后台 runspace 里，
    # 不放进来后台就找不到 Invoke-AgentLoop
    (Join-Path $script:LibRoot 'Agent.ps1'),
    # Comfy.ps1 必须在这里：代理的 HTTP 请求是在后台 runspace 里发的
    # （不能在 UI 线程上发，见 Bridge.ps1 里的说明），
    # 不放进来后台就找不到 Invoke-ComfyRawRequest
    (Join-Path $script:LibRoot 'Comfy.ps1')
)

# ------------------------------------------------------------
#  配置
# ------------------------------------------------------------

$script:Cfg = Get-Config

# --debug 打开诊断日志（%TEMP%\huanmeng-ring-debug.log）。
# 托盘程序没有控制台，像「圆环闪一下就没了」这种问题从外面根本看不出来。
if ($Debug) {
    $script:DebugEnabled = $true
    try { Remove-Item -LiteralPath $script:DebugLogPath -Force -ErrorAction SilentlyContinue } catch { }
    Write-Dbg "=== 幻梦圆环 $($script:HuanmengVersion) 启动（调试模式）==="
    Write-Dbg "PowerShell $($PSVersionTable.PSVersion)   64位进程=$([Environment]::Is64BitProcess)"
    Write-Dbg "AppRoot = $($script:AppRoot)"
}

# ------------------------------------------------------------
#  托盘
# ------------------------------------------------------------

function New-TrayIconBitmap {
    param([int]$Size = 32)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $theme = Get-Theme $script:Cfg.appearance.theme
    $color = ConvertTo-Color $theme.accent 1.0
    $pen = New-Object System.Drawing.Pen($color, [single]($Size * 0.14))
    $pad = $Size * 0.22
    $g.DrawEllipse($pen, [single]$pad, [single]$pad, [single]($Size - $pad * 2), [single]($Size - $pad * 2))
    $pen.Dispose()

    # 中间点一下，小尺寸下更容易认出是个「圆环」而不是字母 O
    $brush = New-Object System.Drawing.SolidBrush($color)
    $dot = $Size * 0.16
    $g.FillEllipse($brush, [single](($Size - $dot) / 2), [single](($Size - $dot) / 2), [single]$dot, [single]$dot)
    $brush.Dispose()
    $g.Dispose()
    return $bmp
}

function Get-TrayIcon {
    $bmp = New-TrayIconBitmap -Size 32
    $handle = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($handle)
    # 从 HICON 造的 Icon 不会自己释放那个 HICON，得手动销毁，
    # 不然每次重建图标都会泄漏一个 GDI 对象
    $script:TrayHicon = $handle
    $bmp.Dispose()
    return $icon
}

# 换配色以后托盘图标要跟着换。旧图标的 HICON 必须先销毁再换新的 ——
# 每次重建都漏一个 GDI 对象的话，挂机久了会把 GDI 额度耗光。
function Refresh-TrayIcon {
    if (-not $script:Tray) { return }
    try {
        if ($script:TrayHicon) {
            [void][Huanmeng.Win32]::DestroyIcon($script:TrayHicon)
            $script:TrayHicon = [IntPtr]::Zero
        }
        $script:Tray.Icon = Get-TrayIcon
    } catch { }
}

function Show-TrayNotification {
    param([string]$Text, [string]$Kind = 'info')

    if (-not $script:Tray) { return }
    if ([string]::IsNullOrWhiteSpace($Text)) { return }

    $title = switch ($Kind) {
        'ok'    { '幻梦圆环' }
        'error' { '幻梦圆环 · 出错' }
        'warn'  { '幻梦圆环 · 注意' }
        default { '幻梦圆环' }
    }

    $script:Tray.BalloonTipTitle = $title
    $script:Tray.BalloonTipText = $Text
    $script:Tray.BalloonTipIcon = switch ($Kind) {
        'error' { [System.Windows.Forms.ToolTipIcon]::Error }
        'warn'  { [System.Windows.Forms.ToolTipIcon]::Warning }
        default { [System.Windows.Forms.ToolTipIcon]::Info }
    }
    try { $script:Tray.ShowBalloonTip(4000) } catch { }
}

$script:Notify = { param($Text, $Kind) Show-TrayNotification -Text $Text -Kind $Kind }

function Open-ConfigFile {
    $path = Get-ConfigPath
    if (-not (Test-Path -LiteralPath $path)) {
        Save-Config -Config $script:Cfg
    }
    # 用记事本打开 —— 不假设用户装了什么编辑器
    Start-Process notepad.exe -ArgumentList "`"$path`""
}

function Reload-Config {
    $script:Cfg = Get-Config
    $script:LocalPresets = $null
    $script:CfgLoadedAt = Get-Date
    & $script:Notify '配置已重新载入' 'ok'
    Push-HuanmengStatus
}

# ------------------------------------------------------------
#  状态文件
# ------------------------------------------------------------

function Push-HuanmengStatus {
    $active = $script:Ring.Visible -or $script:ShotWatch.Active
    Write-Status -Fields @{
        tapActive       = $active
        bridgeConnected = (Test-PluginConnected)
        hotkeyOk        = [bool]$script:HotkeyOk
        hotkey          = [string]$script:Cfg.interaction.hotkey
        mouseHook       = [bool]$script:MouseHook
        pluginLoaded    = (Test-PluginConnected)
    }
}
$script:PushStatus = { Push-HuanmengStatus }

# 圆环弹出/收起时状态文件要立刻跟着变，否则「自检」和安装脚本看到的是旧值
$script:Ring.OnClose = { Push-HuanmengStatus }

# ------------------------------------------------------------
#  全局热键
# ------------------------------------------------------------

function Convert-HotkeySpec {
    param([string]$Spec)

    $modifiers = 0
    $vk = 0
    if (-not $Spec) { return $null }

    $parts = @($Spec.ToLower() -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -eq 0) { return $null }

    for ($i = 0; $i -lt $parts.Count; $i++) {
        $part = $parts[$i]
        $isLast = ($i -eq $parts.Count - 1)

        if (-not $isLast) {
            switch ($part) {
                'ctrl'      { $modifiers = $modifiers -bor [Huanmeng.Win32]::MOD_CONTROL }
                'control'   { $modifiers = $modifiers -bor [Huanmeng.Win32]::MOD_CONTROL }
                'alt'       { $modifiers = $modifiers -bor [Huanmeng.Win32]::MOD_ALT }
                'shift'     { $modifiers = $modifiers -bor [Huanmeng.Win32]::MOD_SHIFT }
                'win'       { $modifiers = $modifiers -bor [Huanmeng.Win32]::MOD_WIN }
                'cmd'       { $modifiers = $modifiers -bor [Huanmeng.Win32]::MOD_WIN }
                'super'     { $modifiers = $modifiers -bor [Huanmeng.Win32]::MOD_WIN }
            }
            continue
        }

        # 最后一段是主键
        if ($part.Length -eq 1) {
            $ch = $part.ToUpper()[0]
            if (($ch -ge 'A' -and $ch -le 'Z') -or ($ch -ge '0' -and $ch -le '9')) {
                $vk = [int][char]$ch
            }
        } elseif ($part -match '^f([1-9]|1[0-9]|2[0-4])$') {
            $vk = 0x70 + ([int]$Matches[1] - 1)     # VK_F1 = 0x70
        } else {
            switch ($part) {
                'space'  { $vk = 0x20 }
                'tab'    { $vk = 0x09 }
                'enter'  { $vk = 0x0D }
                'insert' { $vk = 0x2D }
                'home'   { $vk = 0x24 }
                'end'    { $vk = 0x23 }
            }
        }
    }

    if ($vk -eq 0) { return $null }
    return @{ Modifiers = $modifiers; Vk = $vk }
}

function Register-HuanmengHotkey {
    $spec = Convert-HotkeySpec -Spec ([string]$script:Cfg.interaction.hotkey)
    if ($null -eq $spec) {
        $script:HotkeyOk = $false
        return @{ Ok = $false; Error = "热键格式看不懂：$($script:Cfg.interaction.hotkey)" }
    }

    # 先撤掉旧的，否则改热键时会留下一个还在响应的老热键
    [void][Huanmeng.Win32]::UnregisterHotKey($script:HotkeyWindow.Handle, $script:HK_MAIN)

    $ok = [Huanmeng.Win32]::RegisterHotKey($script:HotkeyWindow.Handle, $script:HK_MAIN, $spec.Modifiers, $spec.Vk)
    $script:HotkeyOk = $ok

    if ($ok) { return @{ Ok = $true; Error = '' } }
    # 注册失败几乎总是被别人占了（微信、QQ、输入法都爱抢 Ctrl+Alt+字母）
    return @{ Ok = $false; Error = "热键 $($script:Cfg.interaction.hotkey) 被别的软件占用了，换一个试试" }
}

# ------------------------------------------------------------
#  唤出圆环
# ------------------------------------------------------------

function Show-Ring {
    param([int]$X = -1, [int]$Y = -1)

    # 旧层级的文字测量缓存里可能有临时字体，先释放再换新层级。
    # 必须在重建菜单**之前**做 —— 释放的是上一轮那些 level 对象。
    foreach ($lvl in @($script:Ring.Stack)) { Dispose-RingLevelFit -Level $lvl }

    # 每次弹出都重建菜单：插件推过来的参数/预设可能变了，
    # 缓存住的话圆环上显示的还是上次的旧值
    # （不再有分页列表要清，这里只建一次菜单就够了）
    $level = Get-MainMenuLevel
    $script:Ring.Stack = @($level)
    Show-RingMenu -X $X -Y $Y
    # 键盘钩子只在圆环开着时挂（理由见 Install-KeyboardHook 上面那段）
    Install-KeyboardHook
}

# ------------------------------------------------------------
#  低级鼠标钩子：Alt + 右键
# ------------------------------------------------------------

function Test-PhotoshopForeground {
    try {
        $hwnd = [Huanmeng.Win32]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        $pid_ = 0
        [void][Huanmeng.Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid_)
        if ($pid_ -le 0) { return $false }
        $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
        if (-not $proc) { return $false }
        return ($proc.ProcessName -like 'Photoshop*')
    } catch {
        return $false
    }
}

function Test-AltRightClickAllowed {
    $cfg = $script:Cfg.interaction
    if (-not $cfg.altRightClick) { return $false }

    switch ([string]$cfg.altRightClickScope) {
        'off'        { return $false }
        'global'     { return $true }
        'photoshop'  { return (Test-PhotoshopForeground) }
    }
    return (Test-PhotoshopForeground)
}

function Install-MouseHook {
    if ($script:MouseHook) { return $true }

    try {
        # 钩子的过滤逻辑在 C# 里（Huanmeng.MouseHook）：
        # 每个系统级鼠标事件先过原生判断，**不是 Alt+右键根本不进 PowerShell**。
        # 旧实现把整个回调写在 PowerShell 里，等于每次鼠标移动都跑一遍脚本 ——
        # 那是全局输入延迟的主要来源。
        $hook = New-Object Huanmeng.MouseHook
        if (-not $hook.Installed) {
            $hook.Dispose()
            return $false
        }

        # 脚本块赋给 Func<int,int,bool> 属性：PowerShell 会自动包成委托。
        # 返回 $true = 吞掉这次右键（圆环已经弹出来了）。
        $hook.AltRightClickHandler = {
            param([int]$x, [int]$y)
            try {
                if (-not (Test-AltRightClickAllowed)) { return $false }
                Show-Ring -X $x -Y $y
                return $true
            } catch {
                Write-CrashLog "Alt右键处理异常: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
                return $false
            }
        }

        $script:MouseHook = $hook
        return $true
    } catch {
        Write-CrashLog "Install-MouseHook: $($_.Exception.Message)"
        return $false
    }
}

function Uninstall-MouseHook {
    if ($script:MouseHook) {
        try { $script:MouseHook.Dispose() } catch { }
        $script:MouseHook = $null
    }
}

# ------------------------------------------------------------
#  低级键盘钩子：只在圆环开着的时候挂
# ------------------------------------------------------------
#  过滤在 C# 里做：不是键按下、或者圆环没开，回调连 vkCode 都不给 PowerShell。
#  圆环开着时用户在打字，键事件本来也不该有任何可感知的额外延迟。

function Install-KeyboardHook {
    if ($script:KeyboardHook) { return $true }

    try {
        $hook = New-Object Huanmeng.KeyboardHook
        if (-not $hook.Installed) {
            $hook.Dispose()
            return $false
        }

        $hook.KeyDownHandler = {
            param([int]$vk)
            try {
                return (Invoke-RingKey -Vk $vk)
            } catch {
                Write-CrashLog "圆环按键处理异常: $($_.Exception.Message)"
                return $false
            }
        }
        $hook.Active = $true

        $script:KeyboardHook = $hook
        return $true
    } catch {
        Write-CrashLog "Install-KeyboardHook: $($_.Exception.Message)"
        return $false
    }
}

function Uninstall-KeyboardHook {
    if ($script:KeyboardHook) {
        try {
            $script:KeyboardHook.Active = $false
            $script:KeyboardHook.Dispose()
        } catch { }
        $script:KeyboardHook = $null
    }
}

# ------------------------------------------------------------
#  定时器
# ------------------------------------------------------------

function Start-HuanmengTimers {
    # 后台任务结果回主线程
    $async = New-Object System.Windows.Forms.Timer
    $async.Interval = 80
    $async.Add_Tick({
        try { Update-AsyncTasks } catch { }
    })
    $async.Start()
    $script:AsyncTimer = $async

    # 插件桥接的收发
    $bridge = New-Object System.Windows.Forms.Timer
    $bridge.Interval = 150
    $bridge.Add_Tick({
        try { Update-HuanmengBridge } catch { }
    })
    $bridge.Start()
    $script:BridgeTimer = $bridge

    # 状态文件 + 配置热重载 + 热键自动重试
    $status = New-Object System.Windows.Forms.Timer
    $status.Interval = 2000
    $status.Add_Tick({
        try {
            Push-HuanmengStatus

            # 热键注册失败不一定是永久失败：
            #  · 刚被杀掉的旧实例可能还没释放热键（重装时的经典竞态）
            #  · 用户开的别的软件（微信、QQ、录屏、IDE 都爱抢 Ctrl+Alt+字母）
            #   也可能只是临时占了，它一释放这里就该抢回来。
            # 之前失败一次就永远失败 —— 热键被人临时占一次，就一天都不能用。
            if (-not $script:HotkeyOk) {
                $retry = Register-HuanmengHotkey
                if ($retry.Ok) {
                    Show-TrayNotification -Text "热键 $($script:Cfg.interaction.hotkey) 已恢复可用" -Kind 'ok'
                }
            }

            # 用户可能刚在记事本里改完配置存盘。只看修改时间，
            # 不去解析内容 —— 解析失败不该让助手崩，Push 里已经兜住了。
            $path = Get-ConfigPath
            if (Test-Path -LiteralPath $path) {
                $written = (Get-Item -LiteralPath $path).LastWriteTime
                if ($written -gt $script:CfgFileTime) {
                    $script:CfgFileTime = $written
                    $oldHotkey = [string]$script:Cfg.interaction.hotkey
                    $script:Cfg = Get-Config
                    $script:LocalPresets = $null

                    # 热键改了要**重新注册**，不然改了配置文件还得重启才生效 ——
                    # 而说明书里写的是「存盘即可」。之前漏了这一步。
                    $newHotkey = [string]$script:Cfg.interaction.hotkey
                    if ($newHotkey -ne $oldHotkey) {
                        $result = Register-HuanmengHotkey
                        if ($result.Ok) {
                            Show-TrayNotification -Text "热键已改为 $newHotkey" -Kind 'ok'
                        } else {
                            Show-TrayNotification -Text $result.Error -Kind 'warn'
                        }
                    } else {
                        Show-TrayNotification -Text '配置已重新载入' -Kind 'ok'
                    }

                    # 鼠标钩子的开关/范围也可能变了
                    if ($script:Cfg.interaction.altRightClick) {
                        if (-not $script:MouseHook) { [void](Install-MouseHook) }
                    } else {
                        Uninstall-MouseHook
                    }

                    if ($script:Ring.Visible) { Draw-RingFrame }
                }
            }
        } catch { }
    })
    $status.Start()
    $script:StatusTimer = $status
}

# 圆环开着时才挂键盘钩子；收起时摘掉
function Sync-KeyboardHook {
    if ($script:Ring.Visible) { Install-KeyboardHook } else { Uninstall-KeyboardHook }
}

# ------------------------------------------------------------
#  安全执行
# ------------------------------------------------------------
#  托盘菜单、按钮回调统一走这里：任何一项出错都只记崩溃日志，
#  不能把整个助手带走，也不能静默失败（静默失败最难查）。
function Invoke-Guarded {
    param([scriptblock]$Action, [string]$Label = '操作')

    try {
        & $Action
    } catch {
        Write-CrashLog "$Label 异常: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
        if ($script:Notify) { & $script:Notify "$Label 出错：$($_.Exception.Message)" 'error' }
    }
}

# ------------------------------------------------------------
#  托盘菜单
# ------------------------------------------------------------

function Initialize-Tray {
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon = Get-TrayIcon
    $tray.Text = "幻梦圆环 $($script:HuanmengVersion)"
    $tray.Visible = $true

    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $header = New-Object System.Windows.Forms.ToolStripMenuItem("幻梦圆环 $($script:HuanmengVersion)")
    $header.Enabled = $false
    [void]$menu.Items.Add($header)

    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

    # 托盘菜单每一项都包一层：任何一项出错都不能把整个助手带走。
    #
    # ⚠️ 这里**必须调全局函数 Invoke-Guarded，不能用一个局部脚本块变量**。
    # 点击回调要等用户点菜单时才执行，那时 Initialize-Tray 的作用域早就没了，
    # PowerShell 的脚本块不会保留函数局部变量 —— 局部变量读出来全是 $null，
    # `& $null { ... }` 会直接抛「表达式生成无效对象」，
    # 然后被全局兜底悄悄吃掉：表现就是「菜单点了没反应」。
    # 这个 bug 真发生过：偏好设置、自检等 7 项全部点不动。
    $showItem = New-Object System.Windows.Forms.ToolStripMenuItem('唤出圆环')
    $showItem.Add_Click({ Invoke-Guarded { Show-Ring } '唤出圆环' })
    [void]$menu.Items.Add($showItem)

    $chatItem = New-Object System.Windows.Forms.ToolStripMenuItem('对话…')
    $chatItem.Add_Click({ Invoke-Guarded { Invoke-ActionChatType } '对话' })
    [void]$menu.Items.Add($chatItem)

    $genItem = New-Object System.Windows.Forms.ToolStripMenuItem('直接出图…')
    $genItem.Add_Click({ Invoke-Guarded { Invoke-ActionPromptText } '直接出图' })
    [void]$menu.Items.Add($genItem)

    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

    $configItem = New-Object System.Windows.Forms.ToolStripMenuItem('打开配置文件')
    $configItem.Add_Click({ Invoke-Guarded { Open-ConfigFile } '打开配置文件' })
    [void]$menu.Items.Add($configItem)

    $importItem = New-Object System.Windows.Forms.ToolStripMenuItem('从插件导入接口配置')
    $importItem.Add_Click({ Invoke-Guarded { Invoke-ImportFromPlugin } '从插件导入配置' })
    [void]$menu.Items.Add($importItem)

    $reloadItem = New-Object System.Windows.Forms.ToolStripMenuItem('重新载入配置')
    $reloadItem.Add_Click({ Invoke-Guarded { Reload-Config } '重新载入配置' })
    [void]$menu.Items.Add($reloadItem)

    $prefsItem = New-Object System.Windows.Forms.ToolStripMenuItem('偏好设置…')
    $prefsItem.Add_Click({ Invoke-Guarded { Show-PrefsWindow } '偏好设置' })
    [void]$menu.Items.Add($prefsItem)

    $doctorItem = New-Object System.Windows.Forms.ToolStripMenuItem('自检…')
    $doctorItem.Add_Click({ Invoke-Guarded { Show-DoctorWindow } '自检' })
    [void]$menu.Items.Add($doctorItem)

    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

    $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('退出幻梦圆环')
    $exitItem.Add_Click({ Stop-HuanmengRing })
    [void]$menu.Items.Add($exitItem)

    $tray.ContextMenuStrip = $menu
    # 左键单击也唤出圆环 —— 比右键再选一项快得多，也是最常用的入口
    $tray.Add_MouseClick({
        param($sender, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            try { Show-Ring } catch { Write-CrashLog "托盘左键异常: $($_.Exception.Message)" }
        }
    })

    $script:Tray = $tray
    $script:TrayMenu = $menu
}

function Invoke-ImportFromPlugin {
    if (-not (Test-PluginConnected)) {
        Show-TrayNotification -Text '插件没连上。先在 Photoshop 里打开插件面板，再点这一项。' -Kind 'warn'
        return
    }

    [void](Send-BridgeCommand -Action 'exportConfig')
    [void](Send-BridgeCommand -Action 'exportPresets')

    # 插件的回复是异步来的（它要先读自己的 localStorage）。
    # 给它一点时间，再检查有没有收到。
    $script:ImportDeadline = (Get-Date).AddSeconds(4)
    if (-not $script:ImportTimer) {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $timer.Add_Tick({ Update-ImportFromPlugin })
        $script:ImportTimer = $timer
    }
    $script:ImportTimer.Start()
    Show-TrayNotification -Text '正在向插件要配置…' -Kind 'info'
}

function Update-ImportFromPlugin {
    if ((Get-Date) -lt $script:ImportDeadline) { return }
    $script:ImportTimer.Stop()

    $incoming = $script:Bridge.IncomingConfig
    if (-not $incoming) {
        Show-TrayNotification -Text '插件没有回配置。确认插件面板开着，再试一次。' -Kind 'warn'
        return
    }

    $applied = @()
    if ($incoming.grsApiKey) { $script:Cfg.api.grsApiKey = [string]$incoming.grsApiKey; $applied += '密钥' }
    if ($incoming.grsRegion) { $script:Cfg.api.grsRegion = [string]$incoming.grsRegion; $applied += '区域' }
    if ($incoming.imgModel)  { $script:Cfg.api.imgModel  = [string]$incoming.imgModel;  $applied += '生图模型' }
    if ($incoming.imageSize) { $script:Cfg.api.imageSize = [string]$incoming.imageSize; $applied += '分辨率' }
    if ($incoming.chatModel) { $script:Cfg.api.chatModel = [string]$incoming.chatModel; $applied += '对话模型' }
    if ($incoming.chatModels) { $script:Cfg.api.chatModels = @($incoming.chatModels) }
    if ($incoming.systemPrompt) { $script:Cfg.api.systemPrompt = [string]$incoming.systemPrompt }
    if ($incoming.chatQuestions) {
        $lines = @()
        foreach ($pair in @($incoming.chatQuestions)) {
            if (@($pair).Count -ge 2) { $lines += "$(@($pair)[0])=$(@($pair)[1])" }
        }
        if ($lines.Count -gt 0) { $script:Cfg.chatQuestions = ($lines -join "`n"); $applied += '快捷提问' }
    }

    Save-Config -Config $script:Cfg

    $presets = $script:Bridge.IncomingPresets
    $presetNote = ''
    if ($presets -and $presets.items) {
        $list = @()
        foreach ($item in @($presets.items)) {
            $list += @{ name = [string]$item.name; prompt = [string]$item.prompt; category = [string]$item.category }
        }
        if ($list.Count -gt 0) {
            Write-TextFile -Path (Get-PresetPath) -Text ($list | ConvertTo-Json -Depth 6)
            $script:LocalPresets = $null
            $presetNote = "，预设 $($list.Count) 条"
        }
    }

    if ($applied.Count -gt 0) {
        Show-TrayNotification -Text "已从插件导入：$($applied -join '、')$presetNote" -Kind 'ok'
    } else {
        Show-TrayNotification -Text '插件回的配置里没有可用的字段' -Kind 'warn'
    }

    $script:Bridge.IncomingConfig = $null
    $script:Bridge.IncomingPresets = $null
}

# ------------------------------------------------------------
#  退出
# ------------------------------------------------------------

function Stop-HuanmengRing {
    try { Stop-ScreenshotWatch } catch { }
    # 退出前一定要把麦克风关掉 —— 引擎握着音频设备不放的话，
    # 下次启动会「打不开麦克风」，而用户完全不知道为什么
    try { Reset-VoiceState } catch { }
    try { [void][Huanmeng.Win32]::UnregisterHotKey($script:HotkeyWindow.Handle, $script:HK_VOICE) } catch { }
    Uninstall-KeyboardHook
    Uninstall-MouseHook
    try { [void][Huanmeng.Win32]::UnregisterHotKey($script:HotkeyWindow.Handle, $script:HK_MAIN) } catch { }
    Stop-HuanmengBridge
    try { Hide-RingMenu } catch { }
    try { if ($script:Tray) { $script:Tray.Visible = $false; $script:Tray.Dispose() } } catch { }
    try { Write-Status -Fields @{ tapActive = $false; bridgeConnected = $false; hotkeyOk = $false; hotkey = ''; pluginLoaded = $false } } catch { }
    try { if ($script:TrayHicon) { [void][Huanmeng.Win32]::DestroyIcon($script:TrayHicon) } } catch { }
    [System.Windows.Forms.Application]::Exit()
}

# ------------------------------------------------------------
#  命令行模式（不进消息循环）
# ------------------------------------------------------------
#
#  这一段必须放在**所有函数定义之后**。
#  PowerShell 是边解析边执行：写在文件前面的分支跑的时候，
#  后面那些函数还没被定义，调它们会直接报「无法识别」。

if ($Version) {
    Write-Output "幻梦圆环 $($script:HuanmengVersion) (Windows)"
    exit 0
}

if ($ChatTest) {
    Write-Output "▶ 测试对话接口"
    $key = [string]$script:Cfg.api.grsApiKey
    if (-not $key -or -not $key.Trim()) {
        Write-Output "✗ 配置文件里没有密钥：$(Get-ConfigPath)"
        exit 1
    }
    Write-Output "  模型：$($script:Cfg.api.chatModel)"
    Write-Output "  区域：$($script:Cfg.api.grsRegion)"
    $result = Invoke-GrsChat -ApiKey $key -Region $script:Cfg.api.grsRegion `
        -Model $script:Cfg.api.chatModel `
        -Messages @(@{ role = 'user'; content = '你好' })
    if ($result.Ok) {
        Write-Output "✓ 通了，回复："
        Write-Output $result.Reply
        exit 0
    }
    Write-Output "✗ 失败：$($result.Error)"
    exit 1
}

if ($Doctor) {
    exit (Invoke-Doctor)
}

# ------------------------------------------------------------
#  单实例
# ------------------------------------------------------------
#
#  放在这儿而不是文件开头：命令行模式（--doctor / --chat-test）**必须能在
#  助手已经跑着的时候用** —— 自检最常见的使用场景恰恰就是「出问题了，
#  但助手还在托盘里挂着」。放前面的话这些模式会被单实例挡掉。

$script:Mutex = New-Object System.Threading.Mutex($false, 'Local\HuanmengRing.SingleInstance')
if (-not $script:Mutex.WaitOne(0, $false)) {
    # 两个实例并存最典型的坏处是抢 8799 端口 ——
    # 那正是「圆环显示未连接」的经典故障，所以直接退出，不要并存。
    [System.Windows.Forms.MessageBox]::Show(
        '幻梦圆环已经在运行了。' + "`n`n" + '看屏幕右下角的托盘图标（可能被折叠在 ∧ 里）。',
        '幻梦圆环', 'OK', 'Information') | Out-Null
    exit 0
}

# ------------------------------------------------------------
#  启动
# ------------------------------------------------------------

Push-HuanmengStatus

$script:HotkeyWindow = New-Object Huanmeng.HotkeyWindow
$script:HotkeyWindow.add_Hotkey({
    param($id)
    if ($id -eq $script:HK_MAIN) {
        try {
            if ($script:Ring.Visible) { Hide-RingMenu } else { Show-Ring }
        } catch {
            Write-CrashLog "热键处理异常: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
        }
        return
    }
    if ($id -eq $script:HK_VOICE) {
        # 按住说话。RegisterHotKey 会在按住期间连发，Invoke-VoiceHotkeyDown
        # 自己用 Armed 标志挡重复；松开靠语音定时器轮询补上。
        try { Invoke-VoiceHotkeyDown }
        catch { Write-CrashLog "语音热键异常: $($_.Exception.Message)`n$($_.ScriptStackTrace)" }
    }
})

$hotkeyResult = Register-HuanmengHotkey
if (-not $hotkeyResult.Ok) {
    Show-TrayNotification -Text $hotkeyResult.Error -Kind 'warn'
}

# 语音热键。语音不可用（没装中文引擎）就不注册 ——
# 注册了也没用，反而占着一个全局组合键。
Initialize-VoiceTimer
if ($script:Cfg.speech.enabled -and (Test-SpeechUsable).Ok) {
    $voiceKey = Register-HuanmengVoiceHotkey
    if (-not $voiceKey.Ok) {
        Show-TrayNotification -Text $voiceKey.Error -Kind 'warn'
    }
} elseif ($script:Cfg.speech.enabled) {
    $speechInfo = Test-SpeechUsable
    Show-TrayNotification -Text "语音输入用不了：$($speechInfo.Error)" -Kind 'warn'
}

Initialize-Tray
Initialize-RingTimer
Initialize-BubbleWindow

$bridgeResult = Start-HuanmengBridge -Port ([int]$script:Cfg.port)
if (-not $bridgeResult.Ok) {
    Show-TrayNotification -Text $bridgeResult.Error -Kind 'warn'
}

if ($script:Cfg.interaction.altRightClick) {
    if (-not (Install-MouseHook)) {
        Show-TrayNotification -Text 'Alt+右键 那一招挂不上（系统钩子被拒），快捷键不受影响' -Kind 'warn'
    }
}

# 圆环里点了扇区之后干什么 —— 接到 Actions.ps1 的分发器上。
#
# **这一行以前是漏掉的。** RingMenu 里 `$script:Ring.OnAction` 默认是 $null，
# 注释写着「由主脚本注入」，可主脚本从来没注入过。后果是**圆环上所有叶子动作
# 全是死的**：生成、读选区、关闭、套预设、切模型…… 点了之后圆环照常收起，
# 然后什么都不发生，也不报错（因为 `if ($ring.OnAction -and $action)` 直接跳过）。
# 表现就是用户说的「圆环的对话用不了」—— 其实是对话、出图、预设一起用不了。
#
# 必须写在脚本顶层：PowerShell 的脚本块不捕获函数局部变量，
# 这里引用的 Invoke-MenuAction 得是脚本作用域里能解析到的。
$script:Ring.OnAction = {
    param($ActionName, $Payload)
    Invoke-MenuAction -Action $ActionName -Payload $Payload
}

# 插件推过来的事件 —— 同样必须在这里接上。
#
# Bridge.ps1 里那几个 `if ($script:OnPluginXxx) { ... }` 全是防御性写法，
# 没人赋值也不报错，只是**默默什么都不做**。之前这五个回调一个都没接，
# 所以插件发回来的回复、进度、状态全被丢进垃圾桶：
# 圆环里问一句，气泡停在「正在想…」就再也没有下文。
$script:OnPluginChat = {
    param($ChatAction, $Payload)
    Receive-PluginChat -ChatAction $ChatAction -Payload $Payload
}

$script:OnPluginState = {
    param($State)
    Receive-PluginState -State $State
}

$script:OnPluginProgress = {
    param($State, $Message, $Thumbnail)
    Receive-PluginProgress -State $State -Message $Message
}

$script:OnBridgeConnected = { Receive-BridgeConnected }
$script:OnBridgeDisconnected = { Receive-BridgeDisconnected }

# 圆环显示/隐藏时同步键盘钩子。挂在 RingMenu 的收尾上，
# 这样不管从哪条路径收起的圆环都能摘掉钩子。
$script:Ring.OnClose = {
    Uninstall-KeyboardHook
    Push-HuanmengStatus
}

Start-HuanmengTimers

# ------------------------------------------------------------
#  图库杂务（启动 10 秒后跑一次，跑完就拆）
#
#  **用独立的一次性定时器，不要塞进那个 2 秒的状态 tick。**
# 那个 tick 每 2 秒要刷状态文件、重试热键、检查配置热重载、重绘，
# 再挂一个可能几百毫秒的目录扫描进去会让状态刷新明显卡顿。
# 一次性定时器跑完自己 Dispose，不留常驻开销。
#
#  **不阻塞启动**：启动路径上先把托盘、圆环、桥接都拉起来，
#  10 秒后用户已经在正常用了，这时候扫目录他才感觉不到。
# ------------------------------------------------------------

function Start-GalleryHousekeeping {
    $t = New-Object System.Windows.Forms.Timer
    $t.Interval = 10000
    $t.Add_Tick({
        try { $script:GalleryHouseTimer.Stop() } catch { }
        try { if ($script:GalleryHouseTimer) { $script:GalleryHouseTimer.Dispose() } } catch { }
        $script:GalleryHouseTimer = $null

        try {
            if (Get-BoolValue -Value $script:Cfg.gallery.sweepTemp -Default $true) {
                # 正在用的几个路径必须跳过。不跳的话，用户刚截的图、
                # 正挂在气泡里看的那张、或者当参考图挂着的那张会凭空消失。
                $keep = @()
                if ($script:Staged.Image)     { $keep += [string]$script:Staged.Image }
                if ($script:Staged.LastImage) { $keep += [string]$script:Staged.LastImage }
                if ($script:Bubble.ImagePath) { $keep += [string]$script:Bubble.ImagePath }
                $swept = Invoke-GalleryTempSweep -MinAgeMinutes 30 -KeepPaths $keep
                if ($swept.Deleted -gt 0) { Write-Dbg "临时文件清理：删了 $($swept.Deleted) 个" }
            }

            # 文件已经不在了的记录清掉。
            # 父目录够不着的（拔了移动硬盘 / 网盘没同步）会保留 ——
            # 见 Repair-GalleryIndex 的注释，那是「够不着」不是「没了」。
            [void](Repair-GalleryIndex)

            # **自动清理一律只收起记录、不删文件。**
            # 就算用户在偏好设置里打开了「连图片文件一起删」，
            # 那也只在手动点「立即清理一次」时生效 —— 自动 + 破坏性 + 无确认
            # 这个组合不该出现。
            [void](Invoke-GalleryPrune -Policy (Get-GalleryPolicy) -AllowedRoot (Get-GalleryOutputFolder))
        } catch {
            Write-CrashLog "图库杂务异常: $($_.Exception.Message)"
        }

        # 首次收编：图库里还是空的、用户也没关掉这个开关。
        # 客户第一次装完打开图库发现是空的、而目录里明明躺着一堆图，
        # 那是最糟的第一印象。
        try {
            if ((Get-BoolValue -Value $script:Cfg.gallery.enabled -Default $true) -and
                (Get-BoolValue -Value $script:Cfg.gallery.adoptOnOpen -Default $true) -and
                (Get-GalleryCount -IncludeHidden) -eq 0) {
                Start-GalleryAdoption
            }
        } catch {
            Write-CrashLog "首次收编异常: $($_.Exception.Message)"
        }
    })
    $t.Start()
    $script:GalleryHouseTimer = $t
}

Start-GalleryHousekeeping

$configPath = Get-ConfigPath
if (Test-Path -LiteralPath $configPath) {
    $script:CfgFileTime = (Get-Item -LiteralPath $configPath).LastWriteTime
} else {
    # 文件还不存在（用户从没改过配置，全用默认值）。
    # 基准给「很久以前」而不是留空 —— 留空的话，配置第一次被创建时
    # 会被当成「建立基准」而不是「发生变化」，那次修改就被吞掉了，
    # 用户会觉得「我在配置文件里改了热键但没生效」。
    $script:CfgFileTime = [datetime]::MinValue
}

Show-TrayNotification -Text "幻梦圆环已启动。按 $($script:Cfg.interaction.hotkey) 或点托盘图标唤出圆环。" -Kind 'ok'

Write-Dbg "启动完成：热键=$($script:HotkeyOk) 桥接=$($bridgeResult.Ok) 鼠标钩子=$([bool]$script:MouseHook)"

if ($Show) {
    Write-Dbg "命令行要求立即弹出圆环"
    Show-Ring
}

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    Stop-HuanmengRing
}
