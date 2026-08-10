// English is the static fallback. The client replaces shell copy from the
// locale cookie or browser preference without adding a language URL segment.
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
  },
};
