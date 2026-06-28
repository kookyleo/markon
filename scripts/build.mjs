import esbuild from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
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

async function build() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const mainOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'main.ts')],
    outfile: resolve(outDir, 'main.js'),
    format: 'esm',
    target: ['es2022'],
    plugins: watch ? [makeReloadPlugin('main')] : [],
  };
  const viewedOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'viewed.ts')],
    outfile: resolve(outDir, 'viewed.js'),
    format: 'iife',
    target: ['es2022'],
    // viewed.js doesn't need its own reload trigger — main.ts owns the
    // single EventSource and one reload picks up every bundle on disk.
  };
  const workspaceDiffOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'workspace-diff.ts')],
    outfile: resolve(outDir, 'workspace-diff.js'),
    format: 'esm',
    target: ['es2022'],
    // main.ts owns the dev reload EventSource.
  };
  const markdownDiffOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'markdown-diff.ts')],
    outfile: resolve(outDir, 'markdown-diff.js'),
    format: 'esm',
    target: ['es2022'],
    // main.ts owns the dev reload EventSource.
  };
  const diffAnnotationsOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'diff-annotations.ts')],
    outfile: resolve(outDir, 'diff-annotations.js'),
    format: 'esm',
    target: ['es2022'],
    // main.ts owns the dev reload EventSource.
  };
  const diffFileCreateOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'diff-file-create.ts')],
    outfile: resolve(outDir, 'diff-file-create.js'),
    format: 'esm',
    target: ['es2022'],
    // main.ts owns the dev reload EventSource.
  };
  const diffShortcutsOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'diff-shortcuts.ts')],
    outfile: resolve(outDir, 'diff-shortcuts.js'),
    format: 'esm',
    target: ['es2022'],
    // main.ts owns the dev reload EventSource.
  };
  // Classic (IIFE) bundle: loaded as a non-module <script> in git-diff.html so
  // it runs DURING parse, before the deferred diff-view ES modules — matching
  // where this logic used to live inline.
  const diffControlsOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'diff-controls.ts')],
    outfile: resolve(outDir, 'diff-controls.js'),
    format: 'iife',
    target: ['es2022'],
    // main.ts owns the dev reload EventSource.
  };
  // Classic (IIFE) bundle for the directory/workspace landing page — runs during
  // parse before the deferred main.js / workspace-diff.js modules.
  const directoryOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'directory.ts')],
    outfile: resolve(outDir, 'directory.js'),
    format: 'iife',
    target: ['es2022'],
    // main.ts owns the dev reload EventSource.
  };
  // Classic (IIFE) bundle for the document-view page chrome (TOC tracking +
  // layout i18n) — runs during parse, sets __markonTocSetSelected before main.js.
  const layoutPageOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'layout-page.ts')],
    outfile: resolve(outDir, 'layout-page.js'),
    format: 'iife',
    target: ['es2022'],
    // main.ts owns the dev reload EventSource.
  };
  // Small classic (IIFE) page bundles (i18n + minimal page glue).
  const accessGateOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'access-gate.ts')],
    outfile: resolve(outDir, 'access-gate.js'),
    format: 'iife',
    target: ['es2022'],
  };
  const gitRefsOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'git-refs.ts')],
    outfile: resolve(outDir, 'git-refs.js'),
    format: 'iife',
    target: ['es2022'],
  };
  const mathRenderOpts = {
    ...shared,
    entryPoints: [resolve(srcDir, 'math-render.ts')],
    outfile: resolve(outDir, 'math-render.js'),
    format: 'iife',
    target: ['es2022'],
    globalName: 'MarkonMathRenderBundle',
    // main.ts owns the dev reload EventSource.
  };

  await mkdir(resolve(outDir, 'katex/fonts'), { recursive: true });
  await copyFile(
    resolve(root, 'node_modules/katex/dist/katex.min.js'),
    resolve(outDir, 'katex/katex.min.js'),
  );
  await copyFile(
    resolve(root, 'node_modules/katex/dist/katex.min.css'),
    resolve(outDir, 'katex/katex.min.css'),
  );
  await cp(
    resolve(root, 'node_modules/katex/dist/fonts'),
    resolve(outDir, 'katex/fonts'),
    { recursive: true },
  );

  if (watch) {
    const ctxMain = await esbuild.context(mainOpts);
    const ctxViewed = await esbuild.context(viewedOpts);
    const ctxWorkspaceDiff = await esbuild.context(workspaceDiffOpts);
    const ctxMarkdownDiff = await esbuild.context(markdownDiffOpts);
    const ctxDiffAnnotations = await esbuild.context(diffAnnotationsOpts);
    const ctxDiffFileCreate = await esbuild.context(diffFileCreateOpts);
    const ctxDiffShortcuts = await esbuild.context(diffShortcutsOpts);
    const ctxDiffControls = await esbuild.context(diffControlsOpts);
    const ctxDirectory = await esbuild.context(directoryOpts);
    const ctxLayoutPage = await esbuild.context(layoutPageOpts);
    const ctxAccessGate = await esbuild.context(accessGateOpts);
    const ctxGitRefs = await esbuild.context(gitRefsOpts);
    const ctxMathRender = await esbuild.context(mathRenderOpts);
    await ctxMain.watch();
    await ctxViewed.watch();
    await ctxWorkspaceDiff.watch();
    await ctxMarkdownDiff.watch();
    await ctxDiffAnnotations.watch();
    await ctxDiffFileCreate.watch();
    await ctxDiffShortcuts.watch();
    await ctxDiffControls.watch();
    await ctxDirectory.watch();
    await ctxLayoutPage.watch();
    await ctxAccessGate.watch();
    await ctxGitRefs.watch();
    await ctxMathRender.watch();
    console.log('[build] watching…');
  } else {
    await Promise.all([
      esbuild.build(mainOpts),
      esbuild.build(viewedOpts),
      esbuild.build(workspaceDiffOpts),
      esbuild.build(markdownDiffOpts),
      esbuild.build(diffAnnotationsOpts),
      esbuild.build(diffFileCreateOpts),
      esbuild.build(diffShortcutsOpts),
      esbuild.build(diffControlsOpts),
      esbuild.build(directoryOpts),
      esbuild.build(layoutPageOpts),
      esbuild.build(accessGateOpts),
      esbuild.build(gitRefsOpts),
      esbuild.build(mathRenderOpts),
    ]);
    console.log('[build] done');
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
