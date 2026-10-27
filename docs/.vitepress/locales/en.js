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
          text: 'Features',
          items: [
            { text: 'Feature overview', link: '/features/' },
          ],
        },
        {
          text: 'Workspace',
          items: [
            { text: 'Workspace / Files', link: '/features/workspaces' },
            { text: 'Spotlight / Search', link: '/features/search' },
          ],
        },
        {
          text: 'Reading',
          items: [
            { text: 'Markdown / Viewer', link: '/features/rendering' },
            { text: 'Outline / Focus / Fold / Resume', link: '/features/viewed' },
          ],
        },
        {
          text: 'Review',
          items: [
            { text: 'Annotate', link: '/features/annotations' },
            { text: 'Progress', link: '/features/viewed' },
            { text: 'Git / Markdiff', link: '/features/git' },
          ],
        },
        {
          text: 'Edit',
          items: [
            { text: 'Edit', link: '/features/edit' },
          ],
        },
        {
          text: 'Workspace AI',
          items: [
            { text: 'Chat', link: '/features/chat' },
          ],
        },
        {
          text: 'Team',
          items: [
            { text: 'Live', link: '/features/live' },
            { text: 'Share', link: '/advanced/shared-annotations' },
          ],
        },
        {
          text: 'Output',
          items: [
            { text: 'Export Notes', link: '/features/export' },
            { text: 'Print', link: '/features/print' },
          ],
        },
        {
          text: 'Settings',
          items: [
            { text: 'Access', link: '/features/access' },
            { text: 'Privacy', link: '/advanced/data-and-privacy' },
            { text: 'Theme / Typography', link: '/advanced/custom-styles' },
            { text: 'Actions / Shortcuts', link: '/advanced/shortcuts' },
          ],
        },
      ],
      '/advanced/': [
        {
          text: 'Deployment, data, and customization',
          items: [
            { text: 'Data and privacy', link: '/advanced/data-and-privacy' },
            { text: 'Share', link: '/advanced/shared-annotations' },
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
