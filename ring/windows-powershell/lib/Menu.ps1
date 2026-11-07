# ============================================================
#  Menu.ps1 — 圆环的菜单内容
#
#  只负责「某一个扇区展开以后有哪些项」，执行在 Actions.ps1。
#  分开是因为这两件事的改动频率完全不同：加一个预设分类不用碰动作分发，
#  改一个动作也不用重排菜单。
#
#  菜单项的字段（RingMenu.ps1 认这几个）：
#    Label     显示文字
#    Action    点了发什么指令（叶子项才有）
#    Payload   指令参数
#    Children  下一级菜单的**描述符**（有它 = 这一项有子菜单），见 Resolve-MenuChildren
#    Checked   打勾，表示「当前就是这个值」
#
#  子菜单为什么要用描述符而不是脚本块：
#  脚本块必须靠 [scriptblock]::Create("...") 拼字符串才能把参数带进延迟求值，
#  而预设分类名是用户数据 —— 里面出现 $、' 或换行就会把拼出来的脚本搞坏。
#  描述符是纯数据，怎么都不会执行到用户输入的代码。
# ============================================================

# **不再分页 —— 这里以前是每页 8 项 + 「更多 ›」翻页。**
# 「更多」本身又是一个层级，看完整份模型清单要点两次，很烦。
# 现在一层有多少子项就铺多少个扇区，全部一次画在同一个环上；
# 项数多的时候靠 RingMenu 里的整体字号自适应 + 标签折行保证还看得清
# （项数越多字越小、折成两行，而不是截断成两个字）。
function New-MenuItem {
    param(
        [string]$Label,
        [string]$Action = '',
        [hashtable]$Payload = @{},
        $Children = $null,
        # **必须是 [bool] 而不是 [switch]。**
        # 写成 [switch] 的话，`-Checked ($a -eq $b)` 里那个括号表达式
        # 不会被当成开关的值，而是掉到下一个位置参数上 ——
        # 也就是 $Children。结果每个「被勾选/未勾选」的菜单项都凭空长出子菜单，
        # 点下去只会得到一句「这一项点不开」。这个坑踩过，别再改回去。
        [bool]$Checked = $false,
        # 用不了的项（比如 PS 没开时的「读选区」）。画成暗色，点了给一句提示。
        [bool]$Disabled = $false,
        [string]$DisabledHint = '这一项现在用不了',
        # 悬停时在中心圆盘上显示的完整文字。扇区那一格很窄 ——
        # 16 项的时候只有十来个汉字的宽度，提示词、模型这些根本放不下。
        # 不给就还是显示 Label。
        [string]$Detail = ''
    )

    return @{
        Label    = $Label
        Action   = $Action
        Payload  = $Payload
        Children = $Children
        # 只认「描述符（哈希表）」和「脚本块」两种，
        # 其它任何东西都当没有子菜单 —— 免得脏数据造出一个点不开的扇区
        HasChildren = ($Children -is [hashtable]) -or ($Children -is [scriptblock])
        Checked  = $Checked
        Disabled = $Disabled
        DisabledHint = $DisabledHint
        Detail   = $Detail
    }
}

# 保留成空壳：菜单会在「插件刚连上/刚断开」这些时机被整体重建，
# 老代码里可能还散落着清理调用，留个空函数比让它们炸掉省事。
function Clear-MenuPageRegistry { }

# ---------- 子菜单解析 ----------

function Resolve-MenuChildren {
    param($Children)

    if ($null -eq $Children) { return $null }

    # 兼容脚本块（内部自己用的少数几处），但菜单内容一律走描述符
    if ($Children -is [scriptblock]) { return (& $Children) }
    if ($Children -isnot [hashtable]) { return $null }

    switch ([string]$Children.kind) {
        'params'         { return Get-ParamsMenu }
        'ratios'         { return Get-AspectRatioMenu }
        'resolutions'    { return Get-ResolutionMenu }
        'counts'         { return Get-CountMenu }
        'presets'        { return Get-PresetsMenu }
        'presetCategory' { return Get-PresetsInCategory -Category ([string]$Children.category) }
        'models'         { return Get-ModelMenu }
        'chat'           { return Get-ChatMenu }
        'chatModels'     { return Get-ChatModelMenu }
        'chatQuestions'  { return Get-ChatQuestionsMenu }
        'generate'       { return Get-GenerateMenu }
        'gallery'        { return Get-GalleryMenu }
        'galleryRecent'  { return Get-GalleryRecentMenu }
        'galleryDays'    { return Get-GalleryDayMenu }
        # day 是 '2026-09-22' 这样的纯数据字符串，走描述符没有
        # [scriptblock]::Create 的注入风险 —— 这正是描述符机制存在的理由
        'galleryDay'     { return Get-GalleryDayItems -Day ([string]$Children.day) }
    }
    return $null
}

function Get-SectorChildren {
    param([string]$Action)

    switch ($Action) {
        'params'   { return @{ kind = 'params' } }
        'presets'  { return @{ kind = 'presets' } }
        'chatMenu' { return @{ kind = 'chat' } }
        'chat'     { return @{ kind = 'chat' } }   # 老配置里可能还写着 chat
        'generate' { return @{ kind = 'generate' } }
        'gallery'  { return @{ kind = 'gallery' } }
        # 老配置里可能写着 galleryMenu，和上面 chat/chatMenu 同一套兼容写法
        'galleryMenu' { return @{ kind = 'gallery' } }
        default    { return $null }
    }
}

# ---------- 可用性 ----------
# 某些动作依赖 Photoshop / 插件。插件没连上时把它们画成暗色并说明原因 ——
# 比让用户点下去再弹一句「命令失败」友好得多，也符合 mac 版的
# disabledWedgeAlpha / disabledEdgeAlpha（禁用扇区压暗）。
# **全项目唯一一份「哪些动作要 Photoshop」的定义。**
#
# 以前这段正则散在 Get-ActionAvailability 里，现在收成一个判据函数 ——
# 因为「离线时收起」和「离线时置灰」是两套处理，判据必须是同一份，
# 否则迟早出现「灰着但没收起」这种自相矛盾的状态。
function Test-ActionNeedsPlugin {
    param([string]$Action)

    if (-not $Action) { return $false }
    switch -Regex ($Action) {
        '^readSelection$' { return $true }
        '^openChat$'      { return $true }
        '^tab:'           { return $true }
    }
    return $false
}

# 需要插件时给用户看的理由。「收起」用不到它，
# 但把 hideUnavailable 关掉的用户会看到置灰的项 —— 那时得说清楚为什么。
function Get-ActionNeedsText {
    param([string]$Action)

    switch -Regex ($Action) {
        '^readSelection$' { return '读取选区' }
        '^openChat$'      { return '打开面板对话页' }
        '^tab:'           { return '切换面板页面' }
    }
    return ''
}

function Get-ActionAvailability {
    param([string]$Action)

    if (-not $Action) { return @{ Ok = $true; Hint = '' } }

    $needs = Get-ActionNeedsText -Action $Action
    if (-not $needs) { return @{ Ok = $true; Hint = '' } }

    if (Test-PluginConnected) { return @{ Ok = $true; Hint = '' } }
    return @{
        Ok   = $false
        Hint = "$needs 需要 Photoshop 开着、并且插件已经加载"
    }
}

# 这个扇区现在该不该整个收起来？
#
# 「收起」和「置灰」是两种态度：灰项在「当独立 app 用」的场景下是纯噪音
# —— 点了没用还占一格；但配置里把它关掉，就退回置灰，
# 让用户至少知道有这么个功能、只是现在用不了。
function Test-SectorHidden {
    param([string]$Id, [string]$Action)

    $cfg = $script:Cfg

    # 图库可以整个关掉，关了就别在圆环上占位
    if ($Id -eq 'gallery' -and -not (Get-BoolValue -Value $cfg.gallery.enabled -Default $true)) { return $true }

    if (-not (Get-BoolValue -Value $cfg.content.hideUnavailable -Default $true)) { return $false }
    if (Test-PluginConnected) { return $false }

    if (Test-ActionNeedsPlugin -Action $Action) { return $true }
    return $false
}

# ---------- 一级菜单 ----------

function Get-MainMenuLevel {
    $cfg = $script:Cfg
    $items = @()

    foreach ($id in $cfg.content.order) {
        $sector = $cfg.content.sectors[$id]
        if (-not $sector -or -not $sector.visible) { continue }

        $action = [string]$sector.action
        if (-not $action) { $action = $id }

        # 依赖 Photoshop 的扇区在插件离线时**整个收起来**，不画成灰的。
        # 副作用是圆环上的块数会变，字号自适应跟着变 —— 这是想要的效果。
        if (Test-SectorHidden -Id $id -Action $action) { continue }

        $avail = Get-ActionAvailability -Action $action
        $items += New-MenuItem -Label ([string]$sector.label) -Action $action `
            -Children (Get-SectorChildren -Action $action) `
            -Disabled (-not $avail.Ok) -DisabledHint $avail.Hint
    }

    if ($items.Count -eq 0) {
        $items += New-MenuItem -Label '关闭' -Action 'close'
    }

    return @{ Title = '幻梦圆环'; Items = @($items) }
}

# ---------- 参数 ----------

function Get-ParamsMenu {
    return @{
        Title = '参数'
        Items = @(
            (New-MenuItem -Label '模型'     -Children @{ kind = 'models' })
            (New-MenuItem -Label '比例'     -Children @{ kind = 'ratios' })
            (New-MenuItem -Label '分辨率'   -Children @{ kind = 'resolutions' })
            (New-MenuItem -Label '张数'     -Children @{ kind = 'counts' })
        )
    }
}

function Get-AspectRatioMenu {
    $current = Get-CurrentParam 'aspectRatio'
    $items = @()
    foreach ($opt in Get-AspectRatioOptions) {
        $items += New-MenuItem -Label $opt.Text -Action 'setParam' `
            -Payload @{ key = 'aspectRatio'; value = $opt.Value } `
            -Checked ($opt.Value -eq $current)
    }
    return @{ Title = '画面比例'; Items = @($items) }
}

# 把插件下发的下拉选项统一成 @{ Value; Text }。
#
# 插件通过桥接发过来的是 **{value, text} 对象数组**（见 ring-bridge.js 的
# controlOptions()）。之前这里直接 `[string]$_`，哈希表被转成字符串
# "System.Collections.Hashtable" —— 插件一连上，圆环的模型列表反而变成一堆乱码。
# 这个函数同时兼容三种形状：对象、纯字符串、以及单个字符串。
#
# **不要写成 `return ,$out`。** 逗号会让函数只吐出一个对象（整个数组），
# 而 `foreach ($x in 函数)` 不会把那个对象再摊开 —— 结果是循环体只跑一次，
# $x 拿到的是整个数组，$x.Value 就成了数组而不是字符串。
# 表现是圆环的模型列表整块消失 / 报「无法把 Object[] 转成 Boolean」。
# 用 @() 包一层也救不了（实测 @() 同样不摊开）。老老实实逐个输出。
function ConvertTo-MenuOptions {
    param($Raw, [string]$FallbackPrefix = '')

    $out = @()
    if ($null -eq $Raw) { return $out }

    foreach ($item in @($Raw)) {
        if ($null -eq $item) { continue }
        if ($item -is [string]) {
            $v = $item.Trim()
            if ($v) { $out += @{ Value = $v; Text = $v } }
            continue
        }
        if ($item -is [System.Collections.IDictionary]) {
            $v = [string]$item['value']
            $t = [string]$item['text']
            if (-not $v) { $v = [string]$item['Value'] }
            if (-not $t) { $t = [string]$item['Text'] }
            if (-not $v) { continue }
            if (-not $t) { $t = $v }
            $out += @{ Value = $v; Text = $t }
        }
    }
    return $out
}

# 图像模型清单。
#
# 插件在线就用**插件自己那份下拉**（那才是这台机器面板上真有的东西，
# 显示名也带着价格等说明）。插件不在时用这里的兜底 ——
# 图像模型清单。
#
# 面板在线就用**面板自己那份**（那才是这台机器上真有的东西）；
# 面板不在线时用下面这张兜底表。
#
# **兜底表按官方 OpenAPI 文档逐字抄，不要再凭印象编。**
# 之前这里混进了一堆根本不在 GRS 清单里的 ID（grok2api/…、xai/…、firefly/…），
# 照着选必然失败，而用户看到的只是「生图点了没反应」。
# 文档里 /v1/api/generate 支持的模型就这 16 个：
#   nano-banana 系：nano-banana / -fast / -2 / -2-cl / -2-2k-cl / -2-4k-cl
#                   nano-banana-pro / -pro-vt / -pro-cl / -pro-vip / -pro-4k-vip
#   gpt-image 系：  gpt-image-2 / -2-vip / -2.5 / -2.5-flare / -2.5-sunburst
function Get-ImageModelOptions {
    $state = Get-PluginState
    if ($state -and $state.options -and $state.options.model) {
        $list = @(ConvertTo-MenuOptions -Raw $state.options.model)
        if ($list.Count -gt 0) { return $list }
    }
    return @(
        # 这一条**不是** GRS 的模型，是 Photoshop 自带接口（面板里走
        # executeNativeAIPreset）。留在列表里是因为面板在线时它确实能用 ——
        # 指令转给面板，由面板分派。面板离线时 Get-ModelMenu 会把它标灰说明原因。
        @{ Value = 'PS_NATIVE_NANO_BANANA';  Text = 'PS 原生 Banana Pro (Photoshop 官方)' }

        @{ Value = 'nano-banana-fast';       Text = 'nano-banana-fast · 快' }
        @{ Value = 'nano-banana';            Text = 'nano-banana' }
        @{ Value = 'nano-banana-2';          Text = 'nano-banana-2' }
        @{ Value = 'nano-banana-2-cl';       Text = 'nano-banana-2-cl' }
        @{ Value = 'nano-banana-2-2k-cl';    Text = 'nano-banana-2-2k-cl' }
        @{ Value = 'nano-banana-2-4k-cl';    Text = 'nano-banana-2-4k-cl' }
        @{ Value = 'nano-banana-pro';        Text = 'gemini-3-pro-image-preview · ¥0.09/次' }
        @{ Value = 'nano-banana-pro-vt';     Text = 'nano-banana-pro-vt' }
        @{ Value = 'nano-banana-pro-cl';     Text = 'nano-banana-pro-cl' }
        @{ Value = 'nano-banana-pro-vip';    Text = 'nano-banana-pro-vip' }
        @{ Value = 'nano-banana-pro-4k-vip'; Text = 'nano-banana-pro-4k-vip' }

        @{ Value = 'gpt-image-2';            Text = 'gpt-image-2 · ¥0.03/次' }
        @{ Value = 'gpt-image-2-vip';        Text = 'GPT Image 2 (1K/2K/4K) · ¥0.10/次' }
        @{ Value = 'gpt-image-2.5';          Text = 'gpt-image-2.5 · ¥0.03/次' }
        @{ Value = 'gpt-image-2.5-flare';    Text = 'gpt-image-2.5-flare · ¥0.10/次' }
        @{ Value = 'gpt-image-2.5-sunburst'; Text = 'gpt-image-2.5-sunburst · ¥0.12/次' }
    )
}

# 画面比例。
#
# 文档里 nano-banana 支持 11 种，nano-banana-2 系列在这之外还多认 4 种。
# 环以前一律发 auto，等于把这十几个选项白白浪费 —— 想指定横竖构图做不到。
function Get-AspectRatioOptions {
    return @(
        @{ Value = 'auto'; Text = '自适应' }
        @{ Value = '1:1';  Text = '1:1 正方形' }
        @{ Value = '16:9'; Text = '16:9 横屏' }
        @{ Value = '9:16'; Text = '9:16 竖屏' }
        @{ Value = '4:3';  Text = '4:3' }
        @{ Value = '3:4';  Text = '3:4' }
        @{ Value = '3:2';  Text = '3:2' }
        @{ Value = '2:3';  Text = '2:3' }
        @{ Value = '5:4';  Text = '5:4' }
        @{ Value = '4:5';  Text = '4:5' }
        @{ Value = '21:9'; Text = '21:9 超宽' }
        # 下面四种只有 nano-banana-2 系列认，别的模型发了会被接口拒掉
        @{ Value = '1:4';  Text = '1:4 · 仅 nano-banana-2 系' }
        @{ Value = '4:1';  Text = '4:1 · 仅 nano-banana-2 系' }
        @{ Value = '1:8';  Text = '1:8 · 仅 nano-banana-2 系' }
        @{ Value = '8:1';  Text = '8:1 · 仅 nano-banana-2 系' }
    )
}

# 分辨率清单。插件里的值是 auto/1K/2K/4K，显示名是 自适应/1K/2K/4K。
function Get-ResolutionOptions {
    $state = Get-PluginState
    if ($state -and $state.options -and $state.options.resolution) {
        $list = @(ConvertTo-MenuOptions -Raw $state.options.resolution)
        if ($list.Count -gt 0) { return $list }
    }
    return @(
        @{ Value = 'auto'; Text = '自适应' }
        @{ Value = '1K';   Text = '1K' }
        @{ Value = '2K';   Text = '2K' }
        @{ Value = '4K';   Text = '4K' }
    )
}

function Get-CurrentParam {
    param([string]$Key)

    $state = Get-PluginState
    if ($state -and $state.params) {
        $value = $state.params.$Key
        if ($value) { return [string]$value }
    }
    switch ($Key) {
        'model'       { return [string]$script:Cfg.api.imgModel }
        'resolution'  { return [string]$script:Cfg.api.imageSize }
        'count'       { return [string]$script:Cfg.api.imageCount }
        'aspectRatio' { return [string]$script:Cfg.api.aspectRatio }
    }
    return ''
}

function Get-ModelMenu {
    $current = Get-CurrentParam 'model'
    $plugin = Test-PluginConnected
    $items = @()

    foreach ($opt in Get-ImageModelOptions) {
        # 扇区上显示插件的显示名，实际发出去的是 value —— 两者不能混。
        # 之前 Label 和 value 用的同一个字符串，所以圆环上写的是裸 ID。
        #
        # 面板连着的时候，选什么都能用 —— 圆环只是把指令转给面板，
        # 面板自己会分派到 PS 原生接口或各家的网关。
        # 面板没连着时，圆环只能直连 GRS：够不着的模型（PS 原生、xAI、
        # 本地网关…）在这里就画成暗色并写明原因，而不是等用户点了之后
        # 收到一句「HTTP 400 Bad Request」—— 那是查不出来的。
        $ok = $true
        $hint = ''
        if (-not $plugin) {
            $probe = ConvertTo-GrsModelName -Model $opt.Value
            if (-not $probe.Ok) { $ok = $false; $hint = $probe.Error }
        }

        $items += New-MenuItem -Label $opt.Text -Action 'setParam' `
            -Payload @{ key = 'model'; value = $opt.Value } `
            -Checked ($opt.Value -eq $current) `
            -Disabled (-not $ok) -DisabledHint $hint
    }
    return @{ Title = '模型'; Items = @($items) }
}

function Get-ResolutionMenu {
    $current = Get-CurrentParam 'resolution'
    $items = @()
    foreach ($opt in Get-ResolutionOptions) {
        $items += New-MenuItem -Label $opt.Text -Action 'setParam' `
            -Payload @{ key = 'resolution'; value = $opt.Value } -Checked ($opt.Value -eq $current)
    }
    return @{ Title = '分辨率'; Items = @($items) }
}

function Get-CountMenu {
    $current = Get-CurrentParam 'count'
    $items = @()
    foreach ($n in @(1, 2, 3, 4)) {
        $items += New-MenuItem -Label "$n 张" -Action 'setParam' -Payload @{ key = 'count'; value = $n } -Checked ([string]$n -eq $current)
    }
    return @{ Title = '张数'; Items = @($items) }
}

# ---------- 预设 ----------

# 老版本插件在 state 里把预设正文截成 40 个字符（`slice(0, 40)`）——
# 那正是「提示词显示不全」的根源。新版插件已改成发全文，但用户可能还没同步插件，
# 所以这里认一下这个特征长度：**正好 40 字**、且本地有更长的同名同分类那条 → 用本地那份。
#
# 为什么只认「正好 40」而不是简单「取更长的」：用户完全可能在插件里**故意把预设改短**，
# 那种情况下取更长的那份会把他的修改吃掉。40 是旧代码的硬编码特征，认它不会误伤。
$script:LegacyPresetSliceLength = 40

function Get-PresetList {
    # 插件在线就用插件那份（用户可能在面板里改过），否则用本地那份。
    # 两份同源，但用户可能只更新了一边。
    $state = Get-PluginState
    if ($state -and $state.presets -and @($state.presets).Count -gt 0) {
        # 本地那份读出来做对照用。**用「分类|名字」当键** ——
        # 预设名字是可以重复的（自带那份里就有两条《面部精修》）。
        $local = @{}
        foreach ($p in @(Get-LocalPresets)) {
            $local["$($p.category)|$($p.name)"] = [string]$p.prompt
        }

        $out = @()
        foreach ($group in @($state.presets)) {
            $category = [string]$group.category
            foreach ($item in @($group.items)) {
                $name = [string]$item.name
                $prompt = [string]$item.prompt
                $key = "$category|$name"
                # 续行符必须在**行尾** —— PowerShell 不接受把 -and 写在行首（踩过一次）
                if ($prompt.Length -eq $script:LegacyPresetSliceLength `
                    -and $local.ContainsKey($key) `
                    -and $local[$key].Length -gt $prompt.Length) {
                    $prompt = $local[$key]
                }
                $out += @{ category = $category; name = $name; prompt = $prompt }
            }
        }
        if ($out.Count -gt 0) { return $out }
    }
    return Get-LocalPresets
}

function Get-LocalPresets {
    if ($script:LocalPresets) { return $script:LocalPresets }

    $path = Get-PresetPath
    $raw = Read-JsonFile $path

    if ($null -eq $raw) {
        # 第一次跑：把包里自带那份抄到用户目录，之后就以用户目录那份为准。
        # 用户改预设不用去改程序目录，卸载重装也不会丢。
        $bundled = Join-Path $script:AppRoot 'presets.json'
        $raw = Read-JsonFile $bundled
        if ($null -ne $raw) {
            try { Write-TextFile -Path $path -Text ($raw | ConvertTo-Json -Depth 6) } catch { }
        }
    }

    $out = @()
    foreach ($item in @($raw)) {
        if (-not $item) { continue }
        $name = [string]$item.name
        $prompt = [string]$item.prompt
        if (-not $name -or -not $prompt) { continue }
        $category = [string]$item.category
        if (-not $category) { $category = '未分类' }
        $out += @{ category = $category; name = $name; prompt = $prompt }
    }

    $script:LocalPresets = $out
    return $out
}

function Get-PresetsMenu {
    $presets = Get-PresetList

    $categories = @()
    $seen = @{}
    foreach ($preset in $presets) {
        if (-not $seen.ContainsKey($preset.category)) {
            $seen[$preset.category] = $true
            $categories += $preset.category
        }
    }

    if ($categories.Count -eq 0) {
        return @{ Title = '预设'; Items = @(New-MenuItem -Label '没有预设' -Action 'noop') }
    }

    $items = @()
    foreach ($category in $categories) {
        $count = @($presets | Where-Object { $_.category -eq $category }).Count
        $items += New-MenuItem -Label "$category ($count)" -Children @{ kind = 'presetCategory'; category = $category }
    }

    # 分类再多也是一圈铺开，不折叠、不翻页
    return @{ Title = '预设分类'; Items = @($items) }
}

function Get-PresetsInCategory {
    param([string]$Category)

    $presets = @(Get-PresetList | Where-Object { $_.category -eq $Category })
    $items = @()
    foreach ($preset in $presets) {
        # ⚠️ payload 里必须带上 category：**预设名字是可以重复的**
        # （实测自带那份里就有两条《面部精修》，一条在「人像精修」93 字、
        #   一条在「脸部」173 字）。插件那边不能只按名字找 —— 它会命中
        #   排在前面的那一条，于是「圆环复制的是这条、插件套用的是那条」，
        #   用户看到的就是「复制不全」。身份 = 分类 + 名字。
        $items += New-MenuItem -Label $preset.name -Action 'applyPreset' -Payload @{
            name     = $preset.name
            category = $preset.category
            prompt   = $preset.prompt
        }
    }
    if ($items.Count -eq 0) { $items += New-MenuItem -Label '（空）' -Action 'noop' }

    return @{ Title = $Category; Items = @($items) }
}

# ---------- 对话 ----------

function Get-ChatQuestions {
    $state = Get-PluginState
    if ($state -and $state.chat -and $state.chat.questions -and @($state.chat.questions).Count -gt 0) {
        $out = @()
        foreach ($q in @($state.chat.questions)) {
            $out += @{ label = [string]$q.label; prompt = [string]$q.prompt }
        }
        if ($out.Count -gt 0) { return $out }
    }

    $custom = Parse-ChatQuestions -Text $script:Cfg.chatQuestions
    if ($custom.Count -gt 0) { return $custom }
    return Get-DefaultChatQuestions
}

function Get-DefaultChatQuestions {
    # 和插件里的 DEFAULT_CHAT_QUESTIONS 保持一致。
    # 助手没连上插件时用这一套，连上了就用插件下发的（用户可能在面板里改过）。
    return @(
        @{ label = '调色思路'; prompt = '给我一个适合这张照片的调色思路，按步骤说明每一步的目的和大致参数范围。' }
        @{ label = '光影诊断'; prompt = '分析这张照片的光影问题，指出需要调整的局部区域和调整方向。' }
        @{ label = '人像精修'; prompt = '针对这张人像列出精修步骤（磨皮、液化、肤色统一、眼神光），说明每一步的力度。' }
        @{ label = '构图建议'; prompt = '从构图角度评价这张照片，指出可以裁剪或调整的地方。' }
        @{ label = '转黑白';   prompt = '如果要把这张照片转成黑白，说明通道混合器各通道的配比和对比度设置建议。' }
        @{ label = '写提示词'; prompt = '根据我接下来描述的画面，写一段用于 AI 生图的中文提示词。' }
    )
}

# 和插件设置页共用同一份解析规则（一行一条：标题=提示词），
# 免得「助手说 6 条、插件上只有 4 条」这种两边对不上的事
function Parse-ChatQuestions {
    param([string]$Text)

    $out = @()
    if (-not $Text) { return $out }

    foreach ($line in ($Text -split "`n")) {
        $raw = $line.Trim()
        if (-not $raw) { continue }
        if ($raw.StartsWith('#')) { continue }

        $cut = -1
        foreach ($mark in @('=', '|', '｜')) {
            $at = $raw.IndexOf($mark)
            if ($at -gt 0 -and ($cut -lt 0 -or $at -lt $cut)) { $cut = $at }
        }

        if ($cut -gt 0) {
            $label = $raw.Substring(0, $cut).Trim()
            $prompt = $raw.Substring($cut + 1).Trim()
        } else {
            $label = ''
            $prompt = $raw
        }
        if (-not $prompt) { continue }
        if (-not $label) {
            if ($prompt.Length -gt 5) { $label = $prompt.Substring(0, 5) } else { $label = $prompt }
        }
        $out += @{ label = $label; prompt = $prompt }
    }
    return $out
}

# 对话模型清单。同样是 {value,text} 配对；兜底表和 index.html 里
# <select id="chatModel"> 的 5 个选项逐字对应。
function Get-ChatModelOptions {
    $state = Get-PluginState
    if ($state -and $state.chat -and $state.chat.models -and @($state.chat.models).Count -gt 0) {
        $list = @(ConvertTo-MenuOptions -Raw $state.chat.models)
        if ($list.Count -gt 0) { return $list }
    }
    $cfgList = @(ConvertTo-MenuOptions -Raw $script:Cfg.api.chatModels)
    if ($cfgList.Count -gt 0) { return $cfgList }
    return @(
        @{ Value = 'grs/gpt-5.4';        Text = 'gpt-5.4 (GRS)' }
        @{ Value = 'grs/gpt-5.5';        Text = 'gpt-5.5 (GRS)' }
        @{ Value = 'grs/gemini-3-pro';   Text = 'gemini-3-pro (GRS)' }
        @{ Value = 'grs/gemini-3.1-pro'; Text = 'gemini-3.1-pro (GRS)' }
        @{ Value = 'grs/gemini-2.5-pro'; Text = 'gemini-2.5-pro (GRS)' }
    )
}

function Get-ChatMenu {
    # 「打开面板」要 Photoshop 和插件都在；其余几项助手自己就能干（独立对话）
    $panelOk = Test-PluginConnected

    $hasKey = $false
    if ($script:Cfg -and $script:Cfg.api -and $script:Cfg.api.grsApiKey) {
        $hasKey = [bool]([string]$script:Cfg.api.grsApiKey).Trim()
    }

    $items = @(
        # Agent 排在第一个：它会自己判断要不要调工具（查预设、生图），
        # 是这里最省事的一条路。下面那几个是纯聊天。
        #
        # 判断条件是**有没有密钥**，不是插件连没连 ——
        # agent 只调 GRS 接口，不依赖 Photoshop。
        (New-MenuItem -Label 'Agent' -Action 'agentAsk' `
            -Disabled (-not $hasKey) -DisabledHint 'Agent 需要先填 API 密钥：菜单栏 ◎ → 打开配置文件')
        (New-MenuItem -Label '模型'     -Children @{ kind = 'chatModels' })
        (New-MenuItem -Label '快捷提问' -Children @{ kind = 'chatQuestions' })
        (New-MenuItem -Label '打字提问' -Action 'chatType')
        (New-MenuItem -Label '看对话'   -Action 'chatHistory')
        (New-MenuItem -Label '新对话'   -Action 'chatNew')
    )

    # 「打开面板」在没插件时**不产出这一项**，而不是画成灰的。
    # 它跟上面几个不一样：那几个离了 PS 照样干活，这一项离了 PS 就是个死按钮。
    # （子菜单项没有 visible 字段，隐藏的既有做法就是构建时不产出它，
    #   见 Get-GenerateMenu。）
    if ($panelOk) {
        $items += New-MenuItem -Label '打开面板' -Action 'openChat'
    }

    return @{ Title = '对话'; Items = @($items) }
}

function Get-ChatQuestionsMenu {
    $items = @()
    foreach ($q in (Get-ChatQuestions)) {
        $items += New-MenuItem -Label $q.label -Action 'chatAsk' -Payload @{ prompt = $q.prompt }
    }
    if ($items.Count -eq 0) { $items += New-MenuItem -Label '（无）' -Action 'noop' }

    return @{ Title = '快捷提问'; Items = @($items) }
}

function Get-ChatModelMenu {
    $state = Get-PluginState
    $current = ''
    if ($state -and $state.chat) { $current = [string]$state.chat.model }

    $plugin = Test-PluginConnected
    $items = @()
    foreach ($opt in Get-ChatModelOptions) {
        # 和出图模型同一套道理：面板在线时它自己分派，离线时圆环只连 GRS，
        # 够不着的（比如火山方舟那类别的渠道）在这里就标灰说明原因
        $ok = $true
        $hint = ''
        if (-not $plugin) {
            $probe = ConvertTo-GrsModelName -Model $opt.Value
            if (-not $probe.Ok) { $ok = $false; $hint = $probe.Error }
        }

        $items += New-MenuItem -Label $opt.Text -Action 'chatModel' `
            -Payload @{ value = $opt.Value } -Checked ($opt.Value -eq $current) `
            -Disabled (-not $ok) -DisabledHint $hint
    }
    if ($items.Count -eq 0) { $items += New-MenuItem -Label '（无）' -Action 'noop' }

    return @{ Title = '对话模型'; Items = @($items) }
}

# ---------- 图库 ----------
#
# 圆环是纯文字的，缩略图网格做不了 —— 所以图库是「一层层点进去」的列表，
# 每项只放时间和提示词的前几个字（见 Gallery.ps1 的 Format-GalleryLabel），
# 完整信息挂在 Detail 上、悬停时在中心圆盘显示。
#
# **每层封顶 16 项。** 这不是拍脑袋：16 项时扇区张角 22.5°，
# RingMenu 的字号自适应会把字号压到下限，一格大约只放得下十来个汉字。
# 再多就得靠折行和截断，实际已经读不出是什么了。

function Get-GalleryRecentLimit {
    $n = 16
    try { $n = [int]$script:Cfg.gallery.recentLimit } catch { }
    if ($n -lt 3) { $n = 3 }
    if ($n -gt 16) { $n = 16 }
    return $n
}

function Get-GalleryMenu {
    $total = Get-GalleryCount
    $items = @()

    if ($total -eq 0) {
        # 一张都没有：别摆两个点进去也是空的子菜单，直接说明白
        $items += New-MenuItem -Label '还没有图' -Action 'galleryOpenFolder' `
            -Detail '点这里打开出图目录看看'
    } else {
        $items += New-MenuItem -Label '最近' -Children @{ kind = 'galleryRecent' } `
            -Detail "最近生成的 $total 张里的一部分"
        # 先赋值再数。Gallery.ps1 里的函数返回的是 `,$array`，
        # 写成 @(Get-GalleryDays ...).Count 的话空图库时会得到 1（见那边的文件头）
        $dayList = Get-GalleryDays -Max 1
        if ($null -ne $dayList -and $dayList.Count -gt 0) {
            $items += New-MenuItem -Label '按天' -Children @{ kind = 'galleryDays' } `
                -Detail '按日期翻'
        }
    }

    $items += New-MenuItem -Label '打开目录' -Action 'galleryOpenFolder' `
        -Detail '在资源管理器里打开出图目录'
    $items += New-MenuItem -Label '收录旧图' -Action 'galleryAdopt' `
        -Detail '把目录里已有的、图库里还没有的图收进来'
    $items += New-MenuItem -Label '清理…' -Action 'galleryCleanup' `
        -Detail '按保留策略收起较早的记录'

    $title = if ($total -gt 0) { "图库 共 $total 张" } else { '图库' }
    return @{ Title = $title; Items = @($items) }
}

function Get-GalleryRecentMenu {
    $limit = Get-GalleryRecentLimit
    # 先赋值再用 —— 见 Gallery.ps1 文件头，@(函数调用) 在空数组时会多算一个
    $items = Get-GalleryRecent -Count $limit
    if ($null -eq $items) { $items = @() }

    $out = @()
    foreach ($it in $items) {
        $out += New-MenuItem -Label (Format-GalleryLabel -Item $it) `
            -Action 'galleryShow' -Payload @{ id = $it.id; scope = 'recent' } `
            -Detail (Format-GalleryDetail -Item $it)
    }
    if ($out.Count -eq 0) { $out += New-MenuItem -Label '（无）' -Action 'noop' }

    return @{ Title = "最近 $($out.Count) 张"; Items = @($out) }
}

function Get-GalleryDayMenu {
    # 同上：先赋值再遍历
    $days = Get-GalleryDays -Max 16
    if ($null -eq $days) { $days = @() }

    $out = @()
    foreach ($d in $days) {
        $out += New-MenuItem -Label "$($d.Label) ($($d.Count))" `
            -Children @{ kind = 'galleryDay'; day = [string]$d.Day } `
            -Detail "$($d.Day) 共 $($d.Count) 张"
    }
    if ($out.Count -eq 0) { $out += New-MenuItem -Label '（无）' -Action 'noop' }

    return @{ Title = '按天'; Items = @($out) }
}

function Get-GalleryDayItems {
    param([string]$Day)

    $items = Get-GalleryByDay -Day $Day
    if ($null -eq $items) { $items = @() }

    $out = @()
    foreach ($it in $items) {
        $out += New-MenuItem -Label (Format-GalleryLabel -Item $it) `
            -Action 'galleryShow' -Payload @{ id = $it.id; scope = 'day'; day = $Day } `
            -Detail (Format-GalleryDetail -Item $it)
    }
    if ($out.Count -eq 0) { $out += New-MenuItem -Label '（无）' -Action 'noop' }

    return @{ Title = (Format-GalleryDayLabel -Day $Day); Items = @($out) }
}

# ---------- 生成 ----------

function Get-GenerateMenu {
    # PS 开着（插件连上了）就直接出图，不再多问一层
    if (Test-PluginConnected) {
        return @{ Title = '生成'; Items = @(New-MenuItem -Label '开始出图' -Action 'generate') }
    }

    # PS 没开：先问要不要参考图
    return @{
        Title = '生成'
        Items = @(
            (New-MenuItem -Label '纯文字'     -Action 'promptText')
            (New-MenuItem -Label '导入图片'   -Action 'pickImage')
            (New-MenuItem -Label '截屏'       -Action 'screenshot')
            (New-MenuItem -Label '用上次的图' -Action 'reuseLast')
        )
    }
}
