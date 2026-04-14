import { defineConfig } from 'vitepress';

// Shared config across all locales.
export default defineConfig({
  title: 'Markon',
  description: 'Turn your markdown on. — A lightweight Markdown renderer with GitHub styling.',
  base: '/markon/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/markon/favicon.png' }],
  ],

  themeConfig: {
    logo: '/favicon.png',
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/kookyleo/markon' },
    ],
  },

  // All three languages live at parallel sub-paths (/zh/, /en/, /ja/).
  // The root (`/`) is a minimal language-picker landing page.
  locales: {
    root: {
      label: '🌐',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: '简体中文', link: '/zh/' },
          { text: 'English', link: '/en/' },
          { text: '日本語', link: '/ja/' },
        ],
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/getting-started' },
          { text: '功能', link: '/zh/features/search' },
          { text: '进阶', link: '/zh/advanced/shared-annotations' },
          { text: '常见问题', link: '/zh/faq' },
          { text: 'GitHub Release', link: 'https://github.com/kookyleo/markon/releases' },
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: '入门',
              items: [
                { text: '简介', link: '/zh/guide/introduction' },
                { text: '快速上手', link: '/zh/guide/getting-started' },
                { text: '安装', link: '/zh/guide/installation' },
                { text: '命令行选项', link: '/zh/guide/cli' },
              ],
            },
          ],
          '/zh/features/': [
            {
              text: '核心功能',
              items: [
                { text: '全文搜索', link: '/zh/features/search' },
                { text: '已读追踪', link: '/zh/features/viewed' },
                { text: '在线编辑', link: '/zh/features/edit' },
                { text: '标注与高亮', link: '/zh/features/annotations' },
                { text: '章节打印', link: '/zh/features/print' },
              ],
            },
          ],
          '/zh/advanced/': [
            {
              text: '进阶用法',
              items: [
                { text: '共享标注', link: '/zh/advanced/shared-annotations' },
                { text: '反向代理', link: '/zh/advanced/reverse-proxy' },
                { text: '自定义样式', link: '/zh/advanced/custom-styles' },
                { text: '键盘快捷键', link: '/zh/advanced/shortcuts' },
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
