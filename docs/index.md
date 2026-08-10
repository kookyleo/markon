---
layout: home

hero:
  name: Markon
  tagline: |-
    <span class="markon-hero-declaration">Help people and agents reach agreement in documents.</span>
    <span class="markon-hero-explainer">Design is rarely finished in one pass. It converges through review, revision, and review again. Markon is a Markdown IDE for people and agents to refine Specs together: read the current proposal, leave feedback or edit it directly, then review what changed in the next version—repeat until everyone agrees.</span>
  image:
    light: /logo-light.svg
    dark: /logo-dark.svg
    alt: Markon
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Explore features
      link: /features/
    - theme: alt
      text: GitHub
      link: https://github.com/kookyleo/markon
---

<FeatureGallery />

<HomeDownloadSection>

<h2 id="downloads" class="markon-home-download-title">Get started</h2>

<DownloadButton />

<p class="markon-home-download-copy">The desktop app already includes the background service. For servers or terminal-only workflows, install <code>markon</code> and <code>markond</code> through <a href="https://crates.io/crates/markon">Cargo</a>:</p>

```bash
cargo install markon markond
markon README.md
```

</HomeDownloadSection>
