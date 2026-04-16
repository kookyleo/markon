/**
 * Position calculation service - pure technical, no business logic
 */
import { CONFIG } from '../core/config.js';

export const Position = {
    // Get element absolute position
    getAbsolute(element) {
        const rect = element.getBoundingClientRect();
        const scrollY = window.scrollY || window.pageYOffset;
        const scrollX = window.scrollX || window.pageXOffset;
        return {
            left: rect.left + scrollX,
            top: rect.top + scrollY,
            right: rect.right + scrollX,
            bottom: rect.bottom + scrollY,
        };
    },

    // Clamp a rect into the viewport. `opts.fixed=true` works in viewport
    // coordinates (for CSS `position: fixed` elements); default uses document
    // coordinates (absolute/static elements that need scroll offset).
    constrainToViewport(left, top, width, height, opts = {}) {
        const margin = opts.margin ?? 10;
        const scrollX = opts.fixed ? 0 : (window.scrollX || window.pageXOffset);
        const scrollY = opts.fixed ? 0 : (window.scrollY || window.pageYOffset);
        let newLeft = left, newTop = top;

        if (newLeft < scrollX + margin) newLeft = scrollX + margin;
        if (newLeft + width > window.innerWidth + scrollX - margin) {
            newLeft = window.innerWidth + scrollX - width - margin;
        }
        if (newTop < scrollY + margin) newTop = scrollY + margin;
        if (newTop + height > window.innerHeight + scrollY - margin) {
            newTop = window.innerHeight + scrollY - height - margin;
        }

        return { left: newLeft, top: newTop };
    },

    // 智能滚动到Heading
    smartScrollToHeading(heading) {
        const section = heading.closest('.heading-section') || heading;
        const sectionHeight = section.offsetHeight;
        const viewportHeight = window.innerHeight;

        if (sectionHeight <= viewportHeight) {
            const availableSpace = viewportHeight - sectionHeight;
            const margin = availableSpace >= CONFIG.DIMENSIONS.HEADING_TOP_MARGIN
                ? CONFIG.DIMENSIONS.HEADING_TOP_MARGIN
                : availableSpace / 2;
            const targetY = section.getBoundingClientRect().top + window.scrollY - margin;
            window.scrollTo({ top: targetY, behavior: 'smooth' });
        } else {
            const targetY = section.getBoundingClientRect().top + window.scrollY - CONFIG.DIMENSIONS.HEADING_TOP_MARGIN_TIGHT;
            window.scrollTo({ top: targetY, behavior: 'smooth' });
        }
    }
};
