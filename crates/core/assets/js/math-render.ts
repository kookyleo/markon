interface KatexOptions {
    displayMode: boolean;
    throwOnError: boolean;
    strict: 'ignore' | 'warn' | 'error';
    trust: boolean;
}

interface KatexGlobal {
    render: (tex: string, element: Element, options: KatexOptions) => void;
}

declare global {
    interface Window {
        katex?: KatexGlobal;
        markonRenderMath?: (root?: ParentNode) => void;
    }
}

function sourceFor(element: Element): string {
    return element.textContent?.trim() ?? '';
}

export function renderMathIn(root: ParentNode = document): void {
    const katex = window.katex;
    if (!katex) return;

    root.querySelectorAll<HTMLElement>('.math:not([data-math-rendered="true"])').forEach((element) => {
        const tex = sourceFor(element);
        if (!tex) return;
        const displayMode = element.dataset['mathDisplay'] === 'true';
        element.dataset['mathSource'] = tex;
        try {
            katex.render(tex, element, {
                displayMode,
                throwOnError: false,
                strict: 'ignore',
                trust: false,
            });
            element.dataset['mathRendered'] = 'true';
        } catch {
            element.classList.add('math-error');
        }
    });
}

window.markonRenderMath = renderMathIn;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => renderMathIn(document), { once: true });
} else {
    renderMathIn(document);
}

