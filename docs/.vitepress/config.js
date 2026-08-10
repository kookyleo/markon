import { defineConfig } from 'vitepress';
import { en } from './locales/en.js';
import { zh } from './locales/zh.js';

// Pulled at build time so the homepage and install page can link to the actual
// latest release (Tauri bundles are versioned, so /releases/latest/download/X
// would 404 — we need the real asset names).
const release = await fetchLatestRelease();
const base = process.env.EO === 'true' ? '/' : '/markon/';

async function fetchLatestRelease() {
  const url = 'https://api.github.com/repos/kookyleo/markon/releases/latest';
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[markon] release fetch ${res.status}; download buttons will fall back to /releases`);
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
    console.warn(`[markon] release fetch error: ${err.message}`);
    return null;
  }
}

export default defineConfig({
  lang: 'en-US',
  title: 'Markon - Mark it on',
  description: 'A local-first Markdown reading, review, Git, and collaboration workbench for desktop and server workflows.',

  base,

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
    ['meta', { property: 'og:url', content: 'https://kookyleo.github.io/markon/' }],
    ['meta', { property: 'og:image', content: 'https://kookyleo.github.io/markon/og.jpg' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'Markon — Local-first Markdown workbench' }],
    ['meta', { name: 'twitter:description', content: 'Read, review, edit, compare, and collaborate on local Markdown.' }],
    ['meta', { name: 'twitter:image', content: 'https://kookyleo.github.io/markon/og.jpg' }],
  ],

  themeConfig: {
    // The documentation body is currently authored in Chinese, so retain its
    // complete sidebar and document controls while using English as the
    // browser-independent static shell fallback. Client-side locale copy then
    // updates the shared shell without adding a language URL segment.
    ...zh.themeConfig,
    ...en.themeConfig,
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
  },
});
