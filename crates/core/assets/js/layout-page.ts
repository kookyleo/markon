/**
 * Document-view (layout.html) page chrome:
 *  1. TOC dual-state tracking — a sliding "viewport" overlay following scroll
 *     position, plus the click-/scroll-driven `.active` link. Exposes
 *     `window.__markonTocSetSelected` for `main.ts` (j/k navigation) and the
 *     in-content click sync.
 *  2. Static i18n labels for the layout chrome (TOC title, footer, etc.).
 *
 * Built as a CLASSIC (IIFE) bundle and loaded as a non-module `<script>` at the
 * same spot in `layout.html` where these lived inline — so it runs during parse
 * and sets `__markonTocSetSelected` before the deferred `main.js` module runs.
 */

type I18nFn = (key: string) => string;

interface SectionRange {
    id: string;
    li: HTMLElement;
    link: HTMLElement;
    top: number;
    bottom: number;
}

// ── 1. TOC dual-state tracking ──────────────────────────────────────────────
function initTocTracking(): void {
    const toc = document.querySelector<HTMLElement>('.toc');
    if (!toc) return;

    const tocLinks = Array.from(toc.querySelectorAll<HTMLElement>('.toc-item a'));
    if (tocLinks.length === 0) return;

    const headings = Array.from(
        document.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'),
    );
    if (headings.length === 0) return;

    const tocContainer = document.getElementById('toc-container');
    const tocLinkByHref = new Map<string, HTMLElement>();
    tocLinks.forEach((link) => {
        const href = link.getAttribute('href');
        if (!href) return;
        tocLinkByHref.set(href, link);
        try { tocLinkByHref.set(decodeURIComponent(href), link); } catch { /* ignore */ }
    });

    const tocLinkForId = (id: string | null): HTMLElement | null => {
        if (!id) return null;
        return tocLinkByHref.get('#' + id) || tocLinkByHref.get('#' + encodeURIComponent(id)) || null;
    };

    // ── Section position cache (rebuilt on resize / DOM, not on scroll) ──
    let sectionCache: SectionRange[] = [];
    let rebuildTimer: number | null = null;
    let rebuildFrame: number | null = null;
    let activeLink: HTMLElement | null = null;

    function rebuildCache(): void {
        const sy = window.scrollY;
        const docBottom = document.documentElement.scrollHeight;
        const visible: SectionRange[] = [];
        for (const h of headings) {
            if (h.offsetHeight === 0) continue;
            const link = tocLinkForId(h.id);
            const li = link && link.closest<HTMLElement>('.toc-item');
            if (!link || !li) continue;
            visible.push({ id: h.id, li, link, top: h.getBoundingClientRect().top + sy, bottom: 0 });
        }
        sectionCache = visible.map((s, i) => ({
            id: s.id,
            li: s.li,
            link: s.link,
            top: s.top,
            bottom: i + 1 < visible.length ? visible[i + 1].top : docBottom,
        }));
    }

    function scheduleRebuild(delay: number): void {
        if (rebuildTimer) clearTimeout(rebuildTimer);
        rebuildTimer = window.setTimeout(() => {
            rebuildTimer = null;
            if (rebuildFrame) cancelAnimationFrame(rebuildFrame);
            rebuildFrame = requestAnimationFrame(() => {
                rebuildFrame = null;
                rebuildCache();
                updateViewport();
            });
        }, delay);
    }

    rebuildCache();
    window.addEventListener('resize', () => scheduleRebuild(100));
    // Rebuild when sections collapse/expand (class changes on .heading-section).
    new MutationObserver(() => scheduleRebuild(50)).observe(
        document.querySelector('.markdown-body') || document.body,
        { attributes: true, subtree: true, attributeFilter: ['class'] },
    );

    // ── State 1: Viewport highlight (sliding overlay) ──
    const tocList = toc.querySelector<HTMLElement>('.toc-list');
    const vpHighlight = document.createElement('div');
    vpHighlight.className = 'toc-viewport-highlight';
    vpHighlight.style.top = '0px';
    vpHighlight.style.height = '0px';
    if (tocList) tocList.appendChild(vpHighlight);

    function updateViewport(): void {
        const vpTop = window.scrollY;
        const vpBottom = vpTop + window.innerHeight;
        let firstVp: HTMLElement | null = null;
        let lastVp: HTMLElement | null = null;
        let lo = 0;
        let hi = sectionCache.length - 1;
        let start = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sectionCache[mid].top <= vpTop) {
                start = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        start = Math.max(0, start - 1);
        for (let i = start; i < sectionCache.length; i++) {
            const s = sectionCache[i];
            if (s.top > vpBottom) break;
            const overlap = Math.min(s.bottom, vpBottom) - Math.max(s.top, vpTop);
            if (overlap > 30) {
                if (!firstVp) firstVp = s.li;
                lastVp = s.li;
            }
        }
        // Position the highlight overlay.
        if (firstVp && tocList) {
            const listRect = tocList.getBoundingClientRect();
            const firstRect = firstVp.getBoundingClientRect();
            const lastRect = (lastVp || firstVp).getBoundingClientRect();
            const top = firstRect.top - listRect.top + tocList.scrollTop;
            const height = lastRect.bottom - firstRect.top;
            vpHighlight.style.top = top + 'px';
            vpHighlight.style.height = height + 'px';
        } else {
            vpHighlight.style.height = '0px';
        }
        // Keep viewport range visible in the TOC panel.
        if (firstVp) {
            const tocRect = toc!.getBoundingClientRect();
            const lineH = firstVp.offsetHeight || 24;
            const lastR = (lastVp || firstVp).getBoundingClientRect();
            if (lastR.bottom > tocRect.bottom - lineH * 4) {
                toc!.scrollTop += lastR.bottom - tocRect.bottom + lineH * 4;
            }
            const firstR = firstVp.getBoundingClientRect();
            if (firstR.top < tocRect.top + lineH * 3) {
                toc!.scrollTop -= tocRect.top + lineH * 3 - firstR.top;
            }
        }
    }

    // ── Unified settle: update TOC only when main content stops moving ──
    let pendingActiveId: string | null = null;
    let settleTimer: number | null = null;

    function onSettle(): void {
        updateViewport();
        if (pendingActiveId) {
            if (activeLink) activeLink.classList.remove('active');
            activeLink = tocLinkForId(pendingActiveId);
            if (activeLink) activeLink.classList.add('active');
            pendingActiveId = null;
        }
    }

    function resetSettleTimer(): void {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = window.setTimeout(onSettle, 20);
    }

    window.addEventListener('scroll', resetSettleTimer, { passive: true });
    if ('onscrollend' in window) window.addEventListener('scrollend', onSettle);

    updateViewport();

    // ── State 2: .active scheduling ──
    function scheduleActive(id: string): void {
        if (activeLink) activeLink.classList.remove('active');
        activeLink = null;
        pendingActiveId = id;
        resetSettleTimer();
    }

    function focusHeading(heading: HTMLElement): void {
        document.querySelectorAll('.heading-focused').forEach((el) => el.classList.remove('heading-focused'));
        heading.classList.add('heading-focused');
    }

    // ── TOC click: schedule selected + smooth scroll ──
    tocLinks.forEach((link) => {
        link.addEventListener('click', (e) => {
            const href = link.getAttribute('href');
            if (href && href.startsWith('#')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const rawTargetId = href.substring(1);
                let targetId = rawTargetId;
                try { targetId = decodeURIComponent(rawTargetId); } catch { /* ignore */ }
                const targetElement = document.getElementById(targetId) || document.getElementById(rawTargetId);
                if (targetElement) {
                    scheduleActive(targetId);
                    focusHeading(targetElement);
                    const targetTop = targetElement.getBoundingClientRect().top + window.scrollY - 20;
                    window.scrollTo({ top: targetTop, behavior: 'smooth' });
                    history.pushState(null, '', href);
                    if (tocContainer && window.innerWidth <= 1400) {
                        tocContainer.classList.remove('active');
                    }
                }
            }
        });
    });

    // ── Sync selected from content-area clicks ──
    document.addEventListener(
        'click',
        (e) => {
            const target = e.target as Element | null;
            if (!target || target.closest('.toc')) return;
            const section = target.closest('.heading-section');
            if (section) {
                const heading = section.querySelector<HTMLElement>(
                    ':scope > h1[id], :scope > h2[id], :scope > h3[id], :scope > h4[id], :scope > h5[id], :scope > h6[id]',
                );
                if (heading && heading.id) { scheduleActive(heading.id); return; }
            }
            const heading = target.closest<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
            if (heading && heading.id) { scheduleActive(heading.id); return; }
            const link = target.closest<HTMLAnchorElement>('a[href^="#"]');
            if (link) {
                const id = (link.getAttribute('href') || '').substring(1);
                if (id) scheduleActive(id);
            }
        },
        true,
    );

    // Expose for j/k and main.js.
    window.__markonTocSetSelected = scheduleActive;
}

// ── 2. Static i18n labels ───────────────────────────────────────────────────
function initLayoutI18n(): void {
    const t: I18nFn = (window.__MARKON_I18N__ && window.__MARKON_I18N__.t) || ((k: string) => k);
    const labelMap: Record<string, string> = {
        'toc-title': 'web.toc.title',
        'back-link-text': 'web.back',
        'footer-text': 'web.footer',
        'clear-annot-text': 'web.annot.clear',
        'feedback-link-text': 'web.footer.feedback',
        'kbd-link-text': 'web.kbd.link',
    };
    for (const id in labelMap) {
        const el = document.getElementById(id);
        if (el) el.textContent = t(labelMap[id]);
    }
    const si = document.getElementById('search-input') as HTMLInputElement | null;
    if (si) si.placeholder = t('web.search.placeholder');
    const se = document.getElementById('search-esc-text');
    if (se) se.textContent = t('web.search.esc');
}

initTocTracking();
initLayoutI18n();

export {};
