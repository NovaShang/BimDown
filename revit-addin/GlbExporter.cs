using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Visual;
using SharpGLTF.Geometry;
using SharpGLTF.Geometry.VertexTypes;
using SharpGLTF.Materials;
using SharpGLTF.Scenes;

namespace BimDown.RevitAddin;

using VERTEX = VertexPosition;
using Vec3 = System.Numerics.Vector3;
using Vec4 = System.Numerics.Vector4;

static class GlbExporter
{
    /// <summary>
    /// Exports an element's geometry to a GLB file with per-face PBR materials.
    /// When origin is provided, vertices are transformed to local coordinates
    /// so the GLB can be placed via CSV x/y/z/rotation.
    /// When origin is null, geometry stays in world coordinates (for fallback mesh).
    /// Returns the relative path (e.g., "mesh/mesh-1.glb") or null if no geometry found.
    /// </summary>
    internal static string? ExportElement(Element element, string outputDir, string shortId,
        XYZ? origin = null, double rotationRad = 0)
    {
        var isFamilyInstance = element is Autodesk.Revit.DB.FamilyInstance;

        // For FamilyInstance, prefer InstanceGeometry (placed solids in world coords)
        // and transform back to local — SymbolGeometry is schematic/symbolic for many
        // MEP families (HRU, diffusers, fittings, …) and returns only linework or
        // tiny stub solids that look "non-empty" but are useless. We only fall back
        // to SymbolGeometry when no origin is supplied (then we can't transform).
        var useSymbolGeometry = isFamilyInstance && origin is null;
        var triangles = ExtractTriangles(element, useSymbolGeometry);
        if (triangles.Count == 0) return null;

        // Symbol path is already local. Instance path (FamilyInstance with origin) and
        // non-FamilyInstance with origin both need world→local transform.
        if (origin is not null && !useSymbolGeometry)
            TransformToLocal(triangles, origin, rotationRad);

        var doc = element.Document;
        var materialCache = new Dictionary<ElementId, MaterialBuilder>();
        var mesh = new MeshBuilder<VERTEX>("mesh");

        foreach (var group in triangles.GroupBy(t => t.MaterialId))
        {
            var matBuilder = GetOrCreateMaterial(doc, group.Key, materialCache);
            var primitive = mesh.UsePrimitive(matBuilder);
            foreach (var (a, b, c, _) in group)
                primitive.AddTriangle(new VERTEX(a), new VERTEX(b), new VERTEX(c));
        }

        var scene = new SceneBuilder();
        scene.AddRigidMesh(mesh, System.Numerics.Matrix4x4.Identity);
        var model = scene.ToGltf2();

        var meshDir = Path.Combine(outputDir, "mesh");
        Directory.CreateDirectory(meshDir);
        var fileName = $"{shortId}.glb";
        var fullPath = Path.Combine(meshDir, fileName);
        model.SaveGLB(fullPath);

        return $"mesh/{fileName}";
    }

    static MaterialBuilder GetOrCreateMaterial(Document doc, ElementId materialId,
        Dictionary<ElementId, MaterialBuilder> cache)
    {
        if (cache.TryGetValue(materialId, out var cached)) return cached;

        var mat = BuildPbrMaterial(doc, materialId);
        cache[materialId] = mat;
        return mat;
    }

    static MaterialBuilder BuildPbrMaterial(Document doc, ElementId materialId)
    {
        var revitMat = materialId != ElementId.InvalidElementId
            ? doc.GetElement(materialId) as Material
            : null;

        if (revitMat is null) return DefaultMaterial();

        // Try appearance asset for PBR properties
        if (revitMat.AppearanceAssetId != ElementId.InvalidElementId
            && doc.GetElement(revitMat.AppearanceAssetId) is AppearanceAssetElement assetElem)
        {
            var asset = assetElem.GetRenderingAsset();
            if (asset is not null)
            {
                var result = ExtractFromAsset(asset, revitMat.Name);
                if (result is not null) return result;
            }
        }

        // Fallback to Material.Color / Transparency
        return BuildFromBasicProperties(revitMat);
    }

    static MaterialBuilder? ExtractFromAsset(Asset asset, string name)
    {
        var color = GetAssetColor(asset, "generic_diffuse");
        if (color is null) return null;

        var transparency = GetAssetFloat(asset, "generic_transparency") ?? 0f;
        var glossiness = GetAssetFloat(asset, "generic_glossiness") ?? 0.5f;
        var reflectivity = GetAssetFloat(asset, "generic_reflectivity_at_0deg") ?? 0.04f;

        var alpha = 1f - transparency;
        var metallic = reflectivity > 0.5f ? reflectivity : 0f;
        var roughness = 1f - glossiness;

        var mat = new MaterialBuilder(name)
            .WithDoubleSide(true)
            .WithMetallicRoughnessShader()
            .WithBaseColor(new Vec4(color.Value.X, color.Value.Y, color.Value.Z, alpha))
            .WithMetallicRoughness(metallic, roughness);

        if (alpha < 1f)
            mat.WithAlpha(AlphaMode.BLEND);

        return mat;
    }

    static Vec3? GetAssetColor(Asset asset, string propertyName)
    {
        for (var i = 0; i < asset.Size; i++)
        {
            var prop = asset[i];
            if (prop.Name != propertyName) continue;

            if (prop is AssetPropertyDoubleArray4d color4d)
            {
                var c = color4d.GetValueAsColor();
                return new Vec3(c.Red / 255f, c.Green / 255f, c.Blue / 255f);
            }
        }
        return null;
    }

    static float? GetAssetFloat(Asset asset, string propertyName)
    {
        for (var i = 0; i < asset.Size; i++)
        {
            var prop = asset[i];
            if (prop.Name != propertyName) continue;

            if (prop is AssetPropertyDouble d)
                return (float)d.Value;
            if (prop is AssetPropertyFloat f)
                return f.Value;
            if (prop is AssetPropertyInteger intProp)
                return intProp.Value / 100f; // transparency/glossiness often stored as 0-100 int
        }
        return null;
    }

    static MaterialBuilder BuildFromBasicProperties(Material revitMat)
    {
        var c = revitMat.Color;
        var r = c.IsValid ? c.Red / 255f : 0.7f;
        var g = c.IsValid ? c.Green / 255f : 0.7f;
        var b = c.IsValid ? c.Blue / 255f : 0.7f;
        var alpha = 1f - revitMat.Transparency / 100f;

        var mat = new MaterialBuilder(revitMat.Name)
            .WithDoubleSide(true)
            .WithMetallicRoughnessShader()
            .WithBaseColor(new Vec4(r, g, b, alpha))
            .WithMetallicRoughness(0f, 0.8f);

        if (alpha < 1f)
            mat.WithAlpha(AlphaMode.BLEND);

        return mat;
    }

    static MaterialBuilder DefaultMaterial() =>
        new MaterialBuilder("default")
            .WithDoubleSide(true)
            .WithMetallicRoughnessShader()
            .WithBaseColor(new Vec4(0.7f, 0.7f, 0.7f, 1f))
            .WithMetallicRoughness(0f, 0.8f);

    static void TransformToLocal(
        List<(Vec3 A, Vec3 B, Vec3 C, ElementId MaterialId)> triangles,
        XYZ origin, double rotationRad)
    {
        var glbOrigin = ToVec3(origin);
        var cos = (float)Math.Cos(-rotationRad);
        var sin = (float)Math.Sin(-rotationRad);

        for (var i = 0; i < triangles.Count; i++)
        {
            var (a, b, c, matId) = triangles[i];
            triangles[i] = (
                RotateY(a - glbOrigin, cos, sin),
                RotateY(b - glbOrigin, cos, sin),
                RotateY(c - glbOrigin, cos, sin),
                matId);
        }
    }

    static Vec3 RotateY(Vec3 v, float cos, float sin) =>
        new(v.X * cos + v.Z * sin, v.Y, -v.X * sin + v.Z * cos);

    static List<(Vec3 A, Vec3 B, Vec3 C, ElementId MaterialId)>
        ExtractTriangles(Element element, bool useSymbolGeometry)
    {
        var result = new List<(Vec3, Vec3, Vec3, ElementId)>();

        var options = new Options
        {
            DetailLevel = ViewDetailLevel.Fine,
            ComputeReferences = false,
            // Many MEP family categories (equipment, terminals, fittings) keep their
            // 3D body on a subcategory that is hidden by default; without this flag
            // get_Geometry returns only schematic linework and we lose the solids.
            IncludeNonVisibleObjects = true,
        };

        var geomElement = element.get_Geometry(options);
        if (geomElement is null) return result;

        CollectTriangles(geomElement, result, useSymbolGeometry);
        return result;
    }

    static void CollectTriangles(GeometryElement geomElement,
        List<(Vec3, Vec3, Vec3, ElementId)> result, bool useSymbolGeometry)
    {
        foreach (var geomObj in geomElement)
        {
            switch (geomObj)
            {
                case Solid solid when solid.Faces.Size > 0:
                    foreach (Face face in solid.Faces)
                    {
                        var mesh = face.Triangulate();
                        if (mesh is null) continue;
                        var matId = face.MaterialElementId;
                        for (var i = 0; i < mesh.NumTriangles; i++)
                        {
                            var tri = mesh.get_Triangle(i);
                            result.Add((
                                ToVec3(tri.get_Vertex(0)),
                                ToVec3(tri.get_Vertex(1)),
                                ToVec3(tri.get_Vertex(2)),
                                matId));
                        }
                    }
                    break;
                case GeometryInstance instance:
                    // Symbol geometry = family local coords (shared across instances).
                    // Instance geometry = world coords (unique per placement).
                    var geom = useSymbolGeometry
                        ? instance.GetSymbolGeometry()
                        : instance.GetInstanceGeometry();
                    CollectTriangles(geom, result, useSymbolGeometry);
                    break;
            }
        }
    }

    static Vec3 ToVec3(XYZ pt)
    {
        // Convert from Revit feet to meters
        var m = UnitConverter.Length(1.0); // feet-to-meters factor
        return new Vec3(
            (float)(pt.X * m),
            (float)(pt.Z * m),  // Revit Z → GLB Y (up)
            (float)(-pt.Y * m)); // Revit Y → GLB -Z (forward)
    }
}
