<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const REPO = 'kookyleo/markon';
const show = ref(false);
const pos = ref({ x: 0, y: 0 });
let selectedText = '';

function onMouseUp() {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text || text.length < 2) {
    show.value = false;
    return;
  }
  selectedText = text;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  pos.value = {
    x: rect.right + 6,
    y: rect.top + window.scrollY,
  };
  show.value = true;
}

function onMouseDown(e) {
  if (e.target.closest('.selection-feedback-btn')) return;
  show.value = false;
}

function submit() {
  const page = location.pathname + location.hash;
  const title = `Docs feedback: "${selectedText.slice(0, 60)}${selectedText.length > 60 ? '…' : ''}"`;
  const body = `**Page:** ${location.href}\n\n**Selected text:**\n> ${selectedText}\n\n**Feedback:**\n`;
  const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=docs`;
  window.open(url, '_blank');
  show.value = false;
}

onMounted(() => {
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('mousedown', onMouseDown);
});
onUnmounted(() => {
  document.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('mousedown', onMouseDown);
});
</script>

<template>
  <Teleport to="body">
    <button
      v-if="show"
      class="selection-feedback-btn"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      title="Report issue with selected text"
      @click="submit"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/></svg>
      <span>Report Issue</span>
    </button>
  </Teleport>
</template>

<style scoped>
.selection-feedback-btn {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  z-index: 999;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.4;
  color: #744d00;
  background: #ffd43b;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transition: opacity 0.15s;
}
.selection-feedback-btn:hover {
  opacity: 0.85;
}
</style>
