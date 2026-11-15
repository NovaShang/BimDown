# BIM Modeling SOP

> For creating BimDown models from existing designs. Focuses on creation order, dependencies, and pitfalls.

## Core Principles

1. **Bottom-up**: lowest floor first
2. **Outside-in**: exterior walls → interior walls
3. **Skeleton first**: walls/slabs → doors/windows/spaces
4. **Validate frequently**: `bimdown build` + `bimdown render` after each element type
5. **One floor, then replicate**: complete typical floor → copy to others

## Element Creation Order

```
1. global/level.csv         ← MUST be first
2. global/grid.csv          ← recommended second
3. wall.csv + wall.geojson          ← depends on level
   ├─ door.csv              ← depends on wall (host_id)
   ├─ window.csv            ← depends on wall (host_id)
   └─ opening.csv           ← depends on wall or slab
4. column.csv + column.geojson        ← independent
5. slab.csv + slab.geojson          ← needs wall outline known
6. space.csv                ← needs walls enclosed (build computes boundary)
7. stair, ramp, railing     ← independent
8. ceiling, roof            ← roof in the topmost (roof) level dir, caps wall tops
9. structure_column, beam, structure_slab, foundation
10. MEP: duct/pipe/cable_tray/conduit, equipment, terminal
11. bimdown resolve-topology ← LAST for MEP
```

## Per-Element Guide

### level (`global/level.csv`)
Must be first. `elevation` = cumulative height from ground (0), in project units. Basements negative. Directory name = level id (e.g., `lv-1`, `lv-B1`, `lv-R`).

**Pitfall**: using floor height instead of cumulative elevation.

### grid (`global/grid.csv`)
X-direction grids (vertical lines): `start_x = end_x`. Y-direction grids (horizontal): `start_y = end_y`. Extend 2–5m beyond building.

**Pitfall**: confusing X/Y — X-grids are vertical lines (constant x).

### wall (`lv-N/wall.csv` + `.geojson`)
Most critical element. One wall = one straight line (`LineString` with 2 coordinates). Never split for doors/windows. Endpoints must align exactly at junctions — even 0.001m gap breaks space computation. `thickness` lives in CSV.

**Order**: exterior → core → major interior → partitions. Render immediately after.

**Pitfalls**: endpoints not aligned, splitting walls at doors.

### door (`lv-N/door.csv` — CSV only)
**Recommended**: use `host_x, host_y` (2D coordinate of door center) — `bimdown build` auto-resolves to nearest wall + position. Alternative: manual `host_id` + `position` (distance from wall start to center). Validate: `position ± width/2` within wall length. No overlaps on same wall.

**Before placing doors, write a room connectivity graph** (e.g., `Stair→Corridor→Office`, `Corridor→Meeting Room`). Each connection = one door. Verify every room traces back to a stair/elevator.

**Pitfalls**: missing connections (room inaccessible), host_x/host_y too far from any wall (>5cm).

### window (`lv-N/window.csv` — CSV only)
Same rules as door. **Always set `base_offset`** = sill height (standard 0.9m). Omitting it puts windows at floor level.

### slab (`lv-N/slab.csv` + `.geojson`)
Polygon matching exterior wall outline. `function`: floor/roof. Account for shaft openings. Optional `boundary_walls` (`w-1;w-2;…`) + `boundary_face` (core default): the editor keeps the outline on those walls when they move.

**Pitfall**: polygon not matching wall outline, forgetting openings.

### column (`lv-N/column.csv` + `.geojson`)
GeoJSON `Point` coordinates are the **center** of the column. Section attributes live in CSV: `shape` (rect/round), `size_x`, `size_y`. For a rotated rectangle, add `properties.rotation` (degrees CCW).

**Tip**: You can also write the column as a 4-vertex `Polygon` — `bimdown build` extracts the rotation and section dimensions and normalizes it to a `Point` + CSV section fields.

### space (`lv-N/space.csv` — CSV only)
Seed point (x,y) inside enclosed room + `name`. `bimdown build` computes boundary. One seed per enclosed area: a second one is a redundant room (area 0, warning) — split the area with a wall or room_separator.

**Pitfall**: seed point on/outside wall, room not fully enclosed.

### stair (`lv-N/stair.csv` + `.geojson`)
Spatial 3D `LineString` (start point at bottom of run, end point at top). CSV: `width`, `step_count`.
- Multi-run (L/U): the stair line is run 1; more flights = `stair_run` rows (`host_id`, `width`, `step_count`, 3D line), platforms = `stair_landing` polygons (`host_id`, `base_offset` = landing top = top of the run arriving on it). Runs stop at the landing edge.
- All risers equal: riser = total rise / total `step_count`; each run's Z = its share. Going = run length / its `step_count`.
- Rules (build warns): riser 0.15–0.19, going ≥ 0.26, 2R+G 0.60–0.65, width ≥ 0.9. Example: 3.0 m rise → 18 risers × 0.167, runs 9 × 0.28 = 2.52 m.
- Same stair on every floor: draw it once on the lowest level with `multistory_top_level_id` = top level (riser adapts per storey).
- Railings: `railing.csv` rows `host_id` = stair, `side` = left|right, NO geometry (path follows runs and landings). One per side.
- Guard on a slab edge: railing with a 3D LineString + `host_id` = slab (stands on the slab top). Railing types: `type_id` = `rlt-steel-1000`, `rlt-steel-1100`, `rlt-glass-1000`, `rlt-timber-900` (global/railing_type.csv).

### curtain_wall, ceiling, roof
- Curtain wall: line element like wall. Even grid: `v_grid_count` columns × `u_grid_count` rows (cell counts).
- Uneven grid: `v_grids` = vertical lines as distances from the start, `u_grids` = horizontal lines as heights above the base, `;`-separated (`1.5;3.3;4.8`); they override the counts.
- Panels: `panels` = `col:row=kind;…` (0-based from start / bottom, `*` = all), kinds `glass` (default), `solid` (spandrel, `solid_material`), `door`, `double_door`, `empty`. E.g. `*:1=solid;2:0=door`. Door panels' marks: `door_numbers` `D105;…` in cell order. Door / window / room numbers must be unique project-wide (build warns): level N uses D/W N01…
- A curtain wall door: make the bottom-row cell the door width (`v_grids`) and door height (first `u_grids`), set it `door`; don't host a `door` row on it. Mullions: `mullion_width`/`mullion_depth`/`mullion_profile` (rect/round).
- Curtain wall in a wall (shopfront in a façade): draw it on the wall's centre line; it cuts the wall over its length and height (embedded, no `opening` row).
- Ceiling: polygon, `height_offset` above level
- Roof: polygon, `roof_type` (flat/gable/hip/shed/mansard), `slope` in degrees. Place it in the TOPMOST level's dir (roof level, e.g. `lv-R`) so it caps the wall tops — a roof in an occupied floor's dir anchors to that floor's elevation and is buried mid-building.
- Roof outline = eave line incl. overhang (wall exterior face + 0.3–0.6 m); `base_offset` = underside at the eave (wall top − overhang·tan slope). Any footprint (L / T / U) is exact.
- Per-edge slopes: `edge_slopes` = one value per polygon edge (`;`, edge i = vertex i→i+1, 0 = gable end), e.g. L gable `35;35;0;35;35;0`. Flat roof drainage: `1.2;0;0;0`. Barrel / custom: `roof_type` extrusion + `profile` `u,z;u,z` across edge 1.
- Walls under a roof: set `top_attach_id` = roof id (any level) — the wall top follows the roof underside (gable triangles, no manual top_offset). Same for walls under a slab.
- Skylight / dormer opening: `opening` Polygon with `host_id` = roof (or slab). Shaft through floors: `opening` Polygon with `top_level_id` (+`top_offset`), no host, cuts every slab/roof it spans — one row, not one per level.

### Structure (structure_column, structure_wall, beam, structure_slab, foundation)
Follow the vertical conventions in SKILL.md §2. In short:
- structure_column / structure_wall: from level + `base_offset` to `top_level_id` + `top_offset`. A basement column usually runs from the raft or cap top to the underside or top of the floor above; set `top_offset` accordingly.
- beam: 3D `LineString` whose z is the **top of the beam**; `size_x` = width, `size_y` = depth. A beam flush with the slab it carries has z = slab top. Keep one beam per span or per continuous run, and put its mark in `number`.
- structure_slab: polygon whose `base_offset` places the **top face**; `thickness` hangs down. Split slabs where thickness or top level changes; cut shafts as holes.
- foundation: `base_offset` places the **top face**, `thickness` hangs down. Polygon = raft zone, pile cap or pad (use the real footprint); LineString + `width` = strip footing; Point = pile. Model each raft zone with a different top or thickness as its own polygon.
- Pits and sumps: pit floor as a `foundation` polygon (top = pit bottom) plus `structure_wall` pit walls.

Verify elevations with `bimdown query <dir> "SELECT id, number, bbox_min_z, bbox_max_z FROM <table>"` — the plan render does not show Z.

### MEP (duct, pipe, cable_tray, conduit)
Spatial 3D `LineString` elements. CSV: `shape` (rect/round), `size_x` (/`size_y`), `system_type`. Align endpoints to create connections. Run `bimdown resolve-topology` after all MEP placed.

#### `system_type` standard abbreviations

Use these tags for the `system_type` column. Editors will color MEP lines by
system_type (consistent color per string). Stick to the canonical short form so
elements at different scales / files keep the same color.

**HVAC**
| Tag | Meaning |
|-----|---------|
| SA  | Supply Air |
| RA  | Return Air |
| EA  | Exhaust Air |
| OA  | Outdoor Air |
| CHWS| Chilled Water Supply |
| CHWR| Chilled Water Return |
| HWS | Heating Hot Water Supply |
| HWR | Heating Hot Water Return |
| CWS | Condenser Water Supply |
| CWR | Condenser Water Return |
| RF  | Refrigerant |
| SF  | Steam Feed |
| GE  | General Exhaust |

**Plumbing**
| Tag | Meaning |
|-----|---------|
| DW  | Domestic Water (potable) |
| DCW | Domestic Cold Water |
| DHW | Domestic Hot Water |
| DHWR| Domestic Hot Water Return |
| SS  | Sanitary Sewer |
| VENT| Vent Stack |
| SD  | Storm Drain |
| GAS | Natural Gas |

**Electrical / Low-voltage**
| Tag | Meaning |
|-----|---------|
| NP  | Normal Power |
| EM  | Emergency Power |
| LV  | Low Voltage |
| HV  | High Voltage |
| DATA| Data / Network |
| FA  | Fire Alarm |
| SEC | Security |

Custom or project-specific systems are allowed (any short string), but reuse a
single spelling across the project so the auto-coloring stays consistent.

### equipment & terminal
Point elements. `equipment_type`: ahu, fcu, chiller, boiler, cooling_tower, fan, pump, transformer, panelboard, generator, water_heater, tank, other. `terminal_type`: supply_air_diffuser, return_air_grille, exhaust_air_grille, sprinkler_head, fire_alarm_device, light_fixture, power_outlet, data_outlet, plumbing_fixture, other.

## Multi-Story Efficiency

1. Complete typical floor (usually lv-2) → validate → copy CSV+GeoJSON to other `lv-N/` dirs
2. IDs are level-scoped — same `w-1` in different levels = different elements
3. Modify non-standard floors: GF lobby, top floor mechanical/roof, basement parking

## Common Build Errors

| Error | Fix |
|-------|-----|
| Unconnected wall endpoint (warning) | The end touches no wall, wall face or column. Close it where rooms must close; free ends of retaining, pit or free-standing walls are fine |
| Door/window out of bounds | Recalculate position or reduce width |
| Overlapping openings | Adjust positions on same wall (a window above a door is fine) |
| Walls overlap | Two walls on one line: delete or shorten one |
| Redundant room | Two seeds in one area: delete one or add a room_separator |
| must be greater than 0 (validate) | Thickness / width / size must be positive (or empty to inherit the type) |
| Space seed not enclosed | Move seed point inside or close wall gaps |
| Unknown column in CSV | Remove computed field from CSV |
| GeoJSON id not in CSV | Add CSV row or remove GeoJSON Feature |

## Final Checklist

- [ ] `bimdown build` — zero errors; remaining warnings understood (free wall ends are OK where no room must close)
- [ ] Elevations checked with `bimdown query … bbox_min_z, bbox_max_z` (slabs, beams, foundations, columns)
- [ ] `bimdown render` every floor — visually correct
- [ ] `bimdown info` — counts reasonable, no empty levels
- [ ] All rooms connected per connectivity graph (every room traces to stair/elevator via doors)
- [ ] Windows have `base_offset` set (sill height)
- [ ] Slabs cover full footprint per level
- [ ] MEP topology resolved (if applicable)
- [ ] `bimdown publish` — only if the user asked for a share link
