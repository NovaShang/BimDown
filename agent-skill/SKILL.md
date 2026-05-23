---
name: bimdown
version: 2.0.0
description: A bridge between AI and building data. Read & create BIM exactly like writing code. Execute architectural design, or just model your own house!
metadata:
  {
    "openclaw": {
      "emoji": "🏛️",
      "requires": {
        "bins": ["bimdown"],
        "install": { "npm": "bimdown-cli" }
      },
      "optionalEnv": ["BIMCLAW_API"],
      "network": {
        "publish": {
          "endpoint": "https://bim-claw.com/api/shares/publish",
          "method": "POST",
          "description": "Optional sharing step. Uploads project CSV/GeoJSON/GLB files as a zip to BimClaw and returns a public share URL. Anonymous (no account or token required). The agent MUST ask the user for explicit permission before the first publish of any given project.",
          "override": "Set BIMCLAW_API to point at a different backend (self-hosted)."
        }
      }
    }
  }
---

# BimDown Agent Skill & Schema Rules

> **Your Mission:** A bridge between AI agents and building data. Use this skill to read, understand, and create Building Information Models (BIM) exactly like reading and writing code.

## Setup / Prerequisites

This skill **REQUIRES** the `bimdown` binary (provided by the `bimdown-cli` npm package).

1. **Check first**: Run `which bimdown` (or `bimdown --version`). If it exists, skip the install step.
2. **If missing**: Install via npm — ask the user for permission before running `npm install -g`.

```bash
npm install -g bimdown-cli
```

You are an AI Coder operating within a BimDown project environment.
BimDown is an open-source, AI-native building data format using **CSV for attributes** and **GeoJSON for geometry**.

## Core Architecture

- **Units are project-declared** — read `project_metadata.json::units` (`m` / `ft` / `in` / `mm`; defaults to `m` when absent). See the [Units](#units) section below. Every coordinate and dimension in CSV / GeoJSON is in that unit — there is no internal canonical conversion.
- **CSV holds attributes** (material, thickness, sizes, FKs, enums). **GeoJSON holds geometry** (Point / LineString / Polygon) plus optional numeric hints (`base_offset`, `top_offset`, `arc`, `rotation`).
- **Computed fields are READ-ONLY**: `length`, `area`, `height`, `start_x/y/z`, `end_x/y/z`, `x`, `y`, `rotation`, `points`, `volume`, `bbox_*`, `level_id`. Never write them anywhere — the CLI hydrates them at query time.
- **The `id` field links CSV row ↔ GeoJSON `properties.id`** for each element.
- **`format_version: 2`** in `project_metadata.json`. Legacy SVG projects (v1) must be migrated first via the `svg-to-geojson` script.

## Project Directory Structure

```
project/
  project_metadata.json     # { "format_version": 2, "units": "m", ... }
  global/                   # cross-floor reference + multi-level geometry
    level.csv               # floor elevations (Z source of truth)
    grid.csv                # structural grid lines (inline coords)
    wall.geojson + wall.csv # multi-story walls
    pipe.geojson + pipe.csv # vertical risers
    ...
  lv-1/                     # per-level element files
    wall.csv + wall.geojson
    column.csv + column.geojson
    slab.csv + slab.geojson
    door.csv                # hosted: CSV only (host_id + position)
    window.csv              # hosted: CSV only
    space.csv               # seed point only (boundary auto-generated)
    ...
  lv-2/
    ...
```

**Key partition rules**:
- An element's `base_level_id` is **always** the containing directory's level. To express a multi-level element (e.g. a wall spanning lv-1 → lv-3), place it in `global/`.
- Spatial elements (beam, ramp, duct, pipe…) live in the level they primarily belong to. Only true cross-level instances (vertical risers, multi-flight stairs) go in `global/`.

## Units

BimDown is **store-as-displayed**: every coordinate, length, thickness, position, and offset in every CSV / GeoJSON file is written in the unit declared by `project_metadata.json::units`. There is no internal canonical unit and no implicit conversion.

**File-level invariant** — once a project declares `"units": "ft"`, every `0.3` you read or write is 0.3 feet. The same number in a `"units": "m"` project is 0.3 meters.

**Before writing or editing any numeric value, read `project_metadata.json` and note the unit.** All the "typical values" tables below assume meters; multiply by the appropriate factor when working in another unit (e.g. a 0.15 m partition wall is ~0.49 ft, ~5.9 in, ~150 mm).

**Allowed values** (enum):

| Value | Meaning | Notes |
|---|---|---|
| `m` | meter | default when field is missing — preserves all pre-units projects |
| `ft` | foot (decimal) | imperial, decimal — `1.25` means 1.25 ft, not 1'-3" |
| `in` | inch | imperial small-scale |
| `mm` | millimeter | metric small-scale (typical in Asia/EU construction docs) |

**Do not convert existing data when changing the unit field.** Switching `units` without converting the numeric payload changes the physical meaning of the project. A separate `bimdown convert --to <unit>` workflow (future) is the only correct way to re-scale.

## Z-Axis Handling (Important — read carefully)

Two modes depending on the element type:

### Level-anchored elements (wall, column, slab, ceiling, roof, curtain_wall, room_separator)

- GeoJSON `geometry.coordinates` are **2D** `[x, y]` — no Z.
- `base_level_id`, `top_level_id` in **CSV** (FKs). Defaults: base = directory level; top = level immediately above base.
- Numeric Z offsets (optional, default 0) in **GeoJSON `properties`**: `base_offset`, `top_offset`.
- This means: changing a level's elevation in `level.csv` auto-updates every anchored element. AI never does arithmetic on level elevations.

### Spatial elements (beam, brace, stair, ramp, railing, duct, pipe, cable_tray, conduit, equipment, terminal, mep_node)

- GeoJSON `geometry.coordinates` are **3D** `[x, y, z]` (absolute Z in meters).
- `base_level_id` (CSV) is still recorded for partitioning, but geometry is self-contained in 3D.

## GeoJSON Geometry Reference

Every Feature has `properties.id` matching the paired CSV row.

### Canonical forms

```jsonc
// Straight wall (level-anchored, 2D)
{
  "type": "Feature",
  "properties": { "id": "w-1" },
  "geometry": { "type": "LineString", "coordinates": [[0, 0], [5, 0]] }
}

// Curved wall: 2 endpoints + arc properties
{
  "type": "Feature",
  "properties": { "id": "w-2", "arc": { "radius": 3, "large_arc": false, "sweep": true } },
  "geometry": { "type": "LineString", "coordinates": [[5, 0], [5, 6]] }
}

// Column (level-anchored Point; section attrs live in CSV)
{
  "type": "Feature",
  "properties": { "id": "c-1" },
  "geometry": { "type": "Point", "coordinates": [2, 2] }
}

// Beam (spatial 3D LineString)
{
  "type": "Feature",
  "properties": { "id": "bm-1" },
  "geometry": { "type": "LineString", "coordinates": [[0, 0, 3.5], [10, 5, 3.7]] }
}

// Slab (2D Polygon, closed ring; CSV has thickness, material)
{
  "type": "Feature",
  "properties": { "id": "sl-1" },
  "geometry": { "type": "Polygon", "coordinates": [[[0,0],[10,0],[10,8],[0,8],[0,0]]] }
}
```

**Disconnected polygons — no `MultiPolygon`**: When a split produces multiple disconnected pieces (typical: slicing an L-shaped slab through its notch), emit them as **separate Features with suffixed ids** (`sl-18a`, `sl-18b`, …), each a single `Polygon`. `MultiPolygon` / `MultiLineString` / `MultiPoint` / `GeometryCollection` are not allowed in canonical form. The `bimdown-cli` library's `writeBimDownGeometry` does this automatically when JSTS operations return Multi* results — if you write geometry through it, you don't have to think about the rule.

### AI input flexibility (build normalizes everything)

You can write any of these equivalent forms; `bimdown build` normalizes to canonical:

| Variant you write | Build action |
|---|---|
| Arc wall as tessellated polyline (`LineString` with N≥3 points on a circle) | Detects arc → emits 2-point LineString + `properties.arc` |
| Rectangular column as 4-vertex Polygon | Extracts `shape/size_x/size_y` to CSV, `rotation` to properties; geometry → Point at centroid |
| Round column as regular polygon approximation (N≥8 vertices on a circle) | Extracts `shape="round"`, sizes; geometry → Point at center |
| Unclosed Polygon ring | Auto-closes |
| 3D coordinates on a level-anchored element with constant Z | Drops Z; if `Z != base_level.elevation + base_offset`, recomputes `base_offset` |

## Recommended Workflow

1. **Plan spatial layout first**: reason through wall positions, room adjacencies, openings.
2. **Write GeoJSON geometry**: create `*.geojson` Feature collections with correct coordinates.
3. **Write CSV attributes**: element properties (material, thickness, size_x/y, …). Never include computed fields.
4. **Render and visually verify**: `bimdown render <dir> -l lv-1 -o render.png` and view the PNG. Save renders **outside** the project directory.
5. **Build**: `bimdown build <dir>` — validates schema, snaps endpoints, normalizes geometry, computes space boundaries.
6. **Iterate** until the render looks right.

## CLI Tools

1. **`bimdown query <dir> <sql> [--json]`** — DuckDB SQL across all tables, including hydrated geometry fields.
   - Example: `bimdown query ./proj "SELECT id, length FROM wall WHERE length > 5"`
2. **`bimdown render <dir> [-l level] [-o out.png] [-w width]`** — render a level as PNG/SVG image.
3. **`bimdown build <dir>`** — validate + snap endpoints + normalize geometry + compute space boundaries. Run after every edit.
4. **`bimdown schema [table]`** — print the full schema for a table.
5. **`bimdown diff <dirA> <dirB>`** — diff two projects.
6. **`bimdown init <dir>`** — create a new empty project (`format_version: 2`).
7. **`bimdown publish <dir>`** — upload to BimClaw and get a share URL (network step; **ask user first**).
8. **`bimdown info <dir>`** — element counts per level.
9. **`bimdown resolve-topology <dir>`** — auto-resolve MEP curve connectivity.
10. **`bimdown merge <dirs...> -o <out>`** — merge projects.
11. **`bimdown sync <dir>`** — hydrate to DuckDB then dehydrate to files (applies normalization).

## Publishing & Data Upload

`bimdown publish` is the **only** network command. Before running:

- **Destination**: `https://bim-claw.com/api/shares/publish` (override with `--api` or `BIMCLAW_API`).
- **Uploaded**: the entire project zipped — every CSV, every GeoJSON, any GLB files, `project_metadata.json`.
- **Anonymous**: no account; the server returns a random share token. Anyone with the link can view/download until expiry (default 7 days).
- **Consent**: Ask the user for explicit permission before the first publish of a project.

## Critical Rules

- **ID format**: `{prefix}-{n}` (digits only) for most elements; `lv-{any}` / `gr-{any}` for level/grid.
- **GeoJSON coordinate system**: project-local meters, `+X=East`, `+Y=North`, `+Z=Up`. **No `crs` member**, **no `scale(1,-1)` flip** — GeoJSON uses native Y-up by convention.
- **CSV vs computed**: write only non-computed CSV fields. Never include `length`, `area`, `start_x/y/z`, `end_x/y/z`, `x`, `y`, `rotation`, `points`, `height`, `volume`, `bbox_*`, `level_id`.
- **GeoJSON properties vs CSV**:
  - `id` — both (matched by string equality).
  - `base_offset`, `top_offset`, `arc`, `rotation`, `height_offset` (ceiling) — **GeoJSON `properties`** only.
  - `base_level_id`, `top_level_id`, `host_id`, `position`, all material/size/enum attrs — **CSV** only.

## Generation Tips

### Typical values (meters — scale to project's `units`)
| Element | Field | Range |
|---|---|---|
| Wall (partition) | thickness | 0.1 – 0.15 |
| Wall (exterior) | thickness | 0.2 – 0.3 |
| Wall (structural) | thickness | 0.3 – 0.6 |
| Door (single) | width × height | 0.9 × 2.1 |
| Door (double) | width × height | 1.8 × 2.1 |
| Window | width × height | 1.2–1.8 × 1.5 |
| Window sill | `properties.base_offset` | 0.9 (standard), 0 (floor-to-ceiling) |
| Column | size_x × size_y | 0.3–0.6 × 0.3–0.6 |
| Slab | thickness | 0.15 – 0.25 |
| Level spacing | elevation Δ | 3.0 – 4.0 |

### Room boundary connectivity
For room boundaries to close cleanly (so `build` can compute spaces):
- Line-element endpoints must meet at shared coordinates (build snaps within 10cm).
- `bimdown build` warns about unconnected endpoints and computes faces from closed loops.

### Door / window placement
Doors and windows are hosted on walls and have **no GeoJSON file** — only CSV with `host_id` + `position` (distance in meters from wall start to opening center).

```csv
id,host_id,position,width,height,operation,material
d-1,w-3,1.5,0.9,2.1,single_swing,wood
```

Validation rules:
- `position - width/2 >= 0` and `position + width/2 <= wall_length`
- Multiple openings on the same wall must not overlap

### GeoJSON file template
```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "id": "w-1" },
      "geometry": { "type": "LineString", "coordinates": [[0,0],[5,0]] } }
  ]
}
```

## Base Schema Reference

All elements inherit from `element`:
- **CSV**: `id` (required), `number`, `mesh_file`.
- **GeoJSON properties**: `base_offset` (default 0).
- **Computed**: `level_id`, `volume`, `bbox_*`.

**Geometry bases** (computed-only):
- `line_element` (wall, beam, …): `start_x`, `start_y`, `end_x`, `end_y`, `length`.
- `spatial_line_element` (beam, duct, …): adds `start_z`, `end_z`.
- `point_element` (column, equipment, …): `x`, `y`, `rotation`.
- `polygon_element` (slab, roof, …): `points`, `area`.

**Vertical span** (`vertical_span`):
- **CSV**: `base_level_id`, `top_level_id`.
- **GeoJSON properties**: `top_offset` (default 0).
- **Computed**: `height`.

**Hosted** (`hosted_element`): `host_id`, `position` — both in CSV. No GeoJSON file.

**Material enum**: concrete, steel, wood, clt, glass, aluminum, brick, stone, gypsum, insulation, copper, pvc, ceramic, fiber_cement, composite.

## Available Tables

`beam`, `brace`, `cable_tray`, `ceiling`, `column`, `conduit`, `curtain_wall`, `door`, `duct`, `equipment`, `foundation`, `grid`, `level`, `mep_node`, `mesh`, `opening`, `pipe`, `railing`, `ramp`, `roof`, `room_separator`, `slab`, `space`, `stair`, `structure_column`, `structure_slab`, `structure_wall`, `terminal`, `wall`, `window`.

If the user asks about a table not covered above, run `bimdown schema <table_name>` for its full schema.

## Reference SOPs

**Before writing files, READ the matching SOP**:
- **Designing a building from a brief** → [`references/building-design.md`](./references/building-design.md)
- **Modeling from existing plans / drawings** → [`references/bim-modeling.md`](./references/bim-modeling.md)

## Additional Resources

For more detail or Revit round-trip tooling, see the official repository:
**[https://github.com/NovaShang/BimDown](https://github.com/NovaShang/BimDown)**
