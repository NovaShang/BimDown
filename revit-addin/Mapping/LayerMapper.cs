namespace BimDown.RevitAddin.Mapping;

/// <summary>One layer of a Revit CompoundStructure, already in meters.</summary>
/// <param name="Function">MaterialFunctionAssignment name (Structure, Substrate, Insulation, Finish1, Finish2, Membrane, StructuralDeck, None).</param>
/// <param name="MaterialName">Revit material name, if any.</param>
/// <param name="Width">Layer width in meters.</param>
/// <param name="Conductivity">Thermal conductivity λ of the material, W/(m·K), if known.</param>
/// <param name="IsCore">True for layers between the core boundaries.</param>
public record LayerInput(string Function, string? MaterialName, double Width, double? Conductivity = null, bool IsCore = false);

/// <summary>
/// Revit compound structure → BimDown layered type (wall_type / slab_type /
/// roof_type / ceiling_type) + type_layer rows. Revit layer 0 is the exterior
/// face of a wall and the top face of a floor / roof / ceiling, which is the
/// same order as type_layer.seq (1 = exterior / top).
/// </summary>
public static class LayerMapper
{
    /// <summary>Revit layer function → type_layer.function.</summary>
    public static string Function(string revitFunction, string? materialName)
    {
        // Revit has no air-gap function: cavities are Thermal/Air layers (Finish or
        // Insulation) with an "Air" material.
        if (Names.ContainsAny(materialName, "air space", "air gap", "air layer", "cavity", "空气层", "空腔"))
            return "air_gap";
        return revitFunction switch
        {
            "Structure" or "StructuralDeck" => "core",
            "Substrate" => "substrate",
            "Insulation" => "insulation",
            "Membrane" => "membrane",
            "Finish1" or "Finish2" => "finish",
            _ => "finish",
        };
    }

    /// <summary>
    /// type_layer.function → Revit MaterialFunctionAssignment name (import).
    /// Revit membranes must be zero-thick, so a BimDown membrane with a thickness
    /// becomes a substrate; finishes outside the core are Finish1, inside Finish2;
    /// air gaps are Revit's Thermal/Air layer (Insulation).
    /// </summary>
    public static string RevitFunction(string? function, bool beforeCore) => function switch
    {
        "core" => "Structure",
        "substrate" or "membrane" => "Substrate",
        "insulation" or "air_gap" => "Insulation",
        _ => beforeCore ? "Finish1" : "Finish2",
    };

    /// <summary>
    /// type_layer rows for one type (still keyed by the type's Revit UniqueId in
    /// <c>type_id</c>; ids <c>{typeUid}:layer:{seq}</c> are remapped to tl-N).
    /// Zero-thickness layers (Revit membranes) are dropped: type_layer.thickness
    /// must be &gt; 0 and they add nothing to the build-up.
    /// </summary>
    public static List<Dictionary<string, string?>> LayerRows(string typeUid, IReadOnlyList<LayerInput> layers)
    {
        var rows = new List<Dictionary<string, string?>>();
        var seq = 0;
        foreach (var l in layers)
        {
            if (l.Width < 0.0005) continue;
            seq++;
            rows.Add(new Dictionary<string, string?>
            {
                ["id"] = $"{typeUid}:layer:{seq}",
                ["type_id"] = typeUid,
                ["seq"] = seq.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["function"] = Function(l.Function, l.MaterialName),
                ["material"] = MaterialMapper.MapToEnum(l.MaterialName),
                ["thickness"] = Names.Num(l.Width, 4),
                ["conductivity"] = l.Conductivity is > 0 ? Names.Num(l.Conductivity.Value, 4) : null,
                ["name"] = string.IsNullOrWhiteSpace(l.MaterialName) ? null : l.MaterialName,
            });
        }
        return rows;
    }

    /// <summary>Sum of the exported layer thicknesses, rounded like the layer rows.</summary>
    public static double TotalThickness(IReadOnlyList<LayerInput> layers) =>
        layers.Where(l => l.Width >= 0.0005).Sum(l => Math.Round(l.Width, 4));

    /// <summary>
    /// Primary material of a layered type: the thickest core layer, else the thickest layer.
    /// </summary>
    public static string PrimaryMaterial(IReadOnlyList<LayerInput> layers)
    {
        var core = layers.Where(l => l.IsCore || l.Function is "Structure" or "StructuralDeck").ToList();
        var pick = (core.Count > 0 ? core : layers.ToList()).OrderByDescending(l => l.Width).FirstOrDefault();
        return MaterialMapper.MapToEnum(pick?.MaterialName);
    }

    /// <summary>
    /// Type row fields of a layered type: name, material and thickness (the sum of
    /// its layers, so validate's layer-total check holds). Without layers the
    /// type's own width is used.
    /// </summary>
    public static Dictionary<string, string?> TypeRow(string typeUid, string name, IReadOnlyList<LayerInput> layers, double? ownWidth = null)
    {
        var hasLayers = layers.Any(l => l.Width >= 0.0005);
        var thickness = hasLayers ? TotalThickness(layers) : ownWidth;
        return new Dictionary<string, string?>
        {
            ["id"] = typeUid,
            ["name"] = name,
            ["material"] = hasLayers ? PrimaryMaterial(layers) : "composite",
            ["thickness"] = thickness is > 0 ? Names.Num(thickness.Value, 4) : null,
        };
    }
}
