# ============================================================
#  Bridge.ps1 — 和 Photoshop 插件之间的桥（WebSocket 服务端，127.0.0.1:8799）
#
#  协议是插件定的，见 插件/Dream-ps-ai/src/features/ring-bridge/ring-bridge.js：
#    助手 = 服务端；插件 = 客户端（UXP 只有 WebSocket 客户端 API，开不了监听端口）
#
#    助手 → 插件   {type:'hello', ...}
#                  {type:'command', id, action, payload, resolved:true}
#                  {type:'comfy-response', id, payload:{ok, status, body, type, error, blocked?}}
#    插件 → 助手   {type:'state',    payload:{document, params, options, presets, chat, sectors, actions, labels}}
#                  {type:'progress', state:'running'|'success'|'failure', message, thumbnail?}
#                  {type:'chat',     action:'history'|'thinking'|'reply'|'error', payload:{...}}
#                  {type:'config',   action:'export'|'presets', payload:{...}}
#                  {type:'comfy-request', id, url, method, bodyBase64?, contentType?, timeoutSec?}
#
#  comfy-* 这一对是**反方向**的请求/响应：别的消息都是「助手说、插件听」，
#  只有它是插件主动要一样东西、助手给回去。起因是 UXP 的 fetch 强制校验 CORS，
#  直连 ComfyUI 会被拦（详见 Comfy.ps1 的文件头）。
#  id 由插件生成，响应原样带回来做配对；插件侧有超时兜底。
#
#  **服务端用 C# 写而不是 PowerShell**：
#  PS 5.1 里做异步 socket 要么靠线程池回调（回调进不了正在跑消息循环的 runspace，
#  直接死锁），要么靠 Start-ThreadJob（5.1 默认没有这个模块）。
#  用 C# 起一个自己的后台线程，收发全部走并发队列，
#  PowerShell 这边只需要在主线程定时 Drain 一下 —— 简单且不可能死锁。
#
#  不用 HttpListener 的原因：它对非管理员账号需要用 netsh 加 URL ACL 才能监听
#  任意端口，而「双击 bat 就装完」的定位不允许用户去动 netsh。
#  TcpListener 没有这个限制，代价是 WebSocket 握手要自己实现（下面就是）。
# ============================================================

if (-not ('Huanmeng.WsServer' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace Huanmeng {

/// 单客户端的 WebSocket 服务端。
/// 「单客户端」是刻意的：理论上只会有 PS 插件这一个连接方，
/// 而两个插件实例同时连上来会互相覆盖状态，圆环上的显示就会乱跳。
public class WsServer {

    private readonly int _port;
    private TcpListener _listener;
    private Thread _thread;
    private volatile bool _running;

    private TcpClient _client;
    private NetworkStream _stream;
    private readonly object _sendLock = new object();

    private readonly ConcurrentQueue<string> _inbox = new ConcurrentQueue<string>();
    private readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();

    private volatile bool _connected;
    public bool IsConnected { get { return _connected; } }
    public int Port { get { return _port; } }

    public WsServer(int port) { _port = port; }

    public bool Start() {
        try {
            _listener = new TcpListener(IPAddress.Loopback, _port);
            _listener.Start();
        } catch (SocketException) {
            return false;
        }
        _running = true;
        _thread = new Thread(AcceptLoop);
        _thread.IsBackground = true;
        _thread.Name = "HuanmengBridge";
        _thread.Start();
        return true;
    }

    public void Stop() {
        _running = false;
        try { if (_listener != null) _listener.Stop(); } catch { }
        CloseClient();
    }

    private void CloseClient() {
        _connected = false;
        try { if (_stream != null) _stream.Close(); } catch { }
        try { if (_client != null) _client.Close(); } catch { }
        _stream = null;
        _client = null;
    }

    /// 后台线程：accept → 握手 → 收帧，断了就回去等下一个
    private void AcceptLoop() {
        while (_running) {
            TcpClient incoming = null;
            try {
                incoming = _listener.AcceptTcpClient();
            } catch {
                if (!_running) return;
                Thread.Sleep(200);
                continue;
            }

            try {
                incoming.NoDelay = true;
                NetworkStream stream = incoming.GetStream();
                stream.ReadTimeout = 10000;

                if (!Handshake(stream)) {
                    incoming.Close();
                    continue;
                }

                // 新连接顶掉旧连接：插件重连时旧 socket 可能还没超时死掉，
                // 两个都留着的话发指令会发到那个死的上面去
                lock (_sendLock) {
                    CloseClient();
                    _client = incoming;
                    _stream = stream;
                    _connected = true;
                }
                stream.ReadTimeout = Timeout.Infinite;
                // 写超时必须设。发指令是在主线程上做的，客户端要是卡住不读，
                // 没有超时的话整个 UI 会跟着一起卡死在这次 Write 上。
                stream.WriteTimeout = 8000;
                _events.Enqueue("open");

                ReadLoop(stream);

                lock (_sendLock) {
                    if (_stream == stream) CloseClient();
                }
                _events.Enqueue("close");
            } catch {
                try { incoming.Close(); } catch { }
            }
        }
    }

    /// 读 HTTP 升级请求，回应 101。
    private bool Handshake(NetworkStream stream) {
        StringBuilder header = new StringBuilder();
        byte[] one = new byte[1];
        int matched = 0;
        // 逐字节读到 \r\n\r\n 为止。不用 StreamReader —— 那玩意儿会预读，
        // 把紧跟其后的 WebSocket 帧一起吞进缓冲区里，后面就全乱了。
        while (matched < 4) {
            int read = stream.Read(one, 0, 1);
            if (read <= 0) return false;
            char c = (char)one[0];
            header.Append(c);
            if ((matched == 0 || matched == 2) && c == '\r') matched++;
            else if ((matched == 1 || matched == 3) && c == '\n') matched++;
            else matched = 0;
            if (header.Length > 16384) return false;
        }

        string text = header.ToString();
        string key = null;
        foreach (string line in text.Split('\n')) {
            int colon = line.IndexOf(':');
            if (colon <= 0) continue;
            if (line.Substring(0, colon).Trim().Equals("Sec-WebSocket-Key", StringComparison.OrdinalIgnoreCase)) {
                key = line.Substring(colon + 1).Trim();
                break;
            }
        }
        if (key == null) return false;

        // RFC 6455：Accept = base64( SHA1( key + 固定 GUID ) )
        string accept;
        using (SHA1 sha = SHA1.Create()) {
            byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
            accept = Convert.ToBase64String(hash);
        }

        string response =
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";

        byte[] outBytes = Encoding.UTF8.GetBytes(response);
        stream.Write(outBytes, 0, outBytes.Length);
        stream.Flush();
        return true;
    }

    private void ReadLoop(NetworkStream stream) {
        MemoryStream fragment = new MemoryStream();
        int fragmentOpcode = 0;

        while (_running) {
            int b0 = stream.ReadByte();
            if (b0 < 0) return;
            int b1 = stream.ReadByte();
            if (b1 < 0) return;

            bool fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0F;
            bool masked = (b1 & 0x80) != 0;
            long length = b1 & 0x7F;

            if (length == 126) {
                byte[] ext = ReadExact(stream, 2);
                if (ext == null) return;
                length = (ext[0] << 8) | ext[1];
            } else if (length == 127) {
                byte[] ext = ReadExact(stream, 8);
                if (ext == null) return;
                length = 0;
                for (int i = 0; i < 8; i++) length = (length << 8) | ext[i];
            }

            byte[] mask = null;
            if (masked) {
                mask = ReadExact(stream, 4);
                if (mask == null) return;
            }

            if (length > 32L * 1024 * 1024) return;   // 单帧 32MB 以上直接掐断

            byte[] payload = length > 0 ? ReadExact(stream, (int)length) : new byte[0];
            if (payload == null) return;

            if (masked) {
                for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];
            }

            switch (opcode) {
                case 0x8:   // close
                    SendFrame(0x8, new byte[0]);
                    return;

                case 0x9:   // ping → pong
                    SendFrame(0xA, payload);
                    break;

                case 0xA:   // pong，不用管
                    break;

                case 0x1:   // text
                case 0x2:   // binary
                    if (fin) {
                        _inbox.Enqueue(Encoding.UTF8.GetString(payload));
                    } else {
                        fragmentOpcode = opcode;
                        fragment.SetLength(0);
                        fragment.Write(payload, 0, payload.Length);
                    }
                    break;

                case 0x0:   // continuation
                    fragment.Write(payload, 0, payload.Length);
                    if (fin) {
                        _inbox.Enqueue(Encoding.UTF8.GetString(fragment.ToArray()));
                        fragment.SetLength(0);
                        fragmentOpcode = 0;
                    }
                    break;
            }
        }
    }

    private static byte[] ReadExact(NetworkStream stream, int count) {
        byte[] buffer = new byte[count];
        int offset = 0;
        while (offset < count) {
            int read = stream.Read(buffer, offset, count - offset);
            if (read <= 0) return null;
            offset += read;
        }
        return buffer;
    }

    /// 发一条文本帧。发送和接收在不同的线程上，所以要加锁。
    public bool Send(string text) {
        return SendFrame(0x1, Encoding.UTF8.GetBytes(text));
    }

    private bool SendFrame(int opcode, byte[] payload) {
        lock (_sendLock) {
            if (_stream == null || !_connected) return false;
            try {
                MemoryStream frame = new MemoryStream();
                frame.WriteByte((byte)(0x80 | opcode));

                if (payload.Length < 126) {
                    frame.WriteByte((byte)payload.Length);
                } else if (payload.Length <= 0xFFFF) {
                    frame.WriteByte(126);
                    frame.WriteByte((byte)((payload.Length >> 8) & 0xFF));
                    frame.WriteByte((byte)(payload.Length & 0xFF));
                } else {
                    frame.WriteByte(127);
                    // ⚠️ 必须先把 payload.Length 转成 long 再移位。
                    //
                    // payload.Length 是 int，而 C# 对 int 的移位次数**按 5 位掩码**（& 31）：
                    // i=7 时的 >> 56 会变成 >> 24，i=6 的 >> 48 变成 >> 16……于是
                    // 长度字段被写成 00 25 FC 94 00 25 FC 94（正确值是 00 00 00 00 00 25 FC 94）。
                    // 客户端读到一个天文数字的帧长，判定协议错误，直接把连接断掉。
                    //
                    // 这个 bug 很久没被发现，是因为在此之前走桥的消息**没有一条超过 64KB**。
                    // ComfyUI 代理送 .object_info（1.8MB → base64 2.4MB）是第一个超的，
                    // 而且症状极具误导性：不是报错，是**圆环主线程卡死**——
                    // 同步写 socket 写到一半对方断连，写操作就永远回不来了。
                    for (int i = 7; i >= 0; i--) {
                        frame.WriteByte((byte)(((long)payload.Length >> (8 * i)) & 0xFF));
                    }
                }

                // 服务端发的帧**不加掩码**（RFC 6455 规定服务端不得掩码）
                frame.Write(payload, 0, payload.Length);

                byte[] bytes = frame.ToArray();
                _stream.Write(bytes, 0, bytes.Length);
                _stream.Flush();
                return true;
            } catch {
                _connected = false;
                return false;
            }
        }
    }

    /// 取走自上次调用以来收到的所有消息（主线程定时调）
    public string[] DrainIncoming() {
        System.Collections.Generic.List<string> list = new System.Collections.Generic.List<string>();
        string item;
        while (_inbox.TryDequeue(out item)) list.Add(item);
        return list.ToArray();
    }

    /// 连接状态变化事件（"open" / "close"），同样由主线程取走
    public string[] DrainEvents() {
        System.Collections.Generic.List<string> list = new System.Collections.Generic.List<string>();
        string item;
        while (_events.TryDequeue(out item)) list.Add(item);
        return list.ToArray();
    }
}

}
'@
}

# ---------- PowerShell 侧的封装 ----------

$script:Bridge = @{
    Server    = $null
    # 插件最近一次推上来的 state，圆环和偏好设置都读它
    State     = @{}
    Connected = $false
    Loaded    = $false
}

function Start-HuanmengBridge {
    param([int]$Port = 8799)

    $server = New-Object Huanmeng.WsServer($Port)
    if (-not $server.Start()) {
        return @{ Ok = $false; Error = "端口 $Port 被占用 —— 多半是已经有一个幻梦圆环在跑了。先退出它再试。" }
    }
    $script:Bridge.Server = $server
    return @{ Ok = $true; Error = '' }
}

function Stop-HuanmengBridge {
    if ($script:Bridge.Server) {
        $script:Bridge.Server.Stop()
        $script:Bridge.Server = $null
    }
}

function Send-BridgeHello {
    if (-not $script:Bridge.Server) { return }
    # 插件对 hello 是直接忽略的（ring-bridge.js 里 `message.type === 'hello'` 就 return）。
    # 留着是为了协议完整性 —— 以后加握手里带版本号之类的不用改插件。
    $payload = @{
        type    = 'hello'
        app     = '幻梦圆环'
        version = [string]$script:HuanmengVersion
        os      = 'windows'
    } | ConvertTo-Json -Compress
    [void]$script:Bridge.Server.Send($payload)
}

function Send-BridgeCommand {
    param(
        [string]$Action,
        [hashtable]$Payload = @{},
        [switch]$Unresolved
    )

    if (-not $script:Bridge.Server -or -not $script:Bridge.Server.IsConnected) {
        return $false
    }

    $message = @{
        type    = 'command'
        id      = [Guid]::NewGuid().ToString('N')
        action  = $Action
        payload = $Payload
    }
    # resolved:true 告诉插件「这个 action 已经解析过了，别再拿你的槽位表翻译一次」。
    # 不加的话，插件会用它在面板设置里的配置覆盖掉用户在圆环偏好里做的选择。
    if (-not $Unresolved) { $message.resolved = $true }

    return [bool]$script:Bridge.Server.Send(($message | ConvertTo-Json -Depth 8 -Compress))
}

function Send-BridgeComfyResponse {
    <#
      把 ComfyUI 代理的结果发回插件。
      body 一律是 base64 的原始字节 —— 不在这里解 JSON，
      因为 /view 回来的本来就是图片二进制，混着两种形态反而容易出错。
      插件那边统一按字节收，再自己决定要不要当 JSON 解。
    #>
    param(
        [string]$RequestId,
        [hashtable]$Payload
    )

    if (-not $RequestId) { return }
    if (-not $script:Bridge.Server -or -not $script:Bridge.Server.IsConnected) { return }

    $message = @{
        type    = 'comfy-response'
        id      = $RequestId
        payload = $Payload
    }
    [void]$script:Bridge.Server.Send(($message | ConvertTo-Json -Depth 6 -Compress))
}

function Update-HuanmengBridge {
    # 主线程定时调：把后台线程收到的东西搬进来
    if (-not $script:Bridge.Server) { return }

    foreach ($event in $script:Bridge.Server.DrainEvents()) {
        if ($event -eq 'open') {
            $script:Bridge.Connected = $true
            Send-BridgeHello
            if ($script:OnBridgeConnected) { & $script:OnBridgeConnected }
        } elseif ($event -eq 'close') {
            $script:Bridge.Connected = $false
            $script:Bridge.State = @{}
            if ($script:OnBridgeDisconnected) { & $script:OnBridgeDisconnected }
        }
        if ($script:PushStatus) { & $script:PushStatus }
    }

    foreach ($raw in $script:Bridge.Server.DrainIncoming()) {
        $message = $null
        try { $message = ConvertFrom-Json $raw } catch { continue }
        if (-not $message -or -not $message.type) { continue }

        switch ($message.type) {
            'state' {
                $script:Bridge.State = ConvertTo-HashtableDeep $message.payload
                if ($script:OnPluginState) { & $script:OnPluginState $script:Bridge.State }
            }
            'progress' {
                if ($script:OnPluginProgress) {
                    & $script:OnPluginProgress ([string]$message.state) ([string]$message.message) ([string]$message.thumbnail)
                }
            }
            'chat' {
                if ($script:OnPluginChat) {
                    & $script:OnPluginChat ([string]$message.action) $message.payload
                }
            }
            'config' {
                # 插件主动推过来的接口配置 / 预设 —— 存下来，用户在偏好设置里
                # 可以选择「用插件那份覆盖本地」
                if ($message.action -eq 'export') {
                    $script:Bridge.IncomingConfig = ConvertTo-HashtableDeep $message.payload
                } elseif ($message.action -eq 'presets') {
                    $script:Bridge.IncomingPresets = ConvertTo-HashtableDeep $message.payload
                }
            }
            'comfy-request' {
                # 插件直连 ComfyUI 被 CORS 拦了，改由圆环代发（见 Comfy.ps1）。

                # 超时值夹在 [5,600] 秒：插件传 0 或乱传一个数都会让请求立刻失败
                # 或者把圆环挂很久。用 TryParse 而不是 [int] 强转，脏值不抛异常。
                $comfyTimeout = 120
                if ($null -ne $message.timeoutSec) {
                    $parsedTimeout = 0
                    if ([int]::TryParse([string]$message.timeoutSec, [ref]$parsedTimeout)) {
                        if ($parsedTimeout -ge 5 -and $parsedTimeout -le 600) {
                            $comfyTimeout = $parsedTimeout
                        }
                    }
                }

                # ⚠️ 这里**不能**有阻塞调用。Update-HuanmengBridge 跑在 UI 线程的
                # WinForms 定时器里（150ms 一次），而拉一次 /object_info 就是 1.8MB、
                # 本机实测 163ms —— 在这儿直接发请求，圆环会肉眼可见地卡一下，
                # 拖滑杆的时候尤其明显。Start-ComfyProxyRequest 只负责丢给后台 runspace。
                Start-ComfyProxyRequest `
                    -RequestId ([string]$message.id) `
                    -Url ([string]$message.url) `
                    -Method ([string]$message.method) `
                    -BodyBase64 ([string]$message.bodyBase64) `
                    -ContentType ([string]$message.contentType) `
                    -AllowedHosts (Get-ComfyAllowedHosts) `
                    -TimeoutSec $comfyTimeout
            }
        }
    }
}

function Get-PluginState { return $script:Bridge.State }
function Test-PluginConnected { return [bool]$script:Bridge.Connected }
