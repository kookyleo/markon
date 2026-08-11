// English is the canonical content language and the fallback whenever a
// locale-specific Markdown file is absent.
export const en = {
  label: 'English',
  lang: 'en-US',
  themeConfig: {
    nav: [
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'Features', link: '/features/' },
      { text: 'Deployment & data', link: '/advanced/data-and-privacy' },
      { text: 'FAQ', link: '/faq' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Meet Markon',
          items: [
            { text: 'Product overview', link: '/guide/introduction' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'CLI reference', link: '/guide/cli' },
          ],
        },
      ],
      '/features/': [
        {
          text: 'Workspace',
          items: [
            { text: 'Feature overview', link: '/features/' },
            { text: 'Workspaces and files', link: '/features/workspaces' },
            { text: 'Markdown rendering', link: '/features/rendering' },
            { text: 'Workspace Spotlight', link: '/features/search' },
            { text: 'Git browsing and diffs', link: '/features/git' },
          ],
        },
        {
          text: 'Reading and review',
          items: [
            { text: 'Annotations and Notes', link: '/features/annotations' },
            { text: 'Section progress and folding', link: '/features/viewed' },
            { text: 'Export Notes', link: '/features/export' },
            { text: 'Section printing', link: '/features/print' },
            { text: 'Source editing', link: '/features/edit' },
          ],
        },
        {
          text: 'Collaboration and AI',
          items: [
            { text: 'Live presentation', link: '/features/live' },
            { text: 'Workspace AI', link: '/features/chat' },
            { text: 'Access and permissions', link: '/features/access' },
          ],
        },
      ],
      '/advanced/': [
        {
          text: 'Deployment, data, and customization',
          items: [
            { text: 'Data and privacy', link: '/advanced/data-and-privacy' },
            { text: 'Shared annotations', link: '/advanced/shared-annotations' },
            { text: 'Reverse proxy', link: '/advanced/reverse-proxy' },
            { text: 'Custom styles', link: '/advanced/custom-styles' },
            { text: 'Keyboard shortcuts', link: '/advanced/shortcuts' },
          ],
        },
      ],
    },
    outline: { label: 'On this page', level: [2, 3] },
    docFooter: { prev: 'Previous page', next: 'Next page' },
    lastUpdatedText: 'Last updated',
    returnToTopLabel: 'Return to top',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Theme',
    lightModeSwitchTitle: 'Switch to light theme',
    darkModeSwitchTitle: 'Switch to dark theme',
  },
};
