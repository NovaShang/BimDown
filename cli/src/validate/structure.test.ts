import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateStructure, PROJECT_METADATA_FIELDS } from './structure.js';

const testDir = join(__dirname, 'test-structure');

function writeMeta(meta: unknown) {
  writeFileSync(join(testDir, 'project_metadata.json'), JSON.stringify(meta));
}

describe('validateStructure — project_metadata.json', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'global'), { recursive: true });
    writeFileSync(join(testDir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,,L1,0\n');
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('accepts spatial_z: "absolute" (written by the web app and `init`)', () => {
    writeMeta({ format_version: '3.0', units: 'm', spatial_z: 'absolute' });
    expect(validateStructure(testDir)).toEqual([]);
  });

  it('rejects other spatial_z values', () => {
    writeMeta({ format_version: '3.0', spatial_z: 'relative' });
    expect(validateStructure(testDir)).toEqual([
      'project_metadata.json  invalid "spatial_z": "relative" — must be "absolute"',
    ]);
  });

  it('still reports unknown fields', () => {
    writeMeta({ format_version: '3.0', foo: 1 });
    expect(validateStructure(testDir)).toEqual(['project_metadata.json  unknown field "foo"']);
  });

  it('allows licence / attribution notes in the project root, nothing else', () => {
    writeMeta({ format_version: '3.0' });
    for (const f of ['LICENSE.txt', 'README.md', 'NOTICE', 'notes.txt']) writeFileSync(join(testDir, f), 'x');
    expect(validateStructure(testDir)).toEqual([
      'notes.txt  unexpected entry in project root — only global/, lv-{n}/, mesh/, underlays/, _IdMap.csv, project_metadata.json and LICENSE/README notes are allowed',
    ]);
  });

  it('knows exactly the fields declared in spec/project_metadata.schema.yaml', () => {
    const schema = parse(readFileSync(join(__dirname, '../../../spec/project_metadata.schema.yaml'), 'utf-8'));
    const declared = (schema.fields as { name: string }[]).map((f) => f.name).sort();
    expect([...PROJECT_METADATA_FIELDS].sort()).toEqual(declared);
  });
});
