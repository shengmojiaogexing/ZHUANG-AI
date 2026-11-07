# ============================================================
#  Config.ps1 — 配置读写
#
#  配置文件刻意沿用 macOS 版的文件名 ~/.huanmeng-ring.json，
#  两份配置互相拷贝就能用（Windows 上就是 %USERPROFILE%\.huanmeng-ring.json）。
#
#  设计原则：**读配置永远不抛异常**。
#  配置坏掉、被手改错、某个键缺失，都退回归默认值继续跑 ——
#  一个改错的配色不该让整个助手起不来。
# ============================================================

$script:ConfigPath  = Join-Path $env:USERPROFILE '.huanmeng-ring.json'
$script:PresetPath  = Join-Path $env:USERPROFILE '.huanmeng-presets.json'
$script:StatusPath  = Join-Path $env:USERPROFILE '.huanmeng-ring-status.json'
# 图库索引。单独一个文件而不是塞进配置里：配置是给人手改的，
# 图库是机器写的、还会随出图不断变长，混在一起的结果是
# 每出一张图就重写一遍用户正在编辑的那份配置。
$script:GalleryPath = Join-Path $env:USERPROFILE '.huanmeng-gallery.json'

function Get-ConfigPath   { return $script:ConfigPath }
function Get-PresetPath   { return $script:PresetPath }
function Get-StatusPath   { return $script:StatusPath }
function Get-GalleryPath  { return $script:GalleryPath }

# ---------- 调试日志 ----------
# 用 --debug 启动才会写。托盘程序没有控制台，出问题时「圆环闪一下就没了」
# 这类现象没法从外面观察 —— 只能让程序自己把关键决策记下来。
# 日志会记录「谁把圆环收起来的」，这一条排掉了绝大部分「圆环不显示」的报障。
$script:DebugEnabled = $false
$script:DebugLogPath = Join-Path $env:TEMP 'huanmeng-ring-debug.log'
$script:CrashLogPath = Join-Path $env:TEMP 'huanmeng-ring-crash.log'

function Write-Dbg {
    param([string]$Text)

    if (-not $script:DebugEnabled) { return }
    try {
        $stamp = (Get-Date).ToString('HH:mm:ss.fff')
        [System.IO.File]::AppendAllText($script:DebugLogPath, "$stamp  $Text`r`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# 崩溃日志：**常开**，不依赖 --debug。
# 托盘程序没有控制台，进程如果被某个事件回调里的异常带崩，
# 用户只会看到「图标没了」，完全无从查起。这里记录一切「差一点就崩掉」的异常。
function Write-CrashLog {
    param([string]$Text)

    try {
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
        [System.IO.File]::AppendAllText($script:CrashLogPath, "$stamp  $Text`r`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# ---------- 配色主题 ----------
#
# key 是配置里存的值，label 是偏好设置下拉里显示的。
#
# 每个字段用在哪：
#  键名和 macOS 版**逐字对齐**（从 .app 二进制里提取的真实键名），
#  这样两边的主题定义可以互相照搬，配置也能通用：
#
#   wedgeFill / wedgeFillAlt  扇区填充 + 交替填充（相邻扇区深浅交错，做出扇贝感）
#   wedgeEdge                 扇区分隔线（环里的「辐条」）
#   hoverFill / hoverEdge     悬停扇区的填充 / 外缘
#   hubFill / hubEdge         中心圆盘（hub）的填充 / 描边
#   textColor / textDim / textFaint   正文 / 次要 / 最弱文字
#   accent                    品牌色。托盘图标、滑杆、辉光用它
#
# 加主题时的自检：textColor 在 wedgeFill 上要看得清，悬停时的文字也要看得清。
$script:Themes = [ordered]@{
    'midnight' = @{
        label = '午夜蓝'
        wedgeFill = '#121A2A'; wedgeFillAlt = '#0E1420'; wedgeEdge = '#25314A'
        hoverFill = '#2E6BE6'; hoverEdge = '#7FAEFF'
        hubFill = '#0C1220'; hubEdge = '#26324A'
        textColor = '#E8EEF7'; textDim = '#7A879C'; textFaint = '#4A5A75'
        accent = '#4D86FF'
    }
    'slate' = @{
        label = '青灰'
        wedgeFill = '#1E2228'; wedgeFillAlt = '#191C21'; wedgeEdge = '#323842'
        hoverFill = '#2C77D0'; hoverEdge = '#8CC4FF'
        hubFill = '#171A1F'; hubEdge = '#31363F'
        textColor = '#E4E7EB'; textDim = '#8B939E'; textFaint = '#5A626D'
        accent = '#5AA9FF'
    }
    'graphite' = @{
        label = '石墨灰'
        wedgeFill = '#1B1C21'; wedgeFillAlt = '#161719'; wedgeEdge = '#2E3036'
        hoverFill = '#E9EAEE'; hoverEdge = '#FFFFFF'
        hubFill = '#141517'; hubEdge = '#2C2E34'
        textColor = '#EDEDEF'; textDim = '#8A8A8E'; textFaint = '#5A5A5E'
        accent = '#C9CBD1'
    }
    'violet' = @{
        label = '深空紫'
        wedgeFill = '#1A1226'; wedgeFillAlt = '#150F1F'; wedgeEdge = '#2E2244'
        hoverFill = '#7A4BDC'; hoverEdge = '#C6AAFF'
        hubFill = '#130D1C'; hubEdge = '#2C2140'
        textColor = '#EFE9FA'; textDim = '#8B7BA8'; textFaint = '#5A4A73'
        accent = '#9B6BFF'
    }
    'ember' = @{
        label = '暖焰橙'
        wedgeFill = '#241811'; wedgeFillAlt = '#1F150E'; wedgeEdge = '#3E2C1E'
        hoverFill = '#E0701C'; hoverEdge = '#FFBB7A'
        hubFill = '#1B120B'; hubEdge = '#3A2A1E'
        textColor = '#FBEDE1'; textDim = '#A08268'; textFaint = '#6E5842'
        accent = '#FF8A3D'
    }
    'jade' = @{
        label = '青玉绿'
        wedgeFill = '#0F2019'; wedgeFillAlt = '#0C1A16'; wedgeEdge = '#1F362C'
        hoverFill = '#1C9A70'; hoverEdge = '#6FE3BA'
        hubFill = '#0A1714'; hubEdge = '#1E332C'
        textColor = '#E3F5EE'; textDim = '#6E9587'; textFaint = '#47685C'
        accent = '#2FBF8F'
    }
    'sakura' = @{
        label = '樱粉'
        wedgeFill = '#241820'; wedgeFillAlt = '#1E1418'; wedgeEdge = '#3C2630'
        hoverFill = '#E2548A'; hoverEdge = '#FFA8C8'
        hubFill = '#1A1116'; hubEdge = '#38222B'
        textColor = '#FCEAF0'; textDim = '#A6828F'; textFaint = '#6E525C'
        accent = '#FF6EA0'
    }
    'paper' = @{
        label = '素白'
        wedgeFill = '#FFFFFF'; wedgeFillAlt = '#F2F5FA'; wedgeEdge = '#D9E0EA'
        hoverFill = '#2F6BFF'; hoverEdge = '#2F6BFF'
        hubFill = '#F7F9FC'; hubEdge = '#D9E0EA'
        textColor = '#1B1F27'; textDim = '#6B7480'; textFaint = '#9AA3AF'
        accent = '#2F6BFF'
    }
}

function Get-ThemeNames { return @($script:Themes.Keys) }
function Get-ThemeLabel($key) {
    if ($script:Themes.Contains($key)) { return $script:Themes[$key].label }
    return $script:Themes['midnight'].label
}
function Get-Theme($key) {
    if ($script:Themes.Contains($key)) { return $script:Themes[$key] }
    return $script:Themes['midnight']
}

# ---------- 默认配置 ----------

function Get-DefaultConfig {
    return @{
        api = @{
            grsApiKey    = ''
            grsRegion    = 'domestic'      # domestic = grsai.dakka.com.cn
            imgModel     = 'nano-banana-fast'
            imageSize    = '1K'            # 1K / 2K / 4K
            imageCount   = 1
            aspectRatio  = 'auto'
            chatModel    = 'grs/gpt-5.5'
            chatModels   = @()
            systemPrompt = ''
            outputFolder = ''              # 留空 = 图片\幻梦AI
        }
        # 键名和 macOS 版 RingAppearance / RingGeometry / RingPalette 对齐
        appearance = @{
            # ---- 几何 ----
            outerRadius = 150        # 外半径（像素）
            bandRatio   = 0.41       # 环带厚度 = outerRadius × bandRatio
            # 扇区间隙按**比例**算，再夹一个角度上限。
            # 固定角度在不同扇区数下观感差很多：6 个扇区时 4° 刚好，
            # 12 个子菜单项时 4° 会把环切得稀碎 —— 比例制才不会。
            gapRatio    = 0.07
            gapMax      = 6
            popDistance = 6          # 悬停扇区向外弹出的距离（像素）

            # ---- 样式 ----
            opacity       = 0.96     # 0.3 – 1.0
            shadowEnabled = $true
            shadowBlur    = 14       # 投影扩散范围
            shadowOffsetY = 6        # 投影下移
            shadowAlpha   = 0.35     # 投影浓度
            animation     = $true
            appearScale   = 0.86     # 弹出动画的起始缩放（1.0 = 不做缩放动画）

            # ---- 内容 ----
            labelFontSize     = 13
            labelLineHeight   = 1.25
            hubTitleFontSize  = 15   # 中心标题
            hubSubFontSize    = 11   # 中心副标题（当前层级 / 提示）
            showChildMarker   = $true   # 有子菜单的扇区显示 ›
            showDirectionLine = $true   # 从中心指向悬停扇区的指示线

            # ---- 禁用态 ----
            disabledWedgeAlpha = 0.35
            disabledEdgeAlpha  = 0.30

            theme = 'midnight'
        }
        interaction = @{
            hotkey            = 'ctrl+alt+r'
            altRightClick     = $true
            altRightClickScope = 'photoshop'   # photoshop / global / off
            hoverHighlight    = $true
            numberKeys        = $true
            escClose          = $true
            guideLines        = $true
        }
        # 语音输入（完全本地，走 Windows 自带的识别引擎，不联网不要密钥）
        speech = @{
            enabled    = $true
            hotkey     = 'ctrl+alt+space'   # 按住说话，松开出字；被占用时自动换候选
            # 置信度门槛 0–1。低于它的识别结果直接丢掉 ——
            # 宁可这次什么都没听出来，也不要把环境噪音变成一句胡话塞进输入框
            confidence = 0.35
        }
        content = @{
            # 顺序 = 顺时针从正上方开始
            # gallery 排在 close 之前 —— 迁移逻辑也是往 close 前插，
            # 两边一致，新装用户和老用户升级后看到的顺序才一样
            order   = @('generate', 'params', 'presets', 'chat', 'readSelection', 'gallery', 'close')
            # 在圆环上选中一个预设之后干什么。
            #   both      = 复制到剪贴板 **并且** 套用到插件（默认）
            #   clipboard = 只复制到剪贴板，用户自己去粘
            #   apply     = 只套用（以前的行为）
            # 默认 both 是用户自己选的：两种用法都有 ——
            # 有时要粘到别处，有时就想直接出图。
            presetAction = 'both'
            # 依赖 Photoshop 的扇区在插件离线时**整个收起来**（不是置灰）。
            # 灰项在「当独立 app 用」的场景下是纯噪音：点了没用，还占一格。
            # 想退回置灰就把这个关掉。
            hideUnavailable = $true
            sectors = @{
                generate      = @{ label = '生成';   action = 'generate';      visible = $true }
                params        = @{ label = '参数';   action = 'params';        visible = $true }
                presets       = @{ label = '预设';   action = 'presets';       visible = $true }
                chat          = @{ label = '对话';   action = 'chatMenu';      visible = $true }
                readSelection = @{ label = '读选区'; action = 'readSelection'; visible = $true }
                gallery       = @{ label = '图库';   action = 'gallery';       visible = $true }
                close         = @{ label = '关闭';   action = 'close';         visible = $true }
            }
        }
        # 出图历史。图片本体在出图目录里，这里只管保留策略。
        gallery = @{
            enabled     = $true
            # count = 按张数 / days = 按天数 / both = 两个都用 / off = 不自动清理
            mode        = 'count'
            maxCount    = 200
            maxDays     = 90
            # **默认关。** 打开它之后清理会真的删掉图片文件 ——
            # 那是用户的作品，不是我们的缓存，删除必须是显式选择。
            deleteFiles = $false
            adoptOnOpen = $true     # 首次启动把出图目录里已有的旧图收进来
            maxAdopt    = 500       # 单次收编上限
            recentLimit = 16        # 圆环里「最近」铺几项（16 是扇区宽度的上限）
            sweepTemp   = $true     # 顺手清 %TEMP% 里三种中间产物
        }
        # 一行一条：标题=提示词。空 = 用内置那 6 条
        chatQuestions = ''
        port          = 8799
    }
}

# ---------- 深合并 ----------
# 把用户配置覆盖到默认值上。**逐层合并**而不是整块替换：
# 以后加一个新键，老配置文件不会因为缺这个键就丢掉默认值。
function Merge-Hashtable {
    param($Base, $Override)

    if ($null -eq $Override) { return $Base }
    if ($Base -isnot [hashtable] -and $Base -isnot [System.Collections.IDictionary]) { return $Override }
    if ($Override -isnot [hashtable] -and $Override -isnot [System.Collections.IDictionary]) { return $Override }

    foreach ($key in $Override.Keys) {
        $value = $Override[$key]
        if ($Base.Contains($key) -and ($Base[$key] -is [hashtable]) -and ($value -is [hashtable])) {
            $Base[$key] = Merge-Hashtable -Base $Base[$key] -Override $value
        } else {
            $Base[$key] = $value
        }
    }
    return $Base
}

# ConvertFrom-Json 出来的是 PSCustomObject，递归转成 hashtable 才好合并
function ConvertTo-HashtableDeep {
    param($InputObject)

    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $out = @{}
        foreach ($key in $InputObject.Keys) { $out[$key] = ConvertTo-HashtableDeep $InputObject[$key] }
        return $out
    }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $out = @{}
        foreach ($prop in $InputObject.PSObject.Properties) { $out[$prop.Name] = ConvertTo-HashtableDeep $prop.Value }
        return $out
    }
    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        $list = @()
        foreach ($item in $InputObject) { $list += ,(ConvertTo-HashtableDeep $item) }
        # 前面的逗号不能省。PowerShell 的函数是靠管道返回值的，
        # `return @()` 会被枚举成「零个对象」，调用方拿到的是 $null ——
        # 空数组就这么在往返过程中变成了「不是数组」。
        # 配置里的空数组被写成 `{}`、读回来变成哈希表，就是这么来的。
        # `,$list` 用一层单元素数组把它包住，管道枚举掉外层后正好剩下原数组。
        return ,$list
    }
    return $InputObject
}

# 把配置里「应该是字符串数组」的字段强制掰回来。
#
# 为什么需要它：配置是用户能手改的 JSON，还可能是旧版本写的。
# 那个字段可能是 null、可能是单个字符串、可能是空对象 {} （见上面 ConvertTo-HashtableDeep
# 的注释）、也可能是正经数组。业务代码不该为每一种都写一遍判断。
function ConvertTo-StringList {
    param($Value)

    if ($null -eq $Value) { return ,@() }
    if ($Value -is [string]) {
        if ($Value.Trim()) { return ,@($Value) }
        return ,@()
    }
    # 空对象 {} 读进来是哈希表 —— 那不是数组，当空的处理
    if ($Value -is [System.Collections.IDictionary]) { return ,@() }
    if ($Value -is [System.Collections.IEnumerable]) {
        $out = @()
        foreach ($item in $Value) {
            $text = [string]$item
            if ($text) { $out += $text }
        }
        return ,$out
    }
    return ,@()
}

# 配置里的布尔值也可能是手改出来的字符串。"false" 在 PowerShell 里是**真值**
# （非空字符串），直接 [bool] 会把它读成 true —— 于是用户在配置文件里
# 明明写了 false，行为却是开着的，而且从哪儿都看不出来为什么。
function Get-BoolValue {
    param($Value, [bool]$Default = $false)

    if ($null -eq $Value) { return $Default }
    if ($Value -is [bool]) { return $Value }

    $text = "$Value".Trim()
    if ($text -match '^(?i)(true|1|yes|on|是|开)$')  { return $true }
    if ($text -match '^(?i)(false|0|no|off|否|关)$') { return $false }
    return $Default
}

# 容错的整数夹取。
#
# **不要直接写 [int]$Value。** 用户在配置文件里手打一个 "maxCount": "两百"，
# [int]'两百' 在 PS 5.1 里会**抛异常**，而 Get-Config 跑在启动路径上，
# 还被每 2 秒一次的配置热重载调着 —— 抛一次助手就直接起不来了。
function Get-ClampedInt {
    param($Value, [int]$Min, [int]$Max, [int]$Default)

    $n = $Default
    try {
        if ($null -ne $Value -and "$Value".Trim()) { $n = [int]$Value }
    } catch {
        $n = $Default
    }
    if ($n -lt $Min) { $n = $Min }
    if ($n -gt $Max) { $n = $Max }
    return $n
}

# 老配置里的扇区顺序补齐。
#
# **为什么非得有这一步**：content.order 是个**数组**，而 Merge-Hashtable
# 只在「两边都是哈希表」时才递归合并，数组是整块覆盖的。于是新版本加的
# 扇区永远进不了老用户的圆环 —— 配置里没有这个 id，代码里也不报错，
# 圆环上就是少一块，从任何地方都看不出是版本升级没生效。
#
# 迁移只补「默认里有、用户配置里压根没有」的，并且插到「关闭」之前。
function Merge-SectorOrder {
    param($Saved, $Default)

    $defaultOrder = ConvertTo-StringList $Default.content.order
    $result = @{ Order = $defaultOrder; Changed = $false }

    if ($null -eq $Saved -or $Saved -isnot [System.Collections.IDictionary]) { return $result }

    # content 整段可能是手改坏的字符串或者数组。.Contains() 在那种东西上
    # 会直接抛，而这段跑在启动路径上 —— 抛了助手就起不来。
    $savedContent = $Saved['content']
    if ($null -eq $savedContent -or $savedContent -isnot [System.Collections.IDictionary]) { return $result }
    if (-not $savedContent.Contains('order')) { return $result }

    $savedOrder = ConvertTo-StringList $savedContent['order']
    if ($savedOrder.Count -eq 0) { return $result }

    # **判据是「order 和 sectors 里都没有这个 id」，不是 visible。**
    #
    # 用户可能只是把某个扇区关掉了（Set-SectorVisible 只改 visible、
    # 不移出 order），拿 visible 当判据会把人家故意关掉的扇区又打开。
    #
    # 而「sectors 里有定义、order 里却没有」是另一种情况：用户手改配置
    # 把它从顺序里摘掉了，那是明确的不想要，得尊重。
    # 只有**两处都找不到**，才说明这份配置是旧版本写的、压根不认识它。
    $savedSectors = $savedContent['sectors']
    $hasSectors = ($savedSectors -is [System.Collections.IDictionary])

    $missing = @()
    foreach ($id in $defaultOrder) {
        if ($savedOrder -contains $id) { continue }
        if ($hasSectors -and $savedSectors.Contains($id)) { continue }
        $missing += $id
    }
    if ($missing.Count -eq 0) { return $result }

    $closeAt = [Array]::IndexOf($savedOrder, 'close')
    if ($closeAt -le 0) {
        # close 在第一位、或者压根没有 close —— 插到最前面。
        # **注意 closeAt = 0 时绝不能走下面那个切片分支**：
        # $savedOrder[0..-1] 在 PowerShell 里是 @(0, -1)，反向索引会取到末尾元素，
        # 拼出来的 order 里就会混进一个 $null。
        $out = @($missing) + @($savedOrder)
    } else {
        $out = @($savedOrder[0..($closeAt - 1)]) + @($missing) + @($savedOrder[$closeAt..($savedOrder.Count - 1)])
    }

    return @{ Order = $out; Changed = $true }
}

# ---------- 读 ----------

function Read-JsonFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        # 显式按 UTF-8 读。PS 5.1 的 Get-Content 默认走 ANSI，
        # 中文提示词会变成乱码 —— 这个坑踩过一次就够了。
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ConvertTo-HashtableDeep (ConvertFrom-Json $raw)
    } catch {
        return $null
    }
}

function Get-Config {
    $default = Get-DefaultConfig
    $saved = Read-JsonFile $script:ConfigPath
    if ($null -eq $saved) { return $default }

    # 旧版外观键 → 新版（macOS 对齐）键名的迁移。
    # 老配置里是 radius/thickness/gap/fontSize/shadow，新版拆成了
    # outerRadius/bandRatio/gapRatio/labelFontSize/shadowEnabled。
    # 直接换名字等于把用户调好的外观全清空 —— 这里做一次等效换算。
    if ($null -ne $saved.appearance) {
        $old = $saved.appearance
        $migrated = @{}
        if ($old.Contains('radius') -and -not $old.Contains('outerRadius')) {
            $migrated['outerRadius'] = $old['radius']
            if ($old.Contains('thickness') -and [double]$old['radius'] -gt 0) {
                $migrated['bandRatio'] = [Math]::Round([double]$old['thickness'] / [double]$old['radius'], 3)
            }
        }
        if ($old.Contains('fontSize') -and -not $old.Contains('labelFontSize')) {
            $migrated['labelFontSize'] = $old['fontSize']
        }
        if ($old.Contains('shadow') -and -not $old.Contains('shadowEnabled')) {
            $migrated['shadowEnabled'] = $old['shadow']
        }
        if ($migrated.Count -gt 0) {
            foreach ($k in $migrated.Keys) { $saved.appearance[$k] = $migrated[$k] }
        }
    }

    # 扇区顺序补齐。必须在 Merge-Hashtable **之前**对 $saved 动手 ——
    # 合并之后 $saved 里的数组已经把默认值盖掉了，再改也来不及。
    $orderFix = Merge-SectorOrder -Saved $saved -Default $default
    if ($orderFix.Changed) { $saved['content']['order'] = $orderFix.Order }

    # 落盘的文件缺段吗？缺的话下面合并完要补写回去。
    #
    # 自检里那句「菜单栏 ◎ → 打开配置文件 → 填 api.grsApiKey」只在
    # 文件**真的有** api 段时才成立。而偏好设置保存的是增量、从旧版升上来的
    # 文件也常缺段 —— 用户打开只看得到 interaction 一行，
    # 根本不知道键名该写什么，那条提示就成了空话。
    $needsFill = Test-ConfigIncomplete -Saved $saved -Canonical $default
    # 迁移过的东西也必须落盘。不落的话用户打开配置文件根本找不到
    # 「图库」这一行 —— 每次启动都在内存里补一遍，外面一点痕迹都没有。
    if ($orderFix.Changed) { $needsFill = $true }

    $merged = Merge-Hashtable -Base $default -Override $saved

    # 合并完再夹一次范围。手改配置文件写个 outerRadius=99999 不该画出个占满屏的环。
    $a = $merged.appearance
    $a.outerRadius     = [Math]::Max(80,   [Math]::Min(400,  [int]$a.outerRadius))
    $a.bandRatio       = [Math]::Max(0.15, [Math]::Min(0.72, [double]$a.bandRatio))
    $a.gapRatio        = [Math]::Max(0.0,  [Math]::Min(0.5,  [double]$a.gapRatio))
    $a.gapMax          = [Math]::Max(0.0,  [Math]::Min(20.0, [double]$a.gapMax))
    $a.popDistance     = [Math]::Max(0,    [Math]::Min(30,   [int]$a.popDistance))
    $a.opacity         = [Math]::Max(0.3,  [Math]::Min(1.0,  [double]$a.opacity))
    $a.shadowBlur      = [Math]::Max(0,    [Math]::Min(40,   [int]$a.shadowBlur))
    $a.shadowOffsetY   = [Math]::Max(-20,  [Math]::Min(30,   [int]$a.shadowOffsetY))
    $a.shadowAlpha     = [Math]::Max(0.0,  [Math]::Min(0.9,  [double]$a.shadowAlpha))
    $a.appearScale     = [Math]::Max(0.5,  [Math]::Min(1.0,  [double]$a.appearScale))
    $a.labelFontSize   = [Math]::Max(9,    [Math]::Min(28,   [int]$a.labelFontSize))
    $a.labelLineHeight = [Math]::Max(0.9,  [Math]::Min(2.5,  [double]$a.labelLineHeight))
    $a.hubTitleFontSize = [Math]::Max(9,   [Math]::Min(32,   [int]$a.hubTitleFontSize))
    $a.hubSubFontSize   = [Math]::Max(8,   [Math]::Min(24,   [int]$a.hubSubFontSize))
    $a.disabledWedgeAlpha = [Math]::Max(0.1, [Math]::Min(1.0, [double]$a.disabledWedgeAlpha))
    $a.disabledEdgeAlpha  = [Math]::Max(0.1, [Math]::Min(1.0, [double]$a.disabledEdgeAlpha))
    if (-not $script:Themes.Contains([string]$a.theme)) { $a.theme = 'midnight' }

    $merged.port = [Math]::Max(1024, [Math]::Min(65535, [int]$merged.port))

    $merged.speech.confidence = [Math]::Max(0.0, [Math]::Min(0.95, [double]$merged.speech.confidence))

    # 数组字段统一掰成字符串数组。配置文件可能是手改的、也可能是旧版本写的，
    # 这一个字段可能是 null / 字符串 / 空对象 {} / 数组 —— 在这里一次性归一，
    # 业务代码就不用到处防了。
    $merged.api.chatModels = ConvertTo-StringList $merged.api.chatModels
    $merged.content.order = ConvertTo-StringList $merged.content.order

    # 图库保留策略。这里**一律走 Get-ClampedInt / Get-BoolValue**，
    # 不能直接 [int] / [bool] —— 见那两个函数头上的注释，
    # 手改坏的配置会让 [int] 抛在启动路径上。
    $g = $merged.gallery
    if (@('count', 'days', 'both', 'off') -notcontains [string]$g.mode) { $g.mode = 'count' }
    $g.maxCount    = Get-ClampedInt -Value $g.maxCount    -Min 1 -Max 5000 -Default 200
    $g.maxDays     = Get-ClampedInt -Value $g.maxDays     -Min 1 -Max 3650 -Default 90
    $g.maxAdopt    = Get-ClampedInt -Value $g.maxAdopt    -Min 0 -Max 5000 -Default 500
    $g.recentLimit = Get-ClampedInt -Value $g.recentLimit -Min 3 -Max 16   -Default 16
    $g.enabled     = Get-BoolValue -Value $g.enabled     -Default $true
    $g.deleteFiles = Get-BoolValue -Value $g.deleteFiles -Default $false
    $g.adoptOnOpen = Get-BoolValue -Value $g.adoptOnOpen -Default $true
    $g.sweepTemp   = Get-BoolValue -Value $g.sweepTemp   -Default $true

    $merged.content.hideUnavailable = Get-BoolValue -Value $merged.content.hideUnavailable -Default $true

    # 可见的扇区至少留一个，否则圆环弹出来是空的，用户会以为程序坏了
    $visible = @($merged.content.order | Where-Object { $merged.content.sectors[$_].visible })
    if ($visible.Count -eq 0) {
        foreach ($key in $merged.content.sectors.Keys) { $merged.content.sectors[$key].visible = $true }
    }

    # 把补齐了默认值的整份配置写回去。已存在的值一个都不动 ——
    # 只是让用户下次打开文件时，每一档可调项都在那儿、键名一目了然。
    if ($needsFill) {
        try { Save-Config $merged } catch { Write-CrashLog "补全配置文件失败: $($_.Exception.Message)" }
    }

    return $merged
}

# 顶层段有没有缺。只查结构性的几处 —— 每次启动都递归比对整份配置不值当，
# 而真正会让人抓瞎的就是「整段不见了」。
function Test-ConfigIncomplete {
    param($Saved, $Canonical)

    if ($null -eq $Saved) { return $true }
    if ($Saved -isnot [System.Collections.IDictionary]) { return $true }

    # gallery 不在这里的话，老配置永远补不出这一段 ——
    # 用户想手改保留策略时打开配置文件会发现压根没这玩意儿
    foreach ($section in @('api', 'appearance', 'interaction', 'content', 'speech', 'gallery')) {
        if (-not $Canonical.ContainsKey($section)) { continue }
        if (-not $Saved.ContainsKey($section)) { return $true }
        if ($Saved[$section] -isnot [System.Collections.IDictionary]) { return $true }
        # 段在、但里面少了键 —— api 段最常见（用户手动删过密钥行）
        foreach ($key in $Canonical[$section].Keys) {
            if (-not $Saved[$section].ContainsKey($key)) { return $true }
        }
    }
    return $false
}

# ---------- 写 ----------

function Save-Config {
    param($Config)

    $json = $Config | ConvertTo-Json -Depth 12
    Write-TextFile -Path $script:ConfigPath -Text $json
    Protect-File -Path $script:ConfigPath
}

# PS 5.1 的 Out-File -Encoding utf8 会写 BOM。
# 我们的 JSON 要能被别的东西（包括 macOS 版助手）读，所以显式写无 BOM 的 UTF-8。
function Write-TextFile {
    param([string]$Path, [string]$Text)

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

# 配置里有明文密钥，收紧到只有本机当前账号能读（对应 macOS 版的 chmod 600）。
#
# 走 icacls 而不是 Get-Acl/Set-Acl：后者在非管理员会话里会因为
# SeSecurityPrivilege 抛 PrivilegeNotHeldException（它顺手也想写 SACL）。
# icacls 只动 DACL，普通账号就能跑。
#
# 全程尽力而为 —— 失败完全不影响功能，%USERPROFILE% 本身默认就不对其他账号开放。
function Protect-File {
    param([string]$Path)

    try {
        if (-not (Test-Path -LiteralPath $Path)) { return }
        $me = "$env:USERDOMAIN\$env:USERNAME"
        $null = & icacls.exe "$Path" /inheritance:r /grant:r "${me}:(R,W)" 2>$null
    } catch { }
}

# ---------- 状态文件 ----------
# 安装脚本和「自检」都读这个文件，用来知道助手自己觉得现在是什么状况。
# 助手每 2 秒刷一次；助手没在跑时文件是旧的，安装脚本据此判断。

function Write-Status {
    param([hashtable]$Fields)

    $payload = @{
        updatedAt       = (Get-Date).ToString('o')
        pid             = $PID
        # Windows 没有辅助功能授权这回事，恒为 true ——
        # 保留这个字段是为了让安装脚本能同时应付两个平台
        trusted         = $true
        tapActive       = [bool]$Fields.tapActive
        bridgeConnected = [bool]$Fields.bridgeConnected
        hotkeyOk        = [bool]$Fields.hotkeyOk
        hotkey          = [string]$Fields.hotkey
        # 这两个字段是给「自检」用的。
        # 自检常常是**另一个进程**（安装脚本第 5 步就是），
        # 那个进程里读不到运行中助手的 $script:HotkeyOk / $script:MouseHook，
        # 只能靠状态文件把运行态传出来。
        mouseHook       = [bool]$Fields.mouseHook
        pluginLoaded    = [bool]$Fields.pluginLoaded
        version         = [string]$script:HuanmengVersion
        platform        = 'windows'
    }
    try { Write-TextFile -Path $script:StatusPath -Text ($payload | ConvertTo-Json -Depth 4) } catch { }
}

function Read-Status {
    $s = Read-JsonFile $script:StatusPath
    if ($null -eq $s) { return @{} }
    return $s
}
