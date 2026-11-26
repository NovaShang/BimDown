import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { validate } from './index.js';

// The Revit sample is the fixture for CLI and editor tests: keep it valid
// (scripts/fix-rac-advanced.mjs repaired the raw export).
describe('sample_data/rac_advanced', () => {
  it('validates with no issues', () => {
    expect(validate(join(import.meta.dirname, '..', '..', '..', 'sample_data', 'rac_advanced'))).toEqual([]);
  }, 60_000);
});
