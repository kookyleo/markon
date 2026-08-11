const SOURCE_SUFFIX_LOCALES = {
  zh: 'zh',
  ja: 'ja',
};

export function rewriteLocalizedSource(id) {
  const normalized = id.replaceAll('\\', '/');
  const match = normalized.match(/^(.*)\.(zh|ja)\.md$/);
  if (!match) return normalized;
  return `${match[2]}/${match[1]}.md`;
}

export function sourcePathToCanonicalRoute(sourcePath) {
  let normalized = sourcePath
    .replaceAll('\\', '/')
    .replace(/\.(?:zh|ja)\.md$/, '.md')
    .replace(/^\/+/, '');
  normalized = normalized.replace(/^(?:zh|ja)\//, '');

  if (normalized === 'index.md') return '/';
  if (normalized.endsWith('/index.md')) {
    return `/${normalized.slice(0, -'index.md'.length)}`;
  }
  return `/${normalized.replace(/\.md$/, '')}`;
}

export function sourcePathLocale(sourcePath) {
  const normalized = sourcePath.replaceAll('\\', '/').replace(/^\/+/, '');
  const suffixMatch = normalized.match(/\.(zh|ja)\.md$/);
  if (suffixMatch) return SOURCE_SUFFIX_LOCALES[suffixMatch[1]];
  const rewrittenMatch = normalized.match(/^(zh|ja)\//);
  return rewrittenMatch ? SOURCE_SUFFIX_LOCALES[rewrittenMatch[1]] : 'en';
}

export function localizedRouteForSource(sourcePath) {
  const canonical = sourcePathToCanonicalRoute(sourcePath);
  const locale = sourcePathLocale(sourcePath);
  return locale === 'en' ? canonical : `/${locale}${canonical}`;
}

export function buildContentLocaleAvailability(sourcePaths) {
  const availability = {};
  for (const sourcePath of sourcePaths) {
    const locale = sourcePathLocale(sourcePath);
    if (locale === 'en') continue;
    const canonical = sourcePathToCanonicalRoute(sourcePath);
    if (!availability[canonical]) availability[canonical] = {};
    availability[canonical][locale] = localizedRouteForSource(sourcePath);
  }
  return availability;
}

function stripBase(pathname, base) {
  const normalizedBase = base === '/' ? '/' : `/${base.replace(/^\/+|\/+$/g, '')}/`;
  if (normalizedBase !== '/' && pathname.startsWith(normalizedBase)) {
    return `/${pathname.slice(normalizedBase.length)}`;
  }
  return pathname;
}

export function contentLocaleFromPath(pathname, base = '/') {
  const url = new URL(pathname, 'https://markon.invalid');
  const path = stripBase(url.pathname, base);
  if (path === '/zh' || path.startsWith('/zh/')) return 'zh';
  if (path === '/ja' || path.startsWith('/ja/')) return 'ja';
  return 'en';
}

export function canonicalContentPath(pathname, base = '/') {
  const url = new URL(pathname, 'https://markon.invalid');
  let path = stripBase(url.pathname, base);
  path = path.replace(/^\/(?:zh|ja)(?:\/|$)/, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  return path || '/';
}

export function localizedContentPath(pathname, locale, availability, base = '/') {
  const canonical = canonicalContentPath(pathname, base);
  const localized = locale === 'en'
    ? canonical
    : availability?.[canonical]?.[locale] || canonical;
  const normalizedBase = base === '/' ? '/' : `/${base.replace(/^\/+|\/+$/g, '')}/`;
  return normalizedBase === '/'
    ? localized
    : `${normalizedBase.slice(0, -1)}${localized}`;
}
