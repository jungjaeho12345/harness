import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectAllInEditor,
  selectLineInEditor,
  selectWordInEditor,
  selectParagraphInEditor,
} from './editorSelect.js';

// editorSelect — 전체 선택 view 헬퍼(selection API만 사용, 본문/DOM 텍스트 무변경).
// jsdom selection API로 root 내용이 selection으로 잡히는지 검증한다.
describe('editorSelect — selectAllInEditor(root)', () => {
  let root;
  beforeEach(() => {
    window.getSelection().removeAllRanges();
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.className = 'yh-editor';
    root.contentEditable = 'true';
    root.innerHTML = '<div class="yh-editor__line">첫째 줄</div><div class="yh-editor__line">둘째 줄</div>';
    document.body.appendChild(root);
  });

  it('root 내용을 selection으로 잡는다(선택 범위가 root를 감싼다)', () => {
    selectAllInEditor(root);
    const sel = window.getSelection();
    expect(sel.rangeCount).toBe(1);
    const range = sel.getRangeAt(0);
    // 선택 범위가 root의 내용(두 줄)을 감싼다 — 공통 조상은 root(또는 그 후손).
    expect(root.contains(range.commonAncestorContainer)).toBe(true);
    // 선택된 텍스트가 본문 전체를 포함한다.
    expect(sel.toString()).toContain('첫째 줄');
    expect(sel.toString()).toContain('둘째 줄');
  });

  it('본문 텍스트/DOM 구조를 바꾸지 않는다(선택만)', () => {
    const before = root.innerHTML;
    const lineCount = root.querySelectorAll('.yh-editor__line').length;
    selectAllInEditor(root);
    expect(root.innerHTML).toBe(before); // DOM 텍스트/구조 불변
    expect(root.querySelectorAll('.yh-editor__line').length).toBe(lineCount);
  });

  it('root가 없으면(null) 조용히 no-op(예외 없음, selection 무변경)', () => {
    window.getSelection().removeAllRanges();
    expect(() => selectAllInEditor(null)).not.toThrow();
    expect(window.getSelection().rangeCount).toBe(0);
  });
});

// 줄/단어/문단 선택 적용기 — 경계 계산 없이 호출부가 준 좌표로 Range만 건다(덤 적용기).
describe('editorSelect — selectLineInEditor(root, lineIndex)', () => {
  let root;
  beforeEach(() => {
    window.getSelection().removeAllRanges();
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.className = 'yh-editor';
    root.contentEditable = 'true';
    root.innerHTML =
      '<div class="yh-editor__line">첫째 줄</div><div class="yh-editor__line">둘째 줄</div><div class="yh-editor__line">셋째 줄</div>';
    document.body.appendChild(root);
  });

  it('지정 줄 내용 전체를 선택한다(다른 줄은 잡히지 않는다)', () => {
    selectLineInEditor(root, 1);
    const sel = window.getSelection();
    expect(sel.rangeCount).toBe(1);
    expect(sel.toString()).toBe('둘째 줄');
    expect(sel.toString()).not.toContain('첫째 줄');
    expect(sel.toString()).not.toContain('셋째 줄');
  });

  it('본문 텍스트/DOM 구조를 바꾸지 않는다(선택만)', () => {
    const before = root.innerHTML;
    selectLineInEditor(root, 0);
    expect(root.innerHTML).toBe(before);
    expect(root.querySelectorAll('.yh-editor__line').length).toBe(3);
  });

  it('null root/범위 밖 lineIndex면 조용히 no-op(예외 없음, DOM·선택 무변경)', () => {
    const before = root.innerHTML;
    window.getSelection().removeAllRanges();
    expect(() => selectLineInEditor(null, 0)).not.toThrow();
    expect(() => selectLineInEditor(root, 99)).not.toThrow();
    expect(() => selectLineInEditor(root, -1)).not.toThrow();
    expect(window.getSelection().rangeCount).toBe(0);
    expect(root.innerHTML).toBe(before);
  });
});

describe('editorSelect — selectWordInEditor(root, lineIndex, colStart, colEnd)', () => {
  let root;
  beforeEach(() => {
    window.getSelection().removeAllRanges();
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.className = 'yh-editor';
    root.contentEditable = 'true';
    root.innerHTML =
      '<div class="yh-editor__line">hello world</div><div class="yh-editor__line">안녕 세상</div>';
    document.body.appendChild(root);
  });

  it('줄-로컬 [colStart, colEnd) 문자 범위를 선택한다', () => {
    selectWordInEditor(root, 0, 0, 5);
    const sel = window.getSelection();
    expect(sel.rangeCount).toBe(1);
    expect(sel.toString()).toBe('hello');
  });

  it('한글 단어도 선택한다(UTF-8)', () => {
    selectWordInEditor(root, 1, 3, 5);
    expect(window.getSelection().toString()).toBe('세상');
  });

  it('빈 범위(colStart===colEnd)면 선택하지 않는다(no-op — 단어 없음 신호)', () => {
    window.getSelection().removeAllRanges();
    selectWordInEditor(root, 0, 3, 3);
    expect(window.getSelection().rangeCount).toBe(0);
  });

  it('colStart/colEnd는 줄 전체 텍스트 길이로 clamp된다', () => {
    selectWordInEditor(root, 0, 6, 99);
    expect(window.getSelection().toString()).toBe('world');
  });

  it('빈 줄(텍스트 노드 없음)/null root/범위 밖 lineIndex → no-op(예외 없음, DOM·선택 무변경)', () => {
    root.innerHTML = '<div class="yh-editor__line"></div>';
    const before = root.innerHTML;
    window.getSelection().removeAllRanges();
    expect(() => selectWordInEditor(root, 0, 0, 3)).not.toThrow(); // 빈 줄
    expect(() => selectWordInEditor(null, 0, 0, 3)).not.toThrow(); // null root
    expect(() => selectWordInEditor(root, 9, 0, 3)).not.toThrow(); // 범위 밖 줄
    expect(window.getSelection().rangeCount).toBe(0);
    expect(root.innerHTML).toBe(before);
  });

  // 맞춤법 하이라이트가 켜진 줄은 [텍스트, span.yh-editor__spell, 텍스트]로 쪼개진다(phase 39 렌더).
  // 줄-로컬 col은 줄 전체 텍스트 기준(캐럿 읽기 39-1 계약과 동형) — 다중 노드 줄에서도 정확히 그 단어가 선택돼야 한다.
  const HL_LINE =
    '<div class="yh-editor__line">hello <span class="yh-editor__spell yh-editor__spell--bold" data-testid="spell-hl">wor</span>ld again</div>';

  it('하이라이트 뒤쪽 단어를 선택한다(스팬 뒤 텍스트 노드 — 줄 텍스트 "hello world again"의 again)', () => {
    root.innerHTML = HL_LINE;
    selectWordInEditor(root, 0, 12, 17);
    const sel = window.getSelection();
    expect(sel.rangeCount).toBe(1);
    expect(sel.toString()).toBe('again');
  });

  it('첫 단어가 하이라이트인 줄에서도 첫 단어를 선택한다(첫 자식이 span)', () => {
    root.innerHTML =
      '<div class="yh-editor__line"><span class="yh-editor__spell yh-editor__spell--bold" data-testid="spell-hl">hello</span> world</div>';
    selectWordInEditor(root, 0, 0, 5);
    const sel = window.getSelection();
    expect(sel.rangeCount).toBe(1);
    expect(sel.toString()).toBe('hello');
  });

  it('하이라이트 경계를 걸친 단어는 전체가 선택된다(시작·끝이 서로 다른 노드, 끝이 줄 끝 경계)', () => {
    // 줄 텍스트 "foo barbaz" — 하이라이트가 마지막 단어 barbaz의 가운데 "arb"만 덮는다.
    // 시작(4)은 스팬 앞 텍스트 노드 안, 끝(10)은 줄 전체 길이(=누적 구간 경계) — 앞 노드의 끝에 붙어야 한다.
    root.innerHTML =
      '<div class="yh-editor__line">foo b<span class="yh-editor__spell yh-editor__spell--bold" data-testid="spell-hl">arb</span>az</div>';
    selectWordInEditor(root, 0, 4, 10);
    const sel = window.getSelection();
    expect(sel.rangeCount).toBe(1);
    expect(sel.toString()).toBe('barbaz');
  });

  it('다중 노드 줄에서도 clamp 기준은 줄 전체 텍스트 길이다(끝이 넘치면 줄 끝까지)', () => {
    root.innerHTML = HL_LINE;
    selectWordInEditor(root, 0, 12, 99);
    expect(window.getSelection().toString()).toBe('again');
  });

  it('다중 노드 줄의 no-op 계약 — 빈 범위/텍스트 없음/범위 밖 줄/null root(예외 없음, 선택 무변경)', () => {
    root.innerHTML = HL_LINE;
    window.getSelection().removeAllRanges();
    expect(() => selectWordInEditor(root, 0, 3, 3)).not.toThrow(); // 빈 범위(시작=끝)
    expect(() => selectWordInEditor(root, 9, 0, 3)).not.toThrow(); // 범위 밖 줄
    expect(() => selectWordInEditor(null, 0, 0, 3)).not.toThrow(); // null root
    root.innerHTML = '<div class="yh-editor__line"><br></div>'; // 텍스트 노드가 하나도 없는 줄
    expect(() => selectWordInEditor(root, 0, 0, 3)).not.toThrow();
    expect(window.getSelection().rangeCount).toBe(0);
  });

  it('다중 노드 케이스 실행 후에도 줄 마크업이 그대로다(선택 연산만 — DOM 무변경)', () => {
    root.innerHTML = HL_LINE;
    const before = root.innerHTML;
    selectWordInEditor(root, 0, 12, 17); // 스팬 뒤 단어
    selectWordInEditor(root, 0, 0, 6); // 스팬 앞 경계 걸침
    expect(root.innerHTML).toBe(before);
    expect(root.querySelectorAll('[data-testid="spell-hl"]').length).toBe(1);
  });
});

describe('editorSelect — selectParagraphInEditor(root, startLine, endLine)', () => {
  let root;
  beforeEach(() => {
    window.getSelection().removeAllRanges();
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.className = 'yh-editor';
    root.contentEditable = 'true';
    root.innerHTML =
      '<div class="yh-editor__line">첫째 줄</div><div class="yh-editor__line">둘째 줄</div><div class="yh-editor__line">셋째 줄</div><div class="yh-editor__line">넷째 줄</div>';
    document.body.appendChild(root);
  });

  it('startLine..endLine(포함)의 줄들을 하나의 범위로 선택한다', () => {
    selectParagraphInEditor(root, 1, 2);
    const sel = window.getSelection();
    expect(sel.rangeCount).toBe(1);
    const text = sel.toString();
    expect(text).toContain('둘째 줄');
    expect(text).toContain('셋째 줄');
    expect(text).not.toContain('첫째 줄');
    expect(text).not.toContain('넷째 줄');
  });

  it('본문 텍스트/DOM 구조를 바꾸지 않는다(선택만)', () => {
    const before = root.innerHTML;
    selectParagraphInEditor(root, 0, 3);
    expect(root.innerHTML).toBe(before);
    expect(root.querySelectorAll('.yh-editor__line').length).toBe(4);
  });

  it('startLine > endLine이면 swap하여 선택한다', () => {
    selectParagraphInEditor(root, 2, 1);
    const text = window.getSelection().toString();
    expect(text).toContain('둘째 줄');
    expect(text).toContain('셋째 줄');
    expect(text).not.toContain('첫째 줄');
  });

  it('범위 밖 인덱스는 존재하는 줄 개수로 clamp한다', () => {
    selectParagraphInEditor(root, 2, 99);
    const text = window.getSelection().toString();
    expect(text).toContain('셋째 줄');
    expect(text).toContain('넷째 줄');
    expect(text).not.toContain('둘째 줄');
  });

  it('null root/줄 없음이면 조용히 no-op(예외 없음, 선택 무변경)', () => {
    window.getSelection().removeAllRanges();
    expect(() => selectParagraphInEditor(null, 0, 1)).not.toThrow();
    const empty = document.createElement('div');
    expect(() => selectParagraphInEditor(empty, 0, 1)).not.toThrow();
    expect(window.getSelection().rangeCount).toBe(0);
  });
});
