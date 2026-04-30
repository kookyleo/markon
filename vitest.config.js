import { defineConfig } from 'vitest/config';

// Tests are colocated next to the module they cover:
// `services/text.ts` ↔ `services/text.test.ts`. jsdom is the default
// environment because most modules touch DOM (querySelector, ranges, etc.).
// Pure-logic modules can opt out via `// @vitest-environment node`.
export default defineConfig({
  test: {
    include: ['crates/core/assets/js/**/*.{test,spec}.{ts,js}'],
    environment: 'jsdom',
  },
  // `__DEV__` is a build-time global injected by esbuild's `define` (see
  // scripts/build.mjs). Tests run through vitest which doesn't know about it,
  // so substitute the release-build value (`false`) here so the dev-reload
  // EventSource block is dead-code-eliminated when modules are imported in tests.
  define: {
    __DEV__: 'false',
  },
});
