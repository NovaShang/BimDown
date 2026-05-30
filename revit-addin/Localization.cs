using System.Globalization;

namespace BimDown.RevitAddin;

/// <summary>
/// Bilingual strings (Chinese / English) with auto locale detection.
/// </summary>
static class L
{
    static readonly bool IsChinese =
        CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";

    public static string S(string en, string zh) => IsChinese ? zh : en;

    // ── Ribbon ──
    public static string TabName => S("BimDown", "BimDown");
    public static string PanelName => S("BimDown", "BimDown");
    public static string ExportButton => S("Export", "导出");
    public static string ImportButton => S("Import", "导入");
    public static string ExportTooltip => S("Export model to BimDown format (CSV + SVG)", "将模型导出为 BimDown 格式 (CSV + SVG)");
    public static string ImportTooltip => S("Import BimDown format (CSV + SVG) into model", "将 BimDown 格式 (CSV + SVG) 导入模型");

    // ── Export Dialog ──
    public static string ExportSettingsTitle => S("BimDown Export Settings", "BimDown 导出设置");
    public static string SelectOutputFolder => S("Output File", "输出文件");
    public static string Browse => S("Browse...", "浏览...");
    public static string BimDownFileFilter => S("BimDown Package (*.zip)|*.zip", "BimDown 包 (*.zip)|*.zip");
    public static string CategorySelection => S("Categories to Export", "选择导出类别");
    public static string GroupArchitecture => S("Architecture", "建筑");
    public static string GroupStructure => S("Structure", "结构");
    public static string GroupMep => S("MEP", "机电");
    public static string GroupGlobal => S("Global", "全局");
    public static string OptionExportMesh => S("Export unrecognized elements as mesh (GLB, read-only)", "将无法识别的构件导出为 Mesh (GLB, 不可编辑)");
    public static string OptionWriteIds => S("Write BimDown IDs to model (enables lossless re-import)", "将 BimDown ID 写入模型 (确保无损导入更新)");
    public static string Export => S("Export", "导出");
    public static string Cancel => S("Cancel", "取消");
    public static string SelectAll => S("Select All", "全选");
    public static string DeselectAll => S("Deselect All", "全不选");

    // ── Import Dialog ──
    public static string SelectImportFolder => S("Select BimDown package file for import", "选择要导入的 BimDown 包文件");

    // ── Progress ──
    public static string ProgressExportTitle => S("BimDown Export", "BimDown 导出中");
    public static string ProgressImportTitle => S("BimDown Import", "BimDown 导入中");
    public static string ProgressInitializing => S("Initializing...", "初始化中...");
    public static string ProgressPreparing => S("Preparing...", "准备中...");
    public static string ProgressScanningIds => S("Scanning IDs...", "扫描 ID...");
    public static string ProgressExportingTables => S("Exporting tables...", "导出数据表...");
    public static string ProgressRemappingIds => S("Remapping IDs...", "映射 ID...");
    public static string ProgressWritingCsv => S("Writing CSV files...", "写入 CSV 文件...");
    public static string ProgressExportingMeshes => S("Exporting meshes...", "导出 Mesh...");
    public static string ProgressWritingSvg => S("Writing SVG files...", "写入 SVG 文件...");
    public static string ProgressSavingToModel => S("Saving to model...", "写入模型...");
    public static string ProgressDone => S("Done", "完成");
    public static string ProgressReadingFiles => S("Reading files...", "读取文件...");
    public static string ProgressPreparingImport => S("Preparing import...", "准备导入...");
    public static string ProgressImporting(string table) => S($"Importing {table}...", $"导入 {table}...");

    // ── Result Messages ──
    public static string ExportComplete(int count, string path) =>
        S($"Exported {count} tables to:\n{path}", $"已导出 {count} 个数据表到:\n{path}");
    public static string ExportResultTitle => S("BimDown Export", "BimDown 导出");
    public static string ImportResultTitle => S("BimDown Import", "BimDown 导入");
    public static string ImportComplete(int tables, int created, int updated, int deleted) =>
        S($"Import complete ({tables} tables):\n  Created: {created}\n  Updated: {updated}\n  Deleted: {deleted}",
          $"导入完成 ({tables} 个表):\n  新建: {created}\n  更新: {updated}\n  删除: {deleted}");
    public static string Warnings(int count) => S($"\n\nWarnings ({count}):", $"\n\n警告 ({count}):");
    public static string Errors(int count) => S($"\n\nErrors ({count}):", $"\n\n错误 ({count}):");

    // ── Share ──
    public static string ShareButton => S("Share", "分享");
    public static string ShareTooltip => S("Export and share model via BimClaw", "导出并通过 BimClaw 分享模型");
    public static string ShareProgressTitle => S("BimDown Share", "BimDown 分享中");
    public static string ShareExporting => S("Exporting model...", "正在导出模型...");
    public static string SharePacking => S("Packing files...", "正在打包文件...");
    public static string ShareUploading => S("Uploading to BimClaw...", "正在上传到 BimClaw...");
    public static string ShareResultTitle => S("Share Link", "分享链接");
    public static string ShareSuccess(string url, string expiresAt) =>
        S($"Share link created!\n\n{url}\n\nExpires: {expiresAt}", $"分享链接已创建！\n\n{url}\n\n过期时间: {expiresAt}");
    public static string ShareCopyLink => S("Copy Link", "复制链接");
    public static string ShareOpenBrowser => S("Open in Browser", "在浏览器中打开");
    public static string ShareFailed(string error) =>
        S($"Share failed:\n{error}", $"分享失败:\n{error}");
    public static string ShareClose => S("Close", "关闭");

    // ── Category Names ──
    public static string CatWall => S("Wall", "墙");
    public static string CatColumn => S("Column", "柱");
    public static string CatSlab => S("Floor / Slab", "楼板");
    public static string CatSpace => S("Space / Room", "房间");
    public static string CatDoor => S("Door", "门");
    public static string CatWindow => S("Window", "窗");
    public static string CatStair => S("Stair", "楼梯");
    public static string CatCurtainWall => S("Curtain Wall", "幕墙");
    public static string CatRoof => S("Roof", "屋顶");
    public static string CatCeiling => S("Ceiling", "天花板");
    public static string CatOpening => S("Opening", "洞口");
    public static string CatRamp => S("Ramp", "坡道");
    public static string CatRailing => S("Railing", "栏杆");
    public static string CatRoomSeparator => S("Room Separator", "房间分隔线");
    public static string CatStructureWall => S("Structure Wall", "结构墙");
    public static string CatStructureColumn => S("Structure Column", "结构柱");
    public static string CatStructureSlab => S("Structure Slab", "结构板");
    public static string CatBeam => S("Beam", "梁");
    public static string CatBrace => S("Brace", "支撑");
    public static string CatFoundation => S("Foundation", "基础");
    public static string CatDuct => S("Duct", "风管");
    public static string CatPipe => S("Pipe", "管道");
    public static string CatCableTray => S("Cable Tray", "桥架");
    public static string CatConduit => S("Conduit", "线管");
    public static string CatMepNode => S("MEP Node / Fitting", "机电节点/管件");
    public static string CatEquipment => S("Equipment", "设备");
    public static string CatTerminal => S("Terminal", "末端");
    public static string CatConnector => S("Connector / Port", "连接器/端口");
    public static string CatLevel => S("Level", "标高");
    public static string CatGrid => S("Grid", "轴网");
}
