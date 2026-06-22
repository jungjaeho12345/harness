import { describe, it, expect, beforeEach } from 'vitest';
import { selectAllInEditor } from './editorSelect.js';

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
