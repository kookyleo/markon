document.addEventListener('DOMContentLoaded', () => {
    const filePathMeta = document.querySelector('meta[name="file-path"]');
    if (!filePathMeta) return;

    const filePath = filePathMeta.getAttribute('content');
    const storageKey = `markon-annotations-${filePath}`;
    const sidebar = document.getElementById('notes-sidebar');
    const markdownBody = document.querySelector('.markdown-body');

    if (!markdownBody) return;

    const popover = createPopover();
    document.body.appendChild(popover);

    // Track if annotations have been applied to prevent re-application
    let annotationsApplied = false;

    // Apply annotations once after a short delay to ensure content is loaded
    setTimeout(() => {
        if (!annotationsApplied) {
            applyAnnotations();
            setupNoteClickHandlers();
            annotationsApplied = true;
        }
    }, 100);


    let currentSelection = null;

    document.addEventListener('mouseup', (e) => {
        if (popover.contains(e.target) || (sidebar && sidebar.contains(e.target))) return;

        const selection = window.getSelection();
        if (selection.toString().trim().length > 0) {
            currentSelection = selection.getRangeAt(0).cloneRange();
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            popover.style.left = `${rect.left + window.scrollX + rect.width / 2 - popover.offsetWidth / 2}px`;
            popover.style.top = `${rect.top + window.scrollY - popover.offsetHeight - 20}px`;
            popover.style.display = 'block';
        } else {
            if (!popover.contains(e.target)) {
                popover.style.display = 'none';
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (sidebar && !sidebar.contains(e.target) && !e.target.classList.contains('has-note')) {
            sidebar.classList.remove('visible');
        }
    });

    function createPopover() {
        const popover = document.createElement('div');
        popover.className = 'selection-popover';
        popover.innerHTML = `
            <button data-action="highlight-orange">Orange</button>
            <button data-action="highlight-green">Green</button>
            <button data-action="highlight-yellow">Yellow</button>
            <button data-action="strikethrough">Strikethrough</button>
            <button data-action="add-note">Note</button>
        `;
        popover.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            if (action.startsWith('highlight-')) applyStyle(action, 'span');
            else if (action === 'strikethrough') applyStyle('strikethrough', 's');
            else if (action === 'add-note') addNote();
            popover.style.display = 'none';
        });
        return popover;
    }

    function getSimpleXPath(node) {
        const parts = [];
        let current = node;

        // Elements to skip when calculating XPath (dynamic UI elements)
        const skipIds = new Set(['notes-sidebar', 'toc']);
        const skipClasses = new Set(['back-link', 'toc', 'selection-popover']);

        const shouldSkip = (element) => {
            if (element.nodeType !== 1) return false; // Only check element nodes
            if (element.id && skipIds.has(element.id)) return true;
            if (element.className) {
                const classes = element.className.split(' ');
                for (let cls of classes) {
                    if (skipClasses.has(cls)) return true;
                }
            }
            return false;
        };

        // Walk up the tree until we reach ARTICLE
        while (current && current.nodeName !== 'ARTICLE') {
            let index = 1;
            for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
                // Skip dynamic UI elements when counting
                if (sibling.nodeName === current.nodeName && !shouldSkip(sibling)) {
                    index++;
                }
            }
            parts.unshift(`${current.nodeName}[${index}]`);
            current = current.parentNode;
        }

        // If parts is empty, we're at the article level
        if (parts.length === 0) {
            return '//article[1]';
        }

        return `//article[1]/${parts.join('/')}`;
    }

    function applyStyle(className, tagName, note = null) {
        if (!currentSelection) return;
        const range = currentSelection;

        // Get the actual node to use for XPath (text node or element)
        const getPathNode = (container) => {
            // If container is a text node, use its parent
            if (container.nodeType === 3) {
                return container.parentNode;
            }
            // If container is an element and we're at the start/end, use the text node if it exists
            return container;
        };

        // Calculate absolute offset relative to the target element's full text content
        const getAbsoluteOffset = (container, offset) => {
            const targetElement = getPathNode(container);
            let absoluteOffset = 0;

            // If container is a text node, calculate its position within the parent element
            if (container.nodeType === 3) {
                // Walk through all child nodes before this one
                let node = targetElement.firstChild;
                while (node) {
                    if (node === container) {
                        // Found the container, add the offset within it
                        absoluteOffset += offset;
                        break;
                    }
                    if (node.nodeType === 3) {
                        // Text node: add its length
                        absoluteOffset += node.length;
                    } else if (node.nodeType === 1) {
                        // Element node: add its text content length
                        absoluteOffset += node.textContent.length;
                    }
                    node = node.nextSibling;
                }
            } else {
                // Container is an element, offset is relative to it
                absoluteOffset = offset;
            }

            return absoluteOffset;
        };

        const startPath = getSimpleXPath(getPathNode(range.startContainer));
        const endPath = getSimpleXPath(getPathNode(range.endContainer));

        const annotation = {
            id: `anno-${Date.now()}`,
            type: className,
            tagName: tagName,
            startPath: startPath,
            startOffset: getAbsoluteOffset(range.startContainer, range.startOffset),
            endPath: endPath,
            endOffset: getAbsoluteOffset(range.endContainer, range.endOffset),
            text: range.toString(),
            note: note
        };

        const element = document.createElement(tagName);
        element.className = className;
        element.dataset.annotationId = annotation.id;
        if (note) {
            element.dataset.note = note;
        }
        element.appendChild(range.extractContents());
        range.insertNode(element);

        saveAnnotation(annotation);
        window.getSelection().removeAllRanges();
    }

    function addNote() {
        if (!currentSelection) return;
        const noteText = prompt("Enter your note:");
        if (noteText) {
            applyStyle('has-note', 'span', noteText);
            updateSidebar();
        }
    }

    function saveAnnotation(annotation) {
        let annotations = JSON.parse(localStorage.getItem(storageKey) || '[]');
        annotations = annotations.filter(a => a.id !== annotation.id);
        annotations.push(annotation);
        localStorage.setItem(storageKey, JSON.stringify(annotations));
    }

    function getNodeByXPath(path) {
        // Elements to skip when resolving XPath (dynamic UI elements)
        const skipIds = new Set(['notes-sidebar']);
        const skipClasses = new Set(['back-link', 'toc', 'selection-popover']);

        const shouldSkip = (element) => {
            if (element.nodeType !== 1) return false;
            if (element.id && skipIds.has(element.id)) return true;
            if (element.className && typeof element.className === 'string') {
                const classes = element.className.split(' ');
                for (let cls of classes) {
                    if (skipClasses.has(cls)) return true;
                }
            }
            return false;
        };

        // Parse simple XPath like //article[1]/P[3]/SPAN[2]
        const match = path.match(/^\/\/article\[1\](?:\/(.+))?$/);
        if (!match) return null;

        let current = document.querySelector('article.markdown-body');
        if (!current) return null;

        if (!match[1]) return current; // Just //article[1]

        const segments = match[1].split('/');
        for (let segment of segments) {
            const tagMatch = segment.match(/^([A-Z]+)\[(\d+)\]$/);
            if (!tagMatch) return null;

            const tagName = tagMatch[1];
            let targetIndex = parseInt(tagMatch[2]);

            // Find the nth child of tagName, skipping dynamic elements
            let found = null;
            let count = 0;

            for (let child of current.children) {
                if (child.tagName === tagName && !shouldSkip(child)) {
                    count++;
                    if (count === targetIndex) {
                        found = child;
                        break;
                    }
                }
            }

            if (!found) return null;
            current = found;
        }

        return current;
    }

    function applyAnnotations() {
        const annotations = JSON.parse(localStorage.getItem(storageKey) || '[]');

        // Sort annotations by startOffset in descending order to apply from back to front
        // This prevents offset shifts when multiple annotations are in the same element
        annotations.sort((a, b) => {
            if (a.startPath !== b.startPath) {
                return a.startPath.localeCompare(b.startPath);
            }
            return b.startOffset - a.startOffset;
        });

        // Helper function to find the text node and relative offset from absolute offset
        const findNodeAndOffset = (element, absoluteOffset) => {
            let currentOffset = 0;
            let targetNode = null;
            let relativeOffset = 0;

            const walk = (node) => {
                if (targetNode) return; // Already found

                if (node.nodeType === 3) {
                    // Text node
                    if (currentOffset + node.length >= absoluteOffset) {
                        targetNode = node;
                        relativeOffset = absoluteOffset - currentOffset;
                    } else {
                        currentOffset += node.length;
                    }
                } else if (node.nodeType === 1) {
                    // Element node: walk through its children
                    for (let child = node.firstChild; child; child = child.nextSibling) {
                        walk(child);
                        if (targetNode) break;
                    }
                }
            };

            walk(element);
            return { node: targetNode, offset: relativeOffset };
        };

        annotations.forEach(anno => {
            const startNode = getNodeByXPath(anno.startPath);
            const endNode = getNodeByXPath(anno.endPath);

            if (startNode && endNode) {
                try {
                    // Validate total length
                    const startTotalLength = startNode.textContent.length;
                    const endTotalLength = endNode.textContent.length;

                    if (anno.startOffset > startTotalLength || anno.endOffset > endTotalLength) {
                        console.warn('Skipping annotation due to invalid offset:', anno);
                        return;
                    }

                    // Find the actual text nodes and offsets
                    const start = findNodeAndOffset(startNode, anno.startOffset);
                    const end = findNodeAndOffset(endNode, anno.endOffset);

                    if (!start.node || !end.node) {
                        console.warn('Skipping annotation: could not find text node:', anno);
                        return;
                    }

                    const range = document.createRange();
                    range.setStart(start.node, start.offset);
                    range.setEnd(end.node, end.offset);

                    if (range.toString().trim() === anno.text.trim()) {
                        const element = document.createElement(anno.tagName);
                        element.className = anno.type;
                        element.dataset.annotationId = anno.id;
                        if (anno.note) {
                            element.dataset.note = anno.note;
                        }
                        element.appendChild(range.extractContents());
                        range.insertNode(element);
                    }
                } catch (e) {
                    console.warn('Skipping annotation due to error:', anno, e.message);
                }
            }
        });
        updateSidebar();
    }

    function updateSidebar() {
        if (!sidebar) return;
        sidebar.innerHTML = '';
        const annotations = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const notes = annotations.filter(anno => anno.note);

        if (notes.length > 0) {
            notes.forEach(note => {
                const card = document.createElement('div');
                card.className = 'note-card';
                card.dataset.annotationId = note.id;

                const quote = document.createElement('p');
                quote.textContent = `"${note.text}"`;

                const noteText = document.createElement('p');
                noteText.className = 'note-text';
                noteText.textContent = note.note;

                card.appendChild(quote);
                card.appendChild(noteText);
                sidebar.appendChild(card);
            });
        } else {
            sidebar.innerHTML = '<p>No notes for this document yet.</p>';
        }
    }

    function setupNoteClickHandlers() {
        document.body.addEventListener('click', (e) => {
            if (e.target.classList.contains('has-note')) {
                sidebar.classList.add('visible');
                const allCards = sidebar.querySelectorAll('.note-card');
                allCards.forEach(c => c.style.backgroundColor = 'white');
                const card = sidebar.querySelector(`[data-annotation-id="${e.target.dataset.annotationId}"]`);
                if (card) {
                    card.style.backgroundColor = '#e7f5ff';
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        });
    }
});