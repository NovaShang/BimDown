/**
 * Hosts an element module's own properties-panel editor (`propertyPanel`),
 * e.g. roof edge slopes or a curtain wall's grid, for a single selection.
 */
import { useEditorState } from '../state/EditorContext.tsx';
import { getElementModule } from '../elements/registry.ts';
import { toElementId } from '../model/ids.ts';

export default function ModulePropertyPanel({ id, table, editable }: { id: string; table: string; editable: boolean }) {
  const state = useEditorState();
  const Panel = getElementModule(table)?.propertyPanel;
  if (!Panel) return null;
  const element = state.document?.elements.get(toElementId(id));
  if (!element) return null;
  return <Panel element={element} editable={editable} />;
}
