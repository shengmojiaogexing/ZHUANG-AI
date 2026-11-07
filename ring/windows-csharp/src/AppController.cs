using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using WinForms = System.Windows.Forms;

namespace HuanmengRing
{
    internal sealed class AppController
    {
        private const int WM_HOTKEY = 0x0312;
        private const uint MOD_NOREPEAT = 0x4000;
        private const int HOTKEY_ID = 0x484D;

        private readonly Application _app;
        private readonly AppConfig _config;
        private readonly PresetStore _store;
        private readonly BridgeServer _bridge;
        private readonly RingWindow _window;
        private readonly Dispatcher _dispatcher;
        private readonly string[] _args;

        private WinForms.NotifyIcon _tray;
        private WinForms.ToolStripMenuItem _statusItem;
        private WinForms.ToolStripMenuItem _showItem;
        private Icon _trayIcon;
        private HwndSource _hwndSource;
        private AltRightHook _altRightHook;
        private bool _hotkeyRegistered;
        private HotkeySpec _activeHotkey;
        private bool _disposed;

        public AppController(Application app, string[] args)
        {
            _app = app;
            _args = args ?? new string[0];
            _dispatcher = app.Dispatcher;
            _config = AppConfig.Load();
            _store = new PresetStore();
            _store.Changed += StoreChanged;
            _store.LoadLocal();

            _window = new RingWindow(this, _store, _config);
            _bridge = new BridgeServer(_config.Port);
            _bridge.MessageReceived += BridgeMessage;
            _bridge.ConnectionChanged += BridgeConnection;

            CreateTray();
            EnsureWindowHandle();
            RegisterGlobalHotkey();
            InstallAltRightHook();
            StartBridge();

            if (HasArg("--show"))
            {
                _dispatcher.BeginInvoke(new Action(ShowOrToggleRing), DispatcherPriority.Normal);
            }
        }

        public AppConfig Config { get { return _config; } }

        public void ApplyPreset(Preset preset)
        {
            if (preset == null) return;
            bool copied = CopyText(preset.Prompt ?? "");
            bool applied = false;
            if (_bridge.IsConnected)
            {
                applied = SendApplyPreset(preset);
                Log.Write("套用预设：" + preset.Category + " / " + preset.Name + " 发送=" + applied);
            }

            string message;
            if (applied && copied) message = "已复制并套用：" + preset.Name;
            else if (applied) message = "已套用到插件：" + preset.Name;
            else if (copied) message = "已复制：" + preset.Name + "（插件未连接）";
            else message = "复制失败，插件也未连接：" + preset.Name;

            ShowBalloon("幻梦圆环", message, applied ? WinForms.ToolTipIcon.Info : WinForms.ToolTipIcon.Warning);
        }

        private static bool CopyText(string text)
        {
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    WinForms.Clipboard.SetText(text);
                    return true;
                }
                catch (Exception error)
                {
                    if (attempt == 5) Log.Write("复制预设失败：" + error.Message);
                    Thread.Sleep(45);
                }
            }
            return false;
        }

        public void ShowOrToggleRing()
        {
            if (_window.IsVisible)
            {
                _window.HideRing();
                return;
            }
            if (_store.Count == 0)
            {
                ShowBalloon("幻梦圆环", "没有可用预设，请先启动 Photoshop 插件或检查预设文件", WinForms.ToolTipIcon.Warning);
                return;
            }
            _window.SetBridgeConnected(_bridge.IsConnected);
            _window.ShowRing();
        }

        private bool SendApplyPreset(Preset preset)
        {
            try
            {
                Dictionary<string, object> payload = new Dictionary<string, object>();
                payload["name"] = preset.Name;
                payload["category"] = preset.Category;

                Dictionary<string, object> message = new Dictionary<string, object>();
                message["type"] = "command";
                message["id"] = Guid.NewGuid().ToString("N");
                message["action"] = "applyPreset";
                message["payload"] = payload;
                message["resolved"] = true;

                JavaScriptSerializer serializer = new JavaScriptSerializer();
                return _bridge.Send(serializer.Serialize(message));
            }
            catch (Exception error)
            {
                Log.Write("发送套用预设失败：" + error.Message);
                return false;
            }
        }

        private void StartBridge()
        {
            if (!_bridge.Start())
            {
                ShowBalloon("幻梦圆环", "桥接端口 " + _config.Port + " 启动失败，可能旧圆环还在运行", WinForms.ToolTipIcon.Error);
                UpdateTrayStatus();
                return;
            }
            UpdateTrayStatus();
        }

        private void BridgeConnection(bool connected)
        {
            _dispatcher.BeginInvoke(new Action(delegate
            {
                _window.SetBridgeConnected(connected);
                if (connected) SendHello();
                UpdateTrayStatus();
            }));
        }

        private void SendHello()
        {
            try
            {
                Dictionary<string, object> message = new Dictionary<string, object>();
                message["type"] = "hello";
                message["app"] = "幻梦圆环";
                message["version"] = "2.0.0";
                message["os"] = "windows";
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                _bridge.Send(serializer.Serialize(message));
            }
            catch (Exception error)
            {
                Log.Write("发送 hello 失败：" + error.Message);
            }
        }

        private void BridgeMessage(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return;
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = 16 * 1024 * 1024;
                Dictionary<string, object> message = serializer.DeserializeObject(raw) as Dictionary<string, object>;
                if (message == null) return;
                string type = Json.String(message, "type", "");
                if (type != "state") return;
                Dictionary<string, object> payload = null;
                object payloadValue;
                if (message.TryGetValue("payload", out payloadValue))
                    payload = payloadValue as Dictionary<string, object>;
                if (payload == null) return;

                _dispatcher.BeginInvoke(new Action(delegate
                {
                    if (_store.ApplyPluginState(payload))
                    {
                        _window.RefreshPresets();
                        UpdateTrayStatus();
                    }
                }));
            }
            catch (Exception error)
            {
                Log.Write("解析插件 state 失败：" + error.Message);
            }
        }

        private void StoreChanged(object sender, EventArgs e)
        {
            if (_dispatcher == null) return;
            _dispatcher.BeginInvoke(new Action(delegate
            {
                _window.RefreshPresets();
                UpdateTrayStatus();
            }));
        }

        private void CreateTray()
        {
            _tray = new WinForms.NotifyIcon();
            _trayIcon = BuildTrayIcon();
            _tray.Icon = _trayIcon;
            _tray.Text = "幻梦圆环 · 预设";
            _tray.Visible = true;
            _tray.DoubleClick += delegate { ShowOrToggleRing(); };

            WinForms.ContextMenuStrip menu = new WinForms.ContextMenuStrip();
            _showItem = new WinForms.ToolStripMenuItem("显示圆环 (" + _config.Hotkey.Display + ")");
            _showItem.Click += delegate { ShowOrToggleRing(); };
            menu.Items.Add(_showItem);

            _statusItem = new WinForms.ToolStripMenuItem("插件：未连接");
            _statusItem.Enabled = false;
            menu.Items.Add(_statusItem);

            menu.Items.Add(new WinForms.ToolStripSeparator());

            WinForms.ToolStripMenuItem reload = new WinForms.ToolStripMenuItem("重载本地预设");
            reload.Click += delegate { ReloadPresets(); };
            menu.Items.Add(reload);

            WinForms.ToolStripMenuItem openFile = new WinForms.ToolStripMenuItem("打开预设文件");
            openFile.Click += delegate { OpenPresetFile(); };
            menu.Items.Add(openFile);

            menu.Items.Add(new WinForms.ToolStripSeparator());

            WinForms.ToolStripMenuItem exit = new WinForms.ToolStripMenuItem("退出");
            exit.Click += delegate { ExitApp(); };
            menu.Items.Add(exit);

            _tray.ContextMenuStrip = menu;
            UpdateTrayStatus();
        }

        private void ReloadPresets()
        {
            _store.LoadLocal();
            _window.RefreshPresets();
            UpdateTrayStatus();
            ShowBalloon("幻梦圆环", "已重载 " + _store.Count + " 条预设", WinForms.ToolTipIcon.Info);
        }

        private void OpenPresetFile()
        {
            try
            {
                if (!File.Exists(AppPaths.PresetPath))
                    _store.SaveLocal(false);
                Process.Start("explorer.exe", "/select,\"" + AppPaths.PresetPath + "\"");
            }
            catch (Exception error)
            {
                Log.Write("打开预设文件失败：" + error.Message);
                ShowBalloon("幻梦圆环", "打不开预设文件", WinForms.ToolTipIcon.Error);
            }
        }

        private void UpdateTrayStatus()
        {
            if (_tray == null) return;
            bool connected = _bridge != null && _bridge.IsConnected;
            if (_statusItem != null)
                _statusItem.Text = connected ? "插件：已连接" : "插件：未连接";
            string text = "幻梦圆环 · " + _store.Count + " 条 · " + (connected ? "插件在线" : "插件离线");
            if (text.Length > 63) text = text.Substring(0, 63);
            _tray.Text = text;
        }

        private void ShowBalloon(string title, string text, WinForms.ToolTipIcon icon)
        {
            try
            {
                if (_tray != null) _tray.ShowBalloonTip(2200, title, text, icon);
            }
            catch { }
        }

        private void EnsureWindowHandle()
        {
            try
            {
                IntPtr handle = new WindowInteropHelper(_window).EnsureHandle();
                _hwndSource = HwndSource.FromHwnd(handle);
                if (_hwndSource != null) _hwndSource.AddHook(HotkeyWndProc);
            }
            catch (Exception error)
            {
                Log.Write("创建圆环窗口句柄失败：" + error.Message);
            }
        }

        private void InstallAltRightHook()
        {
            if (!_config.AltRightClick) return;
            _altRightHook = new AltRightHook(
                delegate
                {
                    if (_disposed) return;
                    _dispatcher.BeginInvoke(new Action(ShowOrToggleRing));
                },
                delegate
                {
                    if (!_config.AltRightClick) return false;
                    string scope = string.IsNullOrEmpty(_config.AltRightScope)
                        ? "global"
                        : _config.AltRightScope.ToLowerInvariant();
                    if (scope == "off") return false;
                    if (scope == "photoshop") return AltRightHook.IsPhotoshopForeground();
                    return true;
                });
            if (!_altRightHook.Install())
            {
                ShowBalloon("幻梦圆环", "Alt+右键钩子挂不上，热键和托盘仍可用", WinForms.ToolTipIcon.Warning);
            }
        }

        private void RegisterGlobalHotkey()
        {
            if (_hwndSource == null)
            {
                Log.Write("无法注册热键：窗口句柄为空");
                return;
            }
            HotkeySpec[] candidates = new HotkeySpec[]
            {
                _config.Hotkey,
                HotkeySpec.Parse("ctrl+alt+shift+r"),
                HotkeySpec.Parse("ctrl+shift+alt+f9")
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                HotkeySpec spec = candidates[i];
                if (spec == null || spec.VirtualKey == 0) continue;
                if (RegisterHotKey(_hwndSource.Handle, HOTKEY_ID, spec.Modifiers, spec.VirtualKey))
                {
                    _activeHotkey = spec;
                    _hotkeyRegistered = true;
                    if (_showItem != null) _showItem.Text = "显示圆环 (" + spec.Display + ")";
                    Log.Write("热键已注册：" + spec.Display);
                    if (i > 0)
                    {
                        ShowBalloon("幻梦圆环", _config.Hotkey.Display + " 被占用，已改用 " + spec.Display,
                            WinForms.ToolTipIcon.Info);
                    }
                    return;
                }
                Log.Write("热键候选失败：" + spec.Display + " 错误码=" + Marshal.GetLastWin32Error());
            }
            Log.Write("注册热键失败：" + _config.Hotkey.Display);
            ShowBalloon("幻梦圆环", "热键注册失败，可能被占用；可以从托盘打开", WinForms.ToolTipIcon.Warning);
        }

        private IntPtr HotkeyWndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WM_HOTKEY && wParam.ToInt32() == HOTKEY_ID)
            {
                handled = true;
                ShowOrToggleRing();
            }
            return IntPtr.Zero;
        }

        private void ExitApp()
        {
            if (_disposed) return;
            _disposed = true;
            try { UnregisterHotkey(); } catch { }
            try { if (_altRightHook != null) _altRightHook.Dispose(); } catch { }
            try { if (_bridge != null) _bridge.Stop(); } catch { }
            try
            {
                if (_tray != null)
                {
                    _tray.Visible = false;
                    _tray.Dispose();
                    _tray = null;
                }
            }
            catch { }
            try { if (_trayIcon != null) _trayIcon.Dispose(); } catch { }
            _app.Shutdown();
        }

        private void UnregisterHotkey()
        {
            if (_hotkeyRegistered && _hwndSource != null)
            {
                UnregisterHotKey(_hwndSource.Handle, HOTKEY_ID);
                _hotkeyRegistered = false;
            }
            if (_hwndSource != null)
            {
                _hwndSource.RemoveHook(HotkeyWndProc);
                _hwndSource = null;
            }
        }

        private static bool HasArg(string[] args, string expected)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], expected, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private bool HasArg(string expected)
        {
            return HasArg(_args, expected);
        }

        private static Icon BuildTrayIcon()
        {
            Bitmap bitmap = new Bitmap(32, 32);
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                using (Brush dark = new SolidBrush(Color.FromArgb(32, 37, 41)))
                    graphics.FillEllipse(dark, 2, 2, 28, 28);
                using (Pen green = new Pen(Color.FromArgb(53, 194, 122), 3.2f))
                    graphics.DrawEllipse(green, 7, 7, 18, 18);
                using (Brush dot = new SolidBrush(Color.FromArgb(242, 245, 242)))
                    graphics.FillEllipse(dot, 14, 14, 4, 4);
            }
            return Icon.FromHandle(bitmap.GetHicon());
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    }
}















