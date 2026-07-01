// Simplified Chinese (default / root) locale: nav, sidebar, and UI labels.
// Kept out of config.js so the global config stays ASCII-only; CJK label text
// lives here under a /locales/ path by convention.
export const zh = {
  label: '简体中文',
  lang: 'zh-CN',
  description: 'Turn your markdown on. — 轻量级 Markdown 阅览与审校工作台。开源、免费、完全本地。',
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
            { text: '与文档对话', link: '/features/chat' },
            { text: '已读追踪 (Viewed)', link: '/features/viewed' },
            { text: '快捷编辑', link: '/features/edit' },
            { text: '注解与笔记', link: '/features/annotations' },
            { text: '导出便条', link: '/features/export' },
            { text: '实时协作 (Live)', link: '/features/live' },
            { text: '章节打印', link: '/features/print' },
            { text: '访问码', link: '/features/access' },
          ],
        },
      ],
      '/advanced/': [
        {
          text: '进阶用法',
          items: [
            { text: '共享批注', link: '/advanced/shared-annotations' },
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
};
