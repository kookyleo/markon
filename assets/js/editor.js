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

    // Use MutationObserver to wait for content to be loaded
    const observer = new MutationObserver((mutationsList, observer) => {
        // We only need to run this once
        for(const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                applyAnnotations();
                setupNoteClickHandlers();
                observer.disconnect(); // Stop observing after we've applied annotations
                break;
            }
        }
    });
    observer.observe(markdownBody, { childList: true, subtree: true });


    let currentSelection = null;

    document.addEventListener('mouseup', (e) => {
        if (popover.contains(e.target) || (sidebar && sidebar.contains(e.target))) return;

        const selection = window.getSelection();
        if (selection.toString().trim().length > 0) {
            currentSelection = selection.getRangeAt(0).cloneRange();
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            popover.style.left = `${rect.left + window.scrollX + rect.width / 2 - popover.offsetWidth / 2}px`;
            popover.style.top = `${rect.top + window.scrollY - popover.offsetHeight - 10}px`;
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
        while (node && node.nodeName !== 'ARTICLE') {
            let index = 1;
            for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
                if (sibling.nodeName === node.nodeName) index++;
            }
            parts.unshift(`${node.nodeName}[${index}]`);
            node = node.parentNode;
        }
        return `//article[1]/${parts.join('/')}`;
    }

    function applyStyle(className, tagName, note = null) {
        if (!currentSelection) return;
        const range = currentSelection;

        const annotation = {
            id: `anno-${Date.now()}`,
            type: className,
            tagName: tagName,
            startPath: getSimpleXPath(range.startContainer.parentNode),
            startOffset: range.startOffset,
            endPath: getSimpleXPath(range.endContainer.parentNode),
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
        annotations.forEach(anno => {
            const startNode = getNodeByXPath(anno.startPath);
            const endNode = getNodeByXPath(anno.endPath);

            if (startNode && endNode) {
                try {
                    const range = document.createRange();
                    range.setStart(startNode.firstChild || startNode, anno.startOffset);
                    range.setEnd(endNode.firstChild || endNode, anno.endOffset);

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
                    console.error('Failed to apply annotation:', anno, e);
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