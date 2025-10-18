// Global function to show confirm dialog
function showConfirmDialog(message, onConfirm, triggerElement, confirmText = 'OK') {
    // Remove existing dialog if any
    const existingDialog = document.querySelector('.confirm-dialog');
    if (existingDialog) existingDialog.remove();

    // Create small dialog
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
        <p class="confirm-message">${message}</p>
        <div class="confirm-actions">
            <button class="confirm-cancel">Cancel</button>
            <button class="confirm-ok">${confirmText}</button>
        </div>
    `;

    document.body.appendChild(dialog);

    // Position near trigger element
    if (triggerElement) {
        const rect = triggerElement.getBoundingClientRect();
        dialog.style.position = 'fixed';
        dialog.style.left = `${rect.left}px`;
        dialog.style.top = `${rect.bottom + 5}px`;

        // Adjust if goes off screen
        setTimeout(() => {
            const dialogRect = dialog.getBoundingClientRect();
            if (dialogRect.right > window.innerWidth) {
                dialog.style.left = `${window.innerWidth - dialogRect.width - 10}px`;
            }
            if (dialogRect.bottom > window.innerHeight) {
                dialog.style.top = `${rect.top - dialogRect.height - 5}px`;
            }
        }, 0);
    }

    const cancelBtn = dialog.querySelector('.confirm-cancel');
    const okBtn = dialog.querySelector('.confirm-ok');

    cancelBtn.addEventListener('click', () => {
        dialog.remove();
    });

    okBtn.addEventListener('click', () => {
        dialog.remove();
        onConfirm();
    });

    // Close on outside click
    setTimeout(() => {
        const closeHandler = (e) => {
            if (!dialog.contains(e.target)) {
                dialog.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 0);

    // Focus OK button
    setTimeout(() => okBtn.focus(), 0);
}

// Global function to clear annotations for current page
// eslint-disable-next-line no-unused-vars
function clearPageAnnotations(event, ws, isSharedAnnotationMode) {
    const filePathMeta = document.querySelector('meta[name="file-path"]');
    if (!filePathMeta) return;

    const triggerElement = event ? event.target : null;

    showConfirmDialog('Clear all annotations for this page?', () => {
        if (isSharedAnnotationMode) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'clear_annotations' }));
            }
        } else {
            const filePath = filePathMeta.getAttribute('content');
            const storageKey = `markon-annotations-${filePath}`;
            localStorage.removeItem(storageKey);
            location.reload();
        }
    }, triggerElement, 'Clear');
}

document.addEventListener('DOMContentLoaded', () => {
    const filePathMeta = document.querySelector('meta[name="file-path"]');
    if (!filePathMeta) return;

    const sharedAnnotationMeta = document.querySelector('meta[name="shared-annotation"]');
    window.isSharedAnnotationMode = sharedAnnotationMeta && sharedAnnotationMeta.getAttribute('content') === 'true';
    window.ws = null;

    if (window.isSharedAnnotationMode) {
        function connect() {
            window.ws = new WebSocket(`ws://${window.location.host}/ws`);

            window.ws.onopen = () => {
                console.log('WebSocket connected');
            };

            window.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                switch (msg.type) {
                    case 'all_annotations':
                        // Clear existing annotations before applying new ones
                        clearAllAnnotationsFromDOM();
                        // This will be our local copy of annotations
                        window.annotations = msg.annotations;
                        applyAnnotations(window.annotations);
                        break;
                    case 'new_annotation':
                        // Remove old version if it exists, then add new one
                        removeAnnotationFromDOM(msg.annotation.id);
                        window.annotations = window.annotations.filter(a => a.id !== msg.annotation.id);
                        window.annotations.push(msg.annotation);
                        applyAnnotations([msg.annotation]);
                        break;
                    case 'delete_annotation':
                        window.annotations = window.annotations.filter(a => a.id !== msg.id);
                        removeAnnotationFromDOM(msg.id);
                        renderNotesMargin();
                        break;
                    case 'clear_annotations':
                        window.annotations = [];
                        clearAllAnnotationsFromDOM();
                        break;
                }
            };

            window.ws.onclose = () => {
                console.log('WebSocket disconnected, attempting to reconnect...');
                setTimeout(connect, 1000);
            };

            window.ws.onerror = (err) => {
                console.error('WebSocket error:', err);
                window.ws.close();
            };
        }
        connect();
    }

    const filePath = filePathMeta.getAttribute('content');
    const storageKey = `markon-annotations-${filePath}`;
    const markdownBody = document.querySelector('.markdown-body');

    if (!markdownBody) return;

    const popover = createPopover();
    document.body.appendChild(popover);

    // Track if annotations have been applied to prevent re-application
    let annotationsApplied = false;

    // Fix HTML entities in TOC
    function fixTocHtmlEntities() {
        const toc = document.querySelector('.toc');
        if (toc) {
            const tocItems = toc.querySelectorAll('.toc-item a');
            tocItems.forEach(item => {
                const text = item.textContent;
                const decoded = text
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'");
                if (text !== decoded) {
                    item.textContent = decoded;
                }

                // Add history.pushState on click
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const href = item.getAttribute('href');
                    history.pushState(null, '', href);

                    // Manually scroll to the element
                    const targetId = href.substring(1);
                    const targetElement = document.getElementById(targetId);
                    if (targetElement) {
                        targetElement.scrollIntoView({ behavior: 'smooth' });
                    }

                    // Close TOC menu on mobile after clicking
                    const tocContainer = document.getElementById('toc-container');
                    if (tocContainer && window.innerWidth <= 1400) {
                        tocContainer.classList.remove('active');
                    }
                });
            });
        }
    }

    // Apply annotations once after a short delay to ensure content is loaded
    setTimeout(() => {
        if (!annotationsApplied) {
            fixTocHtmlEntities();
            applyAnnotations();
            setupNoteClickHandlers();
            annotationsApplied = true;
        }
    }, 100);

    // Make the main selection popover draggable
    makePopoverDraggable(popover, 'markon-popover-offset');

    // Update clear annotations button text
    const clearButton = document.querySelector('.footer-clear-link');
    if (clearButton) {
        clearButton.textContent = `Clear Annotations (${window.isSharedAnnotationMode ? 'shared' : 'local'})`;
    }

    let currentSelection = null;
    let currentHighlightedElement = null;

    // Update popover content based on whether selection is highlighted
    function updatePopover(popover, highlightedElement) {
        currentHighlightedElement = highlightedElement;

        if (highlightedElement) {
            // Show unhighlight button for already highlighted text
            popover.innerHTML = '<button data-action="unhighlight">Unhighlight</button>';
        } else {
            // Show normal annotation buttons
            popover.innerHTML = `
                <button data-action="highlight-orange">Orange</button>
                <button data-action="highlight-green">Green</button>
                <button data-action="highlight-yellow">Yellow</button>
                <button data-action="strikethrough">Strike</button>
                <span class="popover-separator">|</span>
                <button data-action="add-note">Note</button>
            `;
        }
    }

    const handleSelection = (e) => {
        if (popover.contains(e.target)) return;

        const selection = window.getSelection();
        if (selection.toString().trim().length > 0) {
            // Check if selection is within markdown body
            const range = selection.getRangeAt(0);
            const container = range.commonAncestorContainer;
            const element = container.nodeType === 3 ? container.parentElement : container;

            // Only show popover if selection is within markdown-body
            if (!markdownBody.contains(element)) {
                return;
            }

            // Skip if selection is within UI elements
            if (element.closest('.selection-popover') ||
                element.closest('.note-input-modal') ||
                element.closest('.note-card-margin') ||
                element.closest('.note-popup') ||
                element.closest('.confirm-dialog')) {
                return;
            }

            currentSelection = range.cloneRange();
            const rect = range.getBoundingClientRect();

            // Check if selection is already highlighted (excluding has-note, which has its own management)
            const isHighlighted = element.closest('.highlight-orange, .highlight-green, .highlight-yellow, .strikethrough');

            // Update popover content based on highlight status
            updatePopover(popover, isHighlighted);

            // Show popover first (with visibility hidden) to get accurate dimensions
            popover.style.visibility = 'hidden';
            popover.style.display = 'block';

            // Force browser reflow to calculate dimensions
            const popoverHeight = popover.offsetHeight;
            const popoverWidth = popover.offsetWidth;

            // Calculate position (above the selection)
            const originalLeft = rect.left + window.scrollX + rect.width / 2 - popoverWidth / 2;
            const originalTop = rect.top + window.scrollY - popoverHeight - 10;

            // Store original position for calculating drag offset
            popover.dataset.originalLeft = originalLeft;
            popover.dataset.originalTop = originalTop;

            // Apply stored offset if it exists
            const savedOffset = JSON.parse(localStorage.getItem('markon-popover-offset') || '{}');
            const offsetX = savedOffset.dx || 0;
            const offsetY = savedOffset.dy || 0;

            let finalLeft = originalLeft + offsetX;
            let finalTop = originalTop + offsetY;

            // Adjust position to stay within viewport
            // Check left boundary
            if (finalLeft < 10) {
                finalLeft = 10;
            }

            // Check right boundary
            if (finalLeft + popoverWidth > window.innerWidth - 10) {
                finalLeft = window.innerWidth - popoverWidth - 10;
            }

            // Check top boundary. If it's off-screen, try to place it below the selection.
            if (finalTop < 10) {
                finalTop = rect.bottom + window.scrollY + 10;
            }

            popover.style.left = `${finalLeft}px`;
            popover.style.top = `${finalTop}px`;

            // Now make it visible
            popover.style.visibility = 'visible';
        } else {
            if (!popover.contains(e.target)) {
                popover.style.display = 'none';
            }
        }
    };

    document.addEventListener('mouseup', handleSelection);
    document.addEventListener('touchend', handleSelection);
    document.addEventListener('click', (e) => {
        const isHighlighted = e.target.closest('.highlight-orange, .highlight-green, .highlight-yellow, .strikethrough');
        if (isHighlighted) {
            updatePopover(popover, isHighlighted);
            const rect = isHighlighted.getBoundingClientRect();
            popover.style.left = `${rect.left + window.scrollX + rect.width / 2 - popover.offsetWidth / 2}px`;
            popover.style.top = `${rect.top + window.scrollY - popover.offsetHeight - 10}px`;
            popover.style.display = 'block';
        }
    });

    // Hide popover when clicking/touching outside
    const hidePopoverOnOutsideClick = (e) => {
        // Don't hide if clicking on popover itself
        if (popover.contains(e.target)) {
            return;
        }

        // Don't hide if clicking on UI elements (TOC, notes, etc.)
        if (e.target.closest('.toc-container') ||
            e.target.closest('.note-card-margin') ||
            e.target.closest('.note-popup') ||
            e.target.closest('.note-input-modal')) {
            return;
        }

        // Hide popover and clear selection
        if (popover.style.display !== 'none') {
            popover.style.display = 'none';
            currentSelection = null;
            currentHighlightedElement = null;
            // Clear text selection
            window.getSelection().removeAllRanges();
        }
    };

    document.addEventListener('mousedown', hidePopoverOnOutsideClick);
    document.addEventListener('touchstart', hidePopoverOnOutsideClick, { passive: true });


    function createPopover() {
        const popover = document.createElement('div');
        popover.className = 'selection-popover';
        popover.innerHTML = `
            <button data-action="highlight-orange">Orange</button>
            <button data-action="highlight-green">Green</button>
            <button data-action="highlight-yellow">Yellow</button>
            <button data-action="strikethrough">Strike</button>
            <span class="popover-separator">|</span>
            <button data-action="add-note">Note</button>
        `;
        popover.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            if (!action) return; // Clicked on popover background, not a button

            if (action.startsWith('highlight-')) applyStyle(action, 'span');
            else if (action === 'strikethrough') applyStyle('strikethrough', 's');
            else if (action === 'add-note') addNote();
            else if (action === 'unhighlight') removeHighlight();
            popover.style.display = 'none';
        });
        return popover;
    }

    function getSimpleXPath(node) {
        const parts = [];
        let current = node;

        // Elements to skip when calculating XPath (dynamic UI elements)
        const skipIds = new Set(['toc']);
        const skipClasses = new Set(['back-link', 'toc', 'selection-popover', 'note-card-margin', 'note-popup']);

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
                // Container is an element, offset is an index of child nodes
                absoluteOffset = 0;
                for (let i = 0; i < offset && i < container.childNodes.length; i++) {
                    const child = container.childNodes[i];
                    absoluteOffset += child.textContent.length;
                }
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

        // Remove any existing modal
        const existingModal = document.querySelector('.note-input-modal');
        if (existingModal) existingModal.remove();

        // Get selection position
        const range = currentSelection;
        const rect = range.getBoundingClientRect();

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'note-input-modal';

        modal.innerHTML = `
            <textarea class="note-textarea" placeholder="Enter your note..." autofocus></textarea>
            <div class="note-input-actions">
                <button class="note-cancel">Cancel</button>
                <button class="note-save">Save</button>
            </div>
        `;

        // Append to body first to get dimensions
        document.body.appendChild(modal);

        // Force reflow to calculate modal dimensions
        const modalWidth = modal.offsetWidth;
        const modalHeight = modal.offsetHeight;

        // Calculate initial position (below selection)
        let modalLeft = rect.left + window.scrollX;
        let modalTop = rect.bottom + window.scrollY + 10;

        // Adjust horizontal position if goes off right edge
        if (modalLeft + modalWidth > window.innerWidth + window.scrollX) {
            modalLeft = window.innerWidth + window.scrollX - modalWidth - 10;
        }

        // Adjust horizontal position if goes off left edge
        if (modalLeft < window.scrollX) {
            modalLeft = window.scrollX + 10;
        }

        // Adjust vertical position if goes off bottom edge
        if (rect.bottom + modalHeight + 10 > window.innerHeight) {
            // Try to place above selection instead
            if (rect.top - modalHeight - 10 > 0) {
                modalTop = rect.top + window.scrollY - modalHeight - 10;
            } else {
                // If doesn't fit above either, place at top of viewport
                modalTop = window.scrollY + 10;
            }
        }

        modal.style.left = `${modalLeft}px`;
        modal.style.top = `${modalTop}px`;

        const textarea = modal.querySelector('.note-textarea');
        const cancelBtn = modal.querySelector('.note-cancel');
        const saveBtn = modal.querySelector('.note-save');

        // Create a temporary highlight overlay to show selected text
        // (can't use real selection because it conflicts with textarea focus)
        const createSelectionOverlay = () => {
            const rects = currentSelection.getClientRects();
            const overlays = [];

            for (let i = 0; i < rects.length; i++) {
                const rect = rects[i];
                const overlay = document.createElement('div');
                overlay.className = 'temp-selection-overlay';
                overlay.style.position = 'absolute';
                overlay.style.left = `${rect.left + window.scrollX}px`;
                overlay.style.top = `${rect.top + window.scrollY}px`;
                overlay.style.width = `${rect.width}px`;
                overlay.style.height = `${rect.height}px`;
                overlay.style.backgroundColor = 'rgba(100, 150, 255, 0.3)';
                overlay.style.pointerEvents = 'none';
                overlay.style.zIndex = '9998'; // Below modal (9999) but above content
                document.body.appendChild(overlay);
                overlays.push(overlay);
            }
            return overlays;
        };

        const selectionOverlays = createSelectionOverlay();

        // Focus textarea
        setTimeout(() => textarea.focus(), 0);

        // Clean up overlays when modal is removed
        const cleanupOverlays = () => {
            selectionOverlays.forEach(overlay => overlay.remove());
        };

        // Cancel handler
        cancelBtn.addEventListener('click', () => {
            cleanupOverlays();
            modal.remove();
            currentSelection = null;
        });

        // Save handler
        const saveNote = () => {
            const noteText = textarea.value.trim();
            if (noteText) {
                applyStyle('has-note', 'span', noteText);
                renderNotesMargin();
            }
            cleanupOverlays();
            modal.remove();
            currentSelection = null;
        };

        saveBtn.addEventListener('click', saveNote);

        // Enter to save (Ctrl+Enter for newline)
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                saveNote();
            }
        });

        // Click outside to close
        setTimeout(() => {
            document.addEventListener('click', function closeModal(e) {
                if (!modal.contains(e.target)) {
                    cleanupOverlays();
                    modal.remove();
                    document.removeEventListener('click', closeModal);
                }
            });
        }, 100);
    }

    function saveAnnotation(annotation) {
        if (window.isSharedAnnotationMode) {
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({
                    type: 'new_annotation',
                    annotation: annotation
                }));
            }
        } else {
            let annotations = JSON.parse(localStorage.getItem(storageKey) || '[]');
            annotations = annotations.filter(a => a.id !== annotation.id);
            annotations.push(annotation);
            localStorage.setItem(storageKey, JSON.stringify(annotations));
        }
    }

    function getNodeByXPath(path) {
        // Elements to skip when resolving XPath (dynamic UI elements)
        const skipIds = new Set(['toc']);
        const skipClasses = new Set(['back-link', 'toc', 'selection-popover', 'note-card-margin', 'note-popup']);

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
            const tagMatch = segment.match(/^([A-Z0-9]+)\[(\d+)\]$/);
            if (!tagMatch) return null;

            const tagName = tagMatch[1];
            let targetIndex = parseInt(tagMatch[2]);

            // Find the nth child of tagName, skipping dynamic elements
            let found = null;
            let count = 0;

            for (let child of current.childNodes) {
                if (child.nodeName === tagName && !shouldSkip(child)) {
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

    function clearAllAnnotationsFromDOM() {
        markdownBody.querySelectorAll('[data-annotation-id]').forEach(el => {
            const parent = el.parentNode;
            while (el.firstChild) {
                parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
            parent.normalize();
        });
        document.querySelectorAll('.note-card-margin').forEach(el => el.remove());
        noteCardsData = [];
    }

    function applyAnnotations(annotationsToApply) {
        const annotations = annotationsToApply || JSON.parse(localStorage.getItem(storageKey) || '[]');

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
            // CRITICAL: Check if this annotation already exists in DOM to prevent duplicates
            const existingElement = markdownBody.querySelector(`[data-annotation-id="${anno.id}"]`);
            if (existingElement) {
                return;
            }

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
                    } else {
                        console.warn('[applyAnnotations] Skipping annotation due to text mismatch:', {
                            annotationId: anno.id,
                            storedText: anno.text,
                            currentText: range.toString(),
                            reason: 'Content may have changed since annotation was created'
                        });
                    }
                } catch (e) {
                    console.warn('Skipping annotation due to error:', anno, e.message);
                }
            }
        });
        renderNotesMargin();
    }


    // Store note card data for scroll updates
    let noteCardsData = [];

    function renderNotesMargin() {

        // Remove existing margin notes
        document.querySelectorAll('.note-card-margin').forEach(el => el.remove());

        // CRITICAL: Get highlight elements directly from DOM to preserve DOM order!
        const allHighlightElements = markdownBody.querySelectorAll('.has-note[data-annotation-id]');

        // CRITICAL: For each .has-note element, use only the outermost one
        // Create a Map: annotationId -> outermost element
        const outermostMap = new Map();

        allHighlightElements.forEach(element => {
            const annoId = element.dataset.annotationId;

            // Check if this element is nested inside another .has-note
            let isNested = false;
            let parent = element.parentElement;
            while (parent && parent !== markdownBody) {
                if (parent.classList && parent.classList.contains('has-note')) {
                    isNested = true;
                    break;
                }
                parent = parent.parentElement;
            }

            // If not nested, or if we haven't seen this annotation yet, record it
            if (!outermostMap.has(annoId)) {
                outermostMap.set(annoId, element);
            } else if (!isNested) {
                // If we've seen it before but this one is NOT nested, prefer this one
                outermostMap.set(annoId, element);
            }
        });

        // Convert map values to array
        const highlightElements = Array.from(outermostMap.values());


        if (highlightElements.length === 0) {
            noteCardsData = [];
            return;
        }

        // Load annotations for getting note content
        const annotations = window.isSharedAnnotationMode ? (window.annotations || []) : JSON.parse(localStorage.getItem(storageKey) || '[]');
        const annotationsMap = new Map(annotations.map(a => [a.id, a]));

        noteCardsData = [];

        // Iterate in DOM order!
        highlightElements.forEach((highlightElement) => {
            const annoId = highlightElement.dataset.annotationId;
            const anno = annotationsMap.get(annoId);

            if (!anno || !anno.note) {
                return;
            }

            const noteCard = document.createElement('div');
            noteCard.className = 'note-card-margin';
            noteCard.dataset.annotationId = anno.id;

            noteCard.innerHTML = `
                <div class="note-actions">
                    <button class="note-edit" data-annotation-id="${anno.id}" title="Edit note">✎</button>
                    <button class="note-delete" data-annotation-id="${anno.id}" title="Delete note">×</button>
                </div>
                <div class="note-content">${anno.note}</div>
            `;

            // Use absolute position - will be positioned relative to document
            noteCard.style.position = 'absolute';

            document.body.appendChild(noteCard);

            noteCardsData.push({
                element: noteCard,
                highlightId: anno.id,
                highlightElement: highlightElement,
                text: anno.text,
                note: anno.note
            });
        });


        // Check screen width for responsive behavior
        if (window.innerWidth > 1400) {
            // Layout notes with physics simulation for wide screens
            layoutNotesWithPhysics();
        } else {
            // Hide all note cards on small screens
            noteCardsData.forEach(noteData => {
                noteData.element.style.display = 'none';
            });
        }
    }

    function layoutNotesWithPhysics() {

        if (noteCardsData.length === 0) {
            return;
        }

        // Force browser reflow to ensure offsetHeight is calculated
        document.body.offsetHeight;

        // Calculate horizontal position (right-aligned)
        const scrollY = window.scrollY || window.pageYOffset;

        // Note card width is 250px (defined in CSS)
        const noteCardWidth = 250;
        const rightMargin = 20; // 20px margin from window edge

        // Position note card: left edge = window width - card width - margin
        const rightEdge = window.innerWidth - noteCardWidth - rightMargin;

        // Prepare note objects with ideal positions
        const notes = noteCardsData.map((noteData, index) => {
            const highlightRect = noteData.highlightElement.getBoundingClientRect();
            const idealTop = highlightRect.top + scrollY;

            // CRITICAL: Ensure we get the actual height
            const height = noteData.element.offsetHeight;
            if (height === 0) {
                console.warn(`[layoutNotesWithPhysics] Note ${index + 1} has zero height! Using fallback.`);
            }
            const actualHeight = height > 0 ? height : 80;

            return {
                element: noteData.element,
                idealTop: idealTop,
                currentTop: idealTop, // Start at ideal position, will add offset for grouped notes
                height: actualHeight,
                index: index,
                id: noteData.highlightId
            };
        });

        // Spacing between notes
        const minSpacing = 10; // Minimum spacing between notes

        // CRITICAL FIX: Use Union-Find clustering algorithm for grouping notes
        // This ensures transitivity: if A and B are close, B and C are close, then A, B, C are all in same group
        const clusterThreshold = 50; // If notes are within 50px, they should be grouped (increased from 30)

        // Union-Find data structure
        class UnionFind {
            constructor(size) {
                this.parent = Array.from({ length: size }, (_, i) => i);
                this.rank = Array(size).fill(0);
            }

            find(x) {
                if (this.parent[x] !== x) {
                    this.parent[x] = this.find(this.parent[x]); // Path compression
                }
                return this.parent[x];
            }

            union(x, y) {
                const rootX = this.find(x);
                const rootY = this.find(y);

                if (rootX === rootY) return;

                // Union by rank
                if (this.rank[rootX] < this.rank[rootY]) {
                    this.parent[rootX] = rootY;
                } else if (this.rank[rootX] > this.rank[rootY]) {
                    this.parent[rootY] = rootX;
                } else {
                    this.parent[rootY] = rootX;
                    this.rank[rootX]++;
                }
            }
        }

        // Create a copy for sorting without modifying original array
        const sortedIndices = notes.map((note, idx) => ({ idx, idealTop: note.idealTop }))
            .sort((a, b) => a.idealTop - b.idealTop);

        // Initialize Union-Find
        const uf = new UnionFind(notes.length);

        // Merge adjacent notes if they are within threshold
        for (let i = 0; i < sortedIndices.length - 1; i++) {
            const curr = sortedIndices[i];
            const next = sortedIndices[i + 1];

            if (Math.abs(next.idealTop - curr.idealTop) <= clusterThreshold) {
                uf.union(curr.idx, next.idx);
            }
        }

        // Group notes by cluster (root of Union-Find tree)
        const clusters = new Map();
        notes.forEach((note, idx) => {
            const root = uf.find(idx);
            if (!clusters.has(root)) {
                clusters.set(root, []);
            }
            clusters.get(root).push(idx);
        });


        // Pre-position notes: stack notes in same cluster vertically
        clusters.forEach((indices) => {
            if (indices.length > 1) {
                // Multiple notes in same cluster - stack them
                // Start from the minimum idealTop in this cluster
                const minIdealTop = Math.min(...indices.map(idx => notes[idx].idealTop));
                let currentTop = minIdealTop;

                // Sort indices by original order to maintain consistency
                indices.sort((a, b) => a - b);

                indices.forEach(noteIndex => {
                    notes[noteIndex].currentTop = currentTop;
                    currentTop += notes[noteIndex].height + minSpacing;
                });
            }
        });

        // DISABLED: Physics simulation - relying purely on clustering-based pre-positioning
        // The physics simulation was causing clustered notes to spread apart
        // Now we only use the Union-Find clustering to stack notes vertically

        // Post-process: Ensure minimum spacing for ALL notes
        // For notes with similar ideal positions (within threshold), enforce vertical stacking
        const idealPositionThreshold = 50; // If ideal positions are within 50px, they are "grouped"

        // Process notes in DOM order (by index)
        for (let i = 1; i < notes.length; i++) {
            const prev = notes[i - 1];
            const curr = notes[i];

            // Check if their IDEAL positions are significantly different
            const idealGap = Math.abs(curr.idealTop - prev.idealTop);

            if (idealGap <= idealPositionThreshold) {
                // Notes are in the same "group" (same/similar position)
                // Enforce strict vertical stacking with minimum spacing
                const minAllowedTop = prev.currentTop + prev.height + minSpacing;
                if (curr.currentTop < minAllowedTop) {
                    curr.currentTop = minAllowedTop;
                }
            } else {
                // Notes are separated, but still enforce minimum spacing
                const minAllowedTop = prev.currentTop + prev.height + minSpacing;
                if (curr.currentTop < minAllowedTop) {
                    curr.currentTop = minAllowedTop;
                }
            }
        }

        // Apply final positions
        notes.forEach((note) => {
            note.element.style.left = `${rightEdge}px`;
            note.element.style.top = `${note.currentTop}px`;
            note.element.style.display = 'block';
        });

    }

    // Window resize listener with debounce for smooth transitions
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (noteCardsData.length > 0) {
                // Check if crossing the 1400px threshold
                if (window.innerWidth > 1400) {
                    // Wide screen: show margin notes with physics layout
                    noteCardsData.forEach(noteData => {
                        noteData.element.style.display = 'block';
                    });
                    layoutNotesWithPhysics();

                    // Close any open popup
                    const existingPopup = document.querySelector('.note-popup');
                    if (existingPopup) {
                        existingPopup.remove();
                    }
                } else {
                    // Narrow screen: hide all margin notes, will show popup on click
                    noteCardsData.forEach(noteData => {
                        noteData.element.style.display = 'none';
                    });
                }
            }
        }, 150); // 150ms debounce for smooth transition
    });

    function removeHighlight() {
        if (!currentHighlightedElement) return;

        const annotationId = currentHighlightedElement.dataset.annotationId;
        if (!annotationId) return;

        // Remove annotation
        deleteAnnotation(annotationId);

        // Clear selection and state
        window.getSelection().removeAllRanges();
        currentHighlightedElement = null;
        currentSelection = null;
    }

    function deleteAnnotation(annotationId) {

        if (window.isSharedAnnotationMode) {
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({
                    type: 'delete_annotation',
                    id: annotationId
                }));
            }
        } else {
            // Remove from localStorage
            let annotations = JSON.parse(localStorage.getItem(storageKey) || '[]');
            annotations = annotations.filter(a => a.id !== annotationId);
            localStorage.setItem(storageKey, JSON.stringify(annotations));
            removeAnnotationFromDOM(annotationId);
            renderNotesMargin();
        }
    }

    // Function to remove annotation elements from the DOM
    function removeAnnotationFromDOM(annotationId) {
        // Remove highlight from DOM
        const highlightElements = markdownBody.querySelectorAll(`[data-annotation-id="${annotationId}"]`);

        highlightElements.forEach((highlightElement) => {
            // Only remove if this is the direct element with this annotation ID
            // (not a parent element that happens to contain nested annotations)
            if (highlightElement.dataset.annotationId === annotationId) {
                const parent = highlightElement.parentNode;

                // Move all children out of the element, preserving nested annotations
                while (highlightElement.firstChild) {
                    parent.insertBefore(highlightElement.firstChild, highlightElement);
                }

                // Remove the now-empty highlight element
                parent.removeChild(highlightElement);
                parent.normalize(); // Merge adjacent text nodes
            }
        });

        // Remove note card from DOM if exists
        const noteCard = document.querySelector(`.note-card-margin[data-annotation-id="${annotationId}"]`);
        if (noteCard) {
            noteCard.remove();
        }

        // Update noteCardsData
        noteCardsData = noteCardsData.filter(n => n.highlightId !== annotationId);


        // CRITICAL: Re-render note cards after deletion to update remaining notes
        // This is especially important for nested annotations
        renderNotesMargin();
    }

    function editNote(annotationId) {
        // Load annotation from storage
        const annotations = window.isSharedAnnotationMode ? (window.annotations || []) : JSON.parse(localStorage.getItem(storageKey) || '[]');
        const annotation = annotations.find(a => a.id === annotationId);

        if (!annotation || !annotation.note) {
            console.warn('[editNote] Note not found for annotation:', annotationId);
            return;
        }

        // Find the highlight element to position modal near it
        const highlightElement = markdownBody.querySelector(`[data-annotation-id="${annotationId}"]`);
        if (!highlightElement) {
            console.warn('[editNote] Highlight element not found for annotation:', annotationId);
            return;
        }

        // Remove any existing modal
        const existingModal = document.querySelector('.note-input-modal');
        if (existingModal) existingModal.remove();

        // Get highlight element position
        const rect = highlightElement.getBoundingClientRect();

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'note-input-modal';

        modal.innerHTML = `
            <textarea class="note-textarea" placeholder="Enter your note..." autofocus></textarea>
            <div class="note-input-actions">
                <button class="note-cancel">Cancel</button>
                <button class="note-save">Save</button>
            </div>
        `;

        // Append to body first to get dimensions
        document.body.appendChild(modal);

        // Pre-fill textarea with existing note content
        const textarea = modal.querySelector('.note-textarea');
        textarea.value = annotation.note;

        // Force reflow to calculate modal dimensions
        const modalWidth = modal.offsetWidth;
        const modalHeight = modal.offsetHeight;

        // Calculate initial position (below highlight)
        let modalLeft = rect.left + window.scrollX;
        let modalTop = rect.bottom + window.scrollY + 10;

        // Adjust horizontal position if goes off right edge
        if (modalLeft + modalWidth > window.innerWidth + window.scrollX) {
            modalLeft = window.innerWidth + window.scrollX - modalWidth - 10;
        }

        // Adjust horizontal position if goes off left edge
        if (modalLeft < window.scrollX) {
            modalLeft = window.scrollX + 10;
        }

        // Adjust vertical position if goes off bottom edge
        if (rect.bottom + modalHeight + 10 > window.innerHeight) {
            // Try to place above highlight instead
            if (rect.top - modalHeight - 10 > 0) {
                modalTop = rect.top + window.scrollY - modalHeight - 10;
            } else {
                // If doesn't fit above either, place at top of viewport
                modalTop = window.scrollY + 10;
            }
        }

        modal.style.left = `${modalLeft}px`;
        modal.style.top = `${modalTop}px`;

        const cancelBtn = modal.querySelector('.note-cancel');
        const saveBtn = modal.querySelector('.note-save');

        // Focus textarea and select all text for easy editing
        setTimeout(() => {
            textarea.focus();
            textarea.select();
        }, 0);

        // Cancel handler
        cancelBtn.addEventListener('click', () => {
            modal.remove();
        });

        // Save handler
        const saveNote = () => {
            const noteText = textarea.value.trim();
            if (noteText) {
                // Update annotation in storage
                annotation.note = noteText;
                saveAnnotation(annotation);

                // Update DOM element's data attribute
                if (highlightElement) {
                    highlightElement.dataset.note = noteText;
                }

                // Re-render note cards to show updated content
                renderNotesMargin();

            } else {
                // If note is empty, delete the annotation
                deleteAnnotation(annotationId);
            }
            modal.remove();
        };

        saveBtn.addEventListener('click', saveNote);

        // Enter to save (Ctrl+Enter for newline)
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                saveNote();
            }
        });

        // Click outside to close
        setTimeout(() => {
            document.addEventListener('click', function closeModal(e) {
                if (!modal.contains(e.target)) {
                    modal.remove();
                    document.removeEventListener('click', closeModal);
                }
            });
        }, 100);
    }

    function deleteNote(annotationId) {
        // Wrapper for backward compatibility
        deleteAnnotation(annotationId);
    }

    function setupNoteClickHandlers() {
        // Click on highlight text -> show note
        document.body.addEventListener('click', (e) => {
            let target = e.target;

            // Handle edit button clicks
            if (target.classList.contains('note-edit')) {
                const annotationId = target.dataset.annotationId;
                editNote(annotationId);
                e.stopPropagation();
                return;
            }

            // Handle delete button clicks
            if (target.classList.contains('note-delete')) {
                const annotationId = target.dataset.annotationId;
                showConfirmDialog('Delete this note?', () => {
                    deleteNote(annotationId);
                }, target, 'Delete');
                e.stopPropagation();
                return;
            }

            // Handle clicks on has-note elements
            if (target.classList.contains('has-note')) {
                const annotationId = target.dataset.annotationId;

                // Clear previous highlights
                document.querySelectorAll('.has-note.highlight-active').forEach(el => {
                    el.classList.remove('highlight-active');
                });
                document.querySelectorAll('.note-card-margin.highlight-active').forEach(el => {
                    el.classList.remove('highlight-active');
                });

                // Highlight the clicked element
                target.classList.add('highlight-active');

                if (window.innerWidth > 1400) {
                    // Wide screen: highlight corresponding note card
                    const noteCard = document.querySelector(`.note-card-margin[data-annotation-id="${annotationId}"]`);
                    if (noteCard) {
                        noteCard.classList.add('highlight-active');

                        // Scroll note into view if needed
                        const noteRect = noteCard.getBoundingClientRect();
                        if (noteRect.top < 0 || noteRect.bottom > window.innerHeight) {
                            noteCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                } else {
                    // Small screen: show floating popup
                    showNotePopup(target, annotationId);
                }

                e.stopPropagation();
            }

            // Handle clicks on note cards (wide screen only)
            if (target.closest('.note-card-margin')) {
                const noteCard = target.closest('.note-card-margin');
                const annotationId = noteCard.dataset.annotationId;

                // Skip if clicking on action buttons
                if (target.classList.contains('note-edit') || target.classList.contains('note-delete')) {
                    return;
                }

                // Clear previous highlights
                document.querySelectorAll('.has-note.highlight-active').forEach(el => {
                    el.classList.remove('highlight-active');
                });
                document.querySelectorAll('.note-card-margin.highlight-active').forEach(el => {
                    el.classList.remove('highlight-active');
                });

                // Highlight clicked note card
                noteCard.classList.add('highlight-active');

                // Find and highlight corresponding text
                const highlightElement = document.querySelector(`.has-note[data-annotation-id="${annotationId}"]`);
                if (highlightElement) {
                    highlightElement.classList.add('highlight-active');

                    // Scroll text into view
                    highlightElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }

                e.stopPropagation();
            }

            // Click outside - clear all highlights and close popup
            if (!target.classList.contains('has-note') && !target.closest('.note-card-margin') && !target.closest('.note-popup')) {
                document.querySelectorAll('.has-note.highlight-active').forEach(el => {
                    el.classList.remove('highlight-active');
                });
                document.querySelectorAll('.note-card-margin.highlight-active').forEach(el => {
                    el.classList.remove('highlight-active');
                });

                // Close any open popup
                const existingPopup = document.querySelector('.note-popup');
                if (existingPopup) {
                    existingPopup.remove();
                }
            }
        });
    }

    function showNotePopup(highlightElement, annotationId) {
        // Remove any existing popup
        const existingPopup = document.querySelector('.note-popup');
        if (existingPopup) existingPopup.remove();

        // Find note data
        const noteData = noteCardsData.find(n => n.highlightId === annotationId);
        if (!noteData) return;

        // Create popup
        const popup = document.createElement('div');
        popup.className = 'note-popup';
        popup.dataset.annotationId = annotationId;
        popup.innerHTML = `
            <div class="note-actions">
                <button class="note-edit" data-annotation-id="${annotationId}" title="Edit note">✎</button>
                <button class="note-delete" data-annotation-id="${annotationId}" title="Delete note">×</button>
            </div>
            <div class="note-content">${noteData.note}</div>
        `;

        // Position near the highlight element
        const rect = highlightElement.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${rect.bottom + 10}px`;

        document.body.appendChild(popup);

        // Adjust position if popup goes off screen
        const popupRect = popup.getBoundingClientRect();
        if (popupRect.right > window.innerWidth) {
            popup.style.left = `${window.innerWidth - popupRect.width - 10}px`;
        }
        if (popupRect.bottom > window.innerHeight) {
            popup.style.top = `${rect.top - popupRect.height - 10}px`;
        }

        // Make popup draggable
        makeDraggable(popup);
    }

    function makePopoverDraggable(element, storageKey) {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const dragStart = (e) => {
            if (e.target.tagName === 'BUTTON') return;

            isDragging = true;

            const { pageX, pageY } = e.type === 'touchstart' ? e.touches[0] : e;
            startX = pageX;
            startY = pageY;

            initialLeft = element.offsetLeft;
            initialTop = element.offsetTop;

            element.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        };

        const dragMove = (e) => {
            if (!isDragging) return;

            const { pageX, pageY } = e.type === 'touchmove' ? e.touches[0] : e;
            const dx = pageX - startX;
            const dy = pageY - startY;

            element.style.left = `${initialLeft + dx}px`;
            element.style.top = `${initialTop + dy}px`;
        };

        const dragEnd = () => {.
            if (isDragging) {
                isDragging = false;
                element.style.cursor = 'grab';
                document.body.style.userSelect = '';

                const finalLeft = element.offsetLeft;
                const finalTop = element.offsetTop;
                const originalLeft = parseFloat(element.dataset.originalLeft);
                const originalTop = parseFloat(element.dataset.originalTop);

                if (!isNaN(originalLeft) && !isNaN(originalTop)) {
                    const offset = {
                        dx: finalLeft - originalLeft,
                        dy: finalTop - originalTop,
                    };
                    localStorage.setItem(storageKey, JSON.stringify(offset));
                }
            }
        };

        element.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', dragMove);
        document.addEventListener('mouseup', dragEnd);

        element.addEventListener('touchstart', dragStart, { passive: false });
        document.addEventListener('touchmove', dragMove, { passive: false });
        document.addEventListener('touchend', dragEnd);
    }

    function makeDraggable(element) {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        element.addEventListener('mousedown', (e) => {
            // Don't drag if clicking on delete button
            if (e.target.classList.contains('note-delete')) {
                return;
            }

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;

            const rect = element.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            element.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            element.style.left = `${initialLeft + dx}px`;
            element.style.top = `${initialTop + dy}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                element.style.cursor = 'move';
            }
        });
    }

    const tocContainer = document.getElementById('toc-container');
    const tocIcon = document.getElementById('toc-icon');

    if (tocContainer && tocIcon) {
        const tocMenu = tocContainer.querySelector('.toc');

        // Prevent scroll propagation from TOC menu to page
        if (tocMenu) {
            // Prevent wheel events from propagating
            tocMenu.addEventListener('wheel', (e) => {
                const isScrollable = tocMenu.scrollHeight > tocMenu.clientHeight;
                if (!isScrollable) return;

                const atTop = tocMenu.scrollTop === 0;
                const atBottom = tocMenu.scrollTop + tocMenu.clientHeight >= tocMenu.scrollHeight;

                // Prevent propagation if scrolling within bounds
                if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
                    e.stopPropagation();
                }
            }, { passive: false });

            // Prevent touch scroll from propagating
            let touchStartY = 0;
            tocMenu.addEventListener('touchstart', (e) => {
                touchStartY = e.touches[0].clientY;
            }, { passive: true });

            tocMenu.addEventListener('touchmove', (e) => {
                const isScrollable = tocMenu.scrollHeight > tocMenu.clientHeight;
                if (!isScrollable) return;

                const touchY = e.touches[0].clientY;
                const deltaY = touchStartY - touchY;

                const atTop = tocMenu.scrollTop === 0;
                const atBottom = tocMenu.scrollTop + tocMenu.clientHeight >= tocMenu.scrollHeight;

                // Prevent propagation if scrolling within bounds
                if ((deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom)) {
                    e.stopPropagation();
                }
            }, { passive: false });
        }

        // Toggle TOC on click/tap - handle both mouse and touch events
        const toggleToc = (e) => {
            tocContainer.classList.toggle('active');
            e.stopPropagation();
            e.preventDefault();
        };

        tocIcon.addEventListener('click', toggleToc);
        tocIcon.addEventListener('touchend', toggleToc);

        // Close TOC when clicking outside
        const closeToc = (e) => {
            if (tocContainer.classList.contains('active') && !tocContainer.contains(e.target)) {
                tocContainer.classList.remove('active');
            }
        };

        document.addEventListener('click', closeToc);
        document.addEventListener('touchend', closeToc);
    }
});