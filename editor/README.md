# BimDown Editor

Figma-style 2D/3D BIM plan editor component. Renders BimDown CSV + SVG data as interactive engineering drawings with selection, drawing tools, properties inspection, and discipline-based filtering.

## Quick Start

```bash
cd editor
npm install
npm run dev
```

Opens at http://localhost:5174. Requires `../sample_data/` with BimDown CSV/SVG exports.

## Architecture

```
src/
  exports.ts                     Public API surface for embedding
  App.tsx                        Root — provider + data loading (dev mode)
  index.css                      Figma dark theme (single stylesheet)

  model/
    elements.ts                  Canonical element types (Line, Point, Polygon)
    tableRegistry.ts             Element type definitions, fields, defaults
    hosted.ts                    Hosted geometry resolution (doors, windows)
    parse.ts / serialize.ts      CSV/SVG ↔ element conversion

  state/
    EditorContext.tsx             Dual context (state/dispatch split)
    editorReducer.ts             All state transitions
    editorTypes.ts               EditorState, Action union, Tool type
    selectors.ts                 Derived state (processed layers, viewBox, etc.)

  components/
    EditorShell.tsx              Layout orchestrator
    Canvas.tsx                   SVG rendering, pan/zoom, selection, hover
    LeftPanel.tsx                Floor switcher + discipline/layer toggles
    FloatingToolbar.tsx          Drawing tools + discipline-specific filters
    ViewToolbar.tsx              View controls (zoom, fit, 3D toggle)
    DrawingOverlay.tsx           Active drawing visualization
    DrawingPropertiesBar.tsx     Properties bar during drawing
    SelectionOverlay.tsx         Blue outlines on selected elements
    MarqueeSelection.tsx         Rubber-band drag-to-select
    Minimap.tsx                  Corner overview with click-to-navigate
    ResizeHandles.tsx            Element resize handles
    SnapOverlay.tsx              Snap point visualization

  renderers/                     2D SVG renderers per element type
  three/                         3D view with Three.js
  tools/                         Drawing tools (line, point, polygon, hosted)
  export/                        Export: glTF, IFC (web-ifc), PDF (jspdf), DXF (dxf-writer)

  utils/
    dataSource.ts                DataSource interface + factories
    DataSourceContext.tsx         React context for DataSource
    loader.ts                    CSV + SVG data loading
    processor.ts                 SVG transformation pipeline
    geometry.ts                  Coordinate conversion helpers
    snap.ts                      Snap logic for drawing tools

  i18n/                          English and Chinese translations
```

## Exported API

Defined in `src/exports.ts`. Everything below is importable from `bimdown-editor`:

**Providers & Hooks**
- `EditorProvider`, `useEditorState`, `useSelectionState`, `useEditorDispatch` — editor state
- `DataSourceProvider`, `useDataSource` — data source context
- `TooltipProvider` — required by EditorShell internals

**Components**
- `EditorShell` — the main editor UI (expects to be inside all three providers)

**Data Loading**
- `loadProject(ds)`, `loadGrids(ds)`, `loadLayer(ds, levelId, table)` — load data from a DataSource
- `createLocalDataSource(model)` — DataSource factory for local dev server

**Export**
- `exportGltf`, `exportIfc`, `exportPdf`, `exportDxf`

**Types**
- `DataSource`, `EditorState`, `EditorAction`

## Layout

```
+------------------------------------------------------------------+
|  [Left Panel]  |              Canvas                              |
|  +-----------+ |                                                  |
|  | Floors    | |                                                  |
|  +-----------+ |                                                  |
|  | Layers    | |                                                  |
|  | > Arch    | |                                                  |
|  |   - Walls | |                                                  |
|  |   - Doors | |                                                  |
|  | > Struct  | |                                                  |
|  | > HVAC    | |                                                  |
|  +-----------+ |    [Minimap]                                     |
|                |    [========= Floating Toolbar =========]        |
|                |    | Select Pan Zoom | Wall Door Window |        |
+------------------------------------------------------------------+
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `V` | Select tool |
| `H` | Pan tool |
| `Z` | Zoom tool |
| `Space` (hold) | Temporary pan |
| `Ctrl+0` | Zoom to fit |
| `Ctrl+1` | Zoom 100% |
| `+` / `-` | Zoom in / out |
| `Escape` | Clear selection / cancel drawing |
| `Ctrl+A` | Select all visible |

## Mouse

- **Left click** — select element (Shift+click to add)
- **Drag on empty** — marquee selection
- **Scroll wheel** — zoom at cursor
- **Middle mouse drag** — pan
- **Minimap click** — navigate to area

## Discipline Toolbar

Selecting an element or having layers visible auto-detects the active discipline. The toolbar shows discipline-specific filter buttons:

| Discipline | Filters |
|-----------|---------|
| Architectural | Wall, Column, Door, Window, Space, Slab, Stair |
| Structural | Wall, Column, Slab, Beam, Brace |
| HVAC | Duct, Equipment, Terminal |
| Plumbing | Pipe, Equipment, Terminal |
| Electrical | Equipment, Terminal |

Clicking a filter highlights that element type and dims everything else. Click again to clear.

## Tech Stack

- React 19 + TypeScript + Vite 8
- Three.js / @react-three/fiber for 3D view
- jspdf + svg2pdf.js for PDF export
- web-ifc for IFC export
- dxf-writer for DXF export
- Tailwind CSS + shadcn/ui
- `useReducer` + dual context for state management
- CSS transform-based pan/zoom
- DOM event delegation for hit testing
- SVG transformation pipeline for engineering-style rendering
