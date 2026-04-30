<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const REPO = 'kookyleo/markon';
const STORAGE_KEY = 'markon-docs-feedback-offset';

const show = ref(false);
const pos = ref({ x: 0, y: 0 });
let selectedText = '';

// Persisted user-applied offset, in CSS pixels relative to the auto-placed
// position (selection rect's right edge). Survives reloads and applies to
// every subsequent popover until the user drags it again.
const offset = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (v && typeof v.dx === 'number' && typeof v.dy === 'number') return { dx: v.dx, dy: v.dy };
  } catch {}
  return { dx: 0, dy: 0 };
})();

let dragging = false;
let dragBaseX = 0, dragBaseY = 0;
let dragStartMouseX = 0, dragStartMouseY = 0;
let dragAutoX = 0, dragAutoY = 0;

function onMouseUp(e) {
  // The drag's terminating mouseup also bubbles to document — ignore it so
  // we don't immediately re-anchor to the (still-live) selection rect.
  if (dragging) return;
  // Mouseups inside the popover itself (including the drag handle) shouldn't
  // re-trigger placement.
  if (e.target.closest && e.target.closest('.selection-feedback-popover')) return;

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
    x: rect.right + 6 + offset.dx,
    y: rect.top + window.scrollY + offset.dy,
  };
  show.value = true;
}

function onMouseDown(e) {
  if (e.target.closest && e.target.closest('.selection-feedback-popover')) return;
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

function onHandleDown(e) {
  // preventDefault keeps the user's text selection alive across the drag,
  // and stopPropagation keeps onMouseDown from hiding the popover.
  e.preventDefault();
  e.stopPropagation();
  dragging = true;
  dragStartMouseX = e.pageX;
  dragStartMouseY = e.pageY;
  dragBaseX = pos.value.x;
  dragBaseY = pos.value.y;
  dragAutoX = dragBaseX - offset.dx;
  dragAutoY = dragBaseY - offset.dy;
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onHandleMove);
  document.addEventListener('mouseup', onHandleUp);
}

function onHandleMove(e) {
  if (!dragging) return;
  const dx = e.pageX - dragStartMouseX;
  const dy = e.pageY - dragStartMouseY;
  pos.value = { x: dragBaseX + dx, y: dragBaseY + dy };
}

function onHandleUp() {
  if (!dragging) return;
  offset.dx = pos.value.x - dragAutoX;
  offset.dy = pos.value.y - dragAutoY;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ dx: offset.dx, dy: offset.dy }));
  } catch {}
  document.body.style.userSelect = '';
  document.removeEventListener('mousemove', onHandleMove);
  document.removeEventListener('mouseup', onHandleUp);
  // Listeners on `document` fire in registration order: onMouseUp (added in
  // onMounted) runs first and bails on `dragging`, then onHandleUp runs and
  // clears the flag. So a synchronous flip is correct here.
  dragging = false;
}

onMounted(() => {
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('mousedown', onMouseDown);
});
onUnmounted(() => {
  document.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('mousedown', onMouseDown);
  document.removeEventListener('mousemove', onHandleMove);
  document.removeEventListener('mouseup', onHandleUp);
});
</script>

<template>
  <Teleport to="body">
    <span
      v-if="show"
      class="selection-feedback-popover"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
    >
      <span
        class="drag-handle"
        title="拖动以调整位置"
        @mousedown="onHandleDown"
      ></span>
      <button
        class="selection-feedback-btn"
        title="Report issue with selected text"
        @click="submit"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/></svg>
        <span>Report Issue</span>
      </button>
    </span>
  </Teleport>
</template>

<style scoped>
.selection-feedback-popover {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  z-index: 999;
  padding: 2px;
  background: #ffd43b;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  white-space: nowrap;
}
.drag-handle {
  display: inline-block;
  position: relative;
  width: 8px;
  height: 18px;
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.drag-handle::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 12px;
  background: #744d00;
  border-radius: 1px;
  transition: background 0.15s;
}
.drag-handle:hover::before {
  background: #3d2d00;
}
.drag-handle:active {
  cursor: grabbing;
}
.selection-feedback-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 12px;
  line-height: 1.4;
  color: #744d00;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.15s;
}
.selection-feedback-btn:hover {
  opacity: 0.85;
}
</style>
