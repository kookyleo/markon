/**
 * Text service - pure technical, no business logic
 */

export const Text = {
    // Normalize text (collapse whitespace)
    normalize(text) {
        return text.replace(/\s+/g, ' ').trim();
    },

    // Decode HTML entities
    decodeEntities(text) {
        return text
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, '\'');
    },

    // Escape HTML special characters
    escape(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
