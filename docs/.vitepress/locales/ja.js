// Japanese source overrides use `.ja.md` and are served below `/ja/`.
// Missing overrides link to the canonical English page.
export const ja = {
  label: '日本語',
  lang: 'ja-JP',
  themeConfig: {
    nav: [
      { text: 'はじめに', link: '/guide/getting-started' },
      { text: '機能', link: '/features/' },
      { text: '導入とデータ', link: '/advanced/data-and-privacy' },
      { text: 'よくある質問', link: '/faq' },
    ],
  },
};
