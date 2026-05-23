import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DocumentState } from '../model/document.ts';
import { toElementId } from '../model/ids.ts';

/**
 * Anchor point for positioning the overlay element relative to the computed screen position.
 * 'center' centers both axes; 'top-center' centers X, anchors at top; etc.
 */
export type OverlayAnchor = 'top-left' | 'top-center' | 'top-right'
  | 'center-left' | 'center' | 'center-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface OverlayItem {
  id: string;
  /** Model coordinates (x = right, y = down in model space) */
  position: { x: number; y: number };
  /** Pixel offset from computed screen position */
  offset?: { x: number; y: number };
  /** How to anchor the overlay element relative to the screen position. Default: 'top-left' */
  anchor?: OverlayAnchor;
  /** React content to render at this anchor */
  content: ReactNode;
}

/** Polygon centroid (area-weighted), used as the visual anchor for elements
 *  whose label sits at the centroid rather than the bbox center (e.g. spaces). */
function polygonCentroid(vertices: { x: number; y: number }[]): { x: number; y: number } {
  let area = 0, cx = 0, cy = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-10) {
    const sx = vertices.reduce((s, v) => s + v.x, 0) / n;
    const sy = vertices.reduce((s, v) => s + v.y, 0) / n;
    return { x: sx, y: sy };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/** Tables whose overlay anchor is the label, not the bbox center. For these
 *  the action bar sticks to where the user's eye is — the room label. */
const LABEL_ANCHORED_TABLES = new Set(['space']);

/** Compute the overlay anchor point for the current selection. Returns the
 *  label centroid when a single label-anchored element is selected; otherwise
 *  falls back to the bbox center of all selected elements. */
export function getSelectionCenter(
  selectedIds: Set<string>,
  document: DocumentState | null,
): { x: number; y: number } | null {
  if (!document || selectedIds.size === 0) return null;

  if (selectedIds.size === 1) {
    const id = [...selectedIds][0];
    const el = document.elements.get(toElementId(id));
    if (el && LABEL_ANCHORED_TABLES.has(el.tableName)) {
      if (el.geometry === 'polygon') return polygonCentroid(el.vertices);
      if (el.geometry === 'point') return { x: el.position.x, y: el.position.y };
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;

  for (const id of selectedIds) {
    const el = document.elements.get(toElementId(id));
    if (!el) continue;
    found = true;

    switch (el.geometry) {
      case 'line':
      case 'spatial_line':
        minX = Math.min(minX, el.start.x, el.end.x);
        minY = Math.min(minY, el.start.y, el.end.y);
        maxX = Math.max(maxX, el.start.x, el.end.x);
        maxY = Math.max(maxY, el.start.y, el.end.y);
        break;
      case 'point':
        minX = Math.min(minX, el.position.x);
        minY = Math.min(minY, el.position.y);
        maxX = Math.max(maxX, el.position.x);
        maxY = Math.max(maxY, el.position.y);
        break;
      case 'polygon':
        for (const v of el.vertices) {
          minX = Math.min(minX, v.x);
          minY = Math.min(minY, v.y);
          maxX = Math.max(maxX, v.x);
          maxY = Math.max(maxY, v.y);
        }
        break;
    }
  }

  if (!found) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Hook that computes overlay items from editor state.
 * Currently returns items for the selection action bar.
 * Easily extensible for other overlays.
 */
export function useOverlayItems(
  selectedIds: Set<string>,
  document: DocumentState | null,
  content: ReactNode | null,
): OverlayItem[] {
  return useMemo(() => {
    if (!content) return [];
    const center = getSelectionCenter(selectedIds, document);
    if (!center) return [];

    return [{
      id: 'selection-actions',
      position: center,
      offset: { x: 0, y: -12 },
      anchor: 'bottom-center',
      content,
    }];
  }, [selectedIds, document, content]);
}
