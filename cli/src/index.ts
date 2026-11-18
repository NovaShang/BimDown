import { Command } from 'commander';
import { resolve } from 'node:path';
import { build, validateOnly } from './build/index.js';
import { buildRegistry, getSpecDir } from './schema/registry.js';
import { schemaIndexLines, schemaTableLines } from './schema/schema-text.js';
import { discoverLayout, listFiles } from './utils/fs.js';
import { readCsv } from './utils/csv.js';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

declare const CLI_VERSION: string;

const program = new Command();

program
  .name('bimdown')
  .description('BimDown CLI — build, query, and manage BimDown projects')
  .version(typeof CLI_VERSION !== 'undefined' ? CLI_VERSION : '0.0.0');

// ─── build ──────────────────────────────────────────────
const WARN_LIST_LIMIT = 20;

function runBuild(dir: string, opts: { verbose?: boolean } = {}, readOnly = false) {
  const absDir = resolve(dir);
  const result = readOnly ? validateOnly(absDir) : build(absDir);

  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      console.log(issue);
    }
    console.log(`\n${result.issues.length} issue(s) found.`);
    process.exitCode = 1;
  }

  if (result.warnings.length > 0) {
    const shown = opts.verbose ? result.warnings : result.warnings.slice(0, WARN_LIST_LIMIT);
    for (const w of shown) {
      console.log(w);
    }
    if (shown.length < result.warnings.length) {
      console.log(`... ${result.warnings.length - shown.length} more (use --verbose to list all)`);
    }
    console.log(`\n${result.warnings.length} warning(s). Warnings are advisory; issues are errors.`);
  }

  if (result.roomIssues.length > 0) {
    const label = { shared: 'share one enclosed area', contains: 'encloses', unbounded: 'has no enclosing boundary' } as const;
    console.log(`\nRoom problems (${result.roomIssues.length}): derived room areas are wrong until fixed`);
    const shown = opts.verbose ? result.roomIssues : result.roomIssues.slice(0, WARN_LIST_LIMIT);
    for (const r of shown) {
      const text = r.kind === 'contains'
        ? `${r.spaceIds.join(', ')} ${label.contains} ${(r.inside ?? []).join(', ')}`
        : `${r.spaceIds.join(', ')} ${label[r.kind]}`;
      console.log(`  ${r.level}: ${text}`);
    }
    if (shown.length < result.roomIssues.length) {
      console.log(`  ... ${result.roomIssues.length - shown.length} more (use --verbose to list all)`);
    }
  }

  if (result.snaps.length > 0) {
    console.log(readOnly
      ? `${result.snaps.length} endpoint(s) closer than 5 cm (build snaps them):`
      : `Snapped ${result.snaps.length} endpoint(s) closer than 5 cm:`);
    const shown = opts.verbose ? result.snaps : result.snaps.slice(0, WARN_LIST_LIMIT);
    for (const s of shown) {
      console.log(`  ${s.level}/${s.table} ${s.elementId} ${s.side} (${s.from.x.toFixed(3)}, ${s.from.y.toFixed(3)}) -> (${s.to.x.toFixed(3)}, ${s.to.y.toFixed(3)})`);
    }
    if (shown.length < result.snaps.length) console.log(`  ... ${result.snaps.length - shown.length} more`);
  }

  if (result.artifacts.length > 0 && !readOnly) {
    console.log(`\nGenerated: ${result.artifacts.join(', ')}`);
  }

  if (result.issues.length === 0 && result.warnings.length === 0) {
    console.log('Build successful. No issues found.');
  }
}

program
  .command('build')
  .argument('<dir>', 'BimDown project directory')
  .option('--verbose', 'List every warning and snapped endpoint')
  .description('Build a BimDown project (validate + compute space boundaries)')
  .action((dir: string, opts: { verbose?: boolean }) => runBuild(dir, opts));

program
  .command('validate')
  .argument('<dir>', 'BimDown project directory')
  .option('--verbose', 'List every warning and snapped endpoint')
  .description('Check a BimDown project like build, without writing anything')
  .action((dir: string, opts: { verbose?: boolean }) => runBuild(dir, opts, true));

// ─── query ──────────────────────────────────────────────
program
  .command('query')
  .argument('<dir>', 'BimDown project directory')
  .argument('<sql>', 'SQL query to execute')
  .option('--json', 'Output results as JSON')
  .description('Hydrate into DuckDB and execute a SQL query')
  .action(async (dir: string, sql: string, opts: { json?: boolean }) => {
    const absDir = resolve(dir);
    const { getConnection, runQuery, closeConnection } = await import('./duckdb/engine.js');
    const { hydrate } = await import('./duckdb/hydrate.js');

    const conn = await getConnection();
    try {
      await hydrate(conn, absDir);
      const result = await runQuery(conn, sql);

      if (opts.json) {
        console.log(JSON.stringify(result.rows, jsonReplacer, 2));
      } else {
        printTable(result.columns, result.rows);
      }
    } finally {
      await closeConnection();
    }
  });

// ─── sync ───────────────────────────────────────────────
program
  .command('sync')
  .argument('<dir>', 'BimDown project directory')
  .description('Hydrate, then dehydrate back (sync DuckDB changes to files)')
  .action(async (dir: string) => {
    const absDir = resolve(dir);
    const { getConnection, closeConnection } = await import('./duckdb/engine.js');
    const { hydrate } = await import('./duckdb/hydrate.js');
    const { dehydrate } = await import('./duckdb/dehydrate.js');

    const conn = await getConnection();
    try {
      const tables = await hydrate(conn, absDir);
      console.log(`Hydrated ${tables.length} tables: ${tables.join(', ')}`);
      await dehydrate(conn, absDir);
      console.log('Sync complete — files updated.');
    } finally {
      await closeConnection();
    }
  });

// ─── render ─────────────────────────────────────────────
program
  .command('render')
  .argument('<dir>', 'BimDown project directory')
  .option('-l, --level <id>', 'Level to render (defaults to lv-1)', 'lv-1')
  .option('-o, --output <file>', 'Output file path (defaults to render.png)', 'render.png')
  .option('-w, --width <px>', 'Image width in pixels', '2048')
  .description('Renders the BimDown project into a visual blueprint (PNG). Color legend: walls=dark navy, structural walls=slate, columns=dark filled, slabs=light grey translucent (sloped floors with their slope arrow, tail dot → head), spaces=blue translucent, stairs=orange runs with treads (dashed beyond the 1.2 m plan cut), landings and an UP walking line (multi-storey stairs also on the storeys they repeat on), railings=slate lines (stair railings follow the derived path), beams/braces=thin purple dashed centerlines (overhead, drawn under walls), columns at their real section size, foundations=brown dashed outlines (pads width×length, piles as circles, strips at their width, rafts/pile caps), grids=red dash-dot axes with numbered bubbles, roofs=brown outline with ridges and hips (valleys dashed) and down-slope arrows labelled with the slope, slab holes and slab openings (white with a cross; shafts also on every level they cross), wall openings=orange lines, curtain walls=light blue strips with a tick per vertical grid line (door panels open, with red swings). DOORS render as BOLD RED (#e63946) lines and WINDOWS as BOLD TEAL (#2a9d8f) lines cutting across their host walls. MEP: runs at their real width in system colours (SA blue, RA light blue, CHWS cyan, SAN brown, FP red, …) with elbow / tee / reducer bodies, system + size tags, rise / drop boxes, slope arrows; terminals, equipment and valves as plan symbols. Furniture and library components draw their grey plan symbols (back edge = local +Y). Annotations (dimension/text_note/tag tables) in dark blue: dimension lines with values in mm (ft-in for imperial), text, boxed door/window tags, room tags with name/number/area.')
  .action(async (dir: string, opts: { level: string; output: string; width: string }) => {
    const absDir = resolve(dir);
    const { renderLevel } = await import('./render.js');
    try {
      const svg = renderLevel(absDir, opts.level);
      if (opts.output.endsWith('.svg')) {
        writeFileSync(opts.output, svg);
      } else {
        const sharp = (await import('sharp')).default;
        const width = parseInt(opts.width, 10) || 2048;
        await sharp(Buffer.from(svg)).resize({ width }).png().toFile(opts.output);
      }
      console.log(`Rendered ${opts.level} to ${opts.output}`);
    } catch (err: any) {
      console.error(`Render failed: ${err.message}`);
      process.exitCode = 1;
    }
  });

// ─── info ───────────────────────────────────────────────
program
  .command('info')
  .argument('<dir>', 'BimDown project directory')
  .description('Print project summary')
  .action((dir: string) => {
    const absDir = resolve(dir);
    const registry = buildRegistry(getSpecDir());
    const layout = discoverLayout(absDir);

    // Levels
    const levelCsv = join(layout.globalDir, 'level.csv');
    if (existsSync(levelCsv)) {
      const levels = readCsv(levelCsv);
      console.log('Levels:');
      for (const row of levels.rows) {
        console.log(`  ${row.id}  ${row.name || row.number || ''}  elevation=${row.elevation}`);
      }
      console.log();
    }

    // Element counts per level
    const allDirs = [
      { name: 'global', path: layout.globalDir },
      ...layout.levelDirs,
    ];

    const totals: Record<string, number> = {};

    for (const d of allDirs) {
      if (!existsSync(d.path)) continue;
      const files = listFiles(d.path);
      const counts: string[] = [];
      for (const f of files) {
        if (!f.endsWith('.csv')) continue;
        const tableName = f.replace('.csv', '');
        if (!registry.has(tableName)) continue;
        const data = readCsv(join(d.path, f));
        counts.push(`${tableName}: ${data.rows.length}`);
        totals[tableName] = (totals[tableName] ?? 0) + data.rows.length;
      }
      if (counts.length > 0) {
        console.log(`${d.name}/  ${counts.join(', ')}`);
      }
    }

    console.log();
    console.log('Totals:');
    let grand = 0;
    for (const [table, count] of Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${table}: ${count}`);
      grand += count;
    }
    console.log(`  TOTAL: ${grand}`);
  });

// ─── resolve-topology ──────────────────────────────────────
program
  .command('resolve-topology')
  .argument('<dir>', 'BimDown project directory')
  .description('Auto-resolve MEP topology: detect coincident endpoints, generate mep_nodes, fill connectivity')
  .action(async (dir: string) => {
    const absDir = resolve(dir);
    const { resolveTopology } = await import('./commands/resolve-topology.js');
    resolveTopology(absDir);
  });

// ─── mep-check ────────────────────────────────────────────
program
  .command('mep-check')
  .argument('<dir>', 'BimDown project directory')
  .option('--json', 'Print the report as JSON')
  .option('--all', 'Also list info-level findings (unused equipment ports, devices without a circuit)')
  .description('MEP connectivity check: systems (curves, length, devices) and problems — open ends, port refs that do not resolve or whose curve end is not on the port, system / domain mismatches, disconnected devices, orphan fittings, overloaded circuits. Exit code 1 when there are warnings.')
  .action(async (dir: string, opts: { json?: boolean; all?: boolean }) => {
    const { mepReport, formatProblem } = await import('./mep/index.js');
    const report = mepReport(resolve(dir));
    const shown = opts.all ? report.problems : report.problems.filter(p => p.severity === 'warning');
    if (opts.json) {
      console.log(JSON.stringify({ systems: report.systems, problems: shown }, null, 2));
    } else {
      console.log('Systems:');
      if (report.systems.length === 0) console.log('  (no MEP curves)');
      for (const s of report.systems) {
        console.log(`  ${s.system.padEnd(8)} ${String(s.curves).padStart(4)} curve(s)  ${s.length.toFixed(1).padStart(7)} long  ${s.devices} device(s)  [${s.tables.join(', ')}]`);
      }
      console.log();
      for (const p of shown) console.log(`${p.severity === 'info' ? 'info  ' : ''}${formatProblem(p)}`);
      const warnings = report.problems.filter(p => p.severity === 'warning').length;
      console.log(warnings === 0 ? 'MEP connectivity: no problems.' : `\n${warnings} connectivity problem(s).`);
    }
    if (report.problems.some(p => p.severity === 'warning')) process.exitCode = 1;
  });

// ─── clash ────────────────────────────────────────────────
/** A length argument in metres: a bare number in `bareM` metres, or with a unit (mm, cm, m). Null when invalid or negative. */
function parseLengthM(s: string, bareM: number): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*(mm|cm|m)?\s*$/i.exec(s);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] ? { mm: 0.001, cm: 0.01, m: 1 }[m[2].toLowerCase() as 'mm' | 'cm' | 'm'] : bareM);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

program
  .command('clash')
  .argument('<dir>', 'BimDown project directory')
  .option('--tolerance <m>', 'Overlaps no deeper than this are within tolerance, not clashes: metres, or with a unit (50mm, 5cm); 0 = every overlap', '0.05')
  .option('--clearance <mm>', 'Also report MEP closer than this to MEP / structure without touching: mm, or with a unit (0 = off)', '0')
  .option('--minor', 'Also list the overlaps within tolerance')
  .option('--level <id>', 'Only MEP on this level (obstacles from every level)')
  .option('--json', 'Print the report as JSON')
  .option('--mep-only', 'Only MEP vs MEP')
  .description('MEP clash detection: ducts / pipes / conduits / cable trays and devices against structure (high), against other MEP they do not connect to (medium), through slabs / roofs / non-structural walls with no opening (low penetration), and closer than --clearance (low). Overlaps up to --tolerance (5 cm) are modelling slack, not clashes. Exit code 0 unless the project cannot be read.')
  .action(async (dir: string, opts: { tolerance: string; clearance: string; minor?: boolean; level?: string; json?: boolean; mepOnly?: boolean }) => {
    const absDir = resolve(dir);
    const tolerance = parseLengthM(opts.tolerance, 1), clearance = parseLengthM(opts.clearance, 0.001);
    if (!existsSync(absDir)) { console.error(`No such directory: ${dir}`); process.exitCode = 1; return; }
    if (tolerance === null || clearance === null) {
      console.error('--tolerance takes a length in metres, --clearance in mm (>= 0; or with a unit: 50mm, 5cm, 0.05m)'); process.exitCode = 1; return;
    }
    if (tolerance > 1 && !/[a-z]$/i.test(opts.tolerance.trim())) {
      console.error(`--tolerance is in metres (0.05 = 5 cm); for millimetres write ${opts.tolerance}mm`); process.exitCode = 1; return;
    }
    if (opts.level && !discoverLayout(absDir).levelDirs.some(d => d.name === opts.level) && opts.level !== 'global') {
      console.error(`No level directory ${opts.level} in ${dir}`); process.exitCode = 1; return;
    }
    const { clashReport, formatClashReport } = await import('./mep/clash-load.js');
    const report = clashReport(absDir, { toleranceM: tolerance, clearanceMm: clearance * 1000, level: opts.level, mepOnly: opts.mepOnly, minor: opts.minor });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatClashReport(report)) console.log(line);
  });

// ─── merge ───────────────────────────────────────────────
program
  .command('merge')
  .argument('<dirs...>', 'Two or more BimDown project directories to merge')
  .requiredOption('-o, --output <dir>', 'Output directory for merged project')
  .description('Merge multiple BimDown project directories into one, resolving ID conflicts')
  .action(async (dirs: string[], opts: { output: string }) => {
    if (dirs.length < 2) {
      console.error('At least 2 source directories are required.');
      process.exitCode = 1;
      return;
    }
    const absDirs = dirs.map((d) => resolve(d));
    const absOut = resolve(opts.output);
    const { merge } = await import('./commands/merge.js');
    await merge(absDirs, absOut);
  });

// ─── schema ─────────────────────────────────────────────
program
  .command('schema')
  .argument('[table]', 'Table name (omit for a compact index of all tables)')
  .option('--all', 'Print the full schema of every table (long)')
  .description('Print the full schema of a table, or an index of all tables')
  .action((table: string | undefined, opts: { all?: boolean }) => {
    const registry = buildRegistry(getSpecDir());
    if (!table && !opts.all) {
      for (const l of schemaIndexLines(registry)) console.log(l);
      return;
    }

    const tables = table ? [table] : [...registry.keys()].sort();
    for (const t of tables) {
      const resolved = registry.get(t);
      if (!resolved) {
        console.error(`Unknown table: ${t}. Run \`bimdown schema\` for the list of tables.`);
        process.exitCode = 1;
        return;
      }
      for (const l of schemaTableLines(resolved)) console.log(l);
      console.log();
    }
  });

// ─── init ───────────────────────────────────────────────
program
  .command('init')
  .argument('<dir>', 'BimDown project directory')
  .option('--units <units>', 'Project units: m, mm, ft or in (starter types are scaled to them)', 'm')
  .description('Initialize a new BimDown project structure')
  .action(async (dir: string, opts: { units: string }) => {
    const absDir = resolve(dir);
    const { initProject, PROJECT_UNITS } = await import('./commands/init.js');
    if (!(PROJECT_UNITS as string[]).includes(opts.units)) {
      console.error(`Unknown units "${opts.units}" (use ${PROJECT_UNITS.join(', ')})`);
      process.exitCode = 1;
      return;
    }
    initProject(absDir, { units: opts.units as any });
  });

// ─── diff ───────────────────────────────────────────────
program
  .command('diff')
  .argument('<dirA>', 'First BimDown project directory')
  .argument('<dirB>', 'Second BimDown project directory')
  .description('Show differences between two BimDown projects')
  .action(async (dirA: string, dirB: string) => {
    const absA = resolve(dirA);
    const absB = resolve(dirB);
    const { diffProjects } = await import('./commands/diff.js');
    diffProjects(absA, absB);
  });

// ─── import-ifc ────────────────────────────────────────
program
  .command('import-ifc')
  .argument('<file>', 'IFC file (IFC2x3 / IFC4 / IFC4x3, .ifc)')
  .argument('<outdir>', 'Directory for the new BimDown project')
  .option('--force', 'Write into a non-empty directory')
  .option('--json <path>', 'Also write the import report as JSON')
  .description('Convert an IFC model into a BimDown project, then build it and report room problems')
  .action(async (file: string, outdir: string, opts: { force?: boolean; json?: string }) => {
    const { runImportIfc, printImportResult } = await import('./commands/import-ifc.js');
    try {
      const r = await runImportIfc(file, outdir, opts);
      printImportResult(r, outdir);
      if (r.build.issues.length > 0) process.exitCode = 1;
    } catch (e) {
      console.error(`import-ifc: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

// ─── publish ───────────────────────────────────────────
program
  .command('publish')
  .argument('<dir>', 'BimDown project directory')
  .option('--expires <duration>', 'Expiration time (e.g. 7d, 24h, 30m)', '7d')
  .option('--api <url>', 'API base URL (default https://bim.jouledown.com, or $BIMDOWN_API)')
  .option('--name <name>', 'Project name')
  .description('Publish a BimDown project to bim.jouledown.com and get a share link')
  .action(async (dir: string, opts: { expires?: string; api?: string; name?: string }) => {
    const { publish } = await import('./commands/publish.js');
    await publish(dir, opts);
  });

program.parse();

// ─── helpers ────────────────────────────────────────────

function printTable(columns: string[], rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    console.log('(empty result)');
    return;
  }

  // Calculate column widths
  const widths = columns.map((c) => c.length);
  for (const row of rows) {
    for (let i = 0; i < columns.length; i++) {
      const val = formatValue(row[columns[i]]);
      widths[i] = Math.max(widths[i], val.length);
    }
  }

  // Header
  const header = columns.map((c, i) => c.padEnd(widths[i])).join(' | ');
  console.log(header);
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));

  // Rows
  for (const row of rows) {
    const line = columns
      .map((c, i) => formatValue(row[c]).padEnd(widths[i]))
      .join(' | ');
    console.log(line);
  }

  console.log(`\n(${rows.length} row(s))`);
}

function formatValue(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'bigint') return val.toString();
  return String(val);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  return value;
}
