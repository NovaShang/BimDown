using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure.StructuralSections;
using BimDown.RevitAddin.Mapping;

namespace BimDown.RevitAddin;

/// <summary>
/// Reads Revit API objects into the plain inputs of the pure mappers in
/// <c>Mapping/</c> (meters, enum names as strings). Only this layer touches
/// the Revit API; the mapping decisions are unit-tested without Revit.
/// </summary>
static class RevitReaders
{
    public static double M(double feet) => UnitConverter.Length(feet);

    public static string? MaterialName(Document doc, ElementId? id) =>
        id is not null && id != ElementId.InvalidElementId ? (doc.GetElement(id) as Material)?.Name : null;

    /// <summary>Thermal conductivity λ (W/(m·K)) from the material's thermal asset.</summary>
    public static double? Conductivity(Document doc, ElementId? materialId)
    {
        try
        {
            if (materialId is null || doc.GetElement(materialId) is not Material m) return null;
            if (doc.GetElement(m.ThermalAssetId) is not PropertySetElement pse) return null;
            var asset = pse.GetThermalAsset();
            if (asset is null) return null;
            var k = UnitUtils.ConvertFromInternalUnits(asset.ThermalConductivity, UnitTypeId.WattsPerMeterKelvin);
            return k > 0 ? k : null;
        }
        catch { return null; }
    }

    /// <summary>Compound structure layers, exterior / top first (Revit's own order).</summary>
    public static List<LayerInput> Layers(Document doc, CompoundStructure? cs)
    {
        var result = new List<LayerInput>();
        if (cs is null) return result;
        var first = cs.GetFirstCoreLayerIndex();
        var last = cs.GetLastCoreLayerIndex();
        var layers = cs.GetLayers();
        for (var i = 0; i < layers.Count; i++)
        {
            var l = layers[i];
            result.Add(new LayerInput(l.Function.ToString(), MaterialName(doc, l.MaterialId), M(l.Width),
                Conductivity(doc, l.MaterialId), i >= first && i <= last));
        }
        return result;
    }

    /// <summary>
    /// Core faces of a wall type in BimDown wall coordinates (offset on the left
    /// normal, which is the exterior side): (hi, lo) in meters.
    /// </summary>
    public static (double Hi, double Lo)? CoreOffsets(CompoundStructure? cs)
    {
        if (cs is null) return null;
        var layers = cs.GetLayers();
        if (layers.Count == 0) return null;
        var first = cs.GetFirstCoreLayerIndex();
        var last = cs.GetLastCoreLayerIndex();
        if (first < 0 || last < first) return null;
        var total = layers.Sum(l => l.Width);
        var before = layers.Take(first).Sum(l => l.Width);
        var through = layers.Take(last + 1).Sum(l => l.Width);
        return (M(total / 2 - before), M(total / 2 - through));
    }

    /// <summary>Length-type parameters of an element, lower-cased name → meters.</summary>
    public static Dictionary<string, double> LengthParams(Element? e)
    {
        var d = new Dictionary<string, double>();
        if (e is null) return d;
        foreach (Parameter p in e.Parameters)
        {
            try
            {
                if (p.StorageType != StorageType.Double || !p.HasValue) continue;
                if (p.Definition.GetDataType() != SpecTypeId.Length) continue;
                d.TryAdd(p.Definition.Name.Trim().ToLowerInvariant(), M(p.AsDouble()));
            }
            catch { /* some built-in parameters have no data type */ }
        }
        return d;
    }

    /// <summary>Section data of a structural framing / column family type.</summary>
    public static SectionInput Section(FamilySymbol sym)
    {
        StructuralSection? s = null;
        try { s = sym.GetStructuralSection(); } catch { }
        double? F(double? v) => v is > 0 ? M(v.Value) : null;
        return new SectionInput
        {
            ShapeName = s?.StructuralSectionShape.ToString(),
            FamilyName = sym.FamilyName ?? "",
            TypeName = sym.Name ?? "",
            NameKey = s?.SectionNameKey,
            Width = F((s as StructuralSectionRectangular)?.Width),
            Height = F((s as StructuralSectionRectangular)?.Height),
            Diameter = F((s as StructuralSectionRound)?.Diameter),
            FlangeThickness = F((s as StructuralSectionHotRolled)?.FlangeThickness),
            WebThickness = F((s as StructuralSectionHotRolled)?.WebThickness),
            WebFillet = F((s as StructuralSectionHotRolled)?.WebFillet),
            WallThickness = F((s as StructuralSectionGeneralH)?.WallNominalThickness
                ?? (s as StructuralSectionGeneralR)?.WallNominalThickness
                ?? (s as StructuralSectionColdFormed)?.WallNominalThickness),
            OuterFillet = F((s as StructuralSectionGeneralH)?.OuterFillet),
            Params = LengthParams(sym),
        };
    }

    /// <summary>Structural material of an instance (instance / type "Structural Material").</summary>
    public static string? StructuralMaterialName(Element e)
    {
        var doc = e.Document;
        if (e is FamilyInstance fi && MaterialName(doc, fi.StructuralMaterialId) is { } n) return n;
        var id = e.get_Parameter(BuiltInParameter.STRUCTURAL_MATERIAL_PARAM)?.AsElementId()
              ?? doc.GetElement(e.GetTypeId())?.get_Parameter(BuiltInParameter.STRUCTURAL_MATERIAL_PARAM)?.AsElementId();
        return MaterialName(doc, id);
    }

    public static string? TypeUid(Element e)
    {
        var id = e.GetTypeId();
        return id is null || id == ElementId.InvalidElementId ? null : e.Document.GetElement(id)?.UniqueId;
    }

    public static string? LevelUid(Document doc, ElementId? id) =>
        id is null || id == ElementId.InvalidElementId ? null : (doc.GetElement(id) as Level)?.UniqueId;

    /// <summary>Unit conversion from Revit internal units for non-length specs (flow, voltage, …).</summary>
    public static double? FromInternal(Parameter? p, ForgeTypeId unit)
    {
        try
        {
            if (p is null || !p.HasValue || p.StorageType != StorageType.Double) return null;
            var v = UnitUtils.ConvertFromInternalUnits(p.AsDouble(), unit);
            return v > 0 ? v : null;
        }
        catch { return null; }
    }

    /// <summary>Wall location line as a BimDown <see cref="WallLine"/> (reversed so the exterior is on the left).</summary>
    public static WallLine? WallLineOf(Wall w)
    {
        if (w.Location is not LocationCurve { Curve: Line line }) return null;
        var a = line.GetEndPoint(0);
        var b = line.GetEndPoint(1);
        if (IsReversed(w)) (a, b) = (b, a);
        var core = w.WallType.Kind == WallKind.Basic ? CoreOffsets(w.WallType.GetCompoundStructure()) : null;
        return new WallLine(w.UniqueId, M(a.X), M(a.Y), M(b.X), M(b.Y), M(w.Width), core?.Hi, core?.Lo);
    }

    /// <summary>True when the wall is exported start ↔ end swapped (exterior right of its Revit direction).</summary>
    public static bool IsReversed(Wall w)
    {
        try
        {
            if (w.WallType.Kind == WallKind.Curtain) return false;
            if (w.Location is not LocationCurve lc) return false;
            var c = lc.Curve;
            // Tangent at the middle (Wall.Orientation of an arc wall is taken there too)
            var d = c is Line ? c.GetEndPoint(1) - c.GetEndPoint(0) : c.ComputeDerivatives(0.5, true).BasisX;
            if (d.GetLength() < 1e-9) return false;
            d = d.Normalize();
            var o = w.Orientation;
            return WallMapper.ShouldReverse(d.X, d.Y, o.X, o.Y);
        }
        catch { return false; }
    }
}
