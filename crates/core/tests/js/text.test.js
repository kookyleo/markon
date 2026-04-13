import { describe, it, expect } from 'vitest';
import { Text } from '../../assets/js/services/text.js';

describe('Text.normalize', () => {
  it('collapses whitespace and trims', () => {
    expect(Text.normalize('  foo   bar  ')).toBe('foo bar');
  });

  it('normalizes tabs and newlines', () => {
    expect(Text.normalize('a\t\nb')).toBe('a b');
  });

  it('handles empty string', () => {
    expect(Text.normalize('')).toBe('');
  });

  it('handles single word', () => {
    expect(Text.normalize('  hello  ')).toBe('hello');
  });
});

describe('Text.decodeEntities', () => {
  it('decodes lt and gt', () => {
    expect(Text.decodeEntities('&lt;p&gt;')).toBe('<p>');
  });

  it('decodes amp', () => {
    expect(Text.decodeEntities('a &amp; b')).toBe('a & b');
  });

  it('decodes quot and apos', () => {
    expect(Text.decodeEntities('&quot;hello&#39;')).toBe('"hello\'');
  });

  it('handles mixed entities and plain text', () => {
    expect(Text.decodeEntities('1 &lt; 2 &amp; 3 &gt; 0')).toBe('1 < 2 & 3 > 0');
  });

  it('passes through text without entities', () => {
    expect(Text.decodeEntities('plain text')).toBe('plain text');
  });
});

describe('Text.escape', () => {
  it('escapes HTML special characters', () => {
    const result = Text.escape('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;');
  });

  it('preserves plain text', () => {
    expect(Text.escape('hello world')).toBe('hello world');
  });
});
