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

// 이미지 src 허용 scheme 검사 — https:/data:image/ 와 scheme 없는 상대경로만 허용.
// javascript:/data:text/.../http: 등은 거부(트래킹·스푸핑·XSS 완화). 에디터 렌더(InlineEmbed)와
// 상세보기 렌더(articleDetail) 양쪽이 같은 규칙을 쓰도록 임베드 모델 모듈에 단일 출처로 둔다.
export function isAllowedImageSrc(src) {
  if (typeof src !== 'string' || src === '') return false;
  const m = src.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) return true; // scheme 없음 = 상대경로 → 허용
  const scheme = m[1].toLowerCase();
  if (scheme === 'https') return true;
  if (scheme === 'data') return /^data:image\//i.test(src);
  return false;
}

// 오디오/로컬영상 미디어 src 허용 검사 — https: 와 scheme 없는 상대경로만 허용.
// 이미지(isAllowedImageSrc)와 달리 data: 를 허용하지 않는다(오디오/영상은 data: 인라인이 불필요·표면 축소).
// javascript:/data:/http:/blob: 등은 모두 거부. 에디터(InlineEmbed)·상세(articleDetail) 렌더가 공유하는 단일 출처.
export function isAllowedMediaSrc(src) {
  if (typeof src !== 'string' || src === '') return false;
  const m = src.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) return true; // scheme 없음 = 상대경로 → 허용(자료/업로드 파일 상대경로 지원)
  return m[1].toLowerCase() === 'https'; // https만 허용, data: 포함 그 외 전부 거부
}

// 링크 href 허용 검사 — https: 와 scheme 없는 상대경로만 허용. javascript:/data:/http: 등 거부.
// (mailto:/tel: 등 추가 스킴이 필요하면 명시적으로 허용 목록에 더한다 — 기본은 https/상대만.)
// 현재 규칙은 isAllowedMediaSrc와 같지만 의미가 달라 별도 함수로 둔다(향후 링크 전용 스킴 확장 여지).
export function isAllowedHref(href) {
  if (typeof href !== 'string' || href === '') return false;
  const m = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) return true; // scheme 없음 = 상대경로 → 허용
  return m[1].toLowerCase() === 'https';
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
