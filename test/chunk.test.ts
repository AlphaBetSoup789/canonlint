import { describe, expect, it } from 'vitest';
import { chunkCorpus, chunkText } from '../src/ingest/chunk.js';

describe('chunkText', () => {
  it('splits on markdown chapter headers', () => {
    const text = [
      '# Title',
      '',
      '## Chapter 1',
      '',
      'Alpha beta gamma.',
      '',
      '## Chapter 2',
      '',
      'Delta epsilon zeta.',
    ].join('\n');

    const chunks = chunkText(text, { chunkWords: 900 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => /Chapter 1/i.test(c.label))).toBe(true);
    expect(chunks.some((c) => /Chapter 2/i.test(c.label))).toBe(true);
  });

  it('splits oversized sections by word budget', () => {
    const words = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkText(words, { chunkWords: 20 });
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.wordCount <= 20)).toBe(true);
    expect(chunks[0]?.label).toMatch(/part 1\/3/);
  });

  it('uses the file label when there are no headers', () => {
    const chunks = chunkText('Just a short paragraph here.', {
      chunkWords: 900,
      fileLabel: 'story.txt',
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.label).toBe('story.txt');
  });
});

describe('chunkCorpus', () => {
  it('numbers chunks across multiple files', () => {
    const chunks = chunkCorpus(
      [
        { relativePath: 'a.md', text: '## One\n\none two three' },
        { relativePath: 'b.md', text: '## Two\n\nfour five six' },
      ],
      900,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[1]?.index).toBe(1);
  });
});
