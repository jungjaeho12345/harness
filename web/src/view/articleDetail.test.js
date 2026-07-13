import { describe, it, expect } from 'vitest';
import {
  EMPTY_FIELD, DETAIL_COMMON_FIELDS, escapeHtml, buildDetail, renderDetailHtml,
} from './articleDetail.js';
import { serialize, textBlock, embedBlock } from './editorContent.js';

describe('articleDetail — data construction', () => {
  it('lists the common-info fields horizontally with empty fields as "—"', () => {
    const { common } = buildDetail({ author: '김기자', region: '' });
    const author = common.find((f) => f.key === 'author');
    const region = common.find((f) => f.key === 'region');
    expect(author.value).toBe('김기자');
    expect(region.value).toBe(EMPTY_FIELD);
    expect(common).toHaveLength(DETAIL_COMMON_FIELDS.length);
  });

  it('keeps body block order from markupVersion', () => {
    const markupVersion = serialize([textBlock('제목'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('본문')]);
    const { blocks } = buildDetail({ markupVersion });
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']);
  });

  it('window title falls back to "(제목 없음)"', () => {
    expect(buildDetail({ title: '제목있음' }).windowTitle).toBe('제목있음');
    expect(buildDetail({}).windowTitle).toBe('(제목 없음)');
  });
});

// 32-step4: 공통정보 '내용' 행은 신설 분류 필드 category를 읽는다.
// 구스펙 content(미사용 본문 평문 컬럼) 매핑은 제거 — '내용' 행은 category 단일 행만.
describe('articleDetail — 내용(category) 행', () => {
  it("maps the '내용' row to the category field", () => {
    const { common } = buildDetail({ category: '정치일반' });
    const row = common.find((f) => f.key === 'category');
    expect(row.label).toBe('내용');
    expect(row.value).toBe('정치일반');
  });

  it('shows "—" when category is absent', () => {
    const { common } = buildDetail({});
    expect(common.find((f) => f.key === 'category').value).toBe(EMPTY_FIELD);
  });

  it('does not list a content-keyed common row anymore', () => {
    const { common } = buildDetail({ content: '본문평문' });
    expect(common.find((f) => f.key === 'content')).toBeUndefined();
  });

  it('escapes a script-bearing category value in the detail HTML', () => {
    const html = renderDetailHtml({ category: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('articleDetail — HTML escaping', () => {
  it('escapeHtml neutralizes script-bearing markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renderDetailHtml escapes title, common fields and body (no executable script)', () => {
    const markupVersion = serialize([textBlock('<img src=x onerror=alert(1)>')]);
    const html = renderDetailHtml({
      title: '<script>evil()</script>',
      author: '<b>kim</b>',
      markupVersion,
    });
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;kim&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});

describe('articleDetail — embed media rendering', () => {
  it('renders an <img> (not the raw src text) for an allowed image embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'image', src: '/uploads/abc.png', alt: '사진' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<img');
    expect(html).toContain('src="/uploads/abc.png"');
    expect(html).toContain('alt="사진"');
  });

  it('renders an <img> for a data:image/ embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'image', src: 'data:image/png;base64,AAAA' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<img');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('does not render an <img> nor leak the raw src for a disallowed image scheme', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'image', src: 'javascript:alert(1)' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:alert(1)');
  });

  // 20-step2: 신규 /uploads 상대경로(위)와 레거시 data:image base64(위)는 <img> 렌더 회귀 잠금 완료.
  // data:text/html 이미지(악성)는 발행 HTML에 <img> 미렌더 + 원본 src 미노출이어야 한다(폴백 자리표시자).
  it('does not render an <img> nor leak the raw src for a data:text/html image embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'image', src: 'data:text/html,x' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data:text/html,x');
  });

  it('renders a canonical YouTube <iframe> for a video embed', () => {
    const markupVersion = serialize([embedBlock({
      embedType: 'video', videoId: 'dQw4w9WgXcQ', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<iframe');
    expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
  });

  it('renders the title text (no media) for an article reference embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'article', articleId: 'AKR9', title: '참조기사' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('참조기사');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<iframe');
  });

  // 19-step0: 상세/발행 렌더에서 오디오/로컬영상/링크 분기. 비허용 URL은 원본 미노출(폴백 자리표시자).
  it('renders an <audio> for an allowed audio embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'audio', src: 'https://cdn.example.com/a.mp3' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<audio');
    expect(html).toContain('src="https://cdn.example.com/a.mp3"');
  });

  it('does not render <audio> nor leak the raw src for a javascript: audio embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'audio', src: 'javascript:alert(1)' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('<audio');
    expect(html).not.toContain('javascript:alert(1)');
  });

  it('does not render <audio> nor leak the raw src for a data:audio embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'audio', src: 'data:audio/mp3;base64,AAAA' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('<audio');
    expect(html).not.toContain('data:audio/mp3');
  });

  it('renders a <video> for an allowed localVideo embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'localVideo', src: 'https://cdn.example.com/a.webm' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<video');
    expect(html).toContain('src="https://cdn.example.com/a.webm"');
  });

  it('does not render <video> nor leak the raw src for a javascript:/http: localVideo embed', () => {
    const js = renderDetailHtml({ markupVersion: serialize([embedBlock({ embedType: 'localVideo', src: 'javascript:alert(1)' })]) });
    expect(js).not.toContain('<video');
    expect(js).not.toContain('javascript:alert(1)');
    const http = renderDetailHtml({ markupVersion: serialize([embedBlock({ embedType: 'localVideo', src: 'http://insecure/a.webm' })]) });
    expect(http).not.toContain('<video');
    expect(http).not.toContain('http://insecure/a.webm');
  });

  it('renders an <a> with rel=noopener noreferrer for an allowed link embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'link', href: 'https://example.com/x', title: '원문' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<a');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('원문');
  });

  it('does not render <a href> nor leak the raw href for a javascript: link embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'link', href: 'javascript:alert(1)', title: '나쁜링크' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).not.toContain('javascript:alert(1)');
  });

  // 19-보안: 허용된 https URL이라도 title/href에 따옴표·꺾쇠가 있으면 escapeHtml로 속성/태그 탈출이 막혀야 한다.
  // (검증을 통과한 안전 스킴 위에서도 속성 컨텍스트 인젝션을 차단 — 새 창은 정적 HTML 문자열이라 이스케이프 누락 = XSS.)
  it('escapes a quote/angle-bracket bearing title on an allowed link href (no attribute/tag breakout)', () => {
    const markupVersion = serialize([embedBlock({
      embedType: 'link', href: 'https://example.com/x', title: '"><img src=x onerror=alert(1)>',
    })]);
    const html = renderDetailHtml({ markupVersion });
    // 원본 탈출 시퀀스가 그대로 들어가면 안 된다(태그가 닫히고 <img>가 주입됨).
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    // 이스케이프된 형태로만 존재하고, 합법 href 속성은 보존된다.
    expect(html).toContain('&quot;&gt;&lt;img');
    expect(html).toContain('href="https://example.com/x"');
  });

  it('escapes a quote-bearing query string on an allowed media src (no attribute breakout)', () => {
    const markupVersion = serialize([embedBlock({
      embedType: 'audio', src: 'https://cdn.example.com/a.mp3?x="><script>alert(1)</script>',
    })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  // 19-보안: 선행 공백으로 위험 스킴을 숨긴 링크는 앵커로 렌더되면 안 된다(브라우저가 공백을 트림 후 실행).
  it('does not render <a href> nor leak the raw href for a whitespace-prefixed javascript: link', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'link', href: '  javascript:alert(1)', title: '클릭' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toMatch(/<a[^>]*href=/);
    expect(html).not.toContain('javascript:alert(1)');
  });

  // 19-보안(보강): 프로토콜상대·단일슬래시·백슬래시 우회도 발행 HTML(실제 XSS 싱크)에서 앵커/미디어로 렌더되면 안 된다.
  it('does not render <a>/<audio>/<video> for protocol-relative, single-slash and backslash bypass URLs', () => {
    const linkPR = renderDetailHtml({ markupVersion: serialize([embedBlock({ embedType: 'link', href: '//evil.com/x', title: 'x' })]) });
    expect(linkPR).not.toMatch(/<a[^>]*href=/);
    const linkSS = renderDetailHtml({ markupVersion: serialize([embedBlock({ embedType: 'link', href: 'https:/evil.com', title: 'x' })]) });
    expect(linkSS).not.toMatch(/<a[^>]*href=/);
    expect(linkSS).not.toContain('https:/evil.com');
    const audioBS = renderDetailHtml({ markupVersion: serialize([embedBlock({ embedType: 'audio', src: '\\\\evil.com\\x.mp3' })]) });
    expect(audioBS).not.toContain('<audio');
    const videoPR = renderDetailHtml({ markupVersion: serialize([embedBlock({ embedType: 'localVideo', src: '//evil.com/x.webm' })]) });
    expect(videoPR).not.toContain('<video');
  });
});

// 31-step1: 표 임베드 — 상세/발행 HTML에 <table> 렌더. 모든 셀은 escapeHtml(셀 텍스트 = XSS 벡터).
describe('articleDetail — table embed rendering', () => {
  it('renders a <table> with escaped cell texts for a table embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'table', rows: [['a', 'b'], ['c', 'd']] })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<table');
    expect(html).toContain('<td>a</td>');
    expect(html).toContain('<td>d</td>');
    expect(html).toContain('data-embed-type="table"');
  });

  it('does not emit a raw <script> tag for a script-bearing cell (escaped only)', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'table', rows: [['<script>alert(1)</script>']] })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes a tag-breakout attempt cell (no injected <img>)', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'table', rows: [['"><img src=x onerror=alert(1)>']] })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('falls back to the [table] placeholder for empty rows (no <table>, no raw payload)', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'table', rows: [] })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('<table');
    expect(html).toContain('[table]');
  });

  it('normalizes ragged rows into a rectangular table (pads missing cells)', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'table', rows: [['a'], ['b', 'c']] })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<tr><td>a</td><td></td></tr>');
    expect(html).toContain('<tr><td>b</td><td>c</td></tr>');
  });
});

describe('articleDetail — byline (작성자 부가 라인)', () => {
  it('email 사용여부 ON + 값이 있으면 작성자 영역에 email을 부가 라인으로 보여준다', () => {
    const byline = { email: true, emailValue: 'hong@yna.co.kr', blog: false, blogValue: '' };
    const html = renderDetailHtml({ author: '홍길동' }, byline);
    expect(html).toContain('홍길동');
    expect(html).toContain('hong@yna.co.kr');
  });

  it('blog는 ON + 값이 있을 때만 보여주고, email OFF면 값이 있어도 나타나지 않는다', () => {
    const byline = {
      email: false, emailValue: 'hidden@yna.co.kr', blog: true, blogValue: 'https://blog.example.com',
    };
    const html = renderDetailHtml({ author: '홍길동' }, byline);
    expect(html).toContain('https://blog.example.com');
    expect(html).not.toContain('hidden@yna.co.kr');
  });

  it('부가 라인은 작성자(author) 필드에만 붙는다(다른 공통정보 필드는 불변)', () => {
    const byline = { email: true, emailValue: 'hong@yna.co.kr', blog: false, blogValue: '' };
    const { common } = buildDetail({ author: '홍길동' }, byline);
    const author = common.find((f) => f.key === 'author');
    expect(author.extra).toEqual(['hong@yna.co.kr']);
    common.filter((f) => f.key !== 'author').forEach((f) => expect(f.extra).toBeUndefined());
  });

  it('사용여부 ON이지만 값이 빈/공백 문자열이면 부가 라인이 나타나지 않는다', () => {
    const byline = { email: true, emailValue: '   ', blog: true, blogValue: '' };
    const { common } = buildDetail({ author: '홍길동' }, byline);
    const author = common.find((f) => f.key === 'author');
    expect(author.extra).toBeUndefined();
    const html = renderDetailHtml({ author: '홍길동' }, byline);
    expect(html).not.toContain('<div class="yh-detail__byline">');
  });

  it('부가 라인 값도 escapeHtml로 이스케이프한다(raw script 미노출)', () => {
    const byline = { email: true, emailValue: '<script>alert(1)</script>', blog: false, blogValue: '' };
    const html = renderDetailHtml({ author: '홍길동' }, byline);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('하위호환: byline 인자 없이 호출하면 부가 라인 없이 동작한다', () => {
    const { common } = buildDetail({ author: '홍길동' });
    expect(common.find((f) => f.key === 'author').extra).toBeUndefined();
    const html = renderDetailHtml({ author: '홍길동' });
    expect(html).toContain('홍길동');
    expect(html).not.toContain('<div class="yh-detail__byline">');
  });
});
