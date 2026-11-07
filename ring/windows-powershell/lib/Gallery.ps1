# ============================================================
#  Gallery.ps1 — 出图历史索引
#
#  在此之前，生成过的图等于一次性消费品：进程一关，什么都不剩。
#  $script:LastResultPath 甚至是个只写不读的死变量。
#
#  ------------------------------------------------------------
#  **图库是索引，不是仓库**
#
#  图片本体就放在出图目录里，这里只记它叫什么、什么时候出的、用的什么
#  提示词。**不复制文件** —— 复制就会出现两份不同步，用户删了其中一份
#  另一份还在，时间长了谁也说不清哪份是正的。
#
#  连带的结论是：清理策略默认**只从图库里把老记录收起来（hidden），
#  一个文件都不动**。那是用户的作品，不是我们的缓存。真要删文件得
#  用户在偏好设置里显式打开开关，而且删之前还要过 Test-GalleryPathSafe。
#
#  ------------------------------------------------------------
#  **这个文件会被后台 runspace dot-source**
#
#  收编旧图走后台（出图目录常被 OneDrive 接管，Get-ChildItem 几千个文件
#  在绘制路径上就是几秒卡死），所以本文件里的函数**一律不许读 $script:Cfg**：
#  策略、目录、路径全部通过参数传进来。主线程那边再包一层读配置的薄壳。
#  违反了不会报错 —— 后台静默拿到 $null 走默认值，只在特定路径下出问题。
#
#  ------------------------------------------------------------
#  **明确不做的事**（别以为是漏了）
#
#  · 插件在线时出的图**不进图库**。那种情况下图落在 Photoshop 文档里、
#    不落盘，桥接协议里也没有回传路径的字段（Receive-PluginProgress 只给
#    State/Message/Thumbnail）。那块交给插件自己的画廊页（tab:gallery）。
#  · **没有图库窗口**。圆环是纯文字的，缩略图网格做不了。
#  · **不复制图片文件**，见上。
# ============================================================

# ------------------------------------------------------------
#  **本文件里返回数组的函数一律写成 `return ,$array`，调用方必须先赋值**
#
#  `,$array` 那一层是为了让**空数组**能活着穿过管道（不包的话空数组会被
#  枚举成「零个对象」，调用方拿到 $null）。但这么一来有个很阴的副作用：
#
#      @(Get-GalleryItems).Count      →  空图库时是 1，不是 0 ！
#      $x = Get-GalleryItems; $x.Count →  0（对）
#
#  原因是 `@()` 套在**命令**外面时，会把管道吐出来的那个空数组**本身**
#  当成一个元素；而套在**变量**外面时会正常枚举它。
#
#  所以：**永远先赋值，再判断。** 不这么做不会报错，只会让空图库
#  显示成「共 1 张」、然后点进去什么都没有。
# ------------------------------------------------------------

# 允许收编/删除的图片扩展名。收编时用它筛候选，删除前用它做第二道校验。
$script:GalleryImageExt = @('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp')

# 一次收编最多扫出多少张。目录被指到 D:\图片 这种大目录时，
# 宁可少收一点也不能让后台任务跑几分钟。
$script:GalleryScanCeiling = 5000

# ============================================================
#  索引读写
# ============================================================

# 记录 id = 路径小写后的 MD5 前 12 位。
#
# **用内容派生而不是时间戳**：路径就是这条记录的身份，派生出来的 id
# 天然稳定 —— 反复读写同一份索引不会换 id，去重也不用额外维护一张表。
# 时间戳 id 看着好读，但手改过索引、或从别处导入之后就对不上了。
function Get-GalleryId {
    param([string]$Path)

    if (-not $Path) { return '' }
    try {
        $md5 = [System.Security.Cryptography.MD5]::Create()
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())
            $hash = $md5.ComputeHash($bytes)
        } finally { $md5.Dispose() }

        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $hash[0..5]) { [void]$sb.Append($b.ToString('x2')) }
        return $sb.ToString()
    } catch {
        return ''
    }
}

# 把索引里的一个条目掰成固定形状。
#
# 索引是用户能手改的 JSON，还可能是旧版本写的：可能少字段、可能类型不对
# （hidden 写成字符串 "false"、ts 写成 "abc"）。业务代码不该到处防这个。
function ConvertTo-GalleryItem {
    param($Raw)

    if ($null -eq $Raw -or $Raw -isnot [System.Collections.IDictionary]) { return $null }

    $path = [string]$Raw['path']
    if (-not $path.Trim()) { return $null }

    # 时间：ts（整数秒）是排序用的唯一依据。
    # **不要用 createdAt 排序** —— 从 JSON 回来它是字符串，
    # [datetime] 转换会踩区域设置，中文 Windows 上 "2026/9/22" 和
    # "9/22/2026" 都是合法的，谁大谁小说不准。
    $ts = 0
    try { $ts = [int]$Raw['ts'] } catch { $ts = 0 }
    if ($ts -le 0) {
        $created = [string]$Raw['createdAt']
        if ($created) {
            try { $ts = [int][DateTimeOffset]::Parse($created).ToUnixTimeSeconds() } catch { $ts = 0 }
        }
    }

    $source = [string]$Raw['source']
    if (@('ring', 'agent', 'adopted') -notcontains $source) { $source = 'adopted' }

    # hidden 可能是真 bool，也可能是手改出来的字符串 ——
    # "false" 在 PowerShell 里是真值（非空字符串），直接 [bool] 会读成「已隐藏」。
    # 用 Config.ps1 的 Get-BoolValue（那边有完整的注释）。
    $hidden = Get-BoolValue -Value $Raw['hidden'] -Default $false

    $bytes = 0
    try { $bytes = [int]$Raw['bytes'] } catch { $bytes = 0 }

    $id = [string]$Raw['id']
    if (-not $id) { $id = Get-GalleryId -Path $path }

    return @{
        id        = $id
        path      = $path
        prompt    = [string]$Raw['prompt']
        model     = [string]$Raw['model']
        ratio     = [string]$Raw['ratio']
        size      = [string]$Raw['size']
        source    = $source
        ts        = $ts
        createdAt = [string]$Raw['createdAt']
        bytes     = $bytes
        hidden    = $hidden
    }
}

# 读索引。**永远不抛** —— 和 Read-JsonFile 一个原则。
function Read-GalleryIndex {
    $empty = @{ version = 1; items = @() }

    $path = $script:GalleryPath
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $empty }

    $raw = Read-JsonFile -Path $path
    if ($null -eq $raw) {
        # 文件在、但读不动（手改坏了，或者写到一半断电）。
        # 先把它挪开留证再另起一份 —— 直接覆盖会把用户攒了几个月的
        # 提示词记录静默抹掉，而且他永远不会知道。
        try {
            $bad = "$path.bad"
            Move-Item -LiteralPath $path -Destination $bad -Force
            Write-CrashLog "图库索引读不动，已挪到 $bad（新的从空开始）"
        } catch { }
        return $empty
    }

    $items = @()
    if ($raw -is [System.Collections.IDictionary] -and $raw.Contains('items')) {
        foreach ($entry in @($raw['items'])) {
            $item = ConvertTo-GalleryItem -Raw $entry
            if ($item) { $items += $item }
        }
    }
    return @{ version = 1; items = $items }
}

# 写索引。**原子写**：先落 .tmp 再换名。
# 这份 JSON 是用户提示词的唯一记录，直接 WriteAllText 写到一半断电就是全丢。
function Write-GalleryIndex {
    param($Index)

    $path = $script:GalleryPath
    if (-not $path) { return $false }

    try {
        $items = @()
        if ($Index -and $Index.Contains('items')) { $items = @($Index['items']) }

        $json = @{ version = 1; items = $items } | ConvertTo-Json -Depth 8
        $tmp = "$path.tmp"
        Write-TextFile -Path $tmp -Text $json
        Move-Item -LiteralPath $tmp -Destination $path -Force
        return $true
    } catch {
        Write-CrashLog "写图库索引失败: $($_.Exception.Message)"
        return $false
    }
}

# ============================================================
#  查
# ============================================================

# 全部记录，ts 倒序（最新的在前）。默认不含已收起的。
function Get-GalleryItems {
    param([switch]$IncludeHidden, $Index = $null)

    if ($null -eq $Index) { $Index = Read-GalleryIndex }

    $list = @()
    foreach ($it in @($Index['items'])) {
        if (-not $it) { continue }
        if (-not $IncludeHidden -and $it.hidden) { continue }
        $list += $it
    }

    $sorted = @($list | Sort-Object -Property { [int]$_.ts } -Descending)
    return , $sorted
}

function Get-GalleryCount {
    param([switch]$IncludeHidden, $Index = $null)

    # 先赋值再取 .Count。见文件头那条 —— 写成 @(Get-GalleryItems...).Count
    # 的话，空图库会返回 1
    $items = Get-GalleryItems -IncludeHidden:$IncludeHidden -Index $Index
    if ($null -eq $items) { return 0 }
    return $items.Count
}

function Find-GalleryItem {
    param([string]$Path, $Index = $null)

    if (-not $Path) { return $null }
    if ($null -eq $Index) { $Index = Read-GalleryIndex }

    # **大小写不敏感。** Windows 上 C:\a.png 和 c:\A.PNG 是同一个文件，
    # 用 -eq 比较会当成两条不同的记录，图库里就会出现重复项。
    foreach ($it in @($Index['items'])) {
        if ($it -and $it.path -and $it.path.Equals($Path, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $it
        }
    }
    return $null
}

function Find-GalleryItemById {
    param([string]$Id, $Index = $null)

    if (-not $Id) { return $null }
    if ($null -eq $Index) { $Index = Read-GalleryIndex }
    foreach ($it in @($Index['items'])) {
        if ($it -and $it.id -eq $Id) { return $it }
    }
    return $null
}

function Get-GalleryRecent {
    param([int]$Count = 16, $Index = $null)

    $items = Get-GalleryItems -Index $Index
    if ($items.Count -eq 0) { return , @() }
    if ($items.Count -le $Count) { return , $items }
    return , @($items[0..($Count - 1)])
}

# 按天分组，最新的天在前
function Get-GalleryDays {
    param([int]$Max = 30, $Index = $null)

    $items = Get-GalleryItems -Index $Index
    $order = New-Object System.Collections.ArrayList
    $map = @{}

    foreach ($it in $items) {
        $day = Get-GalleryDayKey -Item $it
        if (-not $day) { continue }
        if (-not $map.ContainsKey($day)) {
            $map[$day] = 0
            [void]$order.Add($day)
        }
        $map[$day] = $map[$day] + 1
    }

    $out = @()
    foreach ($d in $order) {
        $out += @{ Day = $d; Label = (Format-GalleryDayLabel -Day $d); Count = $map[$d] }
        if ($out.Count -ge $Max) { break }
    }
    return , $out
}

function Get-GalleryByDay {
    param([string]$Day, $Index = $null)

    $out = @()
    foreach ($it in (Get-GalleryItems -Index $Index)) {
        if ((Get-GalleryDayKey -Item $it) -eq $Day) { $out += $it }
    }
    return , $out
}

function Get-GalleryDayKey {
    param($Item)

    if (-not $Item -or [int]$Item.ts -le 0) { return '' }
    try {
        return [DateTimeOffset]::FromUnixTimeSeconds([long]$Item.ts).LocalDateTime.ToString('yyyy-MM-dd')
    } catch {
        return ''
    }
}

function Format-GalleryDayLabel {
    param([string]$Day)

    # '2026-09-22' → '9月22日'
    if ($Day -match '^(\d{4})-(\d{2})-(\d{2})$') {
        return "$([int]$Matches[2])月$([int]$Matches[3])日"
    }
    return $Day
}

# 从 $Index 出发走 $Delta 步，**跳过文件已经不在的**，返回落点下标；走不出去返回 -1。
#
# 不跳过的话表现是「点了没反应」：Set-BubbleResultImage 遇到不存在的路径
# 是静默 return，旧图还留在框里，用户只会以为按钮坏了。
function Get-GalleryStep {
    param([string[]]$Ids, [int]$Index, [int]$Delta)

    $ids = @($Ids)
    if ($ids.Count -eq 0 -or $Delta -eq 0) { return -1 }

    $i = $Index + $Delta
    while ($i -ge 0 -and $i -lt $ids.Count) {
        if (Test-Path -LiteralPath $ids[$i] -PathType Leaf) { return $i }
        $i += $Delta
    }
    return -1
}

# ============================================================
#  增 / 删
# ============================================================

# 记一笔。
#
# **这个函数挂在出图主路径上** —— 它自己吞掉一切异常并返回 $null。
# 图库写不进去（磁盘满、索引被别的进程占着）绝不能把「出图成功」
# 变成「出图报错」，那对用户来说才是真的灾难。
function Add-GalleryRecord {
    param(
        [string]$Path,
        [string]$Prompt = '',
        [string]$Model = '',
        [string]$Ratio = '',
        [string]$Size = '',
        [string]$Source = 'ring',
        $CreatedAt = $null,
        [int]$Bytes = 0
    )

    try {
        if (-not $Path -or -not $Path.Trim()) { return $null }

        $full = $Path
        try { $full = [System.IO.Path]::GetFullPath($Path) } catch { }

        # 文件不在了就不记 —— 图库是索引，索引指向不存在的东西毫无意义
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $null }

        if (@('ring', 'agent', 'adopted') -notcontains $Source) { $Source = 'ring' }

        $stamp = [DateTimeOffset]::Now
        if ($CreatedAt) {
            try { $stamp = [DateTimeOffset]::Parse([string]$CreatedAt) } catch { }
        }

        if ($Bytes -le 0) {
            try { $Bytes = [int](Get-Item -LiteralPath $full -ErrorAction Stop).Length } catch { $Bytes = 0 }
        }

        $index = Read-GalleryIndex
        $existing = Find-GalleryItem -Path $full -Index $index

        if ($existing) {
            # 同一条路径重复记录：**更新而不是追加**。
            # 提示词可能这次才填上（收编进来的旧记录是空的），
            # 或者用户拿同一张图又生成了一次。
            if ($Prompt) { $existing.prompt = $Prompt }
            if ($Model)  { $existing.model  = $Model }
            if ($Ratio)  { $existing.ratio  = $Ratio }
            if ($Size)   { $existing.size   = $Size }
            if ($Bytes -gt 0) { $existing.bytes = $Bytes }
            $existing.source = $Source
            $existing.hidden = $false      # 用户又在用这张了，从图库里放出来
            [void](Write-GalleryIndex -Index $index)
            return $existing
        }

        $item = @{
            id        = Get-GalleryId -Path $full
            path      = $full
            prompt    = $Prompt
            model     = $Model
            ratio     = $Ratio
            size      = $Size
            source    = $Source
            ts        = [int]$stamp.ToUnixTimeSeconds()
            createdAt = $stamp.ToString('o')
            bytes     = $Bytes
            hidden    = $false
        }

        $index['items'] = @($index['items']) + $item
        [void](Write-GalleryIndex -Index $index)
        return $item
    } catch {
        Write-CrashLog "图库记录失败（不影响出图）: $($_.Exception.Message)"
        return $null
    }
}

function Add-GalleryRecords {
    param($Records)

    $added = 0
    foreach ($r in @($Records)) {
        if (-not $r -or -not $r['Path']) { continue }
        $item = Add-GalleryRecord -Path ([string]$r['Path']) -Prompt ([string]$r['Prompt']) `
            -Model ([string]$r['Model']) -Ratio ([string]$r['Ratio']) `
            -Size ([string]$r['Size']) -Source ([string]$r['Source'])
        if ($item) { $added++ }
    }
    return $added
}

function Set-GalleryHidden {
    param([string]$Id, [bool]$Hidden = $true)

    $index = Read-GalleryIndex
    $item = Find-GalleryItemById -Id $Id -Index $index
    if (-not $item) { return $false }
    $item.hidden = $Hidden
    return (Write-GalleryIndex -Index $index)
}

function Remove-GalleryRecord {
    param([string]$Id, [switch]$DeleteFile, [string]$AllowedRoot = '')

    $index = Read-GalleryIndex
    $item = Find-GalleryItemById -Id $Id -Index $index
    if (-not $item) { return $false }

    if ($DeleteFile) {
        if (Test-GalleryPathSafe -Path $item.path -Root $AllowedRoot) {
            try { Remove-Item -LiteralPath $item.path -Force -ErrorAction Stop } catch { }
        }
    }

    $kept = @()
    foreach ($it in @($index['items'])) {
        if ($it.id -ne $Id) { $kept += $it }
    }
    $index['items'] = $kept
    return (Write-GalleryIndex -Index $index)
}

# 把文件已经不在的记录清掉，返回清掉的条数。
#
# **父目录不在了就保留记录。** 出图目录可能被指到移动硬盘或网盘，
# 那台设备没插的时候 Test-Path 对里面每个文件都返回假 —— 直接清
# 等于用户拔一次盘就丢掉全部历史。
function Repair-GalleryIndex {
    $index = Read-GalleryIndex
    $kept = @()
    $dropped = 0

    foreach ($it in @($index['items'])) {
        if (-not $it) { continue }
        $parent = ''
        try { $parent = [System.IO.Path]::GetDirectoryName($it.path) } catch { }

        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            $kept += $it          # 目录都够不着，不是「文件没了」
        } elseif (Test-Path -LiteralPath $it.path -PathType Leaf) {
            $kept += $it
        } else {
            $dropped++
        }
    }

    if ($dropped -gt 0) {
        $index['items'] = $kept
        [void](Write-GalleryIndex -Index $index)
    }
    return $dropped
}

# ============================================================
#  清理
# ============================================================

# 删文件之前的三重校验。**索引是用户能手改的 JSON** ——
# 少了这三条，手改一行 C:\Windows\System32\... 进去，
# 整个函数就变成了一个任意文件删除器。
function Test-GalleryPathSafe {
    param([string]$Path, [string]$Root)

    if (-not $Path -or -not $Root) { return $false }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
        $fullRoot = [System.IO.Path]::GetFullPath($Root)

        # 根目录必须带尾部分隔符再比前缀。
        # 字符串 -like 'C:\x\幻梦AI*' 会把 C:\x\幻梦AI2\ 也算进去。
        $sep = [System.IO.Path]::DirectorySeparatorChar
        if (-not $fullRoot.EndsWith([string]$sep)) { $fullRoot = $fullRoot + $sep }

        if (-not $fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }

        # 目录本身不算文件
        if (Test-Path -LiteralPath $fullPath -PathType Container) { return $false }

        $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
        if ($script:GalleryImageExt -notcontains $ext) { return $false }

        return $true
    } catch {
        return $false
    }
}

# 只算不删：算出哪些该从图库里收起来。
#
# $Policy 的形状（调用方从配置拼）：@{ Mode='count'; MaxCount=200; MaxDays=90 }
function Get-GalleryPrunePlan {
    param($Policy)

    $mode = 'count'
    $maxCount = 200
    $maxDays = 90
    if ($Policy) {
        if ($Policy['Mode']) { $mode = [string]$Policy['Mode'] }
        # **判断写 $null -ne 而不是直接 if($值)。** 0 在 PowerShell 里是假值，
        # 写成 if($Policy['MaxCount']) 的话「保留 0 张」（= 全部收起）
        # 会被静默忽略、退回默认的 200 —— 从外面完全看不出来。
        try {
            $v = $Policy['MaxCount']
            if ($null -ne $v -and "$v".Trim()) { $maxCount = [int]$v }
        } catch { }
        try {
            $v = $Policy['MaxDays']
            if ($null -ne $v -and "$v".Trim()) { $maxDays = [int]$v }
        } catch { }
    }

    $result = @{ Hide = @(); Kept = 0; Mode = $mode }

    $items = Get-GalleryItems          # 已按 ts 倒序，且不含已收起的
    if ($mode -eq 'off') {
        $result.Kept = $items.Count
        return $result
    }

    $cutoff = 0
    try { $cutoff = [DateTimeOffset]::Now.AddDays(-1 * $maxDays).ToUnixTimeSeconds() } catch { }

    $hide = @()
    for ($i = 0; $i -lt $items.Count; $i++) {
        $over = $false
        if ($mode -eq 'count' -or $mode -eq 'both') {
            if ($i -ge $maxCount) { $over = $true }
        }
        if ($mode -eq 'days' -or $mode -eq 'both') {
            $ts = [int]$items[$i].ts
            if ($ts -gt 0 -and $ts -lt $cutoff) { $over = $true }
        }
        if ($over) { $hide += $items[$i].id } else { $result.Kept = $result.Kept + 1 }
    }

    $result.Hide = $hide
    return $result
}

# 执行清理。
#
# 默认（$DeleteFiles 关）只把记录标成 hidden：**磁盘上的图一个都不动**。
# 打开删除开关时必须同时给出 $AllowedRoot，否则一律拒绝删 —— 宁可少删，
# 也不能因为调用方忘了传目录就删到别处去。
function Invoke-GalleryPrune {
    param($Policy, [string]$AllowedRoot = '', [switch]$DeleteFiles)

    $out = @{ Hidden = 0; Deleted = 0; Failed = 0 }

    try {
        $plan = Get-GalleryPrunePlan -Policy $Policy
        $hideIds = @($plan.Hide)
        if ($hideIds.Count -eq 0) { return $out }

        $index = Read-GalleryIndex
        foreach ($id in $hideIds) {
            $item = Find-GalleryItemById -Id $id -Index $index
            if (-not $item) { continue }

            $item.hidden = $true
            $out.Hidden = $out.Hidden + 1

            if (-not $DeleteFiles) { continue }

            if (Test-GalleryPathSafe -Path $item.path -Root $AllowedRoot) {
                try {
                    Remove-Item -LiteralPath $item.path -Force -ErrorAction Stop
                    $out.Deleted = $out.Deleted + 1
                } catch {
                    $out.Failed = $out.Failed + 1
                }
            } else {
                # 路径不在出图目录里、或者不是图片 —— 只收起记录，不动文件
                $out.Failed = $out.Failed + 1
            }
        }

        [void](Write-GalleryIndex -Index $index)
    } catch {
        Write-CrashLog "图库清理失败: $($_.Exception.Message)"
    }

    return $out
}

# ============================================================
#  收编旧图
# ============================================================

# 扫出图目录里**还没有被记录过**的图。
#
# **纯函数**：不读 $script:Cfg、不写盘、只依赖参数，所以能安全地在后台
# runspace 里跑（出图目录常被 OneDrive 接管，几秒的目录扫描放绘制路径上
# 就是卡死）。
#
# 返回值是哈希表而不是数组：数组经管道返回会被摊开，只有一项时调用方
# 拿到的是那个元素本身而不是数组。
function Get-GalleryScan {
    param(
        [string]$Folder,
        $Known,                       # HashSet[string]，大小写不敏感
        [int]$Max = 500
    )

    $out = @{ Records = @(); Scanned = 0; Truncated = $false }

    # $Max 给 0 或负数时不能当成「不限量」—— 下面那个 `-gt $Max` 判断会
    # 永远不成立，等于把整个目录收进来。回落到默认值。
    if ($Max -le 0) { $Max = 500 }

    if (-not $Folder -or -not (Test-Path -LiteralPath $Folder)) { return $out }

    $found = @()
    # 按扩展名分次用 -Filter 枚举，走文件系统的快路径。
    # 不用 -Include：它要先枚举整个目录再筛，在几万文件的目录上是灾难。
    foreach ($ext in $script:GalleryImageExt) {
        try {
            $found += @(Get-ChildItem -LiteralPath $Folder -File -Filter "幻梦AI-*$ext" -ErrorAction SilentlyContinue)
        } catch { }
    }

    $out.Scanned = $found.Count
    if ($found.Count -eq 0) { return $out }

    # **只收自己命名的文件。** 出图目录是配置项，可以被指到 D:\图片
    # 这种大目录；无条件收编会把用户几万张私人照片灌进图库。
    # 上面那个 -Filter 已经限定了前缀，这里再挡一道是为了防手改配置
    # 把别的命名规则引进来时误伤。
    $candidates = @()
    foreach ($f in $found) {
        if ($f.Name -notlike '幻梦AI-*') { continue }
        if ($script:GalleryImageExt -notcontains $f.Extension.ToLower()) { continue }
        if ($Known -and $Known.Contains($f.FullName)) { continue }
        $candidates += $f
    }

    if ($candidates.Count -eq 0) { return $out }

    # 新的在前
    $candidates = @($candidates | Sort-Object -Property LastWriteTime -Descending)

    if ($candidates.Count -gt $Max) {
        $out.Truncated = $true
        $candidates = @($candidates[0..($Max - 1)])
    }

    $records = @()
    foreach ($f in $candidates) {
        $stamp = [DateTimeOffset]$f.LastWriteTime
        $records += @{
            Path      = $f.FullName
            Prompt    = ''
            Model     = ''
            Ratio     = ''
            Size      = ''
            Source    = 'adopted'
            CreatedAt = $stamp.ToString('o')
            Bytes     = [int]$f.Length
        }
    }

    $out.Records = $records
    return $out
}

# 把扫描结果并进索引。主线程调（后台只负责扫）。
function Merge-GalleryAdoption {
    param($Records)

    $added = 0
    foreach ($r in @($Records)) {
        if (-not $r -or -not $r['Path']) { continue }
        $item = Add-GalleryRecord -Path ([string]$r['Path']) -Source 'adopted' `
            -CreatedAt $r['CreatedAt'] -Bytes ([int]$r['Bytes'])
        if ($item) { $added++ }
    }
    return $added
}

# ============================================================
#  显示
# ============================================================

function Get-GallerySourceLabel {
    param([string]$Source)

    switch ($Source) {
        'ring'  { return '圆环出图' }
        'agent' { return 'Agent 出图' }
        default { return '未知来源' }
    }
}

function Get-GalleryTimeText {
    param($Item)

    if (-not $Item -or [int]$Item.ts -le 0) { return '' }
    try {
        $t = [DateTimeOffset]::FromUnixTimeSeconds([long]$Item.ts).LocalDateTime
        if ($t.Date -eq (Get-Date).Date) { return $t.ToString('HH:mm') }
        return $t.ToString('M-d HH:mm')
    } catch {
        return ''
    }
}

# 圆环扇区上那行字。
#
# 16 项时扇区只有约 11 个汉字的宽度（见 Menu.ps1 里每层封顶 16 的注释），
# 所以这里必须狠着截；完整信息靠 hub 悬停时的 Detail 字段显示。
function Format-GalleryLabel {
    param($Item, [int]$MaxPrompt = 6)

    if (-not $Item) { return '' }

    $time = Get-GalleryTimeText -Item $Item

    # **标签里绝不能有换行。** 扇区文字是单行 NoWrap 画的，
    # 提示词里真出现一个回车就会和 GDI+ 的参数语义打架。
    $text = ([string]$Item.prompt) -replace '[\r\n\t]+', ' '
    $text = $text.Trim()

    if ($text.Length -gt $MaxPrompt) {
        $cut = $MaxPrompt
        # 别把代理对（emoji 之类）劈成两半 —— 劈开在 GDI+ 里画出来是个空框
        if ($cut -gt 0 -and [char]::IsHighSurrogate($text[$cut - 1])) { $cut-- }
        $text = $text.Substring(0, $cut) + '…'
    }

    if (-not $text) { $text = Get-GallerySourceLabel -Source ([string]$Item.source) }
    if ($time) { return "$time $text" }
    return $text
}

# hub 悬停时显示的完整信息
function Format-GalleryDetail {
    param($Item)

    if (-not $Item) { return '' }
    $parts = @()
    $time = Get-GalleryTimeText -Item $Item
    if ($time) { $parts += $time }
    if ($Item.prompt) { $parts += ([string]$Item.prompt -replace '[\r\n\t]+', ' ') }
    else { $parts += (Get-GallerySourceLabel -Source ([string]$Item.source)) }
    if ($Item.model) { $parts += [string]$Item.model }
    if ($Item.size)  { $parts += [string]$Item.size }
    return ($parts -join ' · ')
}

# 气泡提示行：第 3 / 20 张 · 时间 · 模型 · 分辨率
function Format-GalleryStamp {
    param($Item, [int]$Index = -1, [int]$Total = 0)

    $parts = @()
    if ($Index -ge 0 -and $Total -gt 0) { $parts += "第 $($Index + 1) / $Total 张" }

    if ($Item) {
        $t = Get-GalleryTimeText -Item $Item
        if ($t) { $parts += $t }
        if ($Item.prompt) {
            $p = ([string]$Item.prompt -replace '[\r\n\t]+', ' ').Trim()
            if ($p.Length -gt 18) {
                $cut = 18
                if ([char]::IsHighSurrogate($p[$cut - 1])) { $cut-- }
                $p = $p.Substring(0, $cut) + '…'
            }
            $parts += $p
        }
        if ($Item.model) { $parts += [string]$Item.model }
        if ($Item.size)  { $parts += [string]$Item.size }
    }

    return ($parts -join ' · ')
}

# ============================================================
#  临时文件清理
# ============================================================

# 清 %TEMP% 下三类没人管的中间产物。
#
# 在此之前它们无限堆积：每出一张图、每截一次屏都留一个，
# 用久了 %TEMP% 里几千个文件。
#
# **只认这三种精确的 glob。** %TEMP% 根下还躺着
# huanmeng-ring-crash.log 和 huanmeng-ring-debug.log，
# 千万别图省事写 -Include '*huanmeng*' —— 那是排障时唯一的线索。
function Invoke-GalleryTempSweep {
    param(
        [int]$MinAgeMinutes = 30,
        [int]$MaxFiles = 500,
        [string[]]$KeepPaths = @()
    )

    $out = @{ Deleted = 0; Kept = 0; Failed = 0 }

    try {
        $temp = [System.IO.Path]::GetTempPath()
        $targets = @(
            @{ Dir = (Join-Path $temp 'HuanmengRing'); Pattern = 'gen-*.png' }
            @{ Dir = $temp;                             Pattern = 'agent-*.png' }
            @{ Dir = $temp;                             Pattern = 'huanmeng-shot-*.png' }
        )

        # 正在用的文件一个都不能删 —— 用户刚截的图、正在气泡里看的图、
        # 挂着的参考图，删掉就是「东西凭空消失」。
        # **大小写不敏感**：Windows 路径本来就不区分大小写。
        $keep = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($p in @($KeepPaths)) { if ($p) { [void]$keep.Add([string]$p) } }
        try {
            foreach ($it in @((Read-GalleryIndex)['items'])) {
                if ($it -and $it.path) { [void]$keep.Add([string]$it.path) }
            }
        } catch { }

        $cutoff = (Get-Date).AddMinutes(-1 * $MinAgeMinutes)
        $budget = $MaxFiles

        foreach ($t in $targets) {
            if ($budget -le 0) { break }
            if (-not (Test-Path -LiteralPath $t.Dir)) { continue }

            $files = @()
            try {
                $files = @(Get-ChildItem -LiteralPath $t.Dir -File -Filter $t.Pattern -ErrorAction SilentlyContinue)
            } catch { continue }

            foreach ($f in $files) {
                if ($budget -le 0) { break }

                # 年龄门槛：太新的不动。这挡掉「后台正在写的那张图」——
                # Invoke-GrsImage 是先落盘再改名，中间那一瞬它也在候选里。
                if ($f.LastWriteTime -gt $cutoff) { $out.Kept = $out.Kept + 1; continue }
                if ($keep.Contains($f.FullName)) { $out.Kept = $out.Kept + 1; continue }

                try {
                    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
                    $out.Deleted = $out.Deleted + 1
                    $budget--
                } catch {
                    # 被别的进程占着就跳过。一个删不掉不能中断整轮
                    $out.Failed = $out.Failed + 1
                }
            }
        }
    } catch {
        Write-CrashLog "临时文件清理失败: $($_.Exception.Message)"
    }

    return $out
}
