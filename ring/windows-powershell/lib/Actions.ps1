# ============================================================
#  Actions.ps1 — 圆环指令的分发与执行
#
#  两条路：
#    · 插件连上了 → 大部分动作转发给插件（出图、读选区、切页、面板对话）。
#      好处是参数、提示词、聊天记录都只有一份，圆环和面板永远一致。
#    · 插件没连上 → 助手自己干（自己调接口出图、自己攒对话记录、自己存盘）。
#      这是「完全脱离 Photoshop 单独用」那条路。
#
#  「暂存」(staged) 是这里最要紧的概念：提示词和参考图可以先后凑齐
#  （先截屏再套预设，或者先套预设再截屏），凑齐之前一直挂着。
# ============================================================

$script:Staged = @{
    Prompt    = ''    # 当前挂着的提示词
    Image     = ''    # 当前挂着的参考图路径
    ImageName = ''    # 参考图显示名（气泡底部要显示）
    PresetName = ''   # 预设名（气泡底部要显示）
    LastImage = ''    # 上一次用过的参考图，「用上次的图」靠它
}
$script:LastResultPath = ''

# 正在生成的那张图的元数据快照。出图是异步的，完成回调跑起来时
# 用户可能已经改了提示词 —— 所以发起时就存下来，回来时直接用（见 Start-StandaloneGenerate）。
# 用掉或者失败都要清空：留着会挂到下一张成功的图上。
$script:PendingGen = $null

$script:ChatLocal = @{
    History      = @()
    Model        = ''
    Busy         = $false
    LastQuestion = ''
    LastReply    = ''
}
$script:ChatPendingQuestion = ''

# 上一次「用户从圆环上发起动作」的时间。
# 插件的 progress 事件分不清是自己点面板触发的还是圆环触发的 ——
# 点面板时面板自己有进度条，再弹一个托盘气泡纯属打扰；
# 从圆环发起时才需要托盘把结果报回来。靠这个时间戳区分。
$script:LastRingActionAt = $null

$script:ShotWatch = @{ Active = $false; Since = $null; Seen = @{} }

# ============================================================
#  分发
# ============================================================

function Invoke-MenuAction {
    param([string]$Action, $Payload)

    if (-not $Payload) { $Payload = @{} }

    # 记一笔「这次是圆环发起的」，进度回来时才知道该不该弹托盘（见 Receive-PluginProgress）
    $script:LastRingActionAt = Get-Date

    switch -Regex ($Action) {

        '^noop$|^close$' { return }

        '^setParam$'   { Invoke-ActionSetParam -Payload $Payload; return }
        '^applyPreset$' { Invoke-ActionApplyPreset -Payload $Payload; return }
        '^generate$'   { Invoke-ActionGenerate; return }
        '^promptText$' { Invoke-ActionPromptText; return }
        '^pickImage$'  { Invoke-ActionPickImage; return }
        '^screenshot$' { Invoke-ActionScreenshot; return }
        '^reuseLast$'  { Invoke-ActionReuseLast; return }

        '^readSelection$' { Invoke-ActionReadSelection; return }
        '^clearPrompt$'   { Invoke-ActionClearPrompt; return }

        # 图库。'^gallery$' 的 $ 锚点保证它不会吃掉 galleryShow 这类 ——
        # switch -Regex 是**第一个匹配胜出**，少个锚点就会全落到它身上。
        '^gallery$'           { Invoke-ActionGallery; return }
        '^galleryShow$'       { Invoke-ActionGalleryShow -Payload $Payload; return }
        '^galleryOpenFolder$' { Invoke-ActionGalleryOpenFolder; return }
        '^galleryAdopt$'      { Invoke-ActionGalleryAdopt; return }
        '^galleryCleanup$'    { Invoke-ActionGalleryCleanup; return }
        '^galleryUseRef$'     { Invoke-ActionUseAsReference -Path ([string]$Payload.path); return }

        '^agentAsk$'    { Invoke-ActionAgentAsk -Prompt ([string]$Payload.prompt); return }
        '^chatType$'    { Invoke-ActionChatType; return }
        '^chatAsk$'     { Invoke-ActionChatAsk -Prompt ([string]$Payload.prompt); return }
        '^chatHistory$' { Invoke-ActionChatHistory; return }
        '^chatNew$'     { Invoke-ActionChatNew; return }
        '^chatModel$'   { Invoke-ActionChatModel -Value ([string]$Payload.value); return }
        '^openChat$'    { Invoke-ActionOpenChat; return }
        '^tab:'         { Invoke-ActionTab -Tab $Action.Substring(4); return }
    }

    if ($script:Notify) { & $script:Notify "未知指令：$Action" 'warn' }
}

# ============================================================
#  参数
# ============================================================

function Invoke-ActionSetParam {
    param($Payload)

    $key = [string]$Payload.key
    $value = $Payload.value
    if (-not $key) { return }

    # 本地也记一份。插件连上时以插件为准，但插件没连上时
    # 出图用的就是本地这份 —— 两边都更新才不会「圆环上显示 2K，实际按 1K 出」。
    switch ($key) {
        'model'      { $script:Cfg.api.imgModel  = [string]$value }
        'resolution' { $script:Cfg.api.imageSize = [string]$value }
        'count'      { $script:Cfg.api.imageCount = [int]$value }
    }
    Save-Config -Config $script:Cfg

    if (Test-PluginConnected) {
        # 插件那边的 applyParam 是按「键名直接展开」解析的（Object.keys(payload)），
        # 所以要发 @{model='x'} 而不是 @{key='model';value='x'}
        $mapped = @{}
        switch ($key) {
            'model'      { $mapped['model'] = [string]$value }
            'resolution' { $mapped['resolution'] = [string]$value }
            'count'      { $mapped['count'] = [int]$value }
        }
        [void](Send-BridgeCommand -Action 'setParam' -Payload $mapped)
    } else {
        $label = @{ model = '模型'; resolution = '分辨率'; count = '张数' }[$key]
        if ($script:Notify) { & $script:Notify "$label 已设为 $value" 'ok' }
    }
}

# ============================================================
#  预设
# ============================================================

# 预设动作的三种模式（配置里存英文键，界面上显示中文，靠下面两个函数互译）
$script:PresetActionModes = @('both', 'clipboard', 'apply')

function Get-PresetActionMode {
    $mode = ''
    try { $mode = [string]$script:Cfg.content.presetAction } catch { $mode = '' }
    if ($script:PresetActionModes -contains $mode) { return $mode }
    # 读不出来、或者配置被手改坏了，一律按默认走。
    # **不能靠"两个分支都不进"来兜底** —— 那就成了「点了没反应」，最难查。
    return 'both'
}

function Get-PresetActionLabel {
    param([string]$Mode)
    switch ([string]$Mode) {
        'clipboard' { return '只复制到剪贴板' }
        'apply'     { return '只套用到插件' }
        default     { return '复制到剪贴板 + 套用' }
    }
}

function Get-PresetActionModeFromLabel {
    param([string]$Label)
    switch ([string]$Label) {
        '只复制到剪贴板' { return 'clipboard' }
        '只套用到插件'   { return 'apply' }
        default          { return 'both' }
    }
}

# 把一段文本放进剪贴板，成功返回 $true。
#
# 用 WinForms 的剪贴板而不是 Set-Clipboard：同一个文件里读截图
# （Clipboard::ContainsImage）走的就是它，已验证可用，圆环主线程也是 STA。
# 外面套 try/catch 是因为剪贴板可能被别的程序占着 —— 偶发的 OpenClipboard 失败
# 不该把整个「套用预设」流程带崩，更不该谎报成功。
function Set-ClipboardText {
    param([string]$Text)

    if (-not $Text) { return $false }
    try {
        [System.Windows.Forms.Clipboard]::SetText($Text)
        return $true
    } catch {
        # 再试一条路：Set-Clipboard 内部会自己重试几次
        try {
            Set-Clipboard -Value $Text -ErrorAction Stop
            return $true
        } catch {
            return $false
        }
    }
}

function Invoke-ActionApplyPreset {
    param($Payload)

    $name = [string]$Payload.name
    $prompt = [string]$Payload.prompt
    # 分类也要带上：预设名字能重复（自带那份里就有两条《面部精修》），
    # 插件只按名字找会命中排在前面的那一条 —— 于是「圆环给的是这条、
    # 插件套的是那条」，用户看到的就是「复制不全」。
    $category = [string]$Payload.category
    $mode = Get-PresetActionMode

    $copied = $false
    $applied = $false

    # ---- 复制到剪贴板（both / clipboard）
    if ($mode -ne 'apply') {
        $copied = Set-ClipboardText -Text $prompt
    }

    # ---- 套用（both / apply）
    if ($mode -ne 'clipboard') {
        $script:Staged.Prompt = $prompt
        $script:Staged.PresetName = $name

        if (Test-PluginConnected) {
            # 走插件的 applyPreset 而不是自己塞提示词：插件那边会把预设下拉也一起选中，
            # 面板上看到的和圆环选的一致
            [void](Send-BridgeCommand -Action 'applyPreset' -Payload @{ name = $name; category = $category })
        }
        $applied = $true
    }

    # 提示必须说清**这一次到底做了什么**。
    # 复制失败却报「已复制」的话，用户会一直粘出上一次的旧内容，
    # 然后来问「为什么复制的是错的」—— 那是最难查的一类反馈。
    $parts = @()
    if ($mode -ne 'apply') {
        $parts += $(if ($copied) { '已复制到剪贴板' } else { '复制失败（剪贴板可能被占用）' })
    }
    if ($applied) { $parts += '已套用' }
    $kind = if (($mode -ne 'apply') -and (-not $copied)) { 'warn' } else { 'ok' }
    if ($script:Notify) { & $script:Notify (($parts -join ' · ') + "：$name") $kind }

    # 只复制 → 到此为止。
    # **不要**再往下走弹提示词框：用户要的就是「选完自己去粘」，
    # 屏幕上再多一个框就是打扰。
    if ($mode -eq 'clipboard') { return }

    # 参考图还挂着就直接出图，这才是「截图 + 预设」最顺的用法；
    # 没参考图就把提示词摆出来让用户确认/补充
    if ($script:Staged.Image) { Invoke-ActionGenerate } else { Invoke-ActionPromptText }
}

# ============================================================
#  出图
# ============================================================

function Get-StagedSummary {
    $parts = @()
    if ($script:Staged.ImageName) { $parts += "参考图：$($script:Staged.ImageName)" }
    if ($script:Staged.PresetName) { $parts += "预设：$($script:Staged.PresetName)" }
    if ($parts.Count -eq 0) { return '' }
    return ($parts -join ' · ')
}

function Invoke-ActionGenerate {
    # 插件在线：把参数和提示词发给插件，由面板自己走它那套完整的出图流程
    if (Test-PluginConnected) {
        if (-not $script:Staged.Prompt) {
            Invoke-ActionPromptText
            return
        }
        $payload = @{
            prompt     = $script:Staged.Prompt
            model      = [string]$script:Cfg.api.imgModel
            resolution = [string]$script:Cfg.api.imageSize
            count      = [int]$script:Cfg.api.imageCount
        }
        if (Send-BridgeCommand -Action 'generate' -Payload $payload) {
            if ($script:Notify) { & $script:Notify '已交给 Photoshop 出图' 'ok' }
        } else {
            if ($script:Notify) { & $script:Notify '插件没接上，稍后再试' 'warn' }
        }
        return
    }

    # 独立出图
    if (-not $script:Staged.Prompt) {
        Invoke-ActionPromptText
        return
    }
    Start-StandaloneGenerate
}

function Invoke-ActionPromptText {
    $summary = Get-StagedSummary
    $hint = if ($summary) { "$summary · 回车生成 · Esc 取消" } else { '回车生成 · Shift+回车 换行 · Esc 取消' }

    Show-HuanmengBubble -Mode 'input' -Title '写提示词' `
        -Placeholder '描述你想要的画面…' `
        -InitialText $script:Staged.Prompt `
        -Hint $hint `
        -OnSubmit {
            param($text)
            $script:Staged.Prompt = $text
            Invoke-ActionGenerate
        }
}

function Invoke-ActionPickImage {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Filter = '图片|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif|所有文件|*.*'
    $dialog.Title = '选一张参考图'
    $dialog.InitialDirectory = [Environment]::GetFolderPath('MyPictures')

    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Set-StagedImage -Path $dialog.FileName
        Invoke-ActionPromptText
    }
    $dialog.Dispose()
}

function Set-StagedImage {
    param([string]$Path)

    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    $script:Staged.Image = $Path
    $script:Staged.ImageName = [System.IO.Path]::GetFileName($Path)
    $script:Staged.LastImage = $Path
}

function Invoke-ActionReuseLast {
    if (-not $script:Staged.LastImage) {
        if ($script:Notify) { & $script:Notify '还没有用过参考图' 'warn' }
        return
    }
    Set-StagedImage -Path $script:Staged.LastImage
    Invoke-ActionPromptText
}

function Invoke-ActionClearPrompt {
    $script:Staged.Prompt = ''
    $script:Staged.PresetName = ''
    if (Test-PluginConnected) { [void](Send-BridgeCommand -Action 'clearPrompt') }
    if ($script:Notify) { & $script:Notify '已清空提示词' 'ok' }
}

# ---------- 截屏接住 ----------

function Get-ScreenshotFolder {
    $candidates = @(
        (Join-Path ([Environment]::GetFolderPath('MyPictures')) 'Screenshots'),
        (Join-Path ([Environment]::GetFolderPath('MyPictures')) '屏幕截图')
    )
    foreach ($path in $candidates) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return $candidates[0]
}

function Invoke-ActionScreenshot {
    $folder = Get-ScreenshotFolder

    $script:ShotWatch.Active = $true
    $script:ShotWatch.Since = Get-Date
    $script:ShotWatch.Seen = @{}
    if (Test-Path -LiteralPath $folder) {
        foreach ($file in Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue) {
            $script:ShotWatch.Seen[$file.FullName] = $true
        }
    }

    if (-not $script:ShotPollTimer) {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 600
        $timer.Add_Tick({ Update-ScreenshotWatch })
        $script:ShotPollTimer = $timer
    }
    $script:ShotPollTimer.Start()

    Show-HuanmengBubble -Mode 'text' -Title '等你截图' -Width 430 -Height 200 `
        -Hint 'Esc 取消' `
        -InitialText @"
现在用你平时习惯的方式截图就行：

  · Win + Shift + S   （系统截图，会自动存到「图片\屏幕截图」）
  · Win + PrtScn      （整屏，自动存盘）
  · 微信 / QQ / Snipaste 等，只要**保存成文件**或**放进剪贴板**都能接住

截图目录：$folder

截好之后助手会自动接住，弹出写提示词的框。
"@
}

function Update-ScreenshotWatch {
    if (-not $script:ShotWatch.Active) { return }

    $since = $script:ShotWatch.Since
    $folder = Get-ScreenshotFolder
    $found = ''

    # 1) 先看剪贴板里的图。Windows 上「Win+Shift+S」默认就只进剪贴板，
    #    这条路覆盖了绝大多数人的截图习惯。
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
            $img = [System.Windows.Forms.Clipboard]::GetImage()
            if ($img) {
                $target = Join-Path ([System.IO.Path]::GetTempPath()) ("huanmeng-shot-{0}.png" -f (Get-Date).ToString('yyyyMMddHHmmss'))
                $img.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
                $img.Dispose()
                $found = $target
            }
        }
    } catch { }

    # 2) 再看截图目录里有没有新文件
    if (-not $found -and (Test-Path -LiteralPath $folder)) {
        $files = Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.LastWriteTime -ge $since -and $_.Extension -match '(?i)\.(png|jpg|jpeg|bmp|webp)$' } |
                 Sort-Object LastWriteTime -Descending
        foreach ($file in $files) {
            if ($script:ShotWatch.Seen.ContainsKey($file.FullName)) { continue }
            $found = $file.FullName
            break
        }
    }

    if (-not $found) {
        # 等太久就放弃，别让定时器一直跑着
        if (((Get-Date) - $since).TotalSeconds -gt 120) {
            Stop-ScreenshotWatch
            Hide-HuanmengBubble
            if ($script:Notify) { & $script:Notify '等截图超时了' 'warn' }
        }
        return
    }

    Stop-ScreenshotWatch
    Set-StagedImage -Path $found
    Hide-HuanmengBubble

    # 直接把提示词框弹出来。文档里那句「Esc 回圆环可选预设」就是这个意思 ——
    # 这时参考图已经挂上了，用户可以直接写提示词，也可以 Esc 回圆环套预设。
    Invoke-ActionPromptText
}

function Stop-ScreenshotWatch {
    $script:ShotWatch.Active = $false
    if ($script:ShotPollTimer) { $script:ShotPollTimer.Stop() }
}

# ---------- 独立出图 ----------

function Start-StandaloneGenerate {
    $cfg = $script:Cfg.api
    $key = [string]$cfg.grsApiKey

    if (-not $key -or -not $key.Trim()) {
        Show-HuanmengBubble -Mode 'text' -Title '还没有填密钥' -Width 460 -Height 240 `
            -Hint '菜单栏 ◎ → 打开配置文件' `
            -InitialText @"
助手要用你自己的 API 密钥才能出图。填法：

菜单栏 ◎ → 打开配置文件，把 api.grsApiKey 填上：

  "api": {
    "grsApiKey": "sk-你的密钥",
    "grsRegion": "domestic",
    "imgModel": "nano-banana-fast",
    "imageSize": "1K"
  }

改完保存，助手会自动重新读一次配置（不用重启）。
密钥是你自己向 AI 服务商买的，这个软件不含任何 AI 服务，只是个界面。
"@
        return
    }

    $outFolder = Get-OutputFolder -Configured ([string]$cfg.outputFolder)
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $outFile = Join-Path $outFolder "幻梦AI-$stamp.png"

    $refImages = @()
    if ($script:Staged.Image) {
        $data = Convert-ImageToDataUri -Path $script:Staged.Image
        if ($data) { $refImages = @($data) }
    }

    $arguments = @{
        ApiKey          = $key
        Region          = [string]$cfg.grsRegion
        Model           = [string]$cfg.imgModel
        Prompt          = [string]$script:Staged.Prompt
        ImageSize       = [string]$cfg.imageSize
        AspectRatio     = 'auto'
        ReferenceImages = $refImages
        OutFile         = $outFile
        MaxWaitSeconds  = 300
    }

    # **元数据在这一刻就要存下来。**
    # 等到完成回调里再读 $script:Staged.Prompt / $cfg.imgModel 已经晚了：
    # 出图要几十秒，这期间用户完全可能改了提示词、换了模型，
    # 那样就会把 B 图的提示词记到 A 头上，而且永远发现不了。
    $script:PendingGen = @{
        Prompt = [string]$script:Staged.Prompt
        Model  = [string]$cfg.imgModel
        Ratio  = [string]$arguments.AspectRatio
        Size   = [string]$cfg.imageSize
    }

    # 先把结果窗摆出来，图到了再填进去。
    # 反过来做（出完再弹窗）的话，用户对着「什么都没发生」等一分钟，会以为卡死了。
    $summary = Get-StagedSummary
    $hint = if ($summary) { "$summary · 生成中…" } else { '生成中…' }
    Show-HuanmengBubble -Mode 'result' -Title '正在生成' -Hint $hint -ImagePath ''

    $work = {
        param($ApiKey, $Region, $Model, $Prompt, $ImageSize, $AspectRatio, $ReferenceImages, $OutFile, $MaxWaitSeconds)
        Invoke-GrsImage -ApiKey $ApiKey -Region $Region -Model $Model -Prompt $Prompt `
            -ImageSize $ImageSize -AspectRatio $AspectRatio -ReferenceImages $ReferenceImages `
            -OutFile $OutFile -MaxWaitSeconds $MaxWaitSeconds
    }

    [void](Start-AsyncTask -Work $work -Arguments $arguments -OnDone {
        param($result)
        Complete-StandaloneGenerate -Result $result
    })
}

function Complete-StandaloneGenerate {
    param($Result)

    # **失败分支必须把这一笔清掉。** 不清的话它会挂到下一次成功的图上 ——
    # 张冠李戴的记录比没有记录更糟，$script:ChatPendingQuestion 就是这么坑过一回的。
    if ($null -eq $Result) {
        $script:PendingGen = $null
        Set-BubbleHint '生成失败：没有拿到结果'
        return
    }

    if (-not $Result.Ok) {
        $script:PendingGen = $null
        Hide-HuanmengBubble
        Show-HuanmengBubble -Mode 'text' -Title '出图失败' -Width 460 -Height 220 `
            -Hint 'Esc 关闭' -InitialText ([string]$Result.Error)
        return
    }

    $script:LastResultPath = [string]$Result.Path

    # **必须用 $Result.Path，不能用 $outFile。**
    # Invoke-GrsImage 内部会调 Repair-ImageExtension 按文件头改名 ——
    # GRS 实际回的是 JPEG，磁盘上那个文件多半叫 .jpg，
    # 用 $outFile 记下来的是一堆不存在的死链，而且不报错。
    if ($script:PendingGen) {
        [void](Add-GalleryRecord -Path ([string]$Result.Path) `
            -Prompt ([string]$script:PendingGen.Prompt) -Model ([string]$script:PendingGen.Model) `
            -Ratio ([string]$script:PendingGen.Ratio) -Size ([string]$script:PendingGen.Size) `
            -Source 'ring')
        $script:PendingGen = $null
    }

    Set-BubbleTitle '出图完成'
    Set-BubbleHint '另存为 / 打开文件夹 · Esc 关闭'
    Set-BubbleResultImage -Path ([string]$Result.Path)

    if ($script:Notify) { & $script:Notify '出图完成' 'ok' }
}

# ============================================================
#  读选区 / 面板
# ============================================================

function Invoke-ActionReadSelection {
    if (-not (Test-PluginConnected)) {
        if ($script:Notify) { & $script:Notify '读选区要 Photoshop 开着，并且插件已加载' 'warn' }
        return
    }
    [void](Send-BridgeCommand -Action 'readSelection')
}

function Invoke-ActionTab {
    param([string]$Tab)
    if (-not (Test-PluginConnected)) {
        if ($script:Notify) { & $script:Notify '切面板要 Photoshop 和插件都在' 'warn' }
        return
    }
    [void](Send-BridgeCommand -Action "tab:$Tab")
}

function Invoke-ActionOpenChat {
    if (-not (Test-PluginConnected)) {
        # 插件不在就开助手自己的对话窗 —— 这条正是「完全脱离 PS 单独用」
        Invoke-ActionChatType
        return
    }
    [void](Send-BridgeCommand -Action 'openChat')
}

# ============================================================
#  对话
# ============================================================

function Get-ChatModel {
    $cfgModel = ''
    if ($script:Cfg.api.chatModel) { $cfgModel = [string]$script:Cfg.api.chatModel }

    if (Test-PluginConnected) {
        $state = Get-PluginState
        if ($state -and $state.chat -and $state.chat.model) { return [string]$state.chat.model }
    }
    if ($script:ChatLocal.Model) { return $script:ChatLocal.Model }
    return $cfgModel
}

function Invoke-ActionChatType {
    $summary = Get-StagedSummary
    $hint = if ($summary) { "$summary · 回车发送 · Shift+回车 换行" } else { '回车发送 · Shift+回车 换行 · Esc 关闭' }

    Show-HuanmengBubble -Mode 'chat' -Title '对话' -Placeholder '想问点什么…' -Hint $hint `
        -OnSubmit { param($text) Invoke-ActionChatAsk -Prompt $text }

    Update-BubbleChat -History (Get-ChatHistoryForDisplay)
    Set-BubbleHint "模型：$(Get-ChatModel) · 回车发送"

    # 再把插件那份权威记录要过来。圆环自己攒的那份可能是空的
    # （助手刚重启过），或者用户这段时间是在面板里聊的 ——
    # 不拉一次的话，气泡打开是空的，看起来就像「对话记录丢了」。
    # 拉回来的内容走 OnPluginChat 的 history 分支刷新气泡。
    if (Test-PluginConnected) { [void](Send-BridgeCommand -Action 'chatHistory') }
}

function Get-ChatHistoryForDisplay {
    if (Test-PluginConnected) {
        $state = Get-PluginState
        # 插件的 state 里只带截断过的最近一问一答；完整记录要靠 chatHistory 指令拉。
        # 拉回来的那份会更新 $script:ChatLocal.History（见 OnPluginChat 的 history 分支）。
        return @($script:ChatLocal.History)
    }
    return @($script:ChatLocal.History)
}

function Invoke-ActionChatAsk {
    param([string]$Prompt)

    if (-not $Prompt -or -not $Prompt.Trim()) { return }
    $Prompt = $Prompt.Trim()
    $script:ChatPendingQuestion = $Prompt

    # 气泡没开就开一个
    if ((Get-BubbleMode) -ne 'chat') {
        Show-HuanmengBubble -Mode 'chat' -Title '对话' -Placeholder '想问点什么…' `
            -Hint '回车发送 · Shift+回车 换行 · Esc 关闭' `
            -OnSubmit { param($text) Invoke-ActionChatAsk -Prompt $text }
    }

    Set-BubbleHint "模型：$(Get-ChatModel) · 正在想…"

    if (Test-PluginConnected) {
        # 交给插件的对话：记录、上下文、模型选择都留在面板那一份里，
        # 免得圆环和面板各攒一份历史，用户在一边问的到另一边看不见
        Update-BubbleChat -History $script:ChatLocal.History -Pending $Prompt -BusyText '正在想…'
        [void](Send-BridgeCommand -Action 'chatAsk' -Payload @{ prompt = $Prompt })
        return
    }

    # 独立对话
    if ($script:ChatLocal.Busy) {
        Set-BubbleHint '上一条还在想，等它回来再说'
        return
    }

    $key = [string]$script:Cfg.api.grsApiKey
    if (-not $key -or -not $key.Trim()) {
        Hide-HuanmengBubble
        Show-HuanmengBubble -Mode 'text' -Title '还没有填密钥' -Width 460 -Height 200 `
            -Hint '菜单栏 ◎ → 打开配置文件' `
            -InitialText "对话也要用你自己的 API 密钥。`n`n菜单栏 ◎ → 打开配置文件 → 填 api.grsApiKey，保存即可。"
        return
    }

    $script:ChatLocal.Busy = $true
    Update-BubbleChat -History $script:ChatLocal.History -Pending $Prompt -BusyText '正在想…'

    # 只带最近若干轮。整段历史越滚越长，全发过去既慢又贵，
    # 而圆环里的对话基本都是「接着上一句」，不需要很久以前的上下文。
    $messages = @()
    $recent = @($script:ChatLocal.History)
    if ($recent.Count -gt 12) { $recent = @($recent[($recent.Count - 12)..($recent.Count - 1)]) }
    foreach ($item in $recent) {
        $messages += @{ role = $item.role; content = $item.text }
    }
    $messages += @{ role = 'user'; content = $Prompt }

    $arguments = @{
        ApiKey       = $key
        Region       = [string]$script:Cfg.api.grsRegion
        Model        = (Get-ChatModel)
        Messages     = $messages
        SystemPrompt = [string]$script:Cfg.api.systemPrompt
    }

    $work = {
        param($ApiKey, $Region, $Model, $Messages, $SystemPrompt)
        Invoke-GrsChat -ApiKey $ApiKey -Region $Region -Model $Model -Messages $Messages -SystemPrompt $SystemPrompt
    }

    [void](Start-AsyncTask -Work $work -Arguments $arguments -OnDone {
        param($result)
        Complete-LocalChat -Result $result
    })
}

function Complete-LocalChat {
    param($Result)

    $script:ChatLocal.Busy = $false
    $question = $script:ChatPendingQuestion
    $script:ChatPendingQuestion = ''

    if ($null -eq $Result -or -not $Result.Ok) {
        $errorText = if ($Result) { [string]$Result.Error } else { '没有拿到回复' }
        $script:ChatLocal.History += @{ role = 'user'; text = $question }
        $script:ChatLocal.History += @{ role = 'assistant'; text = "（出错）$errorText" }
        Set-BubbleHint '出错了'
        Update-BubbleChat -History $script:ChatLocal.History -BusyText ''
        if ($script:Notify) { & $script:Notify "对话出错：$errorText" 'error' }
        return
    }

    $script:ChatLocal.History += @{ role = 'user'; text = $question }
    $script:ChatLocal.History += @{ role = 'assistant'; text = [string]$Result.Reply }
    $script:ChatLocal.LastReply = [string]$Result.Reply

    Set-BubbleHint "模型：$(Get-ChatModel) · 回车继续问"
    Update-BubbleChat -History $script:ChatLocal.History
}

# ============================================================
#  Agent
# ============================================================

# 交给 agent 处理一句话。它自己决定要不要调工具、调哪个。
#
# 整个循环丢进后台 runspace —— 一次可能要调好几轮工具、
# 每轮几十秒，放主线程会把托盘和圆环冻住。
function Invoke-ActionAgentAsk {
    param([string]$Prompt)

    $Prompt = if ($Prompt) { $Prompt.Trim() } else { '' }

    # 从圆环菜单点「Agent」进来时**不带问题**（菜单项没有 payload），
    # 这里要开输入框让用户打字。
    #
    # 早先这句是无条件 `return`，于是点菜单里的「Agent」什么也不会发生 ——
    # 没有气泡、没有报错、托盘也没动静，从外面看就是「这个按钮是坏的」。
    if (-not $Prompt) {
        Show-HuanmengBubble -Mode 'chat' -Title 'Agent' -Placeholder '想让 agent 做什么…' `
            -Hint '回车发送 · Esc 关闭' `
            -OnSubmit { param($text) Invoke-ActionAgentAsk -Prompt $text }
        Update-BubbleChat -History $script:ChatLocal.History
        Set-BubbleHint 'Agent 会自己判断要不要调工具 · 回车发送'
        return
    }

    # 一次只跑一个。agent 一轮就是几十秒，并发两次的话两条回复会交错着
    # 写进同一份历史，看起来像串台。纯对话那条路有同样的守卫（见 Invoke-ActionChatAsk）。
    if ($script:ChatLocal.Busy) {
        Set-BubbleHint '上一条还在跑，等它回来再说'
        return
    }

    $key = [string]$script:Cfg.api.grsApiKey
    if (-not $key -or -not $key.Trim()) {
        Hide-HuanmengBubble
        Show-HuanmengBubble -Mode 'text' -Title '还没有填密钥' -Width 460 -Height 200 `
            -Hint '菜单栏 ◎ → 打开配置文件' `
            -InitialText "Agent 也要用你自己的 API 密钥。`n`n菜单栏 ◎ → 打开配置文件 → 填 api.grsApiKey，保存即可。"
        return
    }

    # 气泡没开就开一个，让用户看得见进展
    if ((Get-BubbleMode) -ne 'chat') {
        Show-HuanmengBubble -Mode 'chat' -Title 'Agent' -Placeholder '想让 agent 做什么…' `
            -Hint '回车发送 · Esc 关闭' `
            -OnSubmit { param($text) Invoke-ActionAgentAsk -Prompt $text }
    }

    # **必须记下来。** Complete-AgentAsk 靠它把用户这句补进历史，
    # 不设的话答完只剩助手那一句，用户问的原话凭空消失。
    $script:ChatPendingQuestion = $Prompt

    $script:ChatLocal.Busy = $true
    Update-BubbleChat -History $script:ChatLocal.History -Pending $Prompt -BusyText '正在想…'
    Set-BubbleHint 'Agent 正在处理…'

    # 预设表要随上下文传进去 —— 后台 runspace 读不到 $script:LocalPresets
    $presetList = @()
    try {
        foreach ($p in @(Get-PresetList)) {
            $presetList += @{ category = [string]$p.category; name = [string]$p.name }
        }
    } catch { }

    $context = @{
        apiKey      = $key
        region      = [string]$script:Cfg.api.grsRegion
        chatModel   = (Get-ChatModel)
        imgModel    = (Get-CurrentParam 'model')
        aspectRatio = (Get-CurrentParam 'aspectRatio')
        imageSize   = (Get-CurrentParam 'resolution')
        imageCount  = [string]$script:Cfg.api.imageCount
        presets     = $presetList
        # agent 出的图要落到这个目录（以前丢 %TEMP%，出了就找不着）。
        # 后台 runspace 读不到 $script:Cfg，必须随上下文传进去。
        outputFolder = [string]$script:Cfg.api.outputFolder
    }
    $history = @($script:ChatLocal.History)

    $work = {
        param($Prompt, $Context, $History)
        Invoke-AgentLoop -Prompt $Prompt -Context $Context -History $History
    }

    [void](Start-AsyncTask -Work $work `
        -Arguments @{ Prompt = $Prompt; Context = $context; History = $history } `
        -OnProgress {
            # 后台每报一次进度，就在气泡底下写一行 ——
            # agent 一跑几十秒，没有这个用户只会看到「正在处理…」一直不动
            param($text)
            if ((Get-BubbleMode) -eq 'chat') { Set-BubbleHint ([string]$text) }
        } `
        -OnDone { param($result) Complete-AgentAsk -Result $result })
}

function Complete-AgentAsk {
    param($Result)

    $script:ChatLocal.Busy = $false
    $question = $script:ChatPendingQuestion
    $script:ChatPendingQuestion = ''

    if ($null -eq $Result -or -not $Result.Ok) {
        $err = if ($Result) { [string]$Result.Error } else { '没有拿到回复' }
        $script:ChatLocal.History += @{ role = 'user'; text = $question }
        $script:ChatLocal.History += @{ role = 'assistant'; text = "（出错）$err" }
        Set-BubbleHint '出错了'
        Update-BubbleChat -History $script:ChatLocal.History -BusyText ''
        if ($script:Notify) { & $script:Notify "Agent 出错：$err" 'error' }
        return
    }

    $reply = [string]$Result.Reply
    $script:ChatLocal.History += @{ role = 'user'; text = $question }
    $script:ChatLocal.History += @{ role = 'assistant'; text = $reply }
    $script:ChatLocal.LastReply = $reply
    Update-BubbleChat -History $script:ChatLocal.History

    # 把 agent 这一轮出的图记进图库。
    # 位置必须在**失败守卫之后** —— $Result 为 $null 时读 .Records 会炸。
    # 那句 Where-Object 也不是多余的：Records 漏赋值时 @($null) 会产出
    # 一条 Path 为空的假记录。
    foreach ($rec in @($Result.Records)) {
        if (-not $rec -or -not $rec.Path) { continue }
        [void](Add-GalleryRecord -Path ([string]$rec.Path) -Prompt ([string]$rec.Prompt) `
            -Model ([string]$rec.Model) -Ratio ([string]$rec.Ratio) `
            -Size ([string]$rec.Size) -Source 'agent')
    }

    # 出图了就直接把图摆出来 —— agent 说「已生成」但用户看不到东西的话，
    # 他还得自己去翻输出目录
    $images = @($Result.Images)
    if ($images.Count -gt 0 -and (Test-Path -LiteralPath $images[0])) {
        Set-BubbleHint ("Agent 用了 $($Result.Steps) 轮 · 生成了 $($images.Count) 张图")
        Show-HuanmengBubble -Mode 'result' -Title 'Agent 出图' -ImagePath $images[0] -Hint '回车关闭 · Esc 关闭'
        return
    }

    Set-BubbleHint "Agent 用了 $($Result.Steps) 轮 · 回车继续问"
}

# ============================================================
#  图库
#
#  索引层在 Gallery.ps1。这里只做三件事：把配置读成策略对象、
#  把索引里的东西摆到气泡上、以及在后台跑收编。
# ============================================================

# 把 $script:Cfg 里的图库配置拼成一个策略对象。
# Gallery.ps1 里的函数一律不读 $script:Cfg（它们会被后台 dot-source），
# 配置都在这一层读好再传下去。
function Get-GalleryPolicy {
    $g = $script:Cfg.gallery
    return @{
        Mode        = [string]$g.mode
        MaxCount    = [int]$g.maxCount
        MaxDays     = [int]$g.maxDays
        RecentLimit = [int]$g.recentLimit
        DeleteFiles = [bool]$g.deleteFiles
    }
}

function Get-GalleryOutputFolder {
    return (Get-OutputFolder -Configured ([string]$script:Cfg.api.outputFolder))
}

# 点「图库」扇区。
#
# 正常走法是在圆环里压一层子菜单（扇区带 children），压根到不了这里。
# 这个分支是给「动作被单独触发」兜底的 —— 比如偏好设置里预览、
# 或者用户把某个扇区的动作改成了 gallery 却没配子菜单。
function Invoke-ActionGallery {
    # 先赋值再数 —— 见 Gallery.ps1 文件头那条 `,$array` 的坑
    $items = Get-GalleryRecent -Count 1
    if ($null -eq $items -or $items.Count -eq 0) {
        if ($script:Notify) { & $script:Notify '图库里还没有图。可以先用「打开目录」看看出图目录。' 'warn' }
        return
    }
    Invoke-ActionGalleryShow -Payload @{ id = $items[0].id; scope = 'recent' }
}

# 把某一张摆进结果气泡，并带上前后翻页的整份列表。
function Invoke-ActionGalleryShow {
    param($Payload)

    $id    = [string]$Payload.id
    $scope = [string]$Payload.scope
    $day   = [string]$Payload.day
    $policy = Get-GalleryPolicy

    # **列表必须和圆环上画的那一份完全同源。** 圆环按 scope 生成菜单、
    # 这里再按同一个 scope 生成一遍；用别的口径算的话，「下一张」会跳到
    # 用户压根没见过的图上，看起来像乱跳。
    # 先赋值再数（Gallery.ps1 文件头那条 `,$array` 的坑）
    if ($scope -eq 'day' -and $day) { $items = Get-GalleryByDay -Day $day }
    else { $items = Get-GalleryRecent -Count ([int]$policy.RecentLimit) }
    if ($null -eq $items) { $items = @() }

    if ($items.Count -eq 0) {
        if ($script:Notify) { & $script:Notify '图库里还没有图' 'warn' }
        return
    }

    $paths = @()
    $index = 0
    for ($i = 0; $i -lt $items.Count; $i++) {
        $paths += [string]$items[$i].path
        if ($items[$i].id -eq $id) { $index = $i }
    }

    $path = $paths[$index]
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        # 用户在资源管理器里删了。**不能静默继续** —— 结果窗会停在上一次
        # 那张图上（Set-BubbleResultImage 对不存在的路径是直接 return），
        # 看起来就是「点了没反应」。
        if ($script:Notify) { & $script:Notify '这张图已经不在了，可能被删掉或者移走了' 'warn' }
        return
    }

    Show-HuanmengBubble -Mode 'result' -Title '图库' -ImagePath $path `
        -GalleryIds $paths -GalleryIndex $index `
        -Hint (Format-GalleryStamp -Item $items[$index] -Index $index -Total $paths.Count)
}

function Invoke-ActionGalleryOpenFolder {
    $folder = Get-GalleryOutputFolder
    if (-not (Test-Path -LiteralPath $folder)) {
        if ($script:Notify) { & $script:Notify "出图目录还不存在：$folder" 'warn' }
        return
    }

    try {
        # 反引号转义路径 —— PowerShell 的转义符是反引号不是反斜杠。
        # 照抄 Bubble.ps1 里「打开文件夹」那段，别自己发明写法。
        Start-Process explorer.exe -ArgumentList "`"$folder`""
    } catch {
        if ($script:Notify) { & $script:Notify "打不开目录：$($_.Exception.Message)" 'error' }
    }
}

# 收编旧图。
#
# 扫描走后台 —— 出图目录默认是「图片\幻梦AI」，而 Windows 的「图片」目录
# 经常被 OneDrive 接管，几千个文件 stat 一遍是好几秒，放绘制路径上就是卡死。
function Start-GalleryAdoption {
    $folder = Get-GalleryOutputFolder
    $max = [int]$script:Cfg.gallery.maxAdopt
    if ($max -le 0) { $max = 500 }

    # 已知路径交给后台去重。**传字符串数组而不是 HashSet** ——
    # 虽然同一个进程里的 runspace 能共享对象引用，但跨 runspace 传自定义
    # 集合是没必要的风险，后台自己拿数组重建一个就行。
    $known = @()
    $all = Get-GalleryItems -IncludeHidden      # 先赋值再遍历，理由同上
    if ($null -eq $all) { $all = @() }
    foreach ($it in $all) {
        if ($it -and $it.path) { $known += [string]$it.path }
    }

    $work = {
        param($Folder, $KnownPaths, $Max)
        # 大小写不敏感的比较器不能省：Windows 上 C:\a.png 和 c:\A.PNG
        # 是同一个文件，默认的 HashSet 会把它们当成两个，重复收编。
        $set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($k in @($KnownPaths)) { if ($k) { [void]$set.Add([string]$k) } }
        Get-GalleryScan -Folder $Folder -Known $set -Max $Max
    }

    [void](Start-AsyncTask -Work $work -Arguments @{ Folder = $folder; KnownPaths = $known; Max = $max } -OnDone {
        param($scan)
        if ($null -eq $scan) { return }
        $added = Merge-GalleryAdoption -Records $scan.Records
        if ($script:Notify) {
            if ($added -gt 0) {
                $msg = "图库收录了 $added 张旧图"
                if ($scan.Truncated) { $msg += "（还有更多，可再点一次「收录旧图」）" }
                & $script:Notify $msg 'ok'
            } else {
                & $script:Notify '没有发现新的图片' 'ok'
            }
        }
    })
}

function Invoke-ActionGalleryAdopt {
    Start-GalleryAdoption
}

# 清理。
#
# **默认只从图库里「收起」老记录，磁盘上的图一个都不动。**
# 真要删文件得先在偏好设置里显式打开那个开关 —— 图是用户的作品，
# 不是我们的缓存。
function Invoke-ActionGalleryCleanup {
    $policy = Get-GalleryPolicy
    $plan = Get-GalleryPrunePlan -Policy $policy
    $count = @($plan.Hide).Count

    if ($count -eq 0) {
        if ($script:Notify) { & $script:Notify '图库已经是最新的了，没有要清理的' 'ok' }
        return
    }

    $delete = [bool]$policy.DeleteFiles
    $text = "会把 $count 张较早的图从图库里收起来。`n`n" +
            "图片文件本身不会被删除，在「打开目录」里还能找到。`n`n要继续吗？"
    if ($delete) {
        $text = "会**删除** $count 个图片文件，删了就找不回来了。`n`n确定吗？"
    }

    # 默认按钮选「否」。破坏性操作不能因为用户手快回车就执行 ——
    # 这是这个产品第一次真的动用户的文件，宁可多问一句。
    $answer = [System.Windows.Forms.MessageBox]::Show(
        $text, '幻梦圆环 · 清理图库',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2)

    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

    $out = Invoke-GalleryPrune -Policy $policy -AllowedRoot (Get-GalleryOutputFolder) -DeleteFiles:$delete

    $msg = "图库已收起 $($out.Hidden) 张"
    if ($out.Deleted -gt 0) { $msg += "，删除了 $($out.Deleted) 个文件" }
    if ($out.Failed -gt 0) { $msg += "，$($out.Failed) 个跳过（不在出图目录里或删不掉）" }
    if ($script:Notify) { & $script:Notify $msg 'ok' }
}

# 拿一张已有的图当参考图。
#
# 这是独立用的时候最要紧的一步：出图 → 看着还行 → 拿它再改一版。
# 完全复用「用上次的图」那条链 —— Set-StagedImage 顺手会把
# Staged.LastImage 记上，于是「用上次的图」也能直接用。
function Invoke-ActionUseAsReference {
    param([string]$Path)

    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($script:Notify) { & $script:Notify '这张图已经不在了，可能被删掉或者移走了' 'warn' }
        return
    }

    Hide-HuanmengBubble
    Set-StagedImage -Path $Path
    if ($script:Notify) { & $script:Notify '已设为参考图' 'ok' }
    Invoke-ActionPromptText
}

# ============================================================
#  插件推过来的事件
# ============================================================
#
# 这几个函数由主脚本挂到 Bridge 的回调上（见 HuanmengRing.ps1 里
# `$script:OnPluginChat = ...` 那一段）。
#
# **它们以前根本不存在。** Bridge.ps1 里写的是
# `if ($script:OnPluginChat) { ... }` —— 防御性写法，没人赋值也不报错，
# 于是插件发回来的东西全被丢掉了：用户在圆环里问一句，气泡停在
# 「正在想…」就再也没有下文；出图/读选区的进度提示也一样收不到。

# 插件发来的记录统一成 @( @{ role; text } )。
#
# 用点号取值而不是 $item['text']：桥接过来的可能是 PSCustomObject
# （ConvertFrom-Json 的产物），也可能是哈希表（深转换之后），
# 点号对两种都成立，索引只对后者成立。
function ConvertTo-ChatHistory {
    param($Raw)

    $out = @()
    if ($null -eq $Raw) { return $out }

    foreach ($item in @($Raw)) {
        if ($null -eq $item) { continue }
        $text = [string]$item.text
        if (-not $text) { continue }
        $role = 'assistant'
        if ([string]$item.role -eq 'user') { $role = 'user' }
        $out += @{ role = $role; text = $text }
    }
    return $out
}

function Receive-PluginChat {
    param([string]$ChatAction, $Payload)

    $history = @(ConvertTo-ChatHistory $(if ($Payload) { $Payload.history } else { $null }))
    $question = ''
    if ($Payload -and $Payload.question) { $question = [string]$Payload.question }

    switch ($ChatAction) {

        'thinking' {
            # 插件把「刚问出去的那句 + 之前的记录」一起发过来了。
            # 面板是发出请求之后才把问题记进历史的，所以这个阶段
            # extraUserText 那条得靠 Payload.question 补上
            if ($history.Count -gt 0) { $script:ChatLocal.History = $history }
            Update-BubbleChat -History $script:ChatLocal.History -Pending $question -BusyText '正在想…'
            Set-BubbleHint "模型：$(Get-ChatModel) · 正在想…"
        }

        'reply' {
            $text = ''
            if ($Payload -and $Payload.text) { $text = [string]$Payload.text }

            if ($history.Count -gt 0) {
                # 以面板那份为准 —— 圆环不自己攒，两边才不会分叉
                $script:ChatLocal.History = $history
            } else {
                # 插件没给记录（老版本）—— 自己补两条，总比空白强
                if ($question) { $script:ChatLocal.History += @{ role = 'user'; text = $question } }
                $script:ChatLocal.History += @{ role = 'assistant'; text = $text }
            }

            $script:ChatLocal.LastReply = $text
            $script:ChatLocal.Busy = $false
            Set-BubbleHint "模型：$(Get-ChatModel) · 回车继续问"
            Update-BubbleChat -History $script:ChatLocal.History
        }

        'error' {
            $reason = '提问失败'
            if ($Payload -and $Payload.message) { $reason = [string]$Payload.message }

            if ($history.Count -gt 0) { $script:ChatLocal.History = $history }
            # 出错信息不在面板的聊天记录里，**无条件补一条** ——
            # 只替换成 $history 的话，用户只看到自己问的那句，
            # 然后就没有下文了（托盘提示一闪而过，翻不回来）
            $script:ChatLocal.History += @{ role = 'assistant'; text = "（出错）$reason" }

            $script:ChatLocal.Busy = $false
            Set-BubbleHint '出错了'
            Update-BubbleChat -History $script:ChatLocal.History -BusyText ''
            if ($script:Notify) { & $script:Notify "对话出错：$reason" 'error' }
        }

        'history' {
            if ($history.Count -gt 0) {
                $script:ChatLocal.History = $history
                Update-BubbleChat -History $script:ChatLocal.History
            }
        }
    }
}

# 插件推了新的状态快照（参数、文档、预设都可能变了）。
function Receive-PluginState {
    param($State)

    if (-not $State) { return }

    # 气泡开着时顺手刷一下提示行：用户可能刚在面板里换了模型
    if ((Get-BubbleMode) -eq 'chat' -and -not $script:ChatLocal.Busy) {
        $pluginBusy = $false
        if ($State.chat -and $State.chat.busy) { $pluginBusy = $true }
        if (-not $pluginBusy) { Set-BubbleHint "模型：$(Get-ChatModel) · 回车发送" }
    }
}

# 出图 / 读选区 / 对话的进度。state = running | success | failure
function Receive-PluginProgress {
    param([string]$State, [string]$Message)

    if (-not $Message) { return }

    # 气泡开着就把话写在气泡底部，别再弹托盘
    if ((Get-BubbleMode) -ne '') {
        Set-BubbleHint $Message
        return
    }

    # 没气泡的时候才走托盘。**只在圆环发起的那次里报** ——
    # 用户在面板里点出图时面板自己有进度，再弹一个托盘纯属打扰。
    $fromRing = $false
    if ($script:LastRingActionAt) {
        $fromRing = ((Get-Date) - $script:LastRingActionAt).TotalSeconds -lt 30
    }
    if (-not $fromRing) { return }

    switch ($State) {
        'failure' { if ($script:Notify) { & $script:Notify $Message 'error' } }
        'success' { if ($script:Notify) { & $script:Notify $Message 'ok' } }
        default   { if ($script:Notify) { & $script:Notify $Message } }
    }
}

function Receive-BridgeConnected {
    Push-HuanmengStatus

    # 气泡要正开着，就连带要一份权威的对话记录 ——
    # 助手刚重启过的话自己那份是空的
    if ((Get-BubbleMode) -eq 'chat') { [void](Send-BridgeCommand -Action 'chatHistory') }
}

function Receive-BridgeDisconnected {
    Push-HuanmengStatus
    if ((Get-BubbleMode) -eq 'chat') { Set-BubbleHint '插件已断开 · 圆环会自己接着聊' }
}

function Invoke-ActionChatHistory {
    if (Test-PluginConnected) {
        # 圆环自己那份可能是空的（助手刚重启过），问插件要一份权威的
        [void](Send-BridgeCommand -Action 'chatHistory')
    }
    Invoke-ActionChatType
}

function Invoke-ActionChatNew {
    $script:ChatLocal.History = @()
    $script:ChatLocal.LastReply = ''
    $script:ChatPendingQuestion = ''

    if (Test-PluginConnected) { [void](Send-BridgeCommand -Action 'chatNew') }

    if ((Get-BubbleMode) -eq 'chat') { Update-BubbleChat -History @() }
    if ($script:Notify) { & $script:Notify '已开新对话' 'ok' }
}

function Invoke-ActionChatModel {
    param([string]$Value)

    if (-not $Value) { return }

    $script:ChatLocal.Model = $Value
    $script:Cfg.api.chatModel = $Value
    Save-Config -Config $script:Cfg

    if (Test-PluginConnected) {
        [void](Send-BridgeCommand -Action 'chatModel' -Payload @{ value = $Value })
    } else {
        if ($script:Notify) { & $script:Notify "对话模型已切到 $Value" 'ok' }
    }

    if ((Get-BubbleMode) -eq 'chat') { Set-BubbleHint "模型：$Value · 回车发送" }
}

# ============================================================
#  插件回调
# ============================================================

function On-PluginProgress {
    param([string]$State, [string]$Message, [string]$Thumbnail)

    if (-not $Message) { return }

    switch ($State) {
        'success' { if ($script:Notify) { & $script:Notify $Message 'ok' } }
        'failure' { if ($script:Notify) { & $script:Notify $Message 'error' } }
        default   { if ($script:Notify) { & $script:Notify $Message 'info' } }
    }
}

function On-PluginChat {
    param([string]$Action, $Payload)

    if ($null -eq $Payload) { return }

    # 插件推来的 history 是权威版本，覆盖本地那份 ——
    # 圆环不自己攒记录，免得和面板分叉
    if ($Payload.history) {
        $list = @()
        foreach ($item in @($Payload.history)) {
            $role = if ([string]$item.role -eq 'user') { 'user' } else { 'assistant' }
            $list += @{ role = $role; text = [string]$item.text }
        }
        $script:ChatLocal.History = $list
    }

    switch ($Action) {
        'history' {
            if ((Get-BubbleMode) -eq 'chat') { Update-BubbleChat -History $script:ChatLocal.History }
        }
        'thinking' {
            $script:ChatPendingQuestion = [string]$Payload.question
            if ((Get-BubbleMode) -ne 'chat') {
                Show-HuanmengBubble -Mode 'chat' -Title '对话' -Placeholder '接着问…' `
                    -Hint '回车发送 · Esc 关闭' `
                    -OnSubmit { param($text) Invoke-ActionChatAsk -Prompt $text }
            }
            Set-BubbleHint "模型：$(Get-ChatModel) · 正在想…"
            Update-BubbleChat -History $script:ChatLocal.History -Pending $script:ChatPendingQuestion -BusyText '正在想…'
        }
        'reply' {
            $script:ChatPendingQuestion = ''
            $script:ChatLocal.LastReply = [string]$Payload.text
            Set-BubbleHint "模型：$(Get-ChatModel) · 回车继续问"
            Update-BubbleChat -History $script:ChatLocal.History
        }
        'error' {
            $script:ChatPendingQuestion = ''
            Set-BubbleHint '出错了'
            Update-BubbleChat -History $script:ChatLocal.History -BusyText ("出错：" + [string]$Payload.message)
            if ($script:Notify) { & $script:Notify ([string]$Payload.message) 'error' }
        }
    }
}

function On-PluginState {
    param($State)
    # 现在没有需要立刻反应的地方 —— 菜单是每次弹出时现读 state 的。
    # 留这个钩子是为了以后要做「圆环上实时显示进度」时不用改 Bridge.ps1。
}

function On-BridgeConnected {
    $script:ChatPendingQuestion = ''
}

function On-BridgeDisconnected {
    # 插件掉线时把「正在想」清掉，否则气泡会一直停在「正在想…」
    if ((Get-BubbleMode) -eq 'chat' -and $script:ChatLocal.Busy) { return }
    if ((Get-BubbleMode) -eq 'chat') { Set-BubbleHint "模型：$(Get-ChatModel) · 插件已断开" }
}
