# Step 1: writer-page-wiring — 도구>파일 정보 결선(통계 스냅샷 + 다이얼로그)

## 배경 / 요구사항

Step 0이 순수 통계 함수(`editorStats.charCount`/`lineCount`)와 읽기전용 `FileInfoDialog.jsx`를 만들었다. 이 step은 `web/src/view/WriterPage.jsx`에서 도구 메뉴 **'파일 정보'**(`tools.fileInfo`)를 결선한다 — 메뉴 클릭 시 **열린 시점의 본문 통계를 계산해** `FileInfoDialog`에 주입하고 다이얼로그를 띄운다.

**읽기전용**이라 본문/캐럿/임베드를 바꾸지 않는다 — 따라서 **매핑 모드(텍스트 잠금)에서도 안전**하다(별도 매핑 가드 불필요). 통계는 **열 때의 스냅샷**으로 충분하다(실시간 구독 불필요 — 다이얼로그를 여는 시점에 한 번 계산해 주입).

기존 결선 패턴을 그대로 따른다(`web/src/view/WriterPage.jsx`):
- 메뉴 활성: `MENU_ENABLED` 배열에 id 추가.
- 라우팅: `onMenuSelect(id)`에 분기 추가.
- 표시 토글 state: `showFind`/`showGlyphInput`/`urlEmbedKind`와 동일한 boolean state.
- 다이얼로그 배치: `<GlyphInputDialog>`/`<UrlEmbedDialog>` 옆에 `<FileInfoDialog>` 추가.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC, 명령어.
- `/docs/ADR.md` — ADR-003(View 순수·transport 비의존), ADR-004(매핑/본문 불변식은 본문 변경에만 적용 — 읽기전용은 무관).
- `/docs/news.md` — L180(도구 메뉴 '파일 정보').
- `web/src/view/WriterPage.jsx` — **결선 지점(실측)**:
  - `MENU_ENABLED` 배열(L68) — 여기에 `'tools.fileInfo'`를 추가한다.
  - `onMenuSelect(id)`(L292~) — 분기 라우팅 패턴. **읽기전용이라 매핑 가드(`if (isMapping) return;`) 앞에 둔다**(임베드 삽입 항목들과 동일 위치 — 매핑에서도 열려야 함, 죽은 버튼 방지).
  - `showGlyphInput`/`urlEmbedKind` state 선언부(L104~106) — 동일 패턴의 표시 state를 추가(`showFileInfo`).
  - `blocks`(L147 — `deserialize(body)`), `bodyText`(L163 — `blocksToText(blocks)`) — 통계 입력 좌표.
  - `statusCaret`(L92) — StatusBar에 쓰는 마지막 캐럿(`{lineIndex, offset}` 또는 null). 파일 정보의 캐럿 위치 소스로 **그대로 재사용**한다(라이브 readCaret 금지 — 메뉴 클릭으로 포커스가 빠짐, 이미 `statusCaret`/`lastCaretRef`가 그 목적). `lastCaretRef.current`도 동일 값을 들고 있다 — 둘 중 **state인 `statusCaret`**를 캐럿 소스로 쓴다(렌더 시점 일관).
  - 다이얼로그 렌더 블록(L647~696 — `<EditorPrefsDialog>`/`<FindReplaceDialog>`/`<GlyphInputDialog>`/`<UrlEmbedDialog>`/`<EditorContextMenu>`) — 여기에 `<FileInfoDialog>`를 추가한다.
- `web/src/view/FileInfoDialog.jsx` (Step 0 산출물) — props 계약: `open`, `stats`(`{ chars, words, bytes, lines, embeds, paragraph, row, column }`), `onClose`.
- `web/src/view/editorStats.js` (Step 0 보강) — `charCount`/`lineCount`/`wordCount`/`byteLength`/`caretPosition` import해 통계 계산.
- `web/src/view/editorContent.js` — `blocksToText(blocks)`(텍스트 통계 입력), `isEmbedBlock(block)`(임베드 개수 계산용 — `blocks.filter(isEmbedBlock).length`). 이미 WriterPage가 `blocksToText`를 import 중(L28).
- `web/src/view/StatusBar.jsx` — 캐럿 표기(`{paragraph}단락 {row}행 {column}열`)·`caretPosition(text, caret)` 사용법 참고(동일 좌표로 파일 정보 캐럿 산출).
- `web/src/view/WriterPage.test.jsx` — **테스트 컨벤션**: fakeModel/렌더, 메뉴 열기→항목 클릭, 다이얼로그 오픈/닫기, 메뉴 활성/비활성 단언. phase18/19가 `tools.insert*` 결선을 추가한 패턴을 그대로 따른다.

## 작업

TDD로 진행한다(vitest). **`WriterPage.test.jsx`에 단언을 먼저 추가**하고 통과하는 결선을 만든다.

### 결선 (시그니처/배치 수준 — 구현 재량)

1. **import**: `web/src/view/WriterPage.jsx` 상단에 `import { FileInfoDialog } from './FileInfoDialog.jsx';` 와 `import { charCount, lineCount, wordCount, byteLength, caretPosition } from './editorStats.js';` (이미 import된 것과 중복 없게 정리). `isEmbedBlock`는 `editorContent.js`에서 추가 import(기존 `deserialize/serialize/hasEndMarker/blocksToText` import 라인에 합친다).

2. **표시 state**: `const [showFileInfo, setShowFileInfo] = useState(false);` — `showGlyphInput` 패턴과 동일.

3. **통계 계산(열 때 스냅샷)**: 다이얼로그에 주입할 `stats` 객체를 만든다. 두 방식 중 택1(재량):
   - (a) 메뉴 클릭 핸들러에서 즉시 계산해 state에 저장, 또는
   - (b) 렌더 중 `showFileInfo`가 true일 때만 파생 계산(effect/타이머 없이, 찾기 매치 파생계산 패턴과 동일).
   둘 중 어느 쪽이든 다음을 만족한다:
   ```js
   // bodyText = blocksToText(blocks) (이미 존재), caret = statusCaret
   const cp = caretPosition(bodyText, statusCaret);
   const stats = {
     chars: charCount(bodyText),
     words: wordCount(bodyText),
     bytes: byteLength(bodyText),
     lines: lineCount(bodyText),
     embeds: blocks.filter(isEmbedBlock).length, // 블록 레벨 — 임베드 개수
     paragraph: cp.paragraph,
     row: cp.row,
     column: cp.column,
   };
   ```
   **임베드 개수는 `blocks`(텍스트+임베드 전체)에서 계산**한다(`bodyText`는 텍스트만이라 임베드가 빠짐 — 반드시 `blocks.filter(isEmbedBlock)`).

4. **라우팅**: `onMenuSelect`에 분기를 추가한다 — **매핑 가드 앞**(읽기전용이라 매핑에서도 열림):
   ```js
   if (id === 'tools.fileInfo') { setShowFileInfo(true); return; }
   ```
   (기존 `tools.insertImage` 등 임베드 분기와 같은 영역. 본문을 바꾸지 않으므로 `isMapping` 체크 불필요.)

5. **MENU_ENABLED**: 배열에 `'tools.fileInfo'`를 추가한다.

6. **다이얼로그 렌더**: 기존 다이얼로그들 옆에 추가한다:
   ```jsx
   <FileInfoDialog
     open={showFileInfo}
     stats={stats}
     onClose={() => setShowFileInfo(false)}
   />
   ```

> **주의**: `Editor`에 새 prop을 넘기지 마라. `updateField`/`insertEmbed`/`serialize`를 이 경로에서 호출하지 마라(읽기전용 — 본문 무변경). 통계는 표시만 한다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **읽기전용 — 본문/캐럿/임베드 무변경**: 파일 정보 경로에서 `updateField`·`serialize`·`insertEmbed`·`setPendingCaretLine` 등 본문/캐럿 변경 호출을 하지 마라. `setShowFileInfo`와 통계 계산(순수 읽기)만 한다. 이유: 읽기전용 불변식 — 매핑 모드에서도 안전해야 한다.
2. **매핑 가드 앞 배치**: `tools.fileInfo` 분기는 `if (isMapping) return;`(L303) **앞**에 둔다. 이유: 읽기전용이라 매핑에서도 열려야 함(임베드 삽입 항목과 동일 정책 — 죽은 버튼 방지).
3. **캐럿 소스 = `statusCaret`(또는 동일 값 `lastCaretRef.current`)**: 메뉴 클릭으로 에디터 포커스가 빠지므로 라이브 `readCaret`을 호출하지 마라. 이미 보관 중인 `statusCaret`을 `caretPosition`의 caret 인자로 쓴다. 이유: 포커스 이탈 시 라이브 캐럿은 null — StatusBar와 동일 소스로 일관.
4. **임베드 개수는 `blocks`에서**: `blocks.filter(isEmbedBlock).length`. `bodyText`(텍스트만)로 세지 마라. 이유: 임베드 블록은 텍스트 직렬화에서 제외됨 — 잘못된 0이 표시된다.
5. **기존 메뉴 id 재사용**: `EditorMenuBar`의 `tools.fileInfo`(라벨 '파일 정보')를 그대로 결선한다. **새 id·새 라벨을 추가하지 마라**(BLOCKER 전력 — 신규 id로 매칭하면 메뉴가 죽는다). 이유: 라벨 매칭이 아니라 안정 id 매칭.
6. **server/editorPrefs 미변경**: client 전용 표시 기능이다. `server/`·`editorPrefs`·DB 스키마를 건드리지 마라. 이유: DB 비파괴·표시 전용.
7. **비결선 메뉴 비활성 유지**: `MENU_ENABLED`에 `tools.fileInfo`만 추가한다. 다른 미결선 항목(약어변환·메모장 등)을 함께 켜지 마라. 이유: Scope 최소화.

## Acceptance Criteria

```bash
cd web && npm run test -- WriterPage    # 신규 파일 정보 결선 단언 통과
cd .. && npm run test:web                # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx`):
- 도구 메뉴의 '파일 정보' 항목이 **활성**이다(이전엔 disabled placeholder였음 — 비활성→활성 전환 단언).
- '파일 정보' 클릭 시 `FileInfoDialog`(testid `file-info`, `role="dialog"` '파일 정보')가 열린다.
- 본문에 텍스트/임베드가 있는 탭에서 열면 주입된 통계가 표시된다 — 최소 한 항목 이상을 본문에서 계산한 값과 일치 단언(예: 글자수 또는 단어수가 본문에 맞는 값, 임베드가 1개면 `file-info-embeds`가 1).
- 캐럿 위치가 표시된다(`file-info-caret` — `{paragraph}단락 {row}행 {column}열` 형식). 포커스 전(캐럿 없음)에도 기본값(1단락 1행 1열)으로 죽지 않음을 단언.
- '닫기' 또는 Esc로 다이얼로그가 닫힌다(`file-info`가 사라짐).
- **읽기전용 검증**: 파일 정보를 열고 닫아도 본문(`updateField`)이 변경되지 않는다 — fakeModel/컨트롤러 상으로 본문 불변 단언, 또는 다이얼로그에 입력 필드가 없음을 단언.
- **매핑 모드에서도 열린다**: 매핑 탭(`mode==='mapping'`)에서도 '파일 정보'가 활성이고 다이얼로그가 열린다(임베드 삽입 항목과 동일 — 읽기전용이라 안전).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 읽기전용(본문/캐럿/임베드 무변경)·매핑 가드 앞 배치·캐럿 소스 statusCaret·임베드는 blocks 기준·기존 id 재사용·server/editorPrefs 불변·MENU_ENABLED에 fileInfo만 추가.
3. 결과에 따라 `phases/21-editor-file-info/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- 파일 정보 경로에서 `updateField`/`serialize`/`insertEmbed`/`setPendingCaretLine`/`Editor`의 새 prop을 쓰지 마라. 이유: 읽기전용 — 본문/캐럿 무변경(매핑 안전).
- `tools.fileInfo` 분기를 매핑 가드(`if (isMapping) return;`) 뒤에 두지 마라. 이유: 읽기전용이라 매핑에서도 열려야 함(죽은 버튼 방지).
- 라이브 `readCaret(...)`을 이 경로에서 호출하지 마라. 이유: 메뉴 클릭으로 포커스가 빠져 null — `statusCaret`을 캐럿 소스로 쓴다.
- 임베드 개수를 `bodyText`(텍스트만)나 `wordCount` 등으로 세지 마라 — `blocks.filter(isEmbedBlock).length`만 쓴다. 이유: 임베드는 텍스트 직렬화에서 제외됨(잘못된 0).
- `tools.fileInfo`에 새 메뉴 id/라벨을 만들지 마라(기존 id 그대로 결선). 이유: id 불일치로 메뉴가 죽는다(BLOCKER 전력).
- `Editor.jsx`·`EditorMenuBar.jsx`·`StatusBar.jsx`·`server/`·`editorPrefs`·DB 스키마를 수정하지 마라. 이유: 결선만 — Editor 미접촉·client 전용·DB 비파괴.
- `MENU_ENABLED`에 `tools.fileInfo` 외 다른 미결선 항목을 추가하지 마라. 이유: Scope 최소화.
