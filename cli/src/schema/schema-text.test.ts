import { describe, it, expect } from 'vitest';
import { buildRegistry, getSpecDir } from './registry.js';
import { schemaIndexLines, schemaTableLines } from './schema-text.js';

describe('schema text', () => {
  const registry = buildRegistry(getSpecDir());

  it('index lists every table on its own line in under 3k chars', () => {
    const lines = schemaIndexLines(registry);
    const text = lines.join('\n');
    expect(text.length).toBeLessThan(3000);
    expect(text).toContain('schema <table>');
    // every table has a curated line (none fall into "Other")
    expect(text).not.toMatch(/^Other:/m);
    for (const t of registry.keys()) expect(lines.some((l) => l.startsWith(`  ${t}: `))).toBe(true);
  });

  it('a table prints its full columns', () => {
    const text = schemaTableLines(registry.get('wall')!).join('\n');
    expect(text).toContain('── wall (prefix: w) ──');
    expect(text).toMatch(/thickness: float/);
    expect(text).toContain('type_id → wall_type');
  });
});
