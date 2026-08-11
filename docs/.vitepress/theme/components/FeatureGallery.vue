<script setup>
import { computed } from 'vue';
import { useData, useRoute, withBase } from 'vitepress';
import { contentLocaleFromPath, localizedContentPath } from '../../content-locales';
import { FEATURE_GALLERY_COPY } from '../feature-gallery-copy';

const route = useRoute();
const { site, theme } = useData();
const locale = computed(() => contentLocaleFromPath(route.path, site.value.base));
const content = computed(() => FEATURE_GALLERY_COPY[locale.value]);

function contentHref(path) {
  return localizedContentPath(
    path,
    locale.value,
    theme.value.markonContentLocales,
    site.value.base,
  );
}
</script>

<template>
  <section class="feature-gallery" :aria-label="content.label">
    <section v-for="group in content.groups" :key="group.title" class="group">
      <h2 class="group-title">{{ group.title }}</h2>
      <div class="grid">
        <a
          v-for="item in group.items"
          :key="item.title"
          :href="contentHref(item.link)"
          class="card"
          data-feature-card
        >
          <div class="illustration">
            <img :src="withBase(item.image)" :alt="item.title" loading="lazy" />
          </div>
          <div class="body">
            <h3>{{ item.title }}</h3>
            <p>{{ item.desc }}</p>
          </div>
        </a>
      </div>
    </section>
  </section>
</template>

<style scoped>
.feature-gallery {
  margin: 8px 0 16px;
}

.group + .group {
  margin-top: 52px;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 16px;
  border: 0;
  padding: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.04em;
}

.group-title::before {
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--vp-c-brand-1);
  content: '';
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
}

.card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  color: inherit;
  text-decoration: none;
  transition: box-shadow 160ms ease, transform 160ms ease;
}

.card:hover {
  border-color: var(--vp-c-brand-soft);
  box-shadow: 0 12px 30px rgb(0 0 0 / 6%);
  transform: translateY(-2px);
}

.card:focus,
.card:focus-visible {
  border-color: var(--vp-c-divider);
  box-shadow: none;
  outline: none;
  transform: none;
}

.illustration {
  display: flex;
  aspect-ratio: 1 / 1;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--vp-c-divider);
  background: #fafaf7;
}

.illustration img {
  display: block;
  width: 100%;
  height: 100%;
}

.body {
  min-height: 156px;
  padding: 17px 20px 21px;
}

.body h3 {
  margin: 0 0 7px;
  color: var(--vp-c-text-1);
  font-size: 16px;
  font-weight: 650;
  line-height: 1.4;
}

.body p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.62;
}

@media (max-width: 960px) {
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .feature-gallery {
    margin: 4px 0 8px;
  }

  .group + .group {
    margin-top: 38px;
  }

  .grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }

  .body {
    min-height: 0;
    padding: 14px 17px 18px;
  }
}
</style>
