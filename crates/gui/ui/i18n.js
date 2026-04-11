// Load translations from Rust backend (single source: /i18n/*.json5).
// Falls back to fetch if invoke is unavailable (shouldn't happen in Tauri).

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

export const i18n = {
  zh: buildLang(raw.zh),
  en: buildLang(raw.en),
};
