import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initProject } from './init.js';

const testDir = join(__dirname, 'test-init-dir');

describe('initProject', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('creates the required basic folder structure', () => {
    initProject(testDir);
    expect(existsSync(join(testDir, '.bimdown'))).toBe(true);
    expect(existsSync(join(testDir, 'global'))).toBe(true);
    
    // Check level.csv
    const levelContent = readFileSync(join(testDir, 'global', 'level.csv'), 'utf-8');
    expect(levelContent).toContain('lv-1');
    expect(levelContent).toContain('Level 1');

    // Check grid.csv
    const gridContent = readFileSync(join(testDir, 'global', 'grid.csv'), 'utf-8');
    expect(gridContent).toContain('gr-1');
    expect(gridContent).toContain('gr-2');

    // Marks spatial Z as absolute (spec §4.2) so the project is unambiguous
    const meta = JSON.parse(readFileSync(join(testDir, 'project_metadata.json'), 'utf-8'));
    expect(meta.spatial_z).toBe('absolute');
  });
});
