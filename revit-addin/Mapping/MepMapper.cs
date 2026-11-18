namespace BimDown.RevitAddin.Mapping;

/// <summary>Revit MEP data (part types, system classifications, family names) → BimDown MEP enums.</summary>
public static class MepMapper
{
    /// <summary>Revit PartType name of a passive fitting → mep_node.fitting (null = derive from geometry).</summary>
    public static string? Fitting(string? partType) => partType switch
    {
        "Elbow" or "LadderCableTrayElbow" or "ChannelCableTrayElbow" or "LadderCableTrayVerticalElbow"
            or "ChannelCableTrayVerticalElbow" or "JunctionBoxElbow" => "elbow",
        "Tee" or "LadderCableTrayTee" or "ChannelCableTrayTee" or "JunctionBoxTee" or "LateralTee" => "tee",
        "Wye" or "Pants" => "wye",
        "Cross" or "LadderCableTrayCross" or "ChannelCableTrayCross" or "JunctionBoxCross" or "LateralCross" => "cross",
        "Transition" or "LadderCableTrayTransition" or "ChannelCableTrayTransition" => "transition",
        "Union" or "PipeMechanicalCoupling" or "LadderCableTrayUnion" or "ChannelCableTrayUnion" or "PipeFlange" => "coupling",
        "Cap" or "EndCap" => "cap",
        "TapPerpendicular" or "TapAdjustable" or "SpudPerpendicular" or "SpudAdjustable" => "tap",
        _ => null,
    };

    /// <summary>
    /// Functional accessory (pipe / duct accessory family) → mep_node.kind, from its
    /// family and type names (English / Chinese). Unknown accessories are other_accessory.
    /// </summary>
    public static string AccessoryKind(string familyName, string typeName, string? partType = null)
    {
        var n = $"{familyName} {typeName}";
        if (Names.ContainsAny(n, "fire damper", "smoke damper", "防火阀", "排烟阀")) return "fire_damper";
        if (partType == "Damper" || Names.ContainsAny(n, "damper", "风阀", "调节阀门")) return "damper";
        if (Names.ContainsAny(n, "check valve", "non-return", "backflow", "止回阀", "逆止阀")) return "check_valve";
        if (Names.ContainsAny(n, "gate valve", "闸阀")) return "gate_valve";
        if (Names.ContainsAny(n, "ball valve", "球阀")) return "ball_valve";
        if (Names.ContainsAny(n, "butterfly", "蝶阀")) return "butterfly_valve";
        if (Names.ContainsAny(n, "globe valve", "截止阀")) return "globe_valve";
        if (Names.ContainsAny(n, "balancing", "balance valve", "circuit setter", "平衡阀")) return "balancing_valve";
        if (Names.ContainsAny(n, "strainer", "filter", "过滤器")) return "strainer";
        if (Names.ContainsAny(n, "flow meter", "flowmeter", "water meter", "meter", "流量计", "水表")) return "flow_meter";
        if (partType is "Sensor" or "InlineSensor" || Names.ContainsAny(n, "sensor", "thermometer", "gauge", "pressure switch", "传感器", "温度计", "压力表")) return "sensor";
        if (Names.ContainsAny(n, "access panel", "access door", "检修口", "检修门")) return "access_panel";
        if (Names.ContainsAny(n, "inline pump", "circulator", "管道泵")) return "pump";
        if (partType is "ValveNormal" or "ValveBreaksInto" || Names.ContainsAny(n, "valve", "阀")) return "valve";
        return "other_accessory";
    }

    /// <summary>Revit MEPSystemClassification name → mep_system.discipline.</summary>
    public static string Discipline(string? classification) => classification switch
    {
        "SupplyAir" or "ReturnAir" or "ExhaustAir" or "OtherAir" or "SupplyHydronic" or "ReturnHydronic" or "CondensateDrain" => "hvac",
        "DomesticColdWater" or "DomesticHotWater" or "Sanitary" or "Vent" or "Storm" or "Recirculation" or "OtherPipe" => "plumbing",
        "FireProtectWet" or "FireProtectDry" or "FireProtectPreaction" or "FireProtectOther" => "fire",
        "PowerCircuit" or "PowerBalanced" or "PowerUnBalanced" or "CableTrayConduit" => "electrical",
        "DataCircuit" or "Communication" or "Telephone" or "Security" or "FireAlarm" or "NurseCall" or "Controls" => "data",
        _ => "other",
    };

    /// <summary>
    /// Short system tag (system_type) for an element: the Revit system type's
    /// Abbreviation when set, else the editor's preset code for its classification
    /// (SA, RA, EA, CHWS, HWS, DCW, DHW, SAN, VENT, STORM, FP, CD, PWR, DATA),
    /// refined by the system type name (chilled / heating / condenser water).
    /// </summary>
    public static string? SystemTag(string? abbreviation, string? classification, string? systemTypeName)
    {
        if (!string.IsNullOrWhiteSpace(abbreviation)) return abbreviation.Trim().ToUpperInvariant();
        var name = systemTypeName ?? "";
        switch (classification)
        {
            case "SupplyAir": return Names.ContainsAny(name, "outside", "outdoor", "fresh", "新风") ? "OA" : "SA";
            case "ReturnAir": return "RA";
            case "ExhaustAir": return "EA";
            case "SupplyHydronic":
                return Names.ContainsAny(name, "condenser", "cooling water", "冷却水") ? "CWS"
                    : Names.ContainsAny(name, "chilled", "cold", "冷冻", "冷水") ? "CHWS" : "HWS";
            case "ReturnHydronic":
                return Names.ContainsAny(name, "condenser", "cooling water", "冷却水") ? "CWR"
                    : Names.ContainsAny(name, "chilled", "cold", "冷冻", "冷水") ? "CHWR" : "HWR";
            case "DomesticColdWater": return "DCW";
            case "DomesticHotWater": return "DHW";
            case "Recirculation": return "DHWR";
            case "Sanitary": return "SAN";
            case "Vent": return "VENT";
            case "Storm": return "STORM";
            case "CondensateDrain": return "CD";
            case "FireProtectWet" or "FireProtectDry" or "FireProtectPreaction" or "FireProtectOther": return "FP";
            case "PowerCircuit" or "PowerBalanced" or "PowerUnBalanced": return "PWR";
            case "DataCircuit" or "Communication" or "Telephone": return "DATA";
        }
        return string.IsNullOrWhiteSpace(systemTypeName) ? null : Names.Slug(systemTypeName, "sys").ToUpperInvariant();
    }

    public static string ColorHex(byte r, byte g, byte b) => $"#{r:x2}{g:x2}{b:x2}";

    /// <summary>Equipment family / type name → equipment.equipment_type.</summary>
    public static string EquipmentType(string? name, bool electricalCategory = false)
    {
        var n = name ?? "";
        if (Names.ContainsAny(n, "ahu", "air handling", "air handler", "空调箱", "空调机组", "组合式")) return "ahu";
        if (Names.ContainsAny(n, "fcu", "fan coil", "风机盘管")) return "fcu";
        if (Names.ContainsAny(n, "vav", "变风量")) return "vav";
        if (Names.ContainsAny(n, "chiller", "冷水机", "冷机")) return "chiller";
        if (Names.ContainsAny(n, "boiler", "锅炉")) return "boiler";
        if (Names.ContainsAny(n, "cooling tower", "冷却塔")) return "cooling_tower";
        if (Names.ContainsAny(n, "water heater", "热水器")) return "water_heater";
        if (Names.ContainsAny(n, "coil", "盘管")) return "coil";
        if (Names.ContainsAny(n, "fan", "风机")) return "fan";
        if (Names.ContainsAny(n, "pump", "水泵", "泵")) return "pump";
        if (Names.ContainsAny(n, "transformer", "变压器")) return "transformer";
        if (Names.ContainsAny(n, "generator", "发电机")) return "generator";
        if (Names.ContainsAny(n, "panel", "panelboard", "switchboard", "distribution board", "配电箱", "配电柜")) return "panelboard";
        if (Names.ContainsAny(n, "tank", "水箱", "罐")) return "tank";
        return electricalCategory ? "panelboard" : "other";
    }

    /// <summary>
    /// Terminal type from the Revit category (BuiltInCategory name) and family / type names.
    /// </summary>
    public static string TerminalType(string category, string? name)
    {
        var n = name ?? "";
        switch (category)
        {
            case "OST_Sprinklers": return "sprinkler_head";
            case "OST_LightingFixtures":
                return Names.ContainsAny(n, "emergency", "exit", "应急", "疏散") ? "emergency_light" : "light_fixture";
            case "OST_LightingDevices":
                return "switch";
            case "OST_FireAlarmDevices": return "fire_alarm_device";
            case "OST_DataDevices" or "OST_CommunicationDevices" or "OST_TelephoneDevices": return "data_outlet";
            case "OST_ElectricalFixtures":
                if (Names.ContainsAny(n, "data", "rj45", "network", "数据", "网络")) return "data_outlet";
                if (Names.ContainsAny(n, "junction", "接线盒")) return "junction_box";
                if (Names.ContainsAny(n, "switch", "开关")) return "switch";
                return "power_outlet";
            case "OST_DuctTerminal":
                if (Names.ContainsAny(n, "return", "回风")) return "return_air_grille";
                if (Names.ContainsAny(n, "exhaust", "排风", "排气")) return "exhaust_air_grille";
                return "supply_air_diffuser";
            case "OST_PlumbingFixtures":
                if (Names.ContainsAny(n, "water closet", "toilet", "wc", "坐便", "蹲便", "马桶")) return "water_closet";
                if (Names.ContainsAny(n, "urinal", "小便")) return "urinal";
                if (Names.ContainsAny(n, "lavatory", "wash basin", "basin", "洗脸盆", "洗手盆", "台盆")) return "lavatory";
                if (Names.ContainsAny(n, "shower", "淋浴")) return "shower";
                if (Names.ContainsAny(n, "floor drain", "地漏")) return "floor_drain";
                if (Names.ContainsAny(n, "sink", "水槽", "洗涤")) return "sink";
                return "plumbing_fixture";
        }
        return "other";
    }

    /// <summary>
    /// Revit apparent load (VA) → design load (W) with the power factor (1 when unknown).
    /// </summary>
    public static double? LoadWatts(double? apparentVa, double? powerFactor = null) =>
        apparentVa is > 0 ? apparentVa.Value * (powerFactor is > 0 and <= 1 ? powerFactor.Value : 1) : null;
}
