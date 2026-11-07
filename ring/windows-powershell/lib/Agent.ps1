# ============================================================
#  Agent.ps1 — 会自己调工具的对话
#
#  ------------------------------------------------------------
#  **为什么不用 OpenAI 那套 function calling**
#
#  实测过（2026-09）：给 GRS 的 /v1/chat/completions 带上标准 tools 字段，
#  请求会成功，但模型**永远不返回 tool_calls**，content 还是空的。
#  换 gemini-3-pro 也一样（它直接忽略 tools，回一句"我不能生成图片"）。
#  换句话说：接口不报错，但这条路根本走不通。
#
#  所以这里用**文本协议**：在系统提示里告诉模型「要调工具就只输出一个
#  JSON 代码块」，然后解析回复。任何模型都能用，不依赖厂商支持。
#
#  ------------------------------------------------------------
#  **这套东西整个跑在后台 runspace 里**
#
#  一次对话可能要调好几轮工具、每轮又是几十秒的接口调用，
#  放主线程会把托盘和圆环冻住。所以本文件里**只能出现无依赖函数**：
#  需要的主线程状态（预设表、当前参数）一律通过参数传进来，
#  不要读 $script: 里的东西 —— runspace 里拿不到。
#
#  也因此 v1 的工具集刻意只包含「不需要碰 UI 和桥接」的那些。
#  读选区、写图层这类要走插件的，留给主线程版本。
# ============================================================

$script:AgentMaxSteps = 4          # 最多几轮工具调用，防止模型绕圈
$script:AgentToolResultLimit = 800 # 工具结果回灌给模型时的截断长度

# 工具清单。description 会被拼进系统提示，写给模型看，所以要具体、说清参数。
function Get-AgentTools {
    return @(
        @{
            name = 'generate_image'
            desc = '用 AI 生成一张图片。用户要图、要画、要出图时用它。'
            args = '{"prompt": "图片描述，要具体", "model": "可选，默认 nano-banana-fast", "aspectRatio": "可选，如 1:1 / 16:9 / 9:16", "imageSize": "可选，1K / 2K / 4K"}'
        }
        @{
            name = 'list_presets'
            desc = '列出可用的修图预设。用户问有哪些预设、想找某个效果时用它。'
            args = '{"category": "可选，填了只看这一类"}'
        }
        @{
            name = 'get_params'
            desc = '读取当前出图参数（模型、比例、分辨率、张数）。'
            args = '{}'
        }
    )
}

function Get-AgentSystemPrompt {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add('你是幻梦圆环里的助手，帮用户处理 Photoshop 修图相关的事。')
    [void]$lines.Add('')
    [void]$lines.Add('## 调用工具')
    [void]$lines.Add('需要工具时，**只输出 JSON 代码块**，不要写解释、道歉或任何别的话：')
    [void]$lines.Add('```json')
    [void]$lines.Add('{"tool": "工具名", "args": {...}}')
    [void]$lines.Add('```')
    [void]$lines.Add('不需要工具时，直接用自然语言回答，不要输出 JSON。')
    # 模型很爱在调用旁边补一句「抱歉，暂时读不到参数」——
    # 它根本还没拿到结果，这句是凭空猜的，而且会被写进上下文干扰后面几轮。
    [void]$lines.Add('一次可以调多个工具：要调几个就并排输出几个 JSON 代码块。')
    [void]$lines.Add('发出工具请求后就停下来等结果。**不要猜结果**，也不要说「暂时读不到」这类话。')
    [void]$lines.Add('')
    [void]$lines.Add('## 可用工具')
    foreach ($t in (Get-AgentTools)) {
        [void]$lines.Add("- **$($t.name)**：$($t.desc)")
        [void]$lines.Add("  参数：$($t.args)")
    }
    [void]$lines.Add('')
    [void]$lines.Add('## 注意')
    [void]$lines.Add('不要编造工具结果。工具报错就如实告诉用户错在哪。')
    [void]$lines.Add('回答用简体中文，简洁，不要长篇大论。')

    return ($lines -join "`n")
}

# 从模型回复里把工具调用抠出来，**按出现顺序全部装进 $Into**。
#
# 模型不一定老老实实只输出 JSON —— 常见的几种写法都要认：
#   1. 纯 JSON
#   2. ```json 代码块
#   3. ``` 代码块（没标语言）
#   4. JSON 前后带一句解释
#
# **而且它经常一条消息里调好几个工具**，哪怕系统提示明说了「一次只调一个」。
# 实测（gpt-5.5）：
#     {"tool":"get_params","args":{}}{"tool":"list_presets","args":{"category":"风光"}}
# 早先的解析器只取第一个、把第二个当没看见，模型拿不到第二个结果就以为
# 调用失败，回了句「暂时没有成功读取」，然后**多花一整轮重试** ——
# 实测 3 轮 100 秒里有一半是这么烧掉的。
#
# 只扫描一遍花括号、按文档顺序收，不先试代码块：
# 先试正则的话，同一个对象会被代码块和扫描各收一次，
# 而代码块里的非贪婪 `\{.*?\}` 遇到嵌套还会**截出半个对象**。
#
# 扫描要认得字符串 —— `{"prompt":"画个 }"}` 里的花括号不能算进深度，
# 否则整个对象会被从中间切断。
function Add-AgentToolCalls {
    param([string]$Text, $Into)

    if (-not $Text) { return }

    $depth = 0
    $start = -1
    $inStr = $false
    $esc   = $false

    for ($i = 0; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]

        if ($inStr) {
            # JSON 里字符串内的 \" 不算结束
            if ($esc) { $esc = $false }
            elseif ($ch -eq '\') { $esc = $true }
            elseif ($ch -eq '"') { $inStr = $false }
            continue
        }

        if ($ch -eq '"') { if ($depth -gt 0) { $inStr = $true }; continue }

        if ($ch -eq '{') {
            if ($depth -eq 0) { $start = $i }
            $depth++
            continue
        }

        if ($ch -eq '}') {
            if ($depth -gt 0) {
                $depth--
                if ($depth -eq 0 -and $start -ge 0) {
                    Add-AgentCallCandidate -List $Into -Raw $Text.Substring($start, $i - $start + 1)
                    $start = -1
                }
            }
            continue
        }
    }
}

# 试着把一个候选串解析成工具调用；不是（或者读不动）就丢掉，不抛。
function Add-AgentCallCandidate {
    param($List, [string]$Raw)

    try {
        $obj = ConvertFrom-Json $Raw
        if (-not $obj.tool) { return }

        $callArgs = @{}
        if ($obj.args) {
            foreach ($p in $obj.args.PSObject.Properties) { $callArgs[$p.Name] = $p.Value }
        }
        [void]$List.Add(@{ Tool = [string]$obj.tool; Args = $callArgs })
    } catch { }
}

# agent 出的图存哪。
#
# 以前是 %TEMP%\agent-<hex>.png —— 图出了就找不着了，跟没出一样。
# 现在落到和圆环出图同一个目录，图库才索引得到。
#
# **只能依赖 Api.ps1 的 Get-OutputFolder，不许读 $script:Cfg** ——
# 这个函数跑在后台 runspace 里，那边的 $script:Cfg 是 $null。
function New-AgentImagePath {
    param([string]$Configured)

    $folder = Get-OutputFolder -Configured $Configured
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')

    # 随机后缀不能省：同一次对话里模型可能在**同一秒**连出两张，
    # 光靠秒级时间戳会撞名，后一张把前一张覆盖掉 —— 而且 Repair-ImageExtension
    # 之后还有一次改名，撞名会让两张图互相踩。
    $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 4)
    return (Join-Path $folder "幻梦AI-A-$stamp-$suffix.png")
}

# 执行一个工具。$Context 里是主线程传来的只读快照。
# **返回值是给模型看的字符串**，不是给用户看的 —— 所以要短、要具体、
# 报错要说清原因（模型据此决定重试还是向用户解释）。
function Invoke-AgentTool {
    # **参数名不能叫 $Args。**
    # $Args 是 PowerShell 的自动变量（函数未声明的参数都进它）。
    # 用它当形参名，读到的往往不是你传进来的那个东西，
    # 表现是 generate_image 永远报「prompt 是空的」，
    # 模型只好一遍遍重试到上限，最后回一句「工具连续报错」——
    # 从表面完全看不出是变量名撞车。
    # $Sink 是可选的收集器（一个 ArrayList）。调用方想要「这张图是用什么提示词出的」
    # 时传它进来 —— 工具参数只存在于这个函数的**后台 runspace** 里，
    # 主线程完全看不到，不主动往外带的话图库就只能记下一条没有提示词的记录。
    param([string]$Name, $ToolArgs, $Context, $Sink = $null)

    if (-not $Context) { $Context = @{} }

    switch ($Name) {

        'generate_image' {
            $prompt = ''
            if ($ToolArgs -and $ToolArgs['prompt']) { $prompt = [string]$ToolArgs['prompt'] }
            if (-not $prompt.Trim()) { return '错误：prompt 是空的，必须给图片描述' }

            $model = [string]$Context.imgModel
            if ($ToolArgs -and $ToolArgs['model']) { $model = [string]$ToolArgs['model'] }
            $ratio = [string]$Context.aspectRatio
            if ($ToolArgs -and $ToolArgs['aspectRatio']) { $ratio = [string]$ToolArgs['aspectRatio'] }
            $size = [string]$Context.imageSize
            if ($ToolArgs -and $ToolArgs['imageSize']) { $size = [string]$ToolArgs['imageSize'] }
            if (-not $ratio) { $ratio = 'auto' }
            if (-not $size) { $size = '1K' }

            # 落到用户的出图目录，不再丢临时目录。
            # $Context.outputFolder 由主线程从配置里读好传进来 ——
            # 后台 runspace 读不到 $script:Cfg。
            $out = New-AgentImagePath -Configured ([string]$Context.outputFolder)
            $r = Invoke-GrsImage -ApiKey ([string]$Context.apiKey) -Region ([string]$Context.region) `
                -Model $model -Prompt $prompt -AspectRatio $ratio -ImageSize $size `
                -OutFile $out -MaxWaitSeconds 240

            if ($r.Ok) {
                # **写 $null -ne $Sink，不能写 if ($Sink)。**
                # 空的 ArrayList 在 PowerShell 里是**假值** —— 传进来一个刚 new
                # 出来的收集器时，if ($Sink) 会直接跳过，表现是「图出了但图库里
                # 没有提示词」，而且从外面完全看不出是这里的问题。
                if ($null -ne $Sink) {
                    [void]$Sink.Add(@{
                        Path = [string]$r.Path; Prompt = $prompt; Model = $model
                        Ratio = $ratio; Size = $size
                    })
                }
                # **这句话一个字都不能改。** 循环靠 `保存到 (.+?)（` 这个正则
                # 从里面抠路径，改了会静默丢图（图还在，历史里没有）。
                return "成功：图片已生成并保存到 $($r.Path)（模型 $model，比例 $ratio，分辨率 $size）"
            }
            return "失败：$($r.Error)"
        }

        'list_presets' {
            $all = @($Context.presets)
            if ($all.Count -eq 0) { return '当前没有可用预设' }

            $want = ''
            if ($ToolArgs -and $ToolArgs['category']) { $want = [string]$ToolArgs['category'] }

            $filtered = @($all | Where-Object { -not $want -or $_.category -eq $want })
            if ($filtered.Count -eq 0) {
                $cats = @($all | ForEach-Object { $_.category } | Select-Object -Unique) -join '、'
                return "没有名为「$want」的分类。可用的分类有：$cats"
            }

            $byCat = @{}
            foreach ($p in $filtered) {
                if (-not $byCat.ContainsKey($p.category)) { $byCat[$p.category] = New-Object System.Collections.ArrayList }
                [void]$byCat[$p.category].Add($p.name)
            }
            $out = New-Object System.Collections.ArrayList
            foreach ($cat in $byCat.Keys) {
                [void]$out.Add("$cat：" + (($byCat[$cat]) -join '、'))
            }
            return ($out -join "`n")
        }

        'get_params' {
            return ("模型=$($Context.imgModel)  比例=$($Context.aspectRatio)  分辨率=$($Context.imageSize)  张数=$($Context.imageCount)")
        }
    }

    return "错误：没有名为 $Name 的工具"
}

# 往主线程报一句「现在在干什么」。
#
# 一次 agent 对话可能跑几十秒（光出图就 15~60 秒），全程只显示
# 「正在处理…」的话用户会以为程序卡死了，然后就去点别的地方。
#
# 这个函数在两种环境下都要能跑：
#   · 后台 runspace —— Publish-AsyncProgress 存在，正常上报
#   · 直接调用（比如自动化测试）—— 没有那个函数，静默跳过
function Publish-AgentProgress {
    param([string]$Text)
    if (-not $Text) { return }
    try {
        if (Get-Command Publish-AsyncProgress -ErrorAction SilentlyContinue) {
            Publish-AsyncProgress -Text $Text
        }
    } catch { }
}

# 对话循环。**这是要在后台 runspace 里跑的**，所以除了 $Context 之外
# 不读任何外部状态。
function Invoke-AgentLoop {
    param(
        [string]$Prompt,
        [array]$History = @(),
        [hashtable]$Context = @{},
        [int]$MaxSteps = 0
    )

    # Records 是出图记录（Path/Prompt/Model/Ratio/Size），给图库用。
    # **它必须在这三处 return 之前都赋上值** —— 漏一处的表现不是报错，
    # 而是消费端拿到 @($null)＝「一个 Path 为空的假记录」。
    $result = @{ Ok = $false; Reply = ''; Steps = 0; Images = @(); Records = @(); Error = ''; Transcript = @() }

    if (-not $Prompt -or -not $Prompt.Trim()) {
        $result.Error = '问题是空的'
        return $result
    }
    if ($MaxSteps -le 0) { $MaxSteps = $script:AgentMaxSteps }

    $messages = New-Object System.Collections.ArrayList
    [void]$messages.Add(@{ role = 'system'; content = (Get-AgentSystemPrompt) })

    # 只带最近若干轮，整段历史越滚越长，全发过去又慢又贵
    $recent = @($History)
    if ($recent.Count -gt 8) { $recent = @($recent[($recent.Count - 8)..($recent.Count - 1)]) }
    foreach ($h in $recent) {
        if (-not $h.text) { continue }
        [void]$messages.Add(@{ role = $h.role; content = [string]$h.text })
    }
    [void]$messages.Add(@{ role = 'user'; content = $Prompt })

    $transcript = New-Object System.Collections.ArrayList
    $images = New-Object System.Collections.ArrayList
    $records = New-Object System.Collections.ArrayList
    $step = 0

    while ($step -lt $MaxSteps) {
        $step++

        if ($step -eq 1) { Publish-AgentProgress '正在思考…' }
        else { Publish-AgentProgress "正在想下一步（第 $step 轮）…" }

        $r = Invoke-GrsChat -ApiKey ([string]$Context.apiKey) -Region ([string]$Context.region) `
            -Model ([string]$Context.chatModel) -Messages @($messages) `
            -SystemPrompt ''
        if (-not $r.Ok) {
            $result.Error = $r.Error
            $result.Steps = $step
            $result.Images = @($images)
            $result.Records = @($records)
            $result.Transcript = @($transcript)
            return $result
        }

        $reply = [string]$r.Reply
        [void]$transcript.Add(@{ role = 'assistant'; text = $reply })

        $calls = New-Object System.Collections.ArrayList
        Add-AgentToolCalls -Text $reply -Into $calls

        if ($calls.Count -eq 0) {
            # 没有工具调用 = 这就是最终回答
            $result.Ok = $true
            $result.Reply = $reply.Trim()
            $result.Steps = $step
            $result.Images = @($images)
            $result.Records = @($records)
            $result.Transcript = @($transcript)
            return $result
        }

        # 越权保护用的白名单。算一次就够，循环里别反复建
        $known = @((Get-AgentTools) | ForEach-Object { $_.name })
        $block = New-Object System.Collections.ArrayList

        foreach ($call in $calls) {
            # 记下模型说要调什么，供界面显示进度
            [void]$transcript.Add(@{ role = 'tool'; text = "调用 $($call.Tool)" })

            # 让用户知道在调什么、大概要等多久 —— 出图那步最容易让人以为卡死
            switch ($call.Tool) {
                'generate_image' {
                    $p = ''
                    if ($call.Args -and $call.Args['prompt']) {
                        $p = [string]$call.Args['prompt']
                        if ($p.Length -gt 18) { $p = $p.Substring(0, 18) + '…' }
                    }
                    Publish-AgentProgress "正在生成图片：$p（约 15~60 秒）"
                }
                'list_presets' { Publish-AgentProgress '正在查预设…' }
                'get_params'   { Publish-AgentProgress '正在读参数…' }
                default        { Publish-AgentProgress "正在调用 $($call.Tool)…" }
            }

            # 越权保护：模型可能编一个不存在的工具名
            if ($known -notcontains $call.Tool) {
                $toolResult = "错误：没有名为 $($call.Tool) 的工具。可用的是：" + ($known -join '、')
            } else {
                $toolResult = Invoke-AgentTool -Name $call.Tool -ToolArgs $call.Args -Context $Context -Sink $records
            }

            if ($call.Tool -eq 'generate_image' -and $toolResult -like '成功：*') {
                if ($toolResult -match '保存到 (.+?)（') { [void]$images.Add($Matches[1]) }
            }

            if ($toolResult.Length -gt $script:AgentToolResultLimit) {
                $toolResult = $toolResult.Substring(0, $script:AgentToolResultLimit) + '…'
            }

            [void]$block.Add("[工具 $($call.Tool) 的结果]`n$toolResult")
        }

        # 模型的这轮输出 + **所有**工具结果一起塞回上下文。
        # 多条结果合成一条 user 消息：它们本来就出自同一次回复，
        # 拆成多条的话模型容易当成「先后两轮」，然后重复调用。
        [void]$messages.Add(@{ role = 'assistant'; content = $reply })
        [void]$messages.Add(@{ role = 'user'; content = ($block -join "`n`n") })
    }

    # 轮数用完了还没给出最终回答：让它基于已有信息收个尾
    [void]$messages.Add(@{ role = 'user'; content = '已经到工具调用上限了，请直接根据现有信息回答用户，不要再调用工具。' })
    $r2 = Invoke-GrsChat -ApiKey ([string]$Context.apiKey) -Region ([string]$Context.region) `
        -Model ([string]$Context.chatModel) -Messages @($messages) -SystemPrompt ''

    $result.Steps = $step
    $result.Images = @($images)
    $result.Records = @($records)
    $result.Transcript = @($transcript)
    if ($r2.Ok) {
        $result.Ok = $true
        $result.Reply = [string]$r2.Reply
    } else {
        $result.Error = "达到工具调用上限（$MaxSteps 次）后仍然没能给出回答：$($r2.Error)"
    }
    return $result
}
