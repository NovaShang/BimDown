using Xunit;

namespace BimDown.RevitAddin.Tests;

/// <summary>Export clean-ups found exporting the Revit 2026 sample projects in live Revit.</summary>
public class ProjectWriterTests
{
    static Dictionary<string, string?> Row(params (string Key, string? Value)[] kv) => kv.ToDictionary(p => p.Key, p => p.Value);

    static List<ExportedTable> Project(params ExportedTable[] extra) =>
    [
        new("level", true, ["id", "number", "name", "elevation"],
        [
            Row(("id", "uid-L1"), ("number", "1"), ("name", "Level 1"), ("elevation", "0")),
            Row(("id", "uid-L2"), ("number", "2"), ("name", "Level 2"), ("elevation", "3.5")),
        ]),
        .. extra,
    ];

    static Dictionary<string, int> Write(List<ExportedTable> tables)
    {
        var index = ProjectWriter.AssignIds(tables, new ShortIdGenerator());
        ProjectWriter.Finalize(tables, index);
        return index;
    }

    [Fact]
    public void Zero_sizes_are_left_empty_to_inherit_from_the_type()
    {
        var tables = Project(new ExportedTable("door", false, ["id", "level_id", "width", "height"],
            [Row(("id", "uid-D1"), ("level_id", "uid-L1"), ("width", "0"), ("height", "2.1"))]));
        Write(tables);
        var door = tables.Single(t => t.TableName == "door").Rows[0];
        Assert.Null(door["width"]);
        Assert.Equal("2.1", door["height"]);
    }

    [Fact]
    public void Tags_whose_host_is_missing_or_on_another_level_are_dropped()
    {
        var tables = Project(
            new ExportedTable("door", false, ["id", "level_id"],
            [
                Row(("id", "uid-D1"), ("level_id", "uid-L1")),
                Row(("id", "uid-D2"), ("level_id", "uid-L2")),
            ]),
            new ExportedTable("tag", false, ["id", "level_id", "host_id"],
            [
                Row(("id", "uid-T1"), ("level_id", "uid-L1"), ("host_id", "uid-D1")),
                Row(("id", "uid-T2"), ("level_id", "uid-L1"), ("host_id", "uid-D2")),
                Row(("id", "uid-T3"), ("level_id", "uid-L1"), ("host_id", null)),
            ]));
        Write(tables);
        var tags = tables.Single(t => t.TableName == "tag").Rows;
        Assert.Single(tags);
        Assert.Equal(tables.Single(t => t.TableName == "door").Rows[0]["id"], tags[0]["host_id"]);
    }

    [Fact]
    public void Connectors_go_to_their_hosts_directory()
    {
        var tables = Project(
            new ExportedTable("terminal", false, ["id", "level_id"], [Row(("id", "uid-TM"), ("level_id", "uid-L2"))]),
            new ExportedTable("connector", false, ["id", "host_id", "name", "level_id"],
                [Row(("id", "uid-TM:c0"), ("host_id", "uid-TM"), ("name", "c0"), ("level_id", null))]));
        var index = Write(tables);
        var terminal = tables.Single(t => t.TableName == "terminal").Rows[0];
        var connector = tables.Single(t => t.TableName == "connector").Rows[0];
        Assert.Equal(ProjectWriter.GetPartitionDir(terminal, index), ProjectWriter.GetPartitionDir(connector, index));
        Assert.NotEqual("global", ProjectWriter.GetPartitionDir(connector, index));
    }

    [Fact]
    public void Connectors_of_unexported_hosts_are_dropped()
    {
        var tables = Project(
            new ExportedTable("terminal", false, ["id", "level_id"], [Row(("id", "uid-TM"), ("level_id", "uid-L1"))]),
            new ExportedTable("connector", false, ["id", "host_id", "name", "level_id"],
            [
                Row(("id", "uid-TM:c0"), ("host_id", "uid-TM"), ("name", "c0"), ("level_id", null)),
                Row(("id", "uid-X:c0"), ("host_id", "uid-X"), ("name", "c0"), ("level_id", null)),
            ]));
        Write(tables);
        Assert.Single(tables.Single(t => t.TableName == "connector").Rows);
    }

    [Fact]
    public void Multi_line_text_is_written_on_one_line()
    {
        var path = Path.GetTempFileName();
        try
        {
            CsvWriter.Write(path, ["id", "description"], [Row(("id", "x"), ("description", "line one\r\nline two\n"))]);
            var lines = File.ReadAllLines(path);
            Assert.Equal(2, lines.Length);
            Assert.Equal("x,line one line two", lines[1]);
        }
        finally { File.Delete(path); }
    }
}
