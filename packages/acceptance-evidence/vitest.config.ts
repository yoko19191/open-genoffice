import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/tests.json' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.mjs'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
})
