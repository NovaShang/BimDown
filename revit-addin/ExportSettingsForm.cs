namespace BimDown.RevitAddin;

record ExportCategory(string TableName, string DisplayName, string Group);

sealed class ExportSettings
{
    public string OutputFile { get; set; } = "";
    public HashSet<string> EnabledTables { get; set; } = [];
    public bool ExportMesh { get; set; } = true;
    public bool WriteIdsToModel { get; set; } = true;
    public bool Confirmed { get; set; }
}

sealed class ExportSettingsForm : BaseForm
{
    static readonly ExportCategory[] AllCategories =
    [
        // Global
        new("level", L.CatLevel, L.GroupGlobal),
        new("grid", L.CatGrid, L.GroupGlobal),
        // Architecture
        new("wall", L.CatWall, L.GroupArchitecture),
        new("column", L.CatColumn, L.GroupArchitecture),
        new("slab", L.CatSlab, L.GroupArchitecture),
        new("space", L.CatSpace, L.GroupArchitecture),
        new("door", L.CatDoor, L.GroupArchitecture),
        new("window", L.CatWindow, L.GroupArchitecture),
        new("stair", L.CatStair, L.GroupArchitecture),
        new("curtain_wall", L.CatCurtainWall, L.GroupArchitecture),
        new("roof", L.CatRoof, L.GroupArchitecture),
        new("ceiling", L.CatCeiling, L.GroupArchitecture),
        new("opening", L.CatOpening, L.GroupArchitecture),
        new("ramp", L.CatRamp, L.GroupArchitecture),
        new("railing", L.CatRailing, L.GroupArchitecture),
        new("room_separator", L.CatRoomSeparator, L.GroupArchitecture),
        // Structure
        new("structure_wall", L.CatStructureWall, L.GroupStructure),
        new("structure_column", L.CatStructureColumn, L.GroupStructure),
        new("structure_slab", L.CatStructureSlab, L.GroupStructure),
        new("beam", L.CatBeam, L.GroupStructure),
        new("brace", L.CatBrace, L.GroupStructure),
        new("foundation", L.CatFoundation, L.GroupStructure),
        // MEP
        new("duct", L.CatDuct, L.GroupMep),
        new("pipe", L.CatPipe, L.GroupMep),
        new("cable_tray", L.CatCableTray, L.GroupMep),
        new("conduit", L.CatConduit, L.GroupMep),
        new("mep_node", L.CatMepNode, L.GroupMep),
        new("equipment", L.CatEquipment, L.GroupMep),
        new("terminal", L.CatTerminal, L.GroupMep),
        new("connector", L.CatConnector, L.GroupMep),
    ];

    readonly TextBox _pathBox;
    readonly CheckedListBox _categoryList;
    readonly CheckBox _meshCheck;
    readonly CheckBox _writeIdsCheck;

    public ExportSettings Result { get; } = new();

    public ExportSettingsForm()
    {
        Text = L.ExportSettingsTitle;
        Size = new Size(520, 620);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;

        var y = 15;

        // ── Output folder ──
        var folderLabel = new Label
        {
            Text = L.SelectOutputFolder,
            Font = new Font("Segoe UI", 10, FontStyle.Bold),
            Location = new Point(15, y),
            AutoSize = true,
        };
        y += 28;

        _pathBox = new TextBox
        {
            Location = new Point(15, y),
            Size = new Size(380, 28),
            Font = new Font("Segoe UI", 9),
            Text = UserSettings.LastExportPath ?? "",
        };

        var browseBtn = new Button
        {
            Text = L.Browse,
            Location = new Point(400, y - 1),
            Size = new Size(85, 28),
        };
        browseBtn.Click += (_, _) =>
        {
            using var dlg = new SaveFileDialog
            {
                Filter = L.BimDownFileFilter,
                DefaultExt = ".zip",
                FileName = Path.GetFileName(_pathBox.Text),
                InitialDirectory = Path.GetDirectoryName(_pathBox.Text) ?? "",
            };
            if (dlg.ShowDialog() == DialogResult.OK)
                _pathBox.Text = dlg.FileName;
        };
        y += 38;

        // ── Category selection ──
        var catLabel = new Label
        {
            Text = L.CategorySelection,
            Font = new Font("Segoe UI", 10, FontStyle.Bold),
            Location = new Point(15, y),
            AutoSize = true,
        };
        y += 25;

        // Select all / deselect all
        var selectAllBtn = new LinkLabel
        {
            Text = L.SelectAll,
            Font = new Font("Segoe UI", 9),
            Location = new Point(15, y),
            AutoSize = true,
        };
        selectAllBtn.LinkClicked += (_, _) => SetAllChecked(true);

        var deselectAllBtn = new LinkLabel
        {
            Text = L.DeselectAll,
            Font = new Font("Segoe UI", 9),
            Location = new Point(90, y),
            AutoSize = true,
        };
        deselectAllBtn.LinkClicked += (_, _) => SetAllChecked(false);
        y += 22;

        _categoryList = new CheckedListBox
        {
            Location = new Point(15, y),
            Size = new Size(475, 300),
            Font = new Font("Segoe UI", 9),
            CheckOnClick = true,
            BorderStyle = BorderStyle.FixedSingle,
        };

        // Load saved selections (default: all enabled)
        var savedTables = UserSettings.GetList("EnabledTables");
        var allEnabled = savedTables is null || savedTables.Count == 0;

        string? lastGroup = null;
        foreach (var cat in AllCategories)
        {
            // Add group header
            if (cat.Group != lastGroup)
            {
                lastGroup = cat.Group;
                _categoryList.Items.Add($"── {cat.Group} ──");
                // Don't check group headers
                _categoryList.SetItemChecked(_categoryList.Items.Count - 1, false);
            }

            var display = $"    {cat.DisplayName}";
            _categoryList.Items.Add(display);
            var isChecked = allEnabled || savedTables!.Contains(cat.TableName);
            _categoryList.SetItemChecked(_categoryList.Items.Count - 1, isChecked);
        }

        // Prevent checking group headers
        _categoryList.ItemCheck += (_, e) =>
        {
            var text = _categoryList.Items[e.Index]?.ToString() ?? "";
            if (text.StartsWith("──"))
                e.NewValue = e.CurrentValue;
        };
        y += 308;

        // ── Options ──
        _meshCheck = new CheckBox
        {
            Text = L.OptionExportMesh,
            Font = new Font("Segoe UI", 9),
            Location = new Point(15, y),
            Size = new Size(475, 22),
            Checked = UserSettings.GetBool("ExportMesh", true),
        };
        y += 26;

        _writeIdsCheck = new CheckBox
        {
            Text = L.OptionWriteIds,
            Font = new Font("Segoe UI", 9),
            Location = new Point(15, y),
            Size = new Size(475, 22),
            Checked = UserSettings.GetBool("WriteIdsToModel", true),
        };
        y += 35;

        // ── Buttons ──
        var exportBtn = new Button
        {
            Text = L.Export,
            Font = new Font("Segoe UI", 11),
            Size = new Size(120, 40),
            Location = new Point(260, y),
            BackColor = Color.FromArgb(0, 120, 212),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
        };
        exportBtn.FlatAppearance.BorderSize = 0;
        exportBtn.Click += OnExportClick;

        var cancelBtn = new Button
        {
            Text = L.Cancel,
            Font = new Font("Segoe UI", 11),
            Size = new Size(100, 40),
            Location = new Point(390, y),
            FlatStyle = FlatStyle.Flat,
        };
        cancelBtn.Click += (_, _) => Close();

        Controls.AddRange([folderLabel, _pathBox, browseBtn, catLabel, selectAllBtn, deselectAllBtn,
            _categoryList, _meshCheck, _writeIdsCheck, exportBtn, cancelBtn]);
    }

    void SetAllChecked(bool check)
    {
        for (var i = 0; i < _categoryList.Items.Count; i++)
        {
            var text = _categoryList.Items[i]?.ToString() ?? "";
            if (!text.StartsWith("──"))
                _categoryList.SetItemChecked(i, check);
        }
    }

    void OnExportClick(object? sender, EventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_pathBox.Text))
        {
            MessageBox.Show(L.S("Please select an output file.", "请选择输出文件。"),
                L.ExportSettingsTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        Result.OutputFile = _pathBox.Text;
        Result.ExportMesh = _meshCheck.Checked;
        Result.WriteIdsToModel = _writeIdsCheck.Checked;

        // Map checked items back to table names
        var catIndex = 0;
        for (var i = 0; i < _categoryList.Items.Count; i++)
        {
            var text = _categoryList.Items[i]?.ToString() ?? "";
            if (text.StartsWith("──")) continue;

            if (_categoryList.GetItemChecked(i) && catIndex < AllCategories.Length)
                Result.EnabledTables.Add(AllCategories[catIndex].TableName);

            catIndex++;
        }

        // Save to user settings
        UserSettings.LastExportPath = Result.OutputFile;
        UserSettings.SetList("EnabledTables", [.. Result.EnabledTables]);
        UserSettings.SetBool("ExportMesh", Result.ExportMesh);
        UserSettings.SetBool("WriteIdsToModel", Result.WriteIdsToModel);

        Result.Confirmed = true;
        Close();
    }
}
