using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.DB.Structure;

namespace BimDown.RevitAddin.Import;

static class MepHelper
{
    /// <summary>insulation_thickness → a Revit duct / pipe insulation of the first insulation type.</summary>
    internal static void SetInsulation(Document doc, Element curve, Dictionary<string, string?> row)
    {
        if (UnitConverter.ParseNullableDouble(row.GetValueOrDefault("insulation_thickness")) is not { } t || t <= 0) return;
        var feet = UnitConverter.LengthToFeet(t);
        var existing = InsulationLiningBase.GetInsulationIds(doc, curve.Id).Select(doc.GetElement).OfType<InsulationLiningBase>().FirstOrDefault();
        if (existing is not null) { existing.Thickness = feet; return; }
        if (curve is Duct)
        {
            var type = new FilteredElementCollector(doc).OfClass(typeof(DuctInsulationType)).FirstElementId();
            if (type != ElementId.InvalidElementId) DuctInsulation.Create(doc, curve.Id, type, feet);
        }
        else if (curve is Pipe)
        {
            var type = new FilteredElementCollector(doc).OfClass(typeof(PipeInsulationType)).FirstElementId();
            if (type != ElementId.InvalidElementId) PipeInsulation.Create(doc, curve.Id, type, feet);
        }
    }

    internal static void SetSectionSize(Element element, Dictionary<string, string?> row)
    {
        var shape = row.GetValueOrDefault("shape");
        var sizeXStr = row.GetValueOrDefault("size_x");
        var sizeYStr = row.GetValueOrDefault("size_y");

        if (shape == "round" && sizeXStr is not null)
        {
            element.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(sizeXStr)));
        }
        else if (sizeXStr is not null && sizeYStr is not null)
        {
            element.get_Parameter(BuiltInParameter.RBS_CURVE_WIDTH_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(sizeXStr)));
            element.get_Parameter(BuiltInParameter.RBS_CURVE_HEIGHT_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(sizeYStr)));
        }
    }
}

class DuctImporter() : TableImporterBase("duct", 25, [BuiltInCategory.OST_DuctCurves])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var line = Parse3DLine(row);
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");

        var systemType = new FilteredElementCollector(doc)
            .OfClass(typeof(MechanicalSystemType))
            .Cast<MechanicalSystemType>()
            .FirstOrDefault()
            ?? throw new InvalidOperationException("No MechanicalSystemType found");

        var ductType = new FilteredElementCollector(doc)
            .OfClass(typeof(DuctType))
            .Cast<DuctType>()
            .FirstOrDefault()
            ?? throw new InvalidOperationException("No DuctType found");

        var duct = Duct.Create(doc, systemType.Id, ductType.Id, levelId,
            line.GetEndPoint(0), line.GetEndPoint(1));

        MepHelper.SetSectionSize(duct, row);
        MepHelper.SetInsulation(doc, duct, row);
        SetMark(duct, row);
        return duct;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element.Location is LocationCurve lc)
            lc.Curve = Parse3DLine(row);

        MepHelper.SetSectionSize(element, row);
        MepHelper.SetInsulation(doc, element, row);
        SetMark(element, row);
    }
}

class PipeImporter() : TableImporterBase("pipe", 25, [BuiltInCategory.OST_PipeCurves])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var line = Parse3DLine(row);
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");

        var systemType = new FilteredElementCollector(doc)
            .OfClass(typeof(PipingSystemType))
            .Cast<PipingSystemType>()
            .FirstOrDefault()
            ?? throw new InvalidOperationException("No PipingSystemType found");

        var pipeType = new FilteredElementCollector(doc)
            .OfClass(typeof(PipeType))
            .Cast<PipeType>()
            .FirstOrDefault()
            ?? throw new InvalidOperationException("No PipeType found");

        var pipe = Pipe.Create(doc, systemType.Id, pipeType.Id, levelId,
            line.GetEndPoint(0), line.GetEndPoint(1));

        var sizeXStr = row.GetValueOrDefault("size_x");
        if (sizeXStr is not null)
            pipe.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(sizeXStr)));

        MepHelper.SetInsulation(doc, pipe, row);
        SetMark(pipe, row);
        return pipe;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element.Location is LocationCurve lc)
            lc.Curve = Parse3DLine(row);

        var sizeXStr = row.GetValueOrDefault("size_x");
        if (sizeXStr is not null)
            element.get_Parameter(BuiltInParameter.RBS_PIPE_DIAMETER_PARAM)?.Set(
                UnitConverter.LengthToFeet(UnitConverter.ParseDouble(sizeXStr)));

        MepHelper.SetInsulation(doc, element, row);
        SetMark(element, row);
    }
}

class CableTrayImporter() : TableImporterBase("cable_tray", 25, [BuiltInCategory.OST_CableTray])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var line = Parse3DLine(row);
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");

        var trayType = new FilteredElementCollector(doc)
            .OfClass(typeof(CableTrayType))
            .Cast<CableTrayType>()
            .FirstOrDefault()
            ?? throw new InvalidOperationException("No CableTrayType found");

        var tray = CableTray.Create(doc, trayType.Id,
            line.GetEndPoint(0), line.GetEndPoint(1), levelId);

        MepHelper.SetSectionSize(tray, row);
        SetMark(tray, row);
        return tray;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element.Location is LocationCurve lc)
            lc.Curve = Parse3DLine(row);

        MepHelper.SetSectionSize(element, row);
        MepHelper.SetInsulation(doc, element, row);
        SetMark(element, row);
    }
}

class ConduitImporter() : TableImporterBase("conduit", 25, [BuiltInCategory.OST_Conduit])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var line = Parse3DLine(row);
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");

        var conduitType = new FilteredElementCollector(doc)
            .OfClass(typeof(ConduitType))
            .Cast<ConduitType>()
            .FirstOrDefault()
            ?? throw new InvalidOperationException("No ConduitType found");

        var conduit = Conduit.Create(doc, conduitType.Id,
            line.GetEndPoint(0), line.GetEndPoint(1), levelId);

        MepHelper.SetSectionSize(conduit, row);
        SetMark(conduit, row);
        return conduit;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element.Location is LocationCurve lc)
            lc.Curve = Parse3DLine(row);

        MepHelper.SetSectionSize(element, row);
        MepHelper.SetInsulation(doc, element, row);
        SetMark(element, row);
    }
}

class EquipmentImporter() : TableImporterBase(
    "equipment",
    30,
    [BuiltInCategory.OST_MechanicalEquipment, BuiltInCategory.OST_ElectricalEquipment])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["x"]!));
        var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["y"]!));
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        var symbol = FindEquipmentSymbol(doc);
        var pt = new XYZ(x, y, level.Elevation);
        var instance = doc.Create.NewFamilyInstance(pt, symbol, level, StructuralType.NonStructural);

        var rotationStr = row.GetValueOrDefault("rotation");
        if (rotationStr is not null)
        {
            var angle = UnitConverter.AngleToRadians(UnitConverter.ParseDouble(rotationStr));
            if (Math.Abs(angle) > 1e-10)
            {
                var axis = Line.CreateBound(pt, pt + XYZ.BasisZ);
                ElementTransformUtils.RotateElement(doc, instance.Id, axis, angle);
            }
        }

        SetMark(instance, row);
        return instance;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element.Location is LocationPoint lp)
        {
            var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["x"]!));
            var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["y"]!));
            var target = new XYZ(x, y, lp.Point.Z);
            var delta = target - lp.Point;
            if (delta.GetLength() > 1e-10)
                ElementTransformUtils.MoveElement(doc, element.Id, delta);
        }

        var rotationStr = row.GetValueOrDefault("rotation");
        if (rotationStr is not null && element.Location is LocationPoint locPt)
        {
            var targetAngle = UnitConverter.AngleToRadians(UnitConverter.ParseDouble(rotationStr));
            var currentAngle = locPt.Rotation;
            var angleDelta = targetAngle - currentAngle;
            if (Math.Abs(angleDelta) > 1e-10)
            {
                var axis = Line.CreateBound(locPt.Point, locPt.Point + XYZ.BasisZ);
                ElementTransformUtils.RotateElement(doc, element.Id, axis, angleDelta);
            }
        }

        SetMark(element, row);
    }

    static FamilySymbol FindEquipmentSymbol(Document doc)
    {
        var symbol = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_MechanicalEquipment)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault();

        symbol ??= new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_ElectricalEquipment)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .FirstOrDefault();

        if (symbol is null)
            throw new InvalidOperationException("No equipment FamilySymbol found");

        if (!symbol.IsActive) symbol.Activate();
        return symbol;
    }
}

class TerminalImporter() : TableImporterBase(
    "terminal",
    30,
    [BuiltInCategory.OST_DuctTerminal, BuiltInCategory.OST_Sprinklers,
     BuiltInCategory.OST_LightingFixtures, BuiltInCategory.OST_ElectricalFixtures])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["x"]!));
        var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["y"]!));
        var levelId = IdMap.Resolve(doc, row.GetValueOrDefault("level_id"))
            ?? throw new InvalidOperationException("level_id is required");
        var level = (Level)doc.GetElement(levelId);

        var symbol = FindTerminalSymbol(doc);
        var pt = new XYZ(x, y, level.Elevation);
        var instance = doc.Create.NewFamilyInstance(pt, symbol, level, StructuralType.NonStructural);

        var rotationStr = row.GetValueOrDefault("rotation");
        if (rotationStr is not null)
        {
            var angle = UnitConverter.AngleToRadians(UnitConverter.ParseDouble(rotationStr));
            if (Math.Abs(angle) > 1e-10)
            {
                var axis = Line.CreateBound(pt, pt + XYZ.BasisZ);
                ElementTransformUtils.RotateElement(doc, instance.Id, axis, angle);
            }
        }

        SetMark(instance, row);
        return instance;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        if (element.Location is LocationPoint lp)
        {
            var x = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["x"]!));
            var y = UnitConverter.LengthToFeet(UnitConverter.ParseDouble(row["y"]!));
            var target = new XYZ(x, y, lp.Point.Z);
            var delta = target - lp.Point;
            if (delta.GetLength() > 1e-10)
                ElementTransformUtils.MoveElement(doc, element.Id, delta);
        }

        var rotationStr = row.GetValueOrDefault("rotation");
        if (rotationStr is not null && element.Location is LocationPoint locPt)
        {
            var targetAngle = UnitConverter.AngleToRadians(UnitConverter.ParseDouble(rotationStr));
            var currentAngle = locPt.Rotation;
            var angleDelta = targetAngle - currentAngle;
            if (Math.Abs(angleDelta) > 1e-10)
            {
                var axis = Line.CreateBound(locPt.Point, locPt.Point + XYZ.BasisZ);
                ElementTransformUtils.RotateElement(doc, element.Id, axis, angleDelta);
            }
        }

        SetMark(element, row);
    }

    static readonly BuiltInCategory[] TerminalCategories =
    [
        BuiltInCategory.OST_DuctTerminal,
        BuiltInCategory.OST_Sprinklers,
        BuiltInCategory.OST_LightingFixtures,
        BuiltInCategory.OST_ElectricalFixtures,
    ];

    static FamilySymbol FindTerminalSymbol(Document doc)
    {
        foreach (var cat in TerminalCategories)
        {
            var symbol = new FilteredElementCollector(doc)
                .OfCategory(cat)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .FirstOrDefault();
            if (symbol is not null)
            {
                if (!symbol.IsActive) symbol.Activate();
                return symbol;
            }
        }

        throw new InvalidOperationException("No terminal FamilySymbol found");
    }
}

/// <summary>
/// MEP nodes represent fittings and accessories. Creation is not supported since fittings
/// are auto-inserted by Revit when connecting ducts/pipes. Update only sets the mark.
/// </summary>
class MepNodeImporter() : TableImporterBase(
    "mep_node",
    30,
    [BuiltInCategory.OST_DuctFitting, BuiltInCategory.OST_PipeFitting,
     BuiltInCategory.OST_CableTrayFitting, BuiltInCategory.OST_ConduitFitting,
     BuiltInCategory.OST_DuctAccessory, BuiltInCategory.OST_PipeAccessory])
{
    protected override Element? CreateElement(Document doc, Dictionary<string, string?> row)
    {
        // Fittings are auto-inserted by Revit when connecting MEP curves — skip creation
        return null;
    }

    protected override void UpdateElement(Document doc, Dictionary<string, string?> row, Element element)
    {
        SetMark(element, row);
    }
}
