import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: that file's dev-server plugin watches
// ../sample_data, which keeps the test process alive.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
