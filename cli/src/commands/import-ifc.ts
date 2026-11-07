/**
 * `bimdown import-ifc <file.ifc> <outdir>`: convert an IFC model (web-ifc in
 * Node) into a BimDown project, then run `build` on it and report counts,
 * skipped categories, wall joins and room problems.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as W from 'web-ifc';
import { importIfc, formatReport, IfcImportError, type ImportReport } from '../ifc-import/index.js';
import { ID_PREFIXES } from '../schema/registry.js';
import { build, type BuildResult } from '../build/index.js';

export interface ImportIfcCommandOptions {
  force?: boolean;
  json?: string;
  quiet?: boolean;
}

export interface ImportIfcCommandResult {
  report: ImportReport;
  build: BuildResult;
  files: string[];
}

export async function runImportIfc(file: string, outDir: string, opts: ImportIfcCommandOptions = {}): Promise<ImportIfcCommandResult> {
  const src = resolve(file);
  const dir = resolve(outDir);
  if (!existsSync(src)) throw new Error(`${file}: no such file`);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !opts.force) {
    throw new Error(`${outDir} is not empty (use --force to write into it)`);
  }
  const api = new W.IfcAPI();
  await api.Init();
  api.SetLogLevel(W.LogLevel.LOG_LEVEL_OFF);
  const tty = !opts.quiet && process.stderr.isTTY;
  let last = '';
  const result = importIfc(api, new Uint8Array(readFileSync(src)), {
    fileName: basename(src),
    tables: Object.keys(ID_PREFIXES),
    onProgress: ({ phase, fraction }) => {
      if (!tty) return;
      const line = `${phase.padEnd(8)} ${Math.round(fraction * 100)}%`;
      if (line !== last) process.stderr.write(`\r${line}   `);
      last = line;
    },
  });
  if (tty) process.stderr.write('\r' + ' '.repeat(20) + '\r');
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(result.files)) {
    const p = join(dir, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf-8');
  }
  const built = build(dir);
  if (opts.json) writeFileSync(resolve(opts.json), JSON.stringify({ ...result.report, build: summary(built) }, null, 2) + '\n');
  return { report: result.report, build: built, files: Object.keys(result.files) };
}

function summary(b: BuildResult) {
  return { issues: b.issues, warnings: b.warnings.length, roomIssues: b.roomIssues, snappedEndpoints: b.snappedEndpoints };
}

export function printImportResult(r: ImportIfcCommandResult, outDir: string): void {
  console.log(formatReport(r.report));
  console.log('');
  console.log(`Wrote ${r.files.length} files to ${outDir}`);
  const b = r.build;
  console.log(`bimdown build: ${b.issues.length} issue(s), ${b.warnings.length} warning(s), ${b.roomIssues.length} room problem(s)`);
  for (const issue of b.issues.slice(0, 20)) console.log(`  ${issue}`);
  if (b.issues.length > 20) console.log(`  ... ${b.issues.length - 20} more`);
}

export { IfcImportError };
