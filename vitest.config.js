import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['crates/**/tests/**/*.test.js'],
    environment: 'jsdom',
  },
});
