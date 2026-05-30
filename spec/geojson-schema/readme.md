# BimDown GeoJSON Spec

GeoJSON is one of **two interchangeable geometry storage layers** for BimDown — the other is [SVG](../svg-schema/readme.md). Both are first-class and fully supported; a project picks one, declared by `format_version` (see §9). GeoJSON (`format_version: 2`) is the **default for new projects** and the encoding the BimClaw editor consumes. It was chosen as the default after empirical testing on Gemini 3 Flash: it produces equivalent or better AI generation/edit quality at lower token cost, has native 3D support, and integrates with the GIS toolchain (turf.js, DuckDB spatial). The SVG encoding (`format_version: 1`) remains fully supported for 2D projects and for tools with existing SVG pipelines.

GeoJSON files are **not** used for visualization — they are a structured geometry storage format. The editor and renderers consume the parsed canonical element model, not raw GeoJSON.

---

## 1. File Organization

GeoJSON files are co-located with their CSV counterparts, organized by level:

```text
{project-id}/
  {level}/
    wall.csv        wall.geojson
    column.csv      column.geojson
    slab.csv        slab.geojson
    door.csv                          # no geometry file (hosted)
    window.csv                        # no geometry file (hosted)
    space.csv                         # no geometry file (seed point in CSV)
    ...
  global/
    level.csv       grid.csv          # global reference, CSV only
    wall.geojson                      # multi-story walls
    curtain_wall.geojson
    pipe.geojson                      # vertical pipe risers
    ...
```

Each `.geojson` file is a single `FeatureCollection` whose `features[]` contains one Feature per element row in the paired CSV.

### Partitioning Rules

All elements belong to a **base level**, and **`base_level_id` is always the level of the containing directory** — never cross-directory. To express cross-level geometry:

- Element confined to its base level (single-story wall, slab on one level): goes in that level directory.
- Element extending more than one level above its base (multi-story wall, vertical pipe riser): goes in `global/`.
- `level.csv` and `grid.csv`: global reference data, always in `global/`.

Consequence: when parsing or editing a single level view, agents and tools only need to load **two directories** — the current level and `global/`.

### Elements Without Geometry File

These element types have no `.geojson` file; their geometry is fully expressed in CSV:

| Element | Reason |
|---|---|
| `door`, `window`, wall `opening` | Hosted on wall (CSV: `host_id` + `position` along host) |
| `space` | Seed point `(x, y, z)` in CSV; boundary auto-derived by `build` |
| `level`, `grid` | Global reference data with coordinates in CSV |
| `mesh` | Geometry is the referenced GLB file |

---

## 2. Coordinate System

- **Units**: meters
- **Origin**: project Cartesian origin `(0, 0, 0)`
- **Axes**: `+X` = East, `+Y` = North, `+Z` = Up (architectural convention)
- **Coordinate dimension**: 2D `[x, y]` or 3D `[x, y, z]` — element-dependent (see §4)
- **CRS**: BimDown coordinates are project-local, **not** geographic. Do not emit a `crs` member; per GeoJSON RFC 7946 the absence implies WGS84, but readers must treat BimDown coordinates as local Cartesian. Parsers can rely on `project_metadata.json` `units: "m"` to disambiguate.

---

## 3. GeoJSON Subset

### Allowed Geometry Types

| GeoJSON type | BimDown usage |
|---|---|
| `Point` | Point elements (column, equipment, terminal, mep_node) |
| `LineString` | Line elements (wall, beam, duct, stair, ramp, …) — always exactly 2 coordinates in canonical form |
| `Polygon` | Polygon elements (slab, ceiling, roof, slab opening) — single outer ring, optional inner rings for holes |

`MultiPoint`, `MultiLineString`, `MultiPolygon`, `GeometryCollection` are **forbidden in canonical (build-output) form**. An element with disconnected sub-geometries must be split into multiple Features with suffixed IDs (`sl-18ba`, `sl-18bb`).

AI may submit any geometry type as input; build normalizes to canonical (see §6).

### Feature Shape

Every Feature **must** have:
- `properties.id` matching the paired CSV row's `id` field
- a non-null `geometry`

```jsonc
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "id": "w-1" /*, …optional geometry hints… */ },
      "geometry": { "type": "LineString", "coordinates": [[0, 0], [5, 0]] }
    }
  ]
}
```

### Forbidden in Canonical Form

- `MultiPolygon` / `MultiLineString` / `MultiPoint` / `GeometryCollection`
- Properties unrelated to geometry (use CSV for attributes; see §5)
- `bbox` member (computed by hydrate, not stored)
- `crs` member

---

## 4. Z-Axis Handling

LLM spatial arithmetic is unreliable. BimDown therefore encodes Z **semantically** (by level reference) for level-anchored elements, and only uses **absolute Z in coordinates** when the element genuinely lives in free 3D space.

### 4.1 Level-Anchored Elements → 2D Coordinates + Level Properties

Walls, columns, slabs, ceilings, roofs, curtain walls, room separators, and any element whose Z is defined relative to a floor level.

- `geometry.coordinates` are 2D `[x, y]`
- Numeric Z lives in GeoJSON `properties` (default values mean it can be omitted entirely):
  - `base_offset` (float, meters, default `0`) — vertical offset from `base_level_id`
  - `top_offset` (float, meters, default `0`) — vertical offset from `top_level_id`
- Level references (FKs) live in **CSV**, consistent with all other FKs (`host_id`, etc.) and supporting tabular queries like "walls spanning lv-1 → lv-3":
  - `base_level_id` — defaults to the containing directory's level (implicit for level-N/, must be set explicitly in `global/`)
  - `top_level_id` — defaults to the level immediately above `base_level_id`

Result: changing a level's elevation in `level.csv` automatically updates every anchored element's Z without touching geometry files; "all elements spanning lv-2 to lv-4" is a CSV column filter.

```jsonc
// canonical: single-story wall on lv-1, full height
{
  "type": "Feature",
  "properties": { "id": "w-1" },
  "geometry": { "type": "LineString", "coordinates": [[0, 0], [5, 0]] }
}
// base_level_id is implicit (lv-1 from directory); top_level_id default = lv-2;
// base_offset = 0; top_offset = 0.
```

```jsonc
// canonical: column on lv-1, base 0.1m above slab, top -0.05m below lv-2 ceiling
{
  "type": "Feature",
  "properties": {
    "id": "c-3",
    "base_offset": 0.1,
    "top_offset": -0.05,
    "section": { "shape": "rect", "size_x": 0.4, "size_y": 0.4, "rotation": 0 }
  },
  "geometry": { "type": "Point", "coordinates": [2.0, 2.0] }
}
```

### 4.2 Spatial Elements → 3D Coordinates

Beams, braces, stairs, ramps, railings, ducts, pipes, cable trays, conduits — elements whose endpoint Z is genuinely 3D design input rather than "as tall as the floor".

- `geometry.coordinates` are 3D `[x, y, z]`
- Z is **absolute** in project coordinates (meters)
- `base_level_id` is still implicit from the containing directory (used for partitioning and queries, not for geometry)
- Spatial elements should be placed in the level directory they primarily belong to. Only elements that genuinely span multiple levels (e.g. a vertical pipe riser) go in `global/`.

```jsonc
// canonical: beam on lv-2, slightly sloped
{
  "type": "Feature",
  "properties": { "id": "bm-7" },
  "geometry": { "type": "LineString", "coordinates": [[0, 0, 3.5], [10, 5, 3.7]] }
}
```

### 4.3 Why Two Modes

| Concern | Level-anchored mode | Spatial mode |
|---|---|---|
| LLM arithmetic on level elevations | avoided (no Z in coords) | required (small, scoped) |
| Resilience to level elevation edits | automatic | manual update needed |
| Natural expression for designer/AI | "wall on lv-1" | "duct at z=3.7m" |
| Suits | wall, column, slab, ceiling, roof, curtain_wall | beam, brace, stair, ramp, duct, pipe, etc. |

---

## 5. Attribute Split: CSV vs `properties`

Empirical testing showed CSV-for-attributes / file-for-geometry beats both extremes. This spec keeps that split with a strict rule:

| Goes in | What |
|---|---|
| **CSV** | All scalar attributes (material, thickness, function, operation, size_x, size_y, shape, …), enum values, foreign keys (`host_id`, `base_level_id`, `top_level_id`), parametric placement (`position`), `id`, `number` |
| **GeoJSON `properties`** | `id` (link to CSV) + **numeric geometry hints only** — Z offsets (`base_offset`, `top_offset`), curve params (`arc`), point orientation (`rotation`) |
| **Neither (computed)** | `length`, `area`, `height`, `start_x/y/z`, `end_x/y/z`, `x`, `y`, `rotation`, `points`, `volume`, `bbox_*` |

Rationale:
- CSV is dense and tabular — LLMs are strong at column-wise reasoning and bulk edits.
- Per-Feature property bags would repeat keys for every element (1000 walls × all keys), inflating tokens 2-3×.
- Geometry-disambiguating hints are **logically part of the geometry** (you cannot draw a rectangular column without knowing its size), so they belong adjacent to the geometry.

If a future field is unclear, ask: *"does this define what the geometry looks like, or does it describe what the element is?"* The former → properties. The latter → CSV.

---

## 6. AI Input Flexibility & Build Normalization

To accommodate LLMs that prefer one representation over another, BimDown accepts multiple equivalent inputs and normalizes them during `bimdown build`. **The editor and downstream consumers only see canonical form.**

### 6.1 Arc Lines (Walls, Curtain Walls, Ramps, Railings, etc.)

Canonical: 2-point `LineString` + `properties.arc`.

| AI input variant | Build detects | Normalized to |
|---|---|---|
| `LineString` with 2 points, no `arc` property | straight line | unchanged |
| `LineString` with 2 points + `properties.arc = {radius, large_arc, sweep}` | already canonical | unchanged |
| `LineString` with N≥3 points where intermediate points lie on a circle through the endpoints (distance variance < ε) | tessellated arc | 2 endpoints + computed `properties.arc` |
| `LineString` with N≥3 collinear points | redundant polyline | first + last only |

`arc` schema:
```jsonc
"arc": {
  "radius": 3.0,           // meters; sign convention: positive
  "large_arc": false,      // SVG-A semantics; false = arc < 180°
  "sweep": true            // false = counterclockwise from start to end (in +Y-up frame)
}
```

### 6.2 Point Elements with Section Profile (Columns, Equipment, MEP Nodes, Terminals)

Canonical: `Point` geometry; section attributes (`shape`, `size_x`, `size_y`) in **CSV**; orientation in `properties.rotation` if non-zero.

| AI input variant | Build behavior |
|---|---|
| `Point` + CSV `shape/size_x/size_y` | canonical; no rotation written (default `0`) |
| `Point` + `properties.rotation` | canonical; section from CSV |
| `Point` + `properties.section = {shape, size_x, size_y, rotation}` | extract `shape/size_x/size_y` into CSV; keep `rotation` in properties if non-zero; drop `section` bag |
| `Polygon` with 4 vertices, opposite sides parallel and equal | derive `shape="rect"`, `size_x`, `size_y` → CSV; derive `rotation` → properties; reduce geometry to `Point` at centroid |
| `Polygon` with N≥8 vertices, all equidistant from centroid | derive `shape="round"`, `size_x=size_y=2r` → CSV; reduce geometry to `Point` at center |
| `Point`, no `section`, CSV section empty | reject with validation error |

`rotation` in `properties`:
```jsonc
"rotation": 30   // degrees, CCW about +Z axis, applied to the local section frame
```

### 6.3 Polygons (Slabs, Ceilings, Roofs, Slab Openings)

Canonical: `Polygon` with a closed outer ring (last coord = first coord), optional holes as inner rings.

| AI input variant | Build behavior |
|---|---|
| Unclosed ring (last coord ≠ first coord) | auto-close |
| Counterclockwise outer ring | rewind to clockwise (RFC 7946 §3.1.6 right-hand rule applied flipped for screen Y; build canonicalizes to **clockwise** in BimDown frame) |
| Self-intersecting ring | reject with validation error |
| `MultiPolygon` (disconnected) | split into multiple Features with suffix IDs (`sl-18ba`, `sl-18bb`); CSV row is duplicated |
| 3D coords on level-anchored polygon (all Z equal) | drop Z; if any vary, reject with error |

### 6.4 Z-Axis Variants

| AI input | Build behavior |
|---|---|
| Level-anchored element with 2D coords | canonical |
| Level-anchored element with 3D coords (Z varies) | reject |
| Level-anchored element with 3D coords (Z constant) | drop Z; if Z != `base_level.elevation + base_offset`, recompute `base_offset` |
| Spatial element with 2D coords | reject (need Z); CLI suggests inferring from `base_level.elevation` |
| Spatial element with 3D coords | canonical |
| Element with `properties.base_offset` referring to non-containing-directory level | reject (`base_level_id` is structural, not data) |

### 6.5 Other Normalizations (Inherited from Existing CLI)

- **Snap endpoints**: cluster nearby endpoints within tolerance `max(0.10m, max wall thickness)`. Works across `current_level/` and `global/` (the two-directory rule).
- **Resolve hosted coords**: door/window/opening `position` validated against host wall length.
- **Resolve MEP topology**: detect coincident curve endpoints, materialize `mep_node` entries, back-fill `from`/`to` (port refs `host_id:port_name`).
- **Compute space boundaries**: half-edge face tracing from walls + curtain_walls + room_separators + structure_walls; emit `space.geojson` with `Polygon` features. (Space CSV is source of truth for seed points; the generated `.geojson` is a build artifact.)
- **Auto-heal CSV ↔ geometry conflict**: if a CSV `required` field disagrees with hydrated geometry, CSV wins and geometry is corrected on next sync-out.

---

## 7. Canonical Forms by Element Type

| Element | Geometry | Mandatory properties | Optional properties |
|---|---|---|---|
| `wall`, `curtain_wall`, `room_separator` | `LineString` 2D, 2 points | — | `base_offset`, `top_offset`, `arc` |
| `stair`, `ramp`, `railing` | `LineString` 3D, 2 points | — | `arc` |
| `beam`, `brace` | `LineString` 3D, 2 points | — | `arc` |
| `duct`, `pipe`, `cable_tray`, `conduit` | `LineString` 3D, 2 points | — | — |
| `column`, `structure_column` | `Point` 2D | — | `base_offset`, `top_offset`, `rotation` |
| `equipment`, `terminal`, `mep_node` | `Point` 3D | — | `rotation` |
| `slab`, `ceiling`, `roof`, `structure_slab` | `Polygon` 2D, closed CW | — | `base_offset` |
| `slab_opening` (opening with slab host) | `Polygon` 2D, closed CW | — | — |
| `foundation` | `Point` 2D / `LineString` 2D / `Polygon` 2D (form chooses) | — | `base_offset`, `top_offset`, `rotation` (if point) |

Notes:
- `point_element` mixin computed fields (`x`, `y`, `rotation`) are hydrated from geometry + `properties.section.rotation`.
- `line_element` and `spatial_line_element` mixin computed fields (`start_x/y[/z]`, `end_x/y[/z]`, `length`) are hydrated from coordinates; arc length is computed from `properties.arc` when present.
- `polygon_element` mixin computed fields (`points`, `area`) are hydrated from coordinates.
- `vertical_span` mixin computed field (`height`) is hydrated as `top_level.elevation + top_offset − base_level.elevation − base_offset`.

---

## 8. Computed Field Hydration

| Computed field | Source |
|---|---|
| `start_x`, `start_y`, `start_z` | first coordinate of `LineString` (Z from coord for spatial, from `base_level.elevation + base_offset` for level-anchored) |
| `end_x`, `end_y`, `end_z` | last coordinate of `LineString` (Z same convention as above) |
| `length` | Euclidean distance along the line; if `properties.arc` present, computed as arc length |
| `x`, `y` | `Point` coordinates (Z from `base_level.elevation + base_offset` for level-anchored) |
| `rotation` | `properties.section.rotation` (default `0`) |
| `points` | flattened `"x1,y1 x2,y2 …"` string of outer ring vertices |
| `area` | shoelace on outer ring minus holes |
| `height` | `top_level.elevation + top_offset − base_level.elevation − base_offset` |
| `volume` | per-type formula (e.g. `area × height` for slabs, `length × thickness × height` for walls — straight only; arcs use polygon area) |
| `bbox_min_*`, `bbox_max_*` | from geometry + extruded height |
| `level_id` | base_level_id (= containing directory) |

---

## 9. Format Version

`project_metadata.json`:

```json
{
  "format_version": 2,
  "project_name": "…",
  "units": "m",
  "source": "revit"
}
```

- `format_version: 1` — CSV + **SVG** (see [svg-schema/readme.md](../svg-schema/readme.md)). Fully supported; 2D geometry.
- `format_version: 2` — CSV + **GeoJSON** (this spec). Fully supported; 2D and 3D geometry. Default for new projects.

Both encodings are maintained; neither is deprecated. Tools may also detect the encoding directly from the geometry files present (`*.geojson` vs `*.svg`). To convert an existing SVG project to GeoJSON (e.g. to gain 3D fidelity for spatial elements), use `bimdown migrate svg-to-geojson <path>` or `scripts/svg-to-geojson.ts`.

---

## 10. Example Files

### `lv-1/wall.csv`
```csv
id,number,thickness,top_level_id,material
w-1,1,0.2,,concrete
w-2,2,0.2,,concrete
w-3,3,0.15,lv-3,gypsum
```
(`w-3` spans lv-1 → lv-3; `top_level_id` empty for `w-1`/`w-2` means default = lv-2.)

### `lv-1/wall.geojson`
```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "id": "w-1" },
      "geometry": { "type": "LineString", "coordinates": [[0,0],[5,0]] } },
    { "type": "Feature", "properties": { "id": "w-2",
        "arc": { "radius": 3, "large_arc": false, "sweep": true } },
      "geometry": { "type": "LineString", "coordinates": [[5,0],[5,6]] } },
    { "type": "Feature", "properties": { "id": "w-3", "top_offset": -0.3 },
      "geometry": { "type": "LineString", "coordinates": [[0,6],[0,0]] } }
  ]
}
```
Note: `w-3` is a 2-level wall, but per partitioning rules it should live in `global/` if it spans more than one level above its base. The example above is illustrative; the validator will warn.

### `lv-2/beam.csv`
```csv
id,number,material,structural_section_profile_shape,size_x,size_y
bm-1,1,steel,i,0.2,0.4
```

### `lv-2/beam.geojson`
```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "id": "bm-1" },
      "geometry": { "type": "LineString", "coordinates": [[0,0,3.5],[10,0,3.5]] } }
  ]
}
```
