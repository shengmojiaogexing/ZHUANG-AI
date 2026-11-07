using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace HuanmengRing
{
    /// <summary>
    /// 低级鼠标钩子：按住 Alt 再点右键，唤出圆环。
    /// 只在右键按下时检查 Alt，命中后才回调 UI，不进入每个鼠标事件的托管层。
    /// </summary>
    internal sealed class AltRightHook : IDisposable
    {
        private const int WH_MOUSE_LL = 14;
        private const int WM_RBUTTONDOWN = 0x0204;
        private const int VK_MENU = 0x12;

        private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

        private readonly LowLevelMouseProc _proc;
        private readonly Action _onTrigger;
        private readonly Func<bool> _allowed;
        private IntPtr _hook;
        private bool _installed;

        public AltRightHook(Action onTrigger, Func<bool> allowed)
        {
            _onTrigger = onTrigger;
            _allowed = allowed;
            _proc = HookCallback;
        }

        public bool Install()
        {
            if (_installed) return true;
            try
            {
                IntPtr module = GetModuleHandle(null);
                _hook = SetWindowsHookEx(WH_MOUSE_LL, _proc, module, 0);
                _installed = _hook != IntPtr.Zero;
                if (!_installed)
                    Log.Write("Alt+右键钩子安装失败，错误码=" + Marshal.GetLastWin32Error());
                return _installed;
            }
            catch (Exception error)
            {
                Log.Write("Alt+右键钩子异常：" + error.Message);
                return false;
            }
        }

        public void Dispose()
        {
            if (_hook != IntPtr.Zero)
            {
                try { UnhookWindowsHookEx(_hook); } catch { }
                _hook = IntPtr.Zero;
            }
            _installed = false;
        }

        private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0 && wParam == (IntPtr)WM_RBUTTONDOWN)
                {
                    bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
                    if (alt && _allowed != null && _allowed())
                    {
                        if (_onTrigger != null) _onTrigger();
                        return (IntPtr)1; // 吞掉这次右键，不弹 Photoshop 右键菜单
                    }
                }
            }
            catch (Exception error)
            {
                Log.Write("Alt+右键回调异常：" + error.Message);
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        public static bool IsPhotoshopForeground()
        {
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero) return false;
                uint processId;
                GetWindowThreadProcessId(hwnd, out processId);
                if (processId == 0) return false;
                Process process = Process.GetProcessById((int)processId);
                return process != null && process.ProcessName.IndexOf("Photoshop", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch
            {
                return false;
            }
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr GetModuleHandle(string moduleName);
    }
}





