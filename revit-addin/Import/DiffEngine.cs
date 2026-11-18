using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Import;

/// <summary>
/// Three-way diff between CSV rows and model elements. Ids are level-scoped, so
/// both sides are keyed by "directory/id": rows by the directory they were read
/// from (<c>_dir</c>), elements by _IdMap.csv (uuid → directory/id) or by their
/// BimDown_Id in the directory of their level. A row whose key misses still
/// matches an element with the same bare id when that id is unique.
/// </summary>
static class DiffEngine
{
    public static DiffResult Diff(List<Dictionary<string, string?>> csvRows, IList<Element> modelElements, IReadOnlyDictionary<string, string>? uuidToIdMap = null)
    {
        var modelByKey = new Dictionary<string, Element>();
        var modelByBare = new Dictionary<string, List<Element>>();
        var keyOf = new Dictionary<ElementId, string>();
        foreach (var el in modelElements)
        {
            var key = ModelKey(el, uuidToIdMap);
            if (key is null) continue;
            modelByKey[key] = el;
            keyOf[el.Id] = key;
            var bare = key[(key.IndexOf('/') + 1)..];
            if (!modelByBare.TryGetValue(bare, out var list)) modelByBare[bare] = list = [];
            list.Add(el);
        }

        var toUpdate = new List<(Dictionary<string, string?> Row, Element Element)>();
        var toCreate = new List<Dictionary<string, string?>>();
        var matched = new HashSet<ElementId>();

        foreach (var row in csvRows)
        {
            var id = row.GetValueOrDefault("id");
            if (id is null) { toCreate.Add(row); continue; }
            var dir = row.GetValueOrDefault("_dir") ?? "global";
            Element? element = null;
            if (modelByKey.TryGetValue(IdMap.Key(dir, id), out var byKey) && !matched.Contains(byKey.Id)) element = byKey;
            else if (modelByBare.TryGetValue(id, out var bare) && bare.Count == 1 && !matched.Contains(bare[0].Id)) element = bare[0];

            if (element is not null)
            {
                toUpdate.Add((row, element));
                matched.Add(element.Id);
            }
            else toCreate.Add(row);
        }

        var toDelete = modelElements
            .Where(el => keyOf.ContainsKey(el.Id) && !matched.Contains(el.Id))
            .ToList();

        return new DiffResult(toUpdate, toCreate, toDelete);
    }

    static string? ModelKey(Element el, IReadOnlyDictionary<string, string>? uuidToIdMap)
    {
        if (uuidToIdMap is not null && uuidToIdMap.TryGetValue(el.UniqueId, out var mapped))
            return mapped.Contains('/') ? mapped : IdMap.Key("global", mapped);
        var bid = BimDownParameter.Get(el);
        if (bid is null) return null;
        var levelDir = el is Level ? null
            : el.LevelId is { } lid && lid != ElementId.InvalidElementId && el.Document.GetElement(lid) is Level lv
                ? BimDownParameter.Get(lv)
                : null;
        return IdMap.Key(levelDir ?? "global", bid);
    }
}
