using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;

namespace BimDown.RevitAddin.Import;

class WallImporter() : TableImporterBase(
    "wall",
    10,
    [BuiltInCategory.OST_Walls],
    e => e is Wall w && w.WallType.Kind == WallKind.Basic &&
         w.StructuralUsage == StructuralWallUsage.NonBearing)
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var curve = ParseCurve2D(row);
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");

        var thicknessStr = row.GetValueOrDefault("thickness");
        WallType? wallType = null;
        if (thicknessStr is not null)
        {
            var thickness = UnitConverter.ParseDouble(thicknessStr);
            wallType = TypeResolver.WallTypeFor(doc, row, thickness);
        }

        var heightStr = row.GetValueOrDefault("height");
        var heightFeet = heightStr is not null
            ? UnitConverter.LengthToFeet(UnitConverter.ParseDouble(heightStr))
            : 10.0; // default 10 feet

        var typeId = wallType?.Id ?? GetDefaultWallTypeId(doc);
        var wall = Wall.Create(doc, curve, typeId, levelId, heightFeet, 0, false, false);

        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        var topLevelId = IdMap.Resolve(doc, row.GetValueOrDefault("top_level_id"));
        if (topLevelId is not null)
            wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.Set(topLevelId);

        var topOffsetStr = row.GetValueOrDefault("top_offset");
        if (topOffsetStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(topOffsetStr)));

        SetMark(wall, row);
        QueueTopAttachment(wall, row);
        return wall;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is not Wall wall) return;
        QueueTopAttachment(wall, row);

        // Update location curve
        if (wall.Location is LocationCurve lc)
        {
            lc.Curve = ParseCurve2D(row);
        }

        // Update height
        var heightStr = row.GetValueOrDefault("height");
        if (heightStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(heightStr)));

        // Update base offset
        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        // Update top level
        var topLevelId = IdMap.Resolve(doc, row.GetValueOrDefault("top_level_id"));
        if (topLevelId is not null)
            wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.Set(topLevelId);

        // Update top offset
        var topOffsetStr = row.GetValueOrDefault("top_offset");
        if (topOffsetStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(topOffsetStr)));

        // Update type if thickness changed
        var thicknessStr = row.GetValueOrDefault("thickness");
        if (thicknessStr is not null)
        {
            var thickness = UnitConverter.ParseDouble(thicknessStr);
            var newType = TypeResolver.WallTypeFor(doc, row, thickness);
            if (wall.WallType.Id != newType.Id)
                wall.WallType = newType;
        }

        SetMark(wall, row);
    }

    static ElementId GetDefaultWallTypeId(Document doc)
    {
        return new FilteredElementCollector(doc)
            .OfClass(typeof(WallType))
            .Cast<WallType>()
            .First(wt => wt.Kind == WallKind.Basic).Id;
    }
}

class ColumnImporter() : TableImporterBase("column", 10, [BuiltInCategory.OST_Columns])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["x"]!));
        var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["y"]!));
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        var shape = row.GetValueOrDefault("shape");
        var sizeXStr = row.GetValueOrDefault("size_x");
        var sizeYStr = row.GetValueOrDefault("size_y");

        FamilySymbol symbol;
        if (TypeResolver.ResolveNamedSymbol(doc, row.GetValueOrDefault("type_id"), BuiltInCategory.OST_Columns) is { } named)
        {
            symbol = named;
        }
        else if (sizeXStr is not null && sizeYStr is not null)
        {
            symbol = TypeResolver.ResolveOrCreateColumnType(doc, shape,
                UnitConverter.ParseDouble(sizeXStr), UnitConverter.ParseDouble(sizeYStr));
        }
        else
        {
            symbol = GetDefaultColumnSymbol(doc);
        }

        var pt = new XYZ(x, y, level.Elevation);
        var column = doc.Create.NewFamilyInstance(pt, symbol, level, StructuralType.NonStructural);

        // Set rotation
        var rotationStr = row.GetValueOrDefault("rotation");
        if (rotationStr is not null)
        {
            var angle = UnitConverter.AngleToRadians(UnitConverter.ParseDouble(rotationStr));
            if (Math.Abs(angle) > 1e-10)
            {
                var axis = Line.CreateBound(pt, pt + XYZ.BasisZ);
                ElementTransformUtils.RotateElement(doc, column.Id, axis, angle);
            }
        }

        // Set vertical span
        var topLevelId = IdMap.Resolve(doc, row.GetValueOrDefault("top_level_id"));
        if (topLevelId is not null)
            column.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_PARAM)?.Set(topLevelId);

        var topOffsetStr = row.GetValueOrDefault("top_offset");
        if (topOffsetStr is not null)
            column.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(topOffsetStr)));

        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            column.get_Parameter(BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        SetMark(column, row);
        return column;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is not FamilyInstance fi) return;

        // Update location using MoveElement (lp.Point setter can misfire on level-hosted columns)
        if (fi.Location is LocationPoint lp)
        {
            var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["x"]!));
            var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["y"]!));
            var target = new XYZ(x, y, lp.Point.Z);
            var delta = target - lp.Point;
            if (delta.GetLength() > 1e-10)
                ElementTransformUtils.MoveElement(doc, fi.Id, delta);
        }

        // Update rotation
        var rotationStr = row.GetValueOrDefault("rotation");
        if (rotationStr is not null && fi.Location is LocationPoint locPt)
        {
            var targetAngle = UnitConverter.AngleToRadians(UnitConverter.ParseDouble(rotationStr));
            var currentAngle = locPt.Rotation;
            var angleDelta = targetAngle - currentAngle;
            if (Math.Abs(angleDelta) > 1e-10)
            {
                var axis = Line.CreateBound(locPt.Point, locPt.Point + XYZ.BasisZ);
                ElementTransformUtils.RotateElement(doc, fi.Id, axis, angleDelta);
            }
        }

        // Update vertical span
        var topLevelId = IdMap.Resolve(doc, row.GetValueOrDefault("top_level_id"));
        if (topLevelId is not null)
            fi.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_PARAM)?.Set(topLevelId);

        var topOffsetStr = row.GetValueOrDefault("top_offset");
        if (topOffsetStr is not null)
            fi.get_Parameter(BuiltInParameter.FAMILY_TOP_LEVEL_OFFSET_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(topOffsetStr)));

        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            fi.get_Parameter(BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        SetMark(fi, row);
    }

    static FamilySymbol GetDefaultColumnSymbol(Document doc)
    {
        var symbol = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_Columns)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .First();
        if (!symbol.IsActive) symbol.Activate();
        return symbol;
    }
}

class SlabImporter() : TableImporterBase(
    "slab",
    15,
    [BuiltInCategory.OST_Floors],
    e =>
    {
        if (e is Floor floor)
        {
            var structural = floor.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.AsInteger();
            return structural != 1;
        }
        return false;
    })
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var pointsJson = row.GetValueOrDefault("points")
            ?? throw new InvalidOperationException("points is required for slab");
        var points = GeometryUtils.DeserializePolygon(pointsJson);
        if (points.Count < 3) throw new InvalidOperationException("Need at least 3 points for slab");

        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        // Resolve floor type
        var thicknessStr = row.GetValueOrDefault("thickness");
        FloorType floorType;
        if (thicknessStr is not null)
        {
            var thickness = UnitConverter.ParseDouble(thicknessStr);
            floorType = TypeResolver.FloorTypeFor(doc, row, thickness);
        }
        else
        {
            floorType = new FilteredElementCollector(doc)
                .OfClass(typeof(FloorType))
                .Cast<FloorType>()
                .First();
        }

        // Build curve loop
        var curveLoop = new CurveLoop();
        for (var i = 0; i < points.Count; i++)
        {
            var p1 = new XYZ(points[i].X, points[i].Y, level.Elevation);
            var p2 = new XYZ(points[(i + 1) % points.Count].X, points[(i + 1) % points.Count].Y, level.Elevation);
            curveLoop.Append(Line.CreateBound(p1, p2));
        }

        var floor = Floor.Create(doc, [curveLoop], floorType.Id, levelId);

        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        SetMark(floor, row);
        return floor;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is not Floor floor) return;

        // Slab geometry can't be edited in-place — delete and recreate if points changed
        var pointsJson = row.GetValueOrDefault("points");
        if (pointsJson is not null)
        {
            doc.Delete(floor.Id);
            var newFloor = CreateElement(doc, row);
            if (newFloor is not null)
            {
                var csvId = row.GetValueOrDefault("id");
                if (csvId is not null)
                {
                    BimDownParameter.Set(newFloor, csvId);
                    IdMap.Register(csvId, newFloor.Id);
                }
            }
            return;
        }

        // If no geometry change, update type and offset only
        var thicknessStr = row.GetValueOrDefault("thickness");
        if (thicknessStr is not null)
        {
            var thickness = UnitConverter.ParseDouble(thicknessStr);
            var newType = TypeResolver.FloorTypeFor(doc, row, thickness);
            if (floor.FloorType.Id != newType.Id)
                floor.FloorType = newType;
        }

        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        SetMark(floor, row);
    }
}

class SpaceImporter() : TableImporterBase("space", 15, [BuiltInCategory.OST_Rooms])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        // Parse seed point from x, y fields (V2) or polygon centroid (V1 fallback)
        UV uv;
        var xStr = row.GetValueOrDefault("x");
        var yStr = row.GetValueOrDefault("y");
        if (xStr is not null && yStr is not null)
        {
            var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(xStr));
            var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(yStr));
            uv = new UV(x, y);
        }
        else
        {
            var pointsJson = row.GetValueOrDefault("points");
            if (pointsJson is not null)
            {
                var points = GeometryUtils.DeserializePolygon(pointsJson);
                var cx = points.Average(p => p.X);
                var cy = points.Average(p => p.Y);
                uv = new UV(cx, cy);
            }
            else
            {
                uv = new UV(0, 0);
            }
        }

        var room = doc.Create.NewRoom(level, uv);

        var name = row.GetValueOrDefault("name");
        if (name is not null) room.Name = name;

        SetMark(room, row);
        return room;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is not Room room) return;

        var name = row.GetValueOrDefault("name");
        if (name is not null && room.Name != name) room.Name = name;

        SetMark(room, row);
    }
}

class DoorImporter() : TableImporterBase("door", 20, [BuiltInCategory.OST_Doors])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        return HostedOpeningHelper.CreateHostedOpening(doc, row, IdMap, BuiltInCategory.OST_Doors, isWindow: false);
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        HostedOpeningHelper.UpdateHostedOpening(doc, row, element, IdMap, isWindow: false);
    }
}

class WindowImporter() : TableImporterBase("window", 20, [BuiltInCategory.OST_Windows])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        return HostedOpeningHelper.CreateHostedOpening(doc, row, IdMap, BuiltInCategory.OST_Windows, isWindow: true);
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        HostedOpeningHelper.UpdateHostedOpening(doc, row, element, IdMap, isWindow: true);
    }
}

class CurtainWallImporter() : TableImporterBase(
    "curtain_wall",
    10,
    [BuiltInCategory.OST_Walls],
    e => e is Wall w && w.WallType.Kind == WallKind.Curtain)
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var curve = ParseCurve2D(row);
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");

        var typeName = ImportContext.Type(row.GetValueOrDefault("type_id"))?.GetValueOrDefault("name");
        var wallType = new FilteredElementCollector(doc).OfClass(typeof(WallType)).Cast<WallType>()
                           .FirstOrDefault(wt => wt.Kind == WallKind.Curtain && wt.Name == typeName)
                       ?? TypeResolver.FindCurtainWallType(doc);
        var heightStr = row.GetValueOrDefault("height");
        var heightFeet = heightStr is not null
            ? UnitConverter.LengthToFeet(UnitConverter.ParseDouble(heightStr))
            : 10.0;

        var wall = Wall.Create(doc, curve, wallType.Id, levelId, heightFeet, 0, false, false);

        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        var topLevelId = IdMap.Resolve(doc, row.GetValueOrDefault("top_level_id"));
        if (topLevelId is not null)
            wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.Set(topLevelId);

        var topOffsetStr = row.GetValueOrDefault("top_offset");
        if (topOffsetStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(topOffsetStr)));

        AddGridLines(doc, wall, row);
        SetMark(wall, row);
        return wall;
    }

    /// <summary>
    /// Explicit grid lines (v_grids: distances from the start; u_grids: heights
    /// above the base) added to the wall's curtain grid. Panel kinds stay the type's.
    /// </summary>
    static void AddGridLines(Document doc, Wall wall, Dictionary<string, string?> row)
    {
        if (wall.CurtainGrid is not { } grid || wall.Location is not LocationCurve { Curve: var c }) return;
        doc.Regenerate();
        var start = c.GetEndPoint(0);
        var dir = (c.GetEndPoint(1) - start).Normalize();
        var baseZ = ((doc.GetElement(wall.LevelId) as Level)?.Elevation ?? 0)
                    + (wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0);
        foreach (var v in (row.GetValueOrDefault("v_grids") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            try { grid.AddGridLine(false, start + dir * UnitConverter.LengthToFeet(UnitConverter.ParseDouble(v)) + XYZ.BasisZ * (baseZ - start.Z + 0.5), false); }
            catch { }
        }
        var mid = c.Evaluate(0.5, true);
        foreach (var u in (row.GetValueOrDefault("u_grids") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            try { grid.AddGridLine(true, new XYZ(mid.X, mid.Y, baseZ + UnitConverter.LengthToFeet(UnitConverter.ParseDouble(u))), false); }
            catch { }
        }
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is not Wall wall) return;

        if (wall.Location is LocationCurve lc)
            lc.Curve = ParseCurve2D(row);

        var heightStr = row.GetValueOrDefault("height");
        if (heightStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(heightStr)));

        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        var topLevelId = IdMap.Resolve(doc, row.GetValueOrDefault("top_level_id"));
        if (topLevelId is not null)
            wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.Set(topLevelId);

        var topOffsetStr = row.GetValueOrDefault("top_offset");
        if (topOffsetStr is not null)
            wall.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(topOffsetStr)));

        SetMark(wall, row);
    }
}

/// <summary>
/// Footprint roofs from the polygon: roof_type (typed by name with its layers),
/// base offset, and one slope per edge (edge_slopes, else implied by roof_type +
/// slope: hip = every edge, gable = edges 0 and 2 of a 4-gon, shed = edge 0).
/// Extrusion roofs are not created (they need a reference plane and profile).
/// </summary>
class RoofImporter() : TableImporterBase("roof", 15, [BuiltInCategory.OST_Roofs])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        if (row.GetValueOrDefault("roof_type") == "extrusion")
            throw new InvalidOperationException("extrusion roofs are not created on import (draw them in Revit)");
        var pointsJson = row.GetValueOrDefault("points")
            ?? throw new InvalidOperationException("points is required for roof");
        var points = GeometryUtils.DeserializePolygon(pointsJson);
        if (points.Count < 3) throw new InvalidOperationException("Need at least 3 points for roof");

        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        var roofType = TypeResolver.ResolveLayeredType<RoofType>(doc, row.GetValueOrDefault("type_id"))
            ?? new FilteredElementCollector(doc).OfClass(typeof(RoofType)).Cast<RoofType>().First();

        var curveArray = new CurveArray();
        for (var i = 0; i < points.Count; i++)
        {
            var p1 = new XYZ(points[i].X, points[i].Y, level.Elevation);
            var p2 = new XYZ(points[(i + 1) % points.Count].X, points[(i + 1) % points.Count].Y, level.Elevation);
            curveArray.Append(Line.CreateBound(p1, p2));
        }

        var roof = doc.Create.NewFootPrintRoof(curveArray, level, roofType, out var modelCurves);
        SetSlopes(roof, modelCurves, row, points.Count);

        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            roof.get_Parameter(BuiltInParameter.ROOF_LEVEL_OFFSET_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));

        SetMark(roof, row);
        return roof;
    }

    /// <summary>Per-edge "Defines Slope" from edge_slopes (or the implied edges). Slopes are rise / run in Revit.</summary>
    static void SetSlopes(FootPrintRoof roof, ModelCurveArray curves, Dictionary<string, string?> row, int edgeCount)
    {
        var slopes = new double[edgeCount];
        var explicitSlopes = row.GetValueOrDefault("edge_slopes")?.Split(';');
        if (explicitSlopes is not null && explicitSlopes.Length == edgeCount)
        {
            for (var i = 0; i < edgeCount; i++) slopes[i] = UnitConverter.ParseNullableDouble(explicitSlopes[i]) ?? 0;
        }
        else
        {
            var slope = UnitConverter.ParseNullableDouble(row.GetValueOrDefault("slope")) ?? 0;
            switch (row.GetValueOrDefault("roof_type"))
            {
                case "hip" or "mansard": Array.Fill(slopes, slope); break;
                case "gable": for (var i = 0; i < edgeCount; i += 2) slopes[i] = slope; break;
                case "shed": slopes[0] = slope; break;
            }
        }
        var k = 0;
        foreach (ModelCurve mc in curves)
        {
            if (k >= edgeCount) break;
            var deg = slopes[k++];
            roof.set_DefinesSlope(mc, deg > 1e-6);
            if (deg > 1e-6) roof.set_SlopeAngle(mc, Math.Tan(deg * Math.PI / 180));
        }
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        var baseOffsetStr = row.GetValueOrDefault("base_offset");
        if (baseOffsetStr is not null)
            element.get_Parameter(BuiltInParameter.ROOF_LEVEL_OFFSET_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(baseOffsetStr)));
        if (element is RoofBase rb && TypeResolver.ResolveLayeredType<RoofType>(doc, row.GetValueOrDefault("type_id")) is { } rt && rb.RoofType.Id != rt.Id)
            rb.RoofType = rt;
        SetMark(element, row);
    }
}

class CeilingImporter() : TableImporterBase("ceiling", 15, [BuiltInCategory.OST_Ceilings])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var pointsJson = row.GetValueOrDefault("points")
            ?? throw new InvalidOperationException("points is required for ceiling");
        var points = GeometryUtils.DeserializePolygon(pointsJson);
        if (points.Count < 3) throw new InvalidOperationException("Need at least 3 points for ceiling");

        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        var ceilingType = TypeResolver.ResolveLayeredType<CeilingType>(doc, row.GetValueOrDefault("type_id"))
            ?? new FilteredElementCollector(doc)
                .OfClass(typeof(CeilingType))
                .Cast<CeilingType>()
                .First();

        var curveLoop = new CurveLoop();
        for (var i = 0; i < points.Count; i++)
        {
            var p1 = new XYZ(points[i].X, points[i].Y, level.Elevation);
            var p2 = new XYZ(points[(i + 1) % points.Count].X, points[(i + 1) % points.Count].Y, level.Elevation);
            curveLoop.Append(Line.CreateBound(p1, p2));
        }

        var ceiling = Ceiling.Create(doc, [curveLoop], ceilingType.Id, levelId);

        var heightOffsetStr = row.GetValueOrDefault("height_offset");
        if (heightOffsetStr is not null)
            ceiling.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(heightOffsetStr)));

        SetMark(ceiling, row);
        return ceiling;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        var heightOffsetStr = row.GetValueOrDefault("height_offset");
        if (heightOffsetStr is not null)
            element.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(heightOffsetStr)));

        SetMark(element, row);
    }
}

class OpeningImporter() : TableImporterBase(
    "opening", 20,
    [BuiltInCategory.OST_SWallRectOpening, BuiltInCategory.OST_FloorOpening, BuiltInCategory.OST_ShaftOpening])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        // Shaft: a polygon cut from its level (+ base_offset) to top_level_id (+ top_offset).
        if (row.GetValueOrDefault("top_level_id") is { } topRef && row.GetValueOrDefault("points") is { } shaftJson)
        {
            var bottom = IdMap.ResolveLevel(doc, row.GetValueOrDefault("level_id"))
                ?? throw new InvalidOperationException("level_id is required");
            var top = IdMap.ResolveLevel(doc, topRef)
                ?? throw new InvalidOperationException("top_level_id does not resolve to a level");
            var pts = GeometryUtils.DeserializePolygon(shaftJson);
            var loop = new CurveArray();
            for (var i = 0; i < pts.Count; i++)
                loop.Append(Line.CreateBound(new XYZ(pts[i].X, pts[i].Y, bottom.Elevation),
                    new XYZ(pts[(i + 1) % pts.Count].X, pts[(i + 1) % pts.Count].Y, bottom.Elevation)));
            var shaft = doc.Create.NewOpening(bottom, top, loop);
            if (UnitConverter.ParseNullableDouble(row.GetValueOrDefault("base_offset")) is { } bo)
                shaft.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.Set(UnitConverter.LengthToFeet(bo));
            if (UnitConverter.ParseNullableDouble(row.GetValueOrDefault("top_offset")) is { } to)
                shaft.get_Parameter(BuiltInParameter.WALL_TOP_OFFSET)?.Set(UnitConverter.LengthToFeet(to));
            SetMark(shaft, row);
            return shaft;
        }

        var hostId = IdMap.Resolve(doc, row.GetValueOrDefault("host_id"))
            ?? throw new InvalidOperationException("host_id is required");
        var host = doc.GetElement(hostId);
        if (host is null) throw new InvalidOperationException("host element not found");

        // Slab opening mode (has polygon points)
        if (row.GetValueOrDefault("points") is { } pointsJson)
        {
            if (host is not Floor floor)
                throw new InvalidOperationException("slab opening host must be a Floor");

            var points = GeometryUtils.DeserializePolygon(pointsJson);
            if (points.Count < 3) throw new InvalidOperationException("Need at least 3 points for slab opening");

            var curveArray = new CurveArray();
            for (var i = 0; i < points.Count; i++)
            {
                var p1 = points[i];
                var p2 = points[(i + 1) % points.Count];
                curveArray.Append(Line.CreateBound(p1, p2));
            }

            var opening = doc.Create.NewOpening(floor, curveArray, true);
            SetMark(opening, row);
            return opening;
        }

        // Wall opening mode (has position)
        if (host is not Wall wall)
            throw new InvalidOperationException("wall opening host must be a Wall");

        var positionStr = row.GetValueOrDefault("position");
        if (positionStr is null || wall.Location is not LocationCurve hostCurve)
            throw new InvalidOperationException("position and host wall curve required");

        var distanceMeters = UnitConverter.ParseDouble(positionStr);
        var curveLength = hostCurve.Curve.Length; // feet
        var normalizedParam = UnitConverter.LengthToFeet(distanceMeters) / curveLength;
        normalizedParam = Math.Clamp(normalizedParam, 0, 1);
        var rawParam = hostCurve.Curve.ComputeRawParameter(normalizedParam);
        var insertPt = hostCurve.Curve.Evaluate(rawParam, false);

        var widthStr = row.GetValueOrDefault("width") ?? "0.9";
        var heightStr = row.GetValueOrDefault("height") ?? "2.1";
        var width = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(widthStr));
        var height = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(heightStr));

        var wallDir = (hostCurve.Curve.GetEndPoint(1) - hostCurve.Curve.GetEndPoint(0)).Normalize();
        // Sill (CSV base_offset) above the host's base level.
        var hostLevelZ = (doc.GetElement(wall.LevelId) as Level)?.Elevation ?? insertPt.Z;
        var baseZ = hostLevelZ + UnitConverter.LengthToFeet(UnitConverter.ParseNullableDouble(row.GetValueOrDefault("base_offset")) ?? 0);

        var wallOpening = doc.Create.NewOpening(wall,
            new XYZ(insertPt.X - wallDir.X * width / 2, insertPt.Y - wallDir.Y * width / 2, baseZ),
            new XYZ(insertPt.X + wallDir.X * width / 2, insertPt.Y + wallDir.Y * width / 2, baseZ + height));

        SetMark(wallOpening, row);
        return wallOpening;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        SetMark(element, row);
    }
}

static class HostedOpeningHelper
{
    internal static Element? CreateHostedOpening(Document doc, Dictionary<string, string?> row,
        IdMap idMap, BuiltInCategory category, bool isWindow)
    {
        var hostId = idMap.Resolve(doc, row.GetValueOrDefault("host_id"))
            ?? throw new InvalidOperationException("host_id is required");
        var host = doc.GetElement(hostId) as Wall
            ?? throw new InvalidOperationException("host must be a Wall");

        var levelId = idMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        var widthStr = row.GetValueOrDefault("width");
        var heightStr = row.GetValueOrDefault("height");

        FamilySymbol symbol;
        if (TypedSymbol(doc, row, category) is { } typed)
        {
            symbol = typed;
        }
        else if (widthStr is not null && heightStr is not null)
        {
            var w = UnitConverter.ParseDouble(widthStr);
            var h = UnitConverter.ParseDouble(heightStr);
            symbol = isWindow
                ? TypeResolver.ResolveOrCreateWindowType(doc, w, h)
                : TypeResolver.ResolveOrCreateDoorType(doc, w, h);
        }
        else
        {
            symbol = new FilteredElementCollector(doc)
                .OfCategory(category)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .First();
            if (!symbol.IsActive) symbol.Activate();
        }

        // Calculate insertion point from position (distance in meters) on host curve
        XYZ insertPt;
        var locationParamStr = row.GetValueOrDefault("position");
        if (locationParamStr is not null && host.Location is LocationCurve hostCurve)
        {
            var distanceMeters = UnitConverter.ParseDouble(locationParamStr);
            var curveLength = hostCurve.Curve.Length; // feet
            var normalizedParam = UnitConverter.LengthToFeet(distanceMeters) / curveLength;
            normalizedParam = Math.Clamp(normalizedParam, 0, 1);
            var rawParam = hostCurve.Curve.ComputeRawParameter(normalizedParam);
            insertPt = hostCurve.Curve.Evaluate(rawParam, false);
        }
        else
        {
            // Midpoint of host wall
            if (host.Location is LocationCurve lc)
                insertPt = lc.Curve.Evaluate(0.5, true);
            else
                throw new InvalidOperationException("Cannot determine insertion point");
        }

        var instance = doc.Create.NewFamilyInstance(insertPt, symbol, host, level, StructuralType.NonStructural);
        SetSill(instance, row);
        TableImporterBase.SetMark(instance, row);
        return instance;
    }

    /// <summary>The door / window type named by type_id when the row keeps its size.</summary>
    static FamilySymbol? TypedSymbol(Document doc, Dictionary<string, string?> row, BuiltInCategory category)
    {
        var typeId = row.GetValueOrDefault("type_id");
        if (ImportContext.Type(typeId) is not { } t) return null;
        bool Same(string f) => row.GetValueOrDefault(f) is not { } v || t.GetValueOrDefault(f) is not { } tv
            || Math.Abs(UnitConverter.ParseDouble(v) - UnitConverter.ParseDouble(tv)) < 5e-4;
        return Same("width") && Same("height") ? TypeResolver.ResolveOpeningType(doc, typeId, category) : null;
    }

    static void SetSill(FamilyInstance fi, Dictionary<string, string?> row)
    {
        if (UnitConverter.ParseNullableDouble(row.GetValueOrDefault("base_offset")) is { } sill)
            fi.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)?.Set(UnitConverter.LengthToFeet(sill));
    }

    internal static void UpdateHostedOpening(Document doc, Dictionary<string, string?> row,
        Element element, IdMap idMap, bool isWindow)
    {
        if (element is not FamilyInstance fi) return;

        // Update type if width/height changed
        var widthStr = row.GetValueOrDefault("width");
        var heightStr = row.GetValueOrDefault("height");
        if (widthStr is not null && heightStr is not null)
        {
            var w = UnitConverter.ParseDouble(widthStr);
            var h = UnitConverter.ParseDouble(heightStr);
            var newSymbol = isWindow
                ? TypeResolver.ResolveOrCreateWindowType(doc, w, h)
                : TypeResolver.ResolveOrCreateDoorType(doc, w, h);
            if (fi.Symbol.Id != newSymbol.Id)
                fi.Symbol = newSymbol;
        }

        // Update position on host (position is distance in meters along wall)
        var locationParamStr = row.GetValueOrDefault("position");
        if (locationParamStr is not null && fi.Host is Wall host && host.Location is LocationCurve hostCurve
            && fi.Location is LocationPoint lp)
        {
            var distanceMeters = UnitConverter.ParseDouble(locationParamStr);
            var curveLength = hostCurve.Curve.Length; // feet
            var normalizedParam = UnitConverter.LengthToFeet(distanceMeters) / curveLength;
            normalizedParam = Math.Clamp(normalizedParam, 0, 1);
            var rawParam = hostCurve.Curve.ComputeRawParameter(normalizedParam);
            var newPt = hostCurve.Curve.Evaluate(rawParam, false);
            lp.Point = newPt;
        }

        SetSill(fi, row);
        TableImporterBase.SetMark(fi, row);
    }
}

class RampImporter() : TableImporterBase("ramp", 15, [BuiltInCategory.OST_Ramps])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        // Ramps are complex multi-component elements — creation not supported
        return null;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        var widthStr = row.GetValueOrDefault("width");
        if (widthStr is not null)
            element.get_Parameter(BuiltInParameter.STAIRS_ATTR_TREAD_WIDTH)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(widthStr)));

        SetMark(element, row);
    }
}

/// <summary>
/// Room separators (OST_RoomSeparationLines) cannot have shared parameters bound in Revit API,
/// so BimDown_Id cannot be stored on these elements. Round-trip matching relies on geometry only.
/// </summary>
class RoomSeparatorImporter() : TableImporterBase("room_separator", 10, [BuiltInCategory.OST_RoomSeparationLines])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var curve = ParseCurve2D(row);
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        var sketchPlane = SketchPlane.Create(doc,
            Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, level.Elevation)));

        var curveArray = new CurveArray();
        curveArray.Append(curve);
        var modelCurve = doc.Create.NewRoomBoundaryLines(sketchPlane, curveArray, doc.ActiveView).get_Item(0);
        SetMark(modelCurve, row);
        return modelCurve;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element.Location is LocationCurve lc)
            lc.Curve = ParseCurve2D(row);

        SetMark(element, row);
    }
}
