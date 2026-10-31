---
name: bimdown
version: 2.1.0
description: Read, create and edit BIM models in the BimDown format (CSV attributes + GeoJSON geometry, one folder per level) with the `bimdown` CLI — architecture, structure, foundations and MEP. Use when asked to build a building model from drawings or a brief, to query or check an existing BimDown project, or when a task mentions BimDown / bim.jouledown.com / BimClaw.
metadata:
  {
    "openclaw": {
      "emoji": "🏛️",
      "requires": {
        "bins": ["bimdown"],
        "install": { "npm": "bimdown-cli" }
      },
      "optionalEnv": ["BIMDOWN_API"],
      "network": {
        "publish": {
          "endpoint": "https://bim.jouledown.com/api/shares/publish",
          "method": "POST",
          "description": "Optional sharing step. Uploads project CSV/GeoJSON/GLB files as a zip to bim.jouledown.com and returns a public share URL. Anonymous (no account or token required). The agent MUST ask the user for explicit permission before the first publish of any given project.",
          "override": "Set BIMDOWN_API (or the older BIMCLAW_API) to point at a different backend (self-hosted)."
        }
      }
    }
  }
---

# BimDown

BimDown is a plain-text BIM format: **CSV for attributes, GeoJSON for geometry**, one directory per level. You create a model by writing files (usually from a script), then validate and inspect it with the `bimdown` CLI.

## Setup

`bimdown --version` must work. If it is missing, ask the user before running `npm install -g bimdown-cli`.

## 1. Project layout

```
project/
  project_metadata.json        { "format_version": 2, "units": "m" }
  global/
    level.csv                  id,number,name,elevation      ← Z source of truth
    grid.csv                   id,number,start_x,start_y,end_x,end_y
    <table>.csv/.geojson       elements spanning more than one level (multi-storey walls, risers)
  lv-B1/                       one directory per level; the directory name IS the level id
    wall.csv + wall.geojson
    door.csv                   hosted: CSV only
    foundation.csv + foundation.geojson
    ...
  lv-1/
    beam.csv + beam.geojson
    structure_slab.csv + structure_slab.geojson
```

- `project_metadata.json` takes only the known keys (`format_version`, `units`, …); unknown keys such as `name` fail `build`.
- Start with `bimdown init <dir>`, then edit `global/level.csv` (elevations are absolute, basements negative) and `global/grid.csv`.
- An element's base level is **always the directory it is in**. Put it in the level it starts from; only elements spanning more than one level go to `global/`.
- **Units**: use the units `project_metadata.json` declares (`m`, `ft`, `in`, `mm`; new project: the user's units, else `m`). Every number in every file is in that unit — never convert a project's declared units.
- **IDs**: `{prefix}-{n}` with digits (`w-12`, `sc-3`, `f-40`); `lv-*` / `gr-*` may use any suffix. IDs are unique per table **per level**. The CSV row and its GeoJSON Feature share the id (`properties.id`).
- Coordinates: project-local, `+X` east, `+Y` north, `+Z` up. No `crs`, no Y flip.

## 2. Vertical conventions (read this before writing any Z)

Most elements are **level-anchored**: their geometry is 2D and their height comes from the level elevation plus offsets. Framing and MEP are **spatial**: their geometry carries absolute Z.

| Table | Geometry | Bottom | Top |
|---|---|---|---|
| `wall`, `structure_wall`, `curtain_wall` | 2D LineString (centre line) | level + `base_offset` | `top_level_id` elevation + `top_offset` (default: next level up) |
| `column`, `structure_column` | 2D Point (centre) | level + `base_offset` | `top_level_id` elevation + `top_offset` |
| `slab`, `structure_slab` | 2D Polygon | top − `thickness` | **level + `base_offset` = TOP face** |
| `foundation` (raft, pad, pile cap, strip) | 2D Polygon / Point / LineString | top − `thickness` | **level + `base_offset` = TOP face** |
| `roof` | 2D Polygon | level + `base_offset` | (sits on top of the walls below) |
| `ceiling` | 2D Polygon | level + `height_offset` | — |
| `beam`, `brace` | **3D** LineString `[x, y, z]` | z − `size_y` | **z = TOP of the member** |
| `stair`, `ramp`, `railing` | 3D LineString | z of the walking surface (start = bottom of run) | |
| duct, pipe, cable_tray, conduit | 3D LineString | | z = **centre line** |
| `door`, `window`, `opening` | none (hosted) | **level** + `base_offset` (sill height above the level, not above the wall base) | + `height` |

So a 180 mm slab whose top is at −0.100 on level `lv-1` (elevation 0) is `base_offset: -0.1, thickness: 0.18`; a 300×700 beam whose top is flush with that slab has z = −0.1 and `size_y: 0.7`.

- **Offsets are relative to a level; spatial z is absolute.** `base_offset` / `top_offset` are added to a level elevation. The z in a beam/duct/ramp coordinate is the absolute elevation — the same number whatever level directory the element is in (a beam at elevation 3.95 in `lv-2` whose elevation is 4.2 has z = 3.95, not −0.25).
- `top_level_id` may be the element's own level with a negative `top_offset` (e.g. a pit wall in `lv-B1` from −5.9 to −4.9 is `base_offset: -1.5, top_level_id: lv-B1, top_offset: -0.5`). Use whichever reads more clearly.

`bimdown query` reports the resulting extents in `bbox_min_z` / `bbox_max_z` for every element — use it to check your elevations (see §6).

## 3. Where each field lives

| Field | Lives in |
|---|---|
| `id` | both (CSV row ↔ `properties.id`) |
| `base_offset`, `top_offset`, `arc`, `rotation`, `height_offset` | GeoJSON `properties` — **except hosted elements** (door / window / opening), which have no GeoJSON, so their `base_offset` is a CSV column |
| `base_level_id`, `top_level_id`, `host_id`, `position`, `thickness`, `size_x`, `size_y`, `shape`, `material`, `number`, enums | CSV |
| `length`, `area`, `height`, `x`, `y`, `start_*`, `end_*`, `points`, `volume`, `bbox_*`, `level_id` | **computed — never write them** |

Run `bimdown schema <table>` for the exact columns of any table. Use `number` for the element mark / type label you want to keep (e.g. `KL3(2) 300x700`, `FM甲1022`, `CT2`).

## 4. Geometry forms

```jsonc
// wall / structure_wall: centre line, exactly 2 points
{ "type": "Feature", "properties": { "id": "w-1" },
  "geometry": { "type": "LineString", "coordinates": [[0, 0], [8.4, 0]] } }

// curved wall: the 2 end points + arc (or write a tessellated polyline; build converts it)
{ "type": "Feature", "properties": { "id": "w-2", "arc": { "radius": 11.47, "large_arc": false, "sweep": true } },
  "geometry": { "type": "LineString", "coordinates": [[60, 10], [66, 20]] } }

// column: centre point; section in CSV (shape, size_x, size_y); rotation in degrees CCW in properties
{ "type": "Feature", "properties": { "id": "sc-1", "top_offset": -0.1 },
  "geometry": { "type": "Point", "coordinates": [8.4, 6.0] } }

// slab with a shaft opening: outer ring + hole rings
{ "type": "Feature", "properties": { "id": "ss-1", "base_offset": -0.1 },
  "geometry": { "type": "Polygon", "coordinates": [
    [[0, 0], [16.8, 0], [16.8, 12], [0, 12], [0, 0]],
    [[3, 3], [5, 3], [5, 6], [3, 6], [3, 3]] ] } }

// beam: 3D line at the top of the beam
{ "type": "Feature", "properties": { "id": "bm-1" },
  "geometry": { "type": "LineString", "coordinates": [[0, 6, -0.1], [8.4, 6, -0.1]] } }

// pile cap / pad footing: give the real footprint as a Polygon (unambiguous size and orientation)
{ "type": "Feature", "properties": { "id": "f-7", "base_offset": -0.6 },
  "geometry": { "type": "Polygon", "coordinates": [[[7.0, 4.6], [9.8, 4.6], [9.8, 7.4], [7.0, 7.4], [7.0, 4.6]]] } }
```

- **No Multi\* geometries.** A slab cut into disconnected pieces becomes separate Features with their own ids.
- **No boolean operations.** Elements may overlap (caps inside a raft, beams inside a slab, columns through beams) — that is normal and expected; do not carve one element out of another unless the drawing shows a real gap (e.g. a pour strip between two raft pieces, a shaft hole).
- `build` also accepts and normalises: tessellated arcs, columns written as 4-vertex polygons, unclosed rings, 3D coordinates on level-anchored elements with a constant Z.

## 5. Choosing tables

| You are modelling | Use |
|---|---|
| Partition / masonry / finish walls | `wall` |
| Concrete shear walls, retaining walls, core walls, pit walls | `structure_wall` (material concrete) |
| Architectural column casing | `column` |
| Structural columns | `structure_column` |
| Floor / roof slabs that are structure | `structure_slab` (`function`: floor / roof) |
| Finish floors, non-structural slabs | `slab` |
| Beams, girders | `beam` (`shape`, `size_x` = width, `size_y` = depth) |
| Raft / mat, slab-on-grade foundation, pile caps, pads, strip footings | `foundation` (Polygon for raft, caps and pads; LineString + `width` for strips) |
| Thickened raft zones / different raft levels | separate `foundation` polygons, each with its own `base_offset` and `thickness` |
| Sumps, lift pits | `foundation` polygon for the pit floor (its top = pit bottom) + `structure_wall` for the pit walls (negative `base_offset` / `top_offset`) |
| Pour strips / construction joints in a raft | their own `foundation` polygons, named in `number` |
| Piles | `foundation` Point or a small polygon per pile, or skip if not required |
| Car ramps | `ramp` (3D LineString + `width`) or sloped `structure_slab` pieces |
| Openings in walls | `door`, `window`, `opening` (hosted) |
| Shafts / holes in slabs | polygon holes in the slab |
| Room-closing lines without a wall | `room_separator` |
| Anything without a table | `mesh` (GLB) or the closest table + a clear `number` |

## 6. Workflow

1. **Read the brief or drawings first** and collect the numbers (grid, levels, sizes, elevations) before writing files.
2. **Generate the model from a script** (Python or Node) that holds the data and writes every CSV/GeoJSON. Re-running the script is how you fix things; hand-editing hundreds of rows is error-prone.
3. `bimdown build <dir>` after every generation. It validates the schema, snaps endpoints within 5 cm, normalises geometry and computes room boundaries. **Errors must be fixed; warnings are advice** (see below).
4. `bimdown render <dir> -l <level> -o /tmp/lv.png` and look at the image. Write renders **outside** the project directory. Render is a plan view of one level.
5. **Check Z with a query**, because the render is 2D:
   ```bash
   bimdown query <dir> "SELECT id, number, round(bbox_min_z,3) lo, round(bbox_max_z,3) hi FROM structure_slab ORDER BY hi"
   bimdown query <dir> "SELECT number, count(*) n FROM beam GROUP BY number"
   bimdown info <dir>
   ```
   SQL tips: `window`, `column` (and other SQL keywords) must be quoted: `SELECT * FROM "window"`. Computed fields (`length`, `area`, `height`, `bbox_*`) are available in queries.
6. Iterate until counts, plans and elevations are right.

**About build warnings**: "has no connected line element" means a wall end touches nothing — no other wall end, no other wall's body (a T-junction at its face counts as connected) and no column. That matters only where rooms must close (`space`); retaining, pit and free-standing walls may legitimately end free. Do not split or extend walls just to silence it. `build` also merges wall ends of the same level that are less than 5 cm apart and lists what it moved; anything farther apart is left exactly where you put it. Long warning lists are truncated — `bimdown build <dir> --verbose` prints all.

## 7. Doors and windows

Hosted on a wall, CSV only. Either give `host_id` + `position` (distance from the wall's start point to the opening centre), or give `host_x`, `host_y` (the opening centre) and let `build` resolve the nearest wall and position.

```csv
id,number,host_id,position,width,height,base_offset,operation,material
d-1,FM甲1022,w-3,1.5,1.0,2.2,0,single_swing,steel
```
```csv
id,number,host_id,position,width,height,base_offset,material
wn-1,C1515,w-7,4.2,1.5,1.5,0.9,aluminum
```

- `position ± width/2` must stay within the wall; openings on one wall must not overlap.
- `base_offset` is measured from the level elevation (like Revit's sill height), even when the host wall starts below the level. Windows: always set it (0.9 typical); 0 puts the window on the level.
- Put the drawing's mark (e.g. `FM甲1022`, `C1515`) in `number`.

## 8. CLI reference

| Command | Purpose |
|---|---|
| `bimdown init <dir>` | new empty project |
| `bimdown build <dir>` | validate, snap, normalise, compute spaces — run after every edit |
| `bimdown render <dir> [-l level] [-o out.png] [-w width]` | plan image of a level |
| `bimdown query <dir> "<sql>" [--json]` | DuckDB SQL over all tables incl. computed fields |
| `bimdown info <dir>` | element counts per level |
| `bimdown schema [table]` | columns and types of a table |
| `bimdown diff <a> <b>` / `merge <dirs…> -o <out>` / `sync <dir>` | compare / combine / normalise projects |
| `bimdown resolve-topology <dir>` | connect MEP runs (after all MEP is placed) |
| `bimdown publish <dir>` | upload for a 3D share link — **network; ask the user first** |

`publish` is the only network command. It uploads the whole project (CSV, GeoJSON, GLB, metadata) anonymously to `https://bim.jouledown.com/api/shares/publish` (override with `--api` or `BIMDOWN_API`); the link is public until it expires (default 7 days).

## 9. Typical values (metres — scale to the project's units)

| Element | Field | Typical |
|---|---|---|
| Partition wall | thickness | 0.1 – 0.2 |
| Exterior / retaining wall | thickness | 0.2 – 0.4 |
| Shear / core wall | thickness | 0.2 – 0.6 |
| Door | width × height | 0.9 × 2.1 (single), 1.5–1.8 × 2.1 (double) |
| Window | width × height, sill | 1.2–1.8 × 1.5, `base_offset` 0.9 |
| Column | size_x × size_y | 0.4–0.8 |
| Beam | size_x × size_y | 0.25–0.4 × 0.5–0.9 |
| Floor slab | thickness | 0.12 – 0.25 |
| Raft | thickness | 0.4 – 1.5 |
| Storey height | Δ elevation | 3.0 – 4.5 |

## 10. Further reading

Read the SOP that matches your task before writing files (paths relative to this skill's directory):
- Modelling from existing drawings or plans → `references/bim-modeling.md`
- Designing a building from a brief → `references/building-design.md`

Format specification and Revit round-trip tooling: https://github.com/NovaShang/BimDown
