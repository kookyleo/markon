<script setup>
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute } from 'vitepress';
import { HOME_SHELL_COPY } from '../home-copy';
import { useHomeLocale } from '../home-locale';

const route = useRoute();
const { locale, initializeHomeLocale } = useHomeLocale();
let observer;
let frame;

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function syncHomeCopy() {
  const copy = HOME_SHELL_COPY[locale.value];
  document.documentElement.lang = copy.htmlLang;

  document.querySelectorAll('.VPNavBarMenu .VPNavBarMenuLink').forEach((link, index) => {
    if (copy.topNav[index]) setText(link, copy.topNav[index]);
  });
  document.querySelectorAll('.VPNavScreenMenu .VPNavScreenMenuLink').forEach((link, index) => {
    if (copy.topNav[index]) setText(link, copy.topNav[index]);
  });

  if (!document.querySelector('.VPHome')) return;
  document.title = copy.title;

  const description = document.querySelector('meta[name="description"]');
  if (description?.getAttribute('content') !== copy.description) {
    description?.setAttribute('content', copy.description);
  }

  setText(document.querySelector('.markon-hero-declaration'), copy.declaration);
  setText(document.querySelector('.markon-hero-explainer'), copy.explainer);

  document.querySelectorAll('.VPHero .actions .VPButton').forEach((action, index) => {
    if (copy.actions[index]) setText(action, copy.actions[index]);
  });

  setText(document.querySelector('.markon-home-download-title'), copy.downloadsTitle);
  const downloadCopy = document.querySelector('.markon-home-download-copy');
  if (downloadCopy?.innerHTML !== copy.downloadsCopy) downloadCopy.innerHTML = copy.downloadsCopy;
}

function scheduleSync() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(syncHomeCopy);
}

onMounted(async () => {
  initializeHomeLocale();
  await nextTick();
  syncHomeCopy();
  observer = new MutationObserver(scheduleSync);
  observer.observe(document.body, { childList: true, subtree: true });
});

watch(locale, scheduleSync);
watch(() => route.path, async () => {
  await nextTick();
  syncHomeCopy();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
</script>

<template></template>
