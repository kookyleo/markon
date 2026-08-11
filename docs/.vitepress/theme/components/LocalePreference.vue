<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useData, useRoute, useRouter } from 'vitepress';
import {
  canonicalContentPath,
  contentLocaleFromPath,
  localizedContentPath,
} from '../../content-locales';
import { useHomeLocale } from '../home-locale';

const props = defineProps({
  mobile: { type: Boolean, default: false },
});

const { initializeHomeLocale, setHomeLocale } = useHomeLocale();
const route = useRoute();
const router = useRouter();
const { site, theme } = useData();
const isOpen = ref(false);
const root = ref(null);
const routeLocale = computed(() => contentLocaleFromPath(route.path, site.value.base));
const canonicalRoute = computed(() => canonicalContentPath(route.path, site.value.base));

const OPTIONS = [
  { value: 'en', short: 'EN', label: 'English' },
  { value: 'zh', short: '中', label: '简体中文' },
  { value: 'ja', short: '日', label: '日本語' },
];

const current = computed(() => OPTIONS.find(option => option.value === routeLocale.value) || OPTIONS[0]);

function isAvailable(value) {
  if (value === 'en') return true;
  return Boolean(theme.value.markonContentLocales?.[canonicalRoute.value]?.[value]);
}

async function choose(value) {
  if (value === routeLocale.value) {
    isOpen.value = false;
    return;
  }
  setHomeLocale(value);
  isOpen.value = false;
  const target = localizedContentPath(
    route.path,
    value,
    theme.value.markonContentLocales,
    site.value.base,
  );
  const resolvedLocale = contentLocaleFromPath(target, site.value.base);
  if (resolvedLocale !== value) setHomeLocale(resolvedLocale, { persist: false });
  if (target !== route.path) await router.go(target);
}

function onDocumentClick(event) {
  if (root.value && !root.value.contains(event.target)) isOpen.value = false;
}

function onKeydown(event) {
  if (event.key === 'Escape') isOpen.value = false;
}

onMounted(() => {
  initializeHomeLocale();
  document.addEventListener('click', onDocumentClick);
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    ref="root"
    class="markon-locale"
    :class="{ 'markon-locale-mobile': mobile }"
  >
    <button
      type="button"
      class="markon-locale-trigger"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      @click.stop="isOpen = !isOpen"
    >
      <span class="vpi-languages markon-locale-icon" aria-hidden="true"></span>
      <span>{{ current.short }}</span>
      <span class="markon-locale-chevron" aria-hidden="true">⌄</span>
    </button>
    <div v-if="isOpen" class="markon-locale-menu" role="menu">
      <button
        v-for="option in OPTIONS"
        :key="option.value"
        type="button"
        role="menuitemradio"
        :disabled="!isAvailable(option.value)"
        :aria-disabled="!isAvailable(option.value)"
        :aria-checked="option.value === routeLocale"
        :class="{ active: option.value === routeLocale }"
        @click="choose(option.value)"
      >
        <span>{{ option.label }}</span>
        <span aria-hidden="true">{{ option.value === routeLocale ? '✓' : '' }}</span>
      </button>
    </div>
  </div>
</template>
