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

describe('validateStructure — level folders vs global/level.csv', () => {
  const dir = join(__dirname, 'test-structure-levels');
  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    mkdirSync(join(dir, 'lv-1'), { recursive: true });
    mkdirSync(join(dir, 'lv-2'), { recursive: true });
    writeFileSync(join(dir, 'project_metadata.json'), JSON.stringify({ format_version: '3.0', units: 'm' }));
  });
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  it('errors on a header-only level.csv when level folders exist', () => {
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\n');
    expect(validateStructure(dir)).toEqual([
      'global/level.csv  has no levels but the project has level folders (lv-1, lv-2) — add one row per folder',
    ]);
  });

  it('errors on a level folder without a row', () => {
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\n');
    expect(validateStructure(dir)).toEqual(['lv-2/  level folder has no row in global/level.csv (id lv-2)']);
  });

  it('accepts declared folders and declared levels without a folder', () => {
    writeFileSync(join(dir, 'global', 'level.csv'), 'id,number,name,elevation\nlv-1,1,L1,0\nlv-2,2,L2,3\nlv-R,R,Roof,6\n');
    expect(validateStructure(dir)).toEqual([]);
  });
});
