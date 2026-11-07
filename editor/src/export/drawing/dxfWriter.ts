/**
 * Minimal DXF R2007 (AC1021, UTF-8) writer: layers with colour, linetype and
 * lineweight, LINE / LWPOLYLINE / CIRCLE / ARC / TEXT / solid HATCH in model
 * space, with a proper handle/owner structure so AutoCAD, BricsCAD, LibreCAD
 * and ezdxf open it without recovery.
 */
import type { ProjectUnit } from '../../types.ts';
import type { Point } from '../../model/elements.ts';

export interface DxfLayer {
  name: string;
  aci: number;
  /** 0xRRGGBB true colour, optional. */
  trueColor?: number;
  /** Paper mm; snapped to a standard AutoCAD lineweight. */
  weight: number;
  linetype: string;
}

export interface DxfLinetype {
  name: string;
  description: string;
  /** Dash lengths in model units: > 0 dash, < 0 gap, 0 dot. */
  pattern: number[];
}

export interface DxfEntityStyle {
  layer: string;
  aci?: number;
  trueColor?: number;
  linetype?: string;
  /** Paper mm. */
  weight?: number;
}

export type TextAlign = 'left' | 'center' | 'right';
export type TextVAlign = 'baseline' | 'middle';

/** `$INSUNITS` per project unit. */
export const INSUNITS: Record<ProjectUnit, number> = { in: 1, ft: 2, mm: 4, m: 6 };

const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

export function dxfLineweight(mm: number): number {
  const v = mm * 100;
  return LINEWEIGHTS.reduce((best, w) => (Math.abs(w - v) < Math.abs(best - v) ? w : best), LINEWEIGHTS[0]);
}

const num = (v: number) => {
  if (!Number.isFinite(v)) return '0.0';
  const s = (Math.abs(v) < 1e-12 ? 0 : v).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
  return s === '-0.0' ? '0.0' : s;
};

/** DXF text: one line, control characters dropped; `^`, `%%` would be parsed, escape them. */
function cleanText(s: string): string {
  const printable = [...s.replace(/[\r\n\t]+/g, ' ')].filter(ch => ch.charCodeAt(0) >= 0x20).join('');
  return printable.replace(/%%/g, '%%%').replace(/\^/g, '^ ');
}

export class DxfWriter {
  private seed = 0x30;
  private readonly layers = new Map<string, DxfLayer>();
  private readonly linetypes = new Map<string, DxfLinetype>();
  private readonly entities: string[] = [];
  private ext = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  /** Handle of *Model_Space's BLOCK_RECORD, owner of every entity. */
  private readonly msRecord: string;
  private readonly psRecord: string;
  private readonly unit: ProjectUnit;
  private readonly textFont: string;

  constructor(unit: ProjectUnit, textFont = 'arial.ttf') {
    this.unit = unit;
    this.textFont = textFont;
    this.msRecord = this.h();
    this.psRecord = this.h();
    this.addLayer({ name: '0', aci: 7, weight: 0.25, linetype: 'Continuous' });
  }

  private h(): string { return (this.seed++).toString(16).toUpperCase(); }

  addLinetype(lt: DxfLinetype) { this.linetypes.set(lt.name, lt); }
  addLayer(l: DxfLayer) { if (!this.layers.has(l.name)) this.layers.set(l.name, l); }

  private grow(p: Point, r = 0) {
    this.ext.minX = Math.min(this.ext.minX, p.x - r); this.ext.minY = Math.min(this.ext.minY, p.y - r);
    this.ext.maxX = Math.max(this.ext.maxX, p.x + r); this.ext.maxY = Math.max(this.ext.maxY, p.y + r);
  }

  private head(type: string, st: DxfEntityStyle, subclass: string): string[] {
    const g = ['0', type, '5', this.h(), '330', this.msRecord, '100', 'AcDbEntity', '8', st.layer];
    if (st.linetype) g.push('6', st.linetype);
    if (st.aci !== undefined) g.push('62', String(st.aci));
    if (st.weight !== undefined) g.push('370', String(dxfLineweight(st.weight)));
    if (st.trueColor !== undefined) g.push('420', String(st.trueColor));
    g.push('100', subclass);
    return g;
  }

  line(a: Point, b: Point, st: DxfEntityStyle) {
    this.grow(a); this.grow(b);
    this.entities.push(...this.head('LINE', st, 'AcDbLine'),
      '10', num(a.x), '20', num(a.y), '30', '0.0', '11', num(b.x), '21', num(b.y), '31', '0.0');
  }

  polyline(pts: Point[], closed: boolean, st: DxfEntityStyle) {
    if (pts.length < 2) return;
    if (pts.length === 2 && !closed) return this.line(pts[0], pts[1], st);
    const g = this.head('LWPOLYLINE', st, 'AcDbPolyline');
    // 128: generate the linetype pattern continuously around vertices
    g.push('90', String(pts.length), '70', String((closed ? 1 : 0) | 128), '43', '0.0');
    for (const p of pts) { this.grow(p); g.push('10', num(p.x), '20', num(p.y)); }
    this.entities.push(...g);
  }

  circle(c: Point, r: number, st: DxfEntityStyle) {
    this.grow(c, r);
    this.entities.push(...this.head('CIRCLE', st, 'AcDbCircle'), '10', num(c.x), '20', num(c.y), '30', '0.0', '40', num(r));
  }

  /** Counter-clockwise from `startRad` to `endRad`. */
  arc(c: Point, r: number, startRad: number, endRad: number, st: DxfEntityStyle) {
    this.grow(c, r);
    const deg = (a: number) => ((((a * 180) / Math.PI) % 360) + 360) % 360;
    this.entities.push(...this.head('ARC', st, 'AcDbCircle'), '10', num(c.x), '20', num(c.y), '30', '0.0', '40', num(r),
      '100', 'AcDbArc', '50', num(deg(startRad)), '51', num(deg(endRad)));
  }

  text(at: Point, text: string, height: number, st: DxfEntityStyle, o: { align?: TextAlign; valign?: TextVAlign; rotationRad?: number } = {}) {
    const value = cleanText(text);
    if (!value.trim()) return;
    this.grow(at, height);
    const h = ({ left: 0, center: 1, right: 2 } as const)[o.align ?? 'left'];
    const v = o.valign === 'middle' ? 2 : 0;
    const g = this.head('TEXT', st, 'AcDbText');
    g.push('10', num(at.x), '20', num(at.y), '30', '0.0', '40', num(height), '1', value,
      '50', num((((o.rotationRad ?? 0) * 180) / Math.PI + 360) % 360), '7', 'BIMDOWN');
    if (h || v) g.push('72', String(h), '11', num(at.x), '21', num(at.y), '31', '0.0');
    g.push('100', 'AcDbText');
    if (v) g.push('73', String(v));
    this.entities.push(...g);
  }

  /** Solid-filled closed boundary. */
  solidHatch(pts: Point[], st: DxfEntityStyle) {
    if (pts.length < 3) return;
    const g = this.head('HATCH', st, 'AcDbHatch');
    g.push('10', '0.0', '20', '0.0', '30', '0.0', '210', '0.0', '220', '0.0', '230', '1.0',
      '2', 'SOLID', '70', '1', '71', '0', '91', '1',
      '92', '3', '72', '0', '73', '1', '93', String(pts.length));
    for (const p of pts) { this.grow(p); g.push('10', num(p.x), '20', num(p.y)); }
    g.push('97', '0', '75', '0', '76', '1', '98', '0');
    this.entities.push(...g);
  }

  // ─── Serialisation ────────────────────────────────────────────────────────

  toString(): string {
    const out: string[] = [];
    const push = (...g: string[]) => out.push(...g);
    const ext = Number.isFinite(this.ext.minX) ? this.ext : { minX: 0, minY: 0, maxX: 10, maxY: 10 };

    // Tables, blocks and objects are written into `body` first so $HANDSEED covers every handle
    const body: string[] = [];
    const b = (...g: string[]) => body.push(...g);
    const table = (name: string, count: number, entries: () => void, extraSub?: string) => {
      const th = this.h();
      b('0', 'TABLE', '2', name, '5', th, '330', '0', '100', 'AcDbSymbolTable');
      if (extraSub) b('100', extraSub);
      b('70', String(count));
      tableOwner = th;
      entries();
      b('0', 'ENDTAB');
    };
    let tableOwner = '0';
    const rec = (type: string, sub: string, name: string, handleCode = '5') => {
      b('0', type, handleCode, this.h(), '330', tableOwner, '100', 'AcDbSymbolTableRecord', '100', sub, '2', name, '70', '0');
    };

    b('0', 'SECTION', '2', 'CLASSES', '0', 'ENDSEC');
    b('0', 'SECTION', '2', 'TABLES');
    const w = Math.max(ext.maxX - ext.minX, 1e-6), hgt = Math.max(ext.maxY - ext.minY, 1e-6);
    table('VPORT', 1, () => {
      rec('VPORT', 'AcDbViewportTableRecord', '*ACTIVE');
      b('10', '0.0', '20', '0.0', '11', '1.0', '21', '1.0',
        '12', num((ext.minX + ext.maxX) / 2), '22', num((ext.minY + ext.maxY) / 2),
        '13', '0.0', '23', '0.0', '14', '1.0', '24', '1.0', '15', '0.0', '25', '0.0',
        '16', '0.0', '26', '0.0', '36', '1.0', '17', '0.0', '27', '0.0', '37', '0.0',
        '40', num(Math.max(hgt, w / 1.6) * 1.1), '41', '1.6', '42', '50.0', '43', '0.0', '44', '0.0',
        '50', '0.0', '51', '0.0', '71', '0', '72', '100', '73', '1', '74', '3', '75', '0', '76', '0', '77', '0', '78', '0',
        '281', '0', '65', '1', '146', '0.0');
    });
    const ltypes: DxfLinetype[] = [
      { name: 'ByBlock', description: '', pattern: [] },
      { name: 'ByLayer', description: '', pattern: [] },
      { name: 'Continuous', description: 'Solid line', pattern: [] },
      ...this.linetypes.values(),
    ];
    table('LTYPE', ltypes.length, () => {
      for (const lt of ltypes) {
        rec('LTYPE', 'AcDbLinetypeTableRecord', lt.name);
        const total = lt.pattern.reduce((s, v) => s + Math.abs(v), 0);
        b('3', lt.description, '72', '65', '73', String(lt.pattern.length), '40', num(total));
        for (const v of lt.pattern) b('49', num(v), '74', '0');
      }
    });
    table('LAYER', this.layers.size, () => {
      for (const l of this.layers.values()) {
        rec('LAYER', 'AcDbLayerTableRecord', l.name);
        b('62', String(l.aci));
        if (l.trueColor !== undefined) b('420', String(l.trueColor));
        b('6', l.linetype, '370', String(dxfLineweight(l.weight)));
      }
    });
    table('STYLE', 2, () => {
      for (const [name, font] of [['Standard', 'txt'], ['BIMDOWN', this.textFont]]) {
        rec('STYLE', 'AcDbTextStyleTableRecord', name);
        b('40', '0.0', '41', '1.0', '50', '0.0', '71', '0', '42', '2.5', '3', font, '4', '');
      }
    });
    table('VIEW', 0, () => {});
    table('UCS', 0, () => {});
    table('APPID', 1, () => { rec('APPID', 'AcDbRegAppTableRecord', 'ACAD'); });
    table('DIMSTYLE', 1, () => { rec('DIMSTYLE', 'AcDbDimStyleTableRecord', 'Standard', '105'); }, 'AcDbDimStyleTable');
    const blockRecordTable = this.h();
    b('0', 'TABLE', '2', 'BLOCK_RECORD', '5', blockRecordTable, '330', '0', '100', 'AcDbSymbolTable', '70', '2');
    for (const [handle, name] of [[this.msRecord, '*Model_Space'], [this.psRecord, '*Paper_Space']]) {
      b('0', 'BLOCK_RECORD', '5', handle, '330', blockRecordTable, '100', 'AcDbSymbolTableRecord',
        '100', 'AcDbBlockTableRecord', '2', name, '70', '0', '280', '1', '281', '0');
    }
    b('0', 'ENDTAB', '0', 'ENDSEC');

    b('0', 'SECTION', '2', 'BLOCKS');
    for (const [owner, name, paper] of [[this.msRecord, '*Model_Space', false], [this.psRecord, '*Paper_Space', true]] as const) {
      b('0', 'BLOCK', '5', this.h(), '330', owner, '100', 'AcDbEntity');
      if (paper) b('67', '1');
      b('8', '0', '100', 'AcDbBlockBegin', '2', name, '70', '0', '10', '0.0', '20', '0.0', '30', '0.0', '3', name, '1', '');
      b('0', 'ENDBLK', '5', this.h(), '330', owner, '100', 'AcDbEntity');
      if (paper) b('67', '1');
      b('8', '0', '100', 'AcDbBlockEnd');
    }
    b('0', 'ENDSEC');

    b('0', 'SECTION', '2', 'ENTITIES', ...this.entities, '0', 'ENDSEC');

    const root = this.h(), groups = this.h();
    b('0', 'SECTION', '2', 'OBJECTS',
      '0', 'DICTIONARY', '5', root, '330', '0', '100', 'AcDbDictionary', '281', '1', '3', 'ACAD_GROUP', '350', groups,
      '0', 'DICTIONARY', '5', groups, '330', root, '100', 'AcDbDictionary', '281', '1',
      '0', 'ENDSEC', '0', 'EOF');

    const metric = this.unit === 'm' || this.unit === 'mm';
    push('0', 'SECTION', '2', 'HEADER',
      '9', '$ACADVER', '1', 'AC1021',
      '9', '$DWGCODEPAGE', '3', 'ANSI_1252',
      '9', '$HANDSEED', '5', this.h(),
      '9', '$INSUNITS', '70', String(INSUNITS[this.unit]),
      '9', '$MEASUREMENT', '70', metric ? '1' : '0',
      '9', '$LUNITS', '70', '2',
      '9', '$LUPREC', '70', this.unit === 'mm' ? '0' : '3',
      '9', '$LTSCALE', '40', '1.0',
      '9', '$PSLTSCALE', '70', '0',
      '9', '$LWDISPLAY', '290', '1',
      '9', '$EXTMIN', '10', num(ext.minX), '20', num(ext.minY), '30', '0.0',
      '9', '$EXTMAX', '10', num(ext.maxX), '20', num(ext.maxY), '30', '0.0',
      '0', 'ENDSEC');
    out.push(...body);
    return out.join('\n') + '\n';
  }
}
