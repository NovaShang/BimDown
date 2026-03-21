# BimDown Editor

Figma-style 2D BIM plan editor. Renders BimDown CSV + SVG data as interactive engineering drawings with selection, properties inspection, and discipline-based filtering.

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
  App.tsx                        Root — provider + data loading
  index.css                      Figma dark theme (single stylesheet)
  types.ts                       Data types, layer styles, discipline tables

  state/
    EditorContext.tsx             Dual context (state/dispatch split)
    editorReducer.ts             All state transitions
    editorTypes.ts               EditorState, Action union, Tool type
    selectors.ts                 Derived state (processed layers, viewBox, etc.)

  components/
    EditorShell.tsx              Layout orchestrator
    Canvas.tsx                   SVG rendering, pan/zoom, selection, hover
    LeftPanel.tsx                Floor switcher + discipline/layer toggles
    FloatingToolbar.tsx          General tools + discipline-specific filters
    FloatingProperties.tsx       Element properties (appears on selection)
    SelectionOverlay.tsx         Blue outlines on selected elements
    MarqueeSelection.tsx         Rubber-band drag-to-select
    Minimap.tsx                  Corner overview with click-to-navigate

  utils/
    loader.ts                   CSV + SVG data loading
    processor.ts                SVG transformation pipeline (walls, doors, etc.)
    geometry.ts                 Coordinate conversion helpers
```

## Layout

```
+------------------------------------------------------------------+
|  [Left Panel]  |              Canvas                 [Properties] |
|  +-----------+ |                                      (floating,  |
|  | Floors    | |                                       top-right, |
|  +-----------+ |                                       on select) |
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
| `Escape` | Clear selection |
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
- Zero runtime dependencies beyond React
- `useReducer` + dual context for state management
- CSS transform-based pan/zoom
- DOM event delegation for hit testing
- SVG transformation pipeline for engineering-style rendering
