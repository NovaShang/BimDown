# BimDown: DuckDB & CLI Integration Strategy

The core challenge of **Agentic AI** in BIM environments:
1. **Generative tasks** need tiny, bounded contexts (a single floor's walls) to avoid hallucination.
2. **Analytical tasks** require cross-building relational views with geometry calculations.

BimDown bridges this via a **CLI tool** wrapping **DuckDB**.

---

## 1. Hydration Phase (Import)

When the Agent needs global context (e.g. executing SQL), the CLI initializes an in-memory DuckDB database.

### A. Union of Partitions

Merges level-specific and global CSV files into single logical tables:
```sql
CREATE TABLE wall AS SELECT * FROM '*/wall.csv';
```

### B. Geometry Injection (Computed Fields)

The CLI parses SVG files and injects geometry as virtual columns:
- `<path>` → `start_x`, `start_y`, `end_x`, `end_y`, `length`
- `<rect>`/`<circle>` → `x`, `y`, `size_x`, `size_y`, `rotation`
- `<polygon>` → `points` (serialized), `area`

Elements without SVG (door, window, space, grid) have their geometry fields directly from CSV — no injection needed.

**Result**: The LLM gets rich tables with spatial data for SQL queries, despite physical CSVs holding only semantic columns.

---

## 2. Execution Phase (Standard SQL)

The LLM is abstracted from the file system:

```sql
-- Change all sliding doors wider than 0.9m on 1F to swing doors
UPDATE door SET operation = 'single_swing'
WHERE width > 0.9 AND level_id = 'lv-1' AND operation = 'sliding';
```

---

## 3. Sync-Out Phase (Dehydration & Auto-Healing)

### A. Stripping Computed Fields

When writing back to physical CSVs, the CLI strips `computed: true` columns. The CSV remains purely semantic.

### B. Auto-Healing

LLMs are mathematically imprecise. When an AI draws a `<path>` for a door opening that measures 0.887m instead of the CSV-declared 0.9m width:

1. The CSV `width = 0.9` is the **source of truth**.
2. The CLI detects the SVG/CSV mismatch.
3. Takes the SVG midpoint as the placement intent.
4. Redraws the SVG symmetrically around that midpoint to match 0.9m.

This creates a resilient **twin-engine**:
- **CSV** enforces semantic truth (widths, materials, types).
- **SVG** enforces spatial intent (where things are placed).
- **CLI** keeps them in sync.

---

## 4. Resolve-Topology (MEP Connectivity)

AI designs MEP networks by placing duct/pipe segments with endpoint coordinates. The CLI provides a `resolve-topology` command that:

1. Collects all MEP segment endpoints and equipment/terminal positions.
2. Detects coincident coordinates (within tolerance).
3. Auto-generates `mep_node` entries at pure junction points (where no equipment/terminal exists).
4. Back-fills `from` and `to` on each duct/pipe/cable_tray/conduit. Values are port refs of the form `host_id:port_name` (or bare `host_id` for passive fittings). See [`mep-port-conventions.md`](mep-port-conventions.md).

After resolution, DuckDB graph queries work naturally:
```sql
-- Find all ducts connected to equipment eq-1 (any port)
SELECT d.* FROM duct d
WHERE d.from = 'eq-1' OR d.to = 'eq-1'
   OR d.from LIKE 'eq-1:%' OR d.to LIKE 'eq-1:%';
```

---

## 5. Partitioning (Sync-Out)

When writing back to the filesystem, the CLI re-partitions by level:

- Elements with `vertical_span` where `top_level_id` is **more than one level above** base → `global/`
- All other elements → `{level_id}/`
- `level.csv`, `grid.csv` → always `global/`
