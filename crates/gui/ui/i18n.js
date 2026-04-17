// Load translations from Rust backend (single source: /i18n/*.json5).
//
// Exposed via a one-shot initI18n() rather than top-level await so the
// module parses on WebKit older than Safari 15 (macOS Big Sur 11.3+).
// Older WebKit treats top-level await as a SyntaxError and aborts the
// whole module, which also breaks every importing script.

const { invoke } = window.__TAURI__.core;

function buildTemplateFunc(tplStr) {
  return (info) => tplStr
    .replace(/\{app_version\}/g, info.app_version ?? '?')
    .replace(/\{os\}/g, info.os ?? '?')
    .replace(/\{os_version\}/g, info.os_version ?? '')
    .replace(/\{arch\}/g, info.arch ?? '')
    .replace(/\{ua\}/g, navigator.userAgent);
}

function buildLang(data) {
  if (!data) return null;
  const out = { ...data };
  out.bug  = { label: data['feedback.bug.label'],  tip: data['feedback.bug.tip'] };
  out.idea = { label: data['feedback.idea.label'], tip: data['feedback.idea.tip'] };
  out.ask  = { label: data['feedback.ask.label'],  tip: data['feedback.ask.tip'] };
  out.tplBug  = buildTemplateFunc(data['tpl.bug']);
  out.tplIdea = buildTemplateFunc(data['tpl.idea']);
  out.tplAsk  = buildTemplateFunc(data['tpl.ask']);
  out.titleBug  = data['tpl.title.bug'];
  out.titleIdea = data['tpl.title.idea'];
  out.titleAsk  = data['tpl.title.ask'];
  return out;
}

// Mutable containers — filled in-place by initI18n() so existing imports
// keep the same reference identity across the module graph.
export const availableLanguages = [];
export const i18n = {};

let initialized = false;
let initPromise = null;

export function initI18n() {
  if (initialized) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const raw = await invoke('get_i18n');
    const langs = raw._languages || [];
    availableLanguages.length = 0;
    for (const l of langs) availableLanguages.push(l);
    for (const k of Object.keys(i18n)) delete i18n[k];
    for (const lang of langs) {
      if (raw[lang.key]) i18n[lang.key] = buildLang(raw[lang.key]);
    }
    initialized = true;
  })();
  return initPromise;
}
