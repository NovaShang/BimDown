using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;

namespace BimDown.RevitAddin.Import;

class StructureWallImporter() : TableImporterBase(
    "structure_wall",
    10,
    [BuiltInCategory.OST_Walls],
    e => e is Wall w && w.StructuralUsage != StructuralWallUsage.NonBearing)
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
            : 10.0;

        var typeId = wallType?.Id ?? new FilteredElementCollector(doc)
            .OfClass(typeof(WallType))
            .Cast<WallType>()
            .First(wt => wt.Kind == WallKind.Basic).Id;

        var wall = Wall.Create(doc, curve, typeId, levelId, heightFeet, 0, false, true);
        QueueTopAttachment(wall, row);

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
        return wall;
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
}

class StructureColumnImporter() : TableImporterBase("structure_column", 10, [BuiltInCategory.OST_StructuralColumns])
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
        if (TypeResolver.ResolveNamedSymbol(doc, row.GetValueOrDefault("type_id"), BuiltInCategory.OST_StructuralColumns) is { } named)
        {
            symbol = named;
        }
        else if (sizeXStr is not null && sizeYStr is not null)
        {
            symbol = TypeResolver.ResolveOrCreateStructuralColumnType(doc, shape,
                UnitConverter.ParseDouble(sizeXStr), UnitConverter.ParseDouble(sizeYStr));
        }
        else
        {
            symbol = TypeResolver.FindFirstFamilySymbol(doc, BuiltInCategory.OST_StructuralColumns);
        }

        var pt = new XYZ(x, y, level.Elevation);
        var column = doc.Create.NewFamilyInstance(pt, symbol, level, StructuralType.Column);

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

        // Use MoveElement for reliable position updates on level-hosted columns
        if (fi.Location is LocationPoint lp)
        {
            var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["x"]!));
            var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["y"]!));
            var target = new XYZ(x, y, lp.Point.Z);
            var delta = target - lp.Point;
            if (delta.GetLength() > 1e-10)
                ElementTransformUtils.MoveElement(doc, fi.Id, delta);
        }

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
}

class StructureSlabImporter() : TableImporterBase(
    "structure_slab",
    15,
    [BuiltInCategory.OST_Floors],
    e =>
    {
        if (e is not Floor) return false;
        var structural = e.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.AsInteger();
        return structural == 1;
    })
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var pointsJson = row.GetValueOrDefault("points")
            ?? throw new InvalidOperationException("points is required for structure_slab");
        var points = GeometryUtils.DeserializePolygon(pointsJson);
        if (points.Count < 3) throw new InvalidOperationException("Need at least 3 points for structure_slab");

        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

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

        var curveLoop = new CurveLoop();
        for (var i = 0; i < points.Count; i++)
        {
            var p1 = new XYZ(points[i].X, points[i].Y, level.Elevation);
            var p2 = new XYZ(points[(i + 1) % points.Count].X, points[(i + 1) % points.Count].Y, level.Elevation);
            curveLoop.Append(Line.CreateBound(p1, p2));
        }

        var floor = Floor.Create(doc, [curveLoop], floorType.Id, levelId);
        floor.get_Parameter(BuiltInParameter.FLOOR_PARAM_IS_STRUCTURAL)?.Set(1);

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

static class StructuralFramingHelper
{
    internal static Element CreateFramingInstance(Document doc, Dictionary<string, string?> row,
        IdMap idMap, StructuralType structuralType)
    {
        var line = TableImporterBase.Parse3DLine(row);
        var levelId = idMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        var shape = row.GetValueOrDefault("shape");
        var sizeXStr = row.GetValueOrDefault("size_x");
        var sizeYStr = row.GetValueOrDefault("size_y");

        FamilySymbol symbol;
        if (TypeResolver.ResolveNamedSymbol(doc, row.GetValueOrDefault("type_id"), BuiltInCategory.OST_StructuralFraming) is { } named)
        {
            symbol = named;
        }
        else if (sizeXStr is not null && sizeYStr is not null)
        {
            symbol = TypeResolver.ResolveOrCreateStructuralFramingType(doc, shape,
                UnitConverter.ParseDouble(sizeXStr), UnitConverter.ParseDouble(sizeYStr));
        }
        else
        {
            symbol = TypeResolver.FindFirstFamilySymbol(doc, BuiltInCategory.OST_StructuralFraming);
        }

        var instance = doc.Create.NewFamilyInstance(line, symbol, level, structuralType);
        TableImporterBase.SetMark(instance, row);
        return instance;
    }

    internal static void UpdateFramingInstance(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is not FamilyInstance fi) return;

        if (fi.Location is LocationCurve lc)
            lc.Curve = TableImporterBase.Parse3DLine(row);

        TableImporterBase.SetMark(fi, row);
    }
}

class BeamImporter() : TableImporterBase(
    "beam",
    15,
    [BuiltInCategory.OST_StructuralFraming],
    e => e is FamilyInstance fi && fi.StructuralType == StructuralType.Beam)
{
    // Beams of a beam system are generated by the system (BeamSystemImporter).
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
        => row.GetValueOrDefault("beam_system_id") is not null
            ? null
            : StructuralFramingHelper.CreateFramingInstance(doc, row, IdMap, StructuralType.Beam);

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
        => StructuralFramingHelper.UpdateFramingInstance(doc, row, element);
}

class BraceImporter() : TableImporterBase(
    "brace",
    15,
    [BuiltInCategory.OST_StructuralFraming],
    e => e is FamilyInstance fi && fi.StructuralType == StructuralType.Brace)
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
        => StructuralFramingHelper.CreateFramingInstance(doc, row, IdMap, StructuralType.Brace);

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
        => StructuralFramingHelper.UpdateFramingInstance(doc, row, element);
}

class FoundationImporter() : TableImporterBase(
    "foundation",
    15,
    [BuiltInCategory.OST_StructuralFoundation])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        // Raft foundation (polygon)
        if (row.GetValueOrDefault("points") is { } pointsJson)
        {
            var points = GeometryUtils.DeserializePolygon(pointsJson);
            if (points.Count < 3) throw new InvalidOperationException("Need at least 3 points for raft foundation");

            var thicknessStr = row.GetValueOrDefault("thickness");
            FloorType floorType = thicknessStr is not null
                ? TypeResolver.FloorTypeFor(doc, row, UnitConverter.ParseDouble(thicknessStr))
                : new FilteredElementCollector(doc).OfClass(typeof(FloorType)).Cast<FloorType>().First();

            var curveLoop = new CurveLoop();
            for (var i = 0; i < points.Count; i++)
            {
                var p1 = new XYZ(points[i].X, points[i].Y, level.Elevation);
                var p2 = new XYZ(points[(i + 1) % points.Count].X, points[(i + 1) % points.Count].Y, level.Elevation);
                curveLoop.Append(Line.CreateBound(p1, p2));
            }

            var floor = Floor.Create(doc, [curveLoop], floorType.Id, levelId);
            SetMark(floor, row);
            return floor;
        }

        // Strip foundation (line) — requires host wall, skip creation
        if (row.GetValueOrDefault("start_x") is not null)
            return null;

        // Isolated foundation (point)
        if (row.GetValueOrDefault("x") is not null)
        {
            var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["x"]!));
            var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["y"]!));
            var symbol = TypeResolver.ResolveNamedSymbol(doc, row.GetValueOrDefault("type_id"), BuiltInCategory.OST_StructuralFoundation)
                         ?? TypeResolver.FindFirstFamilySymbol(doc, BuiltInCategory.OST_StructuralFoundation);
            var pt = new XYZ(x, y, level.Elevation);
            var instance = doc.Create.NewFamilyInstance(pt, symbol, level, StructuralType.Footing);
            SetFoundationParams(instance, row);
            SetMark(instance, row);
            return instance;
        }

        return null;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element is Floor floor)
        {
            // Raft foundation
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

            var thicknessStr = row.GetValueOrDefault("thickness");
            if (thicknessStr is not null)
            {
                var newType = TypeResolver.FloorTypeFor(doc, row, UnitConverter.ParseDouble(thicknessStr));
                if (floor.FloorType.Id != newType.Id)
                    floor.FloorType = newType;
            }
        }
        else if (element.Location is LocationCurve lc)
        {
            // Strip foundation
            var sx = row.GetValueOrDefault("start_x");
            var sy = row.GetValueOrDefault("start_y");
            var ex = row.GetValueOrDefault("end_x");
            var ey = row.GetValueOrDefault("end_y");
            if (sx is not null && sy is not null && ex is not null && ey is not null)
            {
                lc.Curve = Line.CreateBound(
                    new XYZ(UnitConverter.LengthToFeet(UnitConverter.ParseDouble(sx)),
                            UnitConverter.LengthToFeet(UnitConverter.ParseDouble(sy)), 0),
                    new XYZ(UnitConverter.LengthToFeet(UnitConverter.ParseDouble(ex)),
                            UnitConverter.LengthToFeet(UnitConverter.ParseDouble(ey)), 0));
            }

            SetFoundationDimensionParams(element, row);
        }
        else if (element.Location is LocationPoint lp)
        {
            // Isolated foundation
            var xStr = row.GetValueOrDefault("x");
            var yStr = row.GetValueOrDefault("y");
            if (xStr is not null && yStr is not null)
            {
                var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(xStr));
                var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(yStr));
                lp.Point = new XYZ(x, y, lp.Point.Z);
            }

            SetFoundationParams(element, row);
        }

        SetMark(element, row);
    }

    static void SetFoundationParams(Element element, Dictionary<string, string?> row)
    {
        var lengthStr = row.GetValueOrDefault("length");
        if (lengthStr is not null)
            element.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_LENGTH)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(lengthStr)));

        SetFoundationDimensionParams(element, row);
    }

    static void SetFoundationDimensionParams(Element element, Dictionary<string, string?> row)
    {
        var widthStr = row.GetValueOrDefault("width");
        if (widthStr is not null)
        {
            var widthFeet = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(widthStr));
            element.get_Parameter(BuiltInParameter.STRUCTURAL_FOUNDATION_WIDTH)?.Set(widthFeet);
            element.get_Parameter(BuiltInParameter.FAMILY_WIDTH_PARAM)?.Set(widthFeet);
        }

        var thicknessStr = row.GetValueOrDefault("thickness");
        if (thicknessStr is not null)
        {
            var thicknessFeet = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(thicknessStr));
            element.get_Parameter(BuiltInParameter.FLOOR_ATTR_THICKNESS_PARAM)?.Set(thicknessFeet);
            element.get_Parameter(BuiltInParameter.FAMILY_HEIGHT_PARAM)?.Set(thicknessFeet);
        }
    }
}
