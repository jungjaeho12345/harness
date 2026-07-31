import { describe, it, expect } from 'vitest';
import {
  appendEndMarker, hasEndMarker, isInputBlocked, insertTextIntoBlocks,
  shouldOverwriteNextChar, overwriteExtendLength,
} from './editorNewline.js';
import {
  textBlock, embedBlock, blocksToText, isTextBlock,
} from './editorContent.js';

describe('editorNewline — "(끝)" placement & input blocking', () => {
  it('appends "(끝)" on its own line after the body', () => {
    expect(appendEndMarker('본문')).toBe('본문\n(끝)');
  });

  it('does not add a double newline when body already ends with newline or is empty', () => {
    expect(appendEndMarker('본문\n')).toBe('본문\n(끝)');
    expect(appendEndMarker('')).toBe('(끝)');
  });

  it('does not insert "(끝)" again if it already exists (no duplicate)', () => {
    expect(appendEndMarker('본문\n(끝)')).toBe('본문\n(끝)');
  });

  it('hasEndMarker reflects presence', () => {
    expect(hasEndMarker('본문\n(끝)')).toBe(true);
    expect(hasEndMarker('본문')).toBe(false);
  });

  it('blocks input at or after the marker, allows input before it', () => {
    const text = '본문\n(끝)';
    const markerStart = text.indexOf('(끝)');
    expect(isInputBlocked(text, markerStart)).toBe(true); // 마커 시작
    expect(isInputBlocked(text, text.length)).toBe(true); // 마커 뒤
    expect(isInputBlocked(text, markerStart - 1)).toBe(false); // 앞 줄(개행 위치)
    expect(isInputBlocked(text, 0)).toBe(false);
  });

  it('never blocks when there is no marker', () => {
    expect(isInputBlocked('본문', 0)).toBe(false);
    expect(isInputBlocked('본문', 2)).toBe(false);
  });
});

// phase44 step3 — 수정(overwrite) 모드 덮어쓰기 대상 판정(순수·결정적). 캐럿 바로 뒤(text[offset])가
// 같은 줄 일반 글자면 true, 줄 끝('\n')·문서 끝·"(끝)" 마커 영역·무효 오프셋이면 false(삽입 폴백).
// 이 함수가 이 step의 실질 회귀 방어선(jsdom은 네이티브 문자 대체를 실행하지 않으므로 경계는 여기서 전수 잠근다).
describe('editorNewline — shouldOverwriteNextChar (수정 모드 덮어쓰기 경계)', () => {
  it('줄 중간: 캐럿 뒤에 같은 줄 일반 글자가 있으면 true(각 오프셋)', () => {
    expect(shouldOverwriteNextChar('abc', 0)).toBe(true); // text[0]='a'
    expect(shouldOverwriteNextChar('abc', 1)).toBe(true); // text[1]='b'
    expect(shouldOverwriteNextChar('abc', 2)).toBe(true); // text[2]='c'
  });

  it('문서 끝(offset===length)·범위 밖은 false(삽입 폴백)', () => {
    expect(shouldOverwriteNextChar('abc', 3)).toBe(false); // 문서 끝
    expect(shouldOverwriteNextChar('abc', 99)).toBe(false); // 범위 밖
  });

  it('줄 끝(뒤가 "\\n")은 false(다음 줄 침범 금지), 다음 줄 첫 글자는 true', () => {
    expect(shouldOverwriteNextChar('ab\ncd', 2)).toBe(false); // text[2]='\n' = 줄 끝
    expect(shouldOverwriteNextChar('ab\ncd', 3)).toBe(true); // text[3]='c' = 다음 줄 첫 글자
  });

  it('"(끝)" 마커 시작 이상 오프셋은 전부 false(입력 차단 계약 재사용), 마커 앞 본문은 정상 판정', () => {
    const text = '본문\n(끝)';
    const markerStart = text.indexOf('(끝)');
    expect(shouldOverwriteNextChar(text, markerStart)).toBe(false); // 마커 첫 글자 '('
    for (let i = markerStart; i <= text.length; i += 1) {
      expect(shouldOverwriteNextChar(text, i)).toBe(false); // 마커 영역·그 이상 전부 차단
    }
    expect(shouldOverwriteNextChar(text, 0)).toBe(true); // 마커 앞 본문 '본'
    expect(shouldOverwriteNextChar(text, 1)).toBe(true); // 마커 앞 본문 '문'
    expect(shouldOverwriteNextChar(text, 2)).toBe(false); // 마커 직전 '\n'(줄 끝 — 마커는 자기 줄)
  });

  it('임베드 경계는 blocksToText에서 "\\n"/문서 끝으로 나타나 자동 false', () => {
    // blocksToText는 텍스트 블록만 '\n'으로 조인하고 임베드를 제외 → 임베드 자리는 줄 끝('\n')/문서 끝으로 보인다.
    const text = blocksToText([textBlock('앞'), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('뒤')]);
    expect(text).toBe('앞\n뒤'); // 임베드 제외
    expect(shouldOverwriteNextChar(text, 1)).toBe(false); // '앞' 뒤 = '\n'(임베드 경계) → 삽입 폴백
    expect(shouldOverwriteNextChar(text, text.length)).toBe(false); // 문서 끝
  });

  it('무효 오프셋(null/undefined/음수/비정수/NaN)은 false', () => {
    expect(shouldOverwriteNextChar('abc', null)).toBe(false);
    expect(shouldOverwriteNextChar('abc', undefined)).toBe(false);
    expect(shouldOverwriteNextChar('abc', -1)).toBe(false);
    expect(shouldOverwriteNextChar('abc', 1.5)).toBe(false);
    expect(shouldOverwriteNextChar('abc', NaN)).toBe(false);
    expect(shouldOverwriteNextChar('abc', '1')).toBe(false); // 문자열 오프셋(비정수 취급)
  });

  it('빈 문자열·무효 text는 false', () => {
    expect(shouldOverwriteNextChar('', 0)).toBe(false);
    expect(shouldOverwriteNextChar(null, 0)).toBe(false);
    expect(shouldOverwriteNextChar(undefined, 0)).toBe(false);
  });
});

// phase45 step2 — 수정(overwrite) 모드에서 캐럿 뒤 "한 문자(코드포인트)"를 덮어쓸 때 확장할
// UTF-16 코드유닛 수(1 또는 2). astral 문자(이모지=high+low 서로게이트 페어)는 2, 그 외는 1.
// jsdom이 네이티브 문자 대체를 실행하지 않으므로 서로게이트 경계는 이 순수 함수로 전수 잠근다.
describe('editorNewline — overwriteExtendLength (서로게이트-safe 확장 길이)', () => {
  it('BMP 문자는 1 코드유닛', () => {
    expect(overwriteExtendLength('abc', 1)).toBe(1); // 'b'
    expect(overwriteExtendLength('가나', 1)).toBe(1); // 한글(BMP)
  });

  it('astral 문자(이모지=서로게이트 페어)는 2 코드유닛', () => {
    expect(overwriteExtendLength('a😀b', 1)).toBe(2); // 인덱스 1이 high 서로게이트(😀 시작)
    expect(overwriteExtendLength('😀', 0)).toBe(2); // 문자열 시작의 이모지
    expect(overwriteExtendLength('a😀', 1)).toBe(2); // 문자열 끝의 이모지(low가 마지막 코드유닛)
  });

  it('lone high 서로게이트는 1(짝 없으면 안전 폴백)', () => {
    expect(overwriteExtendLength('a\uD83Db', 1)).toBe(1); // 뒤가 low 서로게이트 아님
    expect(overwriteExtendLength('a\uD83D', 1)).toBe(1); // lone high가 문자열 끝(뒤 코드유닛 없음)
  });

  it('경계/무효 오프셋은 1(안전 기본)', () => {
    expect(overwriteExtendLength('abc', 3)).toBe(1); // 문서 끝(offset===length)
    expect(overwriteExtendLength('abc', -1)).toBe(1); // 음수
    expect(overwriteExtendLength('abc', 1.5)).toBe(1); // 비정수
    expect(overwriteExtendLength('abc', NaN)).toBe(1); // NaN
    expect(overwriteExtendLength('', 0)).toBe(1); // 빈 문자열
    expect(overwriteExtendLength(null, 0)).toBe(1); // 무효 text
    expect(overwriteExtendLength(undefined, 0)).toBe(1);
  });
});

// phase49 step5 — 캐럿이 서로게이트 페어 "내부"(low 서로게이트 위치 = high 바로 뒤)면 덮어쓰기 차단.
// 반쪽(low)만 대체되면 lone high 서로게이트가 남아 본문이 깨진 코드유닛을 품게 된다 → 삽입 폴백으로 안전 저하.
// phase45 step2(페어 "앞" offset의 2유닛 확장)와 짝을 이루는 반대편 엣지. 'a😀b'의 인덱스: 0='a', 1=high, 2=low, 3='b'.
describe('editorNewline — shouldOverwriteNextChar (서로게이트 페어 내부 차단)', () => {
  it('페어 내부(offset=low 서로게이트, 직전=high)는 false — 반쪽 대체 방지(핵심)', () => {
    expect(shouldOverwriteNextChar('a😀b', 2)).toBe(false); // text[2]=low, text[1]=high → 페어 내부
    expect(shouldOverwriteNextChar('😀b', 1)).toBe(false); // 문자열 시작 이모지의 내부
  });

  it('페어 앞(offset=high 시작)은 기존대로 true이고 확장 길이는 2(회귀 가드)', () => {
    expect(shouldOverwriteNextChar('a😀b', 1)).toBe(true); // 이모지 앞 — phase45 step2 경로
    expect(overwriteExtendLength('a😀b', 1)).toBe(2); // 페어 전체(2 코드유닛) 대체
  });

  it('페어 뒤(일반 글자)는 true', () => {
    expect(shouldOverwriteNextChar('a😀b', 3)).toBe(true); // text[3]='b'
  });

  it('lone low 서로게이트(직전이 high 아님)는 기존대로 true — 페어가 아니므로 반쪽 대체 문제 없음', () => {
    expect(shouldOverwriteNextChar('a\uDC00b', 1)).toBe(true); // 직전 'a'는 high 아님
    expect(shouldOverwriteNextChar('\uDC00b', 0)).toBe(true); // 문자열 시작의 lone low(직전 없음)
  });

  it('lone high 서로게이트 위치도 기존대로 true(확장 1 — 안전 폴백 유지)', () => {
    expect(shouldOverwriteNextChar('a\uD83Db', 1)).toBe(true); // text[1]=lone high(뒤가 low 아님)
    expect(overwriteExtendLength('a\uD83Db', 1)).toBe(1);
  });

  it('BMP 회귀 — 한글·영문·기호에서 기존 true/false 판정 불변', () => {
    expect(shouldOverwriteNextChar('가나다', 1)).toBe(true); // 한글(BMP)
    expect(shouldOverwriteNextChar('a!b', 1)).toBe(true); // 기호
    expect(shouldOverwriteNextChar('ab\ncd', 2)).toBe(false); // 줄 끝('\n')
    expect(shouldOverwriteNextChar('abc', 3)).toBe(false); // offset >= length
    const text = '본문\n(끝)';
    expect(shouldOverwriteNextChar(text, text.indexOf('(끝)'))).toBe(false); // "(끝)" 마커 이후
    expect(shouldOverwriteNextChar('abc', -1)).toBe(false); // 음수
    expect(shouldOverwriteNextChar('abc', 1.5)).toBe(false); // 비정수
  });
});

describe('editorNewline — insertTextIntoBlocks (Enter 분할 / 여러 줄 삽입)', () => {
  // 텍스트-only 기준 캐럿: lineIndex번째 텍스트 블록의 줄 안 offset(절대 텍스트 오프셋)으로 환산.
  const caretAt = (blocks, lineIndex, inLine) => {
    const textBlocks = blocks.filter(isTextBlock);
    let off = 0;
    for (let i = 0; i < lineIndex; i += 1) off += textBlocks[i].text.length + 1;
    return { lineIndex, offset: off + inLine };
  };

  it('Enter("\\n")는 캐럿이 속한 줄을 head/tail 두 줄로 분할한다', () => {
    const blocks = [textBlock('AB CD')];
    const r = insertTextIntoBlocks(blocks, caretAt(blocks, 0, 2), '\n');
    expect(blocksToText(r.blocks)).toBe('AB\n CD');
    expect(r.caretLineIndex).toBe(1); // 새 줄(tail)에 캐럿
  });

  it('줄 끝에서 Enter는 뒤에 빈 줄을 추가한다', () => {
    const blocks = [textBlock('줄1'), textBlock('줄2')];
    const r = insertTextIntoBlocks(blocks, caretAt(blocks, 1, 2), '\n'); // 줄2 끝
    expect(blocksToText(r.blocks)).toBe('줄1\n줄2\n');
    expect(r.caretLineIndex).toBe(2);
  });

  it('캐럿이 null이면(라인 래퍼 없음) 마지막 텍스트 줄 끝에 빈 줄을 붙인다', () => {
    const r = insertTextIntoBlocks([textBlock('줄1')], null, '\n');
    expect(blocksToText(r.blocks)).toBe('줄1\n');
    expect(r.caretLineIndex).toBe(1);
  });

  it('완전히 빈 본문([])에서 Enter는 빈 줄 두 개가 된다', () => {
    const r = insertTextIntoBlocks([], null, '\n');
    expect(blocksToText(r.blocks)).toBe('\n');
    expect(r.caretLineIndex).toBe(1);
  });

  it('여러 줄 텍스트 삽입은 head+첫줄 … 끝줄+tail로 개행을 보존한다', () => {
    const blocks = [textBlock('AB CD')];
    const r = insertTextIntoBlocks(blocks, caretAt(blocks, 0, 2), 'x\ny');
    expect(blocksToText(r.blocks)).toBe('ABx\ny CD');
    expect(r.caretLineIndex).toBe(1);
  });

  it('임베드는 위치를 보존하고 텍스트 블록만 분할한다', () => {
    const blocks = [textBlock('제목'), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('본문')];
    // 두 번째 텍스트 블록(본문, lineIndex 1) 끝에서 Enter.
    const r = insertTextIntoBlocks(blocks, caretAt(blocks, 1, 2), '\n');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text', 'text']);
    expect(blocksToText(r.blocks)).toBe('제목\n본문\n');
    expect(r.caretLineIndex).toBe(2);
  });
});
