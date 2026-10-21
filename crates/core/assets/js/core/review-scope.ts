import { CONFIG, i18n } from './config';
import { Meta } from '../services/dom';

/** Describe the active dataset; this label never grants access or changes it. */
export function initReviewScopeLabels(): void {
    const source = Meta.get(CONFIG.META_TAGS.REVIEW_SCOPE) || 'personal';
    const scope = source === 'shared' ? 'shared' : 'personal';
    document.querySelectorAll<HTMLElement>('[data-review-scope-label]').forEach((label) => {
        label.textContent = i18n.t(`web.review.scope.${scope}`);
        label.title = i18n.t(`web.review.scope.${source === 'owner' ? 'owner' : scope}.tip`);
    });
}
