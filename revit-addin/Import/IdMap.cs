using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Import;

/// <summary>
/// BimDown short id → Revit element, directory-aware: ids are level-scoped
/// (w-1 exists in lv-1/ and lv-2/), so a reference resolves in the referencing
/// row's own directory first, then in global/, then by a unique bare id.
/// </summary>
class IdMap
{
    readonly Dictionary<string, ElementId> _byKey = new();
    readonly Dictionary<string, List<ElementId>> _byBare = new();

    /// <summary>Directory of the row being imported (set by TableImporterBase).</summary>
    public string CurrentDir { get; set; } = "global";

    public static string Key(string dir, string id) => $"{dir}/{id}";

    public void Register(string shortId, ElementId elementId) => Register(CurrentDir, shortId, elementId);

    public void Register(string dir, string shortId, ElementId elementId)
    {
        _byKey[Key(dir, shortId)] = elementId;
        if (!_byBare.TryGetValue(shortId, out var list)) _byBare[shortId] = list = [];
        if (!list.Contains(elementId)) list.Add(elementId);
    }

    public ElementId? Resolve(Document doc, string? shortId)
    {
        if (string.IsNullOrEmpty(shortId)) return null;
        if (_byKey.TryGetValue(Key(CurrentDir, shortId), out var id)) return id;
        if (_byKey.TryGetValue(Key("global", shortId), out id)) return id;
        return _byBare.TryGetValue(shortId, out var list) && list.Count == 1 ? list[0] : null;
    }

    public Level? ResolveLevel(Document doc, string? shortId)
    {
        var id = Resolve(doc, shortId);
        return id is not null ? doc.GetElement(id) as Level : null;
    }
}
