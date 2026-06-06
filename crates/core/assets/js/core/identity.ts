/**
 * Per-device collaboration identity: a colour + optional nickname, persisted in
 * localStorage and shared by both Live presence and shared-annotation
 * authorship. No accounts — this is lightweight attribution, not auth.
 *
 * The colour reuses the existing `markon-user-color` key (formerly "Live
 * colour"), so a device that already picked a Live colour keeps it as its
 * annotation author colour. The palette lives in `CONFIG.COLLABORATION.COLORS`
 * (runtime identity data, deliberately NOT a design token).
 */
import { CONFIG } from './config';

const COLOR_KEY = CONFIG.STORAGE_KEYS.LIVE_COLOR;
const NAME_KEY = CONFIG.STORAGE_KEYS.IDENTITY_NAME;

/** Author stamp snapshotted onto each annotation at creation. */
export interface Author {
    color: string;
    /** Optional nickname; omitted when unset. */
    name?: string;
}

function pickDefaultColor(): string {
    const palette = CONFIG.COLLABORATION.COLORS;
    const idx = Math.floor(Math.random() * palette.length);
    return palette[idx] ?? palette[0] ?? '#3451B2';
}

export const Identity = {
    /** The device's colour; auto-assigns and persists one on first read. */
    color(): string {
        let c = localStorage.getItem(COLOR_KEY);
        if (!c) {
            c = pickDefaultColor();
            localStorage.setItem(COLOR_KEY, c);
        }
        return c;
    },

    setColor(color: string): void {
        localStorage.setItem(COLOR_KEY, color);
    },

    /** Optional nickname; empty string when unset. */
    name(): string {
        return localStorage.getItem(NAME_KEY) ?? '';
    },

    setName(name: string): void {
        const trimmed = name.trim();
        if (trimmed) {
            localStorage.setItem(NAME_KEY, trimmed);
        } else {
            localStorage.removeItem(NAME_KEY);
        }
    },

    /** Author stamp for a newly created annotation. Name omitted when unset. */
    author(): Author {
        const author: Author = { color: this.color() };
        const name = this.name();
        if (name) {
            author.name = name;
        }
        return author;
    },
};
