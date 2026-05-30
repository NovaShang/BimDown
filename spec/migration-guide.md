# BimDown Spec Migration Guide

This document records all spec changes across versions to guide editor and CLI adaptation.

---

## Version 3.0 (Current)

### SVG Format: `<line>` → `<path>`

**All line-type elements** now use `<path>` instead of `<line>` in SVG.

Before:
```xml
<line id="w-1" x1="0" y1="0" x2="5" y2="0" stroke="black" stroke-width="0.2" stroke-linecap="square" />
```

After:
```xml
<path id="w-1" d="M 0,0 L 5,0" />
```

- Only `M`, `L`, `A` commands allowed (no bezier `C`/`Q`)
- `A` command supports arc geometry (curved walls, ramps)
- Affects: wall, structure_wall, beam, brace, stair, ramp, railing, curtain_wall, room_separator, duct, pipe, cable_tray, conduit, strip foundations

**Editor action**: SVG parser must handle `<path d="M x1,y1 L x2,y2">` instead of `<line x1=... y1=...>`. Parse the `d` attribute to extract start/end coordinates.

### SVG Styling Removed

No `stroke`, `fill`, `stroke-width`, `stroke-linecap` attributes are written or read. SVG elements only have `id` and geometry attributes (`d`, `x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `points`, `transform`).

**Editor action**: Don't rely on `stroke-width` for wall thickness or any styling attributes for data. Thickness comes from CSV only.

### Door/Window Removed from SVG

Doors and windows **no longer have SVG files**. They are fully defined in CSV via `host_id` + `position` (0-1 parametric location on host wall).

Before: `door.svg` existed with `<line data-host="w-1" ...>` elements.
After: Only `door.csv` exists. No `door.svg`, no `window.svg`.

**Editor action**: Render doors/windows by computing position on host wall from CSV `position` field. Remove any SVG-based door/window loading.

### Space Removed from SVG

Spaces (rooms) **no longer have SVG files**. Defined by seed point `(x, y)` in CSV. Boundary auto-derived from surrounding walls and room separators.

Before: `space.svg` existed with `<polygon>` elements.
After: Only `space.csv` exists with `x`, `y`, `name` fields.

**Editor action**: Render space boundaries by computing enclosed regions from wall geometry, not from SVG polygons.

### Foundation Unified (3 → 1)

`isolated_foundation`, `strip_foundation`, `raft_foundation` merged into single `foundation` table.

Before:
```
isolated_foundation.csv + isolated_foundation.svg  (point: <rect>/<circle>)
strip_foundation.csv + strip_foundation.svg        (line: <line>)
raft_foundation.csv + raft_foundation.svg          (polygon: <polygon>)
```

After:
```
foundation.csv + foundation.svg  (mixed: <rect>/<circle>, <path>, or <polygon>)
```

The geometry type in SVG determines the foundation form. CSV fields are a superset: `thickness`, `width`, `length`, `material`. Unused fields are empty.

ID prefix changed: `if-1`/`sf-1`/`rf-1` → `f-1`

**Editor action**: Load single `foundation` table. Detect geometry type from SVG element (`<rect>` = isolated, `<path>` = strip, `<polygon>` = raft). Handle all three geometry types in one table renderer.

### New Element Types

#### `ramp` (architecture)
- Base: `spatial_line_element`
- Fields: `width`
- SVG: `<path>`
- ID prefix: `rp`
- Similar to `stair` but without `step_count`

#### `railing` (architecture)
- Base: `spatial_line_element`
- Fields: `height`
- SVG: `<path>`
- ID prefix: `rl`
- Previously exported as `mesh` (GLB fallback); now has parametric schema

#### `room_separator` (architecture)
- Base: `line_element`
- Fields: none (pure geometry)
- SVG: `<path>`
- ID prefix: `rs`
- Invisible boundary line for defining room boundaries where no wall exists
- Was defined in spec v2 but never had export/import implementation; now fully implemented

**Editor action**: Add table loaders, renderers, and property panels for these three new element types.

### Opening Dual Mode

`opening` now supports two modes in the same table:

1. **Wall opening**: `host_id` references a wall. Has `position`, `width`, `height`, `shape`. No SVG.
2. **Slab opening**: `host_id` references a slab. Has SVG geometry (`<rect>` or `<polygon>`).

Opening no longer extends `hosted_element` base. It extends `element` directly with its own `host_id` and `position` fields.

For shaft openings spanning multiple floors: one `opening` per level, each hosted on its slab.

**Editor action**: Check `host_id` target type. If host is wall → render as parametric opening on wall. If host is slab → render from SVG geometry.

### MEP System Type: Enum → String

`mep_system.system_type` changed from enum (`hvac`, `plumbing`, etc.) to free-form string matching Revit's system classification (e.g. `"CHWS"`, `"CHR"`, `"SA"`, `"RA"`, `"DW"`).

**Editor action**: Display system_type as text, not dropdown. Remove enum validation for this field.

### MEP Topology Model

MEP networks are a **bipartite graph**: curves connect to nodes, nodes connect to curves. Two curves never connect directly.

- `mep_curve` (duct/pipe/cable_tray/conduit) endpoints come from **connector positions** (not centerline). This ensures endpoints coincide with fitting/accessory positions.
- `mep_node` represents fittings and accessories. Minimal data: just position and system_type.
- `equipment` and `terminal` also serve as network endpoints.
- `from` / `to` on curves reference the connected port via `host_id:port_name` (or bare `host_id` for passive fittings). See [`mep-port-conventions.md`](mep-port-conventions.md).

AI authoring: draw curves → call CLI `validate`/`resolve-topology` → auto-generates nodes and fills connectivity.

Revit export: fittings/accessories exported as `mep_node`. Curve endpoints taken from `Connector.Origin` (not `LocationCurve`), naturally coinciding with node positions.

**Editor action**: Render MEP network as graph. Curve endpoints should visually connect to node positions. Support resolve-topology validation.

### Mesh Category: Enum → String

`mesh.category` changed from enum (`railing`, `generic_model`, etc.) to free-form string containing Revit's category name.

ID prefix changed: `mesh-1` → `ms-1`

**Editor action**: Display category as text. Remove enum validation.

### Project Metadata

New file `project_metadata.json` at project root:

```json
{
  "format_version": "3.0",
  "project_name": "My Project",
  "units": "meters",
  "source": "Revit 2026"
}
```

Schema defined in `spec/project_metadata.schema.yaml`.

**Editor action**: Read `format_version` to detect spec version. Display project name. Validate format compatibility.

### Partitioning Rules Clarified

Elements are partitioned into level directories vs `global/`:

- **Level directory**: Elements whose `top_level_id` is at most one level above their base level (normal single-story elements)
- **Global directory**: Elements whose `top_level_id` is **more than one level above** their base (true multi-story elements), plus elements without `level_id`, plus `level.csv` and `grid.csv`

Before: any element without level_id went to global. Now: the rule is based on level index gap.

**Editor action**: When loading a project, read both level directories and `global/` directory. Merge global elements into the appropriate level views.

### Directory Typo Fixed

`spec/csv-schema/architechture/` → `spec/csv-schema/architecture/`

**Editor action**: Update any hardcoded paths referencing the old directory name.

### New ID Prefixes

| Element | Old Prefix | New Prefix |
|---------|-----------|------------|
| foundation | `if`/`sf`/`rf` | `f` |
| mesh | `mesh` | `ms` |
| ramp | (new) | `rp` |
| railing | (new) | `rl` |
| room_separator | (new) | `rs` |
| curtain_wall | (new) | `cw` |
| mep_node | (new) | `mn` |

### LLM Classification (New Feature — Design Only)

A planned feature for LLM-based classification of Revit family parameters and material names. See `spec/llm-classification.md` for the design document. Not yet implemented — no editor action needed yet.

---

## Version 2.0 (Previous — commit `f1c93ef`)

These changes were made before v3.0 and should already be implemented in the editor.

### Hosted Elements Become CSV-Only

Doors and windows changed from SVG-rendered elements to CSV-only with parametric position:
- `position`: 0.0–1.0 normalized parameter along host wall (center of opening)
- `host_id`: reference to host wall element

SVG representation was `<line data-host="w-1">` with white stroke to show openings. This was replaced with pure CSV data.

### Space Changed to Seed Point

Space (room) changed from polygon (`<polygon>` in SVG) to seed point:
- CSV fields: `x`, `y` (interior point), `name`
- Boundary auto-derived from walls and room separators

### Wall Thickness Source of Truth

`wall.thickness` is `required: true` in CSV (source of truth). SVG `stroke-width` may visually represent thickness but CSV overrides on conflict. CLI auto-heals SVG to match CSV.

### Material Enum

`materialized.material` changed from free-text string to fixed enum: `concrete`, `steel`, `wood`, `clt`, `glass`, `aluminum`, `brick`, `stone`, `gypsum`, `insulation`, `copper`, `pvc`, `ceramic`, `fiber_cement`, `composite`.

### Room Separator Added

New element `room_separator` (line_element, no extra fields). Used to define room boundaries where no physical wall exists. Was spec-only in v2; fully implemented in v3.

### Roof, Ceiling, Opening Added (v2.5 — commit `2c58336`)

- `roof`: polygon_element + materialized, fields: `roof_type` (enum), `slope`, `thickness`
- `ceiling`: polygon_element + materialized, fields: `height_offset`
- `opening`: hosted_element on wall, fields: `width`, `height`, `shape`
- `mesh`: fallback for elements without parametric schema, fields: `category` (was enum), `mesh_file` (GLB path), position/rotation

### Defaults

- `base_offset` defaults to 0
- `top_level_id` empty means next level above current level
- IDs are level-scoped (unique within each level directory)

---

## Version 1.0 (Original)

Original spec with:
- SVG `<line>` for line elements, `<rect>`/`<circle>` for points, `<polygon>` for polygons
- All elements had SVG representation (including doors, windows, spaces)
- Separate foundation types (isolated, strip, raft)
- Free-text material field
- No room_separator, roof, ceiling, opening, mesh
- No project metadata
