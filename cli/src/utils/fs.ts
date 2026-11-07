import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Top-level asset directories: mesh/ (GLB, mesh.mesh_file) and underlays/ (underlay.file). */
export const ASSET_DIRS = new Set(['mesh', 'underlays']);

export interface ProjectLayout {
  root: string;
  globalDir: string;
  levelDirs: { name: string; path: string }[];
}

export function discoverLayout(dir: string): ProjectLayout {
  const globalDir = join(dir, 'global');
  const levelDirs: { name: string; path: string }[] = [];

  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const entry of readdirSync(dir)) {
      // 'mesh' (GLB assets) and 'underlays' (tracing references) are asset
      // directories, not levels.
      if (entry === 'global' || ASSET_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        levelDirs.push({ name: entry, path: full });
      }
    }
  }

  return { root: dir, globalDir, levelDirs };
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => {
    const full = join(dir, f);
    return statSync(full).isFile();
  });
}
