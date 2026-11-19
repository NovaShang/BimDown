# Snap Feature

## Overview

The editor now supports automatic snapping during drawing, moving, and resizing operations. Snapping helps align elements precisely to a grid or to other objects in the scene.

## How It Works

### Two Snap Modes

1. **Object Snap** (higher priority) — snaps to geometric features of existing elements:
   - **Endpoints** — line start/end, polygon vertices, point-element corners
   - **Centers** — point-element centers, polygon centroids
   - **Midpoints** — midpoints of line segments and polygon edges
   - **Edges** — midpoints of point-element edges (top/bottom/left/right)

2. **Grid Snap** (fallback) — snaps to an adaptive grid when no nearby object feature is found:
   - Grid spacing automatically adjusts based on zoom level
   - Zoomed in: finer grid (down to 1mm)
   - Zoomed out: coarser grid (up to 100m)
   - Target: ~50 screen pixels per grid cell

### Snap Threshold

The snap threshold is **10 screen pixels**, regardless of zoom level. This means snapping feels consistent whether you're zoomed in or out.

### X and Y Are Independent

The snap engine evaluates X and Y axes independently. You can snap to one object's X coordinate and another object's Y coordinate simultaneously, or snap X to an object and Y to the grid.

## Where Snap Is Active

| Operation | Snap Behavior |
|-----------|---------------|
| **Draw Line** — both clicks | Snaps start and end points |
| **Draw Point** — placement click | Snaps the placement position |
| **Draw Polygon** — each vertex click | Snaps each vertex |
| **Move elements** (select tool drag) | Snaps the anchor point of the first selected element |
| **Resize handles** (endpoints, corners, vertices) | Snaps the dragged handle point |

During **pointer move** (preview), snap is also active so you see the snapped position in real time.

## Visual Feedback

When a snap is active, guide lines appear:

- **Red dashed lines** — object snap guides (vertical/horizontal alignment lines extending across the viewport)
- **Red circle** — indicates the exact snap target point when both X and Y snap to the same object
- **Yellow dashed lines** — grid snap guides (shorter dashes, lower opacity)

Guides disappear immediately when the snap is released (pointer up or when the cursor moves out of range).

## Files

| File | Purpose |
|------|---------|
| `src/utils/snap.ts` | Core snap engine — `computeSnap()`, `snapPoint()`, `adaptiveGridSpacing()` |
| `src/components/SnapOverlay.tsx` | Renders snap guide lines and indicators |
| `src/tools/types.ts` | `ToolContext.setSnap` — callback for tools to update snap visual state |
| `src/tools/drawLineTool.ts` | Snap integrated into line drawing |
| `src/tools/drawPointTool.ts` | Snap integrated into point placement |
| `src/tools/drawPolygonTool.ts` | Snap integrated into polygon vertex placement |
| `src/tools/selectTool.ts` | Snap integrated into element movement |
| `src/components/ResizeHandles.tsx` | Snap integrated into handle dragging |
| `src/components/Canvas.tsx` | Hosts local snap state, renders SnapOverlay |

## Architecture Notes

- Snap state (`activeSnap`) lives as **local React state** in `Canvas.tsx`, not in the global EditorContext. This avoids full-tree re-renders on every mouse move.
- The snap engine (`computeSnap`) is a **pure function** — it takes the input point, pixel size, elements map, and excluded IDs, and returns the snap result.
- Tools call `ctx.setSnap(result)` to update the visual overlay. They call `ctx.setSnap(null)` on pointer-up to clear guides.
- During element movement, the snap is computed against the **anchor point** (first selected element's primary position), and the entire selection moves by the snapped delta. Elements being moved are excluded from snap targets.
