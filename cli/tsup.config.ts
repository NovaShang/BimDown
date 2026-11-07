import { defineConfig } from 'tsup';
import pkg from './package.json' assert { type: 'json' };

// Shared settings for both the CLI and library entries.
// `clean` is intentionally NOT set here — cleaning is done once up-front by
// the package.json `build` script (`rm -rf dist && tsup`), so neither entry
// wipes the other's output.
const base = {
  format: ['esm'] as const,
  target: 'node20' as const,
  platform: 'node' as const,
  splitting: false,
  sourcemap: true,
  clean: false,
};

export default defineConfig([
  // CLI executable — single bundled entry with shebang. Also copies the spec
  // directory alongside the bundle so the installed `bimdown` binary can find
  // YAML schemas at runtime (see getSpecDir() in cli/src/schema/registry.ts).
  {
    ...base,
    entry: { cli: 'src/index.ts' },
    // Commands loaded with import() (import-ifc and its web-ifc) become their
    // own chunks, so the other commands don't load them.
    splitting: true,
    banner: { js: '#!/usr/bin/env node' },
    define: {
      CLI_VERSION: JSON.stringify(pkg.version),
    },
    dts: false,
    onSuccess: 'cp -R ../spec dist/spec',
  },
  // Library entry — `import { ... } from 'bimdown-cli'`. Emits .d.ts for
  // consumers and no shebang.
  {
    ...base,
    entry: { lib: 'src/lib.ts' },
    dts: true,
  },
]);
