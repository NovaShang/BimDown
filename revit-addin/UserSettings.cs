using System.Text.Json;

namespace BimDown.RevitAddin;

static class UserSettings
{
    static readonly string SettingsDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BimDown");

    static readonly string SettingsFile = Path.Combine(SettingsDir, "settings.json");

    static Dictionary<string, string>? _cache;

    public static string? LastExportPath
    {
        get => Get("LastExportPath");
        set => Set("LastExportPath", value);
    }

    public static string? LastImportPath
    {
        get => Get("LastImportPath");
        set => Set("LastImportPath", value);
    }

    public static string ShareApiBase
    {
        get => Get("ShareApiBase") ?? "https://bimdown.com";
        set => Set("ShareApiBase", value);
    }

    public static string ShareExpires
    {
        get => Get("ShareExpires") ?? "7d";
        set => Set("ShareExpires", value);
    }

    public static List<string>? GetList(string key)
    {
        var raw = Get(key);
        if (raw is null) return null;
        try { return JsonSerializer.Deserialize<List<string>>(raw); }
        catch { return null; }
    }

    public static void SetList(string key, List<string> value) =>
        Set(key, JsonSerializer.Serialize(value));

    public static bool GetBool(string key, bool defaultValue)
    {
        var raw = Get(key);
        return raw is not null ? raw == "true" : defaultValue;
    }

    public static void SetBool(string key, bool value) =>
        Set(key, value ? "true" : "false");

    static string? Get(string key)
    {
        var data = Load();
        return data.GetValueOrDefault(key);
    }

    static void Set(string key, string? value)
    {
        var data = Load();
        if (value is null)
            data.Remove(key);
        else
            data[key] = value;
        Save(data);
    }

    static Dictionary<string, string> Load()
    {
        if (_cache is not null) return _cache;
        try
        {
            if (File.Exists(SettingsFile))
            {
                var json = File.ReadAllText(SettingsFile);
                _cache = JsonSerializer.Deserialize<Dictionary<string, string>>(json) ?? [];
                return _cache;
            }
        }
        catch { }
        _cache = [];
        return _cache;
    }

    static void Save(Dictionary<string, string> data)
    {
        try
        {
            Directory.CreateDirectory(SettingsDir);
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(SettingsFile, json);
            _cache = data;
        }
        catch { }
    }
}
