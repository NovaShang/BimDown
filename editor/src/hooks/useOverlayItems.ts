import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DocumentState } from '../model/document.ts';
import { toElementId } from '../model/ids.ts';
import { getElementModule } from '../elements/registry.ts';

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

/** Compute bbox of selected elements, returning min/max in model coords. */
function getSelectionBBox(
  selectedIds: Set<string>,
  document: DocumentState | null,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
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
        minX = Math.min(minX, el.position.x - el.width / 2);
        minY = Math.min(minY, el.position.y - el.height / 2);
        maxX = Math.max(maxX, el.position.x + el.width / 2);
        maxY = Math.max(maxY, el.position.y + el.height / 2);
        break;
      case 'polygon':
        for (const v of el.vertices) {
          if (v.x < minX) minX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.x > maxX) maxX = v.x;
          if (v.y > maxY) maxY = v.y;
        }
        break;
    }
  }
  return found ? { minX, minY, maxX, maxY } : null;
}

/** Compute the overlay anchor point for the current selection. When a single
 *  element is selected and its module exposes a `selectionAnchor`, that wins;
 *  otherwise falls back to the bbox center of all selected elements. */
export function getSelectionCenter(
  selectedIds: Set<string>,
  document: DocumentState | null,
): { x: number; y: number } | null {
  if (!document || selectedIds.size === 0) return null;

  if (selectedIds.size === 1) {
    const id = [...selectedIds][0];
    const el = document.elements.get(toElementId(id));
    const anchor = el && getElementModule(el.tableName)?.selectionAnchor?.(el);
    if (anchor) return anchor;
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

    // Position priority:
    //   1. Module-supplied selectionAnchor for single selection.
    //   2. Otherwise → element bbox top, centered horizontally — gives the
    //      action bar room above the element instead of overlapping it.
    let position: { x: number; y: number } | null = null;
    let pushUp = 24;
    if (selectedIds.size === 1) {
      const id = [...selectedIds][0];
      const el = document?.elements.get(toElementId(id));
      const anchor = el && getElementModule(el.tableName)?.selectionAnchor?.(el);
      if (anchor) position = anchor;
    }
    if (!position) {
      const bb = getSelectionBBox(selectedIds, document);
      if (bb) {
        position = { x: (bb.minX + bb.maxX) / 2, y: bb.maxY };
        pushUp = 24;
      }
    }
    if (!position) return [];

    return [{
      id: 'selection-actions',
      position,
      offset: { x: 0, y: -pushUp },
      anchor: 'bottom-center',
      content,
    }];
  }, [selectedIds, document, content]);
}
