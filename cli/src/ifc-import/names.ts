/**
 * Revit-style naming of an IFC product: family and type (from the type
 * object, Pset_*Common.Reference, ObjectType or the "Family:Type:Id" Name)
 * and the instance mark, so family / type strings go into family / type
 * columns and type rows instead of `number`.
 */
import type { ImportContext } from './context.js';
import { str } from './model.js';

export interface FamilyType {
  family?: string;
  type?: string;
  /** Instance mark (Revit "Mark", Pset Tag / Reference when not a family:type). */
  mark?: string;
  /** The product's own Name is a Revit "Family:Type[:Id]" string (not a mark). */
  revitName: boolean;
}

const MARK_KEYS = ['Mark', 'Kennzeichen', '标记', 'Marque'];
/** Trailing Revit element id. */
const ID_TAIL = /:\d{3,}$/;

function split(s: string | null | undefined): string[] | null {
  if (!s) return null;
  const p = s.replace(ID_TAIL, '').split(':').map(x => x.trim()).filter(Boolean);
  return p.length >= 2 ? p : null;
}

export function familyType(ctx: ImportContext, id: number): FamilyType {
  const { model } = ctx;
  const line = model.line(id);
  // Our own exports: family / type as written (ObjectType there is the shape or kind)
  if (model.prop(id, /^BimDown$/, 'Table') !== null) {
    const v = (k: string) => { const x = model.prop(id, /^BimDown$/, k); return x === null ? undefined : String(x); };
    const t = model.typeOf.get(id);
    return { family: v('Family'), type: v('Type') ?? (t ? str(model.line(t)?.Name) ?? undefined : undefined), revitName: false };
  }
  const name = str(line?.Name);
  const t = model.typeOf.get(id);
  const typeName = t ? str(model.line(t)?.Name) : null;
  const ref = model.prop(id, /Common$/, 'Reference');
  const fromRef = typeof ref === 'string' ? split(ref) : null;
  const fromObjectType = split(str(line?.ObjectType));
  const fromName = split(name);
  const fromType = split(typeName);
  const pick = fromRef ?? fromType ?? fromObjectType ?? fromName;
  let family = pick?.[0];
  let type = pick?.[1];
  if (!type && typeName) type = typeName.replace(ID_TAIL, '');
  if (!type) {
    const ot = str(line?.ObjectType);
    if (ot && !/^Ifc/.test(ot)) type = ot.replace(ID_TAIL, '');
  }
  if (family && type && family === type) family = undefined;
  let mark: string | undefined;
  for (const k of MARK_KEYS) {
    const v = model.prop(id, /./, k);
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') { mark = String(v).trim(); break; }
  }
  return { family, type, mark, revitName: !!fromName };
}

/** `number` for a product: its mark, else its Name when that is not a Revit family:type string. */
export function numberOf(ctx: ImportContext, id: number, ft: FamilyType = familyType(ctx, id)): string | undefined {
  // Our own exports carry the number in the BimDown set
  if (ctx.model.prop(id, /^BimDown$/, 'Table') !== null) {
    const n = ctx.model.prop(id, /^BimDown$/, 'Number');
    return n === null ? undefined : String(n);
  }
  if (ft.mark) return ft.mark;
  return ft.revitName ? undefined : ctx.label(id);
}
