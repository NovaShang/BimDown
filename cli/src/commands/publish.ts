import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { zipSync } from 'fflate';
import { discoverLayout, listFiles } from '../utils/fs.js';

// bim-claw.com (CLI <= 0.4) still serves /api/shares/publish
const DEFAULT_API = 'https://bimdown.com';
const DEFAULT_EXPIRES = '7d';

export async function publish(dir: string, opts: { expires?: string; api?: string; name?: string }) {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    console.error(`Directory not found: ${absDir}`);
    process.exitCode = 1;
    return;
  }

  const apiBase = (opts.api || process.env.BIMDOWN_API || process.env.BIMCLAW_API || DEFAULT_API).replace(/\/$/, '');
  const expires = opts.expires || DEFAULT_EXPIRES;

  // Collect all project files
  const layout = discoverLayout(absDir);
  const allDirs = [
    { prefix: 'global', path: layout.globalDir },
    ...layout.levelDirs.map(d => ({ prefix: d.name, path: d.path })),
  ];

  const files: Record<string, Uint8Array> = {};

  for (const d of allDirs) {
    if (!existsSync(d.path)) continue;
    for (const f of listFiles(d.path)) {
      const filePath = `${d.prefix}/${f}`;
      const content = readFileSync(resolve(d.path, f));
      files[filePath] = new Uint8Array(content);
    }
  }

  // Include project_metadata.json if it exists
  const metadataPath = resolve(absDir, 'project_metadata.json');
  if (existsSync(metadataPath)) {
    files['project_metadata.json'] = new Uint8Array(readFileSync(metadataPath));
  }

  const fileCount = Object.keys(files).length;
  if (fileCount === 0) {
    console.error('No files found in project directory.');
    process.exitCode = 1;
    return;
  }

  // Create zip
  const zipData = zipSync(files);
  const sizeMB = (zipData.byteLength / 1024 / 1024).toFixed(1);
  console.log(`Packed ${fileCount} files (${sizeMB} MB)`);

  // Derive project name from directory
  const projectName = opts.name || absDir.split('/').pop() || 'Untitled';

  // Upload
  const url = `${apiBase}/api/shares/publish`;
  const formData = new FormData();
  formData.append('file', new Blob([zipData], { type: 'application/zip' }), `${projectName}.zip`);
  formData.append('name', projectName);
  formData.append('expires', expires);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`Publish failed (${resp.status}): ${body}`);
      process.exitCode = 1;
      return;
    }

    const result = await resp.json() as { url: string; token: string; expiresAt: string | null };
    console.log(`\n✅ Published: ${result.url}`);
    if (result.expiresAt) {
      console.log(`   Expires: ${new Date(result.expiresAt).toLocaleString()}`);
    }
  } catch (err: any) {
    console.error(`Publish failed: ${err.message}`);
    process.exitCode = 1;
  }
}
