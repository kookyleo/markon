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
          text: '产品能力 / Features',
          items: [
            { text: '能力总览', link: '/zh/features/' },
          ],
        },
        {
          text: '工作区与查找 / Workspace',
          items: [
            { text: '工作区与文件（Workspace / Files）', link: '/zh/features/workspaces' },
            { text: '统一查找与搜索（Spotlight / Search）', link: '/zh/features/search' },
          ],
        },
        {
          text: '阅读与呈现 / Reading',
          items: [
            { text: '渲染与查看器（Markdown / Viewer）', link: '/zh/features/rendering' },
            { text: '章节阅读（Outline / Focus / Fold / Resume）', link: '/zh/features/viewed' },
          ],
        },
        {
          text: '批注与审阅 / Review',
          items: [
            { text: '批注（Annotate）', link: '/zh/features/annotations' },
            { text: '进度标记（Progress）', link: '/zh/features/viewed' },
            { text: 'Git 浏览与差异审阅（Git / Markdiff）', link: '/zh/features/git' },
          ],
        },
        {
          text: '源码编辑 / Edit',
          items: [
            { text: '源码编辑（Edit）', link: '/zh/features/edit' },
          ],
        },
        {
          text: '工作区 AI / Workspace AI',
          items: [
            { text: 'AI 对话（Chat）', link: '/zh/features/chat' },
          ],
        },
        {
          text: '协作与演示 / Team',
          items: [
            { text: '同步演示（Live）', link: '/zh/features/live' },
            { text: '共享批注与阅读进度（Share）', link: '/zh/advanced/shared-annotations' },
          ],
        },
        {
          text: '导出与打印 / Output',
          items: [
            { text: '导出文字批注（Export Notes）', link: '/zh/features/export' },
            { text: '打印（Print）', link: '/zh/features/print' },
          ],
        },
        {
          text: '管理与偏好 / Settings',
          items: [
            { text: '访问与权限（Access）', link: '/zh/features/access' },
            { text: '隐私与数据（Privacy）', link: '/zh/advanced/data-and-privacy' },
            { text: '主题与排版（Theme / Typography）', link: '/zh/advanced/custom-styles' },
            { text: '操作与快捷键（Actions / Shortcuts）', link: '/zh/advanced/shortcuts' },
          ],
        },
      ],
      '/zh/advanced/': [
        {
          text: '部署、数据与定制',
          items: [
            { text: '数据与隐私', link: '/zh/advanced/data-and-privacy' },
            { text: '共享批注与阅读进度（Share）', link: '/zh/advanced/shared-annotations' },
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
