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

        // Walk up the tree until we reach ARTICLE
        while (current && current.nodeName !== 'ARTICLE') {
            let index = 1;
            for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
                if (sibling.nodeName === current.nodeName) index++;
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

        const annotation = {
            id: `anno-${Date.now()}`,
            type: className,
            tagName: tagName,
            startPath: getSimpleXPath(getPathNode(range.startContainer)),
            startOffset: range.startOffset,
            endPath: getSimpleXPath(getPathNode(range.endContainer)),
            endOffset: range.endOffset,
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
        return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
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

        annotations.forEach(anno => {
            const startNode = getNodeByXPath(anno.startPath);
            const endNode = getNodeByXPath(anno.endPath);

            if (startNode && endNode) {
                try {
                    const startTarget = startNode.firstChild || startNode;
                    const endTarget = endNode.firstChild || endNode;

                    // Validate offsets before creating range
                    const startLength = startTarget.nodeType === 3 ? startTarget.length : startTarget.textContent.length;
                    const endLength = endTarget.nodeType === 3 ? endTarget.length : endTarget.textContent.length;

                    if (anno.startOffset > startLength || anno.endOffset > endLength) {
                        console.warn('Skipping annotation due to invalid offset:', anno);
                        return;
                    }

                    const range = document.createRange();
                    range.setStart(startTarget, anno.startOffset);
                    range.setEnd(endTarget, anno.endOffset);

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