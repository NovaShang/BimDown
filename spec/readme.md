# BimDown Spec

This directory defines the **BimDown data format** — a "Minimum Viable Building" representation optimized for AI-native building design and bidirectional sync with BIM tools (Revit).

BimDown uses **CSV for attributes** and a **geometry layer** that may be encoded as either **SVG** or **GeoJSON** — both human-readable and AI-friendly. The two encodings are interchangeable and fully supported; a project declares which it uses via `format_version` (`1` = SVG, `2` = GeoJSON). GeoJSON adds 2D **and** 3D coordinates and is the default for new projects; SVG is 2D-only and was the original encoding. A CLI tool with DuckDB provides relational query and auto-sync capabilities over either.

> Geometry storage specs (canonical forms, AI input flexibility, build-time normalization):
> - **[geojson-schema/readme.md](geojson-schema/readme.md)** — GeoJSON encoding (`format_version: 2`, default)
> - **[svg-schema/readme.md](svg-schema/readme.md)** — SVG encoding (`format_version: 1`)
>
> The CSV attribute layer below is identical for both encodings.

---

## Project Structure

```text
{project-id}/
├── project_metadata.json            # format_version, project name, units, source
├── global/
│   ├── level.csv                    # floor level definitions (with elevations)
│   ├── grid.csv                     # structural grid lines
│   ├── wall_type.csv, door_type.csv, …, type_layer.csv   # element types (optional)
│   ├── view.csv                     # saved section views (optional)
│   ├── wall.csv / wall.geojson      # multi-story walls (span > 1 level above)
│   ├── stair.csv / stair.geojson    # multi-story stairs
│   ├── pipe.csv / pipe.geojson      # vertical risers
│   └── ...                          # any element genuinely spanning > 1 level
├── 1F/
│   ├── wall.csv / wall.geojson
│   ├── column.csv / column.geojson
│   ├── slab.csv / slab.geojson
│   ├── door.csv                     # no geometry file (hosted)
│   ├── window.csv                   # no geometry file (hosted)
│   ├── space.csv                    # no geometry file (seed point in CSV)
│   └── ...
├── 2F/
│   └── ...
├── underlays/                       # optional: tracing references (png/jpg/webp/pdf/dxf), see global/underlay.csv
├── _IdMap.csv                       # UUID ↔ short ID mapping (Revit round-trip)
└── LICENSE.txt                      # optional licence / attribution note (also README, NOTICE, CREDITS; .txt/.md)
```

> The geometry files above are shown as `.geojson` (`format_version: 2`). In an SVG project (`format_version: 1`) the same elements use `.svg` files instead (`wall.svg`, `column.svg`, …); CSV files are unchanged. See [svg-schema/readme.md](svg-schema/readme.md).

---

## Partitioning Rules (Level vs Global)

All elements belong to a **base level** (their `base_level_id`).

- **`base_level_id` always equals the containing directory's level** — no cross-directory references. To express a multi-level element, place it in `global/`.
- **Level directory** (e.g. `1F/`, `2F/`): elements whose vertical extent stays within one level above their base.
- **Global directory** (`global/`): elements that span **more than one level above** their base (multi-story walls, vertical pipe risers, etc.), plus `level.csv`, `grid.csv` and `view.csv`.
- **Spatial elements** (beams, ramps, ducts, etc.) should be placed in the level directory they primarily belong to. Only truly cross-level instances go in `global/`.

Consequence: editing or rendering one level view requires loading at most **two directories** — the current level and `global/`.

---

## Schema Overview

The **GeoJSON type** column below maps directly to an SVG element in the SVG encoding: `Point` → `<rect>`/`<circle>`, `LineString` → `<path>`, `Polygon` → `<polygon>`. A `3D LineString` (spatial element) becomes a 2D `<path>` plus `start_z`/`end_z` columns in CSV. See [svg-schema/readme.md §6](svg-schema/readme.md).

### Global Tables

| Table   | Geometry file | Description |
|---------|---------------|-------------|
| `level` | No  | Floor levels by elevation |
| `grid`  | No  | Structural/reference grid lines (inline coords in CSV) |
| `*_type`, `type_layer` | No | Element types and their layers — see [Element Types](#element-types) |
| `view`  | No  | Saved section views: `view_type=section`, plan line `start_*`→`end_*` (looks to its left), optional far-clip `depth` |

### Architecture

| Table            | Geometry         | GeoJSON type | Description |
|------------------|------------------|-----------------|-------------|
| `wall`           | Line             | `LineString` 2D | Architectural wall with thickness and vertical span |
| `column`         | Point            | `Point` 2D | Architectural column with section profile |
| `slab`           | Polygon          | `Polygon` 2D | Floor/roof/finish slab |
| `space`          | Seed point       | (CSV `x`,`y`) | Named space/room (boundary computed by `build` from walls, curtain walls, room separators) |
| `door`           | Hosted on wall   | No geometry file | Door with operation type |
| `window`         | Hosted on wall   | No geometry file | Window with dimensions |
| `opening`        | Hosted           | Conditional | Wall opening (no geometry file) or slab opening (`Polygon`) |
| `stair`          | Spatial line     | `LineString` 3D | Stair run with vertical span |
| `ramp`           | Spatial line     | `LineString` 3D | Accessibility ramp |
| `railing`        | Spatial line     | `LineString` 3D | Railing along path |
| `curtain_wall`   | Line             | `LineString` 2D | Curtain wall with grid parameters |
| `ceiling`        | Polygon          | `Polygon` 2D | Ceiling surface |
| `roof`           | Polygon          | `Polygon` 2D | Roof surface |
| `room_separator` | Line             | `LineString` 2D | Invisible boundary line for room separation |

### Structure

| Table              | Geometry   | GeoJSON type | Description |
|--------------------|------------|-----------------|-------------|
| `structure_wall`   | Line       | `LineString` 2D | Structural wall |
| `structure_column` | Point      | `Point` 2D | Structural column |
| `structure_slab`   | Polygon    | `Polygon` 2D | Structural slab |
| `beam`             | Spatial line | `LineString` 3D | Structural beam |
| `brace`            | Spatial line | `LineString` 3D | Structural brace |
| `foundation`       | Mixed      | `Point`/`LineString`/`Polygon` 2D | Unified foundation (geometry type chooses form) |

### MEP

| Table        | Geometry     | GeoJSON type | Description |
|--------------|--------------|-----------------|-------------|
| `duct`       | Spatial line | `LineString` 3D | HVAC duct (endpoints from connectors) |
| `pipe`       | Spatial line | `LineString` 3D | Plumbing/process pipe |
| `cable_tray` | Spatial line | `LineString` 3D | Electrical cable tray |
| `conduit`    | Spatial line | `LineString` 3D | Electrical conduit |
| `equipment`  | Point        | `Point` 3D | MEP equipment (AHU, chiller, pump...) |
| `terminal`   | Point        | `Point` 3D | MEP terminal (diffuser, outlet...) |
| `mep_node`   | Point        | `Point` 3D | Topology node (fitting/accessory in Revit) |
| `connector`  | None (CSV)   | — | Connection port on equipment/terminal/mep_node — host-local offset + outward direction, cross-section, flow direction, domain. Curves reference it via `from`/`to` (`host_id:name`). CSV-only. |

### Annotation

Plan annotations, CSV only, in level directories only (never `global/`). They reference model elements by id, so they follow edits; see [csv-schema/annotation/](csv-schema/annotation/).

| Table        | Geometry file | Description |
|--------------|---------------|-------------|
| `dimension`  | No (CSV points) | Linear dimension: two measured points, each optionally stuck to an element (`start_ref` / `end_ref`: `w-1`, `w-1:left`, `w-1:end`, `d-1:start`, …), a `direction` (empty = aligned) and an `offset` for the dimension line |
| `text_note`  | No (CSV point) | Free text at `x`,`y` with `size` and `rotation` |
| `tag`        | No (CSV point) | Label of one element (`host_id`): door/window mark, room name + number + area, number/name/type/size; empty `x`,`y` = default spot that follows the host |

### Fallback

| Table  | Geometry file | Description |
|--------|---------------|-------------|
| `mesh` | No (GLB)      | Generic 3D model for elements without parametric schema |

### Underlays (reference drawings)

| Table      | Geometry file | Description |
|------------|---------------|-------------|
| `underlay` | No (file in `underlays/`) | `global/underlay.csv`: an image, PDF page or DXF placed under one level for tracing |

An underlay row places `file` (under `underlays/`) on `level_id`: plan = `(x, y)` + rotate(`rotation`°) · (`scale` · local), where local is image pixels (origin bottom-left), PDF points or DXF drawing units; `scale` is project units per local unit. `opacity`, `visible`, `locked`, `page` (PDF) and `hidden_layers` (DXF, `;`-separated) are display settings. Underlays are not building elements: `build`, `render`, `query` and the exports ignore them; `validate` checks only that the file exists.

---

## Storage Layout (CSV vs GeoJSON vs computed)

| Class | Storage | Examples |
|---|---|---|
| Scalar attributes, enum values, FKs | **CSV** | `material`, `thickness`, `size_x`, `size_y`, `shape`, `function`, `operation`, `host_id`, `position`, `base_level_id`, `top_level_id` |
| Geometry coordinates | **GeoJSON `geometry`** | LineString points, Polygon rings, Point coord; 2D for level-anchored, 3D for spatial |
| Numeric geometry hints | **GeoJSON `properties`** | `base_offset`, `top_offset`, `arc`, `rotation` |
| Derived spatial data | **Computed (DuckDB hydrate)** | `length`, `area`, `height`, `volume` (structural tables), `start_x/y/z`, `end_x/y/z`, `x`, `y`, `points`, `bbox_*`, `level_id` |

YAML schemas use the following markers:

- **`required: true`** — Semantic source of truth in CSV. AI writes directly. If geometry contradicts, CSV wins.
- **`computed: true`** — Spatial derivative, never stored. DuckDB hydrate produces it at query time.
- **`storage: geojson_property`** — Lives in GeoJSON Feature `properties`, not CSV. Source of truth in GeoJSON. **In the SVG encoding**, the same hint is expressed intrinsically by SVG (`rotation` → `transform`, `arc` → path `A` command) or, where SVG cannot (Z offsets, spatial Z), moves to a CSV column. See [svg-schema/readme.md §6](svg-schema/readme.md).
- **(default)** — Stored in CSV (identical in both encodings).

---

## Z-Axis Handling Summary

Two modes (see [geojson-schema/readme.md §4](geojson-schema/readme.md) for details):

1. **Level-anchored** (wall, column, slab, ceiling, roof, curtain_wall): geometry coords are 2D; Z lives in CSV (`base_level_id`, `top_level_id`) + GeoJSON properties (`base_offset`, `top_offset`). Resilient to level elevation changes.
2. **Spatial** (beam, brace, stair, ramp, railing, duct, pipe, cable_tray, conduit): geometry coords are 3D with absolute Z; CSV still carries `base_level_id` for partitioning but no Z numerics.

This split keeps numeric Z arithmetic out of the LLM's hands for the bulk of building elements while preserving full 3D fidelity for elements that genuinely need it.

In the **SVG encoding** (2D-only), the same two modes apply but Z always lives in CSV: level-anchored `base_offset`/`top_offset` and spatial `start_z`/`end_z` are CSV columns. See [svg-schema/readme.md §6](svg-schema/readme.md).

---

## Base Mixins

| Mixin                        | Key Fields |
|------------------------------|------------|
| `element`                    | `id` (short ID, PK), `number`, `base_offset` (GeoJSON property), `mesh_file` |
| `line_element`               | `start_x/y`, `end_x/y`, `length` (all computed) |
| `spatial_line_element`       | extends `line_element` + `start_z`, `end_z` (computed from 3D coords) |
| `point_element`              | `x`, `y` (computed from Point coords), `rotation` (computed from GeoJSON property) |
| `polygon_element`            | `points`, `area` (computed) |
| `hosted_element`             | `host_id` (CSV reference), `position` (CSV float, meters along host start) |
| `vertical_span`              | `base_level_id`, `top_level_id` (CSV FKs), `top_offset` (GeoJSON property), `height` (computed) |
| `materialized`               | `material` (CSV enum) |
| `section_profile`            | `shape` (CSV enum rect/round), `size_x`, `size_y` (CSV) |
| `structural_section_profile` | `shape` (CSV enum rect/round/i/t/l/c/cross), `size_x`, `size_y` (CSV) |
| `mep_system`                 | `system_type` (CSV string) |
| `mep_connectable`            | `from`, `to` (CSV; port-ref `host_id:port_name` or bare `host_id`, auto-resolved by CLI) |

---

## ID System

All elements use prefixed short IDs: `{prefix}-{n}`. Counters are 1-based per table, scoped to the level directory.

| Table | Prefix | Example |
|---|---|---|
| `level` | `lv` | `lv-1` |
| `grid` | `gr` | `gr-1` |
| `wall` | `w` | `w-1` |
| `column` | `c` | `c-1` |
| `slab` | `sl` | `sl-1` |
| `space` | `sp` | `sp-1` |
| `door` | `d` | `d-1` |
| `window` | `wn` | `wn-1` |
| `opening` | `op` | `op-1` |
| `stair` | `st` | `st-1` |
| `ramp` | `rp` | `rp-1` |
| `railing` | `rl` | `rl-1` |
| `curtain_wall` | `cw` | `cw-1` |
| `ceiling` | `cl` | `cl-1` |
| `roof` | `ro` | `ro-1` |
| `room_separator` | `rs` | `rs-1` |
| `structure_wall` | `sw` | `sw-1` |
| `structure_column` | `sc` | `sc-1` |
| `structure_slab` | `ss` | `ss-1` |
| `beam` | `bm` | `bm-1` |
| `brace` | `br` | `br-1` |
| `foundation` | `f` | `f-1` |
| `duct` | `du` | `du-1` |
| `pipe` | `pi` | `pi-1` |
| `cable_tray` | `ct` | `ct-1` |
| `conduit` | `co` | `co-1` |
| `equipment` | `eq` | `eq-1` |
| `terminal` | `tm` | `tm-1` |
| `mep_node` | `mn` | `mn-1` |
| `connector` | `cn` | `cn-1` |
| `mesh` | `ms` | `ms-1` |
| `wall_type` / `slab_type` / `roof_type` / `ceiling_type` | `wt` / `slt` / `rot` / `clt` | `wt-ext-concrete-eps` |
| `door_type` / `window_type` / `curtain_wall_type` | `dt` / `wnt` / `cwt` | `dt-single-900` |
| `column_type` / `beam_type` | `colt` / `bmt` | `bmt-steel-ipe-300` |
| `type_layer` | `tl` | `tl-1` |
| `dimension` | `dm` | `dm-1` |
| `text_note` | `tx` | `tx-1` |
| `tag` | `tg` | `tg-1` |
| `underlay` | `ul` | `ul-1` |

Round-trip fidelity with Revit is maintained via a `BimDown_Id` shared parameter stored on each Revit element, and `_IdMap.csv` at the project root.

---

## Design Decisions

### Architecture vs Structure Decoupling

Architectural and structural elements are fully independent. `structure_column`, `structure_wall`, `structure_slab` inherit from geometry bases directly, not from architecture types. This prevents cross-discipline field conflicts and allows independent modeling.

### Section Profiles

- Architecture columns use `section_profile` (rect/round).
- Structural elements use `structural_section_profile` with engineering shapes (I, T, L, C, cross).
- Section attributes (`shape`, `size_x`, `size_y`) live in CSV. Point-element orientation (`rotation`) lives in GeoJSON `properties` if non-zero.

### Two Geometry Encodings (SVG and GeoJSON)

The geometry layer is **not** used for visualization in either encoding — it is structured geometry storage. BimDown supports two interchangeable encodings:

- **SVG** (`format_version: 1`) — 2D only. AI models have extensive SVG training data and strong spatial reasoning with the format. See [svg-schema/readme.md](svg-schema/readme.md).
- **GeoJSON** (`format_version: 2`, **default**) — 2D and 3D. Chosen as the default because:
  - AI models produce equivalent or better quality on GeoJSON vs SVG at lower token cost (validated on Gemini 3 Flash; see `bimdown-format-comparison`).
  - Native 3D coordinate support `[x, y, z]` per RFC 7946.
  - JSON parsing is universally available; no XML/SVG parser dependency.
  - Compatible with the GIS toolchain (turf.js, DuckDB spatial, QGIS) for downstream analysis.

Both define a strict subset and a canonical form (GeoJSON: Point/LineString/Polygon, no Multi*; SVG: `<path>` with M/L/A only, `<rect>`, `<circle>`, `<polygon>`). AI may write looser variants (tessellated arcs, rotated polygons for rect columns, unclosed rings, etc.) and `bimdown build` normalizes to canonical. The two encodings are losslessly convertible over the shared 2D subset (GeoJSON additionally carries 3D). See [geojson-schema/readme.md §6](geojson-schema/readme.md) and [svg-schema/readme.md §6](svg-schema/readme.md).

### Elements Without Geometry File

Some elements have no geometry file:
- **Door/Window/Wall-Opening**: Fully defined by `host_id` + `position`. Absolute coordinates would require re-syncing when the host wall moves.
- **Space**: Defined by seed point `(x, y)` in CSV. Boundary polygon is auto-computed by `bimdown build` from surrounding walls, curtain walls, room separators, and structure walls using a half-edge face tracing algorithm. The generated `space.geojson` contains `Polygon` features whose IDs match the space CSV rows.
- **Grid/Level**: Global reference data with coordinates in CSV.
- **Dimension/Text note/Tag**: Annotations with inline CSV coordinates. A dimension end with a reference is re-derived from the referenced element (location line: the stored point projected onto it; `:start`/`:end`; wall face `:left`/`:right`; `:center`); the stored coordinates are the last resolved points and the fallback. Tags read their text (number, name, size, room area) from the host.

### Unified Foundation Type

Rather than separate types for isolated/strip/raft foundations, a single `foundation` table covers all forms. The GeoJSON geometry gives the footprint and the optional `kind` names the type (empty = the geometry's default):

| Geometry | `kind` | Plan size |
|---|---|---|
| `Point` | `pad` (default) | `width` (X) × `length` (Y, empty = square), turned by `rotation` |
| `Point` | `pile` | round, diameter `width` (rectangular `width` × `length` when `length` is set) |
| `LineString` | `strip` (default) | `width` across the centre line |
| `Polygon` | `raft` (default), `pile_cap`, `pad` | the real footprint (inner rings = holes) |

The top face is level + `base_offset`; the body hangs down by `thickness` (a pile's length).

Structural tables also carry an optional `material_grade` (C30, Q355, GL24h…) next to `material`, and `structure_slab.span_direction` (degrees CCW from +X) marks a one-way slab or deck. `volume` is computed at query time for structural tables.

### Opening: Wall and Slab Voids

`opening` supports two modes via the same table:
- **Wall opening**: `host_id` → wall, with `position`, `width`, `height`, and an optional sill `base_offset` (CSV, like door/window). No GeoJSON.
- **Slab opening**: `host_id` → slab, with GeoJSON `Polygon` geometry.

For multi-story shaft openings: export one `opening` per level, each hosted on its respective slab.

### MEP Topology

MEP networks form a **bipartite graph**: `mep_curve` (duct, pipe, cable_tray, conduit) connects to `mep_node` (fittings, accessories), and nodes connect back to curves. Two curves never connect directly — there is always a node in between.

- **mep_curve** geometry is defined by its two connector endpoints (not the physical centerline). In GeoJSON this is a 3D `LineString`. In Revit, endpoints are taken from `Connector.Origin` positions, which naturally align with the connectors of adjacent fittings.
- **mep_node** is a minimal topology node with position only. In GeoJSON this is a 3D `Point`. In Revit it maps to fittings (`DuctFitting`, `PipeFitting`, etc.) and accessories (`DuctAccessory`, `PipeAccessory`).
- **equipment** and **terminal** also serve as network endpoints — curves can connect directly to them.
- **connector** rows define the named ports on equipment, terminals, and active accessories: a host-local offset, outward direction, cross-section, flow direction, and domain. A curve's `from`/`to` references a port as `host_id:name` (or bare `host_id` for passive fittings, whose ports are derived from geometry at runtime). See [`mep-port-conventions.md`](mep-port-conventions.md).

**AI authoring workflow**:
1. Place equipment and terminals (anchors)
2. Draw duct/pipe segments connecting them (endpoint coordinates)
3. Call CLI `build` / `resolve-topology` — this detects coincident endpoints, generates `mep_node` entries at junctions, and back-fills `from`/`to` on each segment. Warns about disconnected endpoints.

**Revit export**: Fittings and accessories are exported as `mep_node`. Curve endpoints are taken from connector positions (not `LocationCurve`), so they naturally coincide with node positions. `from`/`to` are derived from Revit's connector relationships and reference the specific port via `host_id:port_name`. See [`mep-port-conventions.md`](mep-port-conventions.md) for port naming conventions.

**Revit import**: Curves are created from endpoint coordinates. Fittings are auto-inserted at junctions where curves meet nodes.

### Material Enum

A fixed enum of 15 common structural/architectural materials. Represents the **primary material** of an element. Multi-layer constructions are expressed through element types (below); `material` stays the primary (core) material.

### Element Types

Like Revit family types: a named set of defaults that many elements share. All type tables live in `global/` (schemas in `csv-schema/types/`).

| Type table | Used by (`type_id`) | Type parameters |
|---|---|---|
| `wall_type` | `wall`, `structure_wall` | `thickness`, `material` + layers |
| `slab_type` | `slab`, `structure_slab` | `thickness`, `material` + layers |
| `roof_type` | `roof` | `thickness`, `material` + layers |
| `ceiling_type` | `ceiling` | `material` + layers (thickness is type-only) |
| `door_type` | `door` | `width`, `height`, `operation`, `material`; type-only `frame_width`, `u_value`, `shgc`, `vt` |
| `window_type` | `window` | same as `door_type` |
| `curtain_wall_type` | `curtain_wall` | `u_spacing`, `v_spacing`, `panel_material`, `material`; type-only thermal |
| `column_type` | `column`, `structure_column` | `shape`, `size_x`, `size_y`, `flange`, `web`, `thickness`, `material` |
| `beam_type` | `beam`, `brace` | same as `column_type` |

**Resolution rule.** A field a type table shares by name with the instance table is a *type parameter*. An instance with `type_id` leaves it **empty to inherit** the type's value, or sets it to **override** for that element. Required instance fields (`wall.thickness`, `door.width`, …) may be empty when the type supplies them. Untyped elements are unchanged. Tools write a value equal to the type's back as empty, so editing a type updates every instance that follows it.

**Layers** (`type_layer.csv`): `type_id`, `seq` (1 = a wall's exterior face — its left side looking from start to end, as in Revit for walls drawn clockwise — or the top face of a slab/roof/ceiling), `function` (`core`, `substrate`, `insulation`, `air_gap`, `membrane`, `finish`), `material`, `thickness`, optional `conductivity` (W/(m·K)) and `name`. A layered type's thickness is the sum of its layers; its own `thickness` column may be empty (derived) or must equal that sum. When an instance overrides `thickness`, its core layer absorbs the difference (build warns).

**Thermal fields** on door/window/curtain wall types: `u_value` (W/(m²·K), whole unit), `shgc` and `vt` (0–1).

```csv
# global/wall_type.csv
id,name,material,thickness
wt-ext-concrete-eps,Exterior - Concrete 200 + EPS 100,concrete,0.325
# global/type_layer.csv
id,type_id,seq,function,material,thickness,conductivity,name
tl-2,wt-ext-concrete-eps,1,finish,composite,0.01,0.7,Exterior render
tl-3,wt-ext-concrete-eps,2,insulation,insulation,0.1,0.035,EPS 100
tl-4,wt-ext-concrete-eps,3,core,concrete,0.2,2.3,Reinforced concrete
tl-5,wt-ext-concrete-eps,4,finish,gypsum,0.015,0.4,Gypsum plaster
# lv-1/wall.csv — w-1 follows the type (0.325), w-2 overrides it
id,type_id,thickness
w-1,wt-ext-concrete-eps,
w-2,wt-ext-concrete-eps,0.35
```

New projects start with a metric starter catalog ([`starter-types/global/`](starter-types/global/)): concrete, ETICS, brick cavity, timber frame and stud walls; floor, ground floor and roof build-ups; ceilings; single/double/sliding doors; casement/fixed/sliding/tilt-and-turn windows; concrete/steel/timber column and beam sections. `bimdown query` returns effective values (`SELECT thickness FROM wall` includes inherited ones) and type tables join directly: `SELECT w.id, t.name FROM wall w JOIN wall_type t ON w.type_id = t.id`.

### Format Versioning

`project_metadata.json` at the project root includes `format_version`, which selects the geometry encoding:
- `1` — CSV + **SVG** (2D). Fully supported; see [svg-schema/readme.md](svg-schema/readme.md).
- `2` — CSV + **GeoJSON** (2D/3D). Fully supported; default for new projects.

Both are maintained; neither is deprecated. `bimdown migrate svg-to-geojson` converts a v1 project to v2 (to gain 3D fidelity); tools may also detect the encoding from the geometry files present (`*.svg` vs `*.geojson`).

---

## Storage & Query Architecture

See **[DuckDB & CLI Strategy](duckdb-strategy.md)** for details on:
1. **Hydration**: Merging partitioned CSVs + parsing GeoJSON geometry into in-memory DuckDB tables.
2. **Execution**: Standard SQL queries over unified, geometry-enriched views.
3. **Sync-Out**: Stripping computed fields, auto-healing GeoJSON from CSV source-of-truth, re-partitioning by level.
4. **Resolve-Topology**: Auto-generating MEP connectivity graph from endpoint coordinates.
