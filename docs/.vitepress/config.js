import { defineConfig } from 'vitepress';

// Pulled at build time so the homepage and install page can link to the actual
// latest release (Tauri bundles are versioned, so /releases/latest/download/X
// would 404 — we need the real asset names).

// const release = await fetchLatestRelease();

const isEO = process.env.EO === 'true'

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
  description: 'Turn your markdown on. — 轻量级 Markdown 阅览与审校工作台。开源、免费、完全本地。',
  
  // base: '/markon/',
  base: isEO ? '/' : '/markon/',
  
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/markon/favicon.png' }],
  ],

  themeConfig: {
    logo: { light: '/logo-light.svg', dark: '/logo-dark.svg', alt: 'Markon' },
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
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '指南', link: '/guide/getting-started' },
          { text: '功能', link: '/features/search' },
          { text: '进阶', link: '/advanced/shared-annotations' },
          { text: '常见问题', link: '/faq' },
          { text: 'Release', link: 'https://github.com/kookyleo/markon/releases' },
        ],
        sidebar: {
          '/guide/': [
            {
              text: '入门',
              items: [
                { text: '简介', link: '/guide/introduction' },
                { text: '快速上手', link: '/guide/getting-started' },
                { text: '安装', link: '/guide/installation' },
                { text: '命令行选项', link: '/guide/cli' },
              ],
            },
          ],
          '/features/': [
            {
              text: '核心功能',
              items: [
                { text: '全文搜索', link: '/features/search' },
                { text: '已读追踪 (Viewed)', link: '/features/viewed' },
                { text: '在线编辑', link: '/features/edit' },
                { text: '深度标注', link: '/features/annotations' },
                { text: '实时协作 (Live)', link: '/features/live' },
                { text: '章节打印', link: '/features/print' },
              ],

            },
          ],
          '/advanced/': [
            {
              text: '进阶用法',
              items: [
                { text: '共享标注', link: '/advanced/shared-annotations' },
                { text: '反向代理', link: '/advanced/reverse-proxy' },
                { text: '自定义样式', link: '/advanced/custom-styles' },
                { text: '键盘快捷键', link: '/advanced/shortcuts' },
              ],
            },
          ],
        },
        outline: { label: '本页目录', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdatedText: '最近更新',
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '主题',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        footer: {
          message: '以 Apache 2.0 协议发布',
          copyright: 'Copyright © 2026 kookyleo',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Releases', link: 'https://github.com/kookyleo/markon/releases' },
        ],
      },
    },
    ja: {
      label: '日本語',
      lang: 'ja-JP',
      link: '/ja/',
      themeConfig: {
        nav: [
          { text: 'リリース', link: 'https://github.com/kookyleo/markon/releases' },
        ],
      },
    },
  },
});
