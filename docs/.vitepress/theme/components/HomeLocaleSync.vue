<script setup>
import { onMounted, watch } from 'vue';
import { useData, useRoute } from 'vitepress';
import { contentLocaleFromPath } from '../../content-locales';
import { useHomeLocale } from '../home-locale';

const route = useRoute();
const { site } = useData();
const { setHomeLocale } = useHomeLocale();

function syncLocaleFromRoute() {
  const locale = contentLocaleFromPath(route.path, site.value.base);
  setHomeLocale(locale, { persist: false });
}

onMounted(syncLocaleFromRoute);
watch(() => route.path, syncLocaleFromRoute);
</script>

<template></template>
