/**
 * Read access to an open web-ifc model: typed attribute helpers, the inverse
 * relationships the importer needs (containment, aggregation, voids / fills,
 * materials, property sets, types, systems, ports), the length unit and
 * placement matrices. Knows nothing about BimDown.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- web-ifc lines are untyped */
import * as W from 'web-ifc';
import { type Mat4, mat4FromColumnMajor, mul, scaleTranslation } from './math.js';

type IfcAPI = W.IfcAPI;

const CLASS_NAMES = new Map<string, string>();
for (const ns of [(W as any).IFC4, (W as any).IFC2X3]) {
  if (!ns) continue;
  for (const k of Object.keys(ns)) if (k.startsWith('Ifc')) CLASS_NAMES.set(k.toUpperCase(), k);
}

/** A property value read from a property set / quantity set. */
export type PropValue = string | number | boolean;

export class IfcModel {
  readonly api: IfcAPI;
  readonly id: number;
  readonly schema: string;
  /** File length unit → meters. */
  readonly scale: number;

  private lines = new Map<number, any>();
  private typeCache = new Map<number, number>();
  private psetCache = new Map<number, Map<string, Map<string, PropValue>>>();
  private worldCache = new Map<number, Mat4>();
  /** Plan shift applied to every world position (far-from-origin models are moved near 0). */
  private offset = { x: 0, y: 0 };

  /** element → spatial container (storey / space / building …). */
  readonly container = new Map<number, number>();
  /** part → whole (IfcRelAggregates). */
  readonly parent = new Map<number, number>();
  /** whole → parts. */
  readonly parts = new Map<number, number[]>();
  /** opening → voided element. */
  readonly voids = new Map<number, number>();
  /** element → its openings. */
  readonly openingsOf = new Map<number, number[]>();
  /** filling (door / window) → opening it fills. */
  readonly fillOf = new Map<number, number>();
  /** opening → filling. */
  readonly filledBy = new Map<number, number>();
  /** object (instance or type) → associated material select. */
  readonly material = new Map<number, number>();
  /** object → property set definitions. */
  readonly psets = new Map<number, number[]>();
  /** instance → type object. */
  readonly typeOf = new Map<number, number>();
  /** element → systems / groups it belongs to. */
  readonly groups = new Map<number, number[]>();
  /** element → ports. */
  readonly ports = new Map<number, number[]>();
  /** port → element. */
  readonly portOwner = new Map<number, number>();
  /** port → connected port. */
  readonly portLink = new Map<number, number>();

  constructor(api: IfcAPI, modelID: number) {
    this.api = api;
    this.id = modelID;
    this.schema = api.GetModelSchema(modelID);
    this.scale = this.readLengthScale();
    this.indexRelationships();
  }

  // ─── Lines and values ──────────────────────────────────────────────────────

  line(id: number | null | undefined): any {
    if (!id) return null;
    let l = this.lines.get(id);
    if (l === undefined) {
      try { l = this.api.GetLine(this.id, id, false); } catch { l = null; }
      this.lines.set(id, l);
    }
    return l;
  }

  /** Dereference an attribute that holds a reference (or return the inline object). */
  ref(attr: any): any {
    if (attr == null) return null;
    if (typeof attr === 'object' && attr.type === 5 && typeof attr.value === 'number') return this.line(attr.value);
    return attr;
  }

  refs(attr: any): any[] {
    if (!Array.isArray(attr)) return attr ? [this.ref(attr)].filter(Boolean) : [];
    return attr.map(a => this.ref(a)).filter(Boolean);
  }

  typeCode(id: number): number {
    let t = this.typeCache.get(id);
    if (t === undefined) {
      try { t = this.api.GetLineType(this.id, id) as number; } catch { t = 0; }
      this.typeCache.set(id, t);
    }
    return t;
  }

  /** IFC class name of a line, e.g. "IfcWallStandardCase". */
  className(id: number): string {
    const upper = this.api.GetNameFromTypeCode(this.typeCode(id)) ?? '';
    return CLASS_NAMES.get(upper) ?? upper;
  }

  idsOfType(type: number, inherited = false): number[] {
    const v = this.api.GetLineIDsWithType(this.id, type, inherited);
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    return out;
  }

  // ─── Units ─────────────────────────────────────────────────────────────────

  private readLengthScale(): number {
    const project = this.idsOfType(W.IFCPROJECT)[0];
    const p = this.line(project);
    const assignment = this.ref(p?.UnitsInContext);
    for (const u of this.refs(assignment?.Units)) {
      if (u?.UnitType?.value !== 'LENGTHUNIT') continue;
      return unitScale(this, u);
    }
    return 1;
  }

  /** A length attribute (number or IfcLengthMeasure) in meters. */
  len(attr: any): number | null {
    const v = num(attr);
    return v === null ? null : v * this.scale;
  }

  // ─── Placement ─────────────────────────────────────────────────────────────

  /** World matrix (IFC Z-up, meters) of an IfcObjectPlacement. */
  placementMatrix(placementId: number | null | undefined): Mat4 | null {
    if (!placementId) return null;
    let m = this.worldCache.get(placementId);
    if (!m) {
      try {
        m = scaleTranslation(mat4FromColumnMajor(this.api.GetWorldTransformMatrix(this.id, placementId)), this.scale);
        m[12] -= this.offset.x;
        m[13] -= this.offset.y;
      } catch {
        return null;
      }
      this.worldCache.set(placementId, m);
    }
    return m;
  }

  setOffset(x: number, y: number): void {
    this.offset = { x, y };
    this.worldCache.clear();
  }

  /** World matrix of a product's ObjectPlacement. */
  productMatrix(productId: number): Mat4 | null {
    const p = this.line(productId);
    return this.placementMatrix(p?.ObjectPlacement?.value);
  }

  /** IfcAxis2Placement2D/3D (in file units) → matrix in meters. */
  axisPlacement(attr: any): Mat4 {
    return axis2Placement(this, this.ref(attr));
  }

  /** Compose a product's world matrix with a local axis placement. */
  local(productId: number, placement: any): Mat4 | null {
    const world = this.productMatrix(productId);
    return world ? mul(world, this.axisPlacement(placement)) : null;
  }

  // ─── Relationships ─────────────────────────────────────────────────────────

  private each(type: number, fn: (rel: any) => void): void {
    for (const id of this.idsOfType(type)) {
      const rel = this.line(id);
      if (rel) fn(rel);
      this.lines.delete(id); // relationships are read once
    }
  }

  private indexRelationships(): void {
    const ids = (a: any): number[] => (Array.isArray(a) ? a : a ? [a] : []).map((x: any) => x?.value).filter((x: any) => typeof x === 'number');
    const push = (m: Map<number, number[]>, k: number, v: number) => {
      const l = m.get(k);
      if (l) l.push(v); else m.set(k, [v]);
    };
    this.each(W.IFCRELCONTAINEDINSPATIALSTRUCTURE, r => {
      const s = r.RelatingStructure?.value;
      for (const e of ids(r.RelatedElements)) this.container.set(e, s);
    });
    this.each(W.IFCRELAGGREGATES, r => {
      const whole = r.RelatingObject?.value;
      for (const p of ids(r.RelatedObjects)) { this.parent.set(p, whole); push(this.parts, whole, p); }
    });
    if ((W as any).IFCRELNESTS) {
      this.each(W.IFCRELNESTS, r => {
        const whole = r.RelatingObject?.value;
        for (const p of ids(r.RelatedObjects)) {
          if (this.typeCode(p) === W.IFCDISTRIBUTIONPORT) { push(this.ports, whole, p); this.portOwner.set(p, whole); }
        }
      });
    }
    this.each(W.IFCRELCONNECTSPORTTOELEMENT, r => {
      const port = r.RelatingPort?.value, el = r.RelatedElement?.value;
      if (port && el) { push(this.ports, el, port); this.portOwner.set(port, el); }
    });
    this.each(W.IFCRELCONNECTSPORTS, r => {
      const a = r.RelatingPort?.value, b = r.RelatedPort?.value;
      if (a && b) { this.portLink.set(a, b); this.portLink.set(b, a); }
    });
    this.each(W.IFCRELVOIDSELEMENT, r => {
      const host = r.RelatingBuildingElement?.value, op = r.RelatedOpeningElement?.value;
      if (host && op) { this.voids.set(op, host); push(this.openingsOf, host, op); }
    });
    this.each(W.IFCRELFILLSELEMENT, r => {
      const op = r.RelatingOpeningElement?.value, fill = r.RelatedBuildingElement?.value;
      if (op && fill) { this.fillOf.set(fill, op); this.filledBy.set(op, fill); }
    });
    this.each(W.IFCRELASSOCIATESMATERIAL, r => {
      const mat = r.RelatingMaterial?.value;
      if (!mat) return;
      for (const o of ids(r.RelatedObjects)) this.material.set(o, mat);
    });
    this.each(W.IFCRELDEFINESBYPROPERTIES, r => {
      const def = r.RelatingPropertyDefinition?.value;
      if (!def) return;
      for (const o of ids(r.RelatedObjects)) push(this.psets, o, def);
    });
    this.each(W.IFCRELDEFINESBYTYPE, r => {
      const t = r.RelatingType?.value;
      if (!t) return;
      for (const o of ids(r.RelatedObjects)) this.typeOf.set(o, t);
    });
    this.each(W.IFCRELASSIGNSTOGROUP, r => {
      const g = r.RelatingGroup?.value;
      if (!g) return;
      for (const o of ids(r.RelatedObjects)) push(this.groups, o, g);
    });
  }

  // ─── Property sets ─────────────────────────────────────────────────────────

  /** Property sets (and quantity sets) of an object, including its type's. Keys are set names. */
  propertySets(objectId: number): Map<string, Map<string, PropValue>> {
    let out = this.psetCache.get(objectId);
    if (out) return out;
    out = new Map();
    const typeId = this.typeOf.get(objectId);
    const typeLine = typeId ? this.line(typeId) : null;
    const defs = [...this.refs(typeLine?.HasPropertySets), ...(this.psets.get(objectId) ?? []).map(id => this.line(id))];
    for (const def of defs) {
      if (!def) continue;
      const name = str(def.Name) ?? '';
      const props = out.get(name) ?? new Map<string, PropValue>();
      for (const p of this.refs(def.HasProperties ?? def.Quantities)) {
        const key = str(p.Name);
        if (!key) continue;
        const v = propValue(p);
        if (v !== null) props.set(key, v);
      }
      out.set(name, props);
    }
    this.psetCache.set(objectId, out);
    return out;
  }

  /** First value of `prop` in any set whose name matches `setPattern`. */
  prop(objectId: number, setPattern: RegExp, prop: string): PropValue | null {
    for (const [name, props] of this.propertySets(objectId)) {
      if (!setPattern.test(name)) continue;
      const v = props.get(prop);
      if (v !== undefined) return v;
    }
    return null;
  }

  bool(objectId: number, setPattern: RegExp, prop: string): boolean | null {
    const v = this.prop(objectId, setPattern, prop);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return /^(true|t|yes|\.t\.)$/i.test(v);
    return null;
  }
}

// ─── Value helpers ───────────────────────────────────────────────────────────

/** String value of a label / identifier / text attribute. */
export function str(attr: any): string | null {
  if (attr == null) return null;
  const v = typeof attr === 'object' ? attr.value : attr;
  if (v == null) return null;
  const s = decodeIfcString(String(v)).trim();
  return s === '' ? null : s;
}

export function num(attr: any): number | null {
  if (attr == null) return null;
  const v = typeof attr === 'object' ? attr.value : attr;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Enum attribute value, e.g. "FLOOR". */
export function enumValue(attr: any): string | null {
  if (attr == null) return null;
  const v = typeof attr === 'object' ? attr.value : attr;
  return typeof v === 'string' ? v.replace(/^\./, '').replace(/\.$/, '') : null;
}

function propValue(p: any): PropValue | null {
  // IfcPropertySingleValue
  if (p.NominalValue !== undefined) {
    const v = p.NominalValue;
    if (v == null) return null;
    const raw = typeof v === 'object' ? v.value : v;
    if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      if (v.name === 'IFCBOOLEAN' || v.name === 'IFCLOGICAL') return raw === 'T' || raw === '.T.' || raw === 'true';
      return decodeIfcString(raw);
    }
    return null;
  }
  // IfcPropertyEnumeratedValue
  if (Array.isArray(p.EnumerationValues)) {
    const first = p.EnumerationValues[0];
    return first ? str(first) : null;
  }
  // IfcQuantityLength / Area / Volume / Count
  for (const k of ['LengthValue', 'AreaValue', 'VolumeValue', 'CountValue', 'WeightValue']) {
    if (p[k] !== undefined) return num(p[k]);
  }
  return null;
}

/** Decode STEP string escapes (\X2\…\X0\, \X\hh, \S\c). web-ifc keeps them verbatim. */
export function decodeIfcString(s: string): string {
  if (!s.includes('\\')) return s;
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex: string) => {
      let out = '';
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 128));
}

const SI_PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10,
  DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9,
};

function unitScale(model: IfcModel, u: any): number {
  if (!u) return 1;
  if (u.Prefix !== undefined || u.Name?.value === 'METRE') {
    const prefix = enumValue(u.Prefix);
    return prefix ? SI_PREFIX[prefix] ?? 1 : 1;
  }
  // IfcConversionBasedUnit: ConversionFactor (IfcMeasureWithUnit) = value × unit
  const factor = model.ref(u.ConversionFactor);
  if (factor) {
    const v = num(factor.ValueComponent);
    const base = unitScale(model, model.ref(factor.UnitComponent));
    if (v !== null) return v * base;
  }
  const name = (str(u.Name) ?? '').toLowerCase();
  if (name.includes('foot') || name === 'ft') return 0.3048;
  if (name.includes('inch')) return 0.0254;
  return 1;
}

function vec(model: IfcModel, attr: any): number[] | null {
  const l = model.ref(attr);
  const c = l?.DirectionRatios ?? l?.Coordinates;
  if (!Array.isArray(c)) return null;
  return c.map((x: any) => num(x) ?? 0);
}

/** IfcAxis2Placement2D / 3D → matrix (translation in meters). */
function axis2Placement(model: IfcModel, p: any): Mat4 {
  const m: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!p) return m;
  const loc = vec(model, p.Location) ?? [0, 0, 0];
  const z = vec(model, p.Axis) ?? [0, 0, 1];
  const xr = vec(model, p.RefDirection) ?? [1, 0, 0];
  const z3 = normalize3([z[0] ?? 0, z[1] ?? 0, z[2] ?? 1]);
  const x0 = [xr[0] ?? 1, xr[1] ?? 0, xr[2] ?? 0];
  // Gram–Schmidt: x ⟂ z
  const d = x0[0] * z3[0] + x0[1] * z3[1] + x0[2] * z3[2];
  const x3 = normalize3([x0[0] - d * z3[0], x0[1] - d * z3[1], x0[2] - d * z3[2]]);
  const y3 = [z3[1] * x3[2] - z3[2] * x3[1], z3[2] * x3[0] - z3[0] * x3[2], z3[0] * x3[1] - z3[1] * x3[0]];
  const s = model.scale;
  // Column-major rows: [x | y | z | t]
  return [x3[0], x3[1], x3[2], 0, y3[0], y3[1], y3[2], 0, z3[0], z3[1], z3[2], 0,
    (loc[0] ?? 0) * s, (loc[1] ?? 0) * s, (loc[2] ?? 0) * s, 1];
}

function normalize3(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
