export const SECTION_CLASS = 'heading-section';
export const FOCUSED_CLASS = 'heading-focused';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

export function clearHeadingFocus(root = document) {
  const focused = root.querySelectorAll(`.${FOCUSED_CLASS}`);
  focused.forEach(element => element.classList.remove(FOCUSED_CLASS));
  return focused.length;
}

export function focusedHeading(root = document) {
  return root.querySelector(`.${FOCUSED_CLASS}`);
}

function sectionTopMargin() {
  const navigationBottom = [...document.querySelectorAll('.VPNav, .VPLocalNav')]
    .filter(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0;
    })
    .reduce((bottom, element) => Math.max(bottom, element.getBoundingClientRect().bottom), 0);

  // Keep the focused heading visually separated from the fixed navigation.
  return Math.max(64, navigationBottom + 32);
}

export function smartScrollToHeading(heading) {
  const section = heading?.closest?.(`.${SECTION_CLASS}`) || heading;
  if (!(section instanceof HTMLElement)) return;

  const targetY = section.getBoundingClientRect().top + window.scrollY - sectionTopMargin();
  window.scrollTo({ top: targetY, behavior: 'smooth' });
}

export function focusHeading(heading, { scroll = false } = {}) {
  if (!(heading instanceof HTMLElement)) return false;
  clearHeadingFocus();
  heading.classList.add(FOCUSED_CLASS);
  if (scroll) smartScrollToHeading(heading);
  return true;
}

export function navigateHeadings(headings, direction) {
  const visibleHeadings = headings.filter(heading => (
    heading instanceof HTMLElement && heading.offsetParent !== null
  ));
  if (!visibleHeadings.length) return null;

  const current = focusedHeading();
  const currentIndex = visibleHeadings.indexOf(current);
  let target = null;

  if (currentIndex >= 0) {
    if (direction === 'next' && currentIndex < visibleHeadings.length - 1) {
      target = visibleHeadings[currentIndex + 1];
    } else if (direction === 'prev' && currentIndex > 0) {
      target = visibleHeadings[currentIndex - 1];
    }
  } else {
    // Match Markon: either j or k enters section navigation at the first heading.
    target = visibleHeadings[0];
  }

  if (target) focusHeading(target, { scroll: true });
  return target;
}

export function buildHeadingSections(root) {
  if (!(root instanceof HTMLElement)) return [];

  const originalNodes = [...root.childNodes];
  const stack = [];
  const sections = [];

  for (const node of originalNodes) {
    const isHeading = node instanceof HTMLElement && node.matches(HEADING_SELECTOR);
    if (isHeading) {
      const level = Number(node.tagName.slice(1));
      while (stack.length && stack.at(-1).level >= level) stack.pop();

      const section = document.createElement('div');
      section.className = SECTION_CLASS;
      section.dataset.level = String(level);
      (stack.at(-1)?.section || root).appendChild(section);
      section.appendChild(node);
      stack.push({ level, section });
      sections.push(section);
      continue;
    }

    (stack.at(-1)?.section || root).appendChild(node);
  }

  return sections;
}

export function unwrapHeadingSections(root) {
  if (!(root instanceof HTMLElement)) return;
  const sections = [...root.querySelectorAll(`.${SECTION_CLASS}[data-level]`)].reverse();
  for (const section of sections) {
    if (!section.parentNode) continue;
    while (section.firstChild) section.parentNode.insertBefore(section.firstChild, section);
    section.remove();
  }
}
