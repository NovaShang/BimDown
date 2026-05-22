/**
 * Archetype × operation tool registry.
 *
 * Each ElementModule declares its archetype (line / spatial-line / topo-line /
 * point / hosted / surface). The tools layer then provides a place / move /
 * edit handler per archetype. New element types don't add new tools — they
 * pick an archetype and the existing handlers know how to drive them.
 *
 * Handlers below delegate to the existing draw_/relocate_/rotate tools so
 * behavior is preserved exactly. The value here is a discoverable lookup
 * (`getElementTool('wall', 'place')` instead of `getToolHandler('draw_line')`)
 * and a single place to swap archetype-specific variants when they appear
 * (e.g. a future TopoLineDrawTool with connector snap).
 */
import type { Archetype } from '../../elements/archetypes.ts';
import { getElementModule } from '../../elements/registry.ts';
import type { ToolHandler } from '../types.ts';
import { drawLineTool } from '../drawLineTool.ts';
import { drawPointTool } from '../drawPointTool.ts';
import { drawPolygonTool } from '../drawPolygonTool.ts';
import { drawHostedTool } from '../drawHostedTool.ts';
import { relocateTool } from '../relocateTool.ts';
import { relocateHostedTool } from '../relocateHostedTool.ts';
import { rotateTool } from '../rotateTool.ts';

export type ArchetypeOperation = 'place' | 'move' | 'edit';

interface ArchetypeOps {
  place: ToolHandler;
  move: ToolHandler;
  edit?: ToolHandler;
}

/**
 * Single source of truth: which tool drives each (archetype, operation) pair.
 * When a future variant lands — say a connector-aware TopoLineDrawTool — this
 * map is the only thing that changes.
 */
const ARCHETYPE_HANDLERS: Record<Archetype, ArchetypeOps> = {
  line: {
    place: drawLineTool,
    move: relocateTool,
  },
  'spatial-line': {
    // Today drawLineTool already reads attrs.start_z/end_z when the element's
    // geometry resolves to 'spatial_line', so the same tool serves both archetypes.
    place: drawLineTool,
    move: relocateTool,
  },
  'topo-line': {
    // Same placement tool today; sldeditor-style connector snap is a future
    // upgrade slotted in here.
    place: drawLineTool,
    move: relocateTool,
  },
  point: {
    place: drawPointTool,
    move: relocateTool,
    edit: rotateTool,
  },
  hosted: {
    place: drawHostedTool,
    move: relocateHostedTool,
  },
  surface: {
    place: drawPolygonTool,
    move: relocateTool,
  },
};

export function getArchetypeTool(
  archetype: Archetype,
  op: ArchetypeOperation,
): ToolHandler | null {
  const ops = ARCHETYPE_HANDLERS[archetype];
  if (!ops) return null;
  if (op === 'edit') return ops.edit ?? null;
  return ops[op];
}

/**
 * Lookup tool for an element type via its module's archetype declaration.
 * Falls back to null if the table has no registered module — the caller can
 * then use the legacy tool registry (`getToolHandler('draw_line')` etc.)
 * if it knows the right name.
 */
export function getElementTool(
  tableName: string,
  op: ArchetypeOperation,
): ToolHandler | null {
  const mod = getElementModule(tableName);
  if (!mod) return null;
  return getArchetypeTool(mod.archetype, op);
}
