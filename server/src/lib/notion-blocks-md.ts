// Minimal Markdown → Notion blocks converter. Agents send markdown; NORC owns
// the conversion so agents never deal with Notion's block schema. Supports the
// common cases: headings, bullet/numbered lists, fenced code, blockquotes, and
// paragraphs. Anything fancier degrades gracefully to paragraphs.

import { toRichText } from './notion-writeback.js';

type Block = Record<string, unknown>;

function block(type: string, content: string, extra: Record<string, unknown> = {}): Block {
  return { object: 'block', type, [type]: { rich_text: toRichText(content), ...extra } };
}

export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];

  let inCode = false;
  let codeLang = 'plain text';
  let codeBuf: string[] = [];

  const flushCode = () => {
    blocks.push({
      object: 'block', type: 'code',
      code: { rich_text: toRichText(codeBuf.join('\n')), language: codeLang },
    });
    codeBuf = [];
    codeLang = 'plain text';
  };

  for (const raw of lines) {
    const line = raw;

    // Fenced code blocks.
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (inCode) { flushCode(); inCode = false; }
      else { inCode = true; codeLang = fence[1]!.trim() || 'plain text'; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (line.trim() === '') continue; // skip blank lines between blocks

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^###\s+(.*)$/))) blocks.push(block('heading_3', m[1]!));
    else if ((m = line.match(/^##\s+(.*)$/))) blocks.push(block('heading_2', m[1]!));
    else if ((m = line.match(/^#\s+(.*)$/))) blocks.push(block('heading_1', m[1]!));
    else if ((m = line.match(/^>\s?(.*)$/))) blocks.push(block('quote', m[1]!));
    else if ((m = line.match(/^[-*]\s+(.*)$/))) blocks.push(block('bulleted_list_item', m[1]!));
    else if ((m = line.match(/^\d+\.\s+(.*)$/))) blocks.push(block('numbered_list_item', m[1]!));
    else blocks.push(block('paragraph', line));
  }

  if (inCode && codeBuf.length > 0) flushCode();
  return blocks;
}
