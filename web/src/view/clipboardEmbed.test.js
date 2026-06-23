import { describe, it, expect } from 'vitest';
import {
  EMBED_SIZE, parseYouTubeId, makeImageEmbed, makeVideoEmbed, makeArticleEmbed, embedFromPaste,
  isAllowedMediaSrc, isAllowedHref,
} from './clipboardEmbed.js';

describe('clipboardEmbed — sizing', () => {
  it('uses 17% width/height and 612px figure for photo/video, 480px article card', () => {
    expect(EMBED_SIZE.widthPercent).toBe(17);
    expect(EMBED_SIZE.heightPercent).toBe(17);
    expect(EMBED_SIZE.figureWidthPx).toBe(612);
    expect(EMBED_SIZE.articleCardWidthPx).toBe(480);
  });
});

describe('clipboardEmbed — youtube parsing', () => {
  it('extracts the 11-char video id from common URL forms', () => {
    expect(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for non-youtube text', () => {
    expect(parseYouTubeId('https://example.com')).toBeNull();
    expect(parseYouTubeId('not a url')).toBeNull();
  });
});

// 19-step0: 오디오/로컬영상 src·링크 href 허용 scheme 검사(단일 출처). 이미지와 달리 data: 전면 불허.
describe('clipboardEmbed — media/href scheme allowlist', () => {
  it('isAllowedMediaSrc allows https: and relative paths', () => {
    expect(isAllowedMediaSrc('https://cdn.example.com/a.mp3')).toBe(true);
    expect(isAllowedMediaSrc('clip.webm')).toBe(true);
    expect(isAllowedMediaSrc('/uploads/a.mp3')).toBe(true);
  });

  it('isAllowedMediaSrc rejects javascript:/data:/http:/blob: and empty/non-string', () => {
    expect(isAllowedMediaSrc('javascript:alert(1)')).toBe(false);
    expect(isAllowedMediaSrc('data:text/html,<b>x</b>')).toBe(false);
    // 미디어는 data: 인라인을 허용하지 않는다(이미지의 data:image/ 예외와 구분).
    expect(isAllowedMediaSrc('data:audio/mp3;base64,AAAA')).toBe(false);
    expect(isAllowedMediaSrc('http://insecure/a.mp3')).toBe(false);
    expect(isAllowedMediaSrc('blob:https://x/abc')).toBe(false);
    expect(isAllowedMediaSrc('')).toBe(false);
    expect(isAllowedMediaSrc(null)).toBe(false);
  });

  it('isAllowedHref allows https: and relative paths', () => {
    expect(isAllowedHref('https://example.com')).toBe(true);
    expect(isAllowedHref('/list.do')).toBe(true);
  });

  it('isAllowedHref rejects javascript:/data:/http: and empty/non-string', () => {
    expect(isAllowedHref('javascript:alert(1)')).toBe(false);
    expect(isAllowedHref('data:text/html,x')).toBe(false);
    expect(isAllowedHref('http://x')).toBe(false);
    expect(isAllowedHref('')).toBe(false);
    expect(isAllowedHref(null)).toBe(false);
  });
});

describe('clipboardEmbed — embed builders', () => {
  it('makeImageEmbed builds an image block with sizing', () => {
    const e = makeImageEmbed('data:image/png;base64,AAA', { alt: '사진' });
    expect(e).toMatchObject({
      type: 'embed', embedType: 'image', src: 'data:image/png;base64,AAA', alt: '사진',
      widthPercent: 17, heightPercent: 17, figureWidthPx: 612,
    });
  });

  it('makeVideoEmbed builds a youtube embed, or null for non-youtube', () => {
    const e = makeVideoEmbed('https://youtu.be/dQw4w9WgXcQ');
    expect(e).toMatchObject({
      type: 'embed', embedType: 'video', videoId: 'dQw4w9WgXcQ',
      src: 'https://www.youtube.com/embed/dQw4w9WgXcQ', figureWidthPx: 612,
    });
    expect(makeVideoEmbed('https://example.com')).toBeNull();
  });

  it('makeArticleEmbed builds a reference card at 480px', () => {
    expect(makeArticleEmbed({ articleId: 'AKR1', title: '제목' })).toMatchObject({
      type: 'embed', embedType: 'article', articleId: 'AKR1', title: '제목', widthPx: 480,
    });
  });

  it('embedFromPaste prefers image, falls back to youtube text, else null', () => {
    expect(embedFromPaste({ imageDataUrl: 'data:image/png;base64,AAA' }).embedType).toBe('image');
    expect(embedFromPaste({ text: 'https://youtu.be/dQw4w9WgXcQ' }).embedType).toBe('video');
    expect(embedFromPaste({ text: 'just text' })).toBeNull();
    expect(embedFromPaste({})).toBeNull();
  });
});
