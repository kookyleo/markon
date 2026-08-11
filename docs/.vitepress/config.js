import { defineConfig } from 'vitepress';
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildContentLocaleAvailability,
  localizedRouteForSource,
  rewriteLocalizedSource,
  sourcePathLocale,
  sourcePathToCanonicalRoute,
} from './content-locales.js';
import { en } from './locales/en.js';
import { ja } from './locales/ja.js';
import { zh } from './locales/zh.js';

// Pulled at build time so the homepage and install page can link to the actual
// latest release (Tauri bundles are versioned, so /releases/latest/download/X
// would 404 — we need the real asset names).
const release = await fetchLatestRelease();
const base = process.env.EO === 'true' ? '/' : '/markon/';
const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentLocaleAvailability = buildContentLocaleAvailability(listMarkdownFiles(docsRoot));
const siteOrigin = 'https://kookyleo.github.io';

function listMarkdownFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listMarkdownFiles(absolute, root));
    else if (entry.name.endsWith('.md')) files.push(relative(root, absolute));
  }
  return files;
}

async function fetchLatestRelease() {
  const url = 'https://api.github.com/repos/kookyleo/markon/releases/latest';
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      warnReleaseFallback(`release fetch ${res.status}; download buttons will fall back to /releases`);
      return null;
    }
    const data = await res.json();
    // Drop updater-only artifacts (sigs, archives, manifests) from user-facing lists.
    const userAssets = data.assets.filter(a =>
      !a.name.endsWith('.sig') &&
      !a.name.endsWith('.json') &&
      !/\.(app|AppImage|nsis)\.(tar\.gz|zip)$/.test(a.name)
    );
    return {
      tag: data.tag_name,
      version: data.tag_name.replace(/^v/, ''),
      htmlUrl: data.html_url,
      publishedAt: data.published_at,
      assets: userAssets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    };
  } catch (err) {
    warnReleaseFallback(`release fetch error: ${err.message}`);
    return null;
  }
}

function warnReleaseFallback(message) {
  // Offline local builds already have a deliberate /releases fallback. Keep
  // the warning for CI, where a failed release lookup can affect deployment.
  if (process.env.CI === 'true') console.warn(`[markon] ${message}`);
}

function absoluteContentUrl(route) {
  const basePrefix = base === '/' ? '' : base.slice(0, -1);
  return `${siteOrigin}${basePrefix}${route}`;
}

function contentHead(page) {
  const canonical = sourcePathToCanonicalRoute(page);
  const locale = sourcePathLocale(page);
  const current = localizedRouteForSource(page);
  const alternatives = [
    ['en', canonical],
    ...Object.entries(contentLocaleAvailability[canonical] || {})
      .map(([key, route]) => [key === 'zh' ? 'zh-CN' : key, route]),
    ['x-default', canonical],
  ];

  return [
    ['link', { rel: 'canonical', href: absoluteContentUrl(current) }],
    ...alternatives.map(([hreflang, route]) => [
      'link',
      { rel: 'alternate', hreflang, href: absoluteContentUrl(route) },
    ]),
    ['meta', { property: 'og:locale', content: locale === 'zh' ? 'zh_CN' : locale === 'ja' ? 'ja_JP' : 'en_US' }],
    ['meta', { property: 'og:url', content: absoluteContentUrl(current) }],
  ];
}

export default defineConfig({
  lang: 'en-US',
  title: 'Markon - Mark it on',
  description: 'A local-first Markdown reading, review, Git, and collaboration workbench for desktop and server workflows.',

  base,
  rewrites: rewriteLocalizedSource,

  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: 'https://kookyleo.github.io/markon/',
  },
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}favicon.png` }],
    ['meta', { name: 'theme-color', content: '#168a4a' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Markon' }],
    ['meta', { property: 'og:title', content: 'Markon — Local-first Markdown workbench' }],
    ['meta', { property: 'og:description', content: 'Read, review, edit, compare, and collaborate on local Markdown without uploading the workspace.' }],
    ['meta', { property: 'og:image', content: 'https://kookyleo.github.io/markon/og.jpg' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'Markon — Local-first Markdown workbench' }],
    ['meta', { name: 'twitter:description', content: 'Read, review, edit, compare, and collaborate on local Markdown.' }],
    ['meta', { name: 'twitter:image', content: 'https://kookyleo.github.io/markon/og.jpg' }],
  ],
  transformHead: ({ page }) => contentHead(page),

  locales: {
    root: en,
    zh: { ...zh, link: '/zh/' },
    ja: { ...ja, link: '/ja/' },
  },

  themeConfig: {
    // Keep the navigation quiet: the product mark belongs to the home hero,
    // while the persistent navigation uses the wordmark only.
    logo: false,
    siteTitle: 'Markon',
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/kookyleo/markon' },
    ],
    // Consumed by docs/.vitepress/theme/components/DownloadButton.vue.
    markonRelease: release,
    // Consumed by the custom locale switcher. Locale-specific Markdown files
    // are optional; absent entries resolve to the canonical English route.
    markonContentLocales: contentLocaleAvailability,
  },
});
