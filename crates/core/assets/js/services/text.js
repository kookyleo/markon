/**
 * Text service - pure technical, no business logic
 */

export const Text = {
    // Normalize text (collapse whitespace)
    normalize(text) {
        return text.replace(/\s+/g, ' ').trim();
    },

    // HTML 实体Decode
    decodeEntities(text) {
        return text
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, '\'');
    },

    // HTML 转义
    escape(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
