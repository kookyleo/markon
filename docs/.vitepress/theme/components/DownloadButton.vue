<script setup>
import { computed, onMounted, ref } from 'vue';
import { useData } from 'vitepress';

const props = defineProps({
  // 'primary': big auto-detected button + collapsible others
  // 'all':     full per-OS list (groups have headers)
  // 'os':      single-OS list, no header (use under a section heading)
  mode: { type: String, default: 'primary' },
  // Required when mode='os': 'macos' | 'windows' | 'linux'
  os: { type: String, default: null },
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

// Canonical platform matrix. mode='os' iterates this so the install page
// always lists every supported target, even if the current release is missing
// one (older releases predate the expanded build matrix). Missing entries
// render muted instead of vanishing.
const MATRIX = {
  macos: [
    { variant: 'Apple Silicon', match: a => /\.dmg$/.test(a) && /aarch64/.test(a) },
    { variant: 'Intel',         match: a => /\.dmg$/.test(a) && /(x86_64|x64)/.test(a) },
  ],
  windows: [
    { variant: 'x64',   match: a => /setup\.exe$/.test(a) && /x64/.test(a) },
    { variant: 'ARM64', match: a => /setup\.exe$/.test(a) && /arm64/.test(a) },
  ],
  linux: [
    { variant: 'AppImage · amd64',  match: a => /\.AppImage$/.test(a) && /amd64/.test(a) },
    { variant: 'AppImage · aarch64', match: a => /\.AppImage$/.test(a) && /aarch64/.test(a) },
    { variant: 'deb · amd64',       match: a => /\.deb$/.test(a) && /amd64/.test(a) },
    { variant: 'deb · arm64',       match: a => /\.deb$/.test(a) && /(arm64|aarch64)/.test(a) },
  ],
};

function expandMatrix(osKey) {
  const rows = MATRIX[osKey] || [];
  const assets = release.value?.assets || [];
  return rows.map(row => {
    const asset = assets.find(a => row.match(a.name));
    return asset
      ? { variant: row.variant, name: asset.name, url: asset.url, size: asset.size, available: true }
      : { variant: row.variant, name: null, url: null, size: 0, available: false };
  });
}

const grouped = computed(() => {
  if (!release.value) return [];
  return [
    { label: 'macOS',   items: expandMatrix('macos') },
    { label: 'Windows', items: expandMatrix('windows') },
    { label: 'Linux',   items: expandMatrix('linux') },
  ];
});

const osItems = computed(() => props.os ? expandMatrix(props.os.toLowerCase()) : []);

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
          <li v-for="a in g.items" :key="a.variant" :class="{ unavailable: !a.available }">
            <a v-if="a.available" :href="a.url">{{ a.variant }}</a>
            <span v-else class="markon-dl-disabled">{{ a.variant }}</span>
            <span class="markon-dl-name">{{ a.available ? a.name : '此版本未发布' }}</span>
            <span class="markon-dl-size">{{ formatBytes(a.size) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>

  <a
    v-else-if="mode === 'nav' && primary"
    :href="primary.url"
    class="markon-dl-nav"
    :title="`Markon ${release.version} · ${platformLabel} · ${formatBytes(primary.size)}`"
  >
    <span class="markon-dl-nav-arrow">↓</span>
    <span>下载 {{ platformLabel || '' }}</span>
  </a>
  <a
    v-else-if="mode === 'nav'"
    :href="release.htmlUrl"
    class="markon-dl-nav"
    target="_blank"
    rel="noopener"
    :title="`Markon ${release.version} · 所有平台`"
  >
    <span class="markon-dl-nav-arrow">↓</span>
    <span>下载</span>
  </a>

  <div v-else-if="mode === 'os'" class="markon-dl-list">
    <ul>
      <li v-for="a in osItems" :key="a.variant" :class="{ unavailable: !a.available }">
        <a v-if="a.available" :href="a.url">{{ a.variant }}</a>
        <span v-else class="markon-dl-disabled">{{ a.variant }}</span>
        <span class="markon-dl-name">{{ a.available ? a.name : '此版本未发布' }}</span>
        <span class="markon-dl-size">{{ formatBytes(a.size) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.markon-dl { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; margin: 16px 0 24px; }
.markon-dl-primary {
  display: inline-flex; align-items: center; gap: 14px;
  padding: 14px 22px; border-radius: 12px;
  background: var(--vp-button-brand-bg); color: var(--vp-button-brand-text) !important;
  text-decoration: none !important; transition: background 0.15s;
}
.markon-dl-primary:hover { background: var(--vp-button-brand-hover-bg); }
.markon-dl-arrow { font-size: 24px; line-height: 1; }
.markon-dl-stack { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.3; }
.markon-dl-title { font-size: 16px; font-weight: 600; }
.markon-dl-meta { font-size: 12px; opacity: 0.85; }

.markon-dl-toggle {
  background: none; border: none; padding: 4px 8px;
  font-size: 13px; color: var(--vp-c-text-2); cursor: pointer;
}
.markon-dl-toggle:hover { color: var(--vp-c-brand-1); }

/* nav: tinted brand pill that lives in the top navbar via
   `nav-bar-content-before` (sits next to the site title, ahead of the menu).
   Calm brand-soft fill + brand-color text — lighter than a solid CTA but still
   clearly the primary action, distinct from the neutral nav links beside it. */
.markon-dl-nav {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 14px;
  margin: 0 24px;
  border: 1px solid transparent;
  border-radius: 16px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1) !important;
  font-size: 13px; font-weight: 600;
  text-decoration: none !important;
  transition: background-color .15s, border-color .15s;
  white-space: nowrap;
}
.markon-dl-nav:hover {
  border-color: var(--vp-c-brand-1);
}
.markon-dl-nav-arrow {
  font-size: 14px; line-height: 1;
}

@media (max-width: 768px) {
  /* On small screens the navbar collapses; hide the nav pill to avoid
     squeezing — users can still reach the download via hamburger menu / hero. */
  .markon-dl-nav { display: none; }
}

.markon-dl-list { width: 100%; margin: 8px 0 16px; }
.markon-dl-group { margin-top: 12px; }
.markon-dl-group-label { font-weight: 600; margin-bottom: 6px; color: var(--vp-c-text-1); }

/* List rendering is shared across mode='os' / 'all' / 'primary' (collapsible).
   Targets the wrapper so the same look applies whether the list sits under
   a per-OS group label or directly under a markdown ### heading. */
.markon-dl-list ul { list-style: none; padding: 0; margin: 0; }
.markon-dl-list li {
  display: flex; align-items: baseline; gap: 12px;
  padding: 6px 0; font-size: 13px;
}
.markon-dl-list li.unavailable { opacity: 0.5; }
.markon-dl-list a { font-weight: 500; }
.markon-dl-name { color: var(--vp-c-text-2); font-family: var(--vp-font-family-mono); font-size: 12px; }
.markon-dl-size { color: var(--vp-c-text-3); margin-left: auto; font-size: 12px; white-space: nowrap; }
.markon-dl-disabled { font-weight: 500; color: var(--vp-c-text-2); }

.markon-dl-fallback { padding: 12px 0; }
</style>
