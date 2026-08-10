import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/tests.json' },
    coverage: {
      provider: 'v8',
      include: [
        'src/pi-runtime-*.ts',
        'src/agent-session-*.ts',
        'src/office-tool-*.ts',
        'src/mineru-*.ts',
        'src/secure-storage-broker.ts',
      ],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
})
