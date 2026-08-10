<script setup>
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute } from 'vitepress';

const route = useRoute();
const desktopQuery = '(min-width: 960px)';
const desktopLogoHeightRatio = 0.9;

let hero = null;
let main = null;
let media = null;
let observer = null;

function clearSyncedSize() {
  hero?.style.removeProperty('--markon-hero-logo-width');
  hero?.style.removeProperty('--markon-hero-logo-height');
}

function syncLogoSize() {
  if (!hero || !main || !media?.matches) {
    clearSyncedSize();
    return;
  }

  const height = Math.round(
    main.getBoundingClientRect().height * desktopLogoHeightRatio * 1000,
  ) / 1000;
  if (height <= 0) return;

  hero.style.setProperty('--markon-hero-logo-height', `${height}px`);
  hero.style.setProperty('--markon-hero-logo-width', `${height * 7 / 6}px`);
}

async function bindHero() {
  await nextTick();
  observer?.disconnect();
  clearSyncedSize();

  hero = document.querySelector('.VPHero.has-image');
  main = hero?.querySelector('.main') ?? null;
  if (!hero || !main) return;

  observer?.observe(main);
  syncLogoSize();
}

function handleBreakpointChange() {
  syncLogoSize();
}

onMounted(() => {
  media = window.matchMedia(desktopQuery);
  observer = new ResizeObserver(syncLogoSize);
  media.addEventListener('change', handleBreakpointChange);
  void bindHero();
});

watch(() => route.path, () => {
  void bindHero();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  media?.removeEventListener('change', handleBreakpointChange);
  clearSyncedSize();
});
</script>

<template></template>
