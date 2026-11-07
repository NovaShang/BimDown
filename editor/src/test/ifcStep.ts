/**
 * Minimal STEP (IFC) reader for tests: entity index, argument splitting, and
 * the BimDown `<table>:<id>` key of every product (from its BimDown pset).
 */

export interface StepEntity { id: number; type: string; args: string[] }

/** Split a STEP argument list at top-level commas (respects nesting and quotes). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === "'") { if (s[i + 1] === "'") { cur += s[++i]; } else quote = false; }
      continue;
    }
    if (c === "'") { quote = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur !== '' || out.length > 0) out.push(cur);
  return out;
}

export function indexStep(step: string): Map<number, StepEntity> {
  const out = new Map<number, StepEntity>();
  for (const m of step.matchAll(/^#(\d+)=([A-Z0-9]+)\((.*)\);\s*$/gm)) {
    out.set(Number(m[1]), { id: Number(m[1]), type: m[2], args: splitArgs(m[3]) });
  }
  return out;
}

export const ref = (a: string): number => Number(a.replace('#', ''));
export const refs = (a: string): number[] => a.replace(/[()]/g, '').split(',').filter(Boolean).map(ref);
export const str = (a: string): string => a.replace(/^IFC[A-Z]+\(/, '').replace(/\)$/, '').replace(/^'|'$/g, '');

/** Product expressID → `<table>:<id>` (BimDown pset `Table` / `Id`). */
export function bimdownKeys(ents: Map<number, StepEntity>): Map<number, string> {
  const psetKey = new Map<number, string>();
  for (const e of ents.values()) {
    if (e.type !== 'IFCPROPERTYSET' || str(e.args[2]) !== 'BimDown') continue;
    const props: Record<string, string> = {};
    for (const p of refs(e.args[4])) {
      const v = ents.get(p)!;
      props[str(v.args[0])] = str(v.args[2]);
    }
    psetKey.set(e.id, `${props.Table}:${props.Id}`);
  }
  const out = new Map<number, string>();
  for (const e of ents.values()) {
    if (e.type !== 'IFCRELDEFINESBYPROPERTIES') continue;
    const k = psetKey.get(ref(e.args[5]));
    if (k) for (const o of refs(e.args[4])) out.set(o, k);
  }
  return out;
}

export function countTypes(ents: Map<number, StepEntity>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of ents.values()) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

/** Property `name` of pset `pset` on product `id` (raw STEP value), or undefined. */
export function propertyOf(ents: Map<number, StepEntity>, id: number, pset: string, name: string): string | undefined {
  for (const e of ents.values()) {
    if (e.type !== 'IFCRELDEFINESBYPROPERTIES' || !refs(e.args[4]).includes(id)) continue;
    const ps = ents.get(ref(e.args[5]))!;
    if (str(ps.args[2]) !== pset) continue;
    const list = ps.type === 'IFCELEMENTQUANTITY' ? refs(ps.args[5]) : refs(ps.args[4]);
    for (const p of list) {
      const v = ents.get(p)!;
      if (str(v.args[0]) === name) return ps.type === 'IFCELEMENTQUANTITY' ? v.args[3] : v.args[2];
    }
  }
  return undefined;
}
