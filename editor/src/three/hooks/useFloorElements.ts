import { useMemo } from 'react';
import { useEditorState } from '../../state/EditorContext.tsx';
import type { CanonicalElement } from '../../model/elements.ts';

/** Returns visible elements for the current floor, filtered by discipline + layer visibility (matches 2D behavior). */
export function useFloorElements(): CanonicalElement[] {
  const { document, visibleLayers, activeDiscipline, documentVersion } = useEditorState();

  return useMemo(() => {
    if (!document) return [];
    const result: CanonicalElement[] = [];
    for (const el of document.elements.values()) {
      // Match 2D behavior: only show active discipline + architectural as background
      if (el.discipline !== activeDiscipline && el.discipline !== 'architechture') continue;
      const key = `${el.discipline}/${el.tableName}`;
      if (visibleLayers.has(key)) {
        result.push(el);
      }
    }
    return result;
  }, [document, visibleLayers, activeDiscipline, documentVersion]);
}
