import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
      // 'mesh' is the GLB asset directory (mesh.mesh_file paths), not a level.
      if (entry === 'global' || entry === 'mesh' || entry.startsWith('.')) continue;
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
