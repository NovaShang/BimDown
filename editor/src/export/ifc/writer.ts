/**
 * Thin, schema-aware layer over web-ifc's entity classes: writes entities,
 * wraps typed values, and turns the geometry IR (frame.ts) into IFC
 * placements, profiles and solids. Knows nothing about BimDown tables.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- web-ifc's generated schema constructors are too strict to type here */
import type { Frame, Profile, Solid, V2, V3 } from './frame.ts';
import { relFrame, toLocal } from './frame.ts';
import { ifcGuid } from './guid.ts';

export type IfcSchema = 'IFC2X3' | 'IFC4';
/** web-ifc `Handle` — typed loosely, like the generated schema classes. */
export type H = any;

/** Drop float noise (0.8999999999999986 → 0.9) and signed zeros. */
const clean = (n: number) => (Math.abs(n) < 1e-10 ? 0 : Math.round(n * 1e9) / 1e9);

export class IfcWriter {
  ownerHistory: H = null;
  bodyContext: H = null;
  axisContext: H = null;
  private usedGuids = new Set<string>();
  private dirCache = new Map<string, H>();
  private styleCache = new Map<string, H>();

  readonly api: any;
  readonly model: number;
  readonly schema: IfcSchema;
  /** web-ifc schema namespace (WebIFC.IFC2X3 / WebIFC.IFC4). */
  readonly S: any;
  readonly Handle: any;

  constructor(api: any, model: number, schema: IfcSchema, S: any, Handle: any) {
    this.api = api;
    this.model = model;
    this.schema = schema;
    this.S = S;
    this.Handle = Handle;
  }

  get ifc4(): boolean { return this.schema === 'IFC4'; }

  has(type: string): boolean { return typeof this.S[type] === 'function'; }

  /** Write one entity; missing trailing (optional) arguments are written as `$`. */
  add(type: string, ...args: any[]): H {
    const Ctor = this.S[type];
    if (!Ctor) throw new Error(`IFC entity ${type} is not in ${this.schema}`);
    while (args.length < Ctor.length) args.push(null);
    const ent = new Ctor(...args);
    this.api.WriteLine(this.model, ent);
    return new this.Handle(ent.expressID);
  }

  // ─── Typed values ──────────────────────────────────────────────────────────

  label(s?: string | null) { return s === undefined || s === null || s === '' ? null : new this.S.IfcLabel(s); }
  text(s?: string | null) { return s === undefined || s === null || s === '' ? null : new this.S.IfcText(s); }
  ident(s?: string | null) { return s === undefined || s === null || s === '' ? null : new this.S.IfcIdentifier(s); }
  bool(b: boolean) { return new this.S.IfcBoolean(b); }
  real(n: number) { return new this.S.IfcReal(clean(n)); }
  len(n: number) { return new this.S.IfcLengthMeasure(clean(n)); }
  plen(n: number) { return new this.S.IfcPositiveLengthMeasure(Math.max(clean(n), 1e-6)); }
  int(n: number) { return new this.S.IfcInteger(Math.round(n)); }
  area(n: number) { return new this.S.IfcAreaMeasure(clean(n)); }
  volume(n: number) { return new this.S.IfcVolumeMeasure(clean(n)); }
  count(n: number) { return new this.S.IfcCountMeasure(n); }
  ratio(n: number) { return new this.S.IfcNormalisedRatioMeasure(Math.min(1, Math.max(0, n))); }

  /** Enum value; falls back (NOTDEFINED by default) when the schema lacks it. */
  enumv(enumType: string, value: string, fallback = 'NOTDEFINED') {
    const E = this.S[enumType];
    if (!E) return null;
    return E[value] ?? E[fallback] ?? null;
  }

  /** Deterministic GlobalId for `key`; repeated keys get a suffix so ids stay unique. */
  guid(key: string) {
    let k = key, n = 1;
    while (this.usedGuids.has(k)) k = `${key}#${++n}`;
    this.usedGuids.add(k);
    return new this.S.IfcGloballyUniqueId(ifcGuid(k));
  }

  // ─── Geometry primitives ───────────────────────────────────────────────────

  pt(v: V3): H { return this.add('IfcCartesianPoint', [clean(v.x), clean(v.y), clean(v.z)]); }
  pt2(v: V2): H { return this.add('IfcCartesianPoint', [clean(v.x), clean(v.y)]); }

  dir(v: V3): H {
    const c = [clean(v.x), clean(v.y), clean(v.z)];
    const key = c.map(n => n.toFixed(9)).join(',');
    let h = this.dirCache.get(key);
    if (!h) { h = this.add('IfcDirection', c); this.dirCache.set(key, h); }
    return h;
  }

  dir2(v: V2): H {
    const c = [clean(v.x), clean(v.y)];
    const key = `2:${c.map(n => n.toFixed(9)).join(',')}`;
    let h = this.dirCache.get(key);
    if (!h) { h = this.add('IfcDirection', c); this.dirCache.set(key, h); }
    return h;
  }

  /** IfcAxis2Placement3D; default axes are omitted (written as `$`). */
  axis3(f: Frame): H {
    const defaultAxes = Math.abs(f.z.z - 1) < 1e-9 && Math.abs(f.x.x - 1) < 1e-9;
    return this.add('IfcAxis2Placement3D', this.pt(f.o),
      defaultAxes ? null : this.dir(f.z), defaultAxes ? null : this.dir(f.x));
  }

  axis2(o: V2 = { x: 0, y: 0 }): H {
    return this.add('IfcAxis2Placement2D', this.pt2(o), null);
  }

  /** IfcLocalPlacement of `child` (world) relative to a parent placement whose world frame is `parentFrame`. */
  placement(parent: H | null, parentFrame: Frame, child: Frame): H {
    return this.add('IfcLocalPlacement', parent, this.axis3(relFrame(parentFrame, child)));
  }

  polyline2(pts: V2[], close = false): H {
    const hs = pts.map(p => this.pt2(p));
    if (close && pts.length > 0) hs.push(hs[0]);
    return this.add('IfcPolyline', hs);
  }

  polyline3(pts: V3[], close = false): H {
    const hs = pts.map(p => this.pt(p));
    if (close && pts.length > 0) hs.push(hs[0]);
    return this.add('IfcPolyline', hs);
  }

  profile(p: Profile): H {
    const AREA = this.S.IfcProfileTypeEnum.AREA;
    const name = this.label(p.name);
    switch (p.kind) {
      case 'rect':
        return this.add('IfcRectangleProfileDef', AREA, name, this.axis2({ x: p.cx ?? 0, y: p.cy ?? 0 }),
          this.plen(p.w), this.plen(p.d));
      case 'circle':
        return this.add('IfcCircleProfileDef', AREA, name, this.axis2({ x: p.cx ?? 0, y: p.cy ?? 0 }), this.plen(p.r));
      case 'ishape':
        return this.add('IfcIShapeProfileDef', AREA, name, this.axis2({ x: p.cx ?? 0, y: p.cy ?? 0 }),
          this.plen(p.w), this.plen(p.d), this.plen(p.web), this.plen(p.flange), null);
      case 'poly': {
        const outer = this.polyline2(p.outer, true);
        if (p.holes && p.holes.length > 0) {
          return this.add('IfcArbitraryProfileDefWithVoids', AREA, name, outer, p.holes.map(h => this.polyline2(h, true)));
        }
        return this.add('IfcArbitraryClosedProfileDef', AREA, name, outer);
      }
    }
  }

  /** One solid, converted from world coordinates into the product frame `local`. */
  solid(s: Solid, local: Frame): H {
    if (s.kind === 'extrude') {
      const f = relFrame(local, s.frame);
      return this.add('IfcExtrudedAreaSolid', this.profile(s.profile), this.axis3(f),
        this.dir({ x: 0, y: 0, z: 1 }), this.plen(s.depth));
    }
    const pointIds = new Map<string, H>();
    const point = (p: V3) => {
      const l = toLocal(local, p);
      const key = `${l.x.toFixed(6)},${l.y.toFixed(6)},${l.z.toFixed(6)}`;
      let h = pointIds.get(key);
      if (!h) { h = this.pt(l); pointIds.set(key, h); }
      return h;
    };
    const faces = s.faces.map(poly => {
      const loop = this.add('IfcPolyLoop', poly.map(point));
      return this.add('IfcFace', [this.add('IfcFaceOuterBound', loop, this.ifc4 ? this.bool(true) : true)]);
    });
    return this.add('IfcFacetedBrep', this.add('IfcClosedShell', faces));
  }

  /**
   * Product shape: a Body representation of the solids (converted into the
   * product frame `local`), plus an Axis curve when given. `styles` is one
   * surface style for every item or one per solid.
   */
  productShapeStyled(solids: Solid[], local: Frame, axis?: V3[], styles?: H | (H | null)[] | null): H | null {
    const reps: H[] = [];
    if (axis && axis.length >= 2) {
      const curve = this.polyline3(axis.map(p => toLocal(local, p)));
      reps.push(this.add('IfcShapeRepresentation', this.axisContext, this.label('Axis'), this.label('Curve3D'), [curve]));
    }
    if (solids.length > 0) {
      const items = solids.map(s => this.solid(s, local));
      items.forEach((item, i) => {
        const style = Array.isArray(styles) ? styles[i] : styles;
        if (style) this.styleItem(item, style);
      });
      const type = solids.every(s => s.kind === 'extrude') ? 'SweptSolid' : solids.every(s => s.kind === 'brep') ? 'Brep' : 'SolidModel';
      reps.push(this.add('IfcShapeRepresentation', this.bodyContext, this.label('Body'), this.label(type), items));
    }
    if (reps.length === 0) return null;
    return this.add('IfcProductDefinitionShape', null, null, reps);
  }

  /** Cached surface style (colour + transparency) keyed by name. */
  surfaceStyle(name: string, hex: string, transparency: number): H {
    let h = this.styleCache.get(name);
    if (h) return h;
    const n = parseInt(hex.replace('#', ''), 16) || 0xb8b8b8;
    const colour = this.add('IfcColourRgb', null,
      this.ratio(((n >> 16) & 255) / 255), this.ratio(((n >> 8) & 255) / 255), this.ratio((n & 255) / 255));
    const rendering = this.add('IfcSurfaceStyleRendering', colour, transparency > 0 ? this.ratio(transparency) : null,
      null, null, null, null, null, null, this.S.IfcReflectanceMethodEnum.NOTDEFINED);
    h = this.add('IfcSurfaceStyle', this.label(name), this.S.IfcSurfaceSide.BOTH, [rendering]);
    this.styleCache.set(name, h);
    return h;
  }

  private styleItem(item: H, style: H): void {
    const styles = this.ifc4 ? [style] : [this.add('IfcPresentationStyleAssignment', [style])];
    this.add('IfcStyledItem', item, styles, null);
  }

  // ─── Property sets / quantities ────────────────────────────────────────────

  /** IfcPropertySet from name → value; null/undefined values are skipped. */
  propertySet(key: string, name: string, props: Record<string, any>): H | null {
    const hs: H[] = [];
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined) continue;
      hs.push(this.add('IfcPropertySingleValue', this.ident(k), null, v, null));
    }
    if (hs.length === 0) return null;
    return this.add('IfcPropertySet', this.guid(key), this.ownerHistory, this.label(name), null, hs);
  }

  elementQuantity(key: string, name: string, quantities: { kind: 'length' | 'area' | 'volume'; name: string; value: number }[]): H | null {
    const hs = quantities.filter(q => Number.isFinite(q.value) && q.value > 0).map(q => {
      if (q.kind === 'length') return this.add('IfcQuantityLength', this.label(q.name), null, null, this.len(q.value));
      if (q.kind === 'area') return this.add('IfcQuantityArea', this.label(q.name), null, null, this.area(q.value));
      return this.add('IfcQuantityVolume', this.label(q.name), null, null, this.volume(q.value));
    });
    if (hs.length === 0) return null;
    return this.add('IfcElementQuantity', this.guid(key), this.ownerHistory, this.label(name), null, null, hs);
  }
}
