import { readonly, ref } from 'vue';
import { withBase } from 'vitepress';

export const HOME_LOCALE_COOKIE = 'markon_docs_locale';
export const HOME_LOCALES = ['en', 'zh', 'ja'];

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const locale = ref('en');
let initialized = false;

function normalizeLocale(value) {
  const candidate = String(value || '').toLowerCase().replace('_', '-');
  if (candidate.startsWith('zh')) return 'zh';
  if (candidate.startsWith('ja')) return 'ja';
  if (candidate.startsWith('en')) return 'en';
  return null;
}

export function readHomeLocaleCookie() {
  if (typeof document === 'undefined') return null;
  const prefix = `${HOME_LOCALE_COOKIE}=`;
  const value = document.cookie
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix))
    ?.slice(prefix.length);
  return normalizeLocale(value);
}

export function detectBrowserLocale() {
  if (typeof navigator === 'undefined') return 'en';
  const preferences = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
  for (const preference of preferences) {
    const detected = normalizeLocale(preference);
    if (detected) return detected;
  }
  return 'en';
}

function writeHomeLocaleCookie(value) {
  document.cookie = [
    `${HOME_LOCALE_COOKIE}=${value}`,
    `Max-Age=${COOKIE_MAX_AGE}`,
    `Path=${withBase('/')}`,
    'SameSite=Lax',
  ].join('; ');
}

export function initializeHomeLocale() {
  if (!initialized) {
    locale.value = readHomeLocaleCookie() || detectBrowserLocale();
    initialized = true;
  }
  return locale.value;
}

export function setHomeLocale(value, { persist = true } = {}) {
  const normalized = normalizeLocale(value) || 'en';
  locale.value = normalized;
  initialized = true;
  if (persist && typeof document !== 'undefined') writeHomeLocaleCookie(normalized);
}

export function useHomeLocale() {
  return {
    locale: readonly(locale),
    initializeHomeLocale,
    setHomeLocale,
  };
}
