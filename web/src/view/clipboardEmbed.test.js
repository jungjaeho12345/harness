import { describe, it, expect } from 'vitest';
import {
  EMBED_SIZE, parseYouTubeId, makeImageEmbed, makeVideoEmbed, makeArticleEmbed,
  isAllowedImageSrc, isAllowedMediaSrc, isAllowedHref,
  makeAudioEmbed, makeLocalVideoEmbed, makeLinkEmbed,
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

  // 19: 스킴 비교는 대소문자 무관(toLowerCase)이어야 한다 — 대문자/혼합 javascript:로 우회 불가.
  it('rejects mixed/upper-case dangerous schemes (case-insensitive scheme match)', () => {
    expect(isAllowedMediaSrc('JavaScript:alert(1)')).toBe(false);
    expect(isAllowedMediaSrc('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isAllowedMediaSrc('Data:text/html,x')).toBe(false);
    expect(isAllowedHref('JavaScript:alert(1)')).toBe(false);
    expect(isAllowedHref('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isAllowedHref('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isAllowedHref('VBScript:msgbox(1)')).toBe(false);
  });

  // 19: 허용 스킴(https) 자체는 대소문자 무관으로 통과해야 한다(스킴 정규화 회귀 가드).
  it('allows https regardless of scheme letter case', () => {
    expect(isAllowedMediaSrc('HTTPS://cdn.example.com/a.mp3')).toBe(true);
    expect(isAllowedHref('Https://example.com')).toBe(true);
  });

  // 19-보안: 선행 공백/제어문자로 위험 스킴을 숨기는 우회를 막아야 한다.
  // 브라우저는 href/src의 선행 ASCII 공백·탭·개행을 제거하므로 "  javascript:" 도 클릭 시 실행된다 →
  // 앵커/미디어로 렌더되면 안 된다(발행 기사 신뢰 경계). isAllowedHref/isAllowedMediaSrc가 false여야 한다.
  it('rejects dangerous schemes hidden behind leading whitespace/control chars', () => {
    expect(isAllowedHref('  javascript:alert(1)')).toBe(false);
    expect(isAllowedHref('\tjavascript:alert(1)')).toBe(false);
    expect(isAllowedHref('\njavascript:alert(1)')).toBe(false);
    expect(isAllowedHref('\r\njavascript:alert(1)')).toBe(false);
    expect(isAllowedMediaSrc('  javascript:alert(1)')).toBe(false);
    expect(isAllowedMediaSrc(' data:text/html,x')).toBe(false);
  });

  // 19-보안(보강): 적대적 워크플로가 찾은 추가 우회 벡터를 3함수 전부에서 거부한다.
  // 선행 제어/공백·스킴 내부 제어문자·NUL·프로토콜상대(//)·백슬래시·단일슬래시 https:/ 등.
  const BYPASS_VECTORS = [
    ' javascript:alert(1)',
    '\tjavascript:',
    '\njavascript:',
    '\rjavascript:',
    '\x00javascript:',
    'java\tscript:',
    'java\nscript:',
    '//evil.com/x',
    '/\\evil.com/x',
    '\\\\evil.com\\x',
    'https:/evil.com',
  ];

  it('rejects all known bypass vectors in isAllowedHref', () => {
    BYPASS_VECTORS.forEach((v) => expect(isAllowedHref(v)).toBe(false));
  });

  it('rejects all known bypass vectors in isAllowedMediaSrc', () => {
    BYPASS_VECTORS.forEach((v) => expect(isAllowedMediaSrc(v)).toBe(false));
  });

  it('rejects all known bypass vectors in isAllowedImageSrc', () => {
    BYPASS_VECTORS.forEach((v) => expect(isAllowedImageSrc(v)).toBe(false));
  });

  // 19-보안: 정상 케이스 회귀 가드 — https://·상대경로·(이미지)data:image/ 는 계속 허용된다.
  it('still allows legit https/relative URLs (and data:image/ for images) after hardening', () => {
    ['https://good.com/x.jpg', '/a/b.png', 'b.png'].forEach((v) => {
      expect(isAllowedHref(v)).toBe(true);
      expect(isAllowedMediaSrc(v)).toBe(true);
      expect(isAllowedImageSrc(v)).toBe(true);
    });
    // data:image/ 는 이미지 전용 — media/href는 거부, image는 허용(기존 정책 보존).
    expect(isAllowedImageSrc('data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedMediaSrc('data:image/png;base64,AAAA')).toBe(false);
    expect(isAllowedHref('data:image/png;base64,AAAA')).toBe(false);
  });
});

// 20-step2: 붙여넣기 신규 이미지는 /uploads 상대경로 src로, 이미 저장된 레거시 기사는 data:image base64 src로
// 본문에 남는다(마이그레이션하지 않음). 두 형식이 계속 허용되는지 회귀 잠금 — 규칙은 조이지/완화하지 않는다
// (레거시 base64 렌더·하위호환 보존). 악성 스킴은 계속 거부되어야 한다.
describe('clipboardEmbed — image src backcompat regression (신규 /uploads + 레거시 base64)', () => {
  it('allows the new pasted /uploads relative path', () => {
    expect(isAllowedImageSrc('/uploads/deadbeef.png')).toBe(true);
  });

  it('still allows a legacy data:image base64 src (backcompat)', () => {
    expect(isAllowedImageSrc('data:image/png;base64,AAAA')).toBe(true);
  });

  it('still rejects malicious image src (javascript: / data:text/html)', () => {
    expect(isAllowedImageSrc('javascript:alert(1)')).toBe(false);
    expect(isAllowedImageSrc('data:text/html,x')).toBe(false);
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

});

// 19-step1: 오디오/로컬영상/링크 팩토리. 필드명(src/href/title)은 step0 렌더가 읽는 키와 일치.
// 팩토리는 URL 검증을 하지 않는다(검증은 렌더 단일 출처). 빈/누락 입력은 null(insertEmbed no-op).
describe('clipboardEmbed — audio/link/localVideo builders', () => {
  it('makeAudioEmbed builds an audio block with src/title and 612px figure', () => {
    expect(makeAudioEmbed('https://cdn/a.mp3', { title: '인터뷰' })).toMatchObject({
      type: 'embed', embedType: 'audio', src: 'https://cdn/a.mp3', title: '인터뷰', figureWidthPx: 612,
    });
  });

  it('makeLocalVideoEmbed builds a localVideo (not video) block with src and 612px figure', () => {
    const e = makeLocalVideoEmbed('https://cdn/a.webm');
    expect(e).toMatchObject({
      type: 'embed', embedType: 'localVideo', src: 'https://cdn/a.webm', figureWidthPx: 612,
    });
    expect(e.embedType).not.toBe('video'); // 유튜브와 별개 타입
  });

  it('makeLinkEmbed builds a link block with href/title', () => {
    expect(makeLinkEmbed('https://example.com', { title: '원문' })).toMatchObject({
      type: 'embed', embedType: 'link', href: 'https://example.com', title: '원문',
    });
  });

  it('does not validate the URL — a malicious src/href still builds (rejected at render)', () => {
    expect(makeAudioEmbed('javascript:alert(1)')).toMatchObject({ embedType: 'audio', src: 'javascript:alert(1)' });
    expect(makeLinkEmbed('javascript:alert(1)')).toMatchObject({ embedType: 'link', href: 'javascript:alert(1)' });
  });

  it('returns null for empty/missing input (insertEmbed no-op)', () => {
    expect(makeAudioEmbed('')).toBeNull();
    expect(makeAudioEmbed('   ')).toBeNull();
    expect(makeAudioEmbed()).toBeNull();
    expect(makeLocalVideoEmbed('')).toBeNull();
    expect(makeLinkEmbed('')).toBeNull();
    expect(makeLinkEmbed('   ')).toBeNull();
  });
});
