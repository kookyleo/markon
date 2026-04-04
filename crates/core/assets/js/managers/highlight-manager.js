/**
 * HighlightManager - Handles search term highlighting and scrolling
 */

import { Logger } from '../core/utils.js';

export class HighlightManager {
    #markdownBody;
    #highlightClass = 'search-highlight';
    #activeClass = 'search-highlight-active';

    constructor() {
        this.#markdownBody = document.querySelector('.markdown-body');
        if (!this.#markdownBody) {
            Logger.error('HighlightManager', 'Markdown body not found');
            return;
        }

        this.#checkForHighlightParam();
    }

    #checkForHighlightParam() {
        const urlParams = new URLSearchParams(window.location.search);
        const highlightQuery = urlParams.get('highlight');

        if (highlightQuery && highlightQuery.trim()) {
            Logger.log('HighlightManager', 'Highlighting query:', highlightQuery);
            this.highlightAndScroll(highlightQuery.trim());
        }
    }

    highlightAndScroll(query) {
        // Split query into words for better matching
        const words = query.split(/\s+/).filter(w => w.length > 0);
        if (words.length === 0) return;

        // Find all text nodes in markdown body
        const textNodes = this.#getTextNodes(this.#markdownBody);
        const matches = [];

        // Search for matches
        for (const word of words) {
            for (const node of textNodes) {
                const text = node.textContent;
                const lowerText = text.toLowerCase();
                const lowerWord = word.toLowerCase();
                let startIndex = 0;

                while ((startIndex = lowerText.indexOf(lowerWord, startIndex)) !== -1) {
                    matches.push({
                        node,
                        word,
                        start: startIndex,
                        end: startIndex + word.length,
                        text: text.substring(startIndex, startIndex + word.length)
                    });
                    startIndex += word.length;
                }
            }
        }

        if (matches.length === 0) {
            Logger.log('HighlightManager', 'No matches found for query');
            return;
        }

        Logger.log('HighlightManager', `Found ${matches.length} matches`);

        // Apply highlights
        const highlightedElements = this.#applyHighlights(matches);

        if (highlightedElements.length > 0) {
            // Scroll to first match
            const firstElement = highlightedElements[0];
            firstElement.classList.add(this.#activeClass);

            setTimeout(() => {
                firstElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);

            // Remove temporary highlights after animation
            setTimeout(() => {
                highlightedElements.forEach(el => {
                    el.classList.remove(this.#activeClass);
                });
            }, 3000);
        }
    }

    #getTextNodes(element) {
        const textNodes = [];
        const walk = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    // Skip script, style, and empty text nodes
                    if (node.parentElement.tagName === 'SCRIPT' ||
                        node.parentElement.tagName === 'STYLE' ||
                        !node.textContent.trim()) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    // Skip nodes inside existing highlights
                    if (node.parentElement.classList.contains(this.#highlightClass)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let node;
        while ((node = walk.nextNode())) {
            textNodes.push(node);
        }

        return textNodes;
    }

    #applyHighlights(matches) {
        const highlightedElements = [];

        // Sort matches by node and position (reverse order for safe replacement)
        matches.sort((a, b) => {
            if (a.node !== b.node) {
                return 0;
            }
            return b.start - a.start;
        });

        // Group matches by node
        const nodeMatches = new Map();
        for (const match of matches) {
            if (!nodeMatches.has(match.node)) {
                nodeMatches.set(match.node, []);
            }
            nodeMatches.get(match.node).push(match);
        }

        // Apply highlights to each node
        for (const [node, nodeMatchList] of nodeMatches) {
            const parent = node.parentNode;
            const text = node.textContent;
            const fragments = [];
            let lastIndex = 0;

            // Sort matches for this node by position
            nodeMatchList.sort((a, b) => a.start - b.start);

            for (const match of nodeMatchList) {
                // Add text before match
                if (match.start > lastIndex) {
                    fragments.push(document.createTextNode(text.substring(lastIndex, match.start)));
                }

                // Add highlighted match
                const span = document.createElement('span');
                span.className = this.#highlightClass;
                span.textContent = match.text;
                fragments.push(span);
                highlightedElements.push(span);

                lastIndex = match.end;
            }

            // Add remaining text
            if (lastIndex < text.length) {
                fragments.push(document.createTextNode(text.substring(lastIndex)));
            }

            // Replace node with fragments
            if (fragments.length > 0) {
                for (const fragment of fragments) {
                    parent.insertBefore(fragment, node);
                }
                parent.removeChild(node);
            }
        }

        return highlightedElements;
    }
}
