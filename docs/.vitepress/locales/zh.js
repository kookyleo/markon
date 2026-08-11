// Simplified Chinese locale served below /zh/.
export const zh = {
  label: '简体中文',
  lang: 'zh-CN',
  description: '本地优先的 Markdown 阅读、审阅、Git 对比与协作工作台。',
  themeConfig: {
    nav: [
      { text: '开始使用', link: '/zh/guide/getting-started' },
      { text: '产品能力', link: '/zh/features/' },
      { text: '部署与数据', link: '/zh/advanced/data-and-privacy' },
      { text: '常见问题', link: '/zh/faq' },
    ],
    sidebar: {
      '/zh/guide/': [
        {
          text: '认识 Markon',
          items: [
            { text: '产品定位', link: '/zh/guide/introduction' },
            { text: '快速上手', link: '/zh/guide/getting-started' },
            { text: '安装', link: '/zh/guide/installation' },
            { text: '运行架构', link: '/zh/guide/architecture' },
            { text: '命令行选项', link: '/zh/guide/cli' },
          ],
        },
      ],
      '/zh/features/': [
        {
          text: '工作区',
          items: [
            { text: '能力总览', link: '/zh/features/' },
            { text: '工作区与文件浏览', link: '/zh/features/workspaces' },
            { text: 'Markdown 渲染', link: '/zh/features/rendering' },
            { text: 'Workspace Spotlight', link: '/zh/features/search' },
            { text: 'Git 浏览与对比', link: '/zh/features/git' },
          ],
        },
        {
          text: '阅读与审阅',
          items: [
            { text: '批注与 Notes', link: '/zh/features/annotations' },
            { text: '章节进度与折叠', link: '/zh/features/viewed' },
            { text: '导出便条', link: '/zh/features/export' },
            { text: '章节打印', link: '/zh/features/print' },
            { text: '源码编辑', link: '/zh/features/edit' },
          ],
        },
        {
          text: '协作与智能',
          items: [
            { text: '实时演示 (Live)', link: '/zh/features/live' },
            { text: 'Workspace AI', link: '/zh/features/chat' },
            { text: '访问与权限', link: '/zh/features/access' },
          ],
        },
      ],
      '/zh/advanced/': [
        {
          text: '部署、数据与定制',
          items: [
            { text: '数据与隐私', link: '/zh/advanced/data-and-privacy' },
            { text: '共享批注', link: '/zh/advanced/shared-annotations' },
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
  },
};
