// 에디터 상태표시줄(표시 전용) — 워드수·Byte·N단락 N행 N열·삽입/수정·언어.
// 순수 표시 컴포넌트: props만으로 렌더(내부 상태/effect/타이머 없음). WriterPage 주입은 Step 3.
// language는 언어 코드('ko' 등) — languageLabel로 라벨 표시. inputMode('unicode'|'ksc5601')는
// 바이트 계산 모드 — ksc5601이면 EUC-KR 근사 바이트 + 비호환 개수 병기, unicode면 현행 UTF-8.
// 삽입/수정(overwrite)은 이번 phase에서 동작하지 않는 placeholder다.

import { wordCount, byteLength, caretPosition } from './editorStats.js';
import { normalizeInputMode, euckrStats } from './editorEncoding.js';
import { languageLabel } from './editorLanguage.js';

export function StatusBar({ text = '', caret = null, language = 'ko', inputMode = 'unicode', overwrite = false }) {
  const { paragraph, row, column } = caretPosition(text, caret);
  const mode = normalizeInputMode(inputMode);
  const euckr = mode === 'ksc5601' ? euckrStats(text) : null;
  const bytes = euckr ? euckr.bytes : byteLength(text);
  const incompatible = euckr ? euckr.incompatible : 0;
  return (
    <div className="yh-editor-statusbar" role="status" aria-label="에디터 상태">
      <span className="yh-editor-statusbar__item" data-testid="stat-words">{wordCount(text)}단어</span>
      <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
      <span className="yh-editor-statusbar__item" data-testid="stat-bytes">{bytes}B</span>
      {incompatible > 0 && (
        <>
          <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
          <span className="yh-editor-statusbar__item" data-testid="stat-incompat">비호환 {incompatible}자</span>
        </>
      )}
      <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
      <span className="yh-editor-statusbar__item" data-testid="stat-caret">{paragraph}단락 {row}행 {column}열</span>
      <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
      <span className="yh-editor-statusbar__item" data-testid="stat-mode">{overwrite ? '수정' : '삽입'}</span>
      <span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>
      <span className="yh-editor-statusbar__item" data-testid="stat-language">{languageLabel(language)}</span>
    </div>
  );
}
