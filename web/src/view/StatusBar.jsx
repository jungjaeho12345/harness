// 에디터 상태표시줄(표시 전용) — 워드수·Byte·N단락 N행 N열·삽입/수정·언어.
// 순수 표시 컴포넌트: props만으로 렌더(내부 상태/effect/타이머 없음). 본문·캐럿 주입은 Step 3.
// 삽입/수정(overwrite)·언어(language)는 이번 phase에서 동작하지 않는 placeholder다.

import { wordCount, byteLength, caretPosition } from './editorStats.js';

export function StatusBar({ text = '', caret = null, language = '한국어', overwrite = false }) {
  const { paragraph, row, column } = caretPosition(text, caret);
  return (
    <div className="yh-editor-statusbar" role="status" aria-label="에디터 상태">
      <span className="yh-editor-statusbar__item" data-testid="stat-words">{wordCount(text)}단어</span>
      <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
      <span className="yh-editor-statusbar__item" data-testid="stat-bytes">{byteLength(text)}B</span>
      <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
      <span className="yh-editor-statusbar__item" data-testid="stat-caret">{paragraph}단락 {row}행 {column}열</span>
      <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
      <span className="yh-editor-statusbar__item" data-testid="stat-mode">{overwrite ? '수정' : '삽입'}</span>
      <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
      <span className="yh-editor-statusbar__item" data-testid="stat-language">{language}</span>
    </div>
  );
}
