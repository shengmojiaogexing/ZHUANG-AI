# ============================================================
#  Api.ps1 — GRS 接口调用（出图 + 对话）
#
#  这一层**刻意不依赖任何其它模块和全局状态**，所有输入走参数。
#  因为出图要在后台 runspace 里跑（一次 10–60 秒，放主线程会把托盘和圆环冻住），
#  而 runspace 里拿不到主线程的 $script: 变量 —— 只有无依赖的函数才搬得过去。
#
#  协议对齐插件 src/app/index.js：
#    出图  POST {base}/v1/api/generate   {model,prompt,aspectRatio,imageSize,replyType}
#    轮询  POST {base}/v1/draw/result    {id}
#    对话  POST {base}/v1/chat/completions {model,stream:false,messages}
# ============================================================

# PS 5.1 默认不启用 TLS 1.2，不设这一句连 grsai 会直接握手失败。
# 放在这里而不是主脚本：runspace 里也要重新设一次，每个 runspace 各有一份。
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
} catch { }

$script:GrsBaseDomestic = 'https://grsai.dakka.com.cn'
$script:GrsBaseOverseas = 'https://grsaiapi.com'

function Get-ApiBaseUrl {
    param([string]$Region)
    if ($Region -eq 'overseas') { return $script:GrsBaseOverseas }
    return $script:GrsBaseDomestic
}

function Join-ApiUrl {
    param([string]$Base, [string]$Path)
    return ($Base.TrimEnd('/') + '/' + $Path.TrimStart('/'))
}

# 把面板里那套模型 ID 翻译成**真正能发给 GRS 的**模型名。
#
# 面板内部的模型 ID 是「provider/model」形式，那个前缀是**选路用的**，
# 不是模型名的一部分：
#     grs/gpt-5.5            → 发给 GRS 的是 gpt-5.5
#     xai/grok-imagine-image → 走 xAI 的接口，跟 GRS 没关系
# 插件里对应的是 resolveChatApiRouting / parseModelSelection，它返回的
# routing.model 同样是**去掉前缀**的那个名字。
#
# 圆环这边只连 GRS 一家，所以这个函数干两件事：去掉 grs 前缀；
# 把圆环根本够不着的那些挑出来，给一句人话，而不是让用户对着
# 「HTTP 400 Bad Request」猜。
function ConvertTo-GrsModelName {
    param([string]$Model)

    $info = @{ Ok = $false; Model = ''; Error = '' }
    $name = ''
    if ($Model) { $name = $Model.Trim() }
    if (-not $name) { $info.Error = '没有指定模型'; return $info }

    # PS 原生模型根本不是 GRS 的模型 —— 面板里它是走 executeNativeAIPreset()，
    # 也就是 Photoshop 自带的生成式 AI，压根不经过任何 HTTP 接口。
    # 圆环自己出图时没有这条路，发给 GRS 只会换来 400。
    if ($name -eq 'PS_NATIVE_NANO_BANANA') {
        $info.Error = '「PS 原生 Banana Pro」走的是 Photoshop 自带接口，只有面板加载着的时候能用。要么先在 Photoshop 里打开插件，要么换一个 GRS 模型（比如 nano-banana-fast）'
        return $info
    }

    $slash = $name.IndexOf('/')
    if ($slash -gt 0) {
        $provider = $name.Substring(0, $slash).ToLower()
        $rest = $name.Substring($slash + 1)

        if ($provider -eq 'grs') {
            if (-not $rest) { $info.Error = "模型名是空的：$name"; return $info }
            $info.Ok = $true
            $info.Model = $rest
            return $info
        }

        # 这些前缀在面板里各自指向另一家的接口（xAI、本地 grok2api、
        # 本地 Firefly 网关、NewAPI、火山方舟）。圆环的配置里只有一把 GRS 密钥，
        # 够不着它们，所以直接说清楚，别发出去换一个看不懂的报错。
        $where = switch ($provider) {
            'xai'        { 'xAI 的接口' }
            'grok2api'   { '本机 8000 端口的 grok2api 服务' }
            'firefly'    { '本机 8787 端口的 Firefly 网关' }
            'newapi'     { 'NewAPI 服务' }
            'sub2api'    { '本机 8080 端口的 sub2api 服务' }
            'volcengine' { '火山方舟' }
            default      { "$provider 的接口" }
        }
        $info.Error = "「$name」要走 $where，而圆环只连 GRS。要么在插件面板里用它，要么换一个 GRS 模型"
        return $info
    }

    $info.Ok = $true
    $info.Model = $name
    return $info
}

# 出图存哪。配置里留空就落到「图片\幻梦AI」。
function Get-OutputFolder {
    param([string]$Configured)

    if ($Configured -and $Configured.Trim()) {
        $path = $Configured.Trim()
    } else {
        $path = Join-Path ([Environment]::GetFolderPath('MyPictures')) '幻梦AI'
    }
    if (-not (Test-Path -LiteralPath $path)) {
        try { New-Item -ItemType Directory -Path $path -Force | Out-Null } catch { }
    }
    return $path
}

# ---------- 图像候选提取 ----------
# 对齐插件里的 extractImageFromResponse：**在整份响应里递归找像图的东西**，
# 而不是认准某一个字段名。各家网关返回的位置五花八门
# （data[0].url / data.b64_json / result.output[0] / 甚至塞在 markdown 里），
# 认字段名的话每接一家新渠道就要改一次代码。

function Get-ImageCandidates {
    param($Value, [System.Collections.ArrayList]$Results)

    if ($null -eq $Results) { $Results = New-Object System.Collections.ArrayList }
    if ($null -eq $Value) { return $Results }

    if ($Value -is [string]) {
        $text = $Value.Trim()
        if ($text -match '^(?i)(https?://|data:image/)') {
            [void]$Results.Add($text)
        } elseif ($text.Length -gt 256 -and $text -match '^[A-Za-z0-9+/=\r\n]+$') {
            # 长串纯 base64（没有 data: 前缀的那种）也当成图
            [void]$Results.Add("data:image/png;base64,$($text -replace '\s','')")
        }
        return $Results
    }

    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) { [void](Get-ImageCandidates -Value $Value[$key] -Results $Results) }
        return $Results
    }

    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        foreach ($prop in $Value.PSObject.Properties) { [void](Get-ImageCandidates -Value $prop.Value -Results $Results) }
        return $Results
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($item in $Value) { [void](Get-ImageCandidates -Value $item -Results $Results) }
        return $Results
    }

    return $Results
}

function Test-IsImageUrl {
    param([string]$Value)

    if (-not $Value) { return $false }
    if ($Value -match '^(?i)data:image/') { return $true }

    try {
        $uri = [Uri]$Value
    } catch {
        return $Value -match '(?i)\.(png|jpe?g|webp|gif|avif)(\?|#|$)'
    }

    if ($uri.PathAndQuery -match '(?i)\.(png|jpe?g|webp|gif|avif)(\?|#|$)') { return $true }

    # 对象存储 / CDN 的预签名直链通常没有扩展名，只能认主机名。
    # 这张表是硬编码的，接新渠道遇到「无法提取图像」时往这里补一条。
    $host_ = $uri.Host
    if ($host_ -match '(?i)(^|\.)(oaidalleapiprodscus|blob|grs|claude|image|img|cdn|adobe|firefly|storage|xai-imgen|amazonaws|cloudfront|aliyuncs|myqcloud|googleusercontent|digitaloceanspaces|backblazeb2|b-cdn|volces|volccdn|byteimg|ibyteimg)\.') {
        return $true
    }
    return $false
}

function Find-ImageCandidate {
    param($Response)

    $all = Get-ImageCandidates -Value $Response -Results (New-Object System.Collections.ArrayList)
    foreach ($candidate in $all) {
        if (Test-IsImageUrl -Value $candidate) { return $candidate }
    }
    return $null
}

# 把候选（data URI 或 http 直链）落成磁盘上的文件
function Save-ImageCandidate {
    param([string]$Candidate, [string]$OutFile)

    if ($Candidate -match '^(?i)data:image/([a-z0-9.+-]+);base64,(.+)$') {
        $bytes = [Convert]::FromBase64String(($Matches[2] -replace '\s', ''))
        [System.IO.File]::WriteAllBytes($OutFile, $bytes)
        return $true
    }

    if ($Candidate -match '^(?i)https?://') {
        # -UseBasicParsing：PS 5.1 不带这个参数会去初始化 IE 引擎，
        # 在没配过 IE 的机器上直接报错。
        Invoke-WebRequest -Uri $Candidate -OutFile $OutFile -UseBasicParsing -TimeoutSec 120
        return $true
    }

    return $false
}

function New-TempImagePath {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) 'HuanmengRing'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $name = 'gen-' + [Guid]::NewGuid().ToString('N').Substring(0, 12) + '.png'
    return (Join-Path $dir $name)
}

# 按文件头判断真实格式，返回小写扩展名；认不出来返回空串。
# **不要信扩展名** —— 图片存下来叫什么名字是我们自己定的，跟内容没关系。
function Get-ImageFormatByMagic {
    param([string]$Path)

    try {
        $fs = [System.IO.File]::OpenRead($Path)
        try {
            $head = New-Object byte[] 12
            $n = $fs.Read($head, 0, 12)
        } finally { $fs.Close() }

        if ($n -lt 4) { return '' }
        if ($head[0] -eq 0x89 -and $head[1] -eq 0x50 -and $head[2] -eq 0x4E -and $head[3] -eq 0x47) { return 'png' }
        if ($head[0] -eq 0xFF -and $head[1] -eq 0xD8 -and $head[2] -eq 0xFF) { return 'jpg' }
        if ($n -ge 12 -and
            $head[0] -eq 0x52 -and $head[1] -eq 0x49 -and $head[2] -eq 0x46 -and $head[3] -eq 0x46 -and
            $head[8] -eq 0x57 -and $head[9] -eq 0x45 -and $head[10] -eq 0x42 -and $head[11] -eq 0x50) { return 'webp' }
        if ($head[0] -eq 0x47 -and $head[1] -eq 0x49 -and $head[2] -eq 0x46) { return 'gif' }
        if ($head[0] -eq 0x42 -and $head[1] -eq 0x4D) { return 'bmp' }
    } catch { }
    return ''
}

# 把扩展名改成真实的那个。
#
# **GRS 返回的是 JPEG，但文件一直叫 .png** —— New-TempImagePath 写死的。
# 实测（nano-banana-fast）：落盘的图前 12 字节是 FF D8 FF E0 ... JFIF，
# 标准 JPEG，1024×1024。扩展名不对后果很实在：有的工具按扩展名挑解码器，
# 直接报「文件损坏」；用户拿它去上传也会被拒。
#
# **只改名，不转码。** 转成真 PNG 要重新编码，体积还会涨好几倍，
# 而我们没有任何理由动用户那张图的像素。
function Repair-ImageExtension {
    param([string]$Path)

    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $Path }

    $real = Get-ImageFormatByMagic -Path $Path
    if (-not $real) { return $Path }

    $current = [System.IO.Path]::GetExtension($Path).TrimStart('.').ToLower()
    # jpg / jpeg 是一回事，不为这个改名
    if ($current -eq $real) { return $Path }
    if ($real -eq 'jpg' -and $current -eq 'jpeg') { return $Path }

    $target = [System.IO.Path]::ChangeExtension($Path, $real)
    try {
        Move-Item -LiteralPath $Path -Destination $target -Force
        return $target
    } catch {
        # 改不动就保持原样：图本身是好的，只是名字不对，
        # 不值得为了一个文件名把整次出图判成失败
        return $Path
    }
}

# 本地图片 → data URI，用作参考图
function Convert-ImageToDataUri {
    param([string]$Path)

    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $ext = [System.IO.Path]::GetExtension($Path).TrimStart('.').ToLower()
        switch ($ext) {
            'jpg'  { $mime = 'image/jpeg' }
            'jpeg' { $mime = 'image/jpeg' }
            'webp' { $mime = 'image/webp' }
            'gif'  { $mime = 'image/gif' }
            default { $mime = 'image/png' }
        }
        return "data:$mime;base64,$([Convert]::ToBase64String($bytes))"
    } catch {
        return $null
    }
}

# ---------- 出图 ----------

# ---------- 发请求 ----------
#
# **不要用 Invoke-RestMethod 收 JSON 响应。**
#
# GRS 的响应头是 `Content-Type: application/json`，**不带 charset**。
# 实测（2026-09）：PowerShell 5.1 遇到没有 charset 的 JSON 响应，
# 会按 Latin-1(ISO-8859-1) 解码，于是「你好世界」到手变成「ä½ å¥½ä¸ç」——
# 同一份字节按 UTF-8 解是 U+4F60 U+597D U+4E16 U+754C，按 Latin-1 解就是那串乱码。
#
# 症状很能骗人：HTTP 200、JSON 结构完好、字段一个不少，只有中文是花的。
# 出图那条路看不出来（图 URL 全是 ASCII），所以是**对话**先暴露的 ——
# agent 的回答整段都是乱码。
#
# 这里自己收字节、自己按 UTF-8 解，绕开 5.1 那个默认值。
function Invoke-GrsRequest {
    param(
        [string]$Url,
        [string]$Method = 'POST',
        [hashtable]$Headers = @{},
        [byte[]]$Body = $null,
        [int]$TimeoutSec = 180
    )

    $result = @{ Ok = $false; Status = 0; Text = ''; Json = $null; Error = '' }

    # 老 .NET 默认只开 TLS 1.0，用 |= 往上加而不是覆盖 ——
    # 免得把机器上已经开好的协议关掉。
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = `
            [System.Net.ServicePointManager]::SecurityProtocol -bor `
            [System.Net.SecurityProtocolType]::Tls12
    } catch { }

    $req = $null
    $resp = $null
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = $Method
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        foreach ($k in $Headers.Keys) { $req.Headers[$k] = [string]$Headers[$k] }

        if ($Method -eq 'POST') {
            $req.ContentType = 'application/json; charset=utf-8'
            if ($null -eq $Body) { $Body = [byte[]]@() }
            $req.ContentLength = $Body.Length
            $stream = $req.GetRequestStream()
            if ($Body.Length -gt 0) { $stream.Write($Body, 0, $Body.Length) }
            $stream.Close()
        }

        $resp = $req.GetResponse()
        $result.Status = [int]$resp.StatusCode
        $result.Text = Read-Utf8Body -Stream $resp.GetResponseStream()
        $result.Ok = $true
    } catch [System.Net.WebException] {
        $we = $_.Exception
        # 非 2xx 也会走到这儿。响应体里往往有接口写的人话错误（而且是中文），
        # 一定要按 UTF-8 读出来，别退回 $we.Message 那种英文壳子。
        if ($we.Response) {
            try {
                $result.Status = [int]$we.Response.StatusCode
                $result.Text = Read-Utf8Body -Stream $we.Response.GetResponseStream()
            } catch { }
        }
        if (-not $result.Text) { $result.Text = $we.Message }
        $result.Error = $we.Message
    } catch {
        $result.Error = $_.Exception.Message
        $result.Text = [string]$result.Error
    } finally {
        if ($resp) { try { $resp.Close() } catch { } }
    }

    # **成功和失败都要解一遍。** 失败响应体往往也是结构完好的 JSON
    # （实测 404 回的是 {"error":"result not exist, valid for 2 hours"}），
    # 只在成功分支里解的话，错误提示就只能拿原文硬拼。
    if ($result.Text) {
        try { $result.Json = ConvertFrom-Json $result.Text } catch { }
    }
    return $result
}

function Read-Utf8Body {
    param($Stream)
    if (-not $Stream) { return '' }
    $reader = New-Object System.IO.StreamReader($Stream, [System.Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
    $reader.Close()
    return $text
}

function Invoke-GrsImage {
    param(
        [string]$ApiKey,
        [string]$Region,
        [string]$Model,
        [string]$Prompt,
        [string]$ImageSize = '1K',
        [string]$AspectRatio = 'auto',
        # 这两个只有 gpt-image 系模型认（见官方文档），其它模型别传
        [string]$Quality = '',
        [string]$Background = '',
        [string[]]$ReferenceImages = @(),
        [string]$OutFile,
        [int]$MaxWaitSeconds = 300,
        [scriptblock]$OnProgress
    )

    $result = @{ Ok = $false; Path = ''; Error = '' }

    if (-not $ApiKey -or -not $ApiKey.Trim()) {
        $result.Error = '缺密钥 —— 菜单栏 ◎ → 打开配置文件，填 api.grsApiKey'
        return $result
    }
    if (-not $Prompt -or -not $Prompt.Trim()) {
        $result.Error = '提示词是空的'
        return $result
    }
    if (-not $OutFile) { $OutFile = New-TempImagePath }

    # 模型 ID 先翻译一遍。少了这一步，面板里默认的「PS 原生 Banana Pro」
    # 会被原样发给 GRS，换回来一个 HTTP 400 —— 用户看到的只是「生图失败」，
    # 完全猜不到是模型选错了。
    $modelInfo = ConvertTo-GrsModelName -Model $Model
    if (-not $modelInfo.Ok) {
        $result.Error = $modelInfo.Error
        return $result
    }

    $base = Get-ApiBaseUrl -Region $Region
    $headers = @{ 'Authorization' = "Bearer $($ApiKey.Trim())" }

    $body = @{
        model       = $modelInfo.Model
        prompt      = $Prompt
        # 文档里 nano-banana 支持 11 种比例，nano-banana-2 系列再多 4 种。
        # 之前这里写死 auto，等于把这个能力整个丢掉了。
        aspectRatio = if ($AspectRatio) { $AspectRatio } else { 'auto' }
        imageSize   = if ($ImageSize) { $ImageSize } else { '1K' }
        # **用 async，不要用 json。**
        #
        # json 模式会**全程占着这条 HTTP 连接**等图生成完 —— 实测
        # nano-banana-2 要跑 67 秒，中途被中间设备掐断过一次，报的是
        # 「The underlying connection was closed」，从错误信息里完全看不出
        # 是怎么回事。async 是下单立刻返回任务 id，之后用
        # GET /v1/api/result?id=xxx 轮询，每条连接都是短请求，不会被掐。
        replyType   = 'async'
    }
    if ($ReferenceImages -and $ReferenceImages.Count -gt 0) {
        $body.images = @($ReferenceImages)
    }
    # 文档标注这两个只有 gpt-image 系认，发给 nano-banana 会被拒。
    # 传空就整个不发，让服务端用默认值。
    if ($Quality)    { $body.quality    = $Quality }
    if ($Background) { $body.background = $Background }

    # 第一步：下单
    $json = $body | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $call = Invoke-GrsRequest -Url (Join-ApiUrl $base '/v1/api/generate') -Method 'POST' `
        -Headers $headers -Body $bytes -TimeoutSec 180
    if (-not $call.Ok) {
        $result.Error = Convert-ApiErrorText -Status $call.Status -Text $call.Text
        return $result
    }
    $response = $call.Json
    if ($null -eq $response) {
        $result.Error = '接口返回的不是 JSON：' + $call.Text
        return $result
    }

    # 有的渠道直接就把图给回来了，不用轮询
    $direct = Find-ImageCandidate -Response $response
    if ($direct) {
        try {
            [void](Save-ImageCandidate -Candidate $direct -OutFile $OutFile)
            $result.Ok = $true
            $result.Path = Repair-ImageExtension -Path $OutFile
            return $result
        } catch { }
    }

    # 第二步：拿任务号
    $taskId = $null
    foreach ($key in @('id', 'taskId', 'task_id')) {
        $value = $null
        try { $value = $response.$key } catch { }
        if ($value) { $taskId = [string]$value; break }
    }
    if (-not $taskId) {
        $result.Error = '接口没有返回任务号，响应：' + (Format-JsonBrief $response)
        return $result
    }

    # 第三步：轮询。
    #
    # 接口是 **GET /v1/api/result?id=xxx**（官方文档：异步生成结果查询接口）。
    # 以前这里 POST 的是 /v1/draw/result —— 那个路径在文档里根本没有，
    # 能"工作"纯粹是因为当时用的是 json 模式，图在第一步就回来了，
    # 轮询那一段压根没跑到。现在换成 async，轮询成了主路径，必须用对。
    #
    # 2.5 秒一次，最多 MaxWaitSeconds —— 和插件的 120×2.5s 一致。
    $deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
    $intervalMs = 2500
    $attempt = 0
    $lastProgress = -1

    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds $intervalMs
        $attempt += 1

        $pollUrl = (Join-ApiUrl $base '/v1/api/result') + '?id=' + [Uri]::EscapeDataString($taskId)
        $call = Invoke-GrsRequest -Url $pollUrl -Method 'GET' -Headers $headers -TimeoutSec 60
        if (-not $call.Ok) {
            # 5xx 是服务端抖动，接着轮询；4xx 是请求本身有问题，直接报错
            if ($call.Status -ge 500) { continue }
            $result.Error = Convert-ApiErrorText -Status $call.Status -Text $call.Text
            return $result
        }
        # 解析不出 JSON 多半是网关插了一页 HTML 进来，当抖动处理接着轮询
        if ($null -eq $call.Json) { continue }
        $poll = $call.Json

        # 文档里 progress 是 0~100，有就报给调用方 ——
        # 只报「第几次轮询」的话，用户看着数字涨也不知道还要等多久
        $pct = -1
        try { if ($null -ne $poll.progress) { $pct = [int]$poll.progress } } catch { }
        if ($OnProgress) {
            if ($pct -ge 0) {
                if ($pct -ne $lastProgress) { $lastProgress = $pct; & $OnProgress $pct }
            } else {
                & $OnProgress $attempt
            }
        }

        $candidate = Find-ImageCandidate -Response $poll
        if ($candidate) {
            try {
                [void](Save-ImageCandidate -Candidate $candidate -OutFile $OutFile)
                $result.Ok = $true
                $result.Path = Repair-ImageExtension -Path $OutFile
                return $result
            } catch {
                $result.Error = '图片下载失败：' + $_.Exception.Message
                return $result
            }
        }

        # 终止态：失败 / 取消 / 违规（violation 是官方状态机里的终止态，
        # 漏掉它会把违规任务一直轮询到超时，用户等了五分钟才看到一句「超时」）
        $status = ''
        foreach ($key in @('status', 'state')) {
            $value = $null
            try { $value = $poll.$key } catch { }
            if ($value) { $status = ([string]$value).ToLower(); break }
        }
        if (-not $status) {
            # 有的网关把状态裹在 data 里：{data:{status:"failed"}}
            foreach ($key in @('status', 'state')) {
                $value = $null
                try { if ($poll.data) { $value = $poll.data.$key } } catch { }
                if ($value) { $status = ([string]$value).ToLower(); break }
            }
        }
        if ($status -in @('failed', 'failure', 'error', 'cancelled', 'canceled', 'violation')) {
            $reason = ''
            foreach ($key in @('error', 'failure_reason', 'message', 'detail')) {
                $value = $null
                try { $value = $poll.$key } catch { }
                if ($value) { $reason = [string]$value; break }
            }
            if (-not $reason) { $reason = Format-JsonBrief $poll }
            # 这条错误来自**任务状态**，不走 HTTP 错误分支，所以得自己过一遍人话映射。
            # 不过的话，「服务端过载」这种最常见的失败会原样甩一句英文给用户 ——
            # 实测：The model load is too high, please try again later
            $reason = Convert-ApiErrorText -Status 0 -Text $reason
            $result.Error = "任务结束（$status）：$reason"
            return $result
        }
    }

    $result.Error = "等待生成结果超时（$MaxWaitSeconds 秒）—— 服务端可能过载，稍后重试"
    return $result
}

# ---------- 对话 ----------

function Invoke-GrsChat {
    param(
        [string]$ApiKey,
        [string]$Region,
        [string]$Model,
        [array]$Messages,
        [string]$SystemPrompt = ''
    )

    $result = @{ Ok = $false; Reply = ''; Error = '' }

    if (-not $ApiKey -or -not $ApiKey.Trim()) {
        $result.Error = '缺密钥 —— 菜单栏 ◎ → 打开配置文件，填 api.grsApiKey'
        return $result
    }
    if (-not $Messages -or $Messages.Count -eq 0) {
        $result.Error = '问题是空的'
        return $result
    }

    # 同出图：面板里的 ID 是「provider/model」，发给接口的只能是后半截。
    # 实测 grs/gpt-5.5 是 HTTP 400，gpt-5.5 正常 —— 这个前缀就是原因。
    $modelInfo = ConvertTo-GrsModelName -Model $Model
    if (-not $modelInfo.Ok) {
        $result.Error = $modelInfo.Error
        return $result
    }

    $base = Get-ApiBaseUrl -Region $Region

    $payload = @()
    if ($SystemPrompt -and $SystemPrompt.Trim()) {
        $payload += @{ role = 'system'; content = $SystemPrompt }
    }
    foreach ($message in $Messages) {
        $payload += @{ role = $message.role; content = $message.content }
    }

    $body = @{ model = $modelInfo.Model; stream = $false; messages = $payload }

    $json = $body | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $call = Invoke-GrsRequest -Url (Join-ApiUrl $base '/v1/chat/completions') -Method 'POST' `
        -Headers @{ 'Authorization' = "Bearer $($ApiKey.Trim())" } `
        -Body $bytes -TimeoutSec 180
    if (-not $call.Ok) {
        $result.Error = Convert-ApiErrorText -Status $call.Status -Text $call.Text
        return $result
    }
    $response = $call.Json
    if ($null -eq $response) {
        $result.Error = '接口返回的不是 JSON：' + $call.Text
        return $result
    }

    $text = ''
    try {
        if ($response.choices -and $response.choices.Count -gt 0) {
            $text = [string]$response.choices[0].message.content
        } elseif ($response.data -and $response.data.choices) {
            $text = [string]$response.data.choices[0].message.content
        } elseif ($response.output -and $response.output.Count -gt 0) {
            # 有些网关用 output[].content[] 的形状
            foreach ($part in $response.output) {
                if ($part.content) {
                    foreach ($chunk in $part.content) {
                        if ($chunk.text) { $text += [string]$chunk.text }
                    }
                }
            }
        } elseif ($response.reply) {
            $text = [string]$response.reply
        }
    } catch { }

    if (-not $text) {
        $result.Error = '读不出回复内容，响应：' + (Format-JsonBrief $response)
        return $result
    }

    $result.Ok = $true
    $result.Reply = $text
    return $result
}

# ---------- 错误信息 ----------

# $Text 必须是**已经按 UTF-8 解好的**正文 —— 正常路径来自 Invoke-GrsRequest，
# 它连错误响应体也是按 UTF-8 读的（见那边的 WebException 分支）。
# 接口写的错误提示本身就是中文，这一步弄错的话用户看到的是一串拉丁乱码。
function Convert-ApiErrorText {
    param([int]$Status = 0, [string]$Text = '')

    $status = $Status
    $text = [string]$Text
    if (-not $text) { $text = '接口没有返回任何内容' }

    # 把接口返回的原始 JSON 拆成一句人话
    $message = ''
    try {
        $parsed = ConvertFrom-Json $text
        if ($parsed.error -is [string]) { $message = $parsed.error }
        elseif ($parsed.error.message) { $message = [string]$parsed.error.message }
        elseif ($parsed.message) { $message = [string]$parsed.message }
    } catch { }

    $probe = if ($message) { $message } else { $text }

    # 实测接口回的是 `{"error":{"message":"apikey error"}}`，
    # 不是文档里那种 `invalid_api_key`。只匹配后者的话，
    # 用户填错密钥时看到的就是一句英文的「apikey error」，猜不到该去改哪儿。
    if ($probe -match 'apikey error|invalid_api_key|invalid api key') { return 'API 密钥无效 —— 菜单栏 ◎ → 打开配置文件，检查 api.grsApiKey' }
    if ($probe -match 'quota_exceeded')  { return 'API 配额已用尽，稍后再试' }
    if ($probe -match 'rate_limit')      { return '请求频率过高，稍等几秒再试' }
    if ($probe -match 'model load is too high') { return 'The model load is too high —— 服务端过载，过一会儿重试' }

    if ($message) { return $message }
    if ($status -gt 0) { return "请求失败（HTTP $status）：$text" }
    return $text
}

function Format-JsonBrief {
    param($Object)

    try {
        $json = $Object | ConvertTo-Json -Depth 6 -Compress
        if ($json.Length -gt 300) { $json = $json.Substring(0, 300) + '…' }
        return $json
    } catch {
        return [string]$Object
    }
}
