<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, withBase } from 'vitepress';
import { useHomeLocale } from '../home-locale';

const { locale } = useHomeLocale();
const route = useRoute();
const isOpen = ref(false);
const currentItemIndex = ref(-1);
const closeButton = ref(null);

const COPY = {
  zh: {
    homeTitle: '首页导览与快捷键',
    docsTitle: '文档站功能与快捷键',
    close: '关闭',
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
          { keys: ['/'], label: '打开文档搜索' },
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
          { keys: ['/'], label: '打开文档搜索' },
          { keys: ['⌘ K', 'Ctrl K'], label: '打开文档搜索' },
          { keys: ['h'], label: '返回首页' },
          { keys: ['g'], label: '快速上手' },
          { keys: ['f'], label: '功能介绍' },
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
          { keys: ['/'], label: 'Open documentation search' },
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
          { keys: ['/'], label: 'Open documentation search' },
          { keys: ['⌘ K', 'Ctrl K'], label: 'Open documentation search' },
          { keys: ['h'], label: 'Home' },
          { keys: ['g'], label: 'Getting started' },
          { keys: ['f'], label: 'Feature guide' },
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
          { keys: ['/'], label: 'ドキュメント検索を開く' },
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
          { keys: ['/'], label: 'ドキュメント検索を開く' },
          { keys: ['⌘ K', 'Ctrl K'], label: 'ドキュメント検索を開く' },
          { keys: ['h'], label: 'ホームへ戻る' },
          { keys: ['g'], label: 'クイックスタート' },
          { keys: ['f'], label: '機能紹介' },
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
const panelGroups = computed(() => isHome.value ? copy.value.homeGroups : copy.value.docsGroups);

function isHomePage() {
  return Boolean(document.querySelector('.VPHome'));
}

function homeItems() {
  const hero = document.querySelector('.VPHero.has-image .main');
  const cards = [...document.querySelectorAll('[data-feature-card]')];
  const downloads = document.querySelector('.markon-home-download-section');
  return [hero, ...cards, downloads].filter(item => item instanceof HTMLElement);
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function clearCurrentItem() {
  const activeItem = document.activeElement;
  if (activeItem instanceof HTMLElement) activeItem.blur();
  document.querySelectorAll('.home-shortcut-current').forEach(item => {
    item.classList.remove('home-shortcut-current');
  });
}

function selectHomeItem(delta) {
  const items = homeItems();
  if (!items.length) return;
  if (currentItemIndex.value < 0) {
    currentItemIndex.value = delta > 0 ? 0 : items.length - 1;
  } else {
    currentItemIndex.value = (currentItemIndex.value + delta + items.length) % items.length;
  }
  clearCurrentItem();
  const item = items[currentItemIndex.value];
  item.classList.add('home-shortcut-current');
  if (!item.hasAttribute('tabindex')) item.setAttribute('tabindex', '-1');
  item.focus({ preventScroll: true });
  item.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  const href = withBase(path);
  const target = document.querySelector(`a[href="${href}"]`);
  if (target instanceof HTMLElement) target.click();
  else window.location.assign(href);
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
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;

  if (isOpen.value) {
    if (event.key === 'Escape' || event.key === '?') {
      event.preventDefault();
      closeHelp();
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
    selectHomeItem(1);
  } else if (key === 'k') {
    event.preventDefault();
    selectHomeItem(-1);
  } else if (event.key === 'Enter' && currentItemIndex.value >= 0) {
    event.preventDefault();
    openCurrentItem();
  } else if (key === 'g') {
    event.preventDefault();
    clickTarget(`.VPHero a[href="${withBase('/guide/getting-started')}"]`);
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

onMounted(() => {
  isHome.value = isHomePage();
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('focusin', onFocusIn);
});

watch(() => route.path, async () => {
  closeHelp();
  currentItemIndex.value = -1;
  await nextTick();
  clearCurrentItem();
  isHome.value = isHomePage();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('focusin', onFocusIn);
  clearCurrentItem();
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
                <kbd v-for="key in row.keys" :key="key">{{ key }}</kbd>
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
  width: min(680px, 100%);
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
  grid-template-columns: 88px 1fr;
  min-height: 38px;
  align-items: center;
  gap: 12px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.home-help-keys {
  display: flex;
  gap: 5px;
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
