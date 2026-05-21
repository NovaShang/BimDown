import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RawSchema, RawField, ResolvedField } from './types.js';

export function loadAllSchemas(specDir: string): Map<string, RawSchema> {
  const schemas = new Map<string, RawSchema>();
  walkYaml(specDir, schemas);
  return schemas;
}

function walkYaml(dir: string, schemas: Map<string, RawSchema>) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkYaml(full, schemas);
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      const raw = parseYaml(readFileSync(full, 'utf-8')) as RawSchema;
      if (raw?.name) schemas.set(raw.name, raw);
    }
  }
}

export function resolveFields(
  name: string,
  schemas: Map<string, RawSchema>,
  resolved: Map<string, ResolvedField[]> = new Map(),
): ResolvedField[] {
  if (resolved.has(name)) return resolved.get(name)!;

  const schema = schemas.get(name);
  if (!schema) throw new Error(`Unknown schema: ${name}`);

  const fields: ResolvedField[] = [];
  const seen = new Set<string>();

  // Resolve bases first (depth-first)
  for (const baseName of schema.bases ?? []) {
    for (const f of resolveFields(baseName, schemas, resolved)) {
      if (!seen.has(f.name)) {
        seen.add(f.name);
        fields.push(f);
      }
    }
  }

  // Add own fields (may override base fields)
  for (const raw of schema.fields ?? []) {
    const rf = normalizeField(raw);
    const idx = fields.findIndex((f) => f.name === rf.name);
    if (idx >= 0) {
      fields[idx] = rf;
    } else {
      fields.push(rf);
    }
  }

  resolved.set(name, fields);
  return fields;
}

function normalizeField(raw: RawField): ResolvedField {
  return {
    name: raw.name,
    type: raw.type,
    required: raw.required ?? false,
    computed: raw.computed ?? false,
    storage: raw.storage ?? 'csv',
    reference: raw.reference,
    values: raw.values,
    description: raw.description,
    default: raw.default,
  };
}
