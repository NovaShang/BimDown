# BimDown Revit Add-in

A Revit add-in for bidirectional BIM data exchange with the BimDown format (CSV attributes + GeoJSON geometry, `format_version: 2`, see `../spec/readme.md`). Export a model to a BimDown package (zip), edit it in BimDown Studio / the CLI / an AI agent, and import the changes back with a diff-based sync.

## Export (Revit → BimDown)

Elements are written in meters, partitioned into `global/` and `lv-N/` directories, with level-scoped short ids (`w-1`, `d-3`, …) and `_IdMap.csv` (Revit UniqueId ↔ short id). Element types get readable ids from their names (`wt-exterior-concrete-200-eps-100`).

| Area | Tables | Revit source |
|---|---|---|
| Global | `level`, `grid` (`pinned`) | Levels, Grids |
| Types (global/) | `wall_type`, `slab_type`, `roof_type`, `ceiling_type` + `type_layer` | WallType / FloorType / RoofType / CeilingType compound structure: one layer per CompoundStructureLayer (exterior / top first), function from the layer function (Structure → core, Thermal/Air or "air" material → air_gap, …), λ from the material's thermal asset; zero-thick membranes are dropped |
| | `door_type`, `window_type` | FamilySymbol: width / height, operation (family naming), frame width, analytical U-value / SHGC / VT |
| | `curtain_wall_type` | Curtain WallType: fixed grid spacings, interior mullion size / profile / material, panel material and thermal values |
| | `column_type`, `beam_type` | FamilySymbol section: StructuralSection API (I / T / L / C / RHS / CHS / bars / concrete) or family dimension parameters (bf, d, tf, tw, k, t, b, h, OD), catalogue `designation` (W14X90, HEA 300, HSS…, 14K1 → `open_web`), `root_radius`, `material_grade` (C30/37, S355, A992, Q355, GL24h) |
| | `foundation_type`, `furniture_type`, `railing_type` | isolated / wall / slab foundation types (kind, sizes), furniture family guess + bbox size, RailingType (top rail height / profile, balusters vs glass panels, spacing) |
| Architecture | `wall` / `structure_wall` | `type_id`, `thickness`, `top_attach_id` (Attach Top to a roof / floor). A wall whose exterior (Wall.Orientation) is right of its location line is written reversed, so the exterior face (type_layer seq 1) is on its left as the spec defines; hosted doors / windows / openings follow (position, hinge and swing mirrored) |
| | `slab`, `structure_slab`, `roof`, `ceiling` | `type_id`; `boundary_walls` / `boundary_face` / `boundary_offset` when the outline runs along the level's walls at one face (Revit "Pick Walls"); `structure_slab.span_direction` for metal decks |
| | `roof` | footprint roofs: `edge_slopes` per sketch edge ("Defines Slope" + slope), `roof_type` flat / shed / gable / hip; extrusion roofs: `roof_type=extrusion` + `profile` + footprint |
| | `door`, `window` | `type_id`, sill height as CSV `base_offset`, `number` from Mark; doors in curtain wall cells are not door rows (see `door_numbers`) |
| | `opening` | wall openings (sill `base_offset`), floor / roof openings, **shafts** (`top_level_id`, `top_offset`, no host), sketch holes in floors |
| | `curtain_wall` | explicit `u_grids` (horizontal lines, heights) / `v_grids` (vertical lines, distances), `panels` (`*:row=kind`, `col:row=kind`: solid / door / double_door / empty), `door_numbers` from the door panels' Marks |
| | `stair`, `stair_run`, `stair_landing` | stair by component: lowest run = the stair's own line, other runs = `stair_run`, landings = `stair_landing` (top as `base_offset`); `stair_type` from the run turns; multistory stairs export their lowest stair with `multistory_top_level_id` |
| | `railing` | on a stair: `host_id` + `side` (no geometry, path derived); on a floor: `host_id` + path; sketched: the full 3D path; `type_id` |
| | `furniture` | Furniture, Furniture Systems, Casework, Planting, Entourage, Parking, Specialty Equipment without MEP connectors: library `family` / `variant` guessed from the names (English / Chinese), else `generic_box`; point at the footprint centre, sizes from the family box, `mirror` |
| | `space`, `ramp`, `room_separator`, `column`, `model_group` | Rooms (seed point + name), ramps, room separation lines, architectural columns (rect / round), model groups (`group_id` on members) |
| Structure | `structure_column`, `beam`, `brace` | section + `material_grade` + `type_id`; beams of a beam system carry `beam_system_id` |
| | `beam_system` | Structural Beam System: bay polygon, spacing (fixed distance / maximum / clear / fixed number), direction, beam type |
| | `foundation` | `kind` pad / pile / pile_cap (Polygon at its real footprint) / strip (WallFoundation along its wall) / raft (foundation slab), `type_id`, `material_grade` |
| MEP | `duct`, `pipe`, `cable_tray`, `conduit` | connector-based endpoints, `from` / `to` port refs, `system_type` tag (system Abbreviation, else the classification's code: SA, RA, EA, CHWS, HWR, DCW, DHW, SAN, VENT, FP, …), `insulation_thickness`, `pipe.material` (pipe segment material), flex ducts / pipes (`duct.flexible`) |
| | `mep_node` | fittings: `fitting` from the part type (elbow, tee, wye, cross, transition, coupling, cap, tap); accessories: `kind` (gate / ball / butterfly / check / balancing valve, damper, fire damper, strainer, meter, sensor, …) + body size |
| | `equipment`, `terminal`, `connector` | `equipment_type` / `terminal_type` (incl. plumbing fixtures, fire alarm, data, lighting devices), `flow` (L/s), `load` (W), `circuit_id`; one `connector` row per port |
| | `circuit`, `mep_system` | power circuits (panel, number, load name, voltage, poles, rating); system types in use (tag, name, line colour, discipline) |
| Annotation | `text_note`, `tag`, `dimension` | from each level's main floor plan (the plan named like the level, else the first): text (paper size from the text type), element / room tags, linear dimensions (fixed points, chains as rows) |
| Fallback | `mesh` | Generic Models / topography / site as GLB |

Type inheritance: instance values equal to their type's are written empty (they inherit, as the spec requires), types no exported instance uses are dropped.

## Import (BimDown → Revit)

`ImportCommand` reads a package and diffs it against the model (update / create / delete). Ids are level-scoped, so rows, `_IdMap.csv` and references are matched by `directory/id`. Typed rows first inherit their type's values; then:

- **Types**: `wall_type` / `slab_type` / `roof_type` / `ceiling_type` become Revit types of the same name, built from `type_layer` (materials by name, created if missing); door / window / column / beam / foundation / furniture types are looked up by name (or designation), door / window types created at their size.
- Walls (`type_id`, Attach Top after roofs / floors exist), floors, ceilings, roofs (per-edge slopes from `edge_slopes` or the implied edges), doors / windows (sill), wall openings (sill), **shafts** (`NewOpening(bottom, top)`), curtain walls (named type + `u_grids` / `v_grids`).
- **Stairs**: the stair line + `stair_run` rows → straight runs in a StairsEditScope, automatic landings between them, multistory stairs connected up to `multistory_top_level_id`.
- **Railings**: on stairs (Revit creates both sides; each row takes its side) or sketched along the path.
- Beam systems (beams with `beam_system_id` are generated by them), duct / pipe insulation, furniture (named / guessed family, else a DirectShape box), power circuits, plan text notes and tags.
- Not imported: extrusion roofs, curtain panel kinds, model groups, dimensions, mep_system, connectors (ports come from the families), MEP fittings (Revit inserts them).

## Building

The add-in targets Revit 2026 / .NET 8 and builds against the Nice3point Revit API reference packages (`Nice3point.Revit.Api.RevitAPI` / `RevitAPIUI`, `ExcludeAssets=runtime`), so no Revit installation is needed to compile:

```bash
dotnet build BimDown.RevitAddin.csproj                       # Windows
dotnet build BimDown.RevitAddin.csproj -p:EnableWindowsTargeting=true   # macOS / Linux (compile only)
dotnet build BimDown.RevitAddin.csproj -p:RevitVersion=2025  # another Revit version (2027 needs net10)
```

## Tests

- `Mapping.Tests/` — cross-platform unit tests (xunit, `net8.0`, no Revit) of the pure mapping layer in `Mapping/` (materials, grades, layers, sections, roofs, curtain grids, stairs, furniture, foundations, MEP, wall direction and "Pick Walls" matching, type inheritance, annotations), `ShortIdGenerator` and `ProjectWriter`. `FixtureProjectTests` builds a two-storey project through the same code and runs `bimdown validate` on it:

  ```bash
  cd ../cli && npm run build && cd ../revit-addin
  BIMDOWN_CLI=$PWD/../cli/dist/cli.js dotnet test Mapping.Tests
  ```

  (`BIMDOWN_FIXTURE_DIR` keeps the written project.)
- `Tests/` — TUnit integration tests that run inside Revit 2026 (`Nice3point.TUnit.Revit`).

## Project Structure

```
revit-addin/
├── ExportCommand.cs / ImportCommand.cs / ShareCommand.cs   # IExternalCommands
├── ExportPipeline.cs        # Revit export: exporters → rows → ProjectWriter
├── ProjectWriter.cs         # pure: types, short ids, partitioning, CSV / GeoJSON / metadata
├── ShortIdGenerator.cs      # pure: UniqueId → short ids, reference rewriting
├── RevitReaders.cs          # Revit API → plain inputs of the mappers (meters, enum names)
├── ExportContext.cs         # per-export caches (walls per level, exported stairs)
├── Mapping/                 # pure mapping decisions (unit-tested without Revit)
├── Extractors/              # field extractors (element, line, point, polygon, hosted, MEP, …)
├── Tables/                  # table exporters (architecture, structure, MEP, types, annotations, stairs)
├── Import/                  # importers, diff, id map, type resolver, import context
├── Geojson/                 # GeoJSON writer / reader
├── Mapping.Tests/           # cross-platform unit + fixture tests
└── Tests/                   # in-Revit TUnit tests
```

## Installation

Copy `BimDown.addin` to `%AppData%\Autodesk\Revit\Addins\{version}\` and update the `<Assembly>` path to point to the built DLL (or use the installer in `Installer/`).
