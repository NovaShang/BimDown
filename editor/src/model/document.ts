import type { CanonicalElement } from './elements.ts';

export interface DocumentState {
  elements: Map<string, CanonicalElement>;
  levelId: string;
}

export function createDocument(levelId: string, elements: CanonicalElement[]): DocumentState {
  const map = new Map<string, CanonicalElement>();
  for (const el of elements) {
    map.set(el.id, el);
  }
  return { elements: map, levelId };
}
