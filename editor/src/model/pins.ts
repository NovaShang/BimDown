/**
 * Pinned elements (spec `pinned = "true"`, base element and grid): the modify
 * tools, drags and handles leave them where they are; properties stay editable.
 */
import type { CanonicalElement } from './elements.ts';

export function isPinned(el: CanonicalElement | null | undefined): boolean {
  return el?.attrs.pinned === 'true';
}
