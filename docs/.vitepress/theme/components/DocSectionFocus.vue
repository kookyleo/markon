<script setup>
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute } from 'vitepress';
import {
  buildHeadingSections,
  clearHeadingFocus,
  focusHeading,
  navigateHeadings,
  unwrapHeadingSections,
} from '../section-focus';

const route = useRoute();

let root = null;
let headings = [];

const OUTLINE_LINK_SELECTOR = [
  '.VPDocAsideOutline a.outline-link[href^="#"]',
  '.VPLocalNavOutlineDropdown a.outline-link[href^="#"]',
].join(', ');

function contentRoot() {
  if (document.querySelector('.VPHome')) return null;
  return document.querySelector('.VPDoc .vp-doc > div');
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function isIgnoredClick(target) {
  return Boolean(target.closest('a, button, input, textarea, select, details, .DocSearch'));
}

function clearOutlineFocus() {
  document.querySelectorAll('.markon-outline-focused').forEach(link => {
    link.classList.remove('markon-outline-focused');
    link.removeAttribute('aria-current');
  });
}

function syncOutlineFocus(heading) {
  clearOutlineFocus();
  if (!(heading instanceof HTMLElement) || !heading.id) return;

  for (const link of document.querySelectorAll(OUTLINE_LINK_SELECTOR)) {
    if (!(link instanceof HTMLAnchorElement)) continue;
    let id = link.hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Keep the raw fragment when it is not valid percent-encoded text.
    }
    if (id !== heading.id) continue;
    link.classList.add('markon-outline-focused');
    link.setAttribute('aria-current', 'location');
    link.scrollIntoView({ block: 'nearest' });
  }
}

function focusDocHeading(heading, options) {
  if (!focusHeading(heading, options)) return false;
  syncOutlineFocus(heading);
  return true;
}

function clearDocFocus() {
  const cleared = clearHeadingFocus(root || document);
  clearOutlineFocus();
  return cleared;
}

function headingAtPointer(target, clientY) {
  const direct = target.closest('h1, h2, h3, h4, h5, h6');
  if (direct && root?.contains(direct)) return direct;

  const clickY = clientY + window.scrollY;
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    if (heading.getBoundingClientRect().top + window.scrollY <= clickY) return heading;
  }
  return null;
}

function onContentClick(event) {
  const target = event.target;
  if (!(target instanceof Element) || !root?.contains(target) || isIgnoredClick(target)) return;
  const heading = headingAtPointer(target, event.clientY);
  if (heading) focusDocHeading(heading);
}

function onTocClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest(OUTLINE_LINK_SELECTOR);
  if (!(link instanceof HTMLAnchorElement)) return;

  let id = link.hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep the raw fragment when it is not valid percent-encoded text.
  }

  const heading = document.getElementById(id);
  if (heading instanceof HTMLElement && root?.contains(heading)) focusDocHeading(heading);
}

function onOutsidePointer(event) {
  const target = event.target;
  if (!(target instanceof Element) || !root || root.contains(target)) return;
  if (target.closest('.VPDocAsideOutline, .VPLocalNavOutlineDropdown')) return;
  clearDocFocus();
}

function onKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (isTypingTarget(event.target)) return;
  if (document.querySelector('.VPHome, .home-help-panel, .markon-locale-menu')) return;

  if (event.key === 'Escape') {
    if (clearDocFocus() > 0) event.preventDefault();
    return;
  }

  const key = event.key.toLowerCase();
  if (key !== 'j' && key !== 'k') return;
  if (!headings.length) return;
  event.preventDefault();
  const heading = navigateHeadings(headings, key === 'j' ? 'next' : 'prev');
  if (heading) syncOutlineFocus(heading);
}

function teardown() {
  if (root) {
    clearDocFocus();
    root.removeEventListener('click', onContentClick);
    unwrapHeadingSections(root);
  }
  root = null;
  headings = [];
}

function build() {
  teardown();
  root = contentRoot();
  if (!root) return;
  buildHeadingSections(root);
  headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  root.addEventListener('click', onContentClick);
}

async function rebuild() {
  teardown();
  await nextTick();
  requestAnimationFrame(build);
}

onMounted(() => {
  build();
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onTocClick);
  document.addEventListener('mousedown', onOutsidePointer);
  document.addEventListener('touchstart', onOutsidePointer, { passive: true });
});

watch(() => route.path, rebuild);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('click', onTocClick);
  document.removeEventListener('mousedown', onOutsidePointer);
  document.removeEventListener('touchstart', onOutsidePointer);
  teardown();
});
</script>

<template></template>
