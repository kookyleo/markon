<script setup>
import { computed, onMounted } from 'vue';
import { withBase } from 'vitepress';
import { HOME_SHELL_COPY } from '../home-copy';
import { useHomeLocale } from '../home-locale';

const { locale, initializeHomeLocale } = useHomeLocale();
const copy = computed(() => HOME_SHELL_COPY[locale.value].footer);

const groups = computed(() => [
  {
    title: copy.value.groups.docs,
    links: [
      { label: copy.value.links.gettingStarted, href: withBase('/guide/getting-started') },
      { label: copy.value.links.features, href: withBase('/features/') },
      { label: copy.value.links.deployment, href: withBase('/advanced/data-and-privacy') },
    ],
  },
  {
    title: copy.value.groups.resources,
    links: [
      { label: copy.value.links.download, href: withBase('/download') },
      { label: copy.value.links.faq, href: withBase('/faq') },
    ],
  },
  {
    title: copy.value.groups.project,
    links: [
      { label: copy.value.links.releases, href: 'https://github.com/kookyleo/markon/releases', external: true },
      { label: 'GitHub', href: 'https://github.com/kookyleo/markon', external: true },
    ],
  },
]);

onMounted(initializeHomeLocale);
</script>

<template>
  <footer class="markon-site-footer">
    <div class="markon-site-footer-main">
      <div class="markon-site-footer-brand">
        <a :href="withBase('/')" aria-label="Markon home">Markon</a>
        <p>{{ copy.tagline }}</p>
      </div>
      <nav class="markon-site-footer-nav" :aria-label="copy.navigationLabel">
        <section v-for="group in groups" :key="group.title">
          <h2>{{ group.title }}</h2>
          <a
            v-for="link in group.links"
            :key="link.href"
            :href="link.href"
            :target="link.external ? '_blank' : undefined"
            :rel="link.external ? 'noreferrer' : undefined"
          >
            {{ link.label }}<span v-if="link.external" aria-hidden="true"> ↗</span>
          </a>
        </section>
      </nav>
    </div>
    <div class="markon-site-footer-legal">
      <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noreferrer">
        {{ copy.license }}
      </a>
      <span>Copyright © 2026 kookyleo</span>
    </div>
  </footer>
</template>
