<script setup>
import { computed, onMounted, ref } from 'vue';
import { useData } from 'vitepress';

const props = defineProps({
  // 'primary': big auto-detected button + collapsible others
  // 'all':     full per-OS list
  mode: { type: String, default: 'primary' },
});

const { theme } = useData();
const release = computed(() => theme.value.markonRelease);

const detected = ref(null);
onMounted(async () => { detected.value = await detectPlatform(); });

async function detectPlatform() {
  const ua = navigator.userAgent || '';
  let os = 'unknown';
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) os = 'macos';
  else if (/Windows/i.test(ua)) os = 'windows';
  else if (/Linux|X11/i.test(ua)) os = 'linux';

  let arch = 'unknown';
  if (navigator.userAgentData?.getHighEntropyValues) {
    try {
      const hi = await navigator.userAgentData.getHighEntropyValues(['architecture']);
      if (hi.architecture === 'arm') arch = 'arm64';
      else if (hi.architecture === 'x86') arch = 'x64';
    } catch { /* fall through */ }
  }
  if (arch === 'unknown') {
    if (/ARM64|aarch64|arm64/i.test(ua)) arch = 'arm64';
    else if (/x86_64|x64|WOW64|Win64|amd64/i.test(ua)) arch = 'x64';
    else if (os === 'macos') arch = guessMacArch();
    else arch = 'x64';
  }
  return { os, arch };
}

// Modern Macs default to Apple Silicon. The WebGL renderer string is the most
// reliable client-side hint; fall back to arm64 if it cannot be read.
function guessMacArch() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      const r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
      if (/Apple/i.test(r)) return 'arm64';
      if (/Intel/i.test(r)) return 'x64';
    }
  } catch { /* ignore */ }
  return 'arm64';
}

function pickPrimary(assets, os, arch) {
  const find = (...patterns) => assets.find(a => patterns.every(p => p.test(a.name)));
  if (os === 'macos') return arch === 'arm64' ? find(/\.dmg$/, /aarch64/) : find(/\.dmg$/, /(x86_64|x64)/);
  if (os === 'windows') return arch === 'arm64' ? find(/setup\.exe$/, /arm64/) : find(/setup\.exe$/, /x64/);
  if (os === 'linux') return arch === 'arm64' ? find(/\.AppImage$/, /aarch64/) : find(/\.AppImage$/, /amd64/);
  return null;
}

const primary = computed(() =>
  release.value && detected.value
    ? pickPrimary(release.value.assets, detected.value.os, detected.value.arch)
    : null,
);

const platformLabel = computed(() => {
  if (!detected.value) return '';
  const { os, arch } = detected.value;
  const o = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }[os] || '当前系统';
  const a = arch === 'arm64' ? (os === 'macos' ? 'Apple Silicon' : 'ARM64')
          : arch === 'x64'   ? (os === 'macos' ? 'Intel' : 'x64')
          : '';
  return a ? `${o} · ${a}` : o;
});

const grouped = computed(() => {
  if (!release.value) return [];
  const groups = {
    macos:   { label: 'macOS',   items: [] },
    windows: { label: 'Windows', items: [] },
    linux:   { label: 'Linux',   items: [] },
  };
  for (const a of release.value.assets) {
    if (/\.dmg$/.test(a.name)) {
      groups.macos.items.push({ ...a, variant: /aarch64/.test(a.name) ? 'Apple Silicon' : 'Intel' });
    } else if (/setup\.exe$/.test(a.name)) {
      groups.windows.items.push({ ...a, variant: /arm64/.test(a.name) ? 'ARM64' : 'x64' });
    } else if (/\.AppImage$/.test(a.name)) {
      groups.linux.items.push({ ...a, variant: /aarch64/.test(a.name) ? 'AppImage · arm64' : 'AppImage · amd64' });
    } else if (/\.deb$/.test(a.name)) {
      groups.linux.items.push({ ...a, variant: /aarch64|arm64/.test(a.name) ? 'deb · arm64' : 'deb · amd64' });
    }
  }
  return Object.values(groups).filter(g => g.items.length);
});

function formatBytes(n) {
  if (!n) return '';
  const mb = n / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

const showAll = ref(false);
</script>

<template>
  <div v-if="!release" class="markon-dl-fallback">
    <a href="https://github.com/kookyleo/markon/releases/latest" target="_blank" rel="noopener">
      在 GitHub Releases 查看所有版本 →
    </a>
  </div>

  <div v-else-if="mode === 'primary'" class="markon-dl">
    <a v-if="primary" :href="primary.url" class="markon-dl-primary">
      <span class="markon-dl-arrow">↓</span>
      <span class="markon-dl-stack">
        <span class="markon-dl-title">下载 Markon {{ release.version }}</span>
        <span class="markon-dl-meta">{{ platformLabel }} · {{ formatBytes(primary.size) }}</span>
      </span>
    </a>
    <a v-else :href="release.htmlUrl" class="markon-dl-primary" target="_blank" rel="noopener">
      <span class="markon-dl-arrow">↓</span>
      <span class="markon-dl-stack">
        <span class="markon-dl-title">下载 Markon {{ release.version }}</span>
        <span class="markon-dl-meta">{{ detected ? '当前系统未匹配 — 查看所有平台' : '检测中…' }}</span>
      </span>
    </a>
    <button class="markon-dl-toggle" @click="showAll = !showAll">
      {{ showAll ? '收起' : '其他平台 / 架构' }}
    </button>
    <div v-if="showAll" class="markon-dl-list">
      <div v-for="g in grouped" :key="g.label" class="markon-dl-group">
        <div class="markon-dl-group-label">{{ g.label }}</div>
        <ul>
          <li v-for="a in g.items" :key="a.name">
            <a :href="a.url">{{ a.variant }}</a>
            <span class="markon-dl-name">{{ a.name }}</span>
            <span class="markon-dl-size">{{ formatBytes(a.size) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>

  <div v-else class="markon-dl-list">
    <div v-for="g in grouped" :key="g.label" class="markon-dl-group">
      <div class="markon-dl-group-label">{{ g.label }}</div>
      <ul>
        <li v-for="a in g.items" :key="a.name">
          <a :href="a.url">{{ a.variant }}</a>
          <span class="markon-dl-name">{{ a.name }}</span>
          <span class="markon-dl-size">{{ formatBytes(a.size) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.markon-dl { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; margin: 16px 0 24px; }
.markon-dl-primary {
  display: inline-flex; align-items: center; gap: 14px;
  padding: 14px 22px; border-radius: 12px;
  background: var(--vp-c-brand-1); color: var(--vp-c-white) !important;
  text-decoration: none !important; transition: background 0.15s;
}
.markon-dl-primary:hover { background: var(--vp-c-brand-2); }
.markon-dl-arrow { font-size: 24px; line-height: 1; }
.markon-dl-stack { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.3; }
.markon-dl-title { font-size: 16px; font-weight: 600; }
.markon-dl-meta { font-size: 12px; opacity: 0.85; }

.markon-dl-toggle {
  background: none; border: none; padding: 4px 8px;
  font-size: 13px; color: var(--vp-c-text-2); cursor: pointer;
}
.markon-dl-toggle:hover { color: var(--vp-c-brand-1); }

.markon-dl-list { width: 100%; }
.markon-dl-group { margin-top: 12px; }
.markon-dl-group-label { font-weight: 600; margin-bottom: 6px; color: var(--vp-c-text-1); }
.markon-dl-group ul { list-style: none; padding: 0; margin: 0; }
.markon-dl-group li { display: flex; align-items: baseline; gap: 12px; padding: 4px 0; font-size: 13px; }
.markon-dl-group a { font-weight: 500; }
.markon-dl-name { color: var(--vp-c-text-2); font-family: var(--vp-font-family-mono); font-size: 12px; }
.markon-dl-size { color: var(--vp-c-text-3); margin-left: auto; font-size: 12px; }

.markon-dl-fallback { padding: 12px 0; }
</style>
