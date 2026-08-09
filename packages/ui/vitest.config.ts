import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/agent-session-controller.ts', 'src/agent-session-projection.ts'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
})
