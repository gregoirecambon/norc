import { describe, it, expect } from 'vitest';
import { slackSafeIconUrl, slugifyHandle } from '../lib/slack-agents.js';

describe('slackSafeIconUrl', () => {
  it('passes raster image URLs through untouched', () => {
    const url = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/avatar.png?X-Amz-Signature=xyz';
    expect(slackSafeIconUrl(url)).toBe(url);
  });

  it('rasterizes Notion built-in SVG icons through wsrv.nl', () => {
    const out = slackSafeIconUrl('https://www.notion.so/icons/rocket_gray.svg');
    expect(out).toBe('https://wsrv.nl/?url=www.notion.so%2Ficons%2Frocket_gray.svg&output=png&w=128&h=128');
  });

  it('drops SVGs with query strings (presigned — proxying would leak credentials)', () => {
    expect(slackSafeIconUrl('https://files.example.com/icon.svg?X-Amz-Signature=secret')).toBeNull();
  });

  it('rejects non-http and malformed URLs', () => {
    expect(slackSafeIconUrl('data:image/svg+xml;base64,abcd')).toBeNull();
    expect(slackSafeIconUrl('not a url')).toBeNull();
  });
});

describe('slugifyHandle', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyHandle('Research Agent')).toBe('research-agent');
  });
});
