/**
 * MEP system library: the common system codes with a name (en / zh), the
 * spec discipline (mep_system.discipline) and a distinct plan colour that
 * follows the usual drafting conventions (supply air blue, return air
 * magenta, outside air green, exhaust olive, chilled water blues, heating
 * water orange / red, condenser water teal, cold water green, hot water
 * pink-red, sanitary brown, vent grey, storm navy, fire red, power orange,
 * lighting yellow, data violet, condensate plum). Every colour is unique and visibly
 * different from the others (CIE76 ΔE > 15, see systemPresets.test.ts).
 *
 * `aliases` are other codes the editor emits for the same system (the
 * equipment starters tag DHW ports "DHWS" and vent ports "V"): they resolve
 * to the preset's colour and name.
 */
import type { SystemDef } from '../types.ts';

export type MepDiscipline = 'hvac' | 'plumbing' | 'fire' | 'electrical' | 'data';

/** The spec's mep_system.discipline values (label = i18n key). */
export const DISCIPLINE_OPTIONS: { value: MepDiscipline | 'other'; label: string }[] = [
  { value: 'hvac', label: 'dialog.mepDiscipline.hvac' },
  { value: 'plumbing', label: 'dialog.mepDiscipline.plumbing' },
  { value: 'fire', label: 'dialog.mepDiscipline.fire' },
  { value: 'electrical', label: 'dialog.mepDiscipline.electrical' },
  { value: 'data', label: 'dialog.mepDiscipline.data' },
  { value: 'other', label: 'dialog.mepDiscipline.other' },
];

export interface MepSystemPreset {
  code: string;
  en: string;
  zh: string;
  discipline: MepDiscipline;
  color: string;
  aliases?: string[];
}

export const MEP_SYSTEM_PRESETS: MepSystemPreset[] = [
  // HVAC air
  { code: 'SA', en: 'Supply Air', zh: '送风', discipline: 'hvac', color: '#2f7df6' },
  { code: 'RA', en: 'Return Air', zh: '回风', discipline: 'hvac', color: '#b5179e' },
  { code: 'OA', en: 'Outside Air', zh: '新风', discipline: 'hvac', color: '#7cb518' },
  { code: 'EA', en: 'Exhaust Air', zh: '排风', discipline: 'hvac', color: '#6a6f1a' },
  // HVAC water
  { code: 'CHWS', en: 'Chilled Water Supply', zh: '冷冻水供水', discipline: 'hvac', color: '#00a6d6' },
  { code: 'CHWR', en: 'Chilled Water Return', zh: '冷冻水回水', discipline: 'hvac', color: '#0353a4' },
  { code: 'HWS', en: 'Heating Water Supply', zh: '采暖热水供水', discipline: 'hvac', color: '#f08a4b' },
  { code: 'HWR', en: 'Heating Water Return', zh: '采暖热水回水', discipline: 'hvac', color: '#9b2226' },
  { code: 'CWS', en: 'Condenser Water Supply', zh: '冷却水供水', discipline: 'hvac', color: '#0f9d8a' },
  { code: 'CWR', en: 'Condenser Water Return', zh: '冷却水回水', discipline: 'hvac', color: '#64c4b4' },
  { code: 'CD', en: 'Condensate Drain', zh: '冷凝水', discipline: 'hvac', color: '#5f0f40' },
  // Plumbing
  { code: 'DCW', en: 'Domestic Cold Water', zh: '生活给水', discipline: 'plumbing', color: '#2b9348' },
  { code: 'DHW', en: 'Domestic Hot Water', zh: '生活热水', discipline: 'plumbing', color: '#ef476f', aliases: ['DHWS'] },
  { code: 'DHWR', en: 'Domestic Hot Water Return', zh: '生活热水回水', discipline: 'plumbing', color: '#ff99ac' },
  { code: 'SAN', en: 'Sanitary', zh: '污水', discipline: 'plumbing', color: '#7f4f24' },
  { code: 'VENT', en: 'Vent', zh: '通气', discipline: 'plumbing', color: '#8d99ae', aliases: ['V'] },
  { code: 'STORM', en: 'Storm Drain', zh: '雨水', discipline: 'plumbing', color: '#283655' },
  { code: 'G', en: 'Gas', zh: '燃气', discipline: 'plumbing', color: '#a68a64', aliases: ['GAS'] },
  // Fire
  { code: 'FP', en: 'Fire Protection', zh: '消防喷淋', discipline: 'fire', color: '#e00000' },
  // Electrical / data
  { code: 'PWR', en: 'Power', zh: '电力', discipline: 'electrical', color: '#ff9e00' },
  { code: 'LTG', en: 'Lighting', zh: '照明', discipline: 'electrical', color: '#f2d000' },
  { code: 'DATA', en: 'Data', zh: '弱电', discipline: 'data', color: '#7b2cbf' },
];

const BY_CODE = new Map<string, MepSystemPreset>();
for (const p of MEP_SYSTEM_PRESETS) {
  BY_CODE.set(p.code, p);
  for (const a of p.aliases ?? []) BY_CODE.set(a, p);
}

/** The preset for a system code or one of its aliases (case-insensitive). */
export function systemPreset(code: string): MepSystemPreset | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}

/** Extra colours for codes outside the library, after the unused preset colours. */
const EXTRA_COLORS = ['#3d348b', '#43aa8b', '#e07a5f', '#577590', '#bc6c25', '#c77dff', '#4d908e', '#ff70a6'];

/**
 * Default colour for a new system `code`: the preset's colour, else the first
 * library / extra colour no existing system uses yet.
 */
export function defaultSystemColor(code: string, existing: readonly SystemDef[]): string {
  const preset = systemPreset(code);
  if (preset) return preset.color;
  // An uncoloured system shows its preset colour: that one is taken too
  const used = new Set(existing.map(s => (s.color.trim() || systemPreset(s.system_type)?.color || '').toLowerCase()));
  const free = [...MEP_SYSTEM_PRESETS.map(p => p.color), ...EXTRA_COLORS].find(c => !used.has(c));
  return free ?? EXTRA_COLORS[existing.length % EXTRA_COLORS.length];
}

/**
 * New mep_system rows for the picked presets, skipping codes (or aliases)
 * the project already has. When the model already tags elements with an
 * alias (DHWS from a placed lavatory), the row uses that code so the
 * elements join the system. Ids continue the `sys-N` sequence.
 */
export function presetSystemRows(
  picked: readonly string[], existing: readonly SystemDef[], usedCodes: ReadonlySet<string>, lang: 'en' | 'zh',
): SystemDef[] {
  const have = new Set(existing.map(s => s.system_type.trim().toUpperCase()));
  const ids = new Set(existing.map(s => s.id));
  const out: SystemDef[] = [];
  let n = 1;
  for (const code of picked) {
    const p = systemPreset(code);
    if (!p) continue;
    const codes = [p.code, ...(p.aliases ?? [])];
    if (codes.some(c => have.has(c))) continue;
    const inModel = codes.find(c => usedCodes.has(c));
    while (ids.has(`sys-${n}`)) n++;
    const id = `sys-${n}`;
    ids.add(id);
    const systemType = inModel ?? p.code;
    have.add(systemType);
    out.push({ id, system_type: systemType, name: lang === 'zh' ? p.zh : p.en, color: p.color, discipline: p.discipline });
  }
  return out;
}

/** System codes used by elements (comma lists split), upper-cased. */
export function usedSystemCodes(elements: Iterable<{ attrs: Record<string, string> }>): Set<string> {
  const out = new Set<string>();
  for (const el of elements) {
    for (const c of (el.attrs.system_type ?? '').split(',')) {
      const t = c.trim().toUpperCase();
      if (t) out.add(t);
    }
  }
  return out;
}
