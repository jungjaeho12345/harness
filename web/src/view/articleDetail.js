// 상세보기 데이터 구성 + 새 창 렌더 (news.md 상세보기).
// 상단: 공통정보를 가로 그리드로 나열(빈 필드는 '—'). 하단: 본문 블록을 저장된 순서대로 한 영역에(명조 지면).
// 본문 첫 줄이 곧 제목이므로 별도 제목 요소는 두지 않는다(CSS로 첫 줄 강조). 창 제목은 기사 제목(없으면 '(제목 없음)').
// 새 창은 앱 CSS(yonhap.css)를 로드하지 않으므로 디자인은 인라인 <style>(DETAIL_STYLE)로 포함한다.
// CRITICAL: 모든 내용은 HTML 이스케이프되어 스크립트가 실행되지 않는다(<style>은 정적이라 사용자 값을 담지 않는다).

import { deserialize, isEmbedBlock } from './editorContent.js';
import { parseYouTubeId, isAllowedImageSrc } from './clipboardEmbed.js';

export const EMPTY_FIELD = '—';
const NO_TITLE = '(제목 없음)';

// 공통정보 — 가로 나열 순서(news.md). 엠바고/2차 엠바고 시간 포함.
export const DETAIL_COMMON_FIELDS = Object.freeze([
  { key: 'author', label: '작성자' },
  { key: 'coAuthor', label: '공동작성' },
  { key: 'content', label: '내용' },
  { key: 'region', label: '지역' },
  { key: 'attribute', label: '속성' },
  { key: 'keyword', label: '키워드' },
  { key: 'internalComment', label: '내부코멘트' },
  { key: 'externalComment', label: '외부코멘트' },
  { key: 'attachmentFile', label: '첨부파일' },
  { key: 'referenceFile', label: '자료파일' },
  { key: 'embargoAt', label: '엠바고 시간' },
  { key: 'secondEmbargoAt', label: '2차 엠바고 시간' },
]);

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fieldValue(v) {
  return (v === undefined || v === null || v === '') ? EMPTY_FIELD : String(v);
}

// 바이라인(에디터 환경설정) → 작성자 부가 라인. 사용여부 ON이고 값이 공백 아닌 항목만 노출(뷰어 prefs 기준).
// 값은 사용자 입력이므로 여기서는 원본을 모으고 렌더 시 escapeHtml로 이스케이프한다(XSS 비실행 규칙).
function bylineExtra(byline = {}) {
  const extra = [];
  if (byline.email === true && String(byline.emailValue ?? '').trim() !== '') extra.push(byline.emailValue);
  if (byline.blog === true && String(byline.blogValue ?? '').trim() !== '') extra.push(byline.blogValue);
  return extra;
}

// 상세보기 구조 데이터(공통정보 + 본문 블록 + 창 제목). 컴포넌트/새창 렌더 양쪽이 쓴다.
// byline은 선택적(기본 {}) — 작성자(author) 항목에만 부가 라인(extra)을 붙인다(하위호환: 없으면 부가 라인 없음).
export function buildDetail(article = {}, byline = {}) {
  const common = DETAIL_COMMON_FIELDS.map(({ key, label }) => {
    const item = { key, label, value: fieldValue(article[key]) };
    if (key === 'author') {
      const extra = bylineExtra(byline);
      if (extra.length) item.extra = extra;
    }
    return item;
  });
  const blocks = deserialize(article.markupVersion ?? article.body ?? article.content ?? '');
  const windowTitle = article.title ? String(article.title) : NO_TITLE;
  return { common, blocks, windowTitle };
}

// 새 창용 인라인 스타일 — yonhap.css 디자인 토큰(블루 기조·레드 포인트·명조 헤드라인)을 직접 박는다.
// 새 창은 외부 CSS를 못 받으므로 값을 인라인한다. 정적 문자열이라 사용자 데이터를 담지 않는다(XSS 무관).
const DETAIL_STYLE = `
:root{
  --b:#0a4da6;--r:#c8102e;--gold:#d4af37;
  --ink:#1a1a1a;--gd:#444;--gm:#888;--gl:#ddd;
  --bg:#f5f5f5;--bl:rgba(10,77,166,.08);
}
*{box-sizing:border-box;}
html,body{margin:0;}
body{
  font-family:'Noto Sans KR',system-ui,-apple-system,sans-serif;
  font-size:14px;line-height:1.5;color:var(--ink);background:var(--bg);padding:16px;
}
.yh-detail{
  max-width:672px;margin:0 auto;background:#fff;
  border:1px solid rgba(10,77,166,.15);border-radius:6px;
  box-shadow:0 2px 6px rgba(0,0,0,.08);overflow:hidden;
}
.yh-detail__head{display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:2px solid var(--b);}
.yh-detail__head::before{content:"";width:4px;height:18px;background:var(--r);}
.yh-detail__head h2{margin:0;font-size:.95rem;font-weight:700;letter-spacing:.02em;}
.yh-detail__common{
  margin:0;padding:16px 20px;background:#fafafa;border-bottom:1px solid var(--gl);
  display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px 16px;
}
.yh-detail__field{display:flex;flex-direction:column;gap:2px;min-width:0;}
.yh-detail__field dt{font-size:.68rem;font-weight:700;color:var(--b);letter-spacing:.05em;}
.yh-detail__field dd{margin:0;font-size:.85rem;color:var(--ink);white-space:pre-wrap;word-break:break-word;}
.yh-detail__field dd.is-empty{color:var(--gm);}
.yh-detail__byline{margin-top:2px;font-size:.72rem;color:var(--gm);}
.yh-detail__body{padding:20px 24px 28px;font-family:'Nanum Myeongjo','Noto Serif KR',serif;}
.yh-detail__line{margin:0 0 .7em;font-size:1.02rem;line-height:1.85;color:var(--ink);white-space:pre-wrap;word-break:break-word;}
.yh-detail__line:first-child{
  font-size:1.5rem;font-weight:700;line-height:1.4;
  margin-bottom:1rem;padding-bottom:.6rem;border-bottom:2px solid var(--b);
}
.yh-detail__embed{
  margin:.9em 0;padding:10px 12px;background:var(--bl);
  border:1px solid var(--gl);border-left:3px solid var(--b);border-radius:2px;
  font-family:'Noto Sans KR',system-ui,sans-serif;font-size:.82rem;color:var(--gd);word-break:break-word;
}
.yh-detail__embed::before{
  content:attr(data-embed-type);display:inline-block;margin-right:8px;padding:1px 6px;vertical-align:middle;
  font-size:.62rem;font-weight:700;color:#fff;background:var(--b);border-radius:2px;text-transform:uppercase;
}
/* 이미지/영상 임베드는 라벨/박스 크롬 없이 실제 미디어만 보여준다. */
.yh-detail__embed--media{padding:0;background:none;border:none;border-left:none;border-radius:0;}
.yh-detail__embed--media::before{content:none;}
.yh-detail__embed--media img{max-width:100%;height:auto;display:block;border:1px solid var(--gl);border-radius:3px;}
.yh-detail__embed--media iframe{width:100%;max-width:560px;aspect-ratio:16/9;border:0;border-radius:3px;}
.yh-detail__empty{margin:0;color:var(--gm);font-style:italic;font-family:'Noto Sans KR',system-ui,sans-serif;}
`;

// 임베드 블록 → 상세보기 HTML. 에디터(InlineEmbed)와 같은 규칙으로 이미지/영상은 실제 미디어로,
// 기사 참조는 제목 텍스트로 렌더한다. CRITICAL: 이미지 src는 허용 scheme(isAllowedImageSrc)만,
// 영상은 11자리 videoId로 재구성한 canonical 임베드 URL만 신뢰한다(임의 src 주입 차단). 모든 값은 이스케이프한다.
// 비허용 임베드(예: javascript: 이미지)는 원본 값을 노출하지 않고 자리표시자만 둔다(예전엔 src 문자열을 본문에 그대로 노출).
function embedHtml(b) {
  const type = b.embedType;
  if (type === 'image' && isAllowedImageSrc(b.src)) {
    return '<figure class="yh-detail__embed yh-detail__embed--media" data-embed-type="image">'
      + `<img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt ?? '')}" referrerpolicy="no-referrer"></figure>`;
  }
  if (type === 'video') {
    const videoId = b.videoId || parseYouTubeId(b.src) || parseYouTubeId(b.url);
    if (videoId) {
      return '<figure class="yh-detail__embed yh-detail__embed--media" data-embed-type="video">'
        + `<iframe src="https://www.youtube.com/embed/${escapeHtml(videoId)}" title="${escapeHtml(b.title ?? '영상')}"`
        + ' loading="lazy" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation"></iframe></figure>';
    }
  }
  if (type === 'article') {
    return '<figure class="yh-detail__embed" data-embed-type="article">'
      + `${escapeHtml(b.title || b.articleId || '기사')}</figure>`;
  }
  // 알 수 없거나 허용되지 않은 임베드 — 원본 값(src 등)을 노출하지 않는다.
  return `<figure class="yh-detail__embed" data-embed-type="${escapeHtml(type ?? '')}">[${escapeHtml(type || '임베드')}]</figure>`;
}

// 상세보기 새 창에 write할 HTML 문서 문자열 — 모든 값 이스케이프(스크립트 실행 불가).
// byline은 선택적(기본 {}) — 작성자 <dd> 안에 부가 라인을 줄 단위로 렌더한다(값은 반드시 escapeHtml).
export function renderDetailHtml(article = {}, byline = {}) {
  const { common, blocks, windowTitle } = buildDetail(article, byline);

  const commonHtml = common
    .map((f) => {
      const cls = f.value === EMPTY_FIELD ? ' class="is-empty"' : '';
      const extraHtml = (f.extra || [])
        .map((line) => `<div class="yh-detail__byline">${escapeHtml(line)}</div>`)
        .join('');
      return `<div class="yh-detail__field"><dt>${escapeHtml(f.label)}</dt>`
        + `<dd${cls}>${escapeHtml(f.value)}${extraHtml}</dd></div>`;
    })
    .join('');

  const bodyHtml = blocks.length
    ? blocks
      .map((b) => {
        if (isEmbedBlock(b)) return embedHtml(b);
        return `<p class="yh-detail__line">${escapeHtml(b.text)}</p>`;
      })
      .join('')
    : '<p class="yh-detail__empty">본문 내용이 없습니다.</p>';

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escapeHtml(windowTitle)}</title>`
    + `<style>${DETAIL_STYLE}</style></head><body>`
    + '<article class="yh-detail">'
    + '<header class="yh-detail__head"><h2>상세보기</h2></header>'
    + `<dl class="yh-detail__common">${commonHtml}</dl>`
    + `<section class="yh-detail__body">${bodyHtml}</section>`
    + '</article></body></html>';
}
