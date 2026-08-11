<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useData, useRoute } from 'vitepress';
import { contentLocaleFromPath, localizedContentPath } from '../../content-locales';
import {
  clearHeadingFocus,
  navigateHeadings,
} from '../section-focus';

const route = useRoute();
const { site, theme } = useData();
const locale = computed(() => contentLocaleFromPath(route.path, site.value.base));
const primaryModifier = ref('Ctrl');
const canGoBack = ref(false);
const canGoForward = ref(false);
const isOpen = ref(false);
const currentItemIndex = ref(-1);
const closeButton = ref(null);

const COPY = {
  zh: {
    homeTitle: '首页导览与快捷键',
    docsTitle: '文档站功能与快捷键',
    close: '关闭',
    or: '或',
    back: '后退',
    forward: '前进',
    homeGroups: [
      {
        title: '浏览',
        rows: [
          { keys: ['j'], label: '下一项首页内容' },
          { keys: ['k'], label: '上一项首页内容' },
          { keys: ['Enter'], label: '打开当前项' },
        ],
      },
      {
        title: '前往',
        rows: [
          { keys: ['/', 'Mod K'], alternatives: true, label: '打开文档搜索' },
          { keys: ['g'], label: '快速上手' },
          { keys: ['f'], label: '功能介绍' },
          { keys: ['d'], label: '下载 Markon' },
          { keys: ['?'], label: '显示本面板' },
        ],
      },
    ],
    docsGroups: [
      {
        title: '本站',
        rows: [
          { keys: ['/', 'Mod K'], alternatives: true, label: '打开文档搜索' },
          { keys: ['h'], label: '返回首页' },
          { keys: ['g'], label: '快速上手' },
          { keys: ['f'], label: '功能介绍' },
          { keys: ['j', 'k'], label: '下一 / 上一章节' },
        ],
      },
      {
        title: '帮助',
        rows: [
          { keys: ['?'], label: '显示本面板' },
          { keys: ['Esc'], label: '关闭本面板' },
        ],
      },
    ],
  },
  en: {
    homeTitle: 'Home navigation & shortcuts',
    docsTitle: 'Documentation functions & shortcuts',
    close: 'Close',
    or: 'or',
    back: 'Back',
    forward: 'Forward',
    homeGroups: [
      {
        title: 'Browse',
        rows: [
          { keys: ['j'], label: 'Next home item' },
          { keys: ['k'], label: 'Previous home item' },
          { keys: ['Enter'], label: 'Open the current item' },
        ],
      },
      {
        title: 'Go to',
        rows: [
          { keys: ['/', 'Mod K'], alternatives: true, label: 'Open documentation search' },
          { keys: ['g'], label: 'Getting started' },
          { keys: ['f'], label: 'Feature tour' },
          { keys: ['d'], label: 'Download Markon' },
          { keys: ['?'], label: 'Show this panel' },
        ],
      },
    ],
    docsGroups: [
      {
        title: 'Site',
        rows: [
          { keys: ['/', 'Mod K'], alternatives: true, label: 'Open documentation search' },
          { keys: ['h'], label: 'Home' },
          { keys: ['g'], label: 'Getting started' },
          { keys: ['f'], label: 'Feature guide' },
          { keys: ['j', 'k'], label: 'Next / previous section' },
        ],
      },
      {
        title: 'Help',
        rows: [
          { keys: ['?'], label: 'Show this panel' },
          { keys: ['Esc'], label: 'Close this panel' },
        ],
      },
    ],
  },
  ja: {
    homeTitle: 'ホームのナビゲーションとショートカット',
    docsTitle: 'ドキュメントの機能とショートカット',
    close: '閉じる',
    or: 'または',
    back: '戻る',
    forward: '進む',
    homeGroups: [
      {
        title: '閲覧',
        rows: [
          { keys: ['j'], label: '次のホーム項目' },
          { keys: ['k'], label: '前のホーム項目' },
          { keys: ['Enter'], label: '選択中の項目を開く' },
        ],
      },
      {
        title: '移動',
        rows: [
          { keys: ['/', 'Mod K'], alternatives: true, label: 'ドキュメント検索を開く' },
          { keys: ['g'], label: 'クイックスタート' },
          { keys: ['f'], label: '機能紹介' },
          { keys: ['d'], label: 'Markon をダウンロード' },
          { keys: ['?'], label: 'このパネルを表示' },
        ],
      },
    ],
    docsGroups: [
      {
        title: 'サイト',
        rows: [
          { keys: ['/', 'Mod K'], alternatives: true, label: 'ドキュメント検索を開く' },
          { keys: ['h'], label: 'ホームへ戻る' },
          { keys: ['g'], label: 'クイックスタート' },
          { keys: ['f'], label: '機能紹介' },
          { keys: ['j', 'k'], label: '次 / 前のセクション' },
        ],
      },
      {
        title: 'ヘルプ',
        rows: [
          { keys: ['?'], label: 'このパネルを表示' },
          { keys: ['Esc'], label: 'このパネルを閉じる' },
        ],
      },
    ],
  },
};

const copy = computed(() => COPY[locale.value]);
const isHome = ref(false);
const panelTitle = computed(() => isHome.value ? copy.value.homeTitle : copy.value.docsTitle);
const historyRows = computed(() => [
  canGoBack.value ? { keys: ['History Back'], label: copy.value.back } : null,
  canGoForward.value ? { keys: ['History Forward'], label: copy.value.forward } : null,
].filter(Boolean));
const panelGroups = computed(() => {
  const groups = isHome.value ? copy.value.homeGroups : copy.value.docsGroups;
  if (!historyRows.value.length) return groups;
  const navigationGroup = isHome.value ? 1 : 0;
  return groups.map((group, index) => index === navigationGroup
    ? { ...group, rows: [...group.rows, ...historyRows.value] }
    : group);
});

const HISTORY_INDEX_KEY = '__markonDocsHistoryIndex';
let historyIndex = 0;
let furthestHistoryIndex = 0;
let traversingHistory = false;

function isHomePage() {
  return Boolean(document.querySelector('.VPHome'));
}

function platformModifier() {
  const platform = navigator.userAgentData?.platform
    || navigator.platform
    || navigator.userAgent
    || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘' : 'Ctrl';
}

function displayKey(key) {
  if (key === 'Mod K') return `${primaryModifier.value} K`;
  if (key === 'History Back') return primaryModifier.value === '⌘' ? '⌘ [' : 'Alt ←';
  if (key === 'History Forward') return primaryModifier.value === '⌘' ? '⌘ ]' : 'Alt →';
  return key;
}

function updateHistoryAvailability() {
  const navigationApi = window.navigation;
  if (navigationApi && typeof navigationApi.canGoBack === 'boolean') {
    canGoBack.value = navigationApi.canGoBack;
    canGoForward.value = navigationApi.canGoForward;
    return;
  }
  canGoBack.value = historyIndex > 0;
  canGoForward.value = historyIndex < furthestHistoryIndex;
}

function replaceHistoryIndex(index) {
  history.replaceState(
    { ...(history.state || {}), [HISTORY_INDEX_KEY]: index },
    '',
  );
}

function initializeHistoryTracking() {
  const existing = Number(history.state?.[HISTORY_INDEX_KEY]);
  historyIndex = Number.isInteger(existing) ? existing : 0;
  furthestHistoryIndex = historyIndex;
  if (!Number.isInteger(existing)) replaceHistoryIndex(historyIndex);
  updateHistoryAvailability();
}

function recordRouteNavigation() {
  const existing = Number(history.state?.[HISTORY_INDEX_KEY]);
  if (traversingHistory && Number.isInteger(existing)) {
    historyIndex = existing;
  } else {
    historyIndex += 1;
    furthestHistoryIndex = historyIndex;
    replaceHistoryIndex(historyIndex);
  }
  traversingHistory = false;
  requestAnimationFrame(updateHistoryAvailability);
}

function onPopState() {
  traversingHistory = true;
  requestAnimationFrame(updateHistoryAvailability);
}

function historyShortcutDirection(event) {
  if (primaryModifier.value === '⌘') {
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key === '[') return 'back';
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key === ']') return 'forward';
    return null;
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowLeft') return 'back';
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowRight') return 'forward';
  return null;
}

function homeItems() {
  const hero = document.querySelector('.VPHero.has-image .main');
  const cards = [...document.querySelectorAll('[data-feature-card]')];
  const downloads = document.querySelector('.markon-home-download-section');
  return [hero, ...cards, downloads].filter(item => item instanceof HTMLElement);
}

function homeHeading(item) {
  if (!(item instanceof HTMLElement)) return null;
  if (item.matches('.VPHero .main')) return item.querySelector('h1, .name');
  if (item.matches('[data-feature-card]')) return item.querySelector('h3');
  if (item.matches('.markon-home-download-section')) return item.querySelector('h2');
  return null;
}

function prepareHomeSections() {
  for (const item of homeItems()) {
    item.classList.add('heading-section', 'home-heading-section');
    const heading = homeHeading(item);
    if (heading instanceof HTMLElement) heading.classList.add('home-section-heading');
  }
}

function cleanupHomeSections() {
  clearHeadingFocus();
  document.querySelectorAll('.home-heading-section').forEach(item => {
    item.classList.remove('heading-section', 'home-heading-section');
    item.removeAttribute('tabindex');
  });
  document.querySelectorAll('.home-section-heading').forEach(heading => {
    heading.classList.remove('home-section-heading');
  });
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function clearCurrentItem() {
  clearHeadingFocus();
  currentItemIndex.value = -1;
}

function selectHomeItem(direction) {
  const items = homeItems();
  if (!items.length) return;
  prepareHomeSections();
  const headings = items.map(homeHeading).filter(heading => heading instanceof HTMLElement);
  const heading = navigateHeadings(headings, direction);
  if (!heading) return;
  const item = heading.closest('.home-heading-section');
  currentItemIndex.value = items.indexOf(item);
  if (!(item instanceof HTMLElement)) return;
  if (!item.hasAttribute('tabindex')) item.setAttribute('tabindex', '-1');
  item.focus({ preventScroll: true });
}

function openCurrentItem() {
  const item = homeItems()[currentItemIndex.value];
  if (!(item instanceof HTMLElement)) return;
  if (item.matches('.VPHero .main')) {
    clickTarget('.VPHero .actions .VPButton.brand');
  } else if (item.matches('.markon-home-download-section')) {
    clickTarget('.markon-dl-primary');
  } else {
    item.click();
  }
}

function clickTarget(selector) {
  const target = document.querySelector(selector);
  if (target instanceof HTMLElement) target.click();
}

function scrollTarget(selector) {
  const target = document.querySelector(selector);
  if (target instanceof HTMLElement) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function navigate(path) {
  const href = localeHref(path);
  const target = document.querySelector(`a[href="${href}"]`);
  if (target instanceof HTMLElement) target.click();
  else window.location.assign(href);
}

function localeHref(path) {
  return localizedContentPath(
    path,
    locale.value,
    theme.value.markonContentLocales,
    site.value.base,
  );
}

async function openHelp() {
  isOpen.value = true;
  await nextTick();
  closeButton.value?.focus();
}

function closeHelp() {
  isOpen.value = false;
}

function onKeydown(event) {
  if (isTypingTarget(event.target)) return;

  const historyDirection = historyShortcutDirection(event);
  const canTraverse = historyDirection === 'back' ? canGoBack.value : canGoForward.value;
  if (historyDirection) {
    if (canTraverse) {
      event.preventDefault();
      closeHelp();
      historyDirection === 'back' ? history.back() : history.forward();
    }
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (isOpen.value) {
    if (event.key === 'Escape' || event.key === '?') {
      event.preventDefault();
      closeHelp();
    }
    return;
  }

  if (event.key === 'Escape' && isHomePage()) {
    if (currentItemIndex.value >= 0) {
      event.preventDefault();
      clearCurrentItem();
    }
    return;
  }

  if (event.key === '?') {
    event.preventDefault();
    openHelp();
    return;
  }

  const key = event.key.toLowerCase();
  if (event.key === '/') {
    event.preventDefault();
    clickTarget('.VPNavBarSearch .DocSearch-Button, .VPNavBarSearch button');
  } else if (!isHomePage() && key === 'h') {
    event.preventDefault();
    navigate('/');
  } else if (!isHomePage() && key === 'g') {
    event.preventDefault();
    navigate('/guide/getting-started');
  } else if (!isHomePage() && key === 'f') {
    event.preventDefault();
    navigate('/features/');
  } else if (!isHomePage()) {
    return;
  } else if (key === 'j') {
    event.preventDefault();
    selectHomeItem('next');
  } else if (key === 'k') {
    event.preventDefault();
    selectHomeItem('prev');
  } else if (event.key === 'Enter' && currentItemIndex.value >= 0) {
    event.preventDefault();
    openCurrentItem();
  } else if (key === 'g') {
    event.preventDefault();
    clickTarget(`.VPHero a[href="${localeHref('/guide/getting-started')}"]`);
  } else if (key === 'f') {
    event.preventDefault();
    scrollTarget('.feature-gallery');
  } else if (key === 'd') {
    event.preventDefault();
    scrollTarget('#downloads');
  }
}

function onFocusIn(event) {
  if (!(event.target instanceof Element)) return;
  const index = homeItems().findIndex(item => item === event.target || item.contains(event.target));
  if (index >= 0) currentItemIndex.value = index;
}

function onHomeOutsidePointer(event) {
  if (!isHomePage() || currentItemIndex.value < 0) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest('.home-heading-section')) return;
  clearCurrentItem();
}

onMounted(() => {
  primaryModifier.value = platformModifier();
  initializeHistoryTracking();
  isHome.value = isHomePage();
  if (isHome.value) requestAnimationFrame(prepareHomeSections);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('popstate', onPopState);
  window.navigation?.addEventListener('currententrychange', updateHistoryAvailability);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('mousedown', onHomeOutsidePointer);
  document.addEventListener('touchstart', onHomeOutsidePointer, { passive: true });
});

watch(() => route.path, async () => {
  closeHelp();
  cleanupHomeSections();
  currentItemIndex.value = -1;
  await nextTick();
  isHome.value = isHomePage();
  if (isHome.value) requestAnimationFrame(prepareHomeSections);
  recordRouteNavigation();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('popstate', onPopState);
  window.navigation?.removeEventListener('currententrychange', updateHistoryAvailability);
  document.removeEventListener('focusin', onFocusIn);
  document.removeEventListener('mousedown', onHomeOutsidePointer);
  document.removeEventListener('touchstart', onHomeOutsidePointer);
  cleanupHomeSections();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="home-help-backdrop" role="presentation" @click.self="closeHelp">
      <section class="home-help-panel" role="dialog" aria-modal="true" :aria-label="panelTitle">
        <header class="home-help-header">
          <h2>{{ panelTitle }}</h2>
          <button ref="closeButton" type="button" :aria-label="copy.close" @click="closeHelp">×</button>
        </header>
        <div class="home-help-grid">
          <section v-for="group in panelGroups" :key="group.title" class="home-help-group">
            <h3>{{ group.title }}</h3>
            <div v-for="row in group.rows" :key="row.label" class="home-help-row">
              <span class="home-help-keys">
                <template v-for="(key, index) in row.keys" :key="key">
                  <span v-if="row.alternatives && index > 0" class="home-help-or">{{ copy.or }}</span>
                  <kbd>{{ displayKey(key) }}</kbd>
                </template>
              </span>
              <span>{{ row.label }}</span>
            </div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.home-help-backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(15 24 18 / 32%);
  backdrop-filter: blur(4px);
}

.home-help-panel {
  width: min(760px, 100%);
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-elv);
  box-shadow: 0 24px 70px rgb(0 0 0 / 18%);
  color: var(--vp-c-text-1);
}

.home-help-header {
  display: flex;
  min-height: 68px;
  align-items: center;
  justify-content: space-between;
  padding: 0 22px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.home-help-header h2 {
  margin: 0;
  border: 0;
  font-size: 19px;
  font-weight: 650;
}

.home-help-header button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 25px;
  cursor: pointer;
}

.home-help-header button:hover {
  background: var(--vp-c-default-soft);
}

.home-help-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 34px;
  padding: 25px 28px 30px;
}

.home-help-group h3 {
  margin: 0 0 13px;
  color: var(--vp-c-text-3);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.home-help-row {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr);
  min-height: 38px;
  align-items: center;
  gap: 12px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.home-help-keys {
  display: flex;
  align-items: center;
  gap: 5px;
}

.home-help-or {
  color: var(--vp-c-text-3);
  font-size: 11px;
  line-height: 1;
}

.home-help-row kbd {
  min-width: 30px;
  padding: 3px 7px;
  border: 1px solid var(--vp-c-divider);
  border-bottom-width: 2px;
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 600px) {
  .home-help-grid {
    grid-template-columns: 1fr;
    gap: 22px;
  }
}
</style>
