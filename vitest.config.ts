import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Strips ambient CANONLINT_* / Anthropic credentials so the suite behaves
    // identically on a developer laptop and on a CI runner with no secrets.
    setupFiles: ['test/setup.ts'],
  },
});
