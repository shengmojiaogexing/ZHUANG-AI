# ============================================================
#  Native.ps1 — Win32 互操作集中地
#
#  整个助手只在这里 Add-Type 一次。其它模块直接用 [Huanmeng.Win32]::Xxx。
#
#  包含四块：
#    1. 分层窗口（圆环的透明/抗锯齿靠它，TransparencyKey 做不到半透明）
#    2. 全局热键 RegisterHotKey
#    3. 低级鼠标钩子（Alt + 右键）
#    4. DPI 感知（不做的话高分屏上圆环会被系统拉伸成糊的）
# ============================================================

if (-not ('Huanmeng.Win32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;

namespace Huanmeng {

public static class Win32 {

    // ---------- 分层窗口 ----------

    public const int GWL_EXSTYLE      = -20;
    public const int WS_EX_LAYERED    = 0x00080000;
    public const int WS_EX_TRANSPARENT= 0x00000020;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_NOACTIVATE = 0x08000000;

    public const int ULW_ALPHA    = 0x00000002;
    public const byte AC_SRC_OVER = 0x00;
    public const byte AC_SRC_ALPHA= 0x01;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx; public int cy; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct BLENDFUNCTION {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UpdateLayeredWindow(
        IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
        IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")]  public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")]  public static extern bool DeleteDC(IntPtr hDC);
    [DllImport("gdi32.dll")]  public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll")]  public static extern bool DeleteObject(IntPtr hObject);

    /// 把一张 32bppArgb 位图整体推给分层窗口。
    /// GetHbitmap(Color.FromArgb(0)) 拿到的是**预乘 alpha** 的 DIB，
    /// 正好是 UpdateLayeredWindow + AC_SRC_ALPHA 要的格式 —— 别换成别的重载。
    /// 返回 false 表示 UpdateLayeredWindow 失败（窗口没建好、句柄无效等）。
    /// 失败时窗口会保持上一次的内容 —— 表现是「圆环不显示」，很难查，
    /// 所以调用方要把它记进日志。
    public static bool PushBitmap(IntPtr hwnd, Bitmap bitmap, int x, int y) {
        IntPtr screenDc  = GetDC(IntPtr.Zero);
        IntPtr memDc     = CreateCompatibleDC(screenDc);
        IntPtr hBitmap   = IntPtr.Zero;
        IntPtr oldBitmap = IntPtr.Zero;
        bool ok = false;
        try {
            hBitmap   = bitmap.GetHbitmap(Color.FromArgb(0));
            oldBitmap = SelectObject(memDc, hBitmap);

            SIZE  size        = new SIZE  { cx = bitmap.Width, cy = bitmap.Height };
            POINT pointSource = new POINT { X = 0, Y = 0 };
            POINT topPos      = new POINT { X = x, Y = y };
            BLENDFUNCTION blend = new BLENDFUNCTION {
                BlendOp             = AC_SRC_OVER,
                BlendFlags          = 0,
                SourceConstantAlpha = 255,
                AlphaFormat         = AC_SRC_ALPHA
            };

            ok = UpdateLayeredWindow(hwnd, screenDc, ref topPos, ref size,
                                     memDc, ref pointSource, 0, ref blend, ULW_ALPHA);
        } finally {
            if (oldBitmap != IntPtr.Zero) SelectObject(memDc, oldBitmap);
            if (hBitmap   != IntPtr.Zero) DeleteObject(hBitmap);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
        return ok;
    }

    /// 把一个无边框窗体改成可以整块推图的分层窗口。
    /// 传 true 会额外加 WS_EX_NOACTIVATE：圆环不该抢焦点，
    /// 否则用户在弹出的圆环上按 Esc，Esc 会送给圆环而不是还在前台的 Photoshop。
    public static void MakeLayered(IntPtr hwnd, bool noActivate) {
        int style = GetWindowLong(hwnd, GWL_EXSTYLE);
        style |= WS_EX_LAYERED | WS_EX_TOOLWINDOW;
        if (noActivate) style |= WS_EX_NOACTIVATE;
        SetWindowLong(hwnd, GWL_EXSTYLE, style);
    }

    // ---------- 全局热键 ----------

    public const int WM_HOTKEY = 0x0312;

    public const uint MOD_ALT      = 0x0001;
    public const uint MOD_CONTROL  = 0x0002;
    public const uint MOD_SHIFT    = 0x0004;
    public const uint MOD_WIN      = 0x0008;
    public const uint MOD_NOREPEAT = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    // ---------- 低级鼠标钩子 ----------

    public const int WH_MOUSE_LL    = 14;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_RBUTTONUP   = 0x0205;

    public const int VK_MENU = 0x12;

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT {
        public POINT  pt;
        public uint   mouseData;
        public uint   flags;
        public uint   time;
        public IntPtr dwExtraInfo;
    }

    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    // ---------- 低级键盘钩子 ----------
    //
    // 圆环是 WS_EX_NOACTIVATE 的：它**永远不拿焦点**，所以收不到 WM_KEYDOWN，
    // Esc / 数字键 / 方向键就无从谈起。用低级键盘钩子旁路拿到这些键。
    // 只有在圆环或气泡开着的时候才吞键，其余时间一律放行。

    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN     = 0x0100;
    public const int WM_SYSKEYDOWN  = 0x0104;

    public const int VK_BACK   = 0x08;
    public const int VK_RETURN = 0x0D;
    public const int VK_ESCAPE = 0x1B;
    public const int VK_LEFT   = 0x25;
    public const int VK_DELETE = 0x2E;

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT {
        public uint   vkCode;
        public uint   scanCode;
        public uint   flags;
        public uint   time;
        public IntPtr dwExtraInfo;
    }

    public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    // ---------- 光标 / 窗口 ----------

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);

    // VK_MENU 上面已经有了（public const int），这里只用它的字节形式喂给 keybd_event
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    /// <summary>
    /// 取窗口在屏幕上的矩形。窗口不存在或已销毁时返回 false。
    /// 气泡要靠它决定弹到哪儿 —— 贴着当前在用的那个窗口，而不是鼠标。
    /// </summary>
    public static bool TryGetWindowRect(IntPtr hWnd, out int left, out int top, out int right, out int bottom) {
        left = top = right = bottom = 0;
        if (hWnd == IntPtr.Zero) { return false; }
        RECT r;
        if (!GetWindowRect(hWnd, out r)) { return false; }
        // 最小化的窗口 rect 是 (-32000,-32000) 这种哨兵值，当没有处理
        if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) { return false; }
        left = r.Left; top = r.Top; right = r.Right; bottom = r.Bottom;
        return true;
    }

    /// <summary>
    /// 强行把 hWnd 提到前台并给它键盘焦点。
    ///
    /// **为什么不能只调 SetForegroundWindow：**
    /// Windows 有「前台锁定」—— 不是当前前台进程的窗口，SetForegroundWindow
    /// 会被系统**静默拒绝**（返回 false，不抛异常，就是没反应）。
    /// 助手正好是这个处境：它是托盘常驻程序，圆环窗口还带 WS_EX_NOACTIVATE，
    /// 从头到尾就没当过前台。于是气泡弹出来了、看得见，键盘焦点却还留在
    /// Photoshop 那边 —— 用户打字打进了 PS，表现就是「圆环的对话用不了」。
    ///
    /// 两步绕开限制：
    ///   1. AttachThreadInput 把本线程挂到当前前台线程的输入队列上，
    ///      让本线程「看起来」属于前台；
    ///   2. 合成一次 ALT 敲击，让系统认为最后一次输入发生在本进程
    ///      （这是 SetForegroundWindow 放行的条件之一）。
    /// ALT 只按不配其他键，不会触发菜单或快捷键。
    /// </summary>
    public static bool ForceForegroundWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) { return false; }

        IntPtr fg = GetForegroundWindow();
        if (fg == hWnd) { return true; }

        // 注意：不能写 `out uint fgPid`。PowerShell 5.1 的 Add-Type 用的是
        // 老 CodeDom 编译器（C# 5），内联 out 声明是 C# 7 才有的语法，会编译失败。
        uint fgPid = 0;
        uint fgThread = 0;
        if (fg != IntPtr.Zero) { fgThread = GetWindowThreadProcessId(fg, out fgPid); }
        uint myThread = GetCurrentThreadId();

        bool attached = false;
        if (fgThread != 0 && fgThread != myThread) {
            attached = AttachThreadInput(fgThread, myThread, true);
        }

        try {
            // 只在真的被前台锁定挡住时才用合成按键 —— 它会在目标程序里
            // 留下一次「ALT 按下又抬起」，能少一次就少一次
            if (!SetForegroundWindow(hWnd)) {
                keybd_event((byte)VK_MENU, 0, 0, System.UIntPtr.Zero);
                keybd_event((byte)VK_MENU, 0, KEYEVENTF_KEYUP, System.UIntPtr.Zero);
                SetForegroundWindow(hWnd);
            }
            return GetForegroundWindow() == hWnd;
        } finally {
            if (attached) { AttachThreadInput(fgThread, myThread, false); }
        }
    }

    /// 把当前前台窗口记下来，气泡关掉时还回去。
    /// 光有句柄不够 —— 前台窗口可能在气泡存在期间被销毁，还之前要确认它还活着。
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    /// 销毁从 Bitmap.GetHicon() 拿到的图标句柄。
    /// 不销毁的话每次换配色都会泄漏一个 GDI 对象 —— 挂机久了会耗尽 GDI 额度，
    /// 表现出来就是整个程序画不出东西。
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr hIcon);

    // ---------- DPI ----------

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);

    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    /// 优先按显示器级 v2；老系统退回整机级。失败都无害 —— 只是高分屏会糊一点。
    public static void EnableDpiAwareness() {
        try {
            if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != IntPtr.Zero) return;
        } catch (EntryPointNotFoundException) {
        } catch (DllNotFoundException) {
        }
        try { SetProcessDPIAware(); } catch { }
    }
}

/// 低级鼠标钩子。
///
/// **为什么钩子本身要放在 C# 里、而不是像以前那样让 PowerShell 提供回调**：
/// WH_MOUSE_LL 是全局钩子 —— 系统里**每一次**鼠标事件（包括移动，每秒几百上千次）
/// 都会同步回调这个函数。回调里跑 PowerShell 的话，每次鼠标移动都意味着
/// 一次脚本块调用、参数绑定和若干次 P/Invoke —— 系统级输入延迟就是这么来的，
/// 表现就是「Photoshop 画笔卡顿、整个桌面发黏」。
///
/// 现在热路径是纯原生的：不是右键按下就直接放行（几微秒），
/// 是右键按下才查 Alt 键、查到了才回调 PowerShell 一次。
/// 右键是低频事件，这一步的 PowerShell 开销可以忽略。
public class MouseHook : System.IDisposable {

    private IntPtr _hook = IntPtr.Zero;
    private Win32.LowLevelMouseProc _proc;

    /// 由 PowerShell 注入。Alt+右键发生时回调 (x, y)，
    /// 返回 true 表示「这个右键我处理了，别传给系统」。
    public Func<int, int, bool> AltRightClickHandler;

    public bool Installed { get { return _hook != IntPtr.Zero; } }

    public MouseHook() {
        _proc = HookProc;   // 存成字段，防 GC 回收委托后 Windows 调野指针
        _hook = Win32.SetWindowsHookEx(Win32.WH_MOUSE_LL, _proc, Win32.GetModuleHandle(null), 0);
    }

    public void Dispose() {
        if (_hook != IntPtr.Zero) { Win32.UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        _proc = null;
    }

    private IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && wParam == (IntPtr)Win32.WM_RBUTTONDOWN) {
            if ((Win32.GetAsyncKeyState(Win32.VK_MENU) & 0x8000) != 0) {
                Func<int, int, bool> handler = AltRightClickHandler;
                if (handler != null) {
                    Win32.MSLLHOOKSTRUCT info = (Win32.MSLLHOOKSTRUCT)
                        System.Runtime.InteropServices.Marshal.PtrToStructure(lParam, typeof(Win32.MSLLHOOKSTRUCT));
                    bool handled = false;
                    try { handled = handler(info.pt.X, info.pt.Y); }
                    catch { /* 业务异常绝不允许跨过 P/Invoke 边界 —— 那会直接崩进程 */ }
                    if (handled) return (IntPtr)1;
                }
            }
        }
        return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }
}

/// 低级键盘钩子。和 MouseHook 同一个道理：键按下的过滤在原生层完成，
/// PowerShell 只为真正需要解释的键（圆环开着的时候）跑一次。
/// 圆环收起时 PS 会把 Active 置 false —— 那时连 vkCode 都不传给脚本。
public class KeyboardHook : System.IDisposable {

    private IntPtr _hook = IntPtr.Zero;
    private Win32.LowLevelKeyboardProc _proc;

    /// PowerShell 注入。键按下时回调 vkCode，返回 true 表示吞掉这个键。
    public Func<int, bool> KeyDownHandler;

    /// PowerShell 在圆环可见时置 true。false 时这个钩子完全零开销放行。
    public volatile bool Active;

    public bool Installed { get { return _hook != IntPtr.Zero; } }

    public KeyboardHook() {
        _proc = HookProc;
        _hook = Win32.SetWindowsHookEx(Win32.WH_KEYBOARD_LL, _proc, Win32.GetModuleHandle(null), 0);
    }

    public void Dispose() {
        if (_hook != IntPtr.Zero) { Win32.UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        _proc = null;
    }

    private IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && Active &&
            (wParam == (IntPtr)Win32.WM_KEYDOWN || wParam == (IntPtr)Win32.WM_SYSKEYDOWN)) {
            Func<int, bool> handler = KeyDownHandler;
            if (handler != null) {
                Win32.KBDLLHOOKSTRUCT info = (Win32.KBDLLHOOKSTRUCT)
                    System.Runtime.InteropServices.Marshal.PtrToStructure(lParam, typeof(Win32.KBDLLHOOKSTRUCT));
                bool handled = false;
                try { handled = handler((int)info.vkCode); }
                catch { }
                if (handled) return (IntPtr)1;
            }
        }
        return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }
}

/// 收 WM_HOTKEY 的消息窗。
///
/// 为什么不用 Form：Form 的 WndProc 在 PowerShell 里改不了（protected virtual），
/// 而 RegisterHotKey 的结果是发到窗口消息里的，不接管 WndProc 就收不到。
/// NativeWindow 是专门给这种「只要一个窗口句柄 + 自己处理消息」的场景用的。
public class HotkeyWindow : System.Windows.Forms.NativeWindow {

    public event Action<int> Hotkey;

    public HotkeyWindow() {
        CreateHandle(new System.Windows.Forms.CreateParams());
    }

    protected override void WndProc(ref System.Windows.Forms.Message m) {
        if (m.Msg == Win32.WM_HOTKEY) {
            Action<int> handler = Hotkey;
            if (handler != null) handler(m.WParam.ToInt32());
        }
        base.WndProc(ref m);
    }
}

/// 深色主题的滑杆。
///
/// 为什么用 C# 而不是在 PowerShell 里画：**状态必须活在对象上，不能活在闭包里**。
/// PowerShell 的脚本块虽然在函数里创建、看起来能捕获局部变量，
/// 但函数一返回，那些变量就被清空了 —— 事件回调里读到的全是 $null。
/// （这不是猜测，是实测：函数内定义的 handler 里读局部变量得到的是空值。）
/// 把 Min/Max/Value 做成字段、回调做成事件，就没有这个问题了。
///
/// 另一个好处：系统 TrackBar 的槽和滑块是系统绘制的，深色界面上改不了配色，
/// 只能自绘。
public class UiSlider : System.Windows.Forms.Control {

    public double Min = 0.0;
    public double Max = 100.0;
    public string ValueFormat = "{0}";

    public System.Drawing.Color TrackColor = System.Drawing.Color.FromArgb(40, 48, 61);
    public System.Drawing.Color Accent     = System.Drawing.Color.FromArgb(77, 134, 255);
    public System.Drawing.Color KnobColor  = System.Drawing.Color.FromArgb(232, 238, 247);
    public System.Drawing.Color ReadoutColor = System.Drawing.Color.FromArgb(138, 150, 168);

    /// 留给右侧读数文字的宽度
    public int ReadoutWidth = 90;

    private double _value = 0.0;
    private bool _dragging = false;

    public event Action<double> ValueChanged;

    public UiSlider() {
        // SupportsTransparentBackColor 必须带上。
        // 光有 AllPaintingInWmPaint/UserPaint，基类仍然会拒绝
        // BackColor = Transparent（抛「控件不支持透明的背景色」），
        // 而滑杆要贴在深色窗体上，背景必须透出父容器的颜色。
        SetStyle(System.Windows.Forms.ControlStyles.AllPaintingInWmPaint |
                 System.Windows.Forms.ControlStyles.UserPaint |
                 System.Windows.Forms.ControlStyles.OptimizedDoubleBuffer |
                 System.Windows.Forms.ControlStyles.ResizeRedraw |
                 System.Windows.Forms.ControlStyles.SupportsTransparentBackColor, true);
        Height = 30;
        Width = 400;
        BackColor = System.Drawing.Color.Transparent;
        try {
            Font = new System.Drawing.Font("Microsoft YaHei UI", 12f, System.Drawing.FontStyle.Regular, System.Drawing.GraphicsUnit.Pixel);
        } catch { }
    }

    public double Value {
        get { return _value; }
        set {
            double v = value;
            if (v < Min) v = Min;
            if (v > Max) v = Max;
            if (Math.Abs(v - _value) < 1e-9) return;
            _value = v;
            Invalidate();
            Action<double> handler = ValueChanged;
            if (handler != null) handler(_value);
        }
    }

    /// 初始化用：设值但不触发 ValueChanged。
    /// 构造阶段就触发回调的话，会在页面还没建完时去写配置。
    public void SetValueSilent(double v) {
        if (v < Min) v = Min;
        if (v > Max) v = Max;
        _value = v;
        Invalidate();
    }

    private int TrackWidth {
        get {
            int w = Width - ReadoutWidth;
            return w > 10 ? w : 10;
        }
    }

    protected override void OnPaint(System.Windows.Forms.PaintEventArgs e) {
        System.Drawing.Graphics g = e.Graphics;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        // 半透明背景上用 ClearType 会出彩色边，用灰度抗锯齿
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;

        int trackW = TrackWidth;
        int midY = Height / 2;

        double ratio = (Max > Min) ? (_value - Min) / (Max - Min) : 0.0;
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;

        int barH = 5;
        using (System.Drawing.SolidBrush brush = new System.Drawing.SolidBrush(TrackColor)) {
            g.FillRectangle(brush, 0, midY - barH / 2, trackW, barH);
        }

        int fillW = (int)(trackW * ratio);
        if (fillW > 1) {
            using (System.Drawing.SolidBrush brush = new System.Drawing.SolidBrush(Accent)) {
                g.FillRectangle(brush, 0, midY - barH / 2, fillW, barH);
            }
        }

        int knobX = (int)(trackW * ratio);
        int knobR = 8;
        using (System.Drawing.SolidBrush brush = new System.Drawing.SolidBrush(KnobColor)) {
            g.FillEllipse(brush, knobX - knobR, midY - knobR, knobR * 2, knobR * 2);
        }

        string text = _value.ToString(ValueFormat);
        System.Drawing.Font font = Font;
        if (font != null) {
            using (System.Drawing.SolidBrush brush = new System.Drawing.SolidBrush(ReadoutColor)) {
                g.DrawString(text, font, brush, trackW + 8, midY - font.Height / 2f);
            }
        }
    }

    private void ApplyFromX(int x) {
        int trackW = TrackWidth;
        double ratio = (double)x / trackW;
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;
        Value = Min + ratio * (Max - Min);
    }

    protected override void OnMouseDown(System.Windows.Forms.MouseEventArgs e) {
        _dragging = true;
        ApplyFromX(e.X);
        base.OnMouseDown(e);
    }

    protected override void OnMouseMove(System.Windows.Forms.MouseEventArgs e) {
        if (_dragging) ApplyFromX(e.X);
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(System.Windows.Forms.MouseEventArgs e) {
        _dragging = false;
        base.OnMouseUp(e);
    }

    // 拖到一半滑出控件也要结束拖动，否则鼠标移回来会「粘」着走
    protected override void OnMouseLeave(EventArgs e) {
        _dragging = false;
        base.OnMouseLeave(e);
    }
}

/// 圆环用的窗体基类。
///
/// 为什么要在 C# 里派生而不是在 PowerShell 里配：
///   `ShowWithoutActivation` 和 `CreateParams` 都是 protected override，
///   纯 PowerShell 改不了。而这两件事恰恰是圆环能不能「弹出来但不抢焦点」的关键 ——
///   抢了焦点，用户按 Esc 就关不掉圆环（Esc 送给圆环而不是 Photoshop），
///   而且 Photoshop 会以为自己的窗口失活。
public class LayeredForm : System.Windows.Forms.Form {

    /// true = 弹出来不抢焦点（圆环）；false = 正常抢（气泡要打字）
    public bool NoActivate = true;

    protected override bool ShowWithoutActivation {
        get { return NoActivate; }
    }

    protected override System.Windows.Forms.CreateParams CreateParams {
        get {
            System.Windows.Forms.CreateParams cp = base.CreateParams;
            cp.ExStyle |= Win32.WS_EX_LAYERED | Win32.WS_EX_TOOLWINDOW;
            if (NoActivate) cp.ExStyle |= Win32.WS_EX_NOACTIVATE;
            // 无边框 + 不参与 Alt+Tab。做成圆环以后这两条都是必须的。
            cp.ExStyle |= 0x00000080;
            return cp;
        }
    }
}

}
'@ -ReferencedAssemblies System.Drawing, System.Windows.Forms
}

# 热键 id，避开系统占用的低位段
$script:HK_MAIN = 0x484D01   # 主热键

function Get-CursorPosition {
    $pt = New-Object Huanmeng.Win32+POINT
    [void][Huanmeng.Win32]::GetCursorPos([ref]$pt)
    return @{ X = $pt.X; Y = $pt.Y }
}

function Test-AltDown {
    # 高位为 1 表示当前按下。GetAsyncKeyState 在钩子回调里读是准的。
    return ([Huanmeng.Win32]::GetAsyncKeyState([Huanmeng.Win32]::VK_MENU) -band 0x8000) -ne 0
}
