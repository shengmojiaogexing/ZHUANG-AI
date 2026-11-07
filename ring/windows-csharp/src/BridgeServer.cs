using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace HuanmengRing
{
    /// <summary>
    /// 单客户端 WebSocket 服务端。插件是客户端，圆环是服务端。
    /// 用 TcpListener 而不是 HttpListener，避免 localhost URL ACL 需要管理员权限。
    /// </summary>
    internal sealed class BridgeServer
    {
        private readonly int _port;
        private TcpListener _listener;
        private Thread _thread;
        private volatile bool _running;
        private TcpClient _client;
        private NetworkStream _stream;
        private readonly object _sendLock = new object();
        private volatile bool _connected;

        public event Action<string> MessageReceived;
        public event Action<bool> ConnectionChanged;

        public BridgeServer(int port)
        {
            _port = port;
        }

        public int Port { get { return _port; } }
        public bool IsConnected { get { return _connected; } }

        public bool Start()
        {
            try
            {
                _listener = new TcpListener(IPAddress.Loopback, _port);
                _listener.Start();
            }
            catch (Exception error)
            {
                Log.Write("桥接端口启动失败 " + _port + "：" + error.Message);
                return false;
            }
            _running = true;
            _thread = new Thread(AcceptLoop);
            _thread.IsBackground = true;
            _thread.Name = "HuanmengRingBridge";
            _thread.Start();
            return true;
        }

        public void Stop()
        {
            _running = false;
            try { if (_listener != null) _listener.Stop(); } catch { }
            bool was;
            lock (_sendLock)
            {
                was = _connected;
                CloseClient();
            }
            if (was) RaiseConnection(false);
        }

        private void CloseClient()
        {
            _connected = false;
            try { if (_stream != null) _stream.Close(); } catch { }
            try { if (_client != null) _client.Close(); } catch { }
            _stream = null;
            _client = null;
        }

        private void AcceptLoop()
        {
            while (_running)
            {
                TcpClient incoming = null;
                try
                {
                    incoming = _listener.AcceptTcpClient();
                }
                catch
                {
                    if (!_running) return;
                    Thread.Sleep(200);
                    continue;
                }

                NetworkStream stream = null;
                try
                {
                    incoming.NoDelay = true;
                    stream = incoming.GetStream();
                    stream.ReadTimeout = 10000;
                    if (!Handshake(stream))
                    {
                        incoming.Close();
                        continue;
                    }

                    // 新连接顶掉旧连接。插件重连时旧 socket 可能还没死。
                    lock (_sendLock)
                    {
                        CloseClient();
                        _client = incoming;
                        _stream = stream;
                        _connected = true;
                    }
                    stream.ReadTimeout = Timeout.Infinite;
                    stream.WriteTimeout = 8000;
                    RaiseConnection(true);

                    ReadLoop(stream);

                    bool wasCurrent;
                    lock (_sendLock)
                    {
                        wasCurrent = _stream == stream;
                        if (wasCurrent) CloseClient();
                    }
                    if (wasCurrent) RaiseConnection(false);
                }
                catch (Exception error)
                {
                    Log.Write("桥接连接异常：" + error.Message);
                    try { if (incoming != null) incoming.Close(); } catch { }
                    bool wasCurrent;
                    lock (_sendLock)
                    {
                        wasCurrent = _stream == stream;
                        if (wasCurrent) CloseClient();
                    }
                    if (wasCurrent) RaiseConnection(false);
                }
            }
        }

        private bool Handshake(NetworkStream stream)
        {
            StringBuilder header = new StringBuilder();
            byte[] one = new byte[1];
            int matched = 0;
            while (matched < 4)
            {
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
            string[] lines = text.Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon <= 0) continue;
                if (lines[i].Substring(0, colon).Trim().Equals("Sec-WebSocket-Key", StringComparison.OrdinalIgnoreCase))
                {
                    key = lines[i].Substring(colon + 1).Trim();
                    break;
                }
            }
            if (key == null) return false;

            string accept;
            using (SHA1 sha = SHA1.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
                accept = Convert.ToBase64String(hash);
            }

            string response =
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
            byte[] bytes = Encoding.UTF8.GetBytes(response);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
            return true;
        }

        private void ReadLoop(NetworkStream stream)
        {
            MemoryStream fragment = new MemoryStream();
            while (_running)
            {
                int b0 = stream.ReadByte();
                if (b0 < 0) return;
                int b1 = stream.ReadByte();
                if (b1 < 0) return;

                bool fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                bool masked = (b1 & 0x80) != 0;
                long length = b1 & 0x7F;

                if (length == 126)
                {
                    byte[] ext = ReadExact(stream, 2);
                    if (ext == null) return;
                    length = (ext[0] << 8) | ext[1];
                }
                else if (length == 127)
                {
                    byte[] ext = ReadExact(stream, 8);
                    if (ext == null) return;
                    length = 0;
                    for (int i = 0; i < 8; i++) length = (length << 8) | ext[i];
                }

                byte[] mask = null;
                if (masked)
                {
                    mask = ReadExact(stream, 4);
                    if (mask == null) return;
                }
                if (length > 32L * 1024 * 1024) return;

                byte[] payload = length > 0 ? ReadExact(stream, (int)length) : new byte[0];
                if (payload == null) return;
                if (masked)
                {
                    for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];
                }

                switch (opcode)
                {
                    case 0x8:
                        SendFrame(0x8, new byte[0]);
                        return;
                    case 0x9:
                        SendFrame(0xA, payload);
                        break;
                    case 0xA:
                        break;
                    case 0x1:
                    case 0x2:
                        if (fin)
                        {
                            RaiseMessage(Encoding.UTF8.GetString(payload));
                        }
                        else
                        {
                            fragment.SetLength(0);
                            fragment.Write(payload, 0, payload.Length);
                        }
                        break;
                    case 0x0:
                        fragment.Write(payload, 0, payload.Length);
                        if (fin)
                        {
                            RaiseMessage(Encoding.UTF8.GetString(fragment.ToArray()));
                            fragment.SetLength(0);
                        }
                        break;
                }
            }
        }

        private static byte[] ReadExact(NetworkStream stream, int count)
        {
            byte[] buffer = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buffer, offset, count - offset);
                if (read <= 0) return null;
                offset += read;
            }
            return buffer;
        }

        public bool Send(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            return SendFrame(0x1, Encoding.UTF8.GetBytes(text));
        }

        private bool SendFrame(int opcode, byte[] payload)
        {
            lock (_sendLock)
            {
                if (_stream == null || !_connected) return false;
                try
                {
                    MemoryStream frame = new MemoryStream();
                    frame.WriteByte((byte)(0x80 | opcode));
                    if (payload.Length < 126)
                    {
                        frame.WriteByte((byte)payload.Length);
                    }
                    else if (payload.Length <= 0xFFFF)
                    {
                        frame.WriteByte(126);
                        frame.WriteByte((byte)((payload.Length >> 8) & 0xFF));
                        frame.WriteByte((byte)(payload.Length & 0xFF));
                    }
                    else
                    {
                        frame.WriteByte(127);
                        for (int i = 7; i >= 0; i--)
                            frame.WriteByte((byte)(((long)payload.Length >> (8 * i)) & 0xFF));
                    }
                    frame.Write(payload, 0, payload.Length);
                    byte[] bytes = frame.ToArray();
                    _stream.Write(bytes, 0, bytes.Length);
                    _stream.Flush();
                    return true;
                }
                catch (Exception error)
                {
                    Log.Write("桥接发送失败：" + error.Message);
                    _connected = false;
                    return false;
                }
            }
        }

        private void RaiseMessage(string message)
        {
            Action<string> handler = MessageReceived;
            if (handler != null)
            {
                try { handler(message); }
                catch (Exception error) { Log.Write("桥接消息处理失败：" + error.Message); }
            }
        }

        private void RaiseConnection(bool connected)
        {
            Action<bool> handler = ConnectionChanged;
            if (handler != null)
            {
                try { handler(connected); }
                catch (Exception error) { Log.Write("桥接状态通知失败：" + error.Message); }
            }
        }
    }
}















