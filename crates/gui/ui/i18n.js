// Load translations from Rust backend (single source: /i18n/*.json5).

const { invoke } = window.__TAURI__.core;
const raw = await invoke('get_i18n');

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

// Available languages: [{ value: "zh_CN", key: "zh", label: "简体中文" }, ...]
export const availableLanguages = raw._languages || [];

// Build all languages dynamically from the registry — no hardcoded keys.
export const i18n = {};
for (const lang of availableLanguages) {
  if (raw[lang.key]) {
    i18n[lang.key] = buildLang(raw[lang.key]);
  }
}
