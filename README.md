# BimDown

[![NPM Version](https://img.shields.io/npm/v/bimdown-cli.svg)](https://www.npmjs.com/package/bimdown-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI Status](https://github.com/NovaShang/BimDown/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaShang/BimDown/actions)

[中文文档](./README.zh-CN.md)

An open-source, AI-native building data format and **AI Agent Skill for BIM** — with **full round-trip support for Autodesk Revit**.

BimDown uses **CSV** for attributes and a **geometry layer** that can be encoded as either **SVG** (2D) or **GeoJSON** (2D/3D) — simple enough for any LLM to read and write, structured enough for real BIM workflows. Both geometry encodings are first-class and interchangeable; GeoJSON is the default for new projects. The included Revit add-in enables **bidirectional sync**: export from Revit to BimDown, let AI agents modify the data, then import back into Revit with changes preserved.

## Use with AI Agents (BIM Skill)

BimDown is designed to be natively operated by AI agents like **OpenClaw**, **Claude Code**, **Gemini CLI**, **Cursor**, **VS Code with Copilot**, **Antigravity**, and any other agent that supports agent skills / custom instructions. By installing the **BimDown AI Agent Skill**, your LLM learns the full BIM schema, coordinate rules, and CLI usage — enabling it to create, query, and modify building models autonomously.

### Setup

Copy and paste the following into your AI chat:

> Install the BimDown CLI: `npm install -g bimdown-cli`. Download the skill file from https://raw.githubusercontent.com/NovaShang/BimDown/main/agent-skill/SKILL.md and install it to `<your-global-skill-directory>/bimdown/SKILL.md`.

### What the Agent Can Do

Once configured, the agent can:
- Create building floor plans from natural language descriptions
- Query building data with SQL (e.g. "find all walls thicker than 0.3m")
- Modify geometry and attributes, then validate the result
- Render visual blueprints for review

### Custom Skills

To add custom domain capabilities (e.g. energy modeling, ESG reports), generate your own skill definition:

```bash
bimdown generate-skill
```

## Revit Round-Trip

The `revit-addin/` directory contains a C# add-in for Autodesk Revit 2025+ that enables **bidirectional sync** between Revit models and BimDown format:

- **Export**: Revit model -> BimDown (CSV + SVG or GeoJSON files)
- **Import**: BimDown (CSV + SVG or GeoJSON files) -> Revit model
- **Round-trip**: Export, edit with AI or by hand, import back — changes are applied to the original Revit model

**Installation**:
Download the latest `BimDownInstaller.exe` from the [GitHub Releases](https://github.com/NovaShang/BimDown/releases) page and run it.

**Manual Build (Windows)**:
```powershell
cd revit-addin
.\publish.ps1
```

## CLI

```bash
npm install -g bimdown-cli
```

### Project Management

```bash
bimdown init ./my-project               # create a new BimDown project
bimdown build ./my-project               # validate & compute boundaries (alias: validate)
bimdown info ./my-project                # print project summary (levels, element counts)
```

### Querying

BimDown loads all CSV files into an in-memory DuckDB database, with geometry fields (length, area, start/end coordinates) auto-computed from the geometry layer (SVG or GeoJSON). Query with standard SQL:

```bash
# List all walls and their lengths
bimdown query ./my-project "SELECT id, material, length FROM wall"

# Find thick walls
bimdown query ./my-project "SELECT id, thickness FROM wall WHERE thickness > 0.3"

# Count doors per level
bimdown query ./my-project "SELECT level_id, COUNT(*) FROM door GROUP BY level_id"

# JSON output for scripting
bimdown query ./my-project "SELECT * FROM wall" --json
```

### Schema Inspection

```bash
bimdown schema              # list all element types and their fields
bimdown schema wall          # show fields for a specific element type
```

### Rendering

```bash
bimdown render ./my-project                     # render lv-1 to render.svg
bimdown render ./my-project -l lv-3             # render a specific level
bimdown render ./my-project -o blueprint.svg    # custom output path
```

### Diffing & Merging

```bash
bimdown diff ./project-v1 ./project-v2          # show structural differences (+, -, ~)
bimdown merge ./projectA ./projectB -o ./merged  # merge projects, resolving ID conflicts
```

### Publishing

```bash
bimdown publish ./my-project          # publish to BimClaw and get a shareable link
```

### MEP Topology

```bash
bimdown resolve-topology ./my-project   # auto-detect coincident endpoints,
                                         # generate mep_nodes, fill connectivity
```

### Sync

```bash
bimdown sync ./my-project   # hydrate into DuckDB, then dehydrate back to CSV + SVG/GeoJSON
```

## Quick Look

```
project/
  project_metadata.json         # format_version (1 = SVG, 2 = GeoJSON), project name, units
  global/
    level.csv                   # building levels
    grid.csv                    # structural grids
  lv-1/
    wall.csv + wall.geojson     # walls (CSV attributes + geometry; .svg in a v1 project)
    door.csv                    # doors (CSV-only, parametric position on wall)
    slab.csv + slab.geojson     # floor slabs
    space.csv                   # rooms (seed point + name)
    ...
```

The CSV attribute layer is identical regardless of encoding:

**wall.csv**
```csv
id,material,thickness
w-1,concrete,0.2
w-2,concrete,0.2
```

The geometry layer is either GeoJSON **or** SVG:

**wall.geojson** (`format_version: 2`, default)
```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "id": "w-1" },
      "geometry": { "type": "LineString", "coordinates": [[0,0],[10,0]] } },
    { "type": "Feature", "properties": { "id": "w-2" },
      "geometry": { "type": "LineString", "coordinates": [[10,0],[10,8]] } }
  ]
}
```

**wall.svg** (`format_version: 1`)
```xml
<svg xmlns="http://www.w3.org/2000/svg">
  <g transform="scale(1,-1)">
    <path id="w-1" d="M 0,0 L 10,0" />
    <path id="w-2" d="M 10,0 L 10,8" />
  </g>
</svg>
```

**door.csv** (no geometry file in either encoding — position is parametric)
```csv
id,host_id,position,width,height,operation
d-1,w-1,3.0,0.9,2.1,single_swing
```

## Positioning

BimDown is a **LOD 200 lightweight alternative to Revit**, targeting the schematic design phase. It captures building elements at the level of "what, where, and how big" — not "how exactly it's constructed."

Use BimDown when you need:
- AI agents to read, write, and reason about building data directly
- **Round-trip interop with Revit** — export, edit (by human or AI), import back
- Git-based version control and diffing for building models
- SQL queries over building data (via DuckDB)
- A lightweight interchange format between design tools

Use Revit (or other full BIM tools) when you need:
- Construction-level detail (LOD 300+)
- Multi-layer wall/slab assemblies
- Structural/energy analysis with physical material properties
- Construction documentation and detailing

## Format Spec

The full format specification lives in [`spec/`](./spec/). Key concepts:

- **All coordinates in meters**, Y-axis = North
- **IDs are level-scoped** — unique within each `lv-N/` directory
- **Hosted elements** (doors, windows, openings) use `host_id` + `position` (distance in meters from wall start)
- **Spaces** are seed points — boundary auto-derived from surrounding walls
- **Materials** use a fixed enum: `concrete, steel, wood, clt, glass, aluminum, brick, stone, gypsum, insulation, copper, pvc, ceramic, fiber_cement, composite`
- **Geometry layer** is SVG **or** GeoJSON, selected by `format_version` (`1` = SVG, `2` = GeoJSON):
  - **GeoJSON** (default): `Point` / `LineString` / `Polygon` (no Multi\*); 2D and 3D coordinates
  - **SVG**: `<path>` (M, L, A commands), `<rect>`, `<circle>`, `<polygon>` — no Bezier curves; 2D only
- **Mesh fallback** — any element can have an optional `mesh_file` (GLB) for 3D visualization
- **MEP topology** — bipartite graph of curves and nodes, auto-resolved by CLI

### Element Types

| Category | Elements |
|---|---|
| Architecture | wall, column, slab, door, window, opening, space, stair, ramp, railing, curtain_wall, ceiling, roof, room_separator |
| Structure | structure_wall, structure_column, structure_slab, beam, brace, foundation |
| MEP | duct, pipe, cable_tray, conduit, equipment, terminal, mep_node |
| Other | level, grid, mesh (non-parametric fallback) |

## What BimDown Cannot Represent

The following Revit scenarios fall outside BimDown's scope and will be exported as `mesh` (GLB fallback) or lost:

### Geometry Limitations
- **Free-form / NURBS geometry** — conceptual mass, adaptive components, in-place families with complex shapes
- **Non-circular curved walls** — elliptical arcs, spline walls (circular arcs are supported)
- **Sloped slabs** — sub-element shape editing, slope arrows, variable-thickness slabs
- **Edited wall profiles** — non-rectangular wall sections (e.g. gable walls with sloped tops)
- **Per-panel curtain wall detail** — individual panel materials, embedded doors, non-rectangular panels

### Data Limitations
- **Multi-layer assemblies** — wall/slab/roof layer composition (core, finish, insulation layers)
- **Family types and parameters** — Revit type system, instance parameters, formulas, constraints
- **Phases** — existing/demolish/new construction phasing
- **Design options** — alternative design scenarios in the same model
- **Groups and arrays** — repeated element patterns
- **Nested families** — families containing other families
- **Worksets and linked models** — multi-user collaboration, cross-model references

### Discipline Limitations
- **Structural analysis** — loads, boundary conditions, rebar detailing
- **MEP calculations** — flow rates, pressure drops, electrical loads, heating/cooling loads
- **Energy modeling** — thermal properties (U-values, SHGC), occupancy schedules (geometry is sufficient but thermal attributes are missing)
- **Site and topography** — toposolids, property lines, site components
- **Furniture and fixtures** — exported as `mesh` (GLB) rather than parametric elements
- **Views and sheets** — sections, elevations, detail views, annotation, dimensions, schedules

## Related Projects

- **[bimdown-editor](https://github.com/nicepkg/bimdown-editor)** — browser-based 2D/3D building editor
- **[BimClaw](https://bim-claw.com)** — SaaS platform with hosted AI agent, real-time collaboration, and domain-specific analysis tools

## License

MIT
