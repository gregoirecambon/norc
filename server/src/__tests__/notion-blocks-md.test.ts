import { describe, it, expect } from 'vitest';
import { markdownToBlocks } from '../lib/notion-blocks-md.js';

function typeOf(b: Record<string, unknown>): string { return b['type'] as string; }
function textOf(b: Record<string, unknown>): string {
  const body = b[typeOf(b)] as { rich_text: { text: { content: string } }[] };
  return body.rich_text.map(r => r.text.content).join('');
}

describe('markdownToBlocks', () => {
  it('maps headings, lists, quote and paragraph to the right block types', () => {
    const md = [
      '# Title',
      '## Sub',
      '### Small',
      '- one',
      '* two',
      '1. first',
      '> a quote',
      'plain paragraph',
    ].join('\n');
    const blocks = markdownToBlocks(md);
    expect(blocks.map(typeOf)).toEqual([
      'heading_1', 'heading_2', 'heading_3',
      'bulleted_list_item', 'bulleted_list_item', 'numbered_list_item',
      'quote', 'paragraph',
    ]);
    expect(textOf(blocks[0]!)).toBe('Title');
    expect(textOf(blocks[3]!)).toBe('one');
    expect(textOf(blocks[6]!)).toBe('a quote');
  });

  it('captures fenced code blocks with their language and preserves inner lines', () => {
    const md = ['```ts', 'const x = 1;', 'const y = 2;', '```'].join('\n');
    const blocks = markdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(typeOf(blocks[0]!)).toBe('code');
    const code = blocks[0]!['code'] as { language: string; rich_text: { text: { content: string } }[] };
    expect(code.language).toBe('ts');
    expect(code.rich_text.map(r => r.text.content).join('')).toBe('const x = 1;\nconst y = 2;');
  });

  it('skips blank lines and every block carries a Notion object marker', () => {
    const blocks = markdownToBlocks('a\n\n\nb');
    expect(blocks.map(typeOf)).toEqual(['paragraph', 'paragraph']);
    expect(blocks.every(b => b['object'] === 'block')).toBe(true);
  });
});
