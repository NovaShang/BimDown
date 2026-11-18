namespace BimDown.RevitAddin.Mapping;

/// <summary>Library family + variant guessed for a Revit furniture family.</summary>
/// <param name="Guessed">false when nothing matched (generic_box placeholder)</param>
public record FurnitureGuess(string Family, string? Variant, bool Guessed);

/// <summary>
/// Revit furniture / casework / planting / entourage / parking families →
/// the built-in furniture library (furniture.family + variant). Names are
/// matched in English and Chinese; anything unknown is a generic_box sized to
/// the family's bounding box.
/// </summary>
public static class FurnitureMapper
{
    // Ordered: more specific names first ("office chair" before "chair", "coffee table" before "table").
    static readonly (string Family, string[] Keys)[] Rules =
    [
        ("office_chair", ["office chair", "task chair", "swivel", "办公椅", "转椅"]),
        ("armchair", ["armchair", "lounge chair", "easy chair", "扶手椅", "单人沙发"]),
        ("sofa", ["sofa", "couch", "settee", "沙发"]),
        ("meeting_table", ["table conference", "table meeting", "meeting table", "conference table", "boardroom", "会议桌"]),
        ("dining_table", ["table dining", "dining table", "dinner table", "餐桌"]),
        ("coffee_table", ["table coffee", "table end", "table side", "coffee table", "side table", "end table", "茶几"]),
        ("reception_counter", ["reception", "front desk", "counter desk", "前台", "接待台"]),
        ("desk", ["desk", "workstation", "书桌", "办公桌", "工位"]),
        ("nightstand", ["table night", "nightstand", "night stand", "bedside", "床头柜"]),
        ("bed", ["bed", "床"]),
        ("wardrobe", ["wardrobe", "armoire", "closet", "衣柜"]),
        ("bookshelf", ["bookshelf", "bookcase", "shelving", "shelf", "书架", "书柜"]),
        ("filing_cabinet", ["filing", "file cabinet", "文件柜"]),
        ("locker", ["locker", "储物柜", "更衣柜"]),
        ("sideboard", ["sideboard", "credenza", "buffet", "低柜", "餐边柜"]),
        ("wall_cabinet", ["upper cabinet", "wall cabinet", "wall-mounted cabinet", "吊柜"]),
        ("tall_cabinet", ["tall cabinet", "pantry", "高柜"]),
        ("base_cabinet", ["base cabinet", "counter", "vanity", "地柜", "橱柜"]),
        ("refrigerator", ["refrigerator", "fridge", "冰箱"]),
        ("stove", ["stove", "range", "cooktop", "oven", "灶", "炉"]),
        ("dishwasher", ["dishwasher", "洗碗机"]),
        ("washing_machine", ["washing machine", "washer", "dryer", "洗衣机"]),
        ("toilet_partition", ["toilet partition", "toilet stall", "toilet cubicle", "厕所隔断", "卫生间隔断"]),
        ("parking_space", ["parking", "stall", "车位"]),
        ("car", ["car", "vehicle", "sedan", "suv", "汽车", "轿车"]),
        ("tree", ["tree", "乔木", "树"]),
        ("plant", ["plant", "shrub", "bush", "flower", "potted", "灌木", "植物", "盆栽"]),
        ("person", ["person", "people", "man", "woman", "male", "female", "rpc people", "child", "entourage", "人物", "人"]),
        ("chair", ["chair", "stool", "seat", "椅", "凳"]),
        ("dining_table", ["table", "桌"]),
    ];

    public static FurnitureGuess Guess(string familyName, string typeName, string? categoryName = null)
    {
        var n = $" {familyName} {typeName} ".ToLowerInvariant().Replace('_', ' ').Replace('-', ' ');
        string? family = null;
        foreach (var (fam, keys) in Rules)
        {
            if (keys.Any(k => Matches(n, k))) { family = fam; break; }
        }
        if (family is null)
        {
            // Category-level fallbacks (Planting, Parking, Entourage).
            if (Names.ContainsAny(categoryName, "planting", "植物")) family = "plant";
            else if (Names.ContainsAny(categoryName, "parking", "停车")) family = "parking_space";
            else if (Names.ContainsAny(categoryName, "entourage", "配景")) family = "person";
        }
        if (family is null) return new FurnitureGuess("generic_box", null, false);
        return new FurnitureGuess(family, Variant(family, n), true);
    }

    // Latin keywords match whole words so "bed" does not hit "embedded"; CJK match anywhere.
    static bool Matches(string text, string key)
    {
        if (key.Any(c => c > 127)) return text.Contains(key, StringComparison.Ordinal);
        var i = text.IndexOf(key, StringComparison.Ordinal);
        while (i >= 0)
        {
            var end = i + key.Length;
            var startOk = i == 0 || !char.IsLetter(text[i - 1]);
            // whole word, or a plural ("chairs", "benches")
            var endOk = end >= text.Length || !char.IsLetter(text[end])
                || (text[end] == 's' && (end + 1 >= text.Length || !char.IsLetter(text[end + 1])))
                || (text[end] == 'e' && end + 1 < text.Length && text[end + 1] == 's');
            if (startOk && endOk) return true;
            i = text.IndexOf(key, i + 1, StringComparison.Ordinal);
        }
        return false;
    }

    static string? Variant(string family, string n) => family switch
    {
        "bed" when Names.ContainsAny(n, "king", "特大") => "king",
        "bed" when Names.ContainsAny(n, "single", "twin", "单人") => "single",
        "bed" => "double",
        "sofa" when Names.ContainsAny(n, "l shape", "l-shape", "sectional", "corner", "转角", "l型") => "l_shape",
        "sofa" when Names.ContainsAny(n, "2 seat", "two seat", "loveseat", "双人") => "2_seat",
        "desk" when Names.ContainsAny(n, "l shape", "l-shape", "corner", "转角", "l型") => "l_shape",
        "desk" when Names.ContainsAny(n, "pedestal", "drawer") => "pedestal",
        "meeting_table" when Names.ContainsAny(n, "round", "circular", "圆") => "round",
        "meeting_table" when Names.ContainsAny(n, "racetrack", "oval", "boat") => "racetrack",
        "dining_table" or "coffee_table" when Names.ContainsAny(n, "round", "circular", "圆") => "round",
        "wardrobe" when Names.ContainsAny(n, "sliding", "推拉") => "sliding",
        "filing_cabinet" when Names.ContainsAny(n, "lateral") => "lateral",
        "reception_counter" when Names.ContainsAny(n, "l shape", "l-shape", "corner", "l型") => "l_shape",
        "locker" when Names.ContainsAny(n, "double", "2 tier", "two tier", "双层") => "double_tier",
        "base_cabinet" when Names.ContainsAny(n, "sink", "水槽", "洗涤") => "sink",
        "base_cabinet" when Names.ContainsAny(n, "drawer", "抽屉") => "drawers",
        "refrigerator" when Names.ContainsAny(n, "side by side", "double door", "对开") => "side_by_side",
        "toilet_partition" when Names.ContainsAny(n, "accessible", "ada", "handicap", "无障碍") => "accessible",
        "parking_space" when Names.ContainsAny(n, "accessible", "ada", "handicap", "无障碍") => "accessible",
        "car" when Names.ContainsAny(n, "suv", "van", "truck") => "suv",
        "tree" when Names.ContainsAny(n, "conifer", "pine", "spruce", "fir", "针叶", "松") => "conifer",
        "person" when Names.ContainsAny(n, "child", "kid", "儿童") => "child",
        _ => null,
    };

    /// <summary>
    /// Footprint centre in plan of a family whose local bounding box is
    /// [minX, maxX] × [minY, maxY] around its insertion point (ox, oy), turned by
    /// <paramref name="rotationRad"/>: BimDown furniture points sit at the
    /// footprint centre, Revit families at their insertion point.
    /// </summary>
    public static (double X, double Y) FootprintCenter(double ox, double oy, double rotationRad,
        double minX, double maxX, double minY, double maxY, bool mirrored = false)
    {
        var lx = (minX + maxX) / 2;
        var ly = (minY + maxY) / 2;
        if (mirrored) lx = -lx;
        var (c, s) = (Math.Cos(rotationRad), Math.Sin(rotationRad));
        return (ox + lx * c - ly * s, oy + lx * s + ly * c);
    }
}
