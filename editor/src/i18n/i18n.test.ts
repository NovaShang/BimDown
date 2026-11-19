import { describe, it, expect } from 'vitest';
import '../elements/registerAll.ts';
import { allElementModules } from '../elements/registry.ts';
import { DISCIPLINES } from '../model/tableRegistry.ts';
import en from './en.json';
import zh from './zh.json';

const locales = { en, zh } as Record<string, Record<string, string>>;

/** Keys missing from either locale. */
function missing(keys: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    for (const [lang, dict] of Object.entries(locales)) {
      if (!dict[key]) out.add(`${lang}: ${key}`);
    }
  }
  return [...out].sort();
}

/**
 * Static keys in the editor source: passed to t('…'), or string literals in a
 * known key namespace (labelKey / hintKey tables that are translated later).
 */
function staticKeysInSource(): string[] {
  const sources = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts'], {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;
  const namespaces = new Set(Object.keys(en).map(k => k.split('.')[0]));
  const keys = new Set<string>();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/\bt\(\s*(['"`])([\w.-]+)\1/g)) keys.add(m[2]);
    for (const m of src.matchAll(/(['"`])([a-z]+\.[\w.-]+)\1/g)) {
      if (namespaces.has(m[2].split('.')[0])) keys.add(m[2]);
    }
  }
  return [...keys];
}

describe('editor i18n', () => {
  it('en and zh have the same keys', () => {
    expect(Object.keys(zh).filter(k => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter(k => !(k in zh))).toEqual([]);
  });

  it('translates every static key used in the UI', () => {
    expect(missing(staticKeysInSource())).toEqual([]);
  });

  it('translates every layer / category name (display.*)', () => {
    expect(missing(allElementModules().map(m => `display.${m.layerStyle.displayName}`))).toEqual([]);
  });

  it('translates every discipline', () => {
    expect(missing(['all', ...DISCIPLINES].map(d => `discipline.${d}`))).toEqual([]);
  });

  it('translates every property field label and option (field.* / option.*)', () => {
    const keys: string[] = [];
    for (const m of allElementModules()) {
      for (const f of [...m.propertyFields, ...m.drawingFields]) {
        keys.push(`field.${f.label}`);
        // system_type options are the project's own system codes, shown as-is
        if (f.key === 'system_type') continue;
        for (const o of f.options ?? []) keys.push(`option.${o.label}`);
      }
    }
    expect(missing(keys)).toEqual([]);
  });
});
