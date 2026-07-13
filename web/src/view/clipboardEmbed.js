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

// URL 허용 검사 공통 정규화 — 스킴 추출 '전에' 우회 벡터를 거부 기반으로 걸러낸다(3함수 공유 단일 출처).
//   브라우저는 href/src의 선행·내부 ASCII 공백/제어문자를 제거하고 백슬래시를 슬래시로 정규화하므로,
//   " javascript:" · "java\tscript:" · "/\\evil" · "//evil" 같은 입력이 클릭/로드 시 위험 스킴으로 되살아난다.
//   → 정상 URL에는 raw 제어문자·공백·백슬래시·프로토콜상대(//)가 없으니 그런 입력은 전부 false.
//   반환: false(부적격) | '' (스킴 없는 진짜 상대경로) | 소문자 스킴 문자열.
function classifyUrl(input) {
  if (typeof input !== 'string' || input === '') return false;
  // 제어문자(U+0000~U+001F)·공백(U+0020) 포함 시 거부 — 선행/내부 어디든(스킴 은닉·정규화 우회 차단).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20]/.test(input)) return false;
  if (input.includes('\\')) return false; // 백슬래시(브라우저가 '/'로 정규화) 거부
  if (input.startsWith('//')) return false; // 프로토콜상대(//host) 거부 — 의도치 않은 외부 출처
  const m = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) return ''; // 스킴 없음 = 상대경로
  return m[1].toLowerCase();
}

// https://(authority 포함)만 허용 — 단일슬래시 https:/는 거부(정규화 후 http:로 살아날 수 있음).
function isHttpsAuthority(input) {
  return /^https:\/\//i.test(input);
}

// 이미지 src 허용 scheme 검사 — https://·data:image/ 와 scheme 없는 상대경로만 허용.
// javascript:/data:text/.../http:/제어문자·프로토콜상대 등은 거부(트래킹·스푸핑·XSS 완화). 에디터 렌더(InlineEmbed)와
// 상세보기 렌더(articleDetail) 양쪽이 같은 규칙을 쓰도록 임베드 모델 모듈에 단일 출처로 둔다.
export function isAllowedImageSrc(src) {
  const scheme = classifyUrl(src);
  if (scheme === false) return false;
  if (scheme === '') return true; // 진짜 상대경로
  if (scheme === 'https') return isHttpsAuthority(src);
  if (scheme === 'data') return /^data:image\//i.test(src); // 이미지만 data:image/ 인라인 허용
  return false;
}

// 오디오/로컬영상 미디어 src 허용 검사 — https:// 와 scheme 없는 상대경로만 허용.
// 이미지(isAllowedImageSrc)와 달리 data: 를 허용하지 않는다(오디오/영상은 data: 인라인이 불필요·표면 축소).
// javascript:/data:/http:/blob:/제어문자·프로토콜상대 등은 모두 거부. 에디터·상세 렌더가 공유하는 단일 출처.
export function isAllowedMediaSrc(src) {
  const scheme = classifyUrl(src);
  if (scheme === false) return false;
  if (scheme === '') return true; // 상대경로(자료/업로드 파일) 허용
  return scheme === 'https' && isHttpsAuthority(src); // https://만 허용, data: 포함 그 외 전부 거부
}

// 링크 href 허용 검사 — https:// 와 scheme 없는 상대경로만 허용. javascript:/data:/http: 등 거부.
// (mailto:/tel: 등 추가 스킴이 필요하면 명시적으로 허용 목록에 더한다 — 기본은 https/상대만.)
// 현재 규칙은 isAllowedMediaSrc와 같지만 의미가 달라 별도 함수로 둔다(향후 링크 전용 스킴 확장 여지).
export function isAllowedHref(href) {
  const scheme = classifyUrl(href);
  if (scheme === false) return false;
  if (scheme === '') return true; // 상대경로 허용
  return scheme === 'https' && isHttpsAuthority(href);
}

// 이미지 임베드(붙여넣기 데이터 URL 또는 검색 결과 URL).
// 트림 후 빈 src면 null(insertEmbed no-op) — 형제 팩토리(audio/link/localVideo)와 동일 가드.
export function makeImageEmbed(src, { alt = '' } = {}) {
  const value = String(src ?? '').trim();
  if (!value) return null;
  return embedBlock({
    embedType: 'image',
    src: value,
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

// 오디오 임베드 — src는 사용자 입력 URL(검증은 렌더 시점 isAllowedMediaSrc에 위임).
// 트림 후 빈 src면 null(insertEmbed no-op). 필드명 src/title은 step0 렌더(InlineEmbed/articleDetail)가 읽는 키와 일치.
export function makeAudioEmbed(src, { title = '' } = {}) {
  const value = String(src ?? '').trim();
  if (!value) return null;
  return embedBlock({
    embedType: 'audio',
    src: value,
    title,
    figureWidthPx: EMBED_SIZE.figureWidthPx,
  });
}

// 로컬영상 임베드 — <video> 엘리먼트로 렌더(유튜브 iframe과 별개 타입). src는 사용자 입력 URL.
export function makeLocalVideoEmbed(src, { title = '' } = {}) {
  const value = String(src ?? '').trim();
  if (!value) return null;
  return embedBlock({
    embedType: 'localVideo',
    src: value,
    title,
    figureWidthPx: EMBED_SIZE.figureWidthPx,
  });
}

// 링크 임베드 — href는 사용자 입력 URL. title 없으면 렌더 시점에 href를 표시 텍스트로 쓴다.
export function makeLinkEmbed(href, { title = '' } = {}) {
  const value = String(href ?? '').trim();
  if (!value) return null;
  return embedBlock({
    embedType: 'link',
    href: value,
    title,
  });
}

// 클립보드 페이로드({imageDataUrl?, text?}) → 임베드 블록(없으면 null).
// 이미지가 있으면 이미지 우선, 없으면 텍스트가 유튜브 URL일 때 영상.
export function embedFromPaste({ imageDataUrl, text } = {}) {
  if (imageDataUrl) return makeImageEmbed(imageDataUrl);
  if (text) return makeVideoEmbed(text);
  return null;
}
