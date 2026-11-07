using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace HuanmengRing
{
    internal static class AppPaths
    {
        public static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        public static readonly string ConfigPath = Path.Combine(Home, ".huanmeng-ring.json");
        public static readonly string PresetPath = Path.Combine(Home, ".huanmeng-presets.json");
        public static readonly string PresetBackupPath = Path.Combine(Home, ".huanmeng-presets.backup.json");
        public static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;
        public static readonly string BundledPresetPath = Path.Combine(AppDir, "presets.json");
        public static readonly string LogPath = Path.Combine(Path.GetTempPath(), "huanmeng-ring-wpf.log");
    }

    internal static class Log
    {
        public static void Write(string message)
        {
            try
            {
                File.AppendAllText(
                    AppPaths.LogPath,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine,
                    new UTF8Encoding(false));
            }
            catch { }
        }
    }

    internal sealed class AppConfig
    {
        public int Port = 8799;
        public HotkeySpec Hotkey = HotkeySpec.Parse("ctrl+alt+r");
        public double OuterRadius = 182.0;
        public double BandRatio = 0.499;
        public double Opacity = 0.9;
        public double PopDistance = 8.0;
        public double GapRatio = 0.1257;
        public double GapMax = 6.0;
        public bool ShadowEnabled = true;
        public double ShadowBlur = 14.0;
        public double ShadowOffsetY = 6.0;
        public double ShadowAlpha = 0.496;
        public bool ShowDirectionLine = true;
        public double AppearScale = 0.86;
        public string Theme = "slate";
        public bool Animation = true;
        public string PresetAction = "both";
        public bool AltRightClick = true;
        public string AltRightScope = "global";

        public static AppConfig Load()
        {
            AppConfig cfg = new AppConfig();
            if (!File.Exists(AppPaths.ConfigPath)) return cfg;
            try
            {
                string text = File.ReadAllText(AppPaths.ConfigPath, Encoding.UTF8);
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = 8 * 1024 * 1024;
                Dictionary<string, object> root = serializer.DeserializeObject(text) as Dictionary<string, object>;
                if (root == null) return cfg;

                cfg.Port = Json.Int(root, "port", 8799);
                if (cfg.Port < 1024 || cfg.Port > 65535) cfg.Port = 8799;

                Dictionary<string, object> interaction = Json.Dict(root, "interaction");
                string hotkey = Json.String(interaction, "hotkey", "ctrl+alt+r");
                cfg.Hotkey = HotkeySpec.Parse(hotkey);
                cfg.AltRightClick = Json.Bool(interaction, "altRightClick", true);
                cfg.AltRightScope = Json.String(interaction, "altRightClickScope", "global");

                Dictionary<string, object> appearance = Json.Dict(root, "appearance");
                cfg.OuterRadius = Json.Double(appearance, "outerRadius", 182.0);
                cfg.BandRatio = Json.Double(appearance, "bandRatio", 0.499);
                cfg.Opacity = Json.Double(appearance, "opacity", 0.9);
                cfg.PopDistance = Json.Double(appearance, "popDistance", 8.0);
                cfg.GapRatio = Json.Double(appearance, "gapRatio", 0.1257);
                cfg.GapMax = Json.Double(appearance, "gapMax", 6.0);
                cfg.ShadowEnabled = Json.Bool(appearance, "shadowEnabled", true);
                cfg.ShadowBlur = Json.Double(appearance, "shadowBlur", 14.0);
                cfg.ShadowOffsetY = Json.Double(appearance, "shadowOffsetY", 6.0);
                cfg.ShadowAlpha = Json.Double(appearance, "shadowAlpha", 0.496);
                cfg.ShowDirectionLine = Json.Bool(appearance, "showDirectionLine", true);
                cfg.AppearScale = Json.Double(appearance, "appearScale", 0.86);
                cfg.Theme = Json.String(appearance, "theme", "slate");
                cfg.Animation = Json.Bool(appearance, "animation", true);

                Dictionary<string, object> content = Json.Dict(root, "content");
                cfg.PresetAction = Json.String(content, "presetAction", "both");

                if (cfg.OuterRadius < 120) cfg.OuterRadius = 120;
                if (cfg.OuterRadius > 280) cfg.OuterRadius = 280;
                if (cfg.BandRatio < 0.25) cfg.BandRatio = 0.25;
                if (cfg.BandRatio > 0.75) cfg.BandRatio = 0.75;
                if (cfg.Opacity < 0.5) cfg.Opacity = 0.5;
                if (cfg.Opacity > 1.0) cfg.Opacity = 1.0;
                if (cfg.PopDistance < 0) cfg.PopDistance = 0;
                if (cfg.PopDistance > 30) cfg.PopDistance = 30;
                if (cfg.GapRatio < 0) cfg.GapRatio = 0;
                if (cfg.GapRatio > 0.4) cfg.GapRatio = 0.4;
                if (cfg.GapMax < 0) cfg.GapMax = 0;
                if (cfg.GapMax > 12) cfg.GapMax = 12;
                if (cfg.ShadowBlur < 0) cfg.ShadowBlur = 0;
                if (cfg.ShadowBlur > 40) cfg.ShadowBlur = 40;
                if (cfg.ShadowAlpha < 0) cfg.ShadowAlpha = 0;
                if (cfg.ShadowAlpha > 1) cfg.ShadowAlpha = 1;
                if (cfg.AppearScale < 0.5) cfg.AppearScale = 0.5;
                if (cfg.AppearScale > 1) cfg.AppearScale = 1;
            }
            catch (Exception error)
            {
                Log.Write("读取配置失败：" + error.Message);
            }
            return cfg;
        }
    }

    internal static class Json
    {
        public static Dictionary<string, object> Dict(Dictionary<string, object> source, string key)
        {
            if (source == null) return null;
            object value;
            if (!source.TryGetValue(key, out value)) return null;
            return value as Dictionary<string, object>;
        }

        public static string String(Dictionary<string, object> source, string key, string fallback)
        {
            if (source == null) return fallback;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return fallback;
            string text = Convert.ToString(value);
            return string.IsNullOrEmpty(text) ? fallback : text;
        }

        public static int Int(Dictionary<string, object> source, string key, int fallback)
        {
            if (source == null) return fallback;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt32(value); } catch { return fallback; }
        }

        public static double Double(Dictionary<string, object> source, string key, double fallback)
        {
            if (source == null) return fallback;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToDouble(value); } catch { return fallback; }
        }

        public static bool Bool(Dictionary<string, object> source, string key, bool fallback)
        {
            if (source == null) return fallback;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToBoolean(value); } catch { return fallback; }
        }
    }

    internal sealed class HotkeySpec
    {
        public uint Modifiers;
        public uint VirtualKey;
        public string Display;

        public static HotkeySpec Parse(string text)
        {
            HotkeySpec spec = new HotkeySpec();
            spec.Modifiers = 0x0002 | 0x0001; // Ctrl + Alt
            spec.VirtualKey = 0x52;          // R
            spec.Display = "Ctrl+Alt+R";
            if (string.IsNullOrEmpty(text)) return spec;

            string[] parts = text.ToLowerInvariant().Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return spec;

            uint modifiers = 0;
            uint vk = 0;
            List<string> labels = new List<string>();
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i].Trim();
                if (part == "ctrl" || part == "control") { modifiers |= 0x0002; labels.Add("Ctrl"); }
                else if (part == "alt") { modifiers |= 0x0001; labels.Add("Alt"); }
                else if (part == "shift") { modifiers |= 0x0004; labels.Add("Shift"); }
                else if (part == "win" || part == "windows") { modifiers |= 0x0008; labels.Add("Win"); }
                else if (part.Length > 0) { vk = KeyToVk(part); if (vk != 0) labels.Add(part.ToUpperInvariant()); }
            }
            if (vk == 0) return spec;
            if (modifiers == 0) return spec;

            spec.Modifiers = modifiers;
            spec.VirtualKey = vk;
            spec.Display = string.Join("+", labels.ToArray());
            return spec;
        }

        private static uint KeyToVk(string key)
        {
            if (key.Length == 1)
            {
                char c = char.ToUpperInvariant(key[0]);
                if (c >= 'A' && c <= 'Z') return (uint)c;
                if (c >= '0' && c <= '9') return (uint)c;
            }
            if (key.Length >= 2 && key[0] == 'f')
            {
                int number;
                if (int.TryParse(key.Substring(1), out number) && number >= 1 && number <= 24)
                    return (uint)(0x70 + number - 1);
            }
            if (key == "space") return 0x20;
            if (key == "enter" || key == "return") return 0x0D;
            if (key == "esc" || key == "escape") return 0x1B;
            if (key == "tab") return 0x09;
            if (key == "backspace") return 0x08;
            return 0;
        }
    }
}















