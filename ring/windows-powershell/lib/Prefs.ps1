# ============================================================
#  Prefs.ps1 — 偏好设置
#
#  布局是「左侧导航 + 右侧内容」，不是 TabControl。原因很实际：
#  WinForms 的 TabControl 页签由系统绘制，在深色窗体上会留一排浅灰方块，
#  怎么调都别扭；自绘页签要接管 DrawItem 和各种状态，代码更多、效果更差。
#
#  ⚠️ 这个文件里有一条必须遵守的规矩：
#
#     **事件回调里不能引用任何函数内的局部变量。**
#
#  PowerShell 的脚本块看起来能捕获定义处的局部变量，但函数一返回，
#  那些变量就被清空了 —— 回调运行时读到的全是 $null（实测确认）。
#  所以这里的回调一律：只读 $script: 作用域、只调全局函数、
#  需要区分是哪个控件就查 $sender / $sender.Tag。
#
#  滑杆（Huanmeng.UiSlider）是 C# 写的，状态是对象字段，天然不受这条限制。
# ============================================================

$script:PrefsForm = $null
$script:PrefsNav = @()
$script:PrefsPageHost = $null
$script:PrefsCurrentPage = 'appearance'

# 偏好设置的配色跟随圆环当前主题。
# 换主题时整窗重刷（Show-PrefsWindow 会重建，改主题的那一下会顺手调用）。
# 开窗之前也需要一份能用的值，所以这里先给一套深色兜底。
$script:Ui = @{
    bg        = [System.Drawing.Color]::FromArgb(255, 22, 26, 34)
    surface   = [System.Drawing.Color]::FromArgb(255, 31, 37, 47)
    surfaceHi = [System.Drawing.Color]::FromArgb(255, 41, 49, 62)
    border    = [System.Drawing.Color]::FromArgb(255, 48, 58, 74)
    fg        = [System.Drawing.Color]::FromArgb(255, 232, 238, 247)
    dim       = [System.Drawing.Color]::FromArgb(255, 138, 150, 168)
    accent    = [System.Drawing.Color]::FromArgb(255, 77, 134, 255)
    good      = [System.Drawing.Color]::FromArgb(255, 96, 208, 150)
    bad       = [System.Drawing.Color]::FromArgb(255, 255, 122, 122)
}

function Update-PrefsTheme {
    $p = Get-UiPalette
    $script:Ui = @{
        bg        = $p.bg
        surface   = $p.surface
        surfaceHi = $p.surfaceHi
        border    = $p.border
        fg        = $p.fg
        dim       = $p.dim
        accent    = $p.accent
        good      = $p.good
        bad       = $p.bad
    }
}

function Get-PrefsColors { return $script:Ui }

function Apply-Prefs {
    $result = Register-HuanmengHotkey
    if ($script:PrefsHotkeyNote) {
        if ($result.Ok) {
            $script:PrefsHotkeyNote.Text = '✓ 已生效'
            $script:PrefsHotkeyNote.ForeColor = $script:Ui.good
        } else {
            $script:PrefsHotkeyNote.Text = $result.Error
            $script:PrefsHotkeyNote.ForeColor = $script:Ui.bad
        }
    }

    if ($script:Cfg.interaction.altRightClick) {
        if (-not $script:MouseHook) { [void](Install-MouseHook) }
    } else {
        Uninstall-MouseHook
    }

    # 语音热键是另一个 id，得单独重注册一遍 ——
    # 上面那个 Register-HuanmengHotkey 只管主热键，
    # 少了这一句用户在语音页改的热键要重启才生效。
    if ($script:Cfg.speech -and $script:Cfg.speech.enabled -and (Test-SpeechUsable).Ok) {
        [void](Register-HuanmengVoiceHotkey)
    }

    if ($script:Ring.Visible) { Draw-RingFrame }
    Update-BubbleMicButton
    Push-HuanmengStatus
}

function Save-Prefs { Save-Config -Config $script:Cfg }

# ============================================================
#  回调存取
# ============================================================
#  回调统一放在控件的 Tag 里（一个哈希表），而不是让脚本块去闭包捕获。
#  Tag 是控件自己的字段，和函数作用域没关系，函数返回了它还在。

function Set-CtrlCallback {
    param($Control, [scriptblock]$Callback, [string]$Id = '')

    if ($Control.Tag -is [hashtable]) {
        $Control.Tag.cb = $Callback
        if ($Id) { $Control.Tag.id = $Id }
    } else {
        $Control.Tag = @{ cb = $Callback; id = $Id }
    }
}

function Get-CtrlState {
    param($Control)
    if ($Control.Tag -is [hashtable]) { return $Control.Tag }
    return @{}
}

function Invoke-CtrlCallback {
    param($Control, $Value)

    $state = Get-CtrlState -Control $Control

    # 把「是哪个控件触发的」写进脚本作用域，回调里读 $script:PrefsEventId。
    # 为什么绕这一圈：回调脚本块不能引用函数局部变量（见文件头），
    # 而控件自己又是从 $sender 拿到的 —— 把 id 中转一次，
    # 回调就只需要认 $script:PrefsEventId 这一个约定。
    $script:PrefsEventId = [string]$state.id
    $script:PrefsEventSource = $Control

    if ($state.cb) { & $state.cb $Value }
}

# ============================================================
#  基础控件
# ============================================================

function New-UiLabel {
    # Color 不能写成 `= $null` —— 参数声明成 [System.Drawing.Color] 之后，
    # 默认值 $null 会在绑定时就抛「无法把 null 转成 Color」，函数体都进不去。
    param([string]$Text, [int]$Width = 120, [double]$Size = 13, [System.Drawing.Color]$Color)

    if (-not $PSBoundParameters.ContainsKey('Color')) { $Color = $script:Ui.fg }

    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.Width = $Width
    $label.Height = 24
    $label.AutoSize = $false
    $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $label.ForeColor = $Color
    $label.BackColor = [System.Drawing.Color]::Transparent
    $label.Font = Get-BubbleFont -Pixels $Size
    return $label
}

function New-UiSection {
    param([string]$Title)

    $panel = New-Object System.Windows.Forms.Panel
    $panel.Height = 40
    $panel.Dock = [System.Windows.Forms.DockStyle]::Top
    $panel.BackColor = [System.Drawing.Color]::Transparent

    $label = New-UiLabel -Text $Title -Width 560 -Size 12 -Color $script:Ui.dim
    $label.Location = New-Object System.Drawing.Point(0, 14)
    $label.Parent = $panel

    $rule = New-Object System.Windows.Forms.Panel
    $rule.Height = 1
    $rule.BackColor = $script:Ui.border
    $rule.Location = New-Object System.Drawing.Point(0, 36)
    $rule.Width = 540
    $rule.Anchor = 'Top,Left,Right'
    $rule.Parent = $panel

    return $panel
}

function New-PrefsSlider {
    param(
        [double]$Min, [double]$Max, [double]$Value,
        [scriptblock]$OnChange = $null,
        [string]$Format = '{0}'
    )

    $slider = New-Object Huanmeng.UiSlider
    $slider.Min = $Min
    $slider.Max = $Max
    $slider.ValueFormat = $Format
    $slider.Width = 420
    $slider.Height = 30
    $slider.Font = Get-BubbleFont -Pixels 12
    $slider.TrackColor = $script:Ui.surfaceHi
    $slider.Accent = $script:Ui.accent
    $slider.KnobColor = $script:Ui.fg
    $slider.ReadoutColor = $script:Ui.dim
    $slider.SetValueSilent($Value)

    if ($OnChange) { $slider.add_ValueChanged($OnChange) }
    return $slider
}

function New-PrefsCheck {
    param([string]$Text, [bool]$Checked, [scriptblock]$OnChange = $null, [string]$Id = '')

    $box = New-Object System.Windows.Forms.CheckBox
    $box.Text = $Text
    $box.Checked = $Checked
    $box.Width = 340
    $box.Height = 26
    $box.ForeColor = $script:Ui.fg
    $box.BackColor = [System.Drawing.Color]::Transparent
    $box.Font = Get-BubbleFont -Pixels 13
    $box.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat

    Set-CtrlCallback -Control $box -Callback $OnChange -Id $Id
    $box.Add_CheckedChanged({ param($sender, $e) Invoke-CtrlCallback -Control $sender -Value $sender.Checked })
    return $box
}

function New-PrefsCombo {
    param([string[]]$Items, [string]$Selected, [scriptblock]$OnChange = $null, [int]$Width = 240, [string]$Id = '')

    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    $combo.Width = $Width
    $combo.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $combo.BackColor = $script:Ui.surface
    $combo.ForeColor = $script:Ui.fg
    $combo.Font = Get-BubbleFont -Pixels 13
    foreach ($item in $Items) { [void]$combo.Items.Add($item) }
    if ($Selected -and $combo.Items.Contains($Selected)) { $combo.SelectedItem = $Selected }
    elseif ($combo.Items.Count -gt 0) { $combo.SelectedIndex = 0 }

    Set-CtrlCallback -Control $combo -Callback $OnChange -Id $Id
    # 用 $sender 拿当前控件，不引用外面任何变量 —— 见文件头的规矩
    $combo.Add_SelectedIndexChanged({ param($sender, $e) Invoke-CtrlCallback -Control $sender -Value ([string]$sender.SelectedItem) })
    return $combo
}

function New-PrefsText {
    param([string]$Value, [scriptblock]$OnChange = $null, [int]$Width = 240, [string]$Id = '')

    $box = New-Object System.Windows.Forms.TextBox
    $box.Width = $Width
    $box.Text = $Value
    $box.BackColor = $script:Ui.surface
    $box.ForeColor = $script:Ui.fg
    $box.Font = Get-BubbleFont -Pixels 13
    $box.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle

    Set-CtrlCallback -Control $box -Callback $OnChange -Id $Id
    $box.Add_TextChanged({ param($sender, $e) Invoke-CtrlCallback -Control $sender -Value $sender.Text })
    return $box
}

function New-PrefsButton {
    param([string]$Text, [scriptblock]$OnClick, [int]$Width = 130, [string]$Id = '')

    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $Text
    $btn.Width = $Width
    $btn.Height = 28
    $btn.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $btn.FlatAppearance.BorderColor = $script:Ui.border
    $btn.FlatAppearance.MouseOverBackColor = $script:Ui.surfaceHi
    $btn.BackColor = $script:Ui.surface
    $btn.ForeColor = $script:Ui.fg
    $btn.Font = Get-BubbleFont -Pixels 12

    Set-CtrlCallback -Control $btn -Callback $OnClick -Id $Id
    $btn.Add_Click({ param($sender, $e) Invoke-CtrlCallback -Control $sender -Value $null })
    return $btn
}

function New-PrefsRow {
    param($Label, $Control, [string]$Note = '', [int]$Height = 38)

    $panel = New-Object System.Windows.Forms.Panel
    $panel.Height = $Height
    $panel.Dock = [System.Windows.Forms.DockStyle]::Top
    $panel.BackColor = [System.Drawing.Color]::Transparent

    # 局部变量不能叫 $label / $note：PowerShell 变量名大小写不敏感，
    # 和参数 $Label / $Note 是同一个变量。$Note 还声明成了 [string]，
    # 往里赋一个 Label 控件会被静默转成字符串，下一行就报「找不到 Location」。
    if ($Label) {
        $labelCtl = New-UiLabel -Text $Label -Width 118
        $labelCtl.Location = New-Object System.Drawing.Point(0, 8)
        $labelCtl.Parent = $panel
    }

    $Control.Location = New-Object System.Drawing.Point(126, 4)
    $Control.Parent = $panel

    if ($Note) {
        $noteCtl = New-UiLabel -Text $Note -Width 400 -Size 11 -Color $script:Ui.dim
        $noteCtl.Location = New-Object System.Drawing.Point(0, ($Height - 16))
        $noteCtl.Parent = $panel
    }

    return $panel
}

# ============================================================
#  外观页
# ============================================================

# 重画圆环。改了任何外观设置都调它 —— 圆环开着时立刻能看到效果。
function Update-RingPreview {
    if ($script:Ring.Visible) { Draw-RingFrame }
}

# 字号相关的三个字体跟着重建。少建一个会在绘制时读到 $null 字体。
function Reset-RingFonts {
    $a = $script:Cfg.appearance
    foreach ($f in @($script:Ring.Font, $script:Ring.FontSmall, $script:Ring.FontHub)) {
        if ($f) { try { $f.Dispose() } catch { } }
    }
    $script:Ring.Font = Get-RingFont -Pixels $a.labelFontSize
    $script:Ring.FontSmall = Get-RingFont -Pixels $a.hubSubFontSize
    $script:Ring.FontHub = Get-RingFont -Pixels $a.hubTitleFontSize

    # ---- 引用这几个字体的缓存必须一起作废 ----
    #
    # 上面 Dispose 掉的是真对象，可缓存里还留着指向它们的引用：
    #   · $Ring.CenterFit.Font 往往**就是**刚被释放的 $Ring.FontHub
    #     （见 Draw-RingFrame 里 `$titleFont = $ring.FontHub`）；
    #   · 每个条目的 FitFont、以及层级上的 FitFonts 也一样。
    #
    # 而 CenterFit 的失效键是「悬停项|标题|hubTitleFontSize|缩放」——
    # 拖「扇区字号」或「中心副标题」时这个键**根本不变**，缓存被原样复用，
    # 下一帧就拿一个已释放的 Font 去 DrawString，GDI+ 抛「参数无效」。
    # 实测：圆环开着拖字号滑杆，20 秒里崩了 225 次，画面直接卡住。
    #
    # 顺序要紧：先把条目的 FitKey 置空逼它们重新测量，再释放旧字体 ——
    # 反过来的话，FitKey 没变的条目会继续用着已经被释放的 FitFont。
    $script:Ring.CenterFit = $null
    foreach ($lvl in @($script:Ring.Stack)) {
        foreach ($it in @($lvl.Items)) { $it.FitKey = $null }
        Dispose-RingLevelFit -Level $lvl
    }

    # 扇区字体是 Draw-RingFrame 按「配置字号 × 项数」现建的，
    # 这里清掉比对键让它跟着重建（旧的会在重建时被释放）。
    $script:Ring.SectorFontKey = ''
}

function Build-PrefsAppearancePage {
    $a = $script:Cfg.appearance
    $rows = New-Object System.Collections.ArrayList

    [void]$rows.Add((New-UiSection -Title '几何'))

    [void]$rows.Add((New-PrefsRow -Label '环大小' -Control (New-PrefsSlider -Min 80 -Max 400 -Value $a.outerRadius -Format '{0} px' -OnChange {
        param($v)
        $script:Cfg.appearance.outerRadius = [int]$v
        Update-RingPreview
    })))

    # 厚度用比例表示（mac 版同名键 bandRatio）：改半径时厚度自动等比跟随，
    # 用绝对像素的话半径调大一圈环带就细得像根线。
    [void]$rows.Add((New-PrefsRow -Label '环带比例' -Control (New-PrefsSlider -Min 0.15 -Max 0.72 -Value $a.bandRatio -Format '{0:P0}' -OnChange {
        param($v)
        $script:Cfg.appearance.bandRatio = [double]$v
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '扇区间隙' -Control (New-PrefsSlider -Min 0 -Max 0.5 -Value $a.gapRatio -Format '{0:P0}' -OnChange {
        param($v)
        $script:Cfg.appearance.gapRatio = [double]$v
        Update-RingPreview
    }) -Note '按扇区角度的百分比算，另有 6° 上限；子菜单项多时不会被切碎'))

    [void]$rows.Add((New-PrefsRow -Label '弹出距离' -Control (New-PrefsSlider -Min 0 -Max 30 -Value $a.popDistance -Format '{0} px' -OnChange {
        param($v)
        $script:Cfg.appearance.popDistance = [int]$v
        Update-RingPreview
    }) -Note '鼠标划过的扇区向外弹出的距离'))

    [void]$rows.Add((New-UiSection -Title '样式'))

    [void]$rows.Add((New-PrefsRow -Label '不透明度' -Control (New-PrefsSlider -Min 0.3 -Max 1.0 -Value $a.opacity -Format '{0:P0}' -OnChange {
        param($v)
        $script:Cfg.appearance.opacity = [double]$v
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '投影浓度' -Control (New-PrefsSlider -Min 0 -Max 0.9 -Value $a.shadowAlpha -Format '{0:P0}' -OnChange {
        param($v)
        $script:Cfg.appearance.shadowAlpha = [double]$v
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '投影扩散' -Control (New-PrefsSlider -Min 0 -Max 40 -Value $a.shadowBlur -Format '{0} px' -OnChange {
        param($v)
        $script:Cfg.appearance.shadowBlur = [int]$v
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '投影偏移' -Control (New-PrefsSlider -Min -20 -Max 30 -Value $a.shadowOffsetY -Format '{0} px' -OnChange {
        param($v)
        $script:Cfg.appearance.shadowOffsetY = [int]$v
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '动画起始缩放' -Control (New-PrefsSlider -Min 0.5 -Max 1.0 -Value $a.appearScale -Format '{0:P0}' -OnChange {
        param($v)
        $script:Cfg.appearance.appearScale = [double]$v
    }) -Note '1.0 = 不做缩放，直接出现'))

    $themeLabels = @(Get-ThemeNames | ForEach-Object { Get-ThemeLabel $_ })
    [void]$rows.Add((New-PrefsRow -Label '配色' -Control (New-PrefsCombo -Items $themeLabels -Selected (Get-ThemeLabel $a.theme) -OnChange {
        param($label)
        foreach ($name in Get-ThemeNames) {
            if ((Get-ThemeLabel $name) -eq $label) { $script:Cfg.appearance.theme = $name; break }
        }
        $script:Ring.Theme = Get-Theme $script:Cfg.appearance.theme
        Refresh-TrayIcon
        Update-RingPreview

        # 偏好设置窗自己也跟着换色。整窗重建 —— 逐个去改每个控件的颜色
        # 一定会漏掉几个（标签、分隔线、面板底色……），重建是唯一能保证一致的做法。
        # 用 BeginInvoke 推迟到这次事件走完，否则会在事件处理中销毁 sender。
        $host_ = $script:PrefsPageHost
        if ($host_ -and $host_.IsHandleCreated) {
            [void]$host_.BeginInvoke([Action]{ Show-PrefsWindow -Rebuild })
        }
    })))

    [void]$rows.Add((New-UiSection -Title '文字与提示'))

    [void]$rows.Add((New-PrefsRow -Label '扇区字号' -Control (New-PrefsSlider -Min 9 -Max 28 -Value $a.labelFontSize -Format '{0} px' -OnChange {
        param($v)
        $script:Cfg.appearance.labelFontSize = [int]$v
        Reset-RingFonts
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '中心标题' -Control (New-PrefsSlider -Min 9 -Max 32 -Value $a.hubTitleFontSize -Format '{0} px' -OnChange {
        param($v)
        $script:Cfg.appearance.hubTitleFontSize = [int]$v
        Reset-RingFonts
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '中心副标题' -Control (New-PrefsSlider -Min 8 -Max 24 -Value $a.hubSubFontSize -Format '{0} px' -OnChange {
        param($v)
        $script:Cfg.appearance.hubSubFontSize = [int]$v
        Reset-RingFonts
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text '有子菜单的扇区显示 ›' -Checked $a.showChildMarker -OnChange {
        param($v)
        $script:Cfg.appearance.showChildMarker = [bool]$v
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text '显示方向指示线' -Checked $a.showDirectionLine -OnChange {
        param($v)
        $script:Cfg.appearance.showDirectionLine = [bool]$v
        Update-RingPreview
    })))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text '弹出动画' -Checked $a.animation -OnChange {
        param($v) $script:Cfg.appearance.animation = [bool]$v
    })))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text '投影' -Checked $a.shadowEnabled -OnChange {
        param($v)
        $script:Cfg.appearance.shadowEnabled = [bool]$v
        Update-RingPreview
    })))

    return @($rows)
}

# ============================================================
#  交互页
# ============================================================

function Build-PrefsInteractionPage {
    $i = $script:Cfg.interaction
    $rows = New-Object System.Collections.ArrayList

    [void]$rows.Add((New-UiSection -Title '唤出方式'))

    $hotkeyBox = New-PrefsText -Value ([string]$i.hotkey) -Width 240 -OnChange {
        param($text)
        $script:Cfg.interaction.hotkey = $text.Trim()
        Apply-Prefs
    }
    [void]$rows.Add((New-PrefsRow -Label '全局热键' -Control $hotkeyBox -Note '写法：ctrl+alt+r、ctrl+shift+f2'))

    $noteRow = New-Object System.Windows.Forms.Panel
    $noteRow.Height = 26
    $noteRow.Dock = [System.Windows.Forms.DockStyle]::Top
    $noteRow.BackColor = [System.Drawing.Color]::Transparent
    $note = New-UiLabel -Text '✓ 已生效' -Width 400 -Size 12 -Color $script:Ui.good
    $note.Location = New-Object System.Drawing.Point(126, 2)
    $note.Parent = $noteRow
    $script:PrefsHotkeyNote = $note
    [void]$rows.Add($noteRow)

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text '按住 Alt 再点右键唤出圆环' -Checked $i.altRightClick -OnChange {
        param($v)
        $script:Cfg.interaction.altRightClick = [bool]$v
        Apply-Prefs
    })))

    $scopeLabels = @('只在 Photoshop 里', '任何程序里', '关闭')
    $scopeNow = switch ([string]$i.altRightClickScope) {
        'global' { '任何程序里' }
        'off'    { '关闭' }
        default  { '只在 Photoshop 里' }
    }
    [void]$rows.Add((New-PrefsRow -Label 'Alt右键范围' -Control (New-PrefsCombo -Items $scopeLabels -Selected $scopeNow -OnChange {
        param($label)
        $script:Cfg.interaction.altRightClickScope = switch ($label) {
            '任何程序里' { 'global' }
            '关闭'       { 'off' }
            default      { 'photoshop' }
        }
        Apply-Prefs
    })))

    [void]$rows.Add((New-UiSection -Title '圆环里的操作'))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text '鼠标划过时高亮' -Checked $i.hoverHighlight -OnChange {
        param($v)
        $script:Cfg.interaction.hoverHighlight = [bool]$v
        if ($script:Ring.Visible) { Draw-RingFrame }
    })))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text '数字键 1–9 直接选' -Checked $i.numberKeys -OnChange {
        param($v) $script:Cfg.interaction.numberKeys = [bool]$v
    })))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text 'Esc 关闭圆环' -Checked $i.escClose -OnChange {
        param($v) $script:Cfg.interaction.escClose = [bool]$v
    })))

    $tipRow = New-Object System.Windows.Forms.Panel
    $tipRow.Height = 30
    $tipRow.Dock = [System.Windows.Forms.DockStyle]::Top
    $tipRow.BackColor = [System.Drawing.Color]::Transparent
    $tip = New-UiLabel -Text '左键选中 · 1–9 直接选 · Esc 关掉 · ← 或 Delete 返回上一级 · 右键收起' -Width 560 -Size 11 -Color $script:Ui.dim
    $tip.Location = New-Object System.Drawing.Point(0, 8)
    $tip.Parent = $tipRow
    [void]$rows.Add($tipRow)

    return @($rows)
}

# ============================================================
#  内容页
# ============================================================

function Get-SectorActionChoices {
    # 动作的唯一定义在插件那边（ring-bridge.js 的 ACTIONS）。
    # 插件没连上时用这份兜底表 —— 两边对不上，用户选的动作插件就不认。
    return @(
        'generate', 'params', 'presets', 'chatMenu', 'openChat', 'chatNew',
        'readSelection', 'clearPrompt', 'gallery', 'close',
        'tab:img2img', 'tab:apps', 'tab:toolbox', 'tab:runninghub',
        'tab:gallery', 'tab:generationCenter', 'tab:logs', 'tab:settings'
    )
}

# 内容页所有回调共用的三个入口。
# 写成具名函数，回调里只需要 `$sender.Tag.id`，不碰任何局部变量。
function Set-SectorLabel { param([string]$Id, [string]$Label)
    if ($script:Cfg.content.sectors[$Id]) { $script:Cfg.content.sectors[$Id].label = $Label }
}

function Set-SectorVisible { param([string]$Id, [bool]$Visible)
    if ($script:Cfg.content.sectors[$Id]) {
        $script:Cfg.content.sectors[$Id].visible = $Visible
        if ($script:Ring.Visible) { Show-Ring }
    }
}

function Set-SectorAction { param([string]$Id, [string]$Action)
    if ($script:Cfg.content.sectors[$Id] -and $Action) { $script:Cfg.content.sectors[$Id].action = $Action }
}

# 「选中预设后做什么」的回调。
# 和上面几个同理：回调里不能碰 Build-PrefsContentPage 的局部变量，只调这一个具名函数。
# 三个中文标签 ↔ 配置里的英文键的翻译在 Actions.ps1（Get-PresetActionModeFromLabel），
# 那份是唯一的定义 —— 这里再写一遍迟早会两边不一致。
function Set-PresetActionFromLabel { param([string]$Label)
    $script:Cfg.content.presetAction = Get-PresetActionModeFromLabel -Label $Label
    Save-Prefs
}

function Move-Sector { param([string]$Id, [int]$Delta)
    $list = @($script:Cfg.content.order)
    $at = $list.IndexOf($Id)
    $to = $at + $Delta
    if ($at -lt 0 -or $to -lt 0 -or $to -ge $list.Count) { return }
    $tmp = $list[$to]; $list[$to] = $list[$at]; $list[$at] = $tmp
    $script:Cfg.content.order = $list
    Save-Prefs

    # 重建页面 = 销毁正在触发这个事件的按钮本身。
    # 在事件处理过程中销毁 sender，WinForms 有时会在返回后继续访问它（访问已释放对象）。
    # 丢到消息队列末尾执行，等这次事件彻底走完再重建。
    $host_ = $script:PrefsPageHost
    if ($host_ -and $host_.IsHandleCreated) {
        [void]$host_.BeginInvoke([Action]{ Show-PrefsPage -Name 'content' })
    } else {
        Show-PrefsPage -Name 'content'
    }
}

function Build-PrefsContentPage {
    $content = $script:Cfg.content
    $order = @($content.order)
    $rows = New-Object System.Collections.ArrayList

    [void]$rows.Add((New-UiSection -Title '预设'))
    [void]$rows.Add((New-PrefsRow -Label '选中预设后' -Control (New-PrefsCombo `
        -Items @('复制到剪贴板 + 套用', '只复制到剪贴板', '只套用到插件') `
        -Selected (Get-PresetActionLabel (Get-PresetActionMode)) `
        -Width 240 `
        -OnChange { param($v) Set-PresetActionFromLabel -Label $v }) `
        -Note '「只复制」= 选完直接把提示词放进剪贴板，你自己粘到别处；圆环不会再弹提示词框'))

    # 标题里**不要写死扇区个数** —— 默认值加过几次（6 → 7），
    # 每加一次这个数字就错一次，而且没人会想起来改它
    [void]$rows.Add((New-UiSection -Title '扇区（顺序 = 顺时针从正上方开始）'))

    # 列头。
    # 以前没有这一行 —— 最左边那个 20px 宽的复选框不带任何文字，
    # 整页也找不到一句说明它是什么。结果是「勾掉一个扇区」，圆环上就少一项，
    # 用户既不知道是自己干的，也不知道去哪儿找回来。
    $head = New-Object System.Windows.Forms.Panel
    $head.Height = 22
    $head.Dock = [System.Windows.Forms.DockStyle]::Top
    $head.BackColor = [System.Drawing.Color]::Transparent
    foreach ($col in @(
        @{ t = '显示'; x = 0;   w = 24 }
        @{ t = '名称'; x = 26;  w = 110 }
        @{ t = '动作'; x = 144; w = 190 }
        @{ t = '排序'; x = 342; w = 64 }
        @{ t = '标识'; x = 414; w = 120 }
    )) {
        $lab = New-UiLabel -Text $col.t -Width $col.w -Size 11 -Color $script:Ui.dim
        $lab.Location = New-Object System.Drawing.Point($col.x, 2)
        $head.Controls.Add($lab)
    }
    [void]$rows.Add($head)

    foreach ($id in $order) {
        $sector = $content.sectors[$id]
        if (-not $sector) { continue }

        $row = New-Object System.Windows.Forms.Panel
        $row.Height = 40
        $row.Dock = [System.Windows.Forms.DockStyle]::Top
        $row.BackColor = [System.Drawing.Color]::Transparent

        # 用 Tag 把「这一行是哪个扇区」带进回调，而不是靠闭包捕获 $id ——
        # 闭包在函数返回后就失效了（见文件头）。
        $visible = New-PrefsCheck -Text '' -Checked ([bool]$sector.visible) -Id $id -OnChange {
            param($checked)
            Set-SectorVisible -Id $script:PrefsEventId -Visible $checked
        }
        $visible.Width = 20
        $visible.Location = New-Object System.Drawing.Point(0, 10)
        $row.Controls.Add($visible)

        $nameBox = New-PrefsText -Value ([string]$sector.label) -Width 110 -Id $id -OnChange {
            param($text)
            Set-SectorLabel -Id $script:PrefsEventId -Label $text
        }
        $nameBox.Location = New-Object System.Drawing.Point(26, 8)
        $row.Controls.Add($nameBox)

        $combo = New-PrefsCombo -Items (Get-SectorActionChoices) -Selected ([string]$sector.action) -Width 190 -Id $id -OnChange {
            param($value)
            Set-SectorAction -Id $script:PrefsEventId -Action $value
        }
        $combo.Location = New-Object System.Drawing.Point(144, 8)
        $row.Controls.Add($combo)

        $moveUp = New-PrefsButton -Text '↑' -Width 30 -Id $id -OnClick {
            Move-Sector -Id $script:PrefsEventId -Delta -1
        }
        $moveUp.Location = New-Object System.Drawing.Point(342, 8)
        $row.Controls.Add($moveUp)

        $moveDown = New-PrefsButton -Text '↓' -Width 30 -Id $id -OnClick {
            Move-Sector -Id $script:PrefsEventId -Delta 1
        }
        $moveDown.Location = New-Object System.Drawing.Point(376, 8)
        $row.Controls.Add($moveDown)

        $idLabel = New-UiLabel -Text $id -Width 120 -Size 11 -Color $script:Ui.dim
        $idLabel.Location = New-Object System.Drawing.Point(414, 10)
        $row.Controls.Add($idLabel)

        [void]$rows.Add($row)
    }

    return @($rows)
}

# ============================================================
#  高级页
# ============================================================

# ---------- 图库设置的回调 ----------
#
# **每一个都必须是具名全局函数。** 控件回调不能闭包捕获 Build-PrefsAdvancedPage
# 的局部变量（见文件头那条「血的教训」），所以回调体内只做一件事：
# 调这几个函数，由它们去读 $script:Cfg。

function Set-GalleryEnabled {
    param([bool]$Value)
    $script:Cfg.gallery.enabled = [bool]$Value
    Save-Prefs
}

function Set-GalleryMode {
    param([string]$Value)
    $map = @{ '按张数' = 'count'; '按天数' = 'days'; '两个都用' = 'both'; '不自动清理' = 'off' }
    if ($map.ContainsKey($Value)) { $script:Cfg.gallery.mode = $map[$Value] }
    Save-Prefs
}

function Set-GalleryMaxCount {
    param([string]$Value)
    # 下拉里显示的是「200 张」，取数字部分。走 Get-ClampedInt 而不是 [int]，
    # 手改坏的配置不会在启动路径上抛。
    $script:Cfg.gallery.maxCount = Get-ClampedInt -Value ($Value -replace '[^\d]', '') `
        -Min 1 -Max 5000 -Default 200
    Save-Prefs
}

function Set-GalleryMaxDays {
    param([string]$Value)
    $script:Cfg.gallery.maxDays = Get-ClampedInt -Value ($Value -replace '[^\d]', '') `
        -Min 1 -Max 3650 -Default 90
    Save-Prefs
}

function Set-GalleryDeleteFiles {
    param([bool]$Value)
    $script:Cfg.gallery.deleteFiles = [bool]$Value
    Save-Prefs
}

function Update-PrefsGalleryNote {
    if (-not $script:PrefsGalleryNote) { return }
    try {
        $all = Get-GalleryCount -IncludeHidden
        $shown = Get-GalleryCount
        $text = "已记录 $all 张"
        if ($all -gt $shown) { $text += "，其中 $($all - $shown) 张已收起" }
        if (-not $script:Cfg.gallery.enabled) { $text += "（图库已关闭，不再记录新的）" }
        $script:PrefsGalleryNote.Text = $text
    } catch {
        $script:PrefsGalleryNote.Text = ''
    }
}

function Invoke-GalleryCleanupFromPrefs {
    Invoke-ActionGalleryCleanup
    Update-PrefsGalleryNote
}

function Build-PrefsAdvancedPage {
    $rows = New-Object System.Collections.ArrayList

    [void]$rows.Add((New-UiSection -Title '接口'))

    $portNote = New-UiLabel -Text '插件连的就是这个端口，改了插件也得跟着改' -Width 420 -Size 11 -Color $script:Ui.dim
    $script:PrefsPortNote = $portNote

    $port = New-Object System.Windows.Forms.NumericUpDown
    $port.Minimum = 1024
    $port.Maximum = 65535
    $port.Value = [int]$script:Cfg.port
    $port.Width = 120
    $port.BackColor = $script:Ui.surface
    $port.ForeColor = $script:Ui.fg
    $port.Font = Get-BubbleFont -Pixels 13
    $port.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $port.Add_ValueChanged({
        param($sender, $e)
        $script:Cfg.port = [int]$sender.Value
        if ($script:PrefsPortNote) {
            $script:PrefsPortNote.Text = '端口改动要重启助手才生效'
            $script:PrefsPortNote.ForeColor = $script:Ui.bad
        }
    })

    $portRow = New-PrefsRow -Label '桥接端口' -Control $port
    # 底下挂的是**会变的**提示，所以不交给 -Note（那是静态标签，这里改不到它）
    $portRow.Height = 54
    $portNote.Location = New-Object System.Drawing.Point(0, 34)
    $portNote.Parent = $portRow
    [void]$rows.Add($portRow)

    $outBox = New-PrefsText -Value ([string]$script:Cfg.api.outputFolder) -Width 300 -OnChange {
        param($text) $script:Cfg.api.outputFolder = $text.Trim()
    }
    $script:PrefsOutBox = $outBox
    [void]$rows.Add((New-PrefsRow -Label '出图目录' -Control $outBox -Note '留空 = 图片\幻梦AI'))

    $browse = New-PrefsButton -Text '浏览…' -Width 90 -OnClick {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $script:Cfg.api.outputFolder = $dialog.SelectedPath
            if ($script:PrefsOutBox) { $script:PrefsOutBox.Text = $dialog.SelectedPath }
            Save-Prefs
        }
        $dialog.Dispose()
    }
    [void]$rows.Add((New-PrefsRow -Label '' -Control $browse -Height 34))

    # ---------- 图库 ----------
    # 放在出图目录后面：图库就是这个目录的索引，两件事该挨着看
    [void]$rows.Add((New-UiSection -Title '图库'))

    $galleryOn = New-PrefsCheck -Text '记录出图历史（圆环上会出现「图库」扇区）' `
        -Checked ([bool]$script:Cfg.gallery.enabled) -Id 'galleryEnabled' -OnChange { param($v) Set-GalleryEnabled -Value $v }
    [void]$rows.Add((New-PrefsRow -Label '' -Control $galleryOn -Height 30))

    # 保留方式和上限都用下拉不用滑杆：
    # Huanmeng.UiSlider 的 ValueFormat 是喂给 double.ToString() 的**数字格式串**，
    # 不是 string.Format 模板 —— 写 '{0} 张' 会原样渲染成「{200} 张」。
    # 下拉对不熟悉配置文件的用户也更直观。
    $modeMap = [ordered]@{ '按张数' = 'count'; '按天数' = 'days'; '两个都用' = 'both'; '不自动清理' = 'off' }
    $modeNow = [string]$script:Cfg.gallery.mode
    $modeSel = '按张数'
    foreach ($k in $modeMap.Keys) { if ($modeMap[$k] -eq $modeNow) { $modeSel = $k } }
    $modeCombo = New-PrefsCombo -Items @($modeMap.Keys) -Selected $modeSel -Width 160 `
        -Id 'galleryMode' -OnChange { param($v) Set-GalleryMode -Value $v }
    [void]$rows.Add((New-PrefsRow -Label '保留方式' -Control $modeCombo))

    $countChoices = @('50', '100', '200', '500', '1000', '2000')
    $curCount = [string]([int]$script:Cfg.gallery.maxCount)
    # 用户手改过的值不在选项里就补进去 —— 否则下拉会显示成第一个选项，
    # 看起来像「我的设置被重置了」
    if ($countChoices -notcontains $curCount) { $countChoices = @($curCount) + $countChoices }
    $countCombo = New-PrefsCombo -Items @($countChoices | ForEach-Object { "$_ 张" }) `
        -Selected "$curCount 张" -Width 160 -Id 'galleryMaxCount' `
        -OnChange { param($v) Set-GalleryMaxCount -Value $v }
    [void]$rows.Add((New-PrefsRow -Label '最多保留' -Control $countCombo))

    $dayChoices = @('7', '30', '90', '180', '365', '730')
    $curDays = [string]([int]$script:Cfg.gallery.maxDays)
    if ($dayChoices -notcontains $curDays) { $dayChoices = @($curDays) + $dayChoices }
    $dayCombo = New-PrefsCombo -Items @($dayChoices | ForEach-Object { "$_ 天" }) `
        -Selected "$curDays 天" -Width 160 -Id 'galleryMaxDays' `
        -OnChange { param($v) Set-GalleryMaxDays -Value $v }
    [void]$rows.Add((New-PrefsRow -Label '保留天数' -Control $dayCombo))

    # **这个开关动的是用户的作品，措辞和默认值都要按最保守的来。**
    $delCheck = New-PrefsCheck -Text '清理时连图片文件一起删掉（默认关闭）' `
        -Checked ([bool]$script:Cfg.gallery.deleteFiles) -Id 'galleryDeleteFiles' `
        -OnChange { param($v) Set-GalleryDeleteFiles -Value $v }
    [void]$rows.Add((New-PrefsRow -Label '' -Control $delCheck -Height 30))

    $delNote = New-UiLabel -Text '不勾的话清理只是把老图从图库里收起来，硬盘上的文件一张都不会动。勾了之后只有手动点「立即清理一次」才会真删 —— 自动清理永远不删文件。' `
        -Width 560 -Size 11 -Color $script:Ui.dim
    $delRow = New-Object System.Windows.Forms.Panel
    $delRow.Height = 24
    $delRow.Dock = [System.Windows.Forms.DockStyle]::Top
    $delRow.BackColor = [System.Drawing.Color]::Transparent
    $delNote.Parent = $delRow
    [void]$rows.Add($delRow)

    foreach ($def in @(
        @{ text = '立即清理一次'; action = { Invoke-GalleryCleanupFromPrefs } },
        @{ text = '收录旧图';     action = { Invoke-ActionGalleryAdopt } },
        @{ text = '打开图库文件夹'; action = { Invoke-ActionGalleryOpenFolder } }
    )) {
        $btn = New-PrefsButton -Text $def.text -Width 150 -OnClick $def.action
        $holder = New-Object System.Windows.Forms.Panel
        $holder.Height = 34
        $holder.Dock = [System.Windows.Forms.DockStyle]::Top
        $holder.BackColor = [System.Drawing.Color]::Transparent
        $btn.Location = New-Object System.Drawing.Point(126, 2)
        $holder.Controls.Add($btn)
        [void]$rows.Add($holder)
    }

    # 状态行。和「桥接端口」那一行一样，是**会变的**提示，
    # 所以自己存一个引用，动作做完就地刷新。
    $noteRow = New-Object System.Windows.Forms.Panel
    $noteRow.Height = 26
    $noteRow.Dock = [System.Windows.Forms.DockStyle]::Top
    $noteRow.BackColor = [System.Drawing.Color]::Transparent
    $script:PrefsGalleryNote = New-UiLabel -Text '' -Width 540 -Size 11 -Color $script:Ui.dim
    $script:PrefsGalleryNote.Location = New-Object System.Drawing.Point(0, 4)
    $script:PrefsGalleryNote.Parent = $noteRow
    [void]$rows.Add($noteRow)
    Update-PrefsGalleryNote

    [void]$rows.Add((New-UiSection -Title '配置文件'))

    foreach ($def in @(
        @{ text = '打开配置文件';     action = { Open-ConfigFile } },
        @{ text = '导出配置到…';      action = { Invoke-ExportConfig } },
        @{ text = '从文件导入配置…';  action = { Invoke-ImportConfig } },
        @{ text = '恢复默认外观';     action = { Invoke-ResetAppearance } }
    )) {
        $btn = New-PrefsButton -Text $def.text -Width 170 -OnClick $def.action
        $holder = New-Object System.Windows.Forms.Panel
        $holder.Height = 34
        $holder.Dock = [System.Windows.Forms.DockStyle]::Top
        $holder.BackColor = [System.Drawing.Color]::Transparent
        $btn.Location = New-Object System.Drawing.Point(126, 2)
        $holder.Controls.Add($btn)
        [void]$rows.Add($holder)
    }

    $pathRow = New-Object System.Windows.Forms.Panel
    $pathRow.Height = 26
    $pathRow.Dock = [System.Windows.Forms.DockStyle]::Top
    $pathRow.BackColor = [System.Drawing.Color]::Transparent
    $pathLabel = New-UiLabel -Text (Get-ConfigPath) -Width 540 -Size 11 -Color $script:Ui.dim
    $pathLabel.Location = New-Object System.Drawing.Point(0, 4)
    $pathLabel.Parent = $pathRow
    [void]$rows.Add($pathRow)

    return @($rows)
}

# ============================================================
#  高级页的三个动作
# ============================================================

function Invoke-ExportConfig {
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.Filter = 'JSON|*.json'
    $dialog.FileName = 'huanmeng-ring-config.json'
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        try {
            Write-TextFile -Path $dialog.FileName -Text ($script:Cfg | ConvertTo-Json -Depth 12)
            Show-TrayNotification -Text "配置已导出到 $($dialog.FileName)" -Kind 'ok'
        } catch {
            Show-TrayNotification -Text "导出失败：$($_.Exception.Message)" -Kind 'error'
        }
    }
    $dialog.Dispose()
}

function Invoke-ImportConfig {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Filter = 'JSON|*.json|所有文件|*.*'
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $raw = Read-JsonFile $dialog.FileName
        if ($null -eq $raw) {
            Show-TrayNotification -Text '这个文件读不出 JSON' -Kind 'error'
        } else {
            $script:Cfg = Merge-Hashtable -Base (Get-DefaultConfig) -Override $raw
            # 导入的 JSON 可能把数组字段写成 null / 字符串 / 空对象，
            # 这里走一遍和 Get-Config 一样的归一，不然菜单会拿到一个不是数组的「数组」
            $script:Cfg.api.chatModels = ConvertTo-StringList $script:Cfg.api.chatModels
            $script:Cfg.content.order = ConvertTo-StringList $script:Cfg.content.order
            Save-Prefs
            Apply-Prefs
            Show-PrefsPage -Name $script:PrefsCurrentPage
            Show-TrayNotification -Text '配置已导入' -Kind 'ok'
        }
    }
    $dialog.Dispose()
}

function Invoke-ResetAppearance {
    $script:Cfg.appearance = (Get-DefaultConfig).appearance
    Save-Prefs
    # 三个字体一起重建：只重建两个的话 hub 标题会停在旧字号上
    Reset-RingFonts
    $script:Ring.Theme = Get-Theme $script:Cfg.appearance.theme
    Refresh-TrayIcon
    Show-PrefsPage -Name 'appearance'
}

# ============================================================
#  语音页
# ============================================================

function Build-PrefsVoicePage {
    $s = $script:Cfg.speech
    $rows = New-Object System.Collections.ArrayList

    [void]$rows.Add((New-UiSection -Title '语音输入'))

    # ---- 引擎状态：这一页最该先说清楚的就是「这台机器能不能用」 ----
    $avail = Test-SpeechUsable
    if ($avail.Ok) {
        $statusText = "可用 · $($avail.Name)（$($avail.Culture)）"
        $statusColor = $script:Ui.good
    } else {
        $statusText = "不可用 · $($avail.Error)"
        $statusColor = $script:Ui.bad
    }
    [void]$rows.Add((New-PrefsRow -Label '识别引擎' -Control (New-UiLabel -Text $statusText -Width 520 -Size 12 -Color $statusColor)))

    $hkText = '未注册'
    if ($script:Voice.HotkeyOk) { $hkText = "$($script:Voice.Hotkey)（已注册）" }
    elseif ($script:Voice.Hotkey) { $hkText = "$($script:Voice.Hotkey)（被别的软件占用了）" }
    $hkColor = if ($script:Voice.HotkeyOk) { $script:Ui.good } else { $script:Ui.bad }
    [void]$rows.Add((New-PrefsRow -Label '热键状态' -Control (New-UiLabel -Text $hkText -Width 520 -Size 12 -Color $hkColor)))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-UiLabel `
        -Text '按住热键说话、松开出字。识别完全在本机进行，不联网、不消耗额度。' `
        -Width 520 -Size 11 -Color $script:Ui.dim)))

    [void]$rows.Add((New-UiSection -Title '开关'))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-PrefsCheck -Text '启用语音输入' -Checked ([bool]$s.enabled) -OnChange {
        param($v)
        $script:Cfg.speech.enabled = [bool]$v
        # 关掉的时候必须把正在进行的收音停掉 —— 否则开关关了，
        # 麦克风还开着，用户会以为它在偷偷录音
        if (-not $v) { try { Reset-VoiceState } catch { } }
        Update-BubbleMicButton
    })))

    [void]$rows.Add((New-UiSection -Title '热键'))

    [void]$rows.Add((New-PrefsRow -Label '按住说话' -Control (New-PrefsText -Value ([string]$s.hotkey) -Width 220 -OnChange {
        param($text)
        $script:Cfg.speech.hotkey = ([string]$text).Trim()
    })))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-UiLabel `
        -Text '格式如 ctrl+alt+space。保存后重新打开本窗口生效；如果被输入法或其它软件占了，会自动换一个能用的并告诉你。' `
        -Width 520 -Size 11 -Color $script:Ui.dim)))

    [void]$rows.Add((New-UiSection -Title '识别'))

    [void]$rows.Add((New-PrefsRow -Label '置信度门槛' -Control (New-PrefsSlider -Min 0.10 -Max 0.90 -Value $s.confidence -Format '{0:P0}' -OnChange {
        param($v)
        $script:Cfg.speech.confidence = [double]$v
        # 门槛是引擎侧的设置，改了要立刻同步过去，不然要等下一轮收音才生效
        if ($script:Voice.Pump -and $script:Voice.Ready) {
            try { $script:Voice.Pump.SetThreshold([int]([double]$v * 100)) } catch { }
        }
    }) -Note '低于它的识别结果直接丢掉。调高分贝环境下的误识别会变少，但说话小声时可能听不出来；调低则相反'))

    [void]$rows.Add((New-PrefsRow -Label '' -Control (New-UiLabel `
        -Text 'Windows 自带的是 SAPI 8.0 时代的老引擎：短句够用，长段落明显不如手机上的语音输入。' `
        -Width 520 -Size 11 -Color $script:Ui.dim)))

    return @($rows)
}

# ============================================================
#  导航与主窗
# ============================================================

$script:PrefsPages = [ordered]@{
    'appearance'  = @{ label = '外观'; build = { Build-PrefsAppearancePage } }
    'interaction' = @{ label = '交互'; build = { Build-PrefsInteractionPage } }
    'content'     = @{ label = '内容'; build = { Build-PrefsContentPage } }
    'voice'       = @{ label = '语音'; build = { Build-PrefsVoicePage } }
    'advanced'    = @{ label = '高级'; build = { Build-PrefsAdvancedPage } }
}

function Show-PrefsPage {
    param([string]$Name)

    if (-not $script:PrefsPageHost) { return }
    if (-not $script:PrefsPages.Contains($Name)) { $Name = 'appearance' }
    $script:PrefsCurrentPage = $Name

    # 换页整块重建。设置项不多，重建比逐个同步状态简单可靠得多。
    $host_ = $script:PrefsPageHost
    $host_.SuspendLayout()
    foreach ($ctrl in @($host_.Controls)) {
        $host_.Controls.Remove($ctrl)
        $ctrl.Dispose()
    }

    $rows = & $script:PrefsPages[$Name].build
    for ($i = $rows.Count - 1; $i -ge 0; $i--) { $host_.Controls.Add($rows[$i]) }
    $host_.ResumeLayout()

    foreach ($navButton in $script:PrefsNav) {
        $isCurrent = ($navButton.Tag -eq $Name)
        if ($isCurrent) {
            $navButton.BackColor = $script:Ui.surfaceHi
            $navButton.ForeColor = $script:Ui.fg
        } else {
            $navButton.BackColor = $script:Ui.bg
            $navButton.ForeColor = $script:Ui.dim
        }
    }
}

function Show-PrefsWindow {
    param([switch]$Rebuild)

    if ($script:PrefsForm -and -not $Rebuild) {
        # 后台进程的 Activate() 会被 Windows 前台锁定静默拒掉，
        # 窗口看着在前台、键盘焦点却还在别处 —— 见 ForceForegroundWindow 的注释
        if (-not [Huanmeng.Win32]::ForceForegroundWindow($script:PrefsForm.Handle)) {
            $script:PrefsForm.Activate()
        }
        return
    }

    if ($script:PrefsForm) {
        $old = $script:PrefsForm
        $script:PrefsForm = $null
        $script:PrefsPageHost = $null
        $old.Close()
        $old.Dispose()
    }

    # 每次开窗都按当前主题重算配色 —— 用户可能刚在圆环上换了配色再进来
    Update-PrefsTheme

    $form = New-Object System.Windows.Forms.Form
    $form.Text = '幻梦圆环 · 偏好设置'
    $form.Size = New-Object System.Drawing.Size(780, 600)
    $form.MinimumSize = New-Object System.Drawing.Size(700, 520)
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.BackColor = $script:Ui.bg
    $form.ForeColor = $script:Ui.fg
    $form.Font = Get-BubbleFont -Pixels 13
    $form.MaximizeBox = $false

    # ---- 底部条 ----
    $footer = New-Object System.Windows.Forms.Panel
    $footer.Dock = [System.Windows.Forms.DockStyle]::Bottom
    $footer.Height = 54
    $footer.BackColor = $script:Ui.bg
    $form.Controls.Add($footer)

    $preview = New-PrefsButton -Text '预览圆环' -Width 110 -OnClick {
        $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        Show-Ring -X ([int]($area.Left + $area.Width / 2)) -Y ([int]($area.Top + $area.Height / 2))
    }
    $preview.Location = New-Object System.Drawing.Point(16, 13)
    $footer.Controls.Add($preview)

    $footerNote = New-UiLabel -Text '改动即时生效并自动保存' -Width 300 -Size 11 -Color $script:Ui.dim
    $footerNote.Location = New-Object System.Drawing.Point(136, 17)
    $footer.Controls.Add($footerNote)

    $closeBtn = New-PrefsButton -Text '关闭' -Width 90 -OnClick {
        if ($script:PrefsForm) { $script:PrefsForm.Close() }
    }
    $closeBtn.Location = New-Object System.Drawing.Point(660, 13)
    $closeBtn.Anchor = 'Top,Right'
    $footer.Controls.Add($closeBtn)

    # ---- 左侧导航 ----
    $nav = New-Object System.Windows.Forms.Panel
    $nav.Dock = [System.Windows.Forms.DockStyle]::Left
    $nav.Width = 150
    $nav.BackColor = $script:Ui.bg
    $form.Controls.Add($nav)

    $script:PrefsNav = @()
    $top = 16
    foreach ($key in $script:PrefsPages.Keys) {
        $navButton = New-Object System.Windows.Forms.Button
        $navButton.Text = $script:PrefsPages[$key].label
        $navButton.Tag = $key
        $navButton.Width = 130
        $navButton.Height = 38
        $navButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $navButton.FlatAppearance.BorderSize = 0
        $navButton.FlatAppearance.MouseOverBackColor = $script:Ui.surfaceHi
        $navButton.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
        $navButton.Padding = New-Object System.Windows.Forms.Padding(12, 0, 0, 0)
        $navButton.BackColor = $script:Ui.bg
        $navButton.ForeColor = $script:Ui.dim
        $navButton.Font = Get-BubbleFont -Pixels 13
        $navButton.Location = New-Object System.Drawing.Point(10, $top)
        # $sender.Tag 就是页名 —— 不用 $navButton（局部变量，回调时会失效）
        $navButton.Add_Click({ param($sender, $e) Show-PrefsPage -Name ([string]$sender.Tag) })
        $nav.Controls.Add($navButton)
        $script:PrefsNav += $navButton
        $top += 42
    }

    # ---- 右侧内容（可滚动）----
    $host_ = New-Object System.Windows.Forms.Panel
    $host_.Dock = [System.Windows.Forms.DockStyle]::Fill
    $host_.AutoScroll = $true
    $host_.BackColor = $script:Ui.bg
    $host_.Padding = New-Object System.Windows.Forms.Padding(20, 16, 20, 16)
    $form.Controls.Add($host_)
    $host_.BringToFront()
    $script:PrefsPageHost = $host_

    $form.Add_FormClosing({
        Save-Prefs
        $script:PrefsForm = $null
        $script:PrefsPageHost = $null
    })

    $script:PrefsForm = $form
    $form.Show()
    Show-PrefsPage -Name $script:PrefsCurrentPage
    # 见 ForceForegroundWindow —— 光 Activate() 拿不到键盘焦点，
    # 用户在第一页填密钥时会发现「打字没反应」
    if (-not [Huanmeng.Win32]::ForceForegroundWindow($form.Handle)) {
        $form.Activate()
    }
}
