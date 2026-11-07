# ============================================================
#  Bubble.ps1 — 气泡窗
#
#  三种形态共用一个窗：
#    input   写提示词（出图前）
#    chat   对话：上面是来回记录，下面是输入框
#    text    只读长文本（报错详情、回复全文）
#    result 出图结果：看图 / 另存为 / 打开文件夹
#
#  **刻意用真控件（TextBox / RichTextBox / PictureBox）而不是自绘**：
#  中文输入法的候选窗是挂在真实编辑控件上的，自绘输入框在中文环境下
#  根本没法用（这正是 macOS 版为了输入法要把焦点还给气泡的原因）。
#
#  气泡和圆环不一样，**它要抢焦点** —— 用户要打字。
#  所以关掉的时候要把焦点还给原来那个窗口，否则 PS 会一直以为自己在后台，
#  画布的选区会变成灰的。
#
#  布局用「三段式」：标题条 Dock=Top、提示条 Dock=Bottom、
#  中间 Body 面板 Dock=Fill，控件都 Dock 进 Body 里。
#  不用绝对坐标 —— 绝对坐标和 Dock 混用时 Dock 会赢，位置全乱。
# ============================================================

$script:Bubble = @{
    Form       = $null
    Header     = $null
    Body       = $null
    Input      = $null
    Transcript = $null
    Picture    = $null
    Footer     = $null
    Hint       = $null
    TitleLabel = $null
    Mic        = $null
    MicTip     = $null
    Mode       = ''
    OnSubmit   = $null
    PreviousFg = [IntPtr]::Zero
    Dragging   = $false
    DragOrigin = $null
    FormOrigin = $null
    ImagePath  = ''
    # 图库翻页用。GalleryIds 是当前这一组图的完整路径列表（和圆环上画的那一份同源），
    # GalleryIndex 是正在看第几张。为空 = 不是从图库来的，不显示翻页按钮。
    GalleryIds   = @()
    GalleryIndex = 0
    PrevBtn      = $null
    NextBtn      = $null
}

# 气泡的配色**跟随圆环当前主题**，不写死。
# 选了浅色主题（素白）却弹出一个深色气泡，看起来像两个软件。
# 每次显示前调一次 Update-BubbleTheme 刷新。
$script:BubbleTheme = @{}
$script:BubblePalette = $null

function Update-BubbleTheme {
    $p = Get-UiPalette
    $script:BubblePalette = $p
    $script:BubbleTheme = @{
        bg      = $p.bg
        panel   = $p.surface
        fg      = $p.fg
        dim     = $p.dim
        accent  = $p.accent
        user    = $p.fg
        bot     = $p.fg
        err     = $p.bad
        mineBg  = $p.mineBg
        mineFg  = $p.mineFg
        theirsBg = $p.theirsBg
        theirsFg = $p.theirsFg
    }

    # 窗口已经建出来的话，窗体本身的颜色也要刷一遍。
    # 只换 $script:BubbleTheme 的话，标题条和底板会停在上一套配色上 ——
    # 用户改了主题，气泡看起来像一半新一半旧。
    $b = $script:Bubble
    if ($b.Form) {
        $b.Form.BackColor = $p.bg
        $b.Form.ForeColor = $p.fg
        if ($b.Header) { $b.Header.BackColor = $p.surface }
        if ($b.TitleLabel) { $b.TitleLabel.ForeColor = $p.dim }
        if ($b.Hint) { $b.Hint.ForeColor = $p.dim }
        if ($b.Body) { $b.Body.BackColor = $p.bg }
    }
}

# 模块加载时先算一次，这样即使有人在窗口创建前读 $script:BubbleTheme 也不会是空的
if ($script:Cfg) { Update-BubbleTheme }

function Get-BubbleFont {
    param([double]$Pixels, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)

    foreach ($name in @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI')) {
        try {
            return New-Object System.Drawing.Font($name, [single]$Pixels, $Style, [System.Drawing.GraphicsUnit]::Pixel)
        } catch { }
    }
    return New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericSansSerif, [single]$Pixels, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-RoundedRegion {
    param([int]$Width, [int]$Height, [int]$Radius)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc(($Width - $d - 1), 0, $d, $d, 270, 90)
    $path.AddArc(($Width - $d - 1), ($Height - $d - 1), $d, $d, 0, 90)
    $path.AddArc(0, ($Height - $d - 1), $d, $d, 90, 90)
    $path.CloseFigure()
    $region = New-Object System.Drawing.Region($path)
    $path.Dispose()
    return $region
}

# ---------- 拖动 ----------
# 标题条和它上面的文字都要能拖 —— 只挂 Panel 的话，
# 用户按住标题上那行字拖是不动的（文字盖住了 Panel）。

function Register-BubbleDrag {
    param($Control)

    $Control.Add_MouseDown({
        param($sender, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $script:Bubble.Dragging = $true
            $script:Bubble.DragOrigin = [System.Windows.Forms.Cursor]::Position
            $script:Bubble.FormOrigin = $script:Bubble.Form.Location
        }
    })
    $Control.Add_MouseMove({
        param($sender, $e)
        if (-not $script:Bubble.Dragging) { return }
        $now = [System.Windows.Forms.Cursor]::Position
        $dx = $now.X - $script:Bubble.DragOrigin.X
        $dy = $now.Y - $script:Bubble.DragOrigin.Y
        $script:Bubble.Form.Location = New-Object System.Drawing.Point(
            ($script:Bubble.FormOrigin.X + $dx), ($script:Bubble.FormOrigin.Y + $dy))
    })
    $Control.Add_MouseUp({ $script:Bubble.Dragging = $false })
}

function Initialize-BubbleWindow {
    if ($script:Bubble.Form) { return }

    $b = $script:Bubble
    Update-BubbleTheme
    $theme = $script:BubbleTheme

    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.ShowInTaskbar = $false
    $form.TopMost = $true
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.BackColor = $theme.bg
    $form.ForeColor = $theme.fg
    $form.KeyPreview = $true
    $form.Text = '幻梦AI'
    $form.Width = 430
    $form.Height = 150

    # 先建出窗口句柄再立刻藏起来。
    # 只 Show 不 Hide 的话，助手一启动桌面上就会杵着一个空的「幻梦AI」白框 ——
    # 用户根本不知道那是什么。这里要的只是句柄，不是可见性。
    $form.Show()
    $form.Hide()

    # ---- 标题条（兼作拖动把手）----
    $header = New-Object System.Windows.Forms.Panel
    $header.Dock = [System.Windows.Forms.DockStyle]::Top
    $header.Height = 30
    $header.BackColor = $theme.panel
    $form.Controls.Add($header)

    $close = New-Object System.Windows.Forms.Label
    $close.Text = '✕'
    $close.Dock = [System.Windows.Forms.DockStyle]::Right
    $close.Width = 32
    $close.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $close.Font = Get-BubbleFont -Pixels 13
    $close.ForeColor = $theme.dim
    $close.Cursor = [System.Windows.Forms.Cursors]::Hand
    $close.Add_Click({ Hide-HuanmengBubble })
    $close.Add_MouseEnter({ $script:Bubble.Header.Controls['closeLabel'].ForeColor = $script:BubbleTheme.err })
    $close.Add_MouseLeave({ $script:Bubble.Header.Controls['closeLabel'].ForeColor = $script:BubbleTheme.dim })
    $close.Name = 'closeLabel'
    $header.Controls.Add($close)

    $title = New-Object System.Windows.Forms.Label
    $title.Dock = [System.Windows.Forms.DockStyle]::Fill
    $title.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $title.Padding = New-Object System.Windows.Forms.Padding(12, 0, 0, 0)
    $title.Font = Get-BubbleFont -Pixels 13
    $title.ForeColor = $theme.dim
    $title.Text = '幻梦AI'
    $header.Controls.Add($title)

    Register-BubbleDrag -Control $header
    Register-BubbleDrag -Control $title

    # ---- 底部提示 ----
    $hint = New-Object System.Windows.Forms.Label
    $hint.Dock = [System.Windows.Forms.DockStyle]::Bottom
    $hint.Height = 22
    $hint.Padding = New-Object System.Windows.Forms.Padding(12, 0, 12, 0)
    $hint.Font = Get-BubbleFont -Pixels 11
    $hint.ForeColor = $theme.dim
    $hint.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $form.Controls.Add($hint)

    # ---- 中间正文 ----
    $body = New-Object System.Windows.Forms.Panel
    $body.Dock = [System.Windows.Forms.DockStyle]::Fill
    $body.BackColor = $theme.bg
    $body.Padding = New-Object System.Windows.Forms.Padding(12, 8, 12, 8)
    $form.Controls.Add($body)
    $body.BringToFront()

    $script:Bubble.Header = $header
    $script:Bubble.TitleLabel = $title
    $script:Bubble.Hint = $hint
    $script:Bubble.Body = $body
    $script:Bubble.Form = $form

    $form.Add_KeyDown({
        param($sender, $e)
        if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
            $e.SuppressKeyPress = $true
            # 正在听的时候 Esc 是「这句不算」，不是「关掉气泡」——
            # 说错了要能当场撤销，而不是把气泡也一起关了重来
            if ($script:Voice -and $script:Voice.Listening) {
                Cancel-VoiceCapture
                return
            }
            Hide-HuanmengBubble
        }
    })

    $form.Add_Resize({
        if ($script:Bubble.Form.Width -gt 60 -and $script:Bubble.Form.Height -gt 60) {
            $script:Bubble.Form.Region = New-RoundedRegion -Width $script:Bubble.Form.Width -Height $script:Bubble.Form.Height -Radius 12
        }
    })
}

function Reset-BubbleBody {
    $b = $script:Bubble
    if (-not $b.Body) { return }

    # **位图得自己释放。** Dispose() 控件不会连带释放它的 Image ——
    # 只 Dispose 控件的话每显示一次结果图就漏一张位图（1~2 MB），
    # 加了「上一张/下一张」之后更是一翻一漏，挂机久了 GDI 句柄和内存都会涨。
    if ($b.Picture -and $b.Picture.Image) {
        try { $b.Picture.Image.Dispose() } catch { }
        $b.Picture.Image = $null
    }

    foreach ($ctrl in @($b.Body.Controls)) {
        $b.Body.Controls.Remove($ctrl)
        $ctrl.Dispose()
    }
    $b.Input = $null
    $b.Transcript = $null
    $b.Picture = $null
    $b.Footer = $null
    # 翻页状态一并清掉。不清的话下次显示普通结果图时，
    # 回调会拿着上一组图的列表去翻，而且会写一个已经 Dispose 掉的按钮。
    $b.GalleryIds = @()
    $b.GalleryIndex = 0
    $b.PrevBtn = $null
    $b.NextBtn = $null
    $b.Mic = $null
    if ($b.MicTip) { try { $b.MicTip.Dispose() } catch { } }
    $b.MicTip = $null
}

# ---------- 输入框 ----------

function New-BubbleInputBox {
    param([string]$Placeholder)

    $theme = $script:BubbleTheme

    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true
    $box.BackColor = $theme.panel
    $box.ForeColor = $theme.dim
    $box.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $box.Font = Get-BubbleFont -Pixels 15
    $box.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $box.AcceptsReturn = $false      # Enter 是「发送」，换行走 Shift+Enter
    $box.AcceptsTab = $false
    $box.Dock = [System.Windows.Forms.DockStyle]::Fill
    $box.Text = $Placeholder

    # WinForms 的 TextBox 没有原生 placeholder。用「灰字 + 标记」实现，
    # 进入时清掉、离开时若为空再补回来。
    $box.Tag = @{ placeholder = $Placeholder; showing = $true }
    return $box
}

function Clear-BubblePlaceholder {
    param($Box)

    if (-not $Box -or -not $Box.Tag) { return }
    if ($Box.Tag.showing) {
        $Box.Tag.showing = $false
        $Box.Text = ''
        $Box.ForeColor = $script:BubbleTheme.fg
    }
}

function Get-BubbleInputText {
    param($Box)

    if (-not $Box) { return '' }
    if ($Box.Tag -and $Box.Tag.showing) { return '' }
    return [string]$Box.Text
}

function Reset-BubbleInput {
    param($Box)

    if (-not $Box) { return }
    $Box.Text = $Box.Tag.placeholder
    $Box.ForeColor = $script:BubbleTheme.dim
    $Box.Tag.showing = $true
}

# 提交当前输入。回车和「发送」按钮都走这里 ——
# 两条路径各写一遍的话，迟早有一边忘了清空输入框或忘了去灰字。
function Submit-BubbleInput {
    $b = $script:Bubble
    $text = Get-BubbleInputText -Box $b.Input
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    Reset-BubbleInput -Box $b.Input
    if ($b.OnSubmit) { & $b.OnSubmit $text.Trim() }
}

function Register-BubbleSubmit {
    param($Box)

    $Box.Add_KeyDown({
        param($sender, $e)
        if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter -and -not $e.Shift) {
            # SuppressKeyPress 是必须的：不设的话回车会「叮」一声 ——
            # 多行 TextBox 收到 Enter 会当成非法输入。
            # 输入法正在组字时不会走到这里（Enter 被输入法吃掉当选词了），
            # 这正是我们要的行为。
            $e.SuppressKeyPress = $true
            Submit-BubbleInput
        }
    })
    # 有内容时才把灰字去掉；空框重新获得焦点要能把灰字补回来
    $Box.Add_Enter({ Clear-BubblePlaceholder -Box $script:Bubble.Input })
    $Box.Add_Leave({
        if ([string]::IsNullOrEmpty($script:Bubble.Input.Text)) {
            Reset-BubbleInput -Box $script:Bubble.Input
        }
    })
}

# 输入框右侧那一列按钮的尺寸。集中在这里，改一处三个地方都跟着走。
$script:BubbleSendWidth = 62
$script:BubbleMicWidth  = 48

# 麦克风按钮。点一下开始听，再点一下结束。
# 语音不可用（没装中文识别引擎 / 配置里关了）时干脆不建这个按钮 ——
# 摆一个点不动的按钮比没有按钮更让人困惑。
function New-BubbleMicButton {
    if (-not (Test-VoiceButtonVisible)) { return $null }

    $theme = $script:BubbleTheme
    $mic = New-Object System.Windows.Forms.Button
    $mic.Dock = [System.Windows.Forms.DockStyle]::Right
    $mic.Width = $script:BubbleMicWidth
    $mic.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $mic.FlatAppearance.BorderColor = $theme.panel
    $mic.BackColor = $theme.panel
    $mic.ForeColor = $theme.accent
    $mic.Font = Get-BubbleFont -Pixels 13
    $mic.Text = '语音'
    $mic.Add_Click({ Toggle-VoiceCapture })

    $tip = New-Object System.Windows.Forms.ToolTip
    $hk = ''
    if ($script:Voice -and $script:Voice.Hotkey) { $hk = $script:Voice.Hotkey }
    if ($hk) { $tip.SetToolTip($mic, "点一下开始说话，再点一下结束`n也可以按住 $hk 说话") }
    else { $tip.SetToolTip($mic, '点一下开始说话，再点一下结束') }

    $script:Bubble.Mic = $mic
    $script:Bubble.MicTip = $tip
    return $mic
}

# 收音状态一变就刷按钮外观。按钮本身就是「现在在不在听」的唯一指示，
# 只靠底下那行小字的话，用户按了热键之后会盯着输入框发愣。
function Update-BubbleMicButton {
    $mic = $script:Bubble.Mic
    if (-not $mic) { return }
    $theme = $script:BubbleTheme

    if ($script:Voice.Listening) {
        $mic.Text = '停止'
        $mic.ForeColor = $theme.bg
        $mic.BackColor = $theme.err
        $mic.FlatAppearance.BorderColor = $theme.err
    } else {
        $mic.Text = '语音'
        $mic.ForeColor = $theme.accent
        $mic.BackColor = $theme.panel
        $mic.FlatAppearance.BorderColor = $theme.panel
    }
    try { $mic.Refresh() } catch { }
}

# 输入框 + 发送按钮（+ 语音按钮）。返回一个容器，调用方按 Dock 摆它。
function New-BubbleInputArea {
    param([string]$Placeholder, [int]$ButtonHeight = 0)

    $theme = $script:BubbleTheme

    $area = New-Object System.Windows.Forms.Panel
    $area.BackColor = $theme.bg
    $area.Padding = New-Object System.Windows.Forms.Padding(0)

    # Dock=Right 的先后顺序 = 从右往左的排列顺序：
    # 先加的贴最右边（发送），后加的排在它左边（语音）。
    $send = New-Object System.Windows.Forms.Button
    $send.Text = '发送'
    $send.Dock = [System.Windows.Forms.DockStyle]::Right
    $send.Width = $script:BubbleSendWidth
    $send.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $send.FlatAppearance.BorderColor = $theme.accent
    $send.BackColor = $theme.panel
    $send.ForeColor = $theme.fg
    $send.Font = Get-BubbleFont -Pixels 13
    $send.Add_Click({ Submit-BubbleInput })
    $area.Controls.Add($send)

    $script:Bubble.Mic = $null
    $mic = New-BubbleMicButton
    if ($mic) { $area.Controls.Add($mic) }

    $box = New-BubbleInputBox -Placeholder $Placeholder
    $box.Dock = [System.Windows.Forms.DockStyle]::Fill
    $area.Controls.Add($box)
    $box.BringToFront()

    $script:Bubble.Input = $box
    Register-BubbleSubmit -Box $box

    return $area
}

# ---------- 定位 ----------

# 气泡贴在哪儿。
#
# 以前一律取鼠标位置 —— 键盘操作过来的时候（比如按完热键直接说话），
# 鼠标可能还停在屏幕另一头，气泡就弹那边去了，用户得满屏找。
# 现在优先贴**当前正在用的那个窗口**的下缘中间：
#   · 不盖住窗口标题栏和菜单
#   · 横向居中，和用户正在看的区域对得上
# 拿不到前台窗口（桌面、UAC 之类）再退回鼠标。
function Get-BubbleAnchorPoint {
    $fg = [Huanmeng.Win32]::GetForegroundWindow()

    # 前台是我方窗口的话（气泡自己、圆环、偏好设置），别拿它当锚点，
    # 否则气泡会贴着自己弹，越弹越偏
    $mine = @()
    if ($script:Bubble.Form) { $mine += $script:Bubble.Form.Handle }
    if ($script:Ring -and $script:Ring.Form) { $mine += $script:Ring.Form.Handle }
    if ($script:PrefsForm) { $mine += $script:PrefsForm.Handle }
    if ($fg -ne [IntPtr]::Zero -and $mine -notcontains $fg) {
        $l = 0; $t = 0; $r = 0; $b = 0
        if ([Huanmeng.Win32]::TryGetWindowRect($fg, [ref]$l, [ref]$t, [ref]$r, [ref]$b)) {
            $cx = [int](($l + $r) / 2)
            $by = $b - 24
            if ($by -lt $t) { $by = $t }
            return @{ X = $cx; Y = $by }
        }
    }

    return Get-CursorPosition
}

# ---------- 显示 ----------

function Show-HuanmengBubble {
    param(
        [ValidateSet('input', 'chat', 'result', 'text')]
        [string]$Mode = 'input',
        [string]$Title = '幻梦AI',
        [string]$Placeholder = '说点什么…',
        [string]$InitialText = '',
        [string]$Hint = '回车发送 · Shift+回车 换行 · Esc 关闭',
        [scriptblock]$OnSubmit = $null,
        [string]$ImagePath = '',
        # 从图库点开时把整组图的路径一起带过来，气泡上就能显示
        # 「上一张/下一张」。给两张以上才有意义，单张不给就是普通结果窗。
        [string[]]$GalleryIds = @(),
        [int]$GalleryIndex = 0,
        [int]$Width = 0,
        [int]$Height = 0
    )

    Initialize-BubbleWindow

    $b = $script:Bubble
    # 主题可能刚在偏好设置里被改过，每次显示都刷一遍
    Update-BubbleTheme
    $theme = $script:BubbleTheme
    $form = $b.Form

    $fg = [Huanmeng.Win32]::GetForegroundWindow()
    if ($fg -ne $form.Handle) { $b.PreviousFg = $fg }

    Reset-BubbleBody

    $b.Mode = $Mode
    $b.OnSubmit = $OnSubmit
    $b.ImagePath = $ImagePath

    # Reset-BubbleBody 刚把这两个清空过，赋值必须在它之后
    $b.GalleryIds = @($GalleryIds)
    $b.GalleryIndex = $GalleryIndex
    if ($b.GalleryIndex -lt 0) { $b.GalleryIndex = 0 }
    if ($b.GalleryIndex -ge $b.GalleryIds.Count) { $b.GalleryIndex = 0 }

    $b.TitleLabel.Text = $Title
    # 提示行的最终文案在 switch 之后拼 —— 那时才知道这个形态有没有输入框
    # （也就才知道该不该提示语音快捷键）
    $b.Hint.Text = $Hint

    # 先按目标尺寸摆好，再往里塞控件 —— Dock 依赖父容器的实际大小，
    # 尺寸后设的话控件会按旧尺寸算一遍，出现错位
    # 图库模式要宽一些 —— 五个按钮排不进 430。
    #
    # 算一下：430 − Padding(12+12) = 可用 406px；每个按钮 100px + 8px 右边距
    # = 108px，三个就占 324px，只剩 82px。再加一个 100px 的按钮，
    # FlowLayoutPanel 会把它折到第二行，而 footer 只有 40px 高 ——
    # 表现是按钮**凭空消失**，不是被裁一半。所以直接加宽。
    $galleryMode = ($Mode -eq 'result' -and @($GalleryIds).Count -gt 1)
    if ($Width -le 0) { if ($galleryMode) { $Width = 560 } else { $Width = 430 } }
    $explicitHeight = ($Height -gt 0)
    if ($Height -le 0) {
        switch ($Mode) {
            'chat'   { $Height = 430 }
            'result' { $Height = 470 }
            'text'   { $Height = 280 }
            default  { $Height = 160 }
        }
    }

    # 输入框形态：内容长就把气泡撑高。
    #
    # 预设提示词最长实测 927 字、25 个换行 —— 固定 160px 只能看到三四行，
    # 即使用户能滚，第一眼也只会觉得「显示不全」。这里按内容估个高度
    # （行数 + 按宽度折行后的行数，取较大者），夹在 160 与屏幕可用高度的六成之间。
    if (-not $explicitHeight -and $Mode -eq 'input' -and $InitialText) {
        $text = [string]$InitialText
        $hardLines = ([regex]::Matches($text, "`n")).Count + 1
        # 430px 宽、15px 字号，一行大约放得下 26 个汉字
        $wrapped = [int][Math]::Ceiling($text.Length / 26.0)
        $wantLines = [Math]::Max($hardLines, $wrapped)
        $want = 96 + $wantLines * 22
        if ($want -lt 160) { $want = 160 }
        try {
            $limit = [int]([System.Windows.Forms.Screen]::FromPoint(
                [System.Windows.Forms.Cursor]::Position).WorkingArea.Height * 0.6)
            if ($limit -lt 160) { $limit = 160 }
            if ($want -gt $limit) { $want = $limit }
        } catch {
            # 拿不到屏幕信息就用一个保守上限，总比撑出屏幕强
            if ($want -gt 520) { $want = 520 }
        }
        $Height = [int]$want
    }
    $form.Size = New-Object System.Drawing.Size($Width, $Height)
    $form.Region = New-RoundedRegion -Width $Width -Height $Height -Radius 12

    switch ($Mode) {

        'input' {
            $area = New-BubbleInputArea -Placeholder $Placeholder
            $area.Dock = [System.Windows.Forms.DockStyle]::Fill
            $b.Body.Controls.Add($area)
            if ($InitialText) {
                $b.Input.Text = $InitialText
                $b.Input.ForeColor = $theme.fg
                $b.Input.Tag.showing = $false
            }
        }

        'text' {
            $box = New-Object System.Windows.Forms.RichTextBox
            $box.Dock = [System.Windows.Forms.DockStyle]::Fill
            $box.BackColor = $theme.panel
            $box.ForeColor = $theme.fg
            $box.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
            $box.Font = Get-BubbleFont -Pixels 14
            $box.ReadOnly = $true
            $box.Text = $InitialText
            $b.Body.Controls.Add($box)
            $b.Transcript = $box
        }

        'chat' {
            # Dock 的填充顺序和添加顺序相反：**后添加的先占边**。
            # 所以先加记录区（Fill），再加输入框（Bottom），
            # 否则输入框会被记录区挤没。
            $transcript = New-Object System.Windows.Forms.RichTextBox
            $transcript.Dock = [System.Windows.Forms.DockStyle]::Fill
            $transcript.BackColor = $theme.panel
            $transcript.ForeColor = $theme.fg
            $transcript.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
            $transcript.Font = Get-BubbleFont -Pixels 14
            $transcript.ReadOnly = $true
            $transcript.ScrollBars = [System.Windows.Forms.RichTextBoxScrollBars]::Vertical
            $b.Body.Controls.Add($transcript)
            $b.Transcript = $transcript

            $area = New-BubbleInputArea -Placeholder $Placeholder
            $area.Dock = [System.Windows.Forms.DockStyle]::Bottom
            $area.Height = 78
            $b.Body.Controls.Add($area)
        }

        'result' {
            $picture = New-Object System.Windows.Forms.PictureBox
            $picture.Dock = [System.Windows.Forms.DockStyle]::Fill
            $picture.BackColor = $theme.panel
            $picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
            $b.Body.Controls.Add($picture)
            $b.Picture = $picture

            if ($ImagePath -and (Test-Path -LiteralPath $ImagePath)) {
                try {
                    # 从流加载后立刻断开：直接用 Bitmap($path) 会一直占着文件句柄，
                    # 用户就没法在资源管理器里删除或重命名这张图
                    $fs = [System.IO.File]::OpenRead($ImagePath)
                    $img = [System.Drawing.Image]::FromStream($fs)
                    $fs.Close()
                    $picture.Image = $img
                } catch { }
            }

            $footer = New-Object System.Windows.Forms.FlowLayoutPanel
            $footer.Dock = [System.Windows.Forms.DockStyle]::Bottom
            $footer.Height = 40
            $footer.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
            $footer.BackColor = $theme.bg
            $footer.Padding = New-Object System.Windows.Forms.Padding(0, 6, 0, 0)
            $b.Body.Controls.Add($footer)
            $b.Footer = $footer

            $defs = @()
            if ($galleryMode) {
                $defs += @{ text = '‹ 上一张';   key = 'prev'; action = { Invoke-BubbleGalleryStep -Delta -1 } }
                $defs += @{ text = '下一张 ›';   key = 'next'; action = { Invoke-BubbleGalleryStep -Delta 1 } }
                # 「用作参考图」= 拿这张再改一版。独立用的时候这是最要紧的一步：
                # 出图 → 看着还行 → 拿它当参考接着调。
                $defs += @{ text = '用作参考图'; key = 'ref';  action = { Invoke-ActionUseAsReference -Path $script:Bubble.ImagePath } }
            }
            $defs += @{ text = '另存为…';   key = 'save';   action = { Invoke-BubbleSaveAs } }
            $defs += @{ text = '打开文件夹'; key = 'folder'; action = { Invoke-BubbleOpenFolder } }
            $defs += @{ text = '关闭';       key = 'close';  action = { Hide-HuanmengBubble } }

            # 五个按钮时每个收窄一点，否则总宽超出去会被 FlowLayoutPanel 折行，
            # 而 footer 只有 40px 高 —— 第二行直接看不见
            $btnW = if (@($defs).Count -gt 3) { 92 } else { 100 }

            foreach ($def in $defs) {
                $btn = New-Object System.Windows.Forms.Button
                $btn.Text = $def.text
                $btn.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
                $btn.FlatAppearance.BorderColor = $theme.accent
                $btn.BackColor = $theme.panel
                $btn.ForeColor = $theme.fg
                $btn.Font = Get-BubbleFont -Pixels 12
                $btn.Size = New-Object System.Drawing.Size($btnW, 28)
                $btn.Margin = New-Object System.Windows.Forms.Padding(0, 0, 8, 0)
                $btn.Add_Click($def.action)
                if ($def.key -eq 'prev') { $b.PrevBtn = $btn }
                if ($def.key -eq 'next') { $b.NextBtn = $btn }
                $footer.Controls.Add($btn)
            }

            # 按钮建好之后才知道该灰哪几个（第一张的「上一张」、最后一张的「下一张」）
            if ($galleryMode) { Update-BubbleGalleryChrome }
        }
    }

    # 有输入框的形态，提示行末尾自动挂上语音快捷键 ——
    # 让每个调用点各写一遍的话，迟早有一处忘了，用户就以为语音只在那一个气泡里能用
    if ($b.Input -and -not $script:Voice.Listening) {
        $suffix = Get-VoiceHintSuffix
        if ($suffix -and $b.Hint.Text -notlike "*$suffix*") {
            $b.Hint.Text = $b.Hint.Text + $suffix
        }
    }

    # 定位：优先贴着圆环；圆环没开就贴着**输入焦点所在的那个窗口**，
    # 而不是鼠标位置 —— 用户是键盘操作过来的时候，鼠标可能停在屏幕另一头，
    # 气泡弹到那边去就找不着了。
    $anchor = $null
    if ($script:Ring.Visible) {
        $anchor = @{ X = $script:Ring.CenterX; Y = $script:Ring.CenterY + 40 }
    } else {
        $anchor = Get-BubbleAnchorPoint
    }
    $pos = $anchor
    $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($pos.X, $pos.Y)))
    $wa = $screen.WorkingArea
    $left = $pos.X - [int]($Width / 2)
    $top = $pos.Y + 12
    if ($left -lt $wa.Left) { $left = $wa.Left + 8 }
    if ($left + $Width -gt $wa.Right) { $left = $wa.Right - $Width - 8 }
    # 下方放不下就翻到上方，并且贴着锚点留 24px，别盖住正在看的东西
    if ($top + $Height -gt $wa.Bottom) { $top = $pos.Y - $Height - 24 }
    if ($top -lt $wa.Top) { $top = $wa.Top + 8 }
    $form.Location = New-Object System.Drawing.Point($left, $top)

    if (-not $form.Visible) { $form.Show() }
    $form.BringToFront()

    # **不能只靠 Activate()。**
    # Windows 的前台锁定会让后台进程的 SetForegroundWindow 被静默拒绝，
    # 助手是托盘程序、圆环窗口又带 WS_EX_NOACTIVATE，永远不是前台 ——
    # 结果气泡看得见、键盘焦点却留在 Photoshop，打字全打进 PS 里去了。
    # 这就是「圆环的对话用不了」的真面目（Show/Hide 都走这里，不只是对话）。
    $gotFg = [Huanmeng.Win32]::ForceForegroundWindow($form.Handle)
    Write-Dbg "气泡抢焦点：句柄=$($form.Handle) 成功=$gotFg 抢完的前台=$([Huanmeng.Win32]::GetForegroundWindow())"
    if (-not $gotFg) {
        $form.Activate()
    }

    if ($b.Input) {
        $b.Input.Focus()
        # 光标挪到文末。从预设带进来的提示词应该是「可以接着改」，
        # 全选的话用户一打字就把整条预设覆盖没了。
        $b.Input.SelectionStart = $b.Input.TextLength
        $b.Input.SelectionLength = 0
    }
}

function Hide-HuanmengBubble {
    $b = $script:Bubble
    if (-not $b.Form -or -not $b.Form.Visible) { return }

    # 气泡关掉时**必须**把收音停掉。不然用户说了半句随手关掉气泡，
    # 麦克风还开着，接下来屋里说什么都会被识别、还找不到字去了哪里。
    if ($script:Voice -and $script:Voice.Listening) {
        $script:Voice.CommitOnStop = $false
        Reset-VoiceState
    }

    $b.Form.Hide()
    $b.Mode = ''

    if ($b.PreviousFg -ne [IntPtr]::Zero) {
        try {
            if ([Huanmeng.Win32]::IsWindow($b.PreviousFg)) {
                [void][Huanmeng.Win32]::SetForegroundWindow($b.PreviousFg)
            }
        } catch { }
        $b.PreviousFg = [IntPtr]::Zero
    }
}

# ---------- 内容更新 ----------

function Update-BubbleChat {
    param(
        [array]$History,
        [string]$Pending = '',
        [string]$BusyText = ''
    )

    $b = $script:Bubble
    if (-not $b.Transcript -or $b.Mode -ne 'chat') { return }

    $theme = $script:BubbleTheme
    $box = $b.Transcript

    # 重建整段记录。用 SelectionBackColor + SelectionAlignment 做出
    # 「自己靠右、助手靠左」的对话气泡 —— RichTextBox 支持按段落设背景色和对齐，
    # 不用为了气泡去自绘一个控件（自绘就拿不到输入法支持了）。
    $box.Clear()

    $appendBubble = {
        param([string]$Text, [bool]$IsMine, [System.Drawing.Color]$Back, [System.Drawing.Color]$Fore)

        $box.SelectionStart = $box.TextLength
        $box.SelectionLength = 0
        if ($IsMine) {
            $box.SelectionAlignment = [System.Windows.Forms.HorizontalAlignment]::Right
        } else {
            $box.SelectionAlignment = [System.Windows.Forms.HorizontalAlignment]::Left
        }
        $box.SelectionBackColor = $Back
        $box.SelectionColor = $Fore
        $box.SelectionFont = Get-BubbleFont -Pixels 14
        # 末尾这个换行也在选区里 —— 不然背景色只包住文字本身，看着像高亮而不像气泡
        $box.AppendText($Text + "`n")
        $box.SelectionStart = $box.TextLength
        $box.SelectionLength = 0
        $box.SelectionBackColor = $theme.panel
        $box.SelectionAlignment = [System.Windows.Forms.HorizontalAlignment]::Left
        $box.AppendText("`n")
    }

    # 气泡底色来自当前主题（见 Get-UiPalette），
    # 换主题时自己的话会跟着变成那个色系的强调色
    $mineBg = $theme.mineBg
    $mineFg = $theme.mineFg
    $theirsBg = $theme.theirsBg
    $theirsFg = $theme.theirsFg

    foreach ($item in @($History)) {
        if (-not $item -or -not $item.text) { continue }
        if ($item.role -eq 'user') {
            & $appendBubble ([string]$item.text) $true $mineBg $mineFg
        } else {
            & $appendBubble ([string]$item.text) $false $theirsBg $theirsFg
        }
    }

    # 刚问出去、还没进历史的那一句补在最下面
    if ($Pending) {
        & $appendBubble $Pending $true $mineBg $mineFg
    }

    if ($BusyText) {
        $box.SelectionStart = $box.TextLength
        $box.SelectionLength = 0
        $box.SelectionAlignment = [System.Windows.Forms.HorizontalAlignment]::Left
        $box.SelectionBackColor = $theme.panel
        $box.SelectionColor = $theme.dim
        $box.SelectionFont = Get-BubbleFont -Pixels 13 -Style ([System.Drawing.FontStyle]::Italic)
        $box.AppendText("$BusyText`n")
    }

    $box.SelectionStart = $box.TextLength
    $box.ScrollToCaret()
}

function Set-BubbleResultImage {
    param([string]$Path)

    $b = $script:Bubble
    if (-not $b.Picture) { return }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }

    try {
        # 从流加载后立刻断开：直接用 Bitmap($path) 会一直占着文件句柄，
        # 用户就没法在资源管理器里删除或重命名这张图
        $fs = [System.IO.File]::OpenRead($Path)
        $img = [System.Drawing.Image]::FromStream($fs)
        $fs.Close()

        if ($b.Picture.Image) { $b.Picture.Image.Dispose() }
        $b.Picture.Image = $img
        $b.ImagePath = $Path
    } catch {
        if ($script:Notify) { & $script:Notify "图片打不开：$($_.Exception.Message)" 'error' }
    }
}

# ---------- 图库翻页 ----------

# 刷新翻页按钮的可用状态和底部提示行。
#
# 越界就把按钮灰掉，而不是让用户点一下再被弹一句话 ——
# 「第一张了」这件事本来就该从界面上直接看出来。
# **不做循环回绕**：从最后一张跳回第一张，用户会以为后面还有很多。
function Update-BubbleGalleryChrome {
    $b = $script:Bubble
    if ($null -eq $b -or $b.Mode -ne 'result') { return }

    $ids = @($b.GalleryIds)
    if ($ids.Count -le 1) { return }

    if ($b.PrevBtn) { $b.PrevBtn.Enabled = ($b.GalleryIndex -gt 0) }
    if ($b.NextBtn) { $b.NextBtn.Enabled = ($b.GalleryIndex -lt $ids.Count - 1) }

    if (-not $b.Hint) { return }

    # 提示行是「只看不窗口」这条路上用户唯一能读到元数据的地方，
    # 所以能查到记录就把提示词/模型/分辨率都带上
    $item = $null
    try { $item = Find-GalleryItem -Path ([string]$b.ImagePath) } catch { }

    if ($item) {
        Set-BubbleHint (Format-GalleryStamp -Item $item -Index $b.GalleryIndex -Total $ids.Count)
    } else {
        Set-BubbleHint "第 $($b.GalleryIndex + 1) / $($ids.Count) 张 · 另存为 / 打开文件夹 · Esc 关闭"
    }
}

function Invoke-BubbleGalleryStep {
    param([int]$Delta)

    $b = $script:Bubble
    $ids = @($b.GalleryIds)
    if ($ids.Count -eq 0) { return }

    # 跳过已经被删掉的。不跳过的话表现是「点了没反应」——
    # Set-BubbleResultImage 遇到不存在的路径是静默 return，旧的图还留在框里。
    $target = Get-GalleryStep -Ids $ids -Index $b.GalleryIndex -Delta $Delta
    if ($target -lt 0) {
        # 正常情况下按钮已经是灰的、点不到这里。能点到说明这一侧的图
        # 全被删了 —— 刷一次按钮状态，别让用户以为按钮坏了。
        Update-BubbleGalleryChrome
        return
    }

    $b.GalleryIndex = $target
    Set-BubbleResultImage -Path $ids[$target]
    Update-BubbleGalleryChrome
}

function Set-BubbleHint {
    param([string]$Text)
    if ($script:Bubble.Hint) { $script:Bubble.Hint.Text = $Text }
}

function Set-BubbleTitle {
    param([string]$Text)
    if ($script:Bubble.TitleLabel) { $script:Bubble.TitleLabel.Text = $Text }
}

function Get-BubbleMode { return $script:Bubble.Mode }

# ---------- 结果窗的两个按钮 ----------

function Invoke-BubbleSaveAs {
    $path = $script:Bubble.ImagePath
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return }

    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.Filter = 'PNG 图片|*.png|JPEG 图片|*.jpg|所有文件|*.*'
    $dialog.FileName = [System.IO.Path]::GetFileName($path)
    $dialog.InitialDirectory = [System.IO.Path]::GetDirectoryName($path)

    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        try {
            $ext = [System.IO.Path]::GetExtension($dialog.FileName).ToLower()
            if ($ext -eq '.jpg' -or $ext -eq '.jpeg') {
                $img = [System.Drawing.Image]::FromFile($path)
                $img.Save($dialog.FileName, [System.Drawing.Imaging.ImageFormat]::Jpeg)
                $img.Dispose()
            } else {
                Copy-Item -LiteralPath $path -Destination $dialog.FileName -Force
            }
            if ($script:Notify) { & $script:Notify "已另存为 $($dialog.FileName)" 'ok' }
        } catch {
            if ($script:Notify) { & $script:Notify "另存失败：$($_.Exception.Message)" 'error' }
        }
    }
    $dialog.Dispose()
}

function Invoke-BubbleOpenFolder {
    $path = $script:Bubble.ImagePath
    if (-not $path) { return }

    $folder = [System.IO.Path]::GetDirectoryName($path)
    if ($folder -and (Test-Path -LiteralPath $folder)) {
        if (Test-Path -LiteralPath $path) {
            # /select 直接定位到那张图，省得用户在几百张里翻
            Start-Process explorer.exe -ArgumentList "/select,`"$path`""
        } else {
            Start-Process explorer.exe -ArgumentList "`"$folder`""
        }
    }
}
