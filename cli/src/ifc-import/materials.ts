/**
 * IFC materials → BimDown: the material enum from (multilingual) names, and
 * material layer sets → layered element types (wall_type / slab_type /
 * roof_type + type_layer rows).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- web-ifc lines are untyped */
import type { IfcModel } from './model.js';
import { enumValue, num, str } from './model.js';

export type MaterialEnum =
  | 'concrete' | 'steel' | 'wood' | 'clt' | 'glass' | 'aluminum' | 'brick' | 'stone' | 'gypsum'
  | 'insulation' | 'copper' | 'pvc' | 'ceramic' | 'fiber_cement' | 'composite';

// Order matters: the first pattern that matches wins (e.g. "Stahlbeton" is concrete).
const MATERIAL_PATTERNS: [RegExp, MaterialEnum][] = [
  [/\bclt\b|cross.?lam|brettsperr|x-?lam/i, 'clt'],
  [/concrete|beton|\bstb\b|\bc\d{2}\/\d{2}|screed|estrich|cement(?!.*board)|zement|mortar|mörtel|\bcast.?in|precast|fertigteil/i, 'concrete'],
  [/insulat|dämm|daemm|\beps\b|\bxps\b|mineral.?wool|mineralwolle|rock.?wool|steinwolle|glass.?wool|glaswolle|\bpur\b|\bpir\b|polystyr|foam|schaum|isolat/i, 'insulation'],
  [/gyps|gips|plaster(?!.*board.*cement)|putz|drywall|trockenbau|gkb|gkf|stucco/i, 'gypsum'],
  [/brick|ziegel|mauerwerk|masonry|klinker|\bkalksand|\bks\b|block|cmu|porenbeton|aerated/i, 'brick'],
  [/fiber.?cement|faserzement|cement.?board|eternit/i, 'fiber_cement'],
  [/alumin/i, 'aluminum'],
  [/copper|kupfer/i, 'copper'],
  [/steel|stahl|\biron\b|eisen|metal/i, 'steel'],
  [/glass|glas|glazing|verglas/i, 'glass'],
  [/timber|wood|holz|plywood|\bosb\b|\bmdf\b|spruce|fichte|oak|eiche|pine|kiefer|parquet|parkett|laminat/i, 'wood'],
  [/stone|stein|granite|granit|marble|marmor|naturstein|slate|schiefer|limestone/i, 'stone'],
  [/ceramic|keramik|tile|fliese|porcelain|terracotta/i, 'ceramic'],
  [/\bpvc\b|vinyl|plastic|kunststoff|polyeth|\bpe\b|\bpp\b|hdpe|abs\b/i, 'pvc'],
  [/composite|verbund|\bgrp\b|\bfrp\b/i, 'composite'],
];

export function materialFromName(name: string | null | undefined): MaterialEnum | null {
  if (!name) return null;
  for (const [re, m] of MATERIAL_PATTERNS) if (re.test(name)) return m;
  return null;
}

export type LayerFunction = 'core' | 'substrate' | 'insulation' | 'air_gap' | 'membrane' | 'finish';

export interface LayerInfo {
  name: string | null;
  material: MaterialEnum;
  thickness: number;
  function: LayerFunction;
}

export interface LayerSetInfo {
  /** IfcMaterialLayerSet express id (types are shared per set). */
  setId: number;
  name: string | null;
  layers: LayerInfo[];
  total: number;
  /** IfcMaterialLayerSetUsage, when the element uses one. */
  usage?: { direction: string; sense: 'POSITIVE' | 'NEGATIVE'; offset: number };
}

/** The material select associated with an element, or with its type. */
function materialSelect(model: IfcModel, id: number): any {
  const own = model.material.get(id);
  if (own) return model.line(own);
  const typeId = model.typeOf.get(id);
  const t = typeId ? model.material.get(typeId) : undefined;
  return t ? model.line(t) : null;
}

/** Layer set (with usage) of an element, if it has one. */
export function layerSet(model: IfcModel, id: number): LayerSetInfo | null {
  let sel = materialSelect(model, id);
  if (!sel) return null;
  let cls = model.className(sel.expressID);
  let usage: LayerSetInfo['usage'];
  if (cls === 'IfcMaterialLayerSetUsage') {
    usage = {
      direction: enumValue(sel.LayerSetDirection) ?? 'AXIS2',
      sense: enumValue(sel.DirectionSense) === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE',
      offset: (num(sel.OffsetFromReferenceLine) ?? 0) * model.scale,
    };
    sel = model.ref(sel.ForLayerSet);
    if (!sel) return null;
    cls = model.className(sel.expressID);
  }
  if (cls !== 'IfcMaterialLayerSet') {
    // Instance with a plain material, type with the layer set
    const typeId = model.typeOf.get(id);
    const t = typeId ? model.material.get(typeId) : undefined;
    const tl = t ? model.line(t) : null;
    if (!tl || model.className(tl.expressID) !== 'IfcMaterialLayerSet') return null;
    sel = tl;
  }
  const raw = model.refs(sel.MaterialLayers);
  const layers: LayerInfo[] = [];
  for (const l of raw) {
    const t = (num(l.LayerThickness) ?? 0) * model.scale;
    if (t <= 0) continue;
    const mat = model.ref(l.Material);
    const mname = str(mat?.Name) ?? str(l.Name);
    const lname = str(l.Name) ?? mname;
    layers.push({ name: lname, material: materialFromName(mname) ?? 'composite', thickness: t, function: layerFunction(l, mname) });
  }
  if (layers.length === 0) return null;
  // Exactly one core: the thickest structural layer when nothing says so.
  if (!layers.some(l => l.function === 'core')) {
    const structural = layers.filter(l => ['concrete', 'brick', 'wood', 'clt', 'steel', 'stone'].includes(l.material));
    const pick = (structural.length ? structural : layers).reduce((a, b) => (b.thickness > a.thickness ? b : a));
    pick.function = 'core';
  } else {
    let seen = false;
    for (const l of layers) if (l.function === 'core') { if (seen) l.function = 'substrate'; seen = true; }
  }
  const total = layers.reduce((s, l) => s + l.thickness, 0);
  return { setId: sel.expressID, name: str(sel.LayerSetName), layers, total, usage };
}

function layerFunction(l: any, materialName: string | null): LayerFunction {
  const cat = (str(l.Category) ?? '').toLowerCase();
  if (cat.includes('loadbearing') || cat.includes('load')) return 'core';
  if (cat.includes('insul')) return 'insulation';
  if (cat.includes('air')) return 'air_gap';
  if (cat.includes('membrane')) return 'membrane';
  if (cat.includes('finish')) return 'finish';
  if (cat.includes('substrate')) return 'substrate';
  if (l.IsVentilated?.value === true || enumValue(l.IsVentilated) === 'T') return 'air_gap';
  const n = (materialName ?? '').toLowerCase();
  if (/air|luft/.test(n)) return 'air_gap';
  if (/membrane|folie|vapou?r|dampf|barrier|sperr|bitumen|abdicht|waterproof/.test(n)) return 'membrane';
  if (materialFromName(n) === 'insulation') return 'insulation';
  if (/finish|paint|anstrich|render|putz|plaster|tile|fliese|parquet|parkett|carpet|teppich|cladding|bekleid/.test(n)) return 'finish';
  return 'substrate';
}

/** Primary (enum) material of an element: core layer, single material, or list / constituent. */
export function elementMaterial(model: IfcModel, id: number): MaterialEnum | null {
  const ls = layerSet(model, id);
  if (ls) return ls.layers.find(l => l.function === 'core')?.material ?? ls.layers[0].material;
  const sel = materialSelect(model, id);
  if (!sel) return null;
  const cls = model.className(sel.expressID);
  if (cls === 'IfcMaterial') return materialFromName(str(sel.Name) ?? str(sel.Category));
  if (cls === 'IfcMaterialList') {
    for (const m of model.refs(sel.Materials)) {
      const v = materialFromName(str(m.Name));
      if (v) return v;
    }
    return null;
  }
  if (cls === 'IfcMaterialConstituentSet') {
    for (const c of model.refs(sel.MaterialConstituents)) {
      const v = materialFromName(str(model.ref(c.Material)?.Name) ?? str(c.Name));
      if (v) return v;
    }
    return null;
  }
  if (cls === 'IfcMaterialProfileSetUsage' || cls === 'IfcMaterialProfileSet') {
    const set = cls === 'IfcMaterialProfileSetUsage' ? model.ref(sel.ForProfileSet) : sel;
    for (const p of model.refs(set?.MaterialProfiles)) {
      const v = materialFromName(str(model.ref(p.Material)?.Name));
      if (v) return v;
    }
  }
  return null;
}

/** Name of the element's first material, for keyword matching. */
export function materialName(model: IfcModel, id: number): string | null {
  const sel = materialSelect(model, id);
  if (!sel) return null;
  return str(sel.Name) ?? str(model.refs(sel.Materials)[0]?.Name) ?? null;
}

// ─── Strength grades ─────────────────────────────────────────────────────────

/** Grade patterns, first match wins; `format` normalises the match (data: extend for new standards). */
export const GRADE_PATTERNS: { re: RegExp; format: (m: RegExpMatchArray) => string; materials?: MaterialEnum[] }[] = [
  { re: /\bL?C\s?(\d{2,3})\s?\/\s?(\d{2,3})\b/i, format: m => `${/^L/i.test(m[0]) ? 'LC' : 'C'}${m[1]}/${m[2]}` },
  { re: /\b([SQ])\s?(\d{3})\s?(J[R0-2]|[A-E]|N|NL|M|ML|GJ)?\b/, format: m => `${m[1]}${m[2]}${m[3] ?? ''}` },
  { re: /\bGL\s?(\d{2})\s?([hc])\b/i, format: m => `GL${m[1]}${m[2].toLowerCase()}` },
  { re: /\b(A\d{3,4})(?:\s?(?:Grade|Gr\.?)\s?(\w+))?/, format: m => (m[2] ? `${m[1]} Gr. ${m[2]}` : m[1]) },
  { re: /\bGrade\s?(\d{2,3})\b/i, format: m => `Grade ${m[1]}` },
  { re: /\bC\s?(\d{2})\b/, format: m => `C${m[1]}`, materials: ['concrete'] },
  { re: /\b[CD]\s?(\d{2})\b/, format: m => m[0].replace(/\s/g, ''), materials: ['wood'] },
  { re: /(\d{2,3}(?:\.\d)?)\s?MPa\b/i, format: m => `${m[1]} MPa` },
  { re: /(\d{4,5})\s?psi\b/i, format: m => `${m[1]} psi` },
];

const GRADE_PROPS = /^(grade|material.?grade|strength.?class|concrete.?(grade|strength)|steel.?grade|festigkeitsklasse|betong(ü|ue)te|stahlg(ü|ue)te|强度等级|钢号|混凝土等级)$/i;

export function gradeFromText(text: string | null | undefined, material: MaterialEnum | null): string | null {
  if (!text) return null;
  for (const g of GRADE_PATTERNS) {
    if (g.materials && (!material || !g.materials.includes(material))) continue;
    const m = text.match(g.re);
    if (m) return g.format(m);
  }
  return null;
}

/** Names of all materials associated with an element (single, layers, list, constituents, profiles). */
function materialNames(model: IfcModel, id: number): string[] {
  const sel = materialSelect(model, id);
  if (!sel) return [];
  const out: string[] = [];
  const add = (m: any) => { const s = str(m?.Name); if (s) out.push(s); };
  const walk = (x: any, depth = 0) => {
    if (!x || depth > 3) return;
    const cls = model.className(x.expressID);
    if (cls === 'IfcMaterial') add(x);
    else if (cls === 'IfcMaterialList') for (const m of model.refs(x.Materials)) add(m);
    else if (cls === 'IfcMaterialLayerSetUsage') walk(model.ref(x.ForLayerSet), depth + 1);
    else if (cls === 'IfcMaterialLayerSet') for (const l of model.refs(x.MaterialLayers)) add(model.ref(l.Material));
    else if (cls === 'IfcMaterialProfileSetUsage') walk(model.ref(x.ForProfileSet), depth + 1);
    else if (cls === 'IfcMaterialProfileSet') for (const p of model.refs(x.MaterialProfiles)) add(model.ref(p.Material));
    else if (cls === 'IfcMaterialConstituentSet') for (const c of model.refs(x.MaterialConstituents)) add(model.ref(c.Material));
  };
  walk(sel);
  return out;
}

/** Strength grade (C30/37, S355, Q355, A992, GL24h, "345 MPa" …) from a grade property or the material names. */
export function materialGrade(model: IfcModel, id: number, material: MaterialEnum | null): string | null {
  for (const [, props] of model.propertySets(id)) {
    for (const [k, v] of props) {
      if (typeof v !== 'string' || !GRADE_PROPS.test(k.trim())) continue;
      const g = gradeFromText(v, material);
      if (g) return g;
    }
  }
  for (const name of materialNames(model, id)) {
    const g = gradeFromText(name, material ?? materialFromName(name));
    if (g) return g;
  }
  return null;
}
