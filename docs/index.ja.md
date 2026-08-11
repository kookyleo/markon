---
layout: home

hero:
  name: Markon
  tagline: |-
    <span class="markon-hero-declaration">人と Agent が、文書の上で合意にたどり着けるように。</span>
    <span class="markon-hero-explainer">設計は一度で完成するものではなく、レビューと修正を重ねながら収束していきます。Markon は、人と Agent が Spec を一緒に磨くための Markdown IDE です。現在の案を読み、批注や修正を加え、次の差分をレビューする。その繰り返しを、合意に至るまで同じ文書の文脈で進められます。</span>
  image:
    light: /logo-light.svg
    dark: /logo-dark.svg
    alt: Markon
  actions:
    - theme: brand
      text: はじめる
      link: /guide/getting-started
    - theme: alt
      text: 機能を見る
      link: /features/
    - theme: alt
      text: GitHub
      link: https://github.com/kookyleo/markon
---

<FeatureGallery />

<HomeDownloadSection>

<h2 id="downloads" class="markon-home-download-title">今すぐ始める</h2>

<DownloadButton />

<p class="markon-home-download-copy">デスクトップ版にはバックグラウンドサービスが含まれています。サーバーまたはターミナルだけで使う場合は、<a href="https://crates.io/crates/markon">Cargo</a> から <code>markon</code> と <code>markond</code> をインストールできます。</p>

```bash
cargo install markon markond
markon README.md
```

</HomeDownloadSection>
