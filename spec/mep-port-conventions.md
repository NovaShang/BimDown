# MEP Port Conventions

This document defines how MEP ports are named, what their `system_role` /
`flow_dir` / `domain` should be for common equipment, and how passive
fittings' implicit ports are derived from geometry.

**It is a guide for humans and LLMs, not a machine-readable library.** The
editor, CLI, and Revit add-in do **not** parse this file. Anything written
in `connector.csv` overrides whatever this document recommends.

## 1. Port identity

A port is identified by `host_id:name`. The pair `(host_id, name)` is
unique within a project.

- `host_id` — id of an `equipment`, `terminal`, or `mep_node` row
- `name` — string in `connector.name`, conventionally lowercase semantic
  (e.g. `supply`, `inlet`, `in`); falls back to `c0`, `c1`, … when no
  semantic name applies

MEP curves (`pipe` / `duct` / `conduit` / `cable_tray`) reference ports via
`from` and `to` columns. Examples:

```
pi-001.from = "eq-AHU-01:supply"
pi-001.to   = "eq-VAV-01:inlet"

pi-002.from = "eq-VAV-01:outlet"
pi-002.to   = "mn-007"        # passive elbow, bare host_id
```

## 2. Recommended port names by element kind

Names below are conventions, not enforced. Two principles:

- **Prefer semantic over directional**: write `supply` / `return` instead
  of `c0` / `c1` when the role is obvious.
- **Lowercase, snake_case**: `supply_air`, `condensate_drain`.

### 2.1 HVAC equipment

| Equipment | Typical ports | Notes |
|---|---|---|
| AHU (Air Handling Unit) | `chws`, `chwr` (or `supply`/`return` for hydronic), `sa`, `ra`, `oa`, `condensate` | 4-pipe AHUs add `hws`/`hwr` for hot water |
| FCU (Fan Coil Unit) | `supply`, `return`, `sa`, `ra`, `condensate` | Smaller cousin of AHU |
| VAV / VAV Box | `inlet`, `outlet`, optional `reheat_supply`/`reheat_return` for reheat coils | Air-side mostly |
| Chiller | `chws`, `chwr`, `cws`, `cwr` | Evaporator + condenser sides |
| Cooling tower | `cws`, `cwr`, `makeup`, `overflow` | |
| Boiler | `hws`, `hwr`, `gas_in`, `flue` | |
| Pump | `inlet`, `outlet` | Single in, single out |
| Fan | `inlet`, `outlet` | Air-side pump |

### 2.2 Plumbing equipment & fixtures

| Element | Typical ports |
|---|---|
| Water heater | `cold_in`, `hot_out`, `gas_in` (or `power_in` electric) |
| Tank | `inlet`, `outlet`, `drain`, `overflow`, `vent` |
| Water closet | `cold_in`, `drain`, optional `vent` |
| Lavatory | `cold_in`, `hot_in`, `drain`, `vent` |
| Floor drain | `drain`, optional `vent` |

### 2.3 Electrical equipment

| Equipment | Typical ports |
|---|---|
| Transformer | `primary_in`, `secondary_out` |
| Panelboard | `main_in`, `branch_1`, `branch_2`, … |
| Generator | `power_out`, `fuel_in` |
| Light fixture | `power_in` |
| Receptacle | `power_in` |
| Data outlet | `data_in` |

### 2.4 Terminals (air-side)

| Terminal | Typical port |
|---|---|
| Supply air diffuser | `inlet` (air enters from duct, exits to space) |
| Return air grille | `outlet` (air enters from space, exits to duct) |
| Exhaust air grille | `outlet` |
| Sprinkler head | `inlet` |

### 2.5 Active mep_node (accessories with explicit `kind`)

| Kind | Typical ports |
|---|---|
| `valve`, `damper` | `in`, `out` |
| `pump`, `fan` | `inlet`, `outlet` |
| `strainer`, `flow_meter`, `sensor`, `check_valve` | `in`, `out` |
| Multi-port mixing valve | `in1`, `in2`, `out` (or `cold_in`, `hot_in`, `mixed_out`) |

### 2.6 Passive mep_node (no `connector` rows)

Passive fittings (auto-elbow / tee / cross / coupling / cap / transition)
do **not** have `connector` rows. Pipes reference them by bare `host_id`:

```
pi-005.from = "mn-007"
pi-006.to   = "mn-007"
pi-007.from = "mn-007"      # tee with 3 incident pipes
```

The fitting kind is derived at runtime from the count and geometry of the
incident pipes (see §4).

## 3. Recommended `system_role` vocabulary

`system_role` is a semantic role that is **not stored on the connector**
(connector only has `system_type`), but is used in starter templates and
LLM prompts to map "I want a CHW supply port" to a project-specific
`system_type` tag like `CHWS`.

| Role | Meaning | Typical `system_type` tags |
|---|---|---|
| `chw_supply` | Chilled water supply | `CHWS` |
| `chw_return` | Chilled water return | `CHWR`, `CHR` |
| `cw_supply` | Condenser water supply | `CWS` |
| `cw_return` | Condenser water return | `CWR` |
| `hw_supply` | Hot water supply | `HWS` |
| `hw_return` | Hot water return | `HWR` |
| `dhw_supply` | Domestic hot water supply | `DHWS` |
| `dhw_recirc` | Domestic hot water recirculation | `DHWR` |
| `dcw` | Domestic cold water | `DCW`, `CW` |
| `sa` | Supply air | `SA` |
| `ra` | Return air | `RA` |
| `ea` | Exhaust air | `EA` |
| `oa` | Outdoor air | `OA` |
| `drain` | Sanitary drain / waste | `SAN`, `W` |
| `vent` | Sanitary vent | `V` |
| `condensate` | Equipment condensate drain | `CD` |
| `gas` | Natural gas / fuel | `G` |
| `fp_supply` | Fire protection supply | `FP` |
| `power` | Generic electrical power | `PWR` |
| `data` | Generic data / low-voltage | `DATA` |

## 4. Passive fitting derivation rules

For a passive `mep_node` (`kind=""`, no `connector` rows), the runtime
classifies it from the incident pipes:

| Incident pipes | Geometry | Classification |
|---|---|---|
| 1 | — | `cap` |
| 2 | collinear, equal size | `coupling` |
| 2 | collinear, unequal size | `reducer` |
| 2 | collinear, equal size + different shape | `transition` |
| 2 | non-collinear | `elbow` (any angle other than 0° / 180°) |
| 3 | — | `tee` |
| 4 | two pairs of collinear | `cross` |
| ≥ 5 | — | `manifold` or `custom` (warn) |

Geometric tolerances:

- Collinearity: angle between pipe directions ≤ 0.5°
- Equal size: difference ≤ 1 mm in `size_x` (round) or in both `size_x`
  and `size_y` (rect)

If a passive `mep_node` is degenerate (two incident pipes overlap with
indistinguishable directions, e.g. duplicate runs), CLI `validate` should
emit a warning — port identity becomes ambiguous.

## 5. Revit round-trip mapping

| BimDown | Revit |
|---|---|
| `connector.name` | Prefer `Connector.Description`; else derive `supply`/`return`/`inlet`/`outlet` from `Domain` + `Direction` + system semantics; else `c{ConnectorManager.index}` |
| `connector.flow_dir` | `Connector.Direction` (`In` → `in`, `Out` → `out`, `Bidirectional` → `bidirectional`) |
| `connector.domain` | `Connector.Domain` (`DomainHvac` → `hvac`, `DomainPiping` → `piping`, `DomainElectrical` → `electrical`, `DomainCableTrayConduit` → `cable_tray_conduit`) |
| `equipment.family` + `type` | `FamilySymbol.Family.Name` + `FamilySymbol.Name` |
| `terminal.family` + `type` | same |
| `mep_node.family` + `type` | same |
| pipe `from` / `to` | Resolve the connected `Connector.Owner.UniqueId`, look up its named port; on import, write back `OwnerUniqueId:name` |
| Passive `mep_node` (no connector rows) | `OST_PipeFitting`/`OST_DuctFitting` with `PartType ∈ {Elbow, Tee, Cross, Union, Cap, Transition}` — connectors exist in Revit but are not re-exported (geometry-derived) |
| Active `mep_node` (explicit `kind`) | `OST_PipeAccessory`/`OST_DuctAccessory` — connectors are exported as `connector.csv` rows |
