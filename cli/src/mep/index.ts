import { checkMep, type MepProblem } from './check.js';
import { loadMep, summarizeSystems, type SystemSummary } from './load.js';

export { checkMep, loadMep, summarizeSystems };
export type { MepProblem, SystemSummary };

export interface MepReport {
  systems: SystemSummary[];
  problems: (MepProblem & { dir: string })[];
}

export function mepReport(dir: string): MepReport {
  const m = loadMep(dir);
  const problems = checkMep(m).map(p => ({ ...p, dir: p.scope ?? '' }));
  return { systems: summarizeSystems(m), problems };
}

/** One line per problem: `lv-1/duct.csv  du-3: …`. */
export function formatProblem(p: MepProblem & { dir: string }): string {
  return `${p.dir ? `${p.dir}/` : ''}${p.table}.csv  ${p.id}: [${p.code}] ${p.message}`;
}

/** Problems `bimdown build` reports as errors: a port / fitting / circuit reference to nothing. */
const ERROR_CODES = new Set(['dangling_ref']);

/** Connectivity warnings for `bimdown build` (info-level findings and errors are left out). */
export function mepWarnings(dir: string): string[] {
  const r = mepReport(dir);
  return r.problems.filter(p => p.severity === 'warning' && !ERROR_CODES.has(p.code)).map(formatProblem);
}

/** Connectivity errors for `bimdown build`: references to elements or ports that don't exist. */
export function mepErrors(dir: string): string[] {
  const r = mepReport(dir);
  return r.problems.filter(p => p.severity === 'warning' && ERROR_CODES.has(p.code)).map(formatProblem);
}
