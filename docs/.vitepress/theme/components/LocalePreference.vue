<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useHomeLocale } from '../home-locale';

const props = defineProps({
  mobile: { type: Boolean, default: false },
});

const { locale, initializeHomeLocale, setHomeLocale } = useHomeLocale();
const isOpen = ref(false);
const root = ref(null);

const OPTIONS = [
  { value: 'en', short: 'EN', label: 'English' },
  { value: 'zh', short: '中', label: '简体中文' },
  { value: 'ja', short: '日', label: '日本語' },
];

const current = computed(() => OPTIONS.find(option => option.value === locale.value) || OPTIONS[0]);

function choose(value) {
  if (value === locale.value) {
    isOpen.value = false;
    return;
  }
  setHomeLocale(value);
  window.location.reload();
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
      <span class="markon-locale-icon" aria-hidden="true">
        <span>A</span><span>文</span>
      </span>
      <span>{{ current.short }}</span>
      <span class="markon-locale-chevron" aria-hidden="true">⌄</span>
    </button>
    <div v-if="isOpen" class="markon-locale-menu" role="menu">
      <button
        v-for="option in OPTIONS"
        :key="option.value"
        type="button"
        role="menuitemradio"
        :aria-checked="option.value === locale"
        :class="{ active: option.value === locale }"
        @click="choose(option.value)"
      >
        <span>{{ option.label }}</span>
        <span aria-hidden="true">{{ option.value === locale ? '✓' : '' }}</span>
      </button>
    </div>
  </div>
</template>
