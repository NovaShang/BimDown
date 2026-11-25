import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

// CLI files the editor re-exports. They run in the browser and have to compile
// in both packages, so they must not import anything (node:*, CLI helpers…).
const SHARED: [editor: string, cli: string][] = [
  ['editor/src/geometry/roofSolver.ts', 'cli/src/geo/roof-solver.ts'],
  ['editor/src/geometry/stairCore.ts', 'cli/src/stair/geometry.ts'],
  ['editor/src/families/sections/steelSections.ts', 'cli/src/sections/steel-sections.ts'],
  ['editor/src/mep/clash.ts', 'cli/src/mep/clash.ts'],
  ['editor/src/mep/mepCheck.ts', 'cli/src/mep/check.ts'],
  ['editor/src/geometry/curtainEmbed.ts', 'cli/src/curtain-embed.ts'],
  ['editor/src/geometry/modelChecks.ts', 'cli/src/build/model-checks.ts'],
  ['editor/src/library/furnitureLibrary.ts', 'cli/src/furniture/library.ts'],
]

describe('code shared with the CLI', () => {
  for (const [editor, cli] of SHARED) {
    it(`${editor} re-exports ${cli}, which has no imports`, () => {
      const target = read(editor).match(/export \* from '(.+)'/)?.[1]
      expect(join(ROOT, editor, '..', target ?? '')).toBe(join(ROOT, cli))
      expect(read(cli)).not.toMatch(/^\s*(import|export)\b[^\n;]*\bfrom\s*['"]|\bimport\s*\(|\brequire\s*\(|^\s*import\s*['"]/m)
    })
  }
})

describe('spec enums the editor writes', () => {
  it('sheet_viewport.schedule lists every editor schedule', () => {
    const yaml = read('spec/csv-schema/sheet/sheet_viewport.yaml')
    const values = yaml.match(/- name: schedule\n\s+type: enum\n\s+values: \[([^\]]*)\]/)![1].split(',').map(s => s.trim())
    const src = read('editor/src/schedule/schedules.ts') + read('editor/src/schedule/mepSchedules.ts')
    const keys = [...src.matchAll(/key: '([a-z_]+)', label: 'schedule\./g)].map(m => m[1])
    expect(keys.length).toBeGreaterThan(10)
    expect(keys.filter(k => !values.includes(k))).toEqual([])
  })
})
