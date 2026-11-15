# BimDown CLI

Command-line tool for [BimDown](https://bim.jouledown.com), an open building data format (CSV attributes + GeoJSON or SVG geometry, one folder per level). Validates and builds projects, renders plans, loads models into DuckDB for SQL queries, diffs and merges, and publishes share links to bim.jouledown.com. Format spec and agent skill: [NovaShang/BimDown](https://github.com/NovaShang/BimDown).

## Install

```bash
npm install -g bimdown-cli
```

On npm 11+ the install may end with an `npm warn install-scripts … sharp@…` notice. It is harmless: sharp (used only for `bimdown render` PNG output) ships prebuilt binaries, so its skipped install check isn't needed.

From source:

```bash
cd cli
npm install
npm run build
```

## Commands

### `bimdown publish <dir>`

Uploads the project anonymously and prints a public share link on bim.jouledown.com (default expiry 7 days, `--expires 24h`). Override the server with `--api <url>` or `BIMDOWN_API`.

### `bimdown validate <dir>`

Validate a BimDown project directory. Checks directory structure, CSV headers/required fields/enums, ID format and uniqueness, foreign key references, and SVG strict subset compliance.

```bash
node dist/index.js validate ../sample_data/architectural
```

Output is one issue per line, prefixed with the file path:

```
lv-1/door.csv:3  id "x-1" has wrong prefix, expected "d-"
global/level.csv:5  required field "elevation" is empty
lv-2/wall.svg  forbidden tag <path> found
```

### `bimdown query <dir> <sql>`

Hydrate the project into an in-memory DuckDB instance and execute SQL. All CSV partitions are unioned into logical tables, and computed geometry columns are injected from SVG files.

```bash
# Tabular output
node dist/index.js query ../sample_data/architectural "SELECT id, material, length FROM wall WHERE length > 10 LIMIT 5"

# JSON output
node dist/index.js query ../sample_data/architectural "SELECT id, width FROM door LIMIT 3" --json
```

### `bimdown sync <dir>`

Hydrate into DuckDB, then dehydrate back to files — strips computed columns, re-partitions rows by level, and writes CSVs.

```bash
node dist/index.js sync ../sample_data/architectural
```

### `bimdown info <dir>`

Print project summary: levels with elevations, element counts per level, and totals.

```bash
node dist/index.js info ../sample_data/architectural
```

### `bimdown schema [table]`

Print the resolved schema for a table, showing CSV fields, computed fields, types, and constraints. Without a table it prints a short index (one line per table with its key fields); `--all` prints every table in full.

```bash
node dist/index.js schema wall
node dist/index.js schema        # index of all tables
node dist/index.js schema --all  # every table in full
```

### `bimdown import-ifc <file.ifc> <outdir>`

Convert an IFC2x3 / IFC4 model (Revit, ArchiCAD, …) into a new BimDown project with web-ifc: storeys become levels; walls (with layered wall types), curtain walls, doors / windows / openings hosted on their walls, slabs, roofs, ceilings, spaces, columns, beams, footings, stairs, railings, grids and MEP runs / fittings / terminals / equipment with their systems become BimDown elements. Wall ends are joined and room separators added so rooms close; then `build` runs and the report lists what was skipped (with reasons) and any room problems. `--json <path>` also writes the report. The same converter runs in the browser (Import IFC in the web app).

```bash
bimdown import-ifc Duplex_A.ifc ./duplex
```

## Development

```bash
npm run dev          # watch mode
npm test             # run vitest
npm run test:watch   # vitest watch mode
```

## Architecture

```
src/
  index.ts              # CLI entry point (commander)
  schema/
    types.ts            # TypeScript types for schema definitions
    loader.ts           # Parse YAML schemas, resolve mixin inheritance
    registry.ts         # Table registry: name -> resolved fields, prefix
  validate/
    index.ts            # Orchestrate all validation checks
    structure.ts        # Directory structure validation
    csv.ts              # CSV header, required field, enum validation
    ids.ts              # ID format + uniqueness validation
    svg.ts              # SVG strict subset validation
    references.ts       # Foreign key / reference validation
  duckdb/
    engine.ts           # DuckDB lifecycle and query execution
    hydrate.ts          # CSV partition union + SVG geometry injection
    dehydrate.ts        # Strip computed columns, re-partition, write CSVs
  utils/
    csv.ts              # CSV read/write with BOM and quote handling
    svg.ts              # SVG parsing and geometry extraction
    fs.ts               # Directory traversal, level discovery
```
