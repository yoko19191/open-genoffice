import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.{test.ts,test.mjs}'],
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/tests.json' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,mjs}'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
})
