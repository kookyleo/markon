import esbuild from 'esbuild';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'crates/core/assets/js');
const outDir = resolve(root, 'crates/core/assets/dist');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  loader: { '.svg': 'text' },
  // __DEV__ is the gate for client-side dev-only code (e.g. the live-reload
  // EventSource listener in main.ts). Replaced inline by esbuild so a release
  // build dead-code-eliminates the entire dev block.
  define: { __DEV__: watch ? 'true' : 'false' },
};

// In watch mode, every successful rebuild pings the dev server's
// /_/dev/reload-trigger so the webview can refresh. Skips the very first
// build (page is loading anyway) and silently swallows fetch errors so the
// watcher keeps running before the server has come up.
function makeReloadPlugin(label) {
  let initial = true;
  return {
    name: `dev-reload-notify-${label}`,
    setup(build) {
      build.onEnd((result) => {
        if (initial) { initial = false; return; }
        if (result.errors.length) return;
        fetch('http://127.0.0.1:1618/_/dev/reload-trigger', { method: 'POST' })
          .catch(() => { /* server not up yet — fine */ });
      });
    },
  };
}

async function pickEntry(name) {
  const ts = resolve(srcDir, `${name}.ts`);
  const js = resolve(srcDir, `${name}.js`);
  try { await access(ts); return ts; } catch {}
  try { await access(js); return js; } catch {}
  throw new Error(`No entry for ${name} (.ts or .js) under ${srcDir}`);
}

async function build() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const mainEntry = await pickEntry('main');
  const viewedEntry = await pickEntry('viewed');

  const mainOpts = {
    ...shared,
    entryPoints: [mainEntry],
    outfile: resolve(outDir, 'main.js'),
    format: 'esm',
    target: ['es2022'],
    plugins: watch ? [makeReloadPlugin('main')] : [],
  };
  const viewedOpts = {
    ...shared,
    entryPoints: [viewedEntry],
    outfile: resolve(outDir, 'viewed.js'),
    format: 'iife',
    target: ['es2022'],
    // viewed.js doesn't need its own reload trigger — main.ts owns the
    // single EventSource and one reload picks up every bundle on disk.
  };

  await copyFile(resolve(srcDir, 'mermaid.min.js'), resolve(outDir, 'mermaid.min.js'));

  if (watch) {
    const ctxMain = await esbuild.context(mainOpts);
    const ctxViewed = await esbuild.context(viewedOpts);
    await ctxMain.watch();
    await ctxViewed.watch();
    console.log('[build] watching…');
  } else {
    await Promise.all([esbuild.build(mainOpts), esbuild.build(viewedOpts)]);
    console.log('[build] done');
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
