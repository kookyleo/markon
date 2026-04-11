// Load per-language translations from json5 files.
// Strip // comments before parsing (json5-lite approach).

function parseJson5(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

const [zh, en] = await Promise.all([
  fetch('./zh_CN.i18n.json5').then(r => r.text()).then(parseJson5),
  fetch('./en.i18n.json5').then(r => r.text()).then(parseJson5),
]);

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
  zh: buildLang(zh),
  en: buildLang(en),
};
