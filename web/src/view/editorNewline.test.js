import { describe, it, expect } from 'vitest';
import {
  appendEndMarker, hasEndMarker, isInputBlocked, insertTextIntoBlocks, replaceRangeInBlocks,
  shouldOverwriteNextChar, overwriteExtendLength,
} from './editorNewline.js';
import {
  textBlock, embedBlock, blocksToText, isTextBlock, deserialize, END_MARKER,
} from './editorContent.js';
import { serializeBodyFromBlocks } from './writerBody.js';

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

// phase53 step0 — 비-collapsed 선택 범위 대체(순수 계층). Enter·여러 줄 붙여넣기가 선택 텍스트를 지우지 않아
// 본문이 파손되던 결함(A)을 블록 모델에서 닫는다. DOM selection → 블록 좌표 환산·결선은 step1(Editor.jsx).
// 좌표 계약은 insertTextIntoBlocks와 동일: lineIndex = 텍스트 블록 순번(임베드 제외), offset = blocksToText 절대 오프셋.
describe('editorNewline — replaceRangeInBlocks (선택 범위 삭제 + 삽입)', () => {
  const caretAt = (blocks, lineIndex, inLine) => {
    const textBlocks = blocks.filter(isTextBlock);
    let off = 0;
    for (let i = 0; i < lineIndex; i += 1) off += textBlocks[i].text.length + 1;
    return { lineIndex, offset: off + inLine };
  };
  const rangeAt = (blocks, l1, c1, l2, c2) => ({
    start: caretAt(blocks, l1, c1),
    end: caretAt(blocks, l2, c2),
  });
  const isMarkerBlock = (b) => b.type === 'text' && String(b.text).trim() === END_MARKER;
  const snapshot = (blocks) => JSON.parse(JSON.stringify(blocks));

  // 1. 결함 재현 — 선택 후 여러 줄 붙여넣기.
  it('선택 범위 텍스트를 지우고 그 자리에 삽입한다(결함 재현 — 여러 줄 붙여넣기)', () => {
    const blocks = [textBlock('hello world')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 6, 0, 11), 'A\nB');
    expect(blocksToText(r.blocks)).toBe('hello A\nB'); // 'world' 소멸
    expect(r.caretLineIndex).toBe(1);
  });

  // 2. 결함 재현 — 선택 후 Enter.
  it('선택 범위에서 Enter는 선택을 지운 뒤 줄을 분할한다(결함 재현)', () => {
    const blocks = [textBlock('hello world')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 6, 0, 11), '\n');
    expect(blocksToText(r.blocks)).toBe('hello \n');
    expect(r.caretLineIndex).toBe(1);
  });

  // 3. 여러 줄에 걸친 선택 — 중간 줄 제거 + head/tail 병합.
  it('여러 줄에 걸친 선택은 중간 줄을 제거하고 head/tail을 한 줄로 병합한다', () => {
    const blocks = [textBlock('ab'), textBlock('cd'), textBlock('ef')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 2, 1), 'X');
    expect(blocksToText(r.blocks)).toBe('aXf');
    expect(r.blocks).toHaveLength(1);
    expect(r.caretLineIndex).toBe(0);
  });

  // 4. collapsed 동치성 — 정상 플로우 무손상(회귀 방어의 핵심).
  const equivFixtures = [
    {
      name: '줄 중간',
      blocks: () => [textBlock('AB CD')],
      caret: (b) => caretAt(b, 0, 2),
      enter: { text: 'AB\n CD', caretLineIndex: 1 },
    },
    {
      name: '줄 끝(마지막 줄)',
      blocks: () => [textBlock('줄1'), textBlock('줄2')],
      caret: (b) => caretAt(b, 1, 2),
      enter: { text: '줄1\n줄2\n', caretLineIndex: 2 },
    },
    {
      name: '첫 줄 시작',
      blocks: () => [textBlock('가'), textBlock('나')],
      caret: (b) => caretAt(b, 0, 0),
      enter: { text: '\n가\n나', caretLineIndex: 1 },
    },
    {
      name: '임베드 포함',
      blocks: () => [textBlock('제목'), embedBlock({ embedType: 'image', src: 'x.png' }), textBlock('본문')],
      caret: (b) => caretAt(b, 1, 2),
      enter: { text: '제목\n본문\n', caretLineIndex: 2 },
    },
    {
      name: '캐럿 null(마커 없는 문서)',
      blocks: () => [textBlock('줄1')],
      caret: () => null,
      enter: { text: '줄1\n', caretLineIndex: 1 },
    },
    {
      name: '빈 본문',
      blocks: () => [],
      caret: () => null,
      enter: { text: '\n', caretLineIndex: 1 },
    },
  ];

  it('collapsed(같은 start/end)는 insertTextIntoBlocks와 텍스트·caretLineIndex가 동일하다', () => {
    for (const f of equivFixtures) {
      for (const text of ['\n', 'x\ny', 'Z']) {
        const blocks = f.blocks();
        const caret = f.caret(blocks);
        const a = replaceRangeInBlocks(blocks, { start: caret, end: caret }, text);
        const b = insertTextIntoBlocks(blocks, caret, text);
        expect(blocksToText(a.blocks), `${f.name} / ${JSON.stringify(text)}`).toBe(blocksToText(b.blocks));
        expect(a.caretLineIndex, `${f.name} / ${JSON.stringify(text)}`).toBe(b.caretLineIndex);
      }
    }
  });

  it('collapsed 결과는 오늘의 기대값 그대로다(동치성 자체를 잠그는 명시 단언)', () => {
    for (const f of equivFixtures) {
      const blocks = f.blocks();
      const caret = f.caret(blocks);
      const r = replaceRangeInBlocks(blocks, { start: caret, end: caret }, '\n');
      expect(blocksToText(r.blocks), f.name).toBe(f.enter.text);
      expect(r.caretLineIndex, f.name).toBe(f.enter.caretLineIndex);
    }
  });

  it('range:null·{start:null,end:null}·한쪽만 null 은 캐럿 미상/collapsed 폴백과 같다', () => {
    const blocks = [textBlock('줄1')];
    const viaNull = replaceRangeInBlocks(blocks, null, 'x\ny');
    const viaBothNull = replaceRangeInBlocks(blocks, { start: null, end: null }, 'x\ny');
    const legacy = insertTextIntoBlocks(blocks, null, 'x\ny');
    expect(blocksToText(viaNull.blocks)).toBe(blocksToText(legacy.blocks));
    expect(blocksToText(viaBothNull.blocks)).toBe(blocksToText(legacy.blocks));
    expect(viaNull.caretLineIndex).toBe(legacy.caretLineIndex);
    expect(viaBothNull.caretLineIndex).toBe(legacy.caretLineIndex);
    // 한쪽만 있으면 있는 쪽으로 collapsed 취급(규칙 1-a).
    const caret = caretAt(blocks, 0, 1);
    const onlyEnd = replaceRangeInBlocks(blocks, { start: null, end: caret }, 'X');
    const onlyStart = replaceRangeInBlocks(blocks, { start: caret, end: null }, 'X');
    expect(blocksToText(onlyEnd.blocks)).toBe('줄X1');
    expect(blocksToText(onlyStart.blocks)).toBe('줄X1');
  });

  // 6. 역방향 선택.
  it('역방향 선택(start > end)도 정규화되어 같은 결과를 낸다', () => {
    const blocks = [textBlock('hello world')];
    const fwd = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 6, 0, 11), 'A\nB');
    const rev = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 11, 0, 6), 'A\nB');
    expect(blocksToText(rev.blocks)).toBe('hello A\nB');
    expect(blocksToText(rev.blocks)).toBe(blocksToText(fwd.blocks));
    expect(rev.caretLineIndex).toBe(fwd.caretLineIndex);
    // 여러 줄 역방향.
    const multi = [textBlock('ab'), textBlock('cd'), textBlock('ef')];
    const r = replaceRangeInBlocks(multi, rangeAt(multi, 2, 1, 0, 1), 'X');
    expect(blocksToText(r.blocks)).toBe('aXf');
    expect(r.caretLineIndex).toBe(0);
  });

  // 7. 임베드 보존.
  it('범위 안의 임베드는 삭제되지 않고 병합된 줄 뒤에 원래 상대 순서로 남는다', () => {
    const embed = embedBlock({ embedType: 'image', src: 'x.png' });
    const blocks = [textBlock('ab'), embed, textBlock('cd')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 1, 1), 'X');
    expect(blocksToText(r.blocks)).toBe('aXd');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'embed']);
    expect(r.blocks.filter((b) => b.type === 'embed')).toEqual([{ embedType: 'image', src: 'x.png', type: 'embed' }]);
  });

  it('범위 안 임베드가 여러 개면 개수·상대 순서가 그대로 보존된다', () => {
    const e1 = embedBlock({ embedType: 'image', src: '1.png' });
    const e2 = embedBlock({ embedType: 'video', src: '2.mp4' });
    const blocks = [textBlock('ab'), e1, textBlock('cd'), e2, textBlock('ef')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 2, 1), 'X');
    expect(blocksToText(r.blocks)).toBe('aXf');
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'embed', 'embed']);
    expect(r.blocks.filter((b) => b.type === 'embed').map((b) => b.src)).toEqual(['1.png', '2.mp4']);
  });

  // 8. 마커 clamp.
  it('삭제 end는 "(끝)" 줄 시작 이전으로 clamp된다 — 마커 블록이 변형되지 않는다', () => {
    const blocks = [textBlock('본문'), textBlock('꼬리'), textBlock('(끝)')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 2, 3), 'X'); // 마커 줄 끝까지 선택
    expect(blocksToText(r.blocks)).toBe('본X\n(끝)');
    expect(r.blocks.filter(isMarkerBlock)).toEqual([{ type: 'text', text: '(끝)' }]);
    // 재정규화 라운드트립 — 마커가 여전히 정확히 하나·최종 블록.
    const round = deserialize(serializeBodyFromBlocks(r.blocks));
    expect(round.filter(isMarkerBlock)).toHaveLength(1);
    expect(isMarkerBlock(round[round.length - 1])).toBe(true);
  });

  it('마커 줄 텍스트에 다른 문자가 붙지 않는다(오염 "(끝)X"·"X(끝)" 금지)', () => {
    const blocks = [textBlock('본문'), textBlock('(끝)')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 0, 1, 3), 'X');
    const text = blocksToText(r.blocks);
    expect(text).toContain('(끝)');
    expect(text).not.toContain('(끝)X');
    expect(text).not.toContain('X(끝)');
    expect(r.blocks.filter(isMarkerBlock)).toEqual([{ type: 'text', text: '(끝)' }]);
  });

  // 9. 마커 앞 삭제는 정상 동작.
  it('마커 앞 줄들의 선택 삭제는 정상 동작하고 마커는 온전하다', () => {
    const blocks = [textBlock('본문'), textBlock('꼬리'), textBlock('(끝)')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 1, 2), 'X');
    expect(blocksToText(r.blocks)).toBe('본X\n(끝)');
    expect(r.blocks.filter(isMarkerBlock)).toHaveLength(1);
  });

  it('start는 clamp하지 않는다 — 마커 뒤 삽입 차단은 호출부 책임(오늘 동작 보존)', () => {
    const blocks = [textBlock('본문'), textBlock('(끝)')];
    const caret = caretAt(blocks, 1, 3); // 마커 줄 끝
    const r = replaceRangeInBlocks(blocks, { start: caret, end: caret }, '\n');
    expect(blocksToText(r.blocks)).toBe(blocksToText(insertTextIntoBlocks(blocks, caret, '\n').blocks));
  });

  // 10. 문서 전 범위 선택.
  it('문서 전 범위 선택은 본문을 통째로 대체한다(임베드는 남는다)', () => {
    const blocks = [textBlock('ab'), textBlock('cd'), textBlock('ef')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 0, 2, 2), 'A\nB');
    expect(blocksToText(r.blocks)).toBe('A\nB');
    expect(r.caretLineIndex).toBe(1);
    const embed = embedBlock({ embedType: 'image', src: 'x.png' });
    const withEmbed = [textBlock('ab'), embed, textBlock('cd')];
    const r2 = replaceRangeInBlocks(withEmbed, rangeAt(withEmbed, 0, 0, 1, 2), 'A\nB');
    expect(blocksToText(r2.blocks)).toBe('A\nB');
    expect(r2.blocks.filter((b) => b.type === 'embed')).toHaveLength(1);
  });

  // 11. 캐럿 미상 + 마커 폴백(결함 재현) — 삽입 지점이 마커 줄 앞으로 옮겨진다.
  it('캐럿 미상 폴백은 "마커 줄 직전"에 삽입한다 — "(끝)A" 오염 금지(결함 재현)', () => {
    const blocks = [textBlock('본문'), textBlock('(끝)')];
    const r = replaceRangeInBlocks(blocks, null, 'A\nB');
    expect(blocksToText(r.blocks)).toBe('본문A\nB\n(끝)');
    expect(blocksToText(r.blocks)).not.toContain('(끝)A');
    expect(r.blocks.filter(isMarkerBlock)).toEqual([{ type: 'text', text: '(끝)' }]);
    expect(r.caretLineIndex).toBe(1); // 삽입 대상 줄(0) + 삽입 줄 수-1 — 마커 줄이 아니다
    const round = deserialize(serializeBodyFromBlocks(r.blocks));
    expect(round.filter(isMarkerBlock)).toHaveLength(1);
    expect(isMarkerBlock(round[round.length - 1])).toBe(true);
  });

  it('마커 앞에 텍스트 줄이 없으면 마커 바로 앞에 새 텍스트 줄을 만들어 삽입한다(빈 문서 Alt+Y 상태)', () => {
    const blocks = [textBlock('(끝)')];
    const r = replaceRangeInBlocks(blocks, null, 'A\nB');
    expect(blocksToText(r.blocks)).toBe('A\nB\n(끝)');
    expect(r.blocks.filter(isMarkerBlock)).toEqual([{ type: 'text', text: '(끝)' }]);
    expect(r.caretLineIndex).toBe(1);
  });

  // 12. 마커 없는 문서의 폴백은 불변.
  it('마커 없는 문서의 캐럿 미상 폴백은 오늘과 동일하다(마지막 텍스트 줄 끝)', () => {
    const blocks = [textBlock('가'), textBlock('나')];
    const r = replaceRangeInBlocks(blocks, null, 'X');
    expect(blocksToText(r.blocks)).toBe('가\n나X');
    expect(r.caretLineIndex).toBe(1);
    expect(blocksToText(r.blocks)).toBe(blocksToText(insertTextIntoBlocks(blocks, null, 'X').blocks));
  });

  it('텍스트 줄이 하나도 없으면 블록 배열 끝(임베드 뒤)에 덧붙인다(오늘 동작 보존)', () => {
    const blocks = [embedBlock({ embedType: 'image', src: 'x.png' })];
    const r = replaceRangeInBlocks(blocks, null, 'A\nB');
    expect(r.blocks.map((b) => b.type)).toEqual(['embed', 'text', 'text']);
    expect(blocksToText(r.blocks)).toBe('A\nB');
    expect(r.caretLineIndex).toBe(1);
    expect(blocksToText(r.blocks)).toBe(blocksToText(insertTextIntoBlocks(blocks, null, 'A\nB').blocks));
  });

  // 13. 마커가 2개인 문서 — clamp 기준은 첫 번째 마커.
  it('마커가 둘이면 첫 번째 마커가 clamp 기준이고 그 뒤 블록은 전혀 바뀌지 않는다', () => {
    const blocks = [textBlock('본문'), textBlock('(끝)'), textBlock('꼬리'), textBlock('(끝)')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 3, 3), 'X');
    expect(blocksToText(r.blocks)).toBe('본X\n(끝)\n꼬리\n(끝)');
    expect(r.blocks.slice(1)).toEqual(blocks.slice(1));
  });

  // 14. 정렬 승계.
  it('collapsed Enter는 두 결과 줄 모두 원본 줄의 align을 승계한다', () => {
    const blocks = [textBlock('가운데정렬', 'center')];
    const caret = caretAt(blocks, 0, 3);
    const r = replaceRangeInBlocks(blocks, { start: caret, end: caret }, '\n');
    expect(r.blocks).toEqual([
      { type: 'text', text: '가운데', align: 'center' },
      { type: 'text', text: '정렬', align: 'center' },
    ]);
  });

  it('비-collapsed 병합은 첫 줄이 start 줄 align, 마지막 줄이 end 줄 align을 갖는다', () => {
    const blocks = [textBlock('ab', 'center'), textBlock('cd', 'right')];
    const r = replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 1, 1), 'X\nY\nZ');
    expect(r.blocks).toEqual([
      { type: 'text', text: 'aX', align: 'center' },
      { type: 'text', text: 'Y', align: 'center' }, // 중간 새 줄 = start 줄 align
      { type: 'text', text: 'Zd', align: 'right' },
    ]);
  });

  it('무효 align은 키 자체가 생기지 않는다(isValidAlign 필터)', () => {
    const blocks = [{ type: 'text', text: 'ab', align: 'middle' }];
    const caret = caretAt(blocks, 0, 1);
    const r = replaceRangeInBlocks(blocks, { start: caret, end: caret }, '\n');
    expect(r.blocks).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
    for (const b of r.blocks) expect('align' in b).toBe(false);
  });

  // 15. 불변성.
  it('입력 blocks 배열과 원소를 mutate하지 않는다', () => {
    const embed = embedBlock({ embedType: 'image', src: 'x.png' });
    const blocks = [textBlock('ab', 'center'), embed, textBlock('cd'), textBlock('(끝)')];
    const before = snapshot(blocks);
    replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 2, 1), 'X\nY');
    replaceRangeInBlocks(blocks, null, 'Z');
    replaceRangeInBlocks(blocks, rangeAt(blocks, 2, 1, 0, 0), '\n');
    expect(snapshot(blocks)).toEqual(before);
    expect(blocks[1]).toBe(embed); // 원소 교체/변형 없음
  });
});
