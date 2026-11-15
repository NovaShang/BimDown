/**
 * MEP systems: which system each duct / pipe / fitting / device belongs to
 * (IfcSystem / IfcDistributionSystem membership, else the Revit "System Name"
 * / "System Classification" / "System Type" / "System Abbreviation" property
 * values, English or German), a short `system_type` tag per system (SA, RA,
 * HWS …, numbered when a classification has several systems: SA-1, SA-2) and
 * one global/mep_system.csv row each with name, discipline and colour.
 *
 * The classification table is data: add a row to map a new vocabulary.
 */
import type { ImportContext, OutEl } from './context.js';
import { enumValue, str } from './model.js';

export interface SystemClass {
  /** Matched against classification / type / name text (and IFC4 IfcDistributionSystemEnum). */
  re: RegExp;
  tag: string;
  discipline: 'hvac' | 'plumbing' | 'fire' | 'electrical' | 'data' | 'other';
  color: string;
}

// Order matters: the first match wins ("Hydronic Return" before "Return Air").
export const SYSTEM_CLASSES: SystemClass[] = [
  { re: /chilled.*(return|rück|ruck)|kaltwasser.*rück|CHILLEDWATER.*RETURN|冷冻水回|冷水回/i, tag: 'CHWR', discipline: 'hvac', color: '#0891b2' },
  { re: /chilled|kühlwasser|kaltwasser.*vorlauf|CHILLEDWATER|冷冻水|冷水供/i, tag: 'CHWS', discipline: 'hvac', color: '#06b6d4' },
  { re: /condenser.*(return|rück)|kondensator.*rück|冷却水回/i, tag: 'CWR', discipline: 'hvac', color: '#059669' },
  { re: /condenser|CONDENSERWATER|冷却水/i, tag: 'CWS', discipline: 'hvac', color: '#10b981' },
  { re: /hydronic.*return|heating.*return|hot water return|heizung.*rück|heizungsrücklauf|rücklauf|HWR\b|热水回|采暖回/i, tag: 'HWR', discipline: 'hvac', color: '#ea580c' },
  { re: /hydronic|heating|hot water supply|heizung|vorlauf|HWS\b|HEATING|热水供|采暖/i, tag: 'HWS', discipline: 'hvac', color: '#f97316' },
  { re: /condensate|kondensat|冷凝/i, tag: 'CD', discipline: 'plumbing', color: '#14b8a6' },
  { re: /supply.?air|zuluft|SUPPLYAIR|air.?supply|送风/i, tag: 'SA', discipline: 'hvac', color: '#3b82f6' },
  { re: /return.?air|abluft|umluft|rückluft|ruckluft|RETURNAIR|回风/i, tag: 'RA', discipline: 'hvac', color: '#60a5fa' },
  { re: /exhaust|fortluft|EXHAUSTAIR|排风|排烟/i, tag: 'EA', discipline: 'hvac', color: '#a855f7' },
  { re: /outdoor|outside.?air|fresh.?air|au(ß|ss)enluft|新风/i, tag: 'OA', discipline: 'hvac', color: '#22d3ee' },
  { re: /domestic.?hot|hot.?water|warmwasser|trinkwasser.?warm|DOMESTICHOTWATER|生活热水|热水/i, tag: 'DHW', discipline: 'plumbing', color: '#dc2626' },
  { re: /domestic.?cold|cold.?water|kaltwasser|trinkwasser|DOMESTICCOLDWATER|WATERSUPPLY|给水|生活冷水|冷水/i, tag: 'DCW', discipline: 'plumbing', color: '#1d4ed8' },
  { re: /storm|rain|regenwasser|STORMWATER|RAINWATER|雨水/i, tag: 'SD', discipline: 'plumbing', color: '#0369a1' },
  { re: /sanitary|sewage|waste|soil|schmutzwasser|abwasser|SEWAGE|WASTEWATER|DRAINAGE|DISPOSAL|排水|污水|废水/i, tag: 'SAN', discipline: 'plumbing', color: '#92400e' },
  { re: /\bvent\b|entlüftung|lüftungsleitung|^VENT$|通气/i, tag: 'V', discipline: 'plumbing', color: '#a16207' },
  { re: /\bgas\b|erdgas|FUEL|燃气/i, tag: 'G', discipline: 'plumbing', color: '#facc15' },
  { re: /fire|sprinkler|wet|dry|pre.?action|deluge|lösch|FIREPROTECTION|消防|喷淋/i, tag: 'FP', discipline: 'fire', color: '#ef4444' },
  { re: /ventilation|lüftung|air|luft|VENTILATION|AIRCONDITIONING|通风|空调/i, tag: 'AIR', discipline: 'hvac', color: '#38bdf8' },
  { re: /lighting|beleuchtung|LIGHTING|照明/i, tag: 'LTG', discipline: 'electrical', color: '#f59e0b' },
  { re: /data|communication|telephone|netzwerk|DATA|COMMUNICATION|TELEPHONE|弱电|通信/i, tag: 'DATA', discipline: 'data', color: '#22c55e' },
  { re: /power|electrical|strom|ELECTRICAL|POWERGENERATION|电力|配电/i, tag: 'PWR', discipline: 'electrical', color: '#eab308' },
];

const CONTAINER_CLASSES = new Set(['IfcSystem', 'IfcDistributionSystem', 'IfcDistributionCircuit', 'IfcBuildingSystem']);

/** Property names (any set) carrying Revit system data, English / German. */
const P_NAME = ['System Name', 'Systemname', 'SystemName'];
const P_CLASS = ['System Classification', 'Systemklassifizierung', 'SystemClassification'];
const P_TYPE = ['System Type', 'Systemtyp', 'SystemType'];
const P_ABBR = ['System Abbreviation', 'Systemabkürzung', 'SystemAbbreviation'];

interface SystemInfo {
  key: string;
  name: string;
  /** Text the classification is read from. */
  classText: string;
  /** Tag the source already uses (our own exports, a usable abbreviation). */
  tagHint?: string;
}

const isJunk = (s: string | null | undefined) => !s || /^(undefined|none|other|nicht definiert|-|\s*)$/i.test(s.trim());

/** Comma lists ("Supply Air 1,Return Air 1") → parts. */
function parts(v: string | null): string[] {
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(s => !isJunk(s));
}

function sanitizeTag(s: string): string | undefined {
  const t = s.trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '');
  return t && t.length <= 12 ? t : undefined;
}

export function classifySystem(text: string): SystemClass | null {
  for (const c of SYSTEM_CLASSES) if (c.re.test(text)) return c;
  return null;
}

/** Collects system membership while converting, then assigns tags and writes the mep_system rows. */
export class Systems {
  private infos = new Map<string, SystemInfo>();
  private members = new Map<OutEl, string[]>();
  private tags = new Map<string, string>();
  constructor(private ctx: ImportContext) {}

  /** Record the systems of an IFC product converted into `el` (tags are filled in by `finish`). */
  note(el: OutEl, id: number): void {
    const keys = this.read(id);
    if (keys.length) this.members.set(el, keys);
  }

  /** Same systems as another element (pieces of a split run, connector runs). */
  copy(from: OutEl, to: OutEl): void {
    const k = this.members.get(from);
    if (k) this.members.set(to, k.slice());
  }

  private read(id: number): string[] {
    const { model } = this.ctx;
    const out: string[] = [];
    const add = (info: SystemInfo) => {
      if (!this.infos.has(info.key)) this.infos.set(info.key, info);
      if (!out.includes(info.key)) out.push(info.key);
    };
    // Our own exports: the BimDown set holds the tag.
    const own = model.prop(id, /^BimDown$/, 'System_type');
    if (typeof own === 'string' && own.trim()) {
      for (const t of parts(own)) add({ key: `tag:${t}`, name: t, classText: t, tagHint: t });
      return out;
    }
    // IfcSystem / IfcDistributionSystem membership
    for (const g of model.groups.get(id) ?? []) {
      const cls = model.className(g);
      if (!CONTAINER_CLASSES.has(cls) || cls === 'IfcDistributionCircuit') continue;
      const line = model.line(g);
      const objectType = str(line?.ObjectType);
      if (objectType === 'circuit') continue;
      const name = (str(line?.Name) ?? str(line?.LongName) ?? '').slice(0, 80);
      if (!name) continue;
      const pt = enumValue(line?.PredefinedType) ?? '';
      const abbr = firstProp(this.ctx, id, P_ABBR);
      const revitClass = firstProp(this.ctx, id, P_CLASS);
      add({
        key: `sys:${name}`, name,
        classText: [pt === 'NOTDEFINED' || pt === 'USERDEFINED' ? '' : pt, revitClass ?? '', str(line?.LongName) ?? '', objectType ?? '', name].join(' '),
        tagHint: abbr && !abbr.includes(',') ? sanitizeTag(abbr) : undefined,
      });
    }
    if (out.length) return out;
    // Revit property sets
    const names = parts(firstProp(this.ctx, id, P_NAME));
    const classes = parts(firstProp(this.ctx, id, P_CLASS));
    const types = parts(firstProp(this.ctx, id, P_TYPE)).map(t => t.replace(/^[^:]*:\s*/, ''));
    const abbrs = parts(firstProp(this.ctx, id, P_ABBR));
    if (names.length) {
      names.forEach((name, i) => {
        // Lists line up when they have as many entries; else each name classifies itself
        const cls = classes.length === names.length ? classes[i] : '';
        const typ = types.length === names.length ? types[i] : '';
        const abbr = abbrs.length === names.length ? abbrs[i] : undefined;
        add({ key: `sys:${name}`, name: name.slice(0, 80), classText: `${cls} ${typ} ${name}`, tagHint: abbr ? sanitizeTag(abbr) : undefined });
      });
      return out;
    }
    // No system name: one system per classification / type
    const by = classes.length ? classes : types;
    for (const c of by) add({ key: `class:${c}`, name: c, classText: c });
    return out;
  }

  /** Systems of `el` as recorded (keys), for compatibility checks before tags exist. */
  keysOf(el: OutEl): string[] {
    return this.members.get(el) ?? [];
  }

  /** Give `el` the systems of `from` when it has none. */
  inherit(el: OutEl, from: OutEl): boolean {
    if (this.members.has(el)) return false;
    const k = this.members.get(from);
    if (!k || k.length !== 1) return false;
    this.members.set(el, k.slice());
    return true;
  }

  has(el: OutEl): boolean {
    return this.members.has(el);
  }

  /** Assign tags, stamp system_type on every member and add the mep_system rows. */
  finish(): number {
    const used = new Set<string>();
    // Systems with members only, grouped by base tag
    const live = new Set<string>();
    for (const keys of this.members.values()) for (const k of keys) live.add(k);
    const byBase = new Map<string, { info: SystemInfo; cls: SystemClass | null }[]>();
    for (const key of [...live].sort()) {
      const info = this.infos.get(key)!;
      const cls = classifySystem(info.classText);
      const base = info.tagHint ?? cls?.tag ?? sanitizeTag(info.name) ?? 'SYS';
      const list = byBase.get(base) ?? [];
      list.push({ info, cls });
      byBase.set(base, list);
    }
    let rows = 0;
    for (const [base, list] of byBase) {
      // One system: the plain tag; several: numbered by the name's trailing number when unique
      const trailing = list.map(x => /(\d+)\s*$/.exec(x.info.name)?.[1]);
      const unique = trailing.every(t => t) && new Set(trailing).size === list.length;
      list.forEach((x, i) => {
        let tag = list.length === 1 || x.info.key.startsWith('tag:') ? base : `${base}-${unique ? trailing[i] : i + 1}`;
        while (used.has(tag)) tag = `${tag}'`;
        used.add(tag);
        this.tags.set(x.info.key, tag);
        const color = x.cls ? shade(x.cls.color, i) : undefined;
        const row = this.ctx.add('mep_system', 0, 0, {
          system_type: tag, name: x.info.name, discipline: x.cls?.discipline ?? 'other', color,
        }, null);
        row.global = true;
        rows++;
      });
    }
    for (const [el, keys] of this.members) {
      const tags = keys.map(k => this.tags.get(k)).filter((t): t is string => !!t);
      if (!tags.length) continue;
      // Runs and fittings carry one system; devices may serve several
      el.attrs.system_type = el.table === 'equipment' || el.table === 'terminal' ? [...new Set(tags)].join(',') : tags[0];
    }
    return rows;
  }
}

function firstProp(ctx: ImportContext, id: number, keys: string[]): string | null {
  for (const k of keys) {
    const v = ctx.model.prop(id, /./, k);
    if (typeof v === 'string' && !isJunk(v)) return v;
  }
  return null;
}

/** Colour variant `i` of a base colour (alternately darker / lighter), so sibling systems differ. */
function shade(hex: string, i: number): string {
  if (i === 0) return hex;
  const n = parseInt(hex.slice(1), 16);
  const f = (Math.ceil(i / 2) * 0.18) * (i % 2 ? -1 : 1);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  const r = ch(n >> 16), g = ch((n >> 8) & 255), b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
