import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

const DOCS_ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_ROOT = join(DOCS_ROOT, 'public');
const THEME_ROOT = join(DOCS_ROOT, '.vitepress');
const THEME_EXTENSIONS = new Set(['.js', '.ts', '.vue']);
const IGNORED_ROUTE_LITERALS = new Set(['/markon/']);

function walk(directory, include, ignoredDirectories = []) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.includes(entry.name)) {
      return walk(target, include, ignoredDirectories);
    }
    return entry.isFile() && include(target) ? [target] : [];
  });
}

function lineAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function anchorsFor(file) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!heading) continue;
    const explicit = heading[1].match(/\s*\{#([^}]+)\}\s*$/);
    if (explicit) anchors.add(explicit[1]);
    const title = heading[1].replace(/\s*\{#[^}]+\}\s*$/, '');
    const base = slugify(title);
    if (!base) continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function markdownTarget(pathname, sourceFile) {
  const base = pathname.startsWith('/') ? DOCS_ROOT : dirname(sourceFile);
  const raw = normalize(join(base, pathname.replace(/^\//, '')));
  const candidates = extname(raw)
    ? [raw]
    : [raw, `${raw}.md`, join(raw, 'index.md')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function assetTarget(pathname, sourceFile) {
  const raw = pathname.startsWith('/')
    ? join(PUBLIC_ROOT, pathname.slice(1))
    : join(dirname(sourceFile), pathname);
  return existsSync(raw) ? raw : null;
}

function routeFor(file) {
  const relativePath = relative(DOCS_ROOT, file).split(sep).join('/');
  if (relativePath === 'index.md') return '/';
  if (relativePath.endsWith('/index.md')) return `/${relativePath.slice(0, -'index.md'.length)}`;
  return `/${relativePath.slice(0, -'.md'.length)}`;
}

function strippedHref(href) {
  const withoutQuery = href.split('?', 1)[0];
  const [pathname, anchor = ''] = withoutQuery.split('#', 2);
  return { pathname: decodeURIComponent(pathname), anchor: decodeURIComponent(anchor) };
}

const errors = [];
const incoming = new Map();
const markdownFiles = walk(
  DOCS_ROOT,
  (file) => file.endsWith('.md'),
  ['.vitepress', 'node_modules'],
);
const markdownSet = new Set(markdownFiles);
const routes = new Map(markdownFiles.map((file) => [routeFor(file), file]));

function recordIncoming(target, source) {
  if (!markdownSet.has(target)) return;
  if (!incoming.has(target)) incoming.set(target, new Set());
  incoming.get(target).add(source);
}

function validateHref(href, sourceFile, line, label) {
  if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(href)) return;
  const { pathname, anchor } = strippedHref(href);
  const target = pathname
    ? (extname(pathname) && extname(pathname) !== '.md'
        ? assetTarget(pathname, sourceFile)
        : markdownTarget(pathname, sourceFile))
    : sourceFile;
  const sourceLabel = relative(DOCS_ROOT, sourceFile);
  if (!target) {
    errors.push(`${sourceLabel}:${line} → 缺少${label} ${href}`);
    return;
  }
  recordIncoming(target, sourceLabel);
  if (anchor && target.endsWith('.md') && !anchorsFor(target).has(anchor)) {
    errors.push(`${sourceLabel}:${line} → 缺少锚点 ${href}`);
  }
}

for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8');
  const links = source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g);
  for (const match of links) {
    validateHref(match[1], file, lineAt(source, match.index), '目标');
  }
}

const themeFiles = walk(
  THEME_ROOT,
  (file) => THEME_EXTENSIONS.has(extname(file)),
  ['node_modules', 'dist'],
);
for (const file of themeFiles) {
  const source = readFileSync(file, 'utf8');
  const routeLiterals = source.matchAll(/(['"])(\/(?!\/)[^'"\s`]*)\1/g);
  for (const match of routeLiterals) {
    const href = match[2];
    // Sidebar route prefixes are object keys (for example '/guide/': [...]),
    // not navigable pages in their own right.
    const afterLiteral = source.slice(match.index + match[0].length);
    if (/^\s*:/.test(afterLiteral)) continue;
    if (IGNORED_ROUTE_LITERALS.has(href)) continue;
    validateHref(href, file, lineAt(source, match.index), '站内路由');
  }

  const illustrationFields = source.matchAll(/\bimage\s*:\s*(['"])(illustrations\/[^'"]+)\1/g);
  for (const match of illustrationFields) {
    const target = join(PUBLIC_ROOT, match[2]);
    if (!existsSync(target)) {
      errors.push(`${relative(DOCS_ROOT, file)}:${lineAt(source, match.index)} → 缺少插图 ${match[2]}`);
    }
  }
}

for (const [route, file] of routes) {
  if (route === '/') continue;
  if (!incoming.has(file)) {
    errors.push(`${relative(DOCS_ROOT, file)} → 孤立页面：未被 Markdown、顶栏、侧栏、首页卡片或页脚引用`);
  }
}

const fingerprints = new Map();
for (const file of markdownFiles) {
  const fingerprint = readFileSync(file, 'utf8')
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!fingerprint) continue;
  if (fingerprints.has(fingerprint)) {
    errors.push(`${relative(DOCS_ROOT, file)} → 与 ${relative(DOCS_ROOT, fingerprints.get(fingerprint))} 内容重复`);
  } else {
    fingerprints.set(fingerprint, file);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${markdownFiles.length} Markdown pages, ${themeFiles.length} theme sources, ` +
    `${routes.size} routes, local assets, anchors, navigation coverage, and duplicate pages.`,
  );
}
