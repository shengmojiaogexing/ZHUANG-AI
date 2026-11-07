# ============================================================
#  Doctor.ps1 — 自检
#
#  出问题先点它。每一项都直接给出「怎么修」，而不是只报一句「失败」——
#  用户拿着「桥接未连接」这四个字是没法自己往下查的。
# ============================================================

function New-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '', [string]$Fix = '', [string]$Level = '')
    if (-not $Level) { $Level = if ($Ok) { 'ok' } else { 'bad' } }
    return @{ Name = $Name; Ok = $Ok; Detail = $Detail; Fix = $Fix; Level = $Level }
}

# 状态文件每 2 秒刷一次。超过 10 秒没更新就当进程已经不在了 ——
# 助手被强杀时状态文件会留在磁盘上，光看「文件在不在」会误判成「正在运行」。
function Test-HuanmengRunning {
    $status = Read-Status
    if (-not $status.pid) { return $false }
    $updatedAt = $null
    try { $updatedAt = [datetime]::Parse([string]$status.updatedAt) } catch { return $false }
    return (((Get-Date) - $updatedAt).TotalSeconds -lt 10)
}

# 端口能不能绑上 = 有没有人在监听。
# 自检可能是从托盘菜单点的（此时端口被本进程占着），
# 也可能是命令行单独跑的（此时应该没人占）—— 两种情况都要能给出正确结论。
function Test-PortInUse {
    param([int]$Port)

    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $false
    } catch {
        return $true
    } finally {
        if ($listener) { try { $listener.Stop() } catch { } }
    }
}

# 试着注册一次热键再撤掉。
# 命令行自检时助手没在跑，$script:HotkeyOk 是空的 ——
# 但「这个热键能不能用」是可以真测出来的，不该因为没在跑就报失败。
function Test-HotkeyAvailable {
    param([string]$Spec)

    $parsed = Convert-HotkeySpec -Spec $Spec
    if ($null -eq $parsed) { return @{ Ok = $false; Reason = '格式看不懂' } }

    $window = $null
    try {
        $window = New-Object Huanmeng.HotkeyWindow
        $id = 0x484D99
        $ok = [Huanmeng.Win32]::RegisterHotKey($window.Handle, $id, $parsed.Modifiers, $parsed.Vk)
        if ($ok) { [void][Huanmeng.Win32]::UnregisterHotKey($window.Handle, $id) }
        return @{ Ok = $ok; Reason = '' }
    } catch {
        return @{ Ok = $false; Reason = $_.Exception.Message }
    } finally {
        if ($window) { try { $window.DestroyHandle() } catch { } }
    }
}

function Get-DoctorReport {
    $checks = @()

    $appRunning = Test-HuanmengRunning

    # ---- 1. 配置文件 ----
    $path = Get-ConfigPath
    if (Test-Path -LiteralPath $path) {
        $parsed = Read-JsonFile $path
        if ($null -eq $parsed) {
            $checks += New-Check -Name '配置文件' -Ok $false `
                -Detail "$path 存在但读不出 JSON" `
                -Fix '多半是手改的时候少了逗号或引号。删掉这个文件重启助手会自动重建一份。'
        } else {
            $checks += New-Check -Name '配置文件' -Ok $true -Detail $path
        }
    } else {
        $checks += New-Check -Name '配置文件' -Ok $true -Detail "$path（还没生成，用的全是默认值）" -Level 'warn'
    }

    # ---- 2. 密钥 ----
    $key = [string]$script:Cfg.api.grsApiKey
    if ($key -and $key.Trim()) {
        $masked = if ($key.Length -gt 10) { $key.Substring(0, 6) + '…' + $key.Substring($key.Length - 4) } else { '已填' }
        $checks += New-Check -Name 'API 密钥' -Ok $true -Detail $masked
    } else {
        $checks += New-Check -Name 'API 密钥' -Ok $false -Detail '没填' `
            -Fix '菜单栏 ◎ → 打开配置文件 → 填 api.grsApiKey。没密钥出图和对话都会报错。'
    }

    # ---- 3. 助手进程 ----
    if ($appRunning) {
        $checks += New-Check -Name '助手进程' -Ok $true -Detail "正在运行（PID $((Read-Status).pid)）"
    } else {
        $checks += New-Check -Name '助手进程' -Ok $false -Detail '没在运行' `
            -Fix '开始菜单 →「幻梦圆环」，或者双击部署包里的「启动幻梦圆环.bat」。'
    }

    # ---- 4. 热键 ----
    $hotkeySpec = [string]$script:Cfg.interaction.hotkey

    # 自检常常跑在**另一个进程**里（安装脚本第 5 步就是），
    # 那个进程里 $script:HotkeyOk 永远是空的。这时候要信状态文件 ——
    # 不然助手明明注册成功了，自检却一口咬定「注册失败」。
    $hotkeyLive = $script:HotkeyOk
    if ($null -eq $hotkeyLive) { $hotkeyLive = [bool](Read-Status).hotkeyOk }

    if ($hotkeyLive) {
        # 助手在跑并且注册成功了 —— 最可靠的一种
        $checks += New-Check -Name '全局热键' -Ok $true -Detail "$hotkeySpec（已注册）"
    } elseif ($appRunning) {
        $checks += New-Check -Name '全局热键' -Ok $false -Detail "$hotkeySpec 注册失败" `
            -Fix '多半被别的软件占了（微信、QQ、输入法都爱抢 Ctrl+Alt+字母）。托盘 ◎ → 偏好设置 → 交互 → 热键，换一个。'
    } else {
        # 助手没在跑，那就真测一次这个热键能不能注册
        $probe = Test-HotkeyAvailable -Spec $hotkeySpec
        if ($probe.Ok) {
            $checks += New-Check -Name '全局热键' -Ok $true -Detail "$hotkeySpec（当前可用）"
        } else {
            $checks += New-Check -Name '全局热键' -Ok $false -Detail "$hotkeySpec 用不了（$($probe.Reason)）" `
                -Fix '这个组合被别的软件占了，或者写法不对。改成 ctrl+alt+r 这种形式试试。'
        }
    }

    # ---- 5. 桥接端口 ----
    $port = [int]$script:Cfg.port
    $inUse = Test-PortInUse -Port $port

    if (Test-PluginConnected) {
        $checks += New-Check -Name '插件连接' -Ok $true -Detail "已连上（127.0.0.1:$port）"
    } elseif ($inUse -and $appRunning) {
        $checks += New-Check -Name '插件连接' -Ok $false -Detail "端口 $port 在监听，但没有插件连上来" `
            -Fix '① Photoshop 开着吗 ② 插件加载了吗（PS → 插件 → 幻梦AI 修图插件）③ 面板打开了吗。三条都满足会自动连上。'
    } elseif ($inUse -and -not $appRunning) {
        $checks += New-Check -Name '插件连接' -Ok $false -Detail "端口 $port 被别的程序占着，助手起不来桥接" `
            -Fix '去任务管理器结束占着这个端口的进程，或者托盘 → 偏好设置 → 高级 里换一个端口。'
    } else {
        $checks += New-Check -Name '插件连接' -Ok $true -Level 'warn' -Detail "端口 $port 空着（助手没在运行）"
    }

    # ---- 5. Photoshop ----
    $ps = @(Get-Process -Name 'Photoshop*' -ErrorAction SilentlyContinue)
    if ($ps.Count -gt 0) {
        $checks += New-Check -Name 'Photoshop' -Ok $true -Detail ("正在运行（PID " + ($ps[0].Id) + "）")
    } else {
        $checks += New-Check -Name 'Photoshop' -Ok $true -Level 'warn' -Detail '没在运行' `
            -Fix '不影响助手单独出图和对话。要用「读选区」「把图贴回文档」才需要它。'
    }

    # ---- 6. 预设 ----
    $presets = Get-PresetList
    if ($presets.Count -gt 0) {
        $categories = @($presets | ForEach-Object { $_.category } | Sort-Object -Unique).Count
        $checks += New-Check -Name '预设' -Ok $true -Detail "$($presets.Count) 条 / $categories 个分类"
    } else {
        $checks += New-Check -Name '预设' -Ok $false -Detail '一条都没有' `
            -Fix "包里的 presets.json 没被读到。检查 $(Join-Path $script:AppRoot 'presets.json') 在不在。"
    }

    # ---- 7. 出图目录 ----
    $folder = Get-OutputFolder -Configured ([string]$script:Cfg.api.outputFolder)
    if (Test-Path -LiteralPath $folder) {
        $writable = $true
        try {
            $probe = Join-Path $folder ('.huanmeng-write-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
            [System.IO.File]::WriteAllText($probe, 'ok')
            Remove-Item -LiteralPath $probe -Force
        } catch { $writable = $false }

        if ($writable) {
            $checks += New-Check -Name '出图目录' -Ok $true -Detail $folder
        } else {
            $checks += New-Check -Name '出图目录' -Ok $false -Detail "$folder 不可写" `
                -Fix '文件夹被设成只读了，或者当前账号没权限。在偏好设置 → 高级 里换一个目录。'
        }
    } else {
        $checks += New-Check -Name '出图目录' -Ok $false -Detail "$folder 不存在且建不出来" `
            -Fix '在偏好设置 → 高级 里改一个存在的目录。'
    }

    # ---- 9. 系统钩子 ----
    if ($script:Cfg.interaction.altRightClick) {
        # 和热键同理：跨进程时 $script:MouseHook 是空的，得看状态文件
        $hookLive = $script:MouseHook
        if ($null -eq $hookLive) { $hookLive = [bool](Read-Status).mouseHook }

        if (-not $appRunning) {
            $checks += New-Check -Name 'Alt + 右键' -Ok $true -Level 'warn' `
                -Detail '助手没在运行，这项验证不了'
        } elseif ($hookLive) {
            $checks += New-Check -Name 'Alt + 右键' -Ok $true -Detail ("作用范围：" + $script:Cfg.interaction.altRightClickScope)
        } else {
            $checks += New-Check -Name 'Alt + 右键' -Ok $false -Detail '鼠标钩子没挂上' `
                -Fix '不影响 Ctrl+Alt+R。要恢复的话重启一次助手；如果 Photoshop 是「以管理员身份运行」，钩子也够不着它。'
        }
    } else {
        $checks += New-Check -Name 'Alt + 右键' -Ok $true -Level 'warn' -Detail '已关闭'
    }

    return $checks
}

function Format-DoctorLine {
    param($Check)

    $mark = switch ($Check.Level) {
        'ok'   { '✓' }
        'warn' { '!' }
        default { '✗' }
    }
    $line = "$mark $($Check.Name)"
    if ($Check.Detail) { $line += "  —— $($Check.Detail)" }
    return $line
}

function Invoke-Doctor {
    $checks = Get-DoctorReport
    $bad = @($checks | Where-Object { -not $_.Ok }).Count

    # **用 [Console]::Out 而不是 Write-Output**。
    # 调用方写的是 `exit (Invoke-Doctor)` —— 那是个子表达式，
    # Write-Output 出来的东西会被当成「返回值」一起吞掉，一个字都打不出来。
    # 直接写控制台 stdout 就没这个问题，而且父进程管道仍然能捕获到。
    $write = { param($line) [Console]::Out.WriteLine($line) }

    & $write ''
    & $write "幻梦圆环 $($script:HuanmengVersion) · 自检"
    & $write ('-' * 52)
    foreach ($check in $checks) {
        & $write (Format-DoctorLine -Check $check)
        if (-not $check.Ok -and $check.Fix) { & $write "    → $($check.Fix)" }
    }
    & $write ('-' * 52)
    if ($bad -eq 0) {
        & $write '全部通过。'
        return 0
    }
    & $write "$bad 项要处理。"
    return 1
}

function Show-DoctorWindow {
    $checks = Get-DoctorReport
    $bad = @($checks | Where-Object { -not $_.Ok }).Count

    $lines = @()
    foreach ($check in $checks) {
        $lines += Format-DoctorLine -Check $check
        if (-not $check.Ok -and $check.Fix) { $lines += "    → $($check.Fix)" }
    }
    $lines += ''
    if ($bad -eq 0) { $lines += '全部通过。' } else { $lines += "$bad 项要处理。" }

    Show-HuanmengBubble -Mode 'text' -Title '自检' -Width 620 -Height 420 `
        -Hint 'Esc 关闭' -InitialText ($lines -join "`r`n")
}
