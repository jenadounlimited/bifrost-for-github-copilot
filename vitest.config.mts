// Vitest configuration

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/test/**/*.test.ts'],
    exclude: ['node_modules', 'out', '.vscode-test'],
    coverage: {
      enabled: false,
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/test/**',
        'src/vscode.d.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 75,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: {
      vscode: new URL('./src/test/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
