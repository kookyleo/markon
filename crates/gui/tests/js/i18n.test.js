import { describe, it, expect } from 'vitest';

// These functions are copied from i18n.js since the module reads
// window.__TAURI__.core at import time, which is not available in jsdom.
// If the source changes, these must stay in sync.

function buildTemplateFunc(tplStr) {
  return (info) => tplStr
    .replace(/\{app_version\}/g, info.app_version ?? '?')
    .replace(/\{os\}/g, info.os ?? '?')
    .replace(/\{os_version\}/g, info.os_version ?? '')
    .replace(/\{arch\}/g, info.arch ?? '')
    .replace(/\{ua\}/g, typeof navigator !== 'undefined' ? navigator.userAgent : '');
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

describe('buildTemplateFunc', () => {
  it('replaces all placeholders', () => {
    const tpl = buildTemplateFunc('v{app_version} on {os} {os_version} ({arch})');
    const result = tpl({ app_version: '1.0', os: 'macOS', os_version: '14.0', arch: 'arm64' });
    expect(result).toBe('v1.0 on macOS 14.0 (arm64)');
  });

  it('uses fallback for missing values', () => {
    const tpl = buildTemplateFunc('{app_version} - {os}');
    const result = tpl({});
    expect(result).toBe('? - ?');
  });

  it('replaces multiple occurrences', () => {
    const tpl = buildTemplateFunc('{os}/{os}');
    expect(tpl({ os: 'linux' })).toBe('linux/linux');
  });
});

describe('buildLang', () => {
  it('returns null for null input', () => {
    expect(buildLang(null)).toBeNull();
  });

  it('builds feedback shortcuts from flat keys', () => {
    const data = {
      'feedback.bug.label': 'Report Bug',
      'feedback.bug.tip': 'Tell us',
      'feedback.idea.label': 'Idea',
      'feedback.idea.tip': 'Share',
      'feedback.ask.label': 'Ask',
      'feedback.ask.tip': 'Question',
      'tpl.bug': 'Bug on {os}',
      'tpl.idea': 'Idea for {app_version}',
      'tpl.ask': 'Ask about {arch}',
      'tpl.title.bug': 'Bug Report',
      'tpl.title.idea': 'Feature Request',
      'tpl.title.ask': 'Question',
    };
    const lang = buildLang(data);
    expect(lang.bug.label).toBe('Report Bug');
    expect(lang.idea.tip).toBe('Share');
    expect(lang.titleBug).toBe('Bug Report');
    expect(typeof lang.tplBug).toBe('function');
    expect(lang.tplBug({ os: 'mac' })).toBe('Bug on mac');
  });
});
