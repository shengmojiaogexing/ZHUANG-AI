# ============================================================
#  RingMenu.ps1 — 圆环菜单
#
#  一个**分层窗口**（WS_EX_LAYERED + UpdateLayeredWindow），
#  每帧整张 32bppArgb 位图推上去。为什么不用 TransparencyKey：
#  那玩意儿只有一个「透明色」，抗锯齿的边缘会留下难看的锯齿和色边，
#  而圆环是斜边 + 半透明 + 投影，必须要真的 per-pixel alpha。
#
#  几个关键决定：
#   · 圆环**永不抢焦点**（WS_EX_NOACTIVATE）。抢了的话 Esc 会送给圆环本身，
#     用户按 Esc 关不掉；而且 Photoshop 会以为自己失活，画布上的选区虚线会消失。
#     代价是收不到键盘消息 —— 所以键盘走 Native.ps1 里的低级钩子。
#   · 悬停和点击都靠**全局轮询光标 + 轮询鼠标键**判断，不靠 MouseMove/Click。
#     分层窗口对 alpha=0 的像素是穿透的，鼠标划过扇区之间的缝隙时根本收不到
#     WM_MOUSEMOVE，靠事件做悬停会「卡」在最后一个扇区上。
#   · 因为轮询是全局的，**必须自己判断光标在不在圆环的方框里** ——
#     否则用户在屏幕另一头点任何东西都会把圆环收掉。
#     框外的一律忽略，那些点击是别的程序的。
# ============================================================

$script:Ring = @{
    Form      = $null
    Bitmap    = $null
    Graphics  = $null
    Size      = 0
    Stack     = @()          # 层级栈；每层 = @{ Title; Items }
    Hover     = -1
    CenterX   = 0
    CenterY   = 0
    Visible   = $false
    AnimStart = $null
    Theme     = $null
    Font      = $null
    FontSmall = $null
    WasDown   = $false
    PendingY  = 0            # 层级切换的临界区，见 Invoke-RingActivate
    OnAction  = $null        # 由主脚本注入：(actionName, payload) -> void
    OnClose   = $null
}

$script:RingShadowPad = 26

# ---------- 几何 ----------

# 扇区分到的**弧长**决定标签能画多大。
#
# 实测：预设分类那层是 23 个扇区，每个只有 15.7°，在文字半径上量出来约 28px 弧长，
# 标签被折成两三行、字号还被压到 7px —— 基本看不清。
# 弧长随半径**线性增长**，所以「把整层撑大」是真能解决它，不用改菜单结构。
#
# 目标：每个扇区至少留出 MinArc 像素弧长。6 个扇区以内本来就宽裕，不动。
$script:RingCrowdedMinArc = 48.0     # 每个扇区最少要有的弧长（像素）
$script:RingCrowdedMaxBoost = 1.5    # 撑大上限 —— 再大窗口就要盖住小半个屏幕了

function Get-RingSectorBoost {
    param([int]$Count)

    if ($Count -le 6) { return 1.0 }

    $a = $script:Cfg.appearance
    # 文字画在环带**中线**上，所以量的是中线半径处的弧长
    $textR = [double]$a.outerRadius * (1.0 - [double]$a.bandRatio / 2.0)
    $sweep = 360.0 / $Count
    $gap = Get-RingGap -Sweep $sweep
    # 0.94 和 Draw-RingFrame 里算 $maxWidth 用的系数保持一致 ——
    # 两处不一致的话，这里以为放得下、那边其实放不下，撑了也白撑。
    $arc = $textR * (($sweep - $gap) * [Math]::PI / 180.0) * 0.94
    if ($arc -le 0.5) { return $script:RingCrowdedMaxBoost }

    $boost = $script:RingCrowdedMinArc / $arc
    if ($boost -lt 1.0) { return 1.0 }
    if ($boost -gt $script:RingCrowdedMaxBoost) { return $script:RingCrowdedMaxBoost }
    return $boost
}

# 扇区标签的字号系数。
#
# 基础规则：不分页，项数一多就整层一起缩字号（比逐项截断好认）。
# 但**被撑大的那一层要跟着放大** —— 环都撑大了字还那么小，等于白撑。
function Get-RingFontScale {
    param([int]$Count, [double]$Boost = 1.0)

    $scale = 1.0
    if ($Count -gt 6) { $scale = [Math]::Max(0.55, [Math]::Sqrt(6.0 / $Count)) }
    $scaled = $scale * $Boost
    if ($scaled -gt 1.0) { return 1.0 }
    return $scaled
}

function Get-RingMetrics {
    # 项数决定要不要撑大。**必须传对** —— 窗口/位图尺寸和画出来的半径
    # 都从这里取，两处（Show-RingMenu 定尺寸 / Draw-RingFrame 绘制）不一致
    # 的结果是被裁掉一半（窗口小了）或者点不准（命中判定跟着 RingHit 走，也会错位）。
    param([int]$ItemCount = 0)

    $a = $script:Cfg.appearance
    $outer = [double]$a.outerRadius
    $boost = Get-RingSectorBoost -Count $ItemCount
    $outer = $outer * $boost

    # 厚度用**比例**表示（macOS 同名键 bandRatio）：
    # 用户改半径时厚度会跟着等比缩放，环的观感保持一致；
    # 用绝对像素的话，半径调大一圈，环带就细得像根线。
    $inner = $outer * (1.0 - [double]$a.bandRatio)
    if ($inner -lt 12) { $inner = 12 }

    # 画布要留多少边。
    #
    # **悬停弹出量必须算进来。** 悬停时扇区整体向外挪 popDistance，外缘还要
    # 多描一圈 2.2px 的辉光 —— 留白不够的话，弹出去的那一块正好落在画布外，
    # 被裁成一条直边，就是「往外突就显示不全」。
    # 早先这里只按投影算了 8px 基础留白，默认弹出距离 6 恰好蒙混过去；
    # 一旦在偏好设置里把「弹出距离」调大（滑杆范围 0–30）就露馅了。
    #
    # 投影和弹出是两件互不相干的事，画布要把两者都装下，所以取较大值，不是相加。
    $popExtent = [double]$a.popDistance + 4.0          # 弹出距离 + 那圈外缘辉光
    $shadowExtent = 0.0
    if ($a.shadowEnabled) {
        $shadowExtent = [double]$a.shadowBlur + [Math]::Abs([double]$a.shadowOffsetY)
    }
    $pad = 8.0 + [Math]::Max($popExtent, $shadowExtent)

    return @{
        Outer = $outer
        Inner = $inner
        Half  = [int][Math]::Ceiling($outer + $pad)
        Pad   = [int][Math]::Ceiling($pad)
        # 画布比环本体大出来的这一圈（= 弹出留白），命中判定要用它把两者区分开
        Pop   = [double]$a.popDistance
        # 这一层被撑大的倍数（1.0 = 没撑）。字号要乘它，见 Get-RingFontScale
        Boost = $boost
    }
}

# 每个扇区之间留多少角度。按比例算再夹上限 ——
# 固定角度在 6 个扇区时刚好，12 个子菜单项时会把环切得稀碎。
function Get-RingGap {
    param([double]$Sweep)
    $a = $script:Cfg.appearance
    $gap = $Sweep * [double]$a.gapRatio
    if ($gap -gt [double]$a.gapMax) { $gap = [double]$a.gapMax }
    return $gap
}

function New-AnnularSectorPath {
    param([double]$Cx, [double]$Cy, [double]$ROuter, [double]$RInner, [double]$A0, [double]$A1)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $sweep = $A1 - $A0
    if ($sweep -le 0.01) { return $path }

    # AddArc 的角度是「0° = 3 点钟，正值顺时针」。所以 -90° 正好是正上方。
    $path.AddArc([single]($Cx - $ROuter), [single]($Cy - $ROuter), [single]($ROuter * 2), [single]($ROuter * 2), [single]$A0, [single]$sweep)
    $path.AddArc([single]($Cx - $RInner), [single]($Cy - $RInner), [single]($RInner * 2), [single]($RInner * 2), [single]$A1, [single](-$sweep))
    $path.CloseFigure()
    return $path
}

# ---------- 画 ----------

function Get-RingFont {
    param([double]$Pixels)

    $size = [single][Math]::Max(8.0, $Pixels)
    # 中文优先雅黑 —— 用 Segoe UI 渲染中文会退化成点阵，很难看
    foreach ($name in @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI')) {
        try {
            return New-Object System.Drawing.Font($name, $size, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        } catch { }
    }
    return New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericSansSerif, $size, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
}

# 把一个标签折成最多两行，塞进 $MaxWidth 里。
#
# 为什么非折不可：13 个模型名一次铺满圆环时，每个扇区只剩 ~50px 的单行宽度，
# `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst` 会被截成同一个
# 「gpt-image-…」—— 用户根本分不出点的是哪一个。折成两行宽度翻倍，
# `gpt-image-` / `2.5-sunburst` 就都完整了。
#
# 断点优先选分隔符（空格 - / . : 中文标点…），一个都没有时才均匀采样。
# 采样点上限 16 个 —— MeasureString 对中文很慢，逐字试会明显卡顿。
function Get-RingTextLines {
    param($Graphics, [string]$Text, $Font, [double]$MaxWidth)

    # 同样**不能**用 `return ,@(...)`：调用方那句 `@(Get-RingTextLines ...)`
    # 不会把逗号包出来的那层摊开，$lines 会变成「装着数组的数组」，
    # 于是 $ln.Length 恒等于 1，所有标签都被截成两个字符 + 省略号。
    if (-not $Text) { return '' }
    if ($MaxWidth -le 0) { return $Text }

    $whole = $Graphics.MeasureString($Text, $Font).Width
    if ($whole -le $MaxWidth) { return $Text }

    # 分隔符分两档，权重差很多。
    # 空格 / 斜杠 / 圆括号断行读起来最自然；而 `-` `.` 常常出现在
    # 版本号中间（gpt-5.4、2.5-flare），在那儿断会得到「gpt-5.」/「4 (GRS)」
    # 这种把版本号劈成两半的难看结果 —— 所以只给一点点加权，
    # 用来在「哪儿都放得下」时打破平局，不足以盖过平衡度。
    $sepsStrong = @(' ', '/', '·', '、', '，', ',', '(', '（', '[')
    $sepsWeak = @('\', '-', '_', '.', ':', '：')
    $seps = $sepsStrong + $sepsWeak

    $cands = New-Object System.Collections.ArrayList
    for ($i = 1; $i -lt $Text.Length; $i++) {
        if ($seps -contains [string]$Text[$i - 1]) { [void]$cands.Add($i) }
    }
    if ($cands.Count -eq 0) {
        $step = [Math]::Max(1, [int][Math]::Floor($Text.Length / 16))
        for ($i = $step; $i -lt $Text.Length; $i += $step) { [void]$cands.Add($i) }
    }

    # 两轮挑选。
    #
    # 第一轮：两行都放得下的断点，取宽度最接近的（最平衡 = 最好看）。
    # 第二轮：一个都放不下时**不要就此放弃**，取「最长那行最窄」的断点，
    #         交给调用方缩一点点字号。gpt-image-2.5-flare 就是第二种情况 ——
    #         在 8.8px 下两行各差几个像素，缩到 8.0px 就能整名显示；
    #         放弃的结果是所有 gpt-image 系列都被截成同一个「gpt-image-…」，
    #         那才是真正的不可用。
    $fitBest = -1
    $fitSpread = [double]::MaxValue
    $anyBest = -1
    $anyWidest = $whole

    foreach ($i in $cands) {
        $left = $Text.Substring(0, $i).Trim()
        $right = $Text.Substring($i).Trim()
        if (-not $left -or -not $right) { continue }

        $wL = $Graphics.MeasureString($left, $Font).Width
        $wR = $Graphics.MeasureString($right, $Font).Width
        $widest = [Math]::Max($wL, $wR)

        # 在分隔符后面断开读起来更自然，给一点加权
        $pref = 0.0
        $prev = [string]$Text[$i - 1]
        if ($sepsStrong -contains $prev) { $pref = $MaxWidth * 0.45 }
        elseif ($sepsWeak -contains $prev) { $pref = $MaxWidth * 0.10 }

        if ($wL -le $MaxWidth -and $wR -le $MaxWidth) {
            $spread = [Math]::Abs($wL - $wR) - $pref
            if ($spread -lt $fitSpread) { $fitSpread = $spread; $fitBest = $i }
        }
        if (($widest - $pref) -lt $anyWidest) { $anyWidest = $widest - $pref; $anyBest = $i }
    }

    $pick = $fitBest
    if ($pick -le 0) { $pick = $anyBest }
    if ($pick -gt 0) {
        return $Text.Substring(0, $pick).Trim(), $Text.Substring($pick).Trim()
    }
    # 断不开（比如一长串没有分隔符的中文）—— 原样交回去，让调用方去缩/截
    return $Text
}

function Get-RingScale {
    # 弹出动画：appearScale → 1.0，110ms 缓出。动画关掉时恒为 1。
    $a = $script:Cfg.appearance
    if (-not $a.animation) { return 1.0 }
    if (-not $script:Ring.AnimStart) { return 1.0 }
    $start = [double]$a.appearScale
    if ($start -ge 1.0) { return 1.0 }
    $elapsed = ((Get-Date) - $script:Ring.AnimStart).TotalMilliseconds
    $t = [Math]::Min(1.0, $elapsed / 110.0)
    $eased = 1 - [Math]::Pow(1 - $t, 3)
    return $start + (1.0 - $start) * $eased
}

function New-RingBitmap {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bmp.SetResolution(96, 96)
    return $bmp
}

function Draw-RingFrame {
    $ring = $script:Ring
    if (-not $ring.Visible) { return }

    # 先看清这一层有多少项，再算几何 ——
    # 项数决定要不要把整层撑大，而撑大之后**位图尺寸**也得跟着变，
    # 顺序反了就会画出被裁掉一半的环。
    $level = $ring.Stack[$ring.Stack.Count - 1]
    if (-not $level) { return }
    $items = @($level.Items)
    $count = $items.Count

    $metrics = Get-RingMetrics -ItemCount $count
    $half = $metrics.Half
    $size = $half * 2
    if ($size -lt 64) { return }

    if (-not $ring.Bitmap -or $ring.Size -ne $size) {
        if ($ring.Graphics) { $ring.Graphics.Dispose() }
        if ($ring.Bitmap) { $ring.Bitmap.Dispose() }
        $ring.Bitmap = New-RingBitmap -Size $size
        $ring.Graphics = [System.Drawing.Graphics]::FromImage($ring.Bitmap)
        $ring.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        # **不用 ClearType**：分层窗口上 ClearType 会在半透明边缘产生彩色描边
        $ring.Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
        $ring.Size = $size
    }

    $g = $ring.Graphics
    $g.Clear([System.Drawing.Color]::Transparent)

    if ($count -eq 0) {
        [Huanmeng.Win32]::PushBitmap($ring.Form.Handle, $ring.Bitmap, $ring.CenterX - $half, $ring.CenterY - $half)
        return
    }

    $a = $script:Cfg.appearance
    $theme = $ring.Theme
    $opacity = [double]$a.opacity
    $scale = Get-RingScale
    $cx = $half
    $cy = $half
    $rOuter = $metrics.Outer * $scale
    $rInner = $metrics.Inner * $scale
    $sweep = 360.0 / $count
    $gap = Get-RingGap -Sweep $sweep
    $pop = [double]$a.popDistance * $scale

    # 命中测试用的有效半径也记下来（动画中每帧都在变，
    # 不做这一步的话动画没结束就点，判定用的还是上一帧的半径）
    # Pop 也要记：悬停扇区实际画到了 Outer + Pop，命中判定得跟着放宽，
    # 否则「看得见的那块弹出来的扇区」点不到（会被当成环外，一点就收起）。
    $script:RingHit = @{ Inner = $rInner; Outer = $rOuter; Pop = $pop; Sweep = $sweep; Count = $count; Half = $half }

    # 颜色只在主题或透明度变化时才重算。
    # 之前每帧都要把 10 来个十六进制色值挨个走一遍 ConvertTo-Color
    # （字符串解析 + Convert::ToInt32），悬停时每帧都重复做这件事纯属浪费。
    $colorKey = "$($theme.wedgeFill)|$($theme.hoverFill)|$opacity|$($a.disabledWedgeAlpha)"
    if (-not $ring.CachedColors -or $ring.CachedColors.Key -ne $colorKey) {
        $lim = { param($v) [Math]::Min(1.0, $v) }
        $ring.CachedColors = @{
            Key       = $colorKey
            wedge     = ConvertTo-Color $theme.wedgeFill    $opacity
            wedgeAlt  = ConvertTo-Color $theme.wedgeFillAlt $opacity
            edge      = ConvertTo-Color $theme.wedgeEdge    (& $lim ($opacity + 0.02))
            hover     = ConvertTo-Color $theme.hoverFill    (& $lim ($opacity + 0.04))
            hoverEdge = ConvertTo-Color $theme.hoverEdge    ([Math]::Min(1.0, $opacity))
            hubFill   = ConvertTo-Color $theme.hubFill      (& $lim ($opacity + 0.03))
            hubEdge   = ConvertTo-Color $theme.hubEdge      (& $lim ($opacity + 0.02))
            text      = ConvertTo-Color $theme.textColor    1.0
            textDim   = ConvertTo-Color $theme.textDim      1.0
            textFaint = ConvertTo-Color $theme.textFaint    1.0
            accent    = ConvertTo-Color $theme.accent       1.0
            # 禁用扇区：整体压暗，而不是换个颜色 —— 换颜色会让它看起来像另一种状态
            wedgeOff  = ConvertTo-Color $theme.wedgeFill    ([Math]::Min(1.0, $opacity * [double]$a.disabledWedgeAlpha))
            edgeOff   = ConvertTo-Color $theme.wedgeEdge    ([Math]::Min(1.0, $opacity * [double]$a.disabledEdgeAlpha))
            # 外缘那道白色发丝高光。它是「玻璃感」的来源 ——
            # 没有它，扇区就是一块平涂的色块；有了它，边缘会像有一层薄薄的厚度。
            # alpha 不能高：这是反光，不是描边，超过 40 就变成廉价的亮边了。
            rim       = [System.Drawing.Color]::FromArgb(34, 255, 255, 255)
            rimHi     = [System.Drawing.Color]::FromArgb(120, 255, 255, 255)
        }
    }
    $cc = $ring.CachedColors

    # 画布保持全透明，**不要**铺一层 alpha=1 的底。
    #
    # 早先铺过一层，想让整块方框都参与命中测试。结果适得其反：
    # 分层窗口里 alpha>0 的像素会吞掉点击，于是圆环方框的四个角
    # 也把本该交给 Photoshop 的点击吃掉了 —— 用户点画布没反应。
    #
    # 而「点到哪儿了」根本不依赖窗口的命中测试：Update-RingTick 是
    # 轮询全局光标位置算出来的，透明区域照样能判。所以这层底纯属有害。

    # ---- 投影 ----
    #
    # 10 圈由内到外逐渐变淡，叠出来像连续的模糊（GDI+ 没有现成的模糊）。
    # 这 10 圈**预渲染成一张独立的位图并缓存** —— 悬停只会改变扇区颜色，
    # 投影和悬停无关。之前每帧都重建 10 个 GraphicsPath + 10 次填充，
    # 悬停重绘一次就白干一遍，这是「圆环很卡」的第二大来源。
    # 缓存键里带上 scale：弹出动画期间尺寸在变，动画结束（scale=1）后稳定命中缓存。
    if ($a.shadowEnabled) {
        $shadowKey = "$size|$scale|$rOuter|$rInner|$($a.shadowBlur)|$($a.shadowOffsetY)|$($a.shadowAlpha)"
        if (-not $ring.ShadowCache -or $ring.ShadowCache.Key -ne $shadowKey) {
            $sb = New-RingBitmap -Size $size
            $sg2 = [System.Drawing.Graphics]::FromImage($sb)
            $sg2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            # 圈数跟着 shadowBlur 走：叠得越多越接近高斯模糊，
            # 每圈的 alpha 用总量除以圈数反推，这样调「浓度」时不会顺带改扩散范围。
            $passes = [Math]::Max(4, [Math]::Min(24, [int]$a.shadowBlur))
            $peak = [double]$a.shadowAlpha * 255.0
            $perPass = [int][Math]::Max(1, [Math]::Round($peak / $passes))
            $offsetY = [int]$a.shadowOffsetY
            for ($pass = $passes; $pass -ge 1; $pass--) {
                $inflate = $pass * ([double]$a.shadowBlur / $passes)
                $shadowPath = New-AnnularSectorPath -Cx $cx -Cy ($cy + $offsetY) -ROuter ($rOuter + $inflate) `
                    -RInner ([Math]::Max(2.0, $rInner - $inflate)) -A0 -90 -A1 270
                $shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($perPass, 0, 0, 0))
                $sg2.FillPath($shadowBrush, $shadowPath)
                $shadowBrush.Dispose()
                $shadowPath.Dispose()
            }
            $sg2.Dispose()
            if ($ring.ShadowCache -and $ring.ShadowCache.Bmp) { $ring.ShadowCache.Bmp.Dispose() }
            $ring.ShadowCache = @{ Key = $shadowKey; Bmp = $sb }
        }
        $g.DrawImage($ring.ShadowCache.Bmp, 0, 0)
    }

    # ---- 扇区 ----

    # 字体正常在 Show-RingMenu 里就建好了，这里再兜一次底。
    # 少了这一手的话，只要有任何一条路径没建字体，下面 MeasureString / DrawString
    # 就会抛「font 不能为 null」—— 那是整帧画不出来的硬失败，
    # 表现是「圆环完全不显示」，比字号差几个像素严重得多。
    if (-not $ring.Font) { $ring.Font = Get-RingFont -Pixels $a.labelFontSize }
    if (-not $ring.FontSmall) { $ring.FontSmall = Get-RingFont -Pixels $a.hubSubFontSize }
    if (-not $ring.FontHub) { $ring.FontHub = Get-RingFont -Pixels $a.hubTitleFontSize }

    # 扇区一多就整体缩小字号。
    #
    # 不分页之后，模型清单一次要铺 13 个扇区（每个 27°）、预设分类 23 个（每个 15°），
    # 按配置字号根本放不下。这时**整层一起缩**，而不是每项各自截断 ——
    # 截断的结果是一屋子「gemini…」「gpt-i…」，谁也认不出是哪个。
    # 缩到 0.55 倍就不缩了：再小投影到屏幕上也是一团糊，那时宁可让它截断。
    # 有了下面那个折行，「项数多」的压力大半由两行分担，所以地板比
    # 早先的 0.45 抬高了一档 —— 13 个模型名现在能保住 8.8px 且每行完整。
    # （被撑大的那层由 Get-RingFontScale 把 $metrics.Boost 乘回去）
    $fontScale = Get-RingFontScale -Count $count -Boost $metrics.Boost
    $sectorFontKey = "$($a.labelFontSize)|$([Math]::Round($fontScale, 3))"
    if (-not $ring.SectorFont -or $ring.SectorFontKey -ne $sectorFontKey) {
        if ($ring.SectorFont) { try { $ring.SectorFont.Dispose() } catch { } }
        $ring.SectorFont = Get-RingFont -Pixels ($a.labelFontSize * $fontScale)
        $ring.SectorFontKey = $sectorFontKey
    }

    $font = $ring.SectorFont
    # StringFormat 每帧新建/销毁一次毫无必要 —— 缓存在窗口初始化里
    $format = $ring.TextFormat

    # 文字推迟到第二趟再画。
    #
    # 为什么要拆两趟：方向指示线要横跨整个环带才有意义，而它必须画在
    # 扇区填充**之上**、文字**之下** —— 否则要么被底色盖住，要么糊在字上。
    # 一趟画完的话这两个条件没法同时满足。
    $textQueue = New-Object System.Collections.ArrayList

    for ($i = 0; $i -lt $count; $i++) {
        $item = $items[$i]
        $a0 = -90 + $i * $sweep
        $a1 = $a0 + $sweep - $gap
        $isHover = ($i -eq $ring.Hover)
        $isDisabled = [bool]$item.Disabled

        # 悬停扇区整体向外弹出 popDistance（mac 版同名键）——
        # 配合外缘辉光，鼠标扫过去时一眼能看出选中的是哪一个，比只换颜色明显得多。
        # 禁用扇区不弹：它点不动，弹出来会给人「可以点」的错觉。
        $outer = $rOuter
        if ($isHover -and -not $isDisabled) { $outer = $rOuter + $pop }
        $path = New-AnnularSectorPath -Cx $cx -Cy $cy -ROuter $outer -RInner $rInner -A0 $a0 -A1 $a1

        # 沿**半径方向**的线性渐变：环内侧略暗、外侧略亮。
        # 平涂出来的扇区看着像贴纸，有一点点明暗过渡才有厚度。
        $midRad = (($a0 + $a1) / 2.0) * [Math]::PI / 180.0
        $gx0 = $cx + [Math]::Cos($midRad) * $rInner
        $gy0 = $cy + [Math]::Sin($midRad) * $rInner
        $gx1 = $cx + [Math]::Cos($midRad) * $outer
        $gy1 = $cy + [Math]::Sin($midRad) * $outer

        $sweepDeg = $a1 - $a0

        # 填充色：悬停 > 禁用 > 交替（wedgeFill / wedgeFillAlt 深浅交错）。
        # 交替是 mac 版的观感来源 —— 六个扇区同一色会糊成一整块饼，
        # 隔一个换一档深浅，扇区边界自然就出来了。
        if ($isHover -and -not $isDisabled) {
            $fillInner = $cc.hover
            $fillOuter = $cc.hoverEdge
        } elseif ($isDisabled) {
            $fillInner = $cc.wedgeOff
            $fillOuter = $cc.wedgeOff
        } elseif (($i % 2) -eq 1) {
            $fillInner = $cc.wedgeAlt
            $fillOuter = $cc.wedgeAlt
        } else {
            $fillInner = $cc.wedge
            $fillOuter = $cc.wedge
        }

        # 沿**半径方向**的线性渐变：环内侧略暗、外侧略亮。
        # 平涂出来的扇区看着像贴纸，有一点点明暗过渡才有厚度。
        # 有了交替底色之后，渐变只做「同一扇区内侧到外侧」的微调，
        # 两端的差异收窄，免得和交替色打架。
        $brush = $null
        if (([Math]::Abs($gx1 - $gx0) + [Math]::Abs($gy1 - $gy0)) -gt 1.0) {
            $inner2 = [System.Drawing.Color]::FromArgb(
                $fillInner.A,
                [Math]::Max(0, [int]($fillInner.R * 0.94)),
                [Math]::Max(0, [int]($fillInner.G * 0.94)),
                [Math]::Max(0, [int]($fillInner.B * 0.94)))
            $outer2 = [System.Drawing.Color]::FromArgb(
                $fillOuter.A,
                [Math]::Min(255, [int]($fillOuter.R * 1.06 + 4)),
                [Math]::Min(255, [int]($fillOuter.G * 1.06 + 4)),
                [Math]::Min(255, [int]($fillOuter.B * 1.06 + 4)))
            try {
                $p1 = New-Object System.Drawing.PointF([single]$gx0, [single]$gy0)
                $p2 = New-Object System.Drawing.PointF([single]$gx1, [single]$gy1)
                $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p1, $p2, $inner2, $outer2)
            } catch { $brush = $null }
        }
        if (-not $brush) { $brush = New-Object System.Drawing.SolidBrush($fillInner) }
        $g.FillPath($brush, $path)
        $brush.Dispose()

        # 扇区之间描一道细边。纯靠 gap 露出的背景在浅色壁纸上会糊成一片，
        # 加这条线边界才立得住。禁用扇区的边也跟着淡下去。
        $edgeColor = if ($isDisabled) { $cc.edgeOff } elseif ($isHover) { $cc.hoverEdge } else { $cc.edge }
        $pen = New-Object System.Drawing.Pen($edgeColor, 1)
        $g.DrawPath($pen, $path)
        $pen.Dispose()

        # 外缘的白色发丝高光 —— 「玻璃感」主要来自这一笔。
        # 它模拟的是环体边缘的一层反光，不是描边，所以 alpha 压得很低。
        if ($sweepDeg -gt 1.5 -and -not $isDisabled) {
            $rimPen = New-Object System.Drawing.Pen($(if ($isHover) { $cc.rimHi } else { $cc.rim }), 1.2)
            $g.DrawArc($rimPen, [single]($cx - $outer + 0.6), [single]($cy - $outer + 0.6),
                [single](($outer - 0.6) * 2), [single](($outer - 0.6) * 2), [single]$a0, [single]$sweepDeg)
            $rimPen.Dispose()
        }

        # 悬停：外缘再来一圈品牌色辉光，这是「选中」最直接的信号
        if ($isHover -and -not $isDisabled -and $sweepDeg -gt 1.5) {
            $glowPen = New-Object System.Drawing.Pen($cc.hoverEdge, 2.2)
            $g.DrawArc($glowPen, [single]($cx - $outer - 1.2), [single]($cy - $outer - 1.2),
                [single](($outer + 1.2) * 2), [single](($outer + 1.2) * 2), [single]$a0, [single]$sweepDeg)
            $glowPen.Dispose()
        }

        $path.Dispose()

        $midAngle = ($a0 + $a1) / 2.0
        $rad = $midAngle * [Math]::PI / 180.0
        # 悬停扇区弹出去了，文字也跟着往外挪，否则字会贴在扇区内缘
        $textR = ($rOuter + $rInner) / 2.0
        if ($isHover -and -not $isDisabled) { $textR = $textR + $pop * 0.5 }
        $tx = $cx + [Math]::Cos($rad) * $textR
        $ty = $cy + [Math]::Sin($rad) * $textR

        # ---- 文字 ----
        #
        # 文字内容只随菜单变化、不随悬停变化，所以**测量一次、缓存到条目上**。
        # 之前每次重绘都对每个扇区做 MeasureString —— 中文文本测量很慢，
        # 悬停一下 = 6 次测量，「圆环很卡」的另一半来源就在这里。
        # 缓存键带上字号/环几何/缩放（动画期间缩放再变，结束后稳定命中）。
        $fitKey = "$($a.labelFontSize)|$($metrics.Outer)|$($metrics.Inner)|$gap|$count|$([Math]::Round($scale, 2))|$($a.showChildMarker)"
        if ($item.FitKey -ne $fitKey) {
            $label = [string]$item.Label
            if ($item.Checked) { $label = '✓ ' + $label }
            # 有子菜单的标记（mac 版 showChildMarker 开关）
            if ($item.HasChildren -and $a.showChildMarker) { $label = $label + ' ›' }

            $arcWidth = ($rOuter - $rInner)
            $maxWidth = [Math]::Min($arcWidth, ($textR * ($sweep - $gap) * [Math]::PI / 180.0) * 0.94)

            # 先折行，再谈缩小。顺序反过来的话字会白白缩到看不清。
            $lines = @(Get-RingTextLines -Graphics $g -Text $label -Font $font -MaxWidth $maxWidth)

            $widest = 0.0
            foreach ($ln in $lines) {
                $w = $g.MeasureString($ln, $font).Width
                if ($w -gt $widest) { $widest = $w }
            }

            $sectorFont = $font
            if ($widest -gt $maxWidth -and $widest -gt 0) {
                $ratio = $maxWidth / $widest
                # 注意：Get-RingFont 有 8px 下限，$ratio 算出来低于下限时字会被
                # 悄悄抬回 8px，于是标签比 maxWidth 宽出几个像素。
                # 这是**故意的** —— 宁可挤一点，也不能截断：
                # 「gpt-image-2」截成「gpt-image…」丢掉的那个 2 正是它和
                # 「gpt-image-2.5」唯一的区别。别再往这里加下限判断。
                if ($ratio -lt 0.55) {
                    # 缩太多就没法看了，改成截断 —— 只截**放不下的那几行**，
                    # 放得下的原样留着，免得整条标签一起废掉
                    $kept = @()
                    foreach ($ln in $lines) {
                        $w = $g.MeasureString($ln, $font).Width
                        if ($w -le $maxWidth) { $kept += $ln; continue }

                        # **$keep 必须夹在 1..$ln.Length 之间。**
                        # 早先写的是 Max(2, ...)：环带被调得很细时 maxWidth 只剩
                        # 十来个像素，一个「无」字都比它宽，算出来 floor(1 × 0.x) = 0，
                        # Max(2, 0) = 2 —— 然后对 1 个字的字符串 Substring(0, 2)，
                        # 直接抛「索引和长度必须引用字符串内的位置」，整帧画不出来。
                        $keep = [int][Math]::Floor($ln.Length * ($maxWidth / $w))
                        if ($keep -ge $ln.Length) { $kept += $ln }
                        elseif ($keep -lt 1) { $kept += $ln.Substring(0, 1) + '…' }
                        else { $kept += $ln.Substring(0, $keep) + '…' }
                    }
                    $lines = $kept
                } else {
                    # 缩小的字体是临时对象，记到层级上，层级销毁时一起释放。
                    # 基准是**已经整体缩过的**字号，不是配置原值。
                    $sectorFont = Get-RingFont -Pixels ($a.labelFontSize * $fontScale * $ratio)
                    if (-not $level.FitFonts) { $level.FitFonts = @() }
                    $level.FitFonts += $sectorFont
                }
            }
            $item.FitKey = $fitKey
            $item.FitLines = $lines
            $item.FitFont = $sectorFont
        }
        # 禁用扇区的文字也压暗 —— 只压底色不压字，看着还是能点的样子
        $textColor = if ($isDisabled) { $cc.textFaint } else { $cc.text }
        [void]$textQueue.Add(@{
            Lines = $item.FitLines
            Font = $item.FitFont
            TextR = $textR
            Tx = $tx
            Ty = $ty
            Color = $textColor
        })
    }

    # ---- 方向指示线 ----
    # 从 hub 边缘指向当前悬停扇区中线、一直延伸到环带外缘的一条细射线
    # （mac 版同名键 showDirectionLine）。快速划过时它能立刻说明
    # 「现在指的是哪一个」，比只靠高亮更快。
    # 画在这里 = 在扇区填充之上、文字之下，所以不会盖住任何字。
    $hoveringAny = ($ring.Hover -ge 0 -and $ring.Hover -lt $count)
    if ($a.showDirectionLine -and $hoveringAny -and $count -gt 0) {
        $midA = (-90 + $ring.Hover * $sweep + $sweep / 2.0) * [Math]::PI / 180.0
        $lineR0 = $rInner - 4
        $lineR1 = $rOuter - 6
        if ($lineR1 -gt $lineR0) {
            $linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(
                [int]([Math]::Min(255, 90 * $opacity)), $cc.accent.R, $cc.accent.G, $cc.accent.B), 2.0)
            $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $g.DrawLine($linePen,
                [single]($cx + [Math]::Cos($midA) * $lineR0), [single]($cy + [Math]::Sin($midA) * $lineR0),
                [single]($cx + [Math]::Cos($midA) * $lineR1), [single]($cy + [Math]::Sin($midA) * $lineR1))
            $linePen.Dispose()
        }
    }

    # ---- 文字（第二趟）----
    # 逐行画，不用 `n 换行：StringFormat 上的 NoWrap 会把内嵌换行也一起吃掉，
    # 与其和 GDI+ 的参数语义较劲，不如自己算行高来得确定。
    foreach ($t in $textQueue) {
        $textBrush = New-Object System.Drawing.SolidBrush ($t.Color)
        $lines = @($t.Lines)
        if ($lines.Count -eq 0) { $textBrush.Dispose(); continue }

        $lineH = $t.Font.Size * [double]$a.labelLineHeight
        # 多行时整块上移半行，让文字块的中心仍然落在扇区中线上
        $y0 = $t.Ty - ($lineH * ($lines.Count - 1) / 2.0)
        for ($k = 0; $k -lt $lines.Count; $k++) {
            $lineY = $y0 + $lineH * $k
            $rect = New-Object System.Drawing.RectangleF(($t.Tx - $t.TextR), ($lineY - $t.TextR), ($t.TextR * 2), ($t.TextR * 2))
            $g.DrawString($lines[$k], $t.Font, $textBrush, $rect, $format)
        }
        $textBrush.Dispose()
    }
    $textQueue.Clear()

    # ---- 中枢（hub）----
    # mac 版把中心圆盘叫 hub，有自己的填充/描边色（hubFill / hubEdge），
    # 并且分「标题 + 副标题」两级文字（hubTitleFontSize / hubSubFontSize）。
    $hubR = $rInner - 6
    if ($hubR -gt 10) {
        $hubBrush = New-Object System.Drawing.SolidBrush($cc.hubFill)
        $g.FillEllipse($hubBrush, [single]($cx - $hubR), [single]($cy - $hubR), [single]($hubR * 2), [single]($hubR * 2))
        $hubBrush.Dispose()

        $hubPen = New-Object System.Drawing.Pen($cc.hubEdge, 1)
        $g.DrawEllipse($hubPen, [single]($cx - $hubR), [single]($cy - $hubR), [single]($hubR * 2), [single]($hubR * 2))
        $hubPen.Dispose()

        # 圆盘顶端再补一段高光弧，和扇区的外缘高光是同一套语言
        $capPen = New-Object System.Drawing.Pen($cc.rim, 1.1)
        $g.DrawArc($capPen, [single]($cx - $hubR + 0.5), [single]($cy - $hubR + 0.5),
            [single](($hubR - 0.5) * 2), [single](($hubR - 0.5) * 2), 200.0, 140.0)
        $capPen.Dispose()

        # 悬停时 hub 显示那一项的完整名字（扇区里放不下会被截断），
        # 没悬停就显示当前层级标题 —— 子菜单里用户得知道自己在哪一层
        $hovering = ($ring.Hover -ge 0 -and $ring.Hover -lt $count)
        if ($hovering) {
            # 有 Detail 就显示它。扇区那一格太窄（16 项时只有十来个汉字的宽度），
            # 图库的提示词/模型/分辨率根本放不下 —— hub 有将近两倍宽度，
            # 是唯一能把完整信息交代清楚的地方。
            $hovered = $items[$ring.Hover]
            $detail = [string]$hovered.Detail
            if ($detail) { $hubTitle = $detail } else { $hubTitle = [string]$hovered.Label }
            $hubSub = [string]$level.Title
        } else {
            $hubTitle = [string]$level.Title
            $hubSub = ''
        }

        if ($hubTitle) {
            # hub 文字只在悬停目标变化时才重新测量（其余情况缓存）
            $centerKey = "$($ring.Hover)|$hubTitle|$($a.hubTitleFontSize)|$([Math]::Round($scale, 2))"
            if (-not $ring.CenterFit -or $ring.CenterFit.Key -ne $centerKey) {
                $titleFont = $ring.FontHub
                $fitText = $hubTitle
                $avail = $hubR * 1.75
                $measured = $g.MeasureString($fitText, $titleFont)
                if ($measured.Width -gt $avail -and $measured.Width -gt 0) {
                    $ratio = $avail / $measured.Width
                    if ($ratio -lt 0.6) {
                        # 同扇区标签那个坑：$keep 不能小于 1、也不能超过字符串长度，
                        # 否则环带调细时 Substring 直接抛越界
                        $keep = [int][Math]::Floor($fitText.Length * $ratio)
                        if ($keep -ge $fitText.Length) { }
                        elseif ($keep -lt 1) { $fitText = $fitText.Substring(0, 1) + '…' }
                        else { $fitText = $fitText.Substring(0, $keep) + '…' }
                    } else {
                        $titleFont = Get-RingFont -Pixels ($a.hubTitleFontSize * $ratio)
                        if (-not $level.FitFonts) { $level.FitFonts = @() }
                        $level.FitFonts += $titleFont
                    }
                }
                $ring.CenterFit = @{ Key = $centerKey; Text = $fitText; Font = $titleFont }
            }
            $hubTitle = $ring.CenterFit.Text

            $hasSub = [bool]$hubSub
            $titleBrush = New-Object System.Drawing.SolidBrush($cc.text)
            if ($hasSub) {
                # 有副标题时，标题上移一点，两行一起居中
                $lineGap = $a.labelFontSize * $a.labelLineHeight
                $rect = New-Object System.Drawing.RectangleF(($cx - $hubR), ($cy - $hubR - $lineGap * 0.55), ($hubR * 2), ($hubR * 2))
            } else {
                $rect = New-Object System.Drawing.RectangleF(($cx - $hubR), ($cy - $hubR), ($hubR * 2), ($hubR * 2))
            }
            $g.DrawString($hubTitle, $ring.CenterFit.Font, $titleBrush, $rect, $format)
            $rect = $null
            $titleBrush.Dispose()

            if ($hasSub) {
                $subBrush = New-Object System.Drawing.SolidBrush($cc.textDim)
                $subRect = New-Object System.Drawing.RectangleF(($cx - $hubR), ($cy - $hubR + $a.labelFontSize * $a.labelLineHeight * 0.85), ($hubR * 2), ($hubR * 2))
                $g.DrawString($hubSub, $ring.FontSmall, $subBrush, $subRect, $format)
                $subRect = $null
                $subBrush.Dispose()
            }
        }
    }

    # ---- 推给分层窗口 ----
    $pushed = [Huanmeng.Win32]::PushBitmap($ring.Form.Handle, $ring.Bitmap, $ring.CenterX - $half, $ring.CenterY - $half)
    # 只在失败时记日志。动画期间这个方法每秒要跑三十多次，
    # 成功也记的话日志会被刷得没法看，真正的问题反而被埋掉。
    if (-not $pushed) {
        Write-Dbg "✗ 推送位图失败（窗口句柄 $($ring.Form.Handle)）—— 圆环会显示不出来"
    }
}

# 从当前主题派生出一套「面板配色」，给气泡窗和偏好设置用。
#
# 为什么是派生而不是再定义一张表：主题可能有十几套，每套再手写一遍
# 面板的六个颜色，迟早会漏掉一个、或者改了一处忘了另一处。
# 这里只按背景的明暗分深色/浅色两种，再从主题里取强调色 ——
# 面板和圆环是同一个色系，但对比关系是固定的那两套，不会出错。
function Get-UiPalette {
    $theme = Get-Theme $script:Cfg.appearance.theme
    # 用 wedgeFill 而不是 wedgeFillAlt：前者才是这个主题的主色，
    # 明暗判定（决定面板走深色还是浅色）要用主色才不会判错。
    $base = ConvertTo-Color $theme.wedgeFill 1.0

    # 感知亮度（人眼对绿最敏感、蓝最不敏感，所以不能简单取三者平均）
    $lum = (0.299 * $base.R + 0.587 * $base.G + 0.114 * $base.B) / 255.0
    $accent = ConvertTo-Color $theme.accent 1.0

    if ($lum -gt 0.5) {
        # 浅色主题：面板比环再白一档，分隔线用淡灰蓝
        return @{
            dark      = $false
            bg        = [System.Drawing.Color]::FromArgb(255, 243, 246, 250)
            surface   = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
            surfaceHi = [System.Drawing.Color]::FromArgb(255, 233, 238, 245)
            border    = [System.Drawing.Color]::FromArgb(255, 213, 220, 231)
            fg        = [System.Drawing.Color]::FromArgb(255, 27, 31, 39)
            dim       = [System.Drawing.Color]::FromArgb(255, 107, 116, 128)
            accent    = $accent
            good      = [System.Drawing.Color]::FromArgb(255, 22, 150, 105)
            bad       = [System.Drawing.Color]::FromArgb(255, 205, 55, 55)
            mineBg    = $accent
            mineFg    = [System.Drawing.Color]::White
            theirsBg  = [System.Drawing.Color]::FromArgb(255, 236, 240, 246)
            theirsFg  = [System.Drawing.Color]::FromArgb(255, 27, 31, 39)
        }
    }

    # 深色主题：面板比环底稍亮，才能从「洞」里浮出来
    return @{
        dark      = $true
        bg        = [System.Drawing.Color]::FromArgb(255, 22, 26, 34)
        surface   = [System.Drawing.Color]::FromArgb(255, 31, 37, 47)
        surfaceHi = [System.Drawing.Color]::FromArgb(255, 41, 49, 62)
        border    = [System.Drawing.Color]::FromArgb(255, 48, 58, 74)
        fg        = [System.Drawing.Color]::FromArgb(255, 232, 238, 247)
        dim       = [System.Drawing.Color]::FromArgb(255, 138, 150, 168)
        accent    = $accent
        good      = [System.Drawing.Color]::FromArgb(255, 96, 208, 150)
        bad       = [System.Drawing.Color]::FromArgb(255, 255, 122, 122)
        # 自己的话用强调色打底，和圆环的悬停色是同一个语言
        mineBg    = [System.Drawing.Color]::FromArgb(
            255,
            [Math]::Min(255, [int]($accent.R * 0.62 + 10)),
            [Math]::Min(255, [int]($accent.G * 0.62 + 10)),
            [Math]::Min(255, [int]($accent.B * 0.62 + 10)))
        mineFg    = [System.Drawing.Color]::FromArgb(255, 240, 245, 255)
        theirsBg  = [System.Drawing.Color]::FromArgb(255, 38, 45, 58)
        theirsFg  = [System.Drawing.Color]::FromArgb(255, 214, 224, 238)
    }
}

function ConvertTo-Color {
    param([string]$Hex, [double]$Alpha)

    if (-not $Hex) { $Hex = '#000000' }
    $Hex = $Hex.TrimStart('#')
    if ($Hex.Length -eq 3) {
        $Hex = '' + $Hex[0] + $Hex[0] + $Hex[1] + $Hex[1] + $Hex[2] + $Hex[2]
    }
    try {
        $r = [Convert]::ToInt32($Hex.Substring(0, 2), 16)
        $gr = [Convert]::ToInt32($Hex.Substring(2, 2), 16)
        $b = [Convert]::ToInt32($Hex.Substring(4, 2), 16)
    } catch {
        $r = 0; $gr = 0; $b = 0
    }
    # 0.0 / 1.0 必须写成带小数点的。
    # 写成 `[Math]::Min(1, $Alpha)` 的话，第一个参数是 int 字面量，
    # PowerShell 会挑 Min(int,int) 这个重载，把 0.96 **四舍五入成 1** ——
    # 结果就是「不透明度」这个设置永远等于 1，拖滑杆毫无反应。
    $clamped = [Math]::Max(0.0, [Math]::Min(1.0, $Alpha))
    $a = [int][Math]::Round($clamped * 255.0)
    return [System.Drawing.Color]::FromArgb($a, $r, $gr, $b)
}

# ---------- 命中测试 ----------

function Get-RingHitIndex {
    param([int]$ScreenX, [int]$ScreenY)

    # $script:RingHit 每画一帧就写一次，它存在就说明环已经画出来了 ——
    # 这就是「环在不在」的判据，别再拿 HalfSize 当门槛：
    # 那个值只在 Show-RingMenu 里赋值，而按住 Alt 右键直接弹环、
    # 或者层级切换后单独重绘的路径都不会经过它，加这道门槛只会误判成「环外」。
    if (-not $script:RingHit) { return -1 }
    $h = $script:RingHit

    $dx = $ScreenX - $script:Ring.CenterX
    $dy = $ScreenY - $script:Ring.CenterY
    $dist = [Math]::Sqrt($dx * $dx + $dy * $dy)

    # 上界带上 Pop：悬停扇区会向外弹出去那么远，弹出去的部分也得算在环里
    $reach = $h.Outer
    if ($h.ContainsKey('Pop')) { $reach = $h.Outer + $h.Pop }
    if ($dist -gt $reach) { return -1 }     # 环外 —— 点这里等于「关掉」
    if ($dist -lt $h.Inner) { return -2 }   # 中心圆盘 —— 不响应，防止误触

    $angle = [Math]::Atan2($dy, $dx) * 180.0 / [Math]::PI
    # 转到「以正上方为 0、顺时针为正」的坐标系
    $a = ($angle + 90.0) % 360.0
    if ($a -lt 0) { $a += 360.0 }

    $idx = [int][Math]::Floor($a / $h.Sweep)
    if ($idx -lt 0) { $idx = 0 }
    if ($idx -ge $h.Count) { $idx = $h.Count - 1 }
    return $idx
}

# ---------- 显示 / 隐藏 ----------

function Initialize-RingWindow {
    if ($script:Ring.Form) { return }

    $form = New-Object Huanmeng.LayeredForm
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.ShowInTaskbar = $false
    $form.TopMost = $true
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.NoActivate = $true
    $form.Text = '幻梦圆环'

    $script:Ring.Form = $form

    # 文字格式：全局一份，绘制时复用。
    # 之前每帧 New-Object 一次、画完 Dispose 一次 —— 每帧白白折腾一遍。
    $textFormat = New-Object System.Drawing.StringFormat
    $textFormat.Alignment = [System.Drawing.StringAlignment]::Center
    $textFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textFormat.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
    $script:Ring.TextFormat = $textFormat

    # 先把窗口建出来（Handle 一旦创建就固定），推一张全透明的进去。
    # 不做这一步的话，第一次 Show 会在屏幕上闪一下黑色的方框 ——
    # 分层窗口在收到第一张 UpdateLayeredWindow 之前是没有内容的。
    $form.Size = New-Object System.Drawing.Size(64, 64)
    $form.Show()
    $script:Ring.Visible = $false
    $blank = New-RingBitmap -Size 64
    $g = [System.Drawing.Graphics]::FromImage($blank)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.Dispose()
    [Huanmeng.Win32]::PushBitmap($form.Handle, $blank, -2000, -2000)
    $blank.Dispose()
    $form.Hide()
}

function Set-RingLevel {
    param($Level, [switch]$Reset)

    if ($Reset) { $script:Ring.Stack = @() }
    $script:Ring.Stack += $Level
    $script:Ring.Hover = -1
    Sync-RingWindowToLevel
}

# 层级换了 → 几何可能跟着变（扇区多的层会被撑大），窗口必须一起改。
#
# ⚠️ 不在 Set-RingLevel / Pop-RingLevel 里做这一步的话：进子菜单时环画大了、
# 窗口还是上一层的大小，**边缘直接被裁掉** —— 而且只在「项数比上一层多」的
# 时候才出现（预设分类 23 项 vs 顶层 6 项就是这种），最难查的一类。
#
# 顺带把圆心重新贴一次屏幕边界：环变大之后原来贴边的圆心会把环挤出屏幕外。
function Sync-RingWindowToLevel {
    $ring = $script:Ring
    if (-not $ring.Form) { return }

    $level = $null
    if ($ring.Stack.Count -gt 0) { $level = $ring.Stack[$ring.Stack.Count - 1] }
    $count = 0
    if ($level) { $count = @($level.Items).Count }

    $half = (Get-RingMetrics -ItemCount $count).Half
    if ($ring.HalfSize -eq $half -and $ring.Form.Width -eq ($half * 2)) { return }

    $x = $ring.CenterX
    $y = $ring.CenterY
    try {
        $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($x, $y)))
        $bounds = $screen.WorkingArea
        if ($x - $half -lt $bounds.Left)   { $x = $bounds.Left + $half }
        if ($x + $half -gt $bounds.Right)  { $x = $bounds.Right - $half }
        if ($y - $half -lt $bounds.Top)    { $y = $bounds.Top + $half }
        if ($y + $half -gt $bounds.Bottom) { $y = $bounds.Bottom - $half }
    } catch {
        # 拿不到屏幕信息就照原圆心放，不做贴边处理 —— 比什么都不显示强
    }

    $ring.CenterX = $x
    $ring.CenterY = $y
    $ring.HalfSize = $half
    $ring.Form.Size = New-Object System.Drawing.Size(($half * 2), ($half * 2))
    $ring.Form.Location = New-Object System.Drawing.Point(($x - $half), ($y - $half))
}

# 一个层级的文字测量缓存里可能新建过临时字体，随层级一起销毁。
# 条目的缓存存在条目上、字体记在 level.FitFonts 上 —— 层级没了，两者都没人要了。
function Dispose-RingLevelFit {
    param($Level)
    if ($Level -and $Level.FitFonts) {
        foreach ($f in @($Level.FitFonts)) { try { $f.Dispose() } catch { } }
        $Level.FitFonts = @()
    }
}

function Pop-RingLevel {
    if ($script:Ring.Stack.Count -le 1) { return $false }
    $popped = $script:Ring.Stack[$script:Ring.Stack.Count - 1]
    Dispose-RingLevelFit -Level $popped
    $script:Ring.Stack = $script:Ring.Stack[0..($script:Ring.Stack.Count - 2)]
    $script:Ring.Hover = -1
    $script:Ring.CenterFit = $null
    # 退回上一层时几何可能变小（撑大的那层没了），窗口要跟着收回来
    Sync-RingWindowToLevel
    return $true
}

function Show-RingMenu {
    param([int]$X = -1, [int]$Y = -1)

    Initialize-RingWindow
    Initialize-RingTimer

    if ($X -lt 0 -or $Y -lt 0) {
        $pos = Get-CursorPosition
        $X = $pos.X
        $Y = $pos.Y
    }

    # 贴边时把圆心往回推，否则圆环会有一半在屏幕外。
    # ⚠️ 这里的几何必须和 Draw-RingFrame 用**同一份**（都按当前层项数算），
    # 否则窗口尺寸和画出来的环对不上：窗口小了会把环裁掉一块，
    # 窗口大了边缘一片空白、点到空白处也会被当成「环内」。
    $level = $null
    if ($script:Ring.Stack.Count -gt 0) { $level = $script:Ring.Stack[$script:Ring.Stack.Count - 1] }
    $levelItemCount = 0
    if ($level) { $levelItemCount = @($level.Items).Count }

    $metrics = Get-RingMetrics -ItemCount $levelItemCount
    $half = $metrics.Half
    $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($X, $Y)))
    $bounds = $screen.WorkingArea
    if ($X - $half -lt $bounds.Left)   { $X = $bounds.Left + $half }
    if ($X + $half -gt $bounds.Right)  { $X = $bounds.Right - $half }
    if ($Y - $half -lt $bounds.Top)    { $Y = $bounds.Top + $half }
    if ($Y + $half -gt $bounds.Bottom) { $Y = $bounds.Bottom - $half }

    $ring = $script:Ring
    $ring.CenterX = $X
    $ring.CenterY = $Y
    $ring.HalfSize = $half
    $ring.Hover = -1
    $ring.Theme = Get-Theme $script:Cfg.appearance.theme

    if ($ring.Font) { $ring.Font.Dispose() }
    if ($ring.FontSmall) { $ring.FontSmall.Dispose() }
    if ($ring.SectorFont) { $ring.SectorFont.Dispose(); $ring.SectorFont = $null }
    # 三档字体：扇区标签 / hub 副标题 / hub 标题（都跟配置走）
    $ring.Font = Get-RingFont -Pixels $script:Cfg.appearance.labelFontSize
    $ring.FontSmall = Get-RingFont -Pixels $script:Cfg.appearance.hubSubFontSize
    $ring.FontHub = Get-RingFont -Pixels $script:Cfg.appearance.hubTitleFontSize
    # 扇区字体由 Draw-RingFrame 按当前项数重建（项数变了字号就要跟着变），
    # 这里只清掉缓存的比对键，逼它重算一次。
    $ring.SectorFontKey = ''

    $ring.AnimStart = Get-Date
    $ring.Visible = $true

    $ring.Form.Size = New-Object System.Drawing.Size(($half * 2), ($half * 2))
    $ring.Form.Location = New-Object System.Drawing.Point(($X - $half), ($Y - $half))
    if (-not $ring.Form.Visible) { $ring.Form.Show() }

    $ring.WasDown = $false
    Draw-RingFrame

    if (-not $script:RingTimer.Enabled) { $script:RingTimer.Start() }
    Push-RingStateHint

    Write-Dbg "圆环弹出：圆心 $X,$Y  窗口 $($ring.Form.Left),$($ring.Form.Top) 大小 $($ring.Form.Width)x$($ring.Form.Height)  可见=$($ring.Form.Visible)  层级项数=$(@($level.Items).Count)"
}

function Hide-RingMenu {
    param([string]$Reason = '未说明')

    $ring = $script:Ring
    if (-not $ring.Visible) { return }
    Write-Dbg "圆环收起：$Reason"

    $ring.Visible = $false
    foreach ($lvl in @($ring.Stack)) { Dispose-RingLevelFit -Level $lvl }
    $ring.Stack = @()
    $ring.Hover = -1
    $ring.AnimStart = $null
    $ring.CenterFit = $null
    # 扇区字体是按「当前项数」现建的，收起来就没人用了 —— 必须放掉。
    # 每开一次菜单泄漏一个 Font 对象，挂机一整天 GDI 句柄会慢慢涨上去。
    if ($ring.SectorFont) { try { $ring.SectorFont.Dispose() } catch { } }
    $ring.SectorFont = $null
    $ring.SectorFontKey = ''
    if ($script:RingTimer) { $script:RingTimer.Stop() }
    if ($ring.Form -and $ring.Form.Handle -ne [IntPtr]::Zero) {
        # 推到屏幕外而不是 Hide()：Hide/Show 每次都重建可见性状态，
        # 在 Photoshop 这种重绘频繁的宿主上会闪。挪走是最干净的做法。
        $blank = New-RingBitmap -Size 64
        $g = [System.Drawing.Graphics]::FromImage($blank)
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.Dispose()
        [Huanmeng.Win32]::PushBitmap($ring.Form.Handle, $blank, -4000, -4000)
        $blank.Dispose()
        $ring.Form.Hide()
    }
    if ($script:Ring.OnClose) { & $script:Ring.OnClose }
}

function Push-RingStateHint {
    # 圆环开着 = 「Alt 右键那一招」正在被使用，状态文件里如实反映
    if ($script:PushStatus) { & $script:PushStatus }
}

# ---------- 激活 ----------

function Invoke-RingActivate {
    param([int]$Index)

    $ring = $script:Ring
    if (-not $ring.Visible) { return }
    $level = $ring.Stack[$ring.Stack.Count - 1]
    $items = @($level.Items)
    if ($Index -lt 0 -or $Index -ge $items.Count) {
        Hide-RingMenu -Reason "左键点在扇区外（命中值 $Index）"
        return
    }

    $item = $items[$Index]

    # 禁用项不执行，也不收起圆环 —— 收起会让人以为是「点了但没反应」，
    # 留在原地 + 一句提示，用户才知道是「现在用不了」。
    if ($item.Disabled) {
        if ($script:Notify) { & $script:Notify ([string]$item.DisabledHint) 'warn' }
        return
    }

    if ($item.HasChildren) {
        # Children 是描述符，交给 Menu.ps1 解析成真正的层级。
        # 解出来可能是 @{Title;Items} 也可能直接是一组 Items，两种都认。
        $resolved = Resolve-MenuChildren -Children $item.Children
        if ($null -eq $resolved) {
            if ($script:Notify) { & $script:Notify '这一项点不开' 'warn' }
            return
        }
        if ($resolved -is [hashtable] -and $resolved.ContainsKey('Items')) {
            $level = @{ Title = [string]$resolved.Title; Items = @($resolved.Items) }
        } else {
            $level = @{ Title = $item.Label; Items = @($resolved) }
        }
        if (@($level.Items).Count -eq 0) {
            if ($script:Notify) { & $script:Notify '这一项是空的' 'warn' }
            return
        }
        Set-RingLevel $level
        Draw-RingFrame
        return
    }

    # 动作先收起圆环再执行。**顺序很重要**：执行可能要弹输入框、
    # 发网络请求或者给 Photoshop 发指令，圆环留在屏幕上会盖住它们。
    $action = $item.Action
    $payload = $item.Payload
    Hide-RingMenu -Reason "执行动作 $action"

    if ($ring.OnAction -and $action) {
        # 动作执行链很长（可能开气泡、发网络请求、给 PS 发指令），
        # 任何一环抛异常都不能把整个助手带走
        try {
            & $ring.OnAction $action $payload
        } catch {
            Write-CrashLog "动作 $action 执行异常: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
            if ($script:Notify) { & $script:Notify "操作出错：$($_.Exception.Message)" 'error' }
        }
    }
}

function Invoke-RingBack {
    if (Pop-RingLevel) {
        Draw-RingFrame
    } else {
        Hide-RingMenu -Reason '返回上一级时已在顶层'
    }
}

# ---------- 轮询 ----------

function Update-RingTick {
    $ring = $script:Ring
    if (-not $ring.Visible) { return }

    $pos = Get-CursorPosition
    $idx = Get-RingHitIndex -ScreenX $pos.X -ScreenY $pos.Y
    if ($idx -eq -2) { $idx = -1 }   # 中心圆盘不参与悬停高亮

    $dirty = $false

    if ($script:Cfg.interaction.hoverHighlight) {
        if ($idx -ne $ring.Hover) {
            $ring.Hover = $idx
            $dirty = $true
        }
    }

    # 弹出动画期间每帧都要重画
    if ($script:Cfg.appearance.animation -and $ring.AnimStart) {
        $elapsed = ((Get-Date) - $ring.AnimStart).TotalMilliseconds
        if ($elapsed -lt 130) { $dirty = $true }
    }

    if ($dirty) { Draw-RingFrame }

    # 光标在不在圆环的方框里。
    #
    # **这个判断不能省。** 鼠标是全局轮询的，不设范围的话，用户在屏幕
    # 另一头点任何东西都会把圆环收掉 —— 实测踩过：圆环弹出 4 秒后，
    # 用户在右下角点了一下托盘，圆环就没了，看起来像「自己闪退了」。
    # 圆环的方框之内才算它的地盘，框外的一律当没看见。
    #
    # 方框按**环的真实外沿**算，不是画布尺寸。画布为了给悬停弹出留白会比环大一圈
    # （弹出距离调到 30 时大出三十几像素），拿画布当范围的话，环外面那圈空白
    # 也成了「圆环的地盘」—— 用户在那儿随手一点就把环收掉了，像自己闪退。
    $reach = [double]$ring.HalfSize
    if ($script:RingHit) { $reach = [double]$script:RingHit.Outer + [double]$script:RingHit.Pop }
    $inside = ($pos.X -ge ($ring.CenterX - $reach)) -and ($pos.X -le ($ring.CenterX + $reach)) -and
              ($pos.Y -ge ($ring.CenterY - $reach)) -and ($pos.Y -le ($ring.CenterY + $reach))

    # 左键：按下沿触发（轮询只能看到「现在是按下」，
    # 所以自己记上一次的状态来做边沿检测）
    $down = ([Huanmeng.Win32]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
    if ($down -and -not $ring.WasDown) {
        $ring.WasDown = $true
        if ($inside) {
            Write-Dbg "左键按下：命中扇区 $idx（光标 $($pos.X),$($pos.Y) 圆心 $($ring.CenterX),$($ring.CenterY)）"
            Invoke-RingActivate -Index $idx
            return
        }
        # 起点在框外 —— 整个这次点击都不属于圆环，别在拖进来松手时误触发
        Write-Dbg "左键按在圆环之外，忽略（光标 $($pos.X),$($pos.Y)）"
    }
    if (-not $down) { $ring.WasDown = $false }

    # 右键：只在圆环上按才收起。圆环之外按右键是用户自己的右键菜单，
    # 不该被我们搅掉。
    $rightDown = ([Huanmeng.Win32]::GetAsyncKeyState(0x02) -band 0x8000) -ne 0
    if ($rightDown -and $inside) { Hide-RingMenu -Reason '在圆环上按了右键' }
}

# ---------- 键盘 ----------
# 返回 $true 表示这个键被圆环吃掉了，钩子里不要再传给系统。

function Invoke-RingKey {
    param([int]$Vk)

    if (-not $script:Ring.Visible) { return $false }

    $cfg = $script:Cfg.interaction

    if ($Vk -eq [Huanmeng.Win32]::VK_ESCAPE) {
        if (-not $cfg.escClose) { return $false }
        # Esc 先退一级，已经在第一级才整个关掉 —— 和 macOS 版一致
        if ($script:Ring.Stack.Count -gt 1) { Invoke-RingBack } else { Hide-RingMenu -Reason '按了 Esc' }
        return $true
    }

    if ($Vk -eq [Huanmeng.Win32]::VK_LEFT -or $Vk -eq [Huanmeng.Win32]::VK_BACK -or $Vk -eq [Huanmeng.Win32]::VK_DELETE) {
        Invoke-RingBack
        return $true
    }

    if ($cfg.numberKeys -and $Vk -ge 0x31 -and $Vk -le 0x39) {
        $index = $Vk - 0x31
        $level = $script:Ring.Stack[$script:Ring.Stack.Count - 1]
        if ($index -lt @($level.Items).Count) {
            Invoke-RingActivate -Index $index
            return $true
        }
        return $true   # 越界的数字键也吞掉，别让它漏到 Photoshop 里去
    }

    return $false
}

function Initialize-RingTimer {
    if ($script:RingTimer) { return }
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 30
    $timer.Add_Tick({
        # 一帧画坏了不应该带走整个进程。
        # 这个 tick 是圆环最忙的代码路径（轮询 + 重绘），
        # 全局 ThreadException 是最后一道防线，这里是第一道。
        try { Update-RingTick } catch {
            Write-CrashLog "圆环 tick 异常: $($_.Exception.Message)"
        }
    })
    $script:RingTimer = $timer
}
