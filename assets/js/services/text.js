/**
 * 文本服务 - 纯技术，无业务逻辑
 */

export const Text = {
    // 标准化文本（折叠空白）
    normalize(text) {
        return text.replace(/\s+/g, ' ').trim();
    },

    // HTML 实体解码
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
