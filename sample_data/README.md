# BimDown sample data

## In this repository

### `rac_advanced/`

Autodesk's Revit "rac_advanced_sample_project" (a 3-storey building with a roof and parapet level), exported to BimDown with the [Revit add-in](../revit-addin/). GeoJSON geometry (`format_version: 2`), metres.

- 5 levels (`lv-1` to `lv-5`), 22 grids, about 980 elements: 146 walls, 34 curtain walls, 100 doors, 24 windows, 91 rooms, 176 structural columns, 37 beams, slabs, ceilings, roofs, stairs, railings, air terminals, 105 furniture rows (cafeteria tables and chairs, trees and shrubs from the Revit families, as built-in library components), plus 71 `mesh` elements (12 GLB files in `mesh/`) for geometry outside the format's scope
- Used as the fixture for the CLI and editor tests
- `bimdown validate` reports no issues. The raw export was repaired by [`scripts/fix-rac-advanced.mjs`](../scripts/fix-rac-advanced.mjs) (re-runnable; its header lists every change: section shapes, level numbers, slab openings, furniture, wall ends joined to the wall they meet so the rooms close). The remaining warnings are the model as drawn in Revit: free wall ends at openings, one duplicated wall (lv-2 `w-103` / `w-104`), and stair railings whose stairs were exported without geometry. Elements have no types (`type_id`) apart from furniture.

```bash
npx bimdown-cli@latest info sample_data/rac_advanced
npx bimdown-cli@latest render sample_data/rac_advanced -l lv-2 -o lv-2.png
npx bimdown-cli@latest query sample_data/rac_advanced "SELECT level_id, COUNT(*) AS doors FROM door GROUP BY level_id ORDER BY level_id"
```

No page on the website yet; open the folder in the [editor](https://bim.jouledown.com/editor) (Open local folder, Chrome or Edge) to see it in 2D/3D.

## On the website

Clean, complete models you can open, edit and export (plans, sections, 3D, IFC) in the browser without an account. Their data is not in this repository.

| Example | Source | Contents |
|---|---|---|
| [Small office building](https://bim.jouledown.com/examples/small-office-building) | Original | 2-storey office (36 × 16.8 m): open offices, meeting rooms, stair and WC core, columns, beams, flat roof |
| [Duplex apartment](https://bim.jouledown.com/examples/duplex-apartment) | buildingSMART "Duplex Apartment" IFC test files (CC BY 4.0), converted | Two mirrored 2-storey homes with foundations, roof, stairs, plumbing and electrical |
| [DigitalHub office, RWTH Aachen](https://bim.jouledown.com/examples/digitalhub-office-building) | [RWTH-E3D/DigitalHub](https://github.com/RWTH-E3D/DigitalHub) (MIT), converted | Real office: basement plus 2 storeys, 64 rooms, structure, stairs, full ventilation ductwork |
| [Plant room and office (MEP)](https://bim.jouledown.com/examples/mep-plant-room) | Original | AHU, water-cooled chiller, pumps, rooftop cooling tower, connected ducts and chilled / condenser water pipes |

To build a model of your own from text, a sketch or photos, see [Photo to BIM](https://bim.jouledown.com/use-cases/photo-to-bim) or start in the [web app](https://bim.jouledown.com).
