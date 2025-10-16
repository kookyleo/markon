document.addEventListener('DOMContentLoaded', () => {
    const filePathMeta = document.querySelector('meta[name="file-path"]');
    if (!filePathMeta) return;

    const filePath = filePathMeta.getAttribute('content');
    const storageKey = `markon-annotations-${filePath}`;
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
        if (popover.contains(e.target)) return;

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
            if (!action) return; // Clicked on popover background, not a button

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

        // Remove any existing modal
        const existingModal = document.querySelector('.note-input-modal');
        if (existingModal) existingModal.remove();

        // Get selection position
        const range = currentSelection;
        const rect = range.getBoundingClientRect();

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'note-input-modal';

        // Position modal below selection
        const modalLeft = rect.left + window.scrollX;
        const modalTop = rect.bottom + window.scrollY + 10;

        modal.style.left = `${modalLeft}px`;
        modal.style.top = `${modalTop}px`;

        modal.innerHTML = `
            <textarea class="note-textarea" placeholder="输入你的想法..." autofocus></textarea>
            <div class="note-input-actions">
                <button class="note-cancel">取消</button>
                <button class="note-save">保存</button>
            </div>
        `;

        document.body.appendChild(modal);

        const textarea = modal.querySelector('.note-textarea');
        const cancelBtn = modal.querySelector('.note-cancel');
        const saveBtn = modal.querySelector('.note-save');

        // Focus textarea
        setTimeout(() => textarea.focus(), 0);

        // Cancel handler
        cancelBtn.addEventListener('click', () => {
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
                    modal.remove();
                    document.removeEventListener('click', closeModal);
                }
            });
        }, 100);
    }

    function saveAnnotation(annotation) {
        let annotations = JSON.parse(localStorage.getItem(storageKey) || '[]');
        annotations = annotations.filter(a => a.id !== annotation.id);
        annotations.push(annotation);
        localStorage.setItem(storageKey, JSON.stringify(annotations));
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
        renderNotesMargin();
    }


    // Store note card data for scroll updates
    let noteCardsData = [];

    function renderNotesMargin() {
        console.log('[renderNotesMargin] Starting...');

        // Remove existing margin notes
        document.querySelectorAll('.note-card-margin').forEach(el => el.remove());

        // CRITICAL: Get highlight elements directly from DOM to preserve DOM order!
        const highlightElements = markdownBody.querySelectorAll('.has-note[data-annotation-id]');
        console.log('[renderNotesMargin] Found highlight elements in DOM:', highlightElements.length);

        if (highlightElements.length === 0) {
            noteCardsData = [];
            console.log('[renderNotesMargin] No highlight elements found, exiting');
            return;
        }

        // Load annotations for getting note content
        const annotations = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const annotationsMap = new Map(annotations.map(a => [a.id, a]));

        noteCardsData = [];

        // Iterate in DOM order!
        highlightElements.forEach((highlightElement, index) => {
            const annoId = highlightElement.dataset.annotationId;
            const anno = annotationsMap.get(annoId);

            console.log(`[renderNotesMargin] Processing DOM element ${index + 1}, ID:`, annoId);

            if (!anno || !anno.note) {
                console.log(`[renderNotesMargin] No note data for ${annoId}, skipping`);
                return;
            }

            const noteCard = document.createElement('div');
            noteCard.className = 'note-card-margin';
            noteCard.dataset.annotationId = anno.id;

            noteCard.innerHTML = `
                <div class="note-quote">"${anno.text}"</div>
                <div class="note-content">${anno.note}</div>
            `;

            // Use absolute position - will be positioned relative to document
            noteCard.style.position = 'absolute';

            document.body.appendChild(noteCard);
            console.log(`[renderNotesMargin] Note card appended to body`);

            noteCardsData.push({
                element: noteCard,
                highlightId: anno.id,
                highlightElement: highlightElement,
                text: anno.text,
                note: anno.note
            });
        });

        console.log('[renderNotesMargin] Total note cards created:', noteCardsData.length);

        // Check screen width for responsive behavior
        if (window.innerWidth > 1400) {
            console.log('[renderNotesMargin] Wide screen - showing margin notes');
            // Layout notes with physics simulation for wide screens
            layoutNotesWithPhysics();
        } else {
            console.log('[renderNotesMargin] Narrow screen - hiding margin notes, will show on click');
            // Hide all note cards on small screens
            noteCardsData.forEach(noteData => {
                noteData.element.style.display = 'none';
            });
        }
    }

    function layoutNotesWithPhysics() {
        console.log('[layoutNotesWithPhysics] Starting physics simulation...');

        if (noteCardsData.length === 0) {
            console.log('[layoutNotesWithPhysics] No note cards, exiting');
            return;
        }

        // Force browser reflow to ensure offsetHeight is calculated
        document.body.offsetHeight;

        // Calculate horizontal position (constant for all notes)
        const bodyRect = markdownBody.getBoundingClientRect();
        const scrollY = window.scrollY || window.pageYOffset;
        const rightEdge = bodyRect.left + bodyRect.width + 20;

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
                currentTop: idealTop, // Start at ideal position
                height: actualHeight,
                index: index
            };
        });

        console.log('[layoutNotesWithPhysics] Initial note positions:', notes.map(n => ({
            index: n.index,
            idealTop: n.idealTop,
            height: n.height
        })));

        // Physics simulation parameters
        const minSpacing = 10; // Minimum spacing between notes
        const springConstant = 0.2; // How strongly notes return to ideal position
        const repulsionStrength = 1.0; // How strongly notes push each other away
        const maxIterations = 100; // Maximum simulation steps
        const convergenceThreshold = 0.1; // Stop when movement is less than this

        // Run physics simulation
        for (let iteration = 0; iteration < maxIterations; iteration++) {
            let maxMovement = 0;

            // Sort notes by current position for easier overlap detection
            const sortedNotes = [...notes].sort((a, b) => a.currentTop - b.currentTop);

            // Calculate forces for each note
            notes.forEach((note, i) => {
                let force = 0;

                // Spring force: pull toward ideal position
                const displacement = note.idealTop - note.currentTop;
                force += displacement * springConstant;

                // Repulsion force: check all other notes
                sortedNotes.forEach((other) => {
                    if (note.index === other.index) return;

                    // Calculate positions
                    const noteBottom = note.currentTop + note.height;
                    const otherBottom = other.currentTop + other.height;

                    // Calculate gap: positive means separated, negative means overlapping
                    let gap;
                    if (note.currentTop < other.currentTop) {
                        // Note is above other
                        gap = other.currentTop - noteBottom;
                    } else {
                        // Note is below other
                        gap = note.currentTop - otherBottom;
                    }

                    // If gap < minSpacing, apply repulsion force
                    if (gap < minSpacing) {
                        const penetration = minSpacing - gap;

                        if (note.currentTop < other.currentTop) {
                            // Note is above, push it up
                            force -= penetration * repulsionStrength;
                        } else {
                            // Note is below, push it down
                            force += penetration * repulsionStrength;
                        }

                        if (iteration === 0 || penetration > 1) {
                            console.log(`[layoutNotesWithPhysics] Iteration ${iteration + 1}: Note ${note.index + 1} too close to Note ${other.index + 1}, gap=${gap.toFixed(1)}px, needed=${minSpacing}px, penetration=${penetration.toFixed(1)}`);
                        }
                    }
                });

                // Update position
                const movement = force;
                note.currentTop += movement;
                maxMovement = Math.max(maxMovement, Math.abs(movement));
            });

            // Check convergence
            if (maxMovement < convergenceThreshold) {
                console.log(`[layoutNotesWithPhysics] Converged at iteration ${iteration + 1}, maxMovement=${maxMovement.toFixed(2)}`);
                break;
            }

            if (iteration === maxIterations - 1) {
                console.log(`[layoutNotesWithPhysics] Reached max iterations (${maxIterations}), maxMovement=${maxMovement.toFixed(2)}`);
            }
        }

        // Apply final positions
        notes.forEach((note, i) => {
            note.element.style.left = `${rightEdge}px`;
            note.element.style.top = `${note.currentTop}px`;
            note.element.style.display = 'block';

            console.log(`[layoutNotesWithPhysics] Note ${i + 1} final position: ideal=${note.idealTop.toFixed(0)}, actual=${note.currentTop.toFixed(0)}, offset=${(note.currentTop - note.idealTop).toFixed(1)}`);
        });

        console.log('[layoutNotesWithPhysics] Physics simulation complete');
    }

    // Window resize listener - recalculate positions when window size changes
    window.addEventListener('resize', () => {
        if (noteCardsData.length > 0) {
            layoutNotesWithPhysics();
        }
    });

    function setupNoteClickHandlers() {
        // Click on highlight text -> show note
        document.body.addEventListener('click', (e) => {
            let target = e.target;

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
        popup.innerHTML = `
            <div class="note-quote">"${noteData.text}"</div>
            <div class="note-content">${noteData.note}</div>
        `;

        // Position near the highlight element
        const rect = highlightElement.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${rect.bottom + 10}px`;
        popup.style.maxWidth = '300px';
        popup.style.background = '#f6f8fa';
        popup.style.border = '1px solid #0969da';
        popup.style.borderRadius = '6px';
        popup.style.padding = '12px 16px';
        popup.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
        popup.style.zIndex = '9999';
        popup.style.fontSize = '13px';
        popup.style.lineHeight = '1.6';

        document.body.appendChild(popup);

        // Adjust position if popup goes off screen
        const popupRect = popup.getBoundingClientRect();
        if (popupRect.right > window.innerWidth) {
            popup.style.left = `${window.innerWidth - popupRect.width - 10}px`;
        }
        if (popupRect.bottom > window.innerHeight) {
            popup.style.top = `${rect.top - popupRect.height - 10}px`;
        }
    }
});