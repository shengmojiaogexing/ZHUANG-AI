using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace HuanmengRing
{
    internal sealed class Preset
    {
        public string Name;
        public string Prompt;
        public string Category;

        public Preset(string category, string name, string prompt)
        {
            Category = string.IsNullOrEmpty(category) ? "未分类" : category;
            Name = name;
            Prompt = prompt;
        }
    }

    internal sealed class PresetStore
    {
        private List<Preset> _items = new List<Preset>();
        private string _lastSavedJson = "";

        public event EventHandler Changed;

        public int Count { get { return _items.Count; } }

        public List<Preset> Items
        {
            get { return new List<Preset>(_items); }
        }

        public void LoadLocal()
        {
            _items = new List<Preset>();
            try
            {
                if (!File.Exists(AppPaths.PresetPath) && File.Exists(AppPaths.BundledPresetPath))
                {
                    File.Copy(AppPaths.BundledPresetPath, AppPaths.PresetPath, true);
                }
                if (File.Exists(AppPaths.PresetPath))
                {
                    string text = File.ReadAllText(AppPaths.PresetPath, Encoding.UTF8);
                    _items = ParsePresetArray(text);
                }
            }
            catch (Exception error)
            {
                Log.Write("读取本地预设失败：" + error.Message);
            }
            _lastSavedJson = ToJson();
            RaiseChanged();
        }

        public bool ApplyPluginState(Dictionary<string, object> payload)
        {
            if (payload == null) return false;
            object presetsValue;
            if (!payload.TryGetValue("presets", out presetsValue)) return false;
            object[] groups = presetsValue as object[];
            if (groups == null || groups.Length == 0) return false;

            List<Preset> next = new List<Preset>();
            for (int g = 0; g < groups.Length; g++)
            {
                Dictionary<string, object> group = groups[g] as Dictionary<string, object>;
                if (group == null) continue;
                string category = Json.String(group, "category", "未分类");
                object itemsValue;
                if (!group.TryGetValue("items", out itemsValue)) continue;
                object[] items = itemsValue as object[];
                if (items == null) continue;
                for (int i = 0; i < items.Length; i++)
                {
                    Dictionary<string, object> item = items[i] as Dictionary<string, object>;
                    if (item == null) continue;
                    string name = Json.String(item, "name", "");
                    string prompt = Json.String(item, "prompt", "");
                    if (name.Length == 0 || prompt.Length == 0) continue;
                    next.Add(new Preset(category, name, prompt));
                }
            }
            if (next.Count == 0) return false;

            _items = next;
            SaveLocal(true);
            RaiseChanged();
            return true;
        }

        public List<string> Categories()
        {
            List<string> result = new List<string>();
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < _items.Count; i++)
            {
                string category = _items[i].Category;
                if (seen.Add(category)) result.Add(category);
            }
            return result;
        }

        public List<Preset> InCategory(string category)
        {
            List<Preset> result = new List<Preset>();
            for (int i = 0; i < _items.Count; i++)
            {
                if (string.Equals(_items[i].Category, category, StringComparison.Ordinal))
                    result.Add(_items[i]);
            }
            return result;
        }

        public int CountInCategory(string category)
        {
            int count = 0;
            for (int i = 0; i < _items.Count; i++)
            {
                if (string.Equals(_items[i].Category, category, StringComparison.Ordinal)) count++;
            }
            return count;
        }

        public void SaveLocal(bool backup)
        {
            try
            {
                string json = ToJson();
                if (json == _lastSavedJson && File.Exists(AppPaths.PresetPath)) return;

                if (backup && File.Exists(AppPaths.PresetPath) && !File.Exists(AppPaths.PresetBackupPath))
                {
                    try { File.Copy(AppPaths.PresetPath, AppPaths.PresetBackupPath, false); }
                    catch (Exception backupError) { Log.Write("备份预设失败：" + backupError.Message); }
                }

                string temp = AppPaths.PresetPath + ".tmp";
                File.WriteAllText(temp, json, new UTF8Encoding(false));
                if (File.Exists(AppPaths.PresetPath)) File.Delete(AppPaths.PresetPath);
                File.Move(temp, AppPaths.PresetPath);
                _lastSavedJson = json;
            }
            catch (Exception error)
            {
                Log.Write("写入本地预设失败：" + error.Message);
            }
        }

        public string ToJson()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 8 * 1024 * 1024;
            List<Dictionary<string, string>> rows = new List<Dictionary<string, string>>();
            for (int i = 0; i < _items.Count; i++)
            {
                Dictionary<string, string> row = new Dictionary<string, string>();
                row["category"] = _items[i].Category;
                row["name"] = _items[i].Name;
                row["prompt"] = _items[i].Prompt;
                rows.Add(row);
            }
            return serializer.Serialize(rows);
        }

        private static List<Preset> ParsePresetArray(string text)
        {
            List<Preset> result = new List<Preset>();
            if (string.IsNullOrEmpty(text)) return result;
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 16 * 1024 * 1024;
            object parsed = serializer.DeserializeObject(text);
            object[] rows = parsed as object[];
            if (rows == null) return result;
            for (int i = 0; i < rows.Length; i++)
            {
                Dictionary<string, object> row = rows[i] as Dictionary<string, object>;
                if (row == null) continue;
                string name = Json.String(row, "name", "");
                string prompt = Json.String(row, "prompt", "");
                string category = Json.String(row, "category", "未分类");
                if (name.Length == 0 || prompt.Length == 0) continue;
                result.Add(new Preset(category, name, prompt));
            }
            return result;
        }

        private void RaiseChanged()
        {
            EventHandler handler = Changed;
            if (handler != null)
            {
                try { handler(this, EventArgs.Empty); }
                catch (Exception error) { Log.Write("预设变更通知失败：" + error.Message); }
            }
        }
    }
}















