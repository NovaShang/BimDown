using Autodesk.Revit.DB;

namespace BimDown.RevitAddin.Extractors;

/// <summary>
/// <c>type_id</c>: the element's Revit type (WallType, FloorType, FamilySymbol, …)
/// as its UniqueId; remapped to the type table's short id, and dropped when the
/// type table does not export that type.
/// </summary>
public class TypeIdExtractor : IFieldExtractor
{
    public IReadOnlyList<string> FieldNames { get; } = ["type_id"];

    public Dictionary<string, string?> Extract(Element element) =>
        new() { ["type_id"] = RevitReaders.TypeUid(element) };
}
