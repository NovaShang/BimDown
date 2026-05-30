# BimDown SVG Spec

SVG is one of **two interchangeable geometry storage layers** for BimDown — the other is [GeoJSON](../geojson-schema/readme.md). Both are first-class and fully supported; a project picks one, declared by `format_version` (see §7). The CSV attribute layer is identical regardless of which geometry encoding is used.

- **SVG** (`format_version: 1`): 2D geometry, the encoding documented here. AI models have extensive SVG training data and strong spatial reasoning with the format.
- **GeoJSON** (`format_version: 2`): 2D **and** 3D geometry, native JSON, GIS-toolchain compatible. The default for new projects and the encoding the BimClaw editor consumes.

Like GeoJSON, SVG here is **not** used for visualization — it is a structured geometry storage format. Renderers consume the parsed canonical element model, not the raw SVG.

A key structural difference: **SVG stores 2D geometry only.** Any Z information — level offsets and the absolute Z of spatial elements — lives in CSV columns (see §6). GeoJSON, by contrast, carries absolute Z in coordinates and Z offsets in feature `properties`.

---

## 1. File Organization

SVG files are co-located with their CSV counterparts, organized by level:

```text
{project-id}/
  {level}/
    wall.svg
    column.svg
    slab.svg
    ...
  global/
    wall.svg       (multi-story walls)
    ...
```

Each SVG file corresponds to one element table for one directory. Multi-story elements in `global/*.csv` have their SVG in `global/*.svg`. When rendering a floor plan, the CLI composites `global/` SVG onto the active level's view.

### Elements Without SVG

The following element types have **no SVG files**:
- `door`, `window` — Parametric placement via `host_id` + `position` on wall
- `space` — Seed point `(x, y)` in CSV; boundary auto-derived from walls
- `opening` (wall mode) — Parametric placement via `host_id` + `position`
- `level`, `grid` — Global reference data with coordinates in CSV
- `mesh` — 3D geometry in GLB files

---

## 2. Coordinate System

- **Origin**: Project Cartesian origin `(0, 0)`
- **Units**: Meters
- **Y-Axis**: Architectural convention (+Y = North). When rendering, apply `<g transform="scale(1, -1)">` to flip to SVG screen coordinates.

---

## 3. SVG Subset

### Allowed Elements

| SVG Element | BimDown Usage |
|-------------|---------------|
| `<svg>`, `<g>` | Structure and grouping |
| `<path>` | Line elements (walls, beams, ducts, stairs, ramps, railings, etc.) |
| `<rect>` | Point elements with rectangular profile |
| `<circle>` | Point elements with round profile |
| `<polygon>` | Polygon elements (slabs, ceilings, roofs, etc.) |
| `<text>` | Optional labels |

### Allowed `<path>` Commands

Only the following path commands are permitted:
- `M` / `m` — Move to (start point)
- `L` / `l` — Line to (straight segment)
- `A` / `a` — Arc to (circular arc segment)

**Bezier curves (`C`, `Q`, `S`, `T`) are forbidden.** Arcs cover the curved geometry needed in architecture (curved walls, ramps).

### Forbidden Features

- `<defs>`, `<use>`, gradients, filters, animations
- Embedded scripts (`<script>`)
- Bezier path commands

### Styling

The spec does **not** require or read any styling attributes (`stroke`, `stroke-width`, `fill`, etc.). AI may write them freely for valid SVG, but they are ignored on import. Only geometric attributes and `id` are meaningful.

---

## 4. Element Representation

Every SVG element **must** have an `id` attribute matching the CSV short ID (e.g. `w-1`, `c-3`).

### 4.1 Line Elements → `<path>`

Walls, beams, braces, ducts, pipes, stairs, ramps, railings, curtain walls, room separators, strip foundations.

```xml
<!-- Straight wall from (0,0) to (5,0) -->
<path id="w-1" d="M 0,0 L 5,0" />

<!-- Curved wall: arc from (0,0) to (5,0) -->
<path id="w-2" d="M 0,0 A 3,3 0 0,1 5,0" />
```

- Straight segments: `M x1,y1 L x2,y2`
- Arcs: `M x1,y1 A rx,ry rotation large-arc-flag sweep-flag x2,y2`
- One `<path>` per element (one-to-one mapping with CSV rows)

### 4.2 Point Elements → `<rect>` or `<circle>`

Columns, structure columns, equipment, terminals, mep_nodes, isolated foundations.

```xml
<!-- Rectangular column 0.4×0.4 at (2,2) -->
<rect id="c-1" x="1.8" y="1.8" width="0.4" height="0.4" />

<!-- Round column at (5,3) with radius 0.2 -->
<circle id="c-2" cx="5" cy="3" r="0.2" />

<!-- Rotated rectangular column -->
<rect id="c-3" x="1.8" y="1.8" width="0.4" height="0.6" transform="rotate(45, 2, 2.1)" />
```

- `shape = "round"` → `<circle>`, otherwise → `<rect>`
- Rotation via `transform="rotate(angle, center_x, center_y)"`

### 4.3 Polygon Elements → `<polygon>`

Slabs, structure slabs, ceilings, roofs, raft foundations, slab openings.

```xml
<!-- Floor slab -->
<polygon id="sl-1" points="0,0 10,0 10,8 0,8" />
```

- `points` attribute: space-separated `x,y` coordinate pairs

### 4.4 Foundation (Mixed Geometry)

A single `foundation` table uses different SVG elements depending on the form:
- Isolated (pad): `<rect>` or `<circle>` (point-based)
- Strip (continuous): `<path>` (line-based)
- Raft (mat): `<polygon>` (polygon-based)

```xml
<!-- Isolated foundation -->
<rect id="f-1" x="0.4" y="0.4" width="1.2" height="1.2" />
<!-- Strip foundation -->
<path id="f-2" d="M 0,0 L 10,0" />
<!-- Raft foundation -->
<polygon id="f-3" points="0,0 10,0 10,8 0,8" />
```

### 4.5 Slab Opening

When `opening.host_id` references a slab, the opening has SVG geometry:

```xml
<!-- Rectangular slab opening -->
<rect id="op-1" x="3" y="3" width="2" height="1.5" />
<!-- Irregular slab opening -->
<polygon id="op-2" points="3,3 5,3 5,4.5 3,4.5" />
```

---

## 5. Computed Field Hydration

The CLI parses SVG elements and injects computed fields into DuckDB:

| SVG Element | Computed Fields |
|-------------|----------------|
| `<path>` (line) | `start_x`, `start_y`, `end_x`, `end_y`, `length` |
| `<rect>` | `x`, `y`, `size_x` (width), `size_y` (height), `rotation` |
| `<circle>` | `x` (cx), `y` (cy), `size_x` (2r), `size_y` (2r), `shape="round"` |
| `<polygon>` | `points` (serialized), `area` |

---

## 6. Attribute Split: SVG vs CSV

As in the GeoJSON encoding, **CSV is the attribute source of truth** — material, thickness, sizes, enums, foreign keys (`host_id`, `base_level_id`, `top_level_id`), and parametric placement (`position`) all live in CSV, unchanged.

The difference is in the **numeric geometry hints**. The GeoJSON encoding keeps these in feature `properties`; SVG has no per-feature property bag, so each hint maps as follows:

| Geometry hint | GeoJSON encoding | SVG encoding |
|---|---|---|
| Point orientation (`rotation`) | `properties.rotation` | `transform="rotate(angle, cx, cy)"` on `<rect>`/`<circle>` |
| Arc curvature (`arc`) | `properties.arc = {radius, large_arc, sweep}` | path `A rx,ry rot large-arc sweep x,y` command |
| Level Z offsets (`base_offset`, `top_offset`) | `properties.base_offset` / `top_offset` | **CSV columns** `base_offset` / `top_offset` (SVG carries no Z) |
| Absolute Z of spatial elements (beam, duct, …) | 3rd coordinate `[x, y, z]` | **CSV columns** `start_z` / `end_z` (SVG `<path>` is 2D) |

Everything else — `length`, `area`, `x`/`y`, `start_*`/`end_*` — is **computed** at hydrate time (§5), never stored, in both encodings.

> Rule of thumb when porting a field between encodings: geometry the SVG element can express *intrinsically* (2D position, arc, rotation) stays in SVG; any Z, and all non-geometric attributes, move to CSV.

---

## 7. Format Version

`project_metadata.json` declares the geometry encoding via `format_version`:

```json
{
  "format_version": 1,
  "project_name": "…",
  "units": "m",
  "source": "revit"
}
```

- `format_version: 1` — CSV + **SVG** (this spec). Fully supported.
- `format_version: 2` — CSV + **GeoJSON** (see [geojson-schema/readme.md](../geojson-schema/readme.md)). Fully supported; default for new projects.

Both encodings are maintained; neither is deprecated. Tools may also detect the encoding directly from the geometry files present (`*.svg` vs `*.geojson`). Conversion in either direction is lossless for the 2D subset; the `bimdown migrate` command and `scripts/svg-to-geojson.ts` convert SVG → GeoJSON (3D fidelity for spatial elements is gained, not lost, in that direction).
