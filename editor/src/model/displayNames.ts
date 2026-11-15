/**
 * Display names of built-in data in the UI language. The data keeps its
 * (English) names, so files and the AI see the same project in any language:
 * only the label changes. A renamed level or type shows its own name.
 */
import { starterTypes } from './types/starter.ts';

type T = (key: string, options?: Record<string, unknown>) => string;

let starterNames: Map<string, string> | null = null;

/** A type's name; starter types not renamed by the user in the UI language. */
export function typeLabel(t: T, type: { id: string; name: string }): string {
  starterNames ??= new Map(starterTypes().map(s => [s.id, s.name]));
  return starterNames.get(type.id) === type.name ? t(`starterType.${type.id}`, { defaultValue: type.name }) : type.name;
}

/** A level's name; the default names (Level 3, Ground Floor, Roof) in the UI language. */
export function levelLabel(t: T, level: { id: string; name?: string; number?: string }): string {
  const name = level.name || level.number || level.id;
  const m = /^Level (\d+)$/.exec(name);
  if (m) return t('levelName.level', { n: m[1], defaultValue: name });
  if (name === 'Ground Floor') return t('levelName.ground', { defaultValue: name });
  if (name === 'Roof') return t('levelName.roof', { defaultValue: name });
  return name;
}
