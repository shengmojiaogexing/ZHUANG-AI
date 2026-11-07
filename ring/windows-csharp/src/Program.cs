using System;
using System.Threading;
using System.Windows;
using System.Windows.Threading;

namespace HuanmengRing
{
    internal static class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Local\\HuanmengRingWpf", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("幻梦圆环已经在运行。", "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Information);
                    return;
                }

                Application app = new Application();
                app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                app.DispatcherUnhandledException += delegate (object sender, DispatcherUnhandledExceptionEventArgs e)
                {
                    Log.Write("未处理异常：" + e.Exception.Message + Environment.NewLine + e.Exception.StackTrace);
                    MessageBox.Show("幻梦圆环出错了：\n" + e.Exception.Message, "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Error);
                    e.Handled = true;
                };

                try
                {
                    AppController controller = new AppController(app, args);
                    GC.KeepAlive(controller);
                    app.Run();
                }
                catch (Exception error)
                {
                    Log.Write("启动失败：" + error.Message + Environment.NewLine + error.StackTrace);
                    MessageBox.Show("幻梦圆环启动失败：\n" + error.Message, "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }
    }
}















