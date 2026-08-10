// Simplified Chinese (default / root) locale: nav, sidebar, and UI labels.
// Kept out of config.js so the global config stays ASCII-only; CJK label text
// lives here under a /locales/ path by convention.
export const zh = {
  label: '简体中文',
  lang: 'zh-CN',
  description: '本地优先的 Markdown 阅读、审阅、Git 对比与协作工作台。',
  themeConfig: {
    nav: [
      { text: '开始使用', link: '/guide/getting-started' },
      { text: '产品能力', link: '/features/' },
      { text: '部署与数据', link: '/advanced/data-and-privacy' },
      { text: '常见问题', link: '/faq' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '认识 Markon',
          items: [
            { text: '产品定位', link: '/guide/introduction' },
            { text: '快速上手', link: '/guide/getting-started' },
            { text: '安装', link: '/guide/installation' },
            { text: '运行架构', link: '/guide/architecture' },
            { text: '命令行选项', link: '/guide/cli' },
          ],
        },
      ],
      '/features/': [
        {
          text: '工作区',
          items: [
            { text: '能力总览', link: '/features/' },
            { text: '工作区与文件浏览', link: '/features/workspaces' },
            { text: 'Markdown 渲染', link: '/features/rendering' },
            { text: 'Workspace Spotlight', link: '/features/search' },
            { text: 'Git 浏览与对比', link: '/features/git' },
          ],
        },
        {
          text: '阅读与审阅',
          items: [
            { text: '批注与 Notes', link: '/features/annotations' },
            { text: '章节进度与折叠', link: '/features/viewed' },
            { text: '导出便条', link: '/features/export' },
            { text: '章节打印', link: '/features/print' },
            { text: '源码编辑', link: '/features/edit' },
          ],
        },
        {
          text: '协作与智能',
          items: [
            { text: '实时演示 (Live)', link: '/features/live' },
            { text: 'Workspace AI', link: '/features/chat' },
            { text: '访问与权限', link: '/features/access' },
          ],
        },
      ],
      '/advanced/': [
        {
          text: '部署、数据与定制',
          items: [
            { text: '数据与隐私', link: '/advanced/data-and-privacy' },
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
  },
};
