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

/** Compute bounding box center-top of selected elements in model coordinates. */
export function getSelectionCenter(
  selectedIds: Set<string>,
  document: DocumentState | null,
): { x: number; y: number } | null {
  if (!document || selectedIds.size === 0) return null;

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
