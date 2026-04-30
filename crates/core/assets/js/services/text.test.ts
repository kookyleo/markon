import { describe, it, expect } from 'vitest';
import { Text } from './text.js';

describe('Text.normalize', () => {
    it('collapses runs of whitespace and trims edges', () => {
        expect(Text.normalize('  hello   world  ')).toBe('hello world');
    });

    it('handles empty / whitespace-only / unicode / mixed whitespace', () => {
        expect(Text.normalize('')).toBe('');
        expect(Text.normalize('   \t\n  ')).toBe('');
        expect(Text.normalize('  你好\t\n世界  ')).toBe('你好 世界');
        // \s matches a wide variety of whitespace; consecutive runs collapse to a single space
        expect(Text.normalize('a\t\n\r b')).toBe('a b');
    });
});

describe('Text.decodeEntities', () => {
    it('decodes the supported entity set', () => {
        expect(Text.decodeEntities('&lt;b&gt;&quot;hi&quot;&amp;&#39;ok&#39;&lt;/b&gt;'))
            .toBe('<b>"hi"&\'ok\'</b>');
    });

    it('passes through strings without entities and handles empty', () => {
        expect(Text.decodeEntities('')).toBe('');
        expect(Text.decodeEntities('plain text 你好')).toBe('plain text 你好');
    });
});

describe('Text.escape', () => {
    it('escapes < > & in text', () => {
        const out = Text.escape('<script>alert("x" & \'y\')</script>');
        // jsdom's innerHTML serialization
        expect(out).toContain('&lt;script&gt;');
        expect(out).toContain('&lt;/script&gt;');
        expect(out).toContain('&amp;');
    });

    it('handles empty and unicode', () => {
        expect(Text.escape('')).toBe('');
        expect(Text.escape('你好 world')).toBe('你好 world');
    });
});
