# ============================================================
#  Comfy.ps1 — ComfyUI 代理
#
#  【为什么需要它】
#  UXP 插件的 fetch 会强制校验 CORS，而 ComfyUI 默认不下发
#  access-control-allow-origin 头（本机实测为空）。所以插件直连 ComfyUI 会被
#  浏览器层直接拦掉，报错还和「连不上」长得一模一样。
#  圆环是普通 .NET 进程，没有这个限制 —— 插件把请求交给圆环代发即可，
#  客户那边 ComfyUI 不用改任何启动参数。
#
#  插件侧会自动降级：直连能通就用直连（少一次中转），被拦了才走这里。
#
#  【安全边界 —— 这条不能省】
#  这个代理跑在用户机器上、拥有完整的网络权限。如果不加限制，它就是一个
#  「什么地址都能打」的开放代理：插件里（或任何能连上 8799 的进程里）
#  一段脚本就能借它去请求内网地址。
#  所以默认只放行回环地址，要打局域网得在配置里显式写 comfy.allowedHosts。
#
#  【线程】
#  Update-HuanmengBridge 跑在 UI 线程上，绝不能在这里做 HTTP。
#  实际请求一律丢给 Start-AsyncTask 的后台 runspace，结果回主线程后再发出去。
# ============================================================

# 单个响应体的上限（编码成 base64 之后）。ComfyUI 的输出图通常 1~5MB，
# 放大到 32MB 足够，再大就不是正常回图了 —— 与其把圆环的内存和
# WebSocket 帧撑爆，不如明确报错。
$script:ComfyMaxResponseBytes = 32MB

# 默认只允许回环。理由见文件头。
$script:ComfyLoopbackHosts = @('127.0.0.1', 'localhost', '::1', '[::1]')

function Test-ComfyUrlAllowed {
    <#
      判断一个 URL 允不允许被代理。
      判据：协议必须是 http/https，且主机在允许列表里（默认只有回环）。
    #>
    param(
        [string]$Url,
        [string[]]$AllowedHosts = @()
    )

    if (-not $Url) { return $false }

    $uri = $null
    try { $uri = [System.Uri]$Url } catch { return $false }
    if ($null -eq $uri) { return $false }

    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { return $false }

    $hostName = [string]$uri.Host
    if (-not $hostName) { return $false }

    # 优先用 .NET 自己的判定 —— 它比手写列表全得多，而且没有我踩过的那个坑：
    # IPv6 的 Uri.Host 返回的是**展开形式** '[0000:0000:0000:0000:0000:0000:0000:0001]'，
    # 手写 '[::1]' / '::1' 一个都匹配不上（实测：http://[::1]:8188 被判成非回环）。
    # IsLoopback 覆盖 127.0.0.0/8 整段、::1、localhost，且随 .NET 版本稳定。
    if ($uri.IsLoopback) { return $true }

    # 手写列表留作兜底：万一某个 .NET 实现对 IsLoopback 的判定有出入
    foreach ($loop in $script:ComfyLoopbackHosts) {
        if ($hostName -eq $loop) { return $true }
    }

    # 用户显式加的局域网地址
    foreach ($extra in @($AllowedHosts)) {
        if ($null -eq $extra) { continue }
        $text = ([string]$extra).Trim()
        if (-not $text) { continue }
        if ($hostName -eq $text) { return $true }
    }

    return $false
}

function Get-ComfyAllowedHosts {
    <#
      从配置里读「除了回环之外还允许代理哪些主机」。

      全程带 $null 守卫：$script:Cfg 是用户能直接改的 JSON，
      里面可能压根没有 comfy 这一段（老配置升级上来的就肯定没有）。
      不守卫的话，在 Update-HuanmengBridge 这条路径上会直接抛 ——
      而那个函数跑在 WinForms 定时器里，抛出去就是一串崩溃日志。
    #>
    $out = @()
    $cfg = $script:Cfg
    if ($null -eq $cfg) { return $out }
    if (-not ($cfg -is [System.Collections.IDictionary])) { return $out }
    if (-not $cfg.Contains('comfy')) { return $out }

    $comfyCfg = $cfg['comfy']
    if ($null -eq $comfyCfg) { return $out }
    if (-not ($comfyCfg -is [System.Collections.IDictionary])) { return $out }
    if (-not $comfyCfg.Contains('allowedHosts')) { return $out }

    foreach ($item in @($comfyCfg['allowedHosts'])) {
        if ($null -eq $item) { continue }
        $text = ([string]$item).Trim()
        if ($text) { $out += $text }
    }
    return $out
}

function Read-ComfyRawBody {
    # 整个读成字节。**不能用 StreamReader** —— 图片是二进制，
    # 按文本读一遍再转回去，字节就已经被改坏了。
    param($Stream)

    if ($null -eq $Stream) { return [byte[]]@() }

    $memory = New-Object System.IO.MemoryStream
    try {
        $Stream.CopyTo($memory)
        return $memory.ToArray()
    } finally {
        $memory.Close()
    }
}

function Invoke-ComfyRawRequest {
    <#
      发一个请求，把响应**原样按字节**收回来。

      和 Api.ps1 的 Invoke-GrsRequest 的区别：
        - 那个只回文本（GRS 全是 JSON），这个是字节级，因为 ComfyUI 的
          /view 返回的是图片二进制
        - 那个失败时把响应体当文本读出来给用户看；这里同样要读，
          因为 ComfyUI 校验工作流失败返回的是 HTTP 400 + body 里的 node_errors，
          body 不读出来，插件那边就没有料可以翻译成人话

      返回 @{ Ok; Status; Bytes; ContentType; Error }
    #>
    param(
        [string]$Url,
        [string]$Method = 'GET',
        [byte[]]$Body = $null,
        [string]$ContentType = 'application/json; charset=utf-8',
        [int]$TimeoutSec = 120
    )

    $result = @{
        Ok          = $false
        Status      = 0
        Bytes       = [byte[]]@()
        ContentType = ''
        Error       = ''
        Url         = $Url
    }

    $req = $null
    $resp = $null
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = $Method
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        # 不要跟随重定向去别的主机：代理的安全边界只对原始地址负责，
        # 跟过去可能就出圈了
        $req.AllowAutoRedirect = $false

        if ($Method -ne 'GET' -and $Method -ne 'HEAD') {
            $req.ContentType = $ContentType
            if ($null -eq $Body) { $Body = [byte[]]@() }
            $req.ContentLength = $Body.Length
            $stream = $req.GetRequestStream()
            if ($Body.Length -gt 0) { $stream.Write($Body, 0, $Body.Length) }
            $stream.Close()
        }

        $resp = $req.GetResponse()
        $result.Status = [int]$resp.StatusCode
        $result.ContentType = [string]$resp.ContentType
        $result.Bytes = Read-ComfyRawBody -Stream $resp.GetResponseStream()
        $result.Ok = $true
    } catch [System.Net.WebException] {
        $we = $_.Exception
        # 非 2xx 也走这里。响应体必须读出来 —— 见上面注释。
        if ($we.Response) {
            try {
                $result.Status = [int]$we.Response.StatusCode
                $result.ContentType = [string]$we.Response.ContentType
                $result.Bytes = Read-ComfyRawBody -Stream $we.Response.GetResponseStream()
            } catch { }
        }
        # 注意用 .Length 判断而不是直接 if($bytes)：空的 byte[] 在 PowerShell 里是**假值**，
        # 而 Read-ComfyRawBody 正常情况下返回的也可能正好是空数组
        if ($null -eq $result.Bytes -or $result.Bytes.Length -eq 0) {
            $result.Error = $we.Message
        }
    } catch {
        $result.Error = $_.Exception.Message
    } finally {
        if ($resp) { try { $resp.Close() } catch { } }
    }

    return $result
}

function Start-ComfyProxyRequest {
    <#
      主线程调用：接下一个插件的代理请求，丢到后台去发，结果回来再发回插件。

      $BodyBase64 是插件那边 base64 过的请求体（可能为空）。
    #>
    param(
        [string]$RequestId,
        [string]$Url,
        [string]$Method = 'GET',
        [string]$BodyBase64 = '',
        [string]$ContentType = 'application/json; charset=utf-8',
        [string[]]$AllowedHosts = @(),
        [int]$TimeoutSec = 120
    )

    if (-not $RequestId) { return }
    if (-not $script:Bridge.Server -or -not $script:Bridge.Server.IsConnected) { return }

    # 方法白名单。ComfyUI 的接口只用得上这三个，其余（PUT/DELETE/OPTIONS…）
    # 没有理由让它通过 —— 代理本身不该比需要的更能干。
    $methodUpper = ([string]$Method).ToUpperInvariant()
    if (-not $methodUpper) { $methodUpper = 'GET' }
    if ($methodUpper -ne 'GET' -and $methodUpper -ne 'POST' -and $methodUpper -ne 'HEAD') {
        Send-BridgeComfyResponse -RequestId $RequestId -Payload @{
            ok = $false; status = 0; body = ''
            error = "圆环拒绝了代理请求：不支持的方法 $methodUpper。只允许 GET / POST / HEAD。"
        }
        return
    }

    if (-not (Test-ComfyUrlAllowed -Url $Url -AllowedHosts $AllowedHosts)) {
        # 不满足安全边界就直接回绝，连请求都不发
        Send-BridgeComfyResponse -RequestId $RequestId -Payload @{
            ok      = $false
            blocked = $true
            status  = 0
            body    = ''
            error   = "圆环拒绝了代理请求：$Url`n这个代理默认只允许本机地址（127.0.0.1 / localhost）。`n要用局域网上的 ComfyUI，请在配置里加 comfy.allowedHosts。"
        }
        return
    }

    $bodyBytes = [byte[]]@()
    if ($BodyBase64) {
        try { $bodyBytes = [System.Convert]::FromBase64String($BodyBase64) } catch {
            Send-BridgeComfyResponse -RequestId $RequestId -Payload @{
                ok = $false; status = 0; body = ''
                error = '代理请求的请求体不是合法的 base64，已丢弃。'
            }
            return
        }
    }

    # 后台环境是干净的 runspace，用到的函数必须在 AsyncLibs 里（见 HuanmengRing.ps1）。
    # 参数一律靠 $Arguments 传 —— 那个 scriptblock 是被字符串化后再重建的，闭包不生效。
    # 空 ContentType 就退回 JSON —— 老版本的插件不发这个字段
    $sendContentType = if ($ContentType) { $ContentType } else { 'application/json; charset=utf-8' }

    $work = {
        param($Url, $Method, $BodyBytes, $ContentType, $TimeoutSec, $RequestId)
        $r = Invoke-ComfyRawRequest -Url $Url -Method $Method -Body $BodyBytes -ContentType $ContentType -TimeoutSec $TimeoutSec
        # 把请求号塞进返回值带回来：OnDone 拿不到闭包变量，
        # 只有 $result 这一个入口
        $r.RequestId = $RequestId
        return $r
    }

    $arguments = @{
        Url         = $Url
        Method      = $methodUpper
        BodyBytes   = $bodyBytes
        ContentType = $sendContentType
        TimeoutSec  = $TimeoutSec
        RequestId   = $RequestId
    }

    [void](Start-AsyncTask -Work $work -Arguments $arguments -OnDone {
        param($result)
        Complete-ComfyProxyRequest -Result $result
    })
}

function Complete-ComfyProxyRequest {
    # 主线程：后台发完了，把结果发回插件
    param($Result)

    if ($null -eq $Result) {
        # 拿不到 RequestId 就只能算了 —— 插件那边有超时兜底，不会一直挂着
        return
    }
    if (-not $Result.RequestId) { return }

    $payload = @{
        ok      = [bool]$Result.Ok
        status  = [int]$Result.Status
        body    = ''
        type    = [string]$Result.ContentType
        error   = [string]$Result.Error
    }

    $bytes = $Result.Bytes
    # 同样用 .Length 判断，别用 if($bytes)
    if ($null -ne $bytes -and $bytes.Length -gt 0) {
        if ($bytes.Length -gt $script:ComfyMaxResponseBytes) {
            $payload.ok = $false
            $payload.error = ("ComfyUI 返回的内容太大（{0:N1} MB），超过代理上限 {1:N0} MB，已丢弃。" -f `
                ($bytes.Length / 1MB), ($script:ComfyMaxResponseBytes / 1MB))
        } else {
            $payload.body = [System.Convert]::ToBase64String($bytes)
        }
    }

    Send-BridgeComfyResponse -RequestId ([string]$Result.RequestId) -Payload $payload
}
