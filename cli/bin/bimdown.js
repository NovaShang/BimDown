#!/usr/bin/env node
// `bimdown` entry. The published package runs dist/cli.js directly; in a source
// checkout (npx bimdown-cli inside a clone of the repo) dist/ may not be built
// yet, so build it once first.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  console.error('bimdown: building the CLI from source (first run in this checkout)...');
  try {
    execSync('npm run build', { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    console.error('bimdown: build failed. Run `npm install` at the repository root, then retry (or use `npx bimdown-cli@latest`).');
    process.exit(1);
  }
}
await import(entry.href);
