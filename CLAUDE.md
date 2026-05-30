# BimDown Spec

## Structure
- `spec/` — BimDown format spec (YAML schemas)
- `cli/` — BimDown CLI (validate, query, render, gen-skill, info, merge)
- `revit-addin/` — Revit plugin (C#) for import/export
- `sample_data/` — CSV/SVG exports from Revit models
- `scripts/` — Migration and utility scripts

## Development
- Package manager: npm workspaces
- CLI build: `cd cli && npm run build`
- CLI dev: source is in `cli/src/`, uses tsup for bundling

## Format Key Concepts
- CSV for attributes; geometry layer is SVG (2D, `format_version: 1`) or GeoJSON (2D/3D, `format_version: 2`, default) — both encodings supported, both human and AI readable. CSV attribute layer is identical for both.
- Hosted elements (door, window, opening) are CSV-only with `position` (distance in meters from host wall start)
- Spaces are CSV-only seed points (x, y) — boundary auto-derived from walls
- Wall thickness is in both CSV and SVG stroke-width, CSV is source of truth
- IDs are level-scoped (unique within each lv-N/ directory)
- Materials use a fixed enum: concrete, steel, wood, clt, glass, aluminum, brick, stone, gypsum, insulation, copper, pvc, ceramic, fiber_cement, composite
- Any element can have optional `mesh_file` (GLB) for precise 3D visualization fallback

## Code Style
- TypeScript for CLI
- Prefer modern C# for revit-addin (primary constructors, collection expressions, pattern matching, records, file-scoped namespaces)

## Testing
- CLI tests: `cd cli && npm test` (vitest)
- Tests use `sample_data/rac_advanced/` for fixture data

### Revit Tests
- Test framework: TUnit with `Nice3point.TUnit.Revit` (integration tests inside Revit process)
- Test project: `revit-addin/Tests/BimDown.RevitTests.csproj`
- Build tests: `dotnet build revit-addin/Tests/BimDown.RevitTests.csproj`
- Run tests: requires Revit 2026 running
- Run non-SampleProject tests: `dotnet run --project revit-addin/Tests/BimDown.RevitTests.csproj -- --treenode-filter "/*/*/*/*[Category!=SampleProject]"`
- **Killing stuck test processes**: Find the parent dotnet process and kill it:
  1. `powershell -Command "(Get-Process -Id <PID>).Parent.Id"`
  2. `powershell -Command "Stop-Process -Id <parent_PID> -Force"`

## Sample Data
- `sample_data/rac_advanced/` is the reference CSV/SVG dataset exported from Revit (5 levels, includes doors/windows hosted on global curtain walls — exercises the renderer's global-wall lookup and hydrate's height fallback)
- Source Revit projects: `SourceRevitModels/*.rvt` (gitignored)

## Git Commits
- Do NOT add `Co-Authored-By` lines or any Claude/Anthropic signature to commit messages
- Commit messages: conventional commit style, no model attribution
