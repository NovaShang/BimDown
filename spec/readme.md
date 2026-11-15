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
│   ├── sheet.csv, sheet_viewport.csv # drawing sheets and the views placed on them (optional)
│   ├── dimension.csv, text_note.csv # annotations on sections / elevations (view_id, optional)
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
- **Global directory** (`global/`): elements that span **more than one level above** their base (multi-story walls, vertical pipe risers, etc.), plus `level.csv`, `grid.csv`, `view.csv`, the sheets and the annotations drawn on sections / elevations.
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
| `stair`          | Spatial line     | `LineString` 3D | Stair (its own first run) with vertical span; optional multi-storey repetition |
| `stair_run`      | Spatial line     | `LineString` 3D | Further flight of a stair (`host_id` → stair) |
| `stair_landing`  | Polygon          | `Polygon` 2D | Landing between runs (`host_id` → stair), top at `base_offset` |
| `ramp`           | Spatial line     | `LineString` 3D | Accessibility ramp |
| `railing`        | Spatial line     | Conditional | Sketched railing (`LineString` 3D, optionally on a slab via `host_id`) or stair railing (`host_id` → stair + `side`, no geometry) |
| `curtain_wall`   | Line             | `LineString` 2D | Curtain wall with grid parameters |
| `ceiling`        | Polygon          | `Polygon` 2D | Ceiling surface |
| `roof`           | Polygon          | `Polygon` 2D | Roof surface |
| `room_separator` | Line             | `LineString` 2D | Invisible boundary line for room separation |
| `furniture`      | Point            | `Point` 2D | Built-in parametric component: furniture, casework, appliances without ports, toilet partitions, cars / parking, planting, people, placeholders (`family`, `variant`, `size_x` × `size_y` × `height`, `mirror`) |

### Structure

| Table              | Geometry   | GeoJSON type | Description |
|--------------------|------------|-----------------|-------------|
| `structure_wall`   | Line       | `LineString` 2D | Structural wall |
| `structure_column` | Point      | `Point` 2D | Structural column |
| `structure_slab`   | Polygon    | `Polygon` 2D | Structural slab |
| `beam`             | Spatial line | `LineString` 3D | Structural beam |
| `brace`            | Spatial line | `LineString` 3D | Structural brace |
| `foundation`       | Mixed      | `Point`/`LineString`/`Polygon` 2D | Unified foundation (geometry type chooses form) |
| `beam_system`      | Polygon    | `Polygon` 2D | Associative infill beams across a bay: `spacing`, `direction`, `type_id`; its beams carry `beam_system_id` and are regenerated when it changes |

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
| `circuit`    | None (CSV)   | — | Electrical branch circuit hosted on a panel (`host_id`); devices join through `circuit_id`. CSV-only. |

### Annotation

Plan annotations, CSV only, in level directories. They reference model elements by id, so they follow edits; see [csv-schema/annotation/](csv-schema/annotation/). Dimensions and text notes drawn on a section or elevation live in `global/` with `view_id` (a `view.csv` section id, or `north` / `south` / `east` / `west`) and view coordinates: x along the view as seen, y = absolute elevation.

Annotation sizes are **paper sizes**: text, ticks and tag boxes are millimetres on the sheet, drawn at `mm × scale / 1000` metres in the model (2.5 mm = 0.25 m at 1:100, 0.5 m at 1:200), so a note reads the same at every scale. `text_note.paper_size` stores the height in mm; the legacy `size` (project units, fixed) is used only when `paper_size` is empty.

| Table        | Geometry file | Description |
|--------------|---------------|-------------|
| `dimension`  | No (CSV points) | Linear dimension: two measured points, each optionally stuck to an element (`start_ref` / `end_ref`: `w-1`, `w-1:left`, `w-1:end`, `d-1:start`, …), a `direction` (empty = aligned) and an `offset` for the dimension line |
| `text_note`  | No (CSV point) | Free text at `x`,`y` with `paper_size` (mm) and `rotation` |
| `tag`        | No (CSV point) | Label of one element (`host_id`): door/window mark, room name + number + area, number/name/type/size; empty `x`,`y` = default spot that follows the host |

### Model groups

A repeated unit (an apartment, a toilet core, a bay of columns) placed several times. Each placement is a `model_group` row in the level directory (CSV only): `name`, origin `x`,`y`, `rotation` (degrees CCW) and `mirrored`. Its members are ordinary elements of the same level with `group_id` = the row id, stored as usual (absolute plan coordinates), so anything that ignores groups still reads them. Instances with the same `name` are copies of one group: their members are identical in the group's local frame (plan = origin + rotate(rotation) · (mirrored ? flip-Y : identity) · local). Editing one instance in an editor rebuilds the others; `bimdown build` warns when instances of one group differ.

| Table         | Geometry file | Description |
|---------------|---------------|-------------|
| `model_group` | No (CSV point) | Group instance: `name`, `x`, `y`, `rotation`, `mirrored`; members carry `group_id` |

### Pinned elements

`pinned = "true"` (every element, and grids) marks an element editors must not move, rotate or reshape (properties stay editable). Empty = not pinned.

### Fallback

| Table  | Geometry file | Description |
|--------|---------------|-------------|
| `mesh` | No (GLB)      | Generic 3D model for elements without parametric schema |

`furniture` covers what used to need a GLB: a closed list of library families (`bimdown schema furniture` prints them with variants and default sizes). Plan symbols and low-poly 3D massing are generated from the family and its parameters, so files stay small and editable; `mesh_file` on a row overrides the 3D only. Local frame: `size_x` along X, `size_y` along Y, **+Y is the back** (the side against a wall), `rotation` CCW in GeoJSON properties. Empty sizes take the family / variant default. Exporters map families to IFC4 `IfcFurniture` (DESK, CHAIR, TABLE, BED, SOFA, SHELF, FILECABINET), `IfcElectricAppliance` (appliances), `IfcFurnishingElement`, `IfcGeographicElement` (trees) or `IfcBuildingElementProxy` (cars, parking, people, generic). Plumbing fixtures with pipe connections are MEP `terminal`s, not furniture.

### Underlays (reference drawings)

| Table      | Geometry file | Description |
|------------|---------------|-------------|
| `underlay` | No (file in `underlays/`) | `global/underlay.csv`: an image, PDF page or DXF placed under one level for tracing |

An underlay row places `file` (under `underlays/`) on `level_id`: plan = `(x, y)` + rotate(`rotation`°) · (`scale` · local), where local is image pixels (origin bottom-left), PDF points or DXF drawing units; `scale` is project units per local unit. `opacity`, `visible`, `locked`, `page` (PDF) and `hidden_layers` (DXF, `;`-separated) are display settings. Underlays are not building elements: `build`, `render`, `query` and the exports ignore them; `validate` checks only that the file exists.

### Sheets (drawings for print)

| Table | Geometry file | Description |
|-------|---------------|-------------|
| `sheet` | No | `global/sheet.csv`: one sheet: `number` (unique, e.g. A-101), `name`, `paper` (A0–A4 landscape), revision fields, `issue_date`, `drawn_by`, `checked_by` |
| `sheet_viewport` | No | `global/sheet_viewport.csv`: a view on a sheet: `view_type` plan (`level_id`, `discipline`), section (`view_id`), elevation (`view_id` = direction), schedule (`schedule`) or legend, at `scale` (100 = 1:100), centred at `x`,`y` mm from the paper's bottom-left |

The title block shows `project_name`, `project_number`, `client` and `address` from `project_metadata.json`, the sheet number / name, date, revision and the scale of each viewport. Sheets are not building elements: `build` and `render` ignore them (`query` reads them like any table).

---

## Storage Layout (CSV vs GeoJSON vs computed)

| Class | Storage | Examples |
|---|---|---|
| Scalar attributes, enum values, FKs | **CSV** | `material`, `thickness`, `size_x`, `size_y`, `shape`, `function`, `operation`, `host_id`, `position`, `base_level_id`, `top_level_id` |
| Geometry coordinates | **GeoJSON `geometry`** | LineString points, Polygon rings, Point coord; 2D for level-anchored, 3D for spatial |
| Numeric geometry hints | **GeoJSON `properties`** | `base_offset`, `top_offset`, `arc`, `rotation` |
| Derived spatial data | **Computed (DuckDB hydrate)** | `length`, `area`, `net_area` (spaces), `height`, `volume` (structural tables), `start_x/y/z`, `end_x/y/z`, `x`, `y`, `points`, `bbox_*`, `level_id` |

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

Changing a level's `elevation` moves everything on that level with it: level-anchored elements follow by themselves; the absolute Z in that level's spatial GeoJSON (beams, ducts, pipes, stairs, equipment, …) must be shifted by the same amount (editors rewrite it). To keep the storey heights above, shift the higher levels (and their spatial Z) too.

This split keeps numeric Z arithmetic out of the LLM's hands for the bulk of building elements while preserving full 3D fidelity for elements that genuinely need it.

In the **SVG encoding** (2D-only), the same two modes apply but Z always lives in CSV: level-anchored `base_offset`/`top_offset` and spatial `start_z`/`end_z` are CSV columns. See [svg-schema/readme.md §6](svg-schema/readme.md).

---

## Base Mixins

| Mixin                        | Key Fields |
|------------------------------|------------|
| `element`                    | `id` (short ID, PK), `number`, `base_offset` (GeoJSON property), `mesh_file`, `group_id` (model group), `pinned` |
| `line_element`               | `start_x/y`, `end_x/y`, `length` (all computed) |
| `spatial_line_element`       | extends `line_element` + `start_z`, `end_z` (computed from 3D coords) |
| `point_element`              | `x`, `y` (computed from Point coords), `rotation` (computed from GeoJSON property) |
| `polygon_element`            | `points`, `area` (computed) |
| `hosted_element`             | `host_id` (CSV reference), `position` (CSV float, meters along host start) |
| `vertical_span`              | `base_level_id`, `top_level_id` (CSV FKs), `top_offset` (GeoJSON property), `height` (computed) |
| `materialized`               | `material` (CSV enum) |
| `wall_bounded`               | `boundary_walls`, `boundary_face`, `boundary_offset` (CSV; slab, structure_slab, roof, ceiling) |
| `section_profile`            | `shape` (CSV enum rect/round), `size_x`, `size_y` (CSV) |
| `structural_section_profile` | `shape` (CSV enum rect/round/i/t/l/c/cross), `size_x`, `size_y` (CSV) |
| `mep_system`                 | `system_type` (CSV string) |
| `mep_connectable`            | `from`, `to` (CSV; port-ref `host_id:port_name` or bare `host_id`, auto-resolved by CLI) |
| `mep_design`                 | `flow` (L/s), `load` (W), `circuit_id` (equipment, terminal; not lengths) |
| `mep_insulated`              | `insulation_thickness` (duct, pipe) |

**Room area.** A space's boundary is derived along wall centre lines (`space.geojson`, written by `bimdown build`), so its `area` is the gross, centre-line area. `net_area` is the area at the wall finish faces: each boundary edge moves inward by half the thickness of the wall it lies on (room separators and edges on no wall stay put) — Revit's default room area. Drawings, room tags, schedules and IFC `NetFloorArea` use `net_area`; `area` is kept for backward compatibility (and as IFC `GrossFloorArea`).

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
| `stair_run` | `sr` | `sr-1` |
| `stair_landing` | `sl_land` | `sl_land-1` |
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
| `circuit` | `ci` | `ci-1` |
| `mesh` | `ms` | `ms-1` |
| `wall_type` / `slab_type` / `roof_type` / `ceiling_type` | `wt` / `slt` / `rot` / `clt` | `wt-ext-concrete-eps` |
| `door_type` / `window_type` / `curtain_wall_type` | `dt` / `wnt` / `cwt` | `dt-single-900` |
| `column_type` / `beam_type` | `colt` / `bmt` | `bmt-steel-ipe-300` |
| `foundation_type` | `fdt` | `fdt-pad-2000` |
| `furniture_type` | `fut` | `fut-desk-1600` |
| `railing_type` | `rlt` | `rlt-steel-1000` |
| `type_layer` | `tl` | `tl-1` |
| `dimension` | `dm` | `dm-1` |
| `text_note` | `tx` | `tx-1` |
| `tag` | `tg` | `tg-1` |
| `underlay` | `ul` | `ul-1` |
| `furniture` | `fu` | `fu-1` |
| `sheet` / `sheet_viewport` | `sh` / `vp` | `sh-1`, `vp-1` |
| `model_group` | `mg` | `mg-1` |

Round-trip fidelity with Revit is maintained via a `BimDown_Id` shared parameter stored on each Revit element, and `_IdMap.csv` at the project root.

---

## Design Decisions

### Architecture vs Structure Decoupling

Architectural and structural elements are fully independent. `structure_column`, `structure_wall`, `structure_slab` inherit from geometry bases directly, not from architecture types. This prevents cross-discipline field conflicts and allows independent modeling.

### Section Profiles

- Architecture columns use `section_profile` (rect/round).
- Structural elements use `structural_section_profile` with engineering shapes (I, T, L, C, cross, `rect_hollow` RHS/SHS, `round_hollow` CHS; `thickness` = wall thickness; `open_web` K / LH bar joists: chords solid, web open), optional `root_radius` (root fillet / RHS outer corner) and `designation` (catalogue name such as HEA 300, W14X90, CHS 219.1x8, used as the IFC ProfileName). Computed `weight` (kg) on columns / beams / braces = volume × material density (steel 7850 kg/m³); beams / braces use their computed `cut_length` (to the faces of the columns / girders they frame into, as the editor schedules).
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
- **Space**: Defined by seed point `(x, y)` in CSV. Boundary polygon is auto-computed by `bimdown build` from surrounding walls, curtain walls, room separators, and structure walls using a half-edge face tracing algorithm. The generated `space.geojson` contains `Polygon` features whose IDs match the space CSV rows. Two seeds in one enclosed area (Revit "redundant room"): the first row keeps the area, later ones get `redundant: true` and `net_area` 0 (a build warning; add a room_separator or delete the extra row). A seed outside every closed loop gets no polygon.
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

Structural tables also carry an optional `material_grade` (C30, Q355, GL24h…) next to `material`, and `structure_slab.span_direction` (degrees CCW from +X) marks a one-way slab or deck. `volume` is computed at query time for structural tables; slabs also get `net_area` (inner rings and hosted Polygon openings deducted), and slab volume uses it.

Marks (`number`) can be generated per category; `project_metadata.json` `numbering` maps a table (or `table.kind`: `foundation.pile`, `equipment.ahu`, `beam.secondary`) to its prefix.

### Model Checks

`bimdown validate` rejects non-positive `thickness`, `width`, `height`, `size_x` / `size_y`, `step_count`, grid spacings and mullion sizes (empty = inherited from the type) and negative `position`. `bimdown build` warns about doors / windows / openings overlapping on one wall (not ones stacked one above the other), walls overlapping each other (parallel, one centre line inside the other's thickness), redundant / unbounded rooms, stair calculator failures and MEP connectivity. The editor's Warnings panel shows the same checks.

### Opening: Wall and Slab Voids

`opening` supports two modes via the same table:
- **Wall opening**: `host_id` → wall, with `position`, `width`, `height`, and an optional sill `base_offset` (CSV, like door/window). No GeoJSON.
- **Slab / roof opening**: `host_id` → slab, structure_slab or roof, with GeoJSON `Polygon` geometry, cut vertically (skylights, dormer openings).
- **Shaft**: a `Polygon` opening with `top_level_id` (+ `top_offset`); it cuts every slab, structure_slab, ceiling and roof whose body lies between its bottom (its level + `base_offset`) and its top, on every level. `host_id` may stay empty. One `opening` per level hosted on each slab also works.

### Roofs and Attached Walls

A roof is a footprint polygon (the eave outline, overhang included); `base_offset` is the underside at the eaves. `edge_slopes` gives one slope per footprint edge (`;`-separated degrees, edge i from vertex i to i+1, 0 = gable / rake edge): each sloped edge is a plane rising inward, and the roof underside is the lowest plane reaching each point, so L / T / U footprints get exact ridges, hips and valleys. Without `edge_slopes`, `roof_type` + `slope` imply them (hip: all edges; gable: all but the wing ends; shed: one eave; mansard: all edges, steeper, with a flat deck). A flat roof drains with small edge slopes (`1.2;0;0;0`). `roof_type: extrusion` sweeps `profile` (`u,z;...`: rise z at distance u across the first edge) along the first edge.

A wall (or structure_wall) with `top_attach_id` = a roof or slab id (any level) has its top follow that element's underside wherever the wall is under it (gable end walls, walls under a sloped ceiling); elsewhere it keeps its `top_level_id` / `top_offset` top.

```csv
# lv-2/roof.csv — L-shaped gable over a 6-edge outline, wing ends at edges 2 and 5
id,roof_type,slope,edge_slopes,thickness
ro-1,gable,35,35;35;0;35;35;0,0.25
# lv-2/wall.csv — walls under it attach their tops
id,thickness,top_level_id,top_attach_id
w-1,0.2,lv-3,ro-1
```

**Boundaries picked from walls.** A slab, structure_slab, roof or ceiling with `boundary_walls` (`w-1;w-2;…`, walls / curtain walls / room separators on its level or in global/) keeps its outline associated with those walls (Revit "Pick Walls"): the polygon is still stored, but editors rebuild it from the walls' loop at `boundary_face` (interior, core, centerline, core_exterior, exterior; default core, roofs exterior, ceilings interior) moved out by `boundary_offset` (a roof's overhang) whenever one of the walls moves, flips or changes thickness. Editing the polygon directly clears `boundary_walls`. `validate` checks the ids.

### Stairs and Railings

A stair is assembled from components, like Revit's stair by component:

- `stair` — its own 3D LineString is the **first run** (bottom riser → top, along the walking line), `step_count` = its risers, `width`; `stair_type` is a shape hint. A stair without geometry — or whose line spans exactly the bottom-to-top of its `stair_run` rows (an overall axis) — is a container whose runs are all `stair_run` rows.
- `stair_run` (`host_id` → stair) — further flights, each with its own `width` and `step_count`.
- `stair_landing` (`host_id` → stair) — platform polygons; `base_offset` is the landing **top** (= top of the run arriving on it), `thickness` hangs below.

Runs are ordered by their start Z. All risers of a stair share one height: riser = total rise / total risers; a run's going = run length / its `step_count` (its last tread is flush with the landing or floor above). Editors keep run Z values and landing heights in step when steps or levels change.

**Multi-storey**: `multistory_top_level_id` repeats the stair (runs, landings, stair railings) on every storey from the base level up to that level. Repetitions keep the step count and plan; the riser adapts to each storey's height. Exporters write one IfcStair per storey.

**Calculator checks** (`bimdown build` warnings): riser 0.15–0.19 m, going ≥ 0.26 m, 2R+G 0.60–0.65 m, width ≥ 0.90 m; plus a landing whose top differs from the run arriving on it.

**Railings** have three forms (one `railing` table):

| Form | `host_id` | Geometry | Path |
|---|---|---|---|
| Sketched | empty | `LineString` 3D | the coordinates |
| On a slab edge | slab / structure_slab | `LineString` (Z ignored) | on the slab top, follows it |
| On a stair | stair, plus `side` = `left` / `right` | none (CSV only) | derived: along that side's run edges (inset 5 cm), around the outer side of landings, across the well side of U stairs; rises with the nosing line |

`height` is measured from the walking surface (stair nosing line or floor). A `railing_type` supplies height, top rail (`top_rail_shape`, `top_rail_size`), infill (`balusters` at `baluster_spacing` / `baluster_size`, `glass` panels or `none`) and material.

```csv
# lv-1/stair.csv — an L stair: st-1 is run 1, sr-1 run 2, one landing, railings both sides
id,width,step_count,stair_type,top_level_id,multistory_top_level_id
st-1,1.2,9,quarter_turn,lv-2,
# lv-1/stair_run.csv
id,host_id,width,step_count
sr-1,st-1,1.2,9
# lv-1/railing.csv (no railing.geojson features for these)
id,host_id,side,type_id,height
rl-1,st-1,left,rlt-steel-1000,
rl-2,st-1,right,rlt-steel-1000,
```

### MEP Topology

MEP networks form a **bipartite graph**: `mep_curve` (duct, pipe, cable_tray, conduit) connects to `mep_node` (fittings, accessories), and nodes connect back to curves. Two curves never connect directly — there is always a node in between.

- **mep_curve** geometry is defined by its two connector endpoints (not the physical centerline). In GeoJSON this is a 3D `LineString`. In Revit, endpoints are taken from `Connector.Origin` positions, which naturally align with the connectors of adjacent fittings.
- **mep_node** is a minimal topology node with position only. In GeoJSON this is a 3D `Point`. In Revit it maps to fittings (`DuctFitting`, `PipeFitting`, etc.) and accessories (`DuctAccessory`, `PipeAccessory`).
- **equipment** and **terminal** also serve as network endpoints — curves can connect directly to them.
- **connector** rows define the named ports on equipment, terminals, and active accessories: a host-local offset, outward direction, cross-section, flow direction, and domain. A curve's `from`/`to` references a port as `host_id:name` (or bare `host_id` for passive fittings, whose ports are derived from geometry at runtime). See [`mep-port-conventions.md`](mep-port-conventions.md).

**Fittings and accessories**: passive `mep_node`s (empty `kind`) are derived elbows / tees / crosses / reducers / transitions / caps (an optional `fitting` hint records `tap`, `cap`, `open`); tools draw them with real bodies (elbow centre-line radius 1.0 × width for ducts and trays, 1.5 × D for pipes, 4 × D for conduit; runs are pulled back to the fitting face). Inline accessories (`kind` valve / damper / …) carry `in` / `out` connector rows and the run is split around them.

**AI authoring workflow**:
1. Place equipment and terminals (anchors) with their `connector` rows
2. Draw duct/pipe segments whose ends sit exactly on port points, on other run ends, or on another run's body; add a vertical segment wherever heights differ
3. Call CLI `resolve-topology` — ends on ports get `host:port`, meeting ends get a passive `mep_node`, an end on a run's body splits that run with a tee (same table and system only), and the remaining problems are listed
4. `build` (and `mep-check`) report MEP connectivity warnings: open ends, refs that don't resolve, ends off their port, system / domain mismatches, disconnected devices, orphan fittings, overloaded circuits. Ids resolve in the curve's own level first, then `global/`.

**Revit export**: Fittings and accessories are exported as `mep_node`. Curve endpoints are taken from connector positions (not `LocationCurve`), so they naturally coincide with node positions. `from`/`to` are derived from Revit's connector relationships and reference the specific port via `host_id:port_name`. See [`mep-port-conventions.md`](mep-port-conventions.md) for port naming conventions.

**Revit import**: Curves are created from endpoint coordinates. Fittings are auto-inserted at junctions where curves meet nodes.

### Curtain Wall Grids and Panels

A curtain wall is a grid of cells: columns along the wall (col 0 at the start), rows up from the base (row 0 at the bottom).
- **Uniform**: `v_grid_count` columns × `u_grid_count` rows (or a line every `v_spacing` / `u_spacing` when the count is empty; default 3 × 3).
- **Explicit**: `v_grids` = vertical lines as distances from the start, `u_grids` = horizontal lines as heights above the base, semicolon-separated (`1.2;2.4;3.9`); they override the counts. Lines must lie inside the wall.
- **Panels**: `panels` = `col:row=kind` overrides, `;`-separated, `*` = every col / row (`*:0=solid;1:0=door`). Kinds: `glass` (default, `panel_material`), `solid` (opaque spandrel, `solid_material`), `door`, `double_door` (hinged on the cell's start side, swinging to the wall's left; no bottom transom), `empty` (mullions only). Door panel marks: `door_numbers` = `D105;D106`, one per door panel in cell order (column from the start, then row); they share the door numbering (unique project-wide).
- **Mullions**: `mullion_width` (along the wall; Ø when round), `mullion_depth`, `mullion_profile` (`rect`/`round`, interior members only), all type parameters. Two curtain walls meeting at an endpoint share one corner mullion.
- **Embedded** (Revit "Automatically Embed"): a straight curtain wall drawn along a straight wall or structure_wall (parallel within ~1°, both ends inside the wall's thickness) cuts that wall over the overlap, from the curtain wall's base to its top; exporters write it as an opening in the host filled by the curtain wall. Derived, nothing stored: move or delete the curtain wall and the host follows. To keep both, offset the curtain wall out of the wall.

```csv
id,v_grids,u_grids,panels
cw-1,1.5;3.3;4.8,0.9;2.4,*:0=solid;1:0=door;3:2=empty
```

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
| `curtain_wall_type` | `curtain_wall` | `u_spacing`, `v_spacing`, `panel_material`, `solid_material`, `mullion_width`, `mullion_depth`, `mullion_profile`, `material`; type-only thermal |
| `column_type` | `column`, `structure_column` | `shape`, `size_x`, `size_y`, `flange`, `web`, `thickness`, `root_radius`, `designation`, `material`, `material_grade` |
| `beam_type` | `beam`, `brace` | same as `column_type` |
| `foundation_type` | `foundation` | `kind`, `width`, `length`, `thickness`, `material`, `material_grade` |
| `furniture_type` | `furniture` | `family`, `variant`, `size_x`, `size_y`, `height` |
| `railing_type` | `railing` | `height`, `baluster_spacing`, `material`; type-only `top_rail_shape`, `top_rail_size`, `infill` (balusters/glass/none), `baluster_size` |

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

New projects start with a starter catalog ([`starter-types/global/`](starter-types/global/), metric; `bimdown init --units` and the editor scale its lengths to the project units): concrete, ETICS, brick cavity, timber frame and stud walls; floor, ground floor and roof build-ups; ceilings; single/double/sliding doors; casement/fixed/sliding/tilt-and-turn windows; concrete/steel/timber column and beam sections. `bimdown query` returns effective values (`SELECT thickness FROM wall` includes inherited ones) and type tables join directly: `SELECT w.id, t.name FROM wall w JOIN wall_type t ON w.type_id = t.id`.

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
