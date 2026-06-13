// 붙여넣기/검색 결과 → 임베드 블록 (news.md 기사 에디터).
// 크기: 에디터 100% 기준 가로·세로 17%(기존 10%에 1.7배). 사진/영상 figure 폭 612px, 기사 참조 카드 480px.

import { embedBlock } from './editorContent.js';

export const EMBED_SIZE = Object.freeze({
  widthPercent: 17, // 에디터 100% 기준 가로 17%
  heightPercent: 17, // 세로 17%
  figureWidthPx: 612, // 사진/영상 figure 폭(1.7배)
  articleCardWidthPx: 480, // 기사 참조 카드 폭
});

const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;

// 유튜브 URL에서 11자리 video id를 추출한다(아니면 null).
export function parseYouTubeId(url) {
  const m = String(url ?? '').match(YOUTUBE_RE);
  return m ? m[1] : null;
}

// 이미지 임베드(붙여넣기 데이터 URL 또는 검색 결과 URL).
export function makeImageEmbed(src, { alt = '' } = {}) {
  return embedBlock({
    embedType: 'image',
    src: String(src ?? ''),
    alt,
    widthPercent: EMBED_SIZE.widthPercent,
    heightPercent: EMBED_SIZE.heightPercent,
    figureWidthPx: EMBED_SIZE.figureWidthPx,
  });
}

// 영상(유튜브) 임베드 — 유튜브 URL이 아니면 null.
export function makeVideoEmbed(url, { title = '' } = {}) {
  const videoId = parseYouTubeId(url);
  if (!videoId) return null;
  return embedBlock({
    embedType: 'video',
    videoId,
    src: `https://www.youtube.com/embed/${videoId}`,
    title,
    widthPercent: EMBED_SIZE.widthPercent,
    heightPercent: EMBED_SIZE.heightPercent,
    figureWidthPx: EMBED_SIZE.figureWidthPx,
  });
}

// 내부 기사 참조 카드 임베드(글기사 검색 결과).
export function makeArticleEmbed(article = {}) {
  return embedBlock({
    embedType: 'article',
    articleId: article.articleId ?? null,
    title: article.title ?? '',
    widthPx: EMBED_SIZE.articleCardWidthPx,
  });
}

// 클립보드 페이로드({imageDataUrl?, text?}) → 임베드 블록(없으면 null).
// 이미지가 있으면 이미지 우선, 없으면 텍스트가 유튜브 URL일 때 영상.
export function embedFromPaste({ imageDataUrl, text } = {}) {
  if (imageDataUrl) return makeImageEmbed(imageDataUrl);
  if (text) return makeVideoEmbed(text);
  return null;
}
