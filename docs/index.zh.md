---
layout: home

hero:
  name: Markon
  tagline: |-
    <span class="markon-hero-declaration">让人与 Agent 在文档中达成共识。</span>
    <span class="markon-hero-explainer">设计通常都不是一次写就，而是在审阅、修订与再审阅中逐步收敛完成。Markon 是人与 Agent 共同打磨 Spec 的 Markdown IDE：阅读当前方案，批注反馈或直接修改，再审阅下一版的变化，如此往复，直到达成共识。</span>
  image:
    light: /logo-light.svg
    dark: /logo-dark.svg
    alt: Markon
  actions:
    - theme: brand
      text: 快速上手
      link: /zh/guide/getting-started
    - theme: alt
      text: 查看功能
      link: /zh/features/
    - theme: alt
      text: GitHub
      link: https://github.com/kookyleo/markon
---

<FeatureGallery />

<HomeDownloadSection>

<h2 id="downloads" class="markon-home-download-title">开始使用</h2>

<DownloadButton />

<p class="markon-home-download-copy">桌面应用已经包含后台服务。服务器或纯终端工作流可通过 <a href="https://crates.io/crates/markon">Cargo</a> 安装 <code>markon</code> 与 <code>markond</code>：</p>

```bash
cargo install markon markond
markon README.md
```

</HomeDownloadSection>
