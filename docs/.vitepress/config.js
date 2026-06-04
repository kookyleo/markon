import { defineConfig } from 'vitepress';
import { zh } from './locales/zh.js';
import { en } from './locales/en.js';
import { ja } from './locales/ja.js';

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
  title: 'Markon',
  description: 'Turn your markdown on. — A lightweight, local-first Markdown reading & review workbench. Open source and free.',

  base,

  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${base}favicon.png` }],
  ],

  themeConfig: {
    // Logo is a baked wordmark (mark + "Markon" as vector paths), so the
    // text title is hidden to avoid duplicating the brand name.
    logo: { light: '/logo-wordmark-light.svg', dark: '/logo-wordmark-dark.svg', alt: 'Markon' },
    siteTitle: false,
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/kookyleo/markon' },
    ],
    // Consumed by docs/.vitepress/theme/components/DownloadButton.vue.
    markonRelease: release,
  },

  // Chinese is the default language, served at the root path.
  // English and Japanese live at /en/ and /ja/.
  // The language switcher shows exactly three options — no extra "root" entry.
  // Per-locale nav/sidebar/label text lives in ./locales/*.js so this config
  // file stays ASCII-only (CJK label text belongs under a /locales/ path).
  locales: {
    root: zh,
    en,
    ja,
  },
});
