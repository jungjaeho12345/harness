# Step 3: writer-drop-wiring

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md` — TDD(테스트 먼저)
- `docs/ADR.md` — ADR-003(View ← Controller ← Model, 업로드는 Model 경유)
- `docs/news.md` 192행 — 환경설정 편집 > 드래그앤드롭: "이미지를 드래그앤 드롭이 허용된다. 기본값은 된다"
- `web/src/view/WriterPage.jsx` — **이 step이 수정하는 유일한 프로덕션 파일**. 환경설정 state 게이트 패턴(L244~306: lazy init → 마운트 effect 복원 → `onPrefsClose(applied)` 갱신), `pasteImageAtCaret(file, caret)`(L1262~), `<Editor .../>` 결선부(L1545~1563)
- `web/src/view/Editor.jsx` — **step 2에서 추가된** `onDropImageFile` prop의 계약(호출 시점·인자). 이 step은 이 파일을 수정하지 않는다
- `web/src/view/editorPrefs.js` — `DEFAULT_EDITOR_PREFS.edit.dragDrop === true`, `loadEditorPrefs()`
- `web/src/view/EditorPrefsDialog.jsx` — 드래그앤드롭 체크박스(설정 저장 경로. 이 step은 수정하지 않는다)
- `web/src/view/WriterPage.test.jsx` — 붙여넣기 이미지 업로드 테스트(`model.uploadFile` 스파이 + 본문 임베드 단언 패턴)

## 배경 (이 step 안에서 자기완결)

step 2에서 `Editor`는 네이티브 드롭을 전면 차단하고, 이미지 파일만 `onDropImageFile(file, caret)`으로 상위에 위임한다. 그 prop이 없으면 **차단만** 한다.

환경설정(`edit.dragDrop`, 기본 true)은 EditorPrefsDialog에 존재하지만 에디터에 결선된 적이 없다. 이 step이 그 게이트를 결선한다:

- `dragDrop === true` → 드롭된 이미지가 **붙여넣기와 완전히 같은 경로**(`pasteImageAtCaret`: `model.uploadFile` → `/uploads` 경로 image 임베드 → `insertEmbedAtLine`)로 들어간다.
- `dragDrop === false` → prop을 주지 않아 드롭이 차단만 된다(본문 무변경).

새 업로드/삽입 경로를 만들지 않는다 — 기존 함수를 그대로 재사용하는 것이 이 step의 핵심이다(phase 20이 검증한 stale 탭·await 레이스 방어가 그 함수 안에 있다).

## 작업

### 1) 착수 전 실측

```bash
npm run test:web    # step 2까지 완료된 상태가 전부 green인지 확인
npm run lint
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`web/src/view/WriterPage.test.jsx`에 케이스를 추가한다. 드롭 이벤트는 step 2 테스트와 동형으로 만들고(`dataTransfer.items`/`files`), 본문 편집 영역(`getByRole('textbox', { name: '본문' })`)에 dispatch한다.

기능 케이스:

1. 기본 설정(dragDrop 미설정 = 기본 true)에서 이미지 파일 드롭 → `model.uploadFile`이 1회 호출되고, 본문(`saveArticle`에 실리는 `markupVersion` 또는 렌더된 임베드)에 업로드 경로를 `src`로 가진 image 임베드가 생긴다(기존 붙여넣기 테스트와 같은 단언 방식).
2. `localStorage`에 `edit.dragDrop:false`를 저장한 뒤 마운트 → 이미지 파일 드롭 → `model.uploadFile` 호출 0회, 본문 불변.
3. 환경설정 다이얼로그를 '적용'으로 닫으면 변경된 dragDrop 값이 즉시 반영된다(다른 편집 설정과 동형 게이트 — `columnLimit` 테스트가 있으면 그 패턴을 따르고, 없으면 최소한 마운트 복원만 단언해도 된다).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

4. 텍스트 드롭은 dragDrop 설정과 무관하게 본문을 바꾸지 않는다.
5. Ctrl+V 이미지 붙여넣기는 dragDrop 설정과 **무관하게** 그대로 동작한다(설정이 false여도 붙여넣기는 살아 있다).
6. 기존 WriterPage 테스트(본문 타이핑·저장·송고·임베드 삽입)가 전부 green이다.

### 3) 구현 — `web/src/view/WriterPage.jsx`만 수정

1. 환경설정 state를 기존 패턴과 **완전히 동형**으로 추가한다:

```js
const [dragDrop, setDragDrop] = useState(() => loadEditorPrefs().edit.dragDrop);
```
- 마운트 effect(L278~289 블록)에 `setDragDrop(loadEditorPrefs().edit.dragDrop);` 한 줄 추가(새로고침 후 반영).
- `onPrefsClose(applied)`의 `applied` 분기에 `setDragDrop(loadEditorPrefs().edit.dragDrop);` 한 줄 추가(취소 시 불변 — 다른 설정과 같은 게이트).

2. `<Editor ... />`에 prop 한 줄을 추가한다:

```jsx
onDropImageFile={dragDrop ? pasteImageAtCaret : undefined}
```
- `onPasteImageFile={pasteImageAtCaret}`는 **그대로 둔다**(붙여넣기는 설정과 무관).
- `pasteImageAtCaret`을 수정하지 마라 — 시그니처 `(file, caret)`가 step 2의 호출 계약과 이미 일치한다.

3. 왜 같은 함수를 재사용하는지(업로드 실패 안내·탭 전환 방어·base64 미생성이 이미 그 안에 있다)를 결선 지점 주석 한 줄로 남겨라.

## Acceptance Criteria

```bash
npm run test:web    # step2 기준선 + 신규 케이스, fail 0
npm run lint        # clean
npm run build       # 번들 빌드 성공
npm test            # 백엔드 무접촉 확인 — 751 그대로 green
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증(각각 확인 후 반드시 원복):
   - `onDropImageFile` prop을 제거하면 케이스 1이 red가 되는가?
   - 게이트를 상수 `true`로 바꾸면 케이스 2가 red가 되는가?
3. 아키텍처 체크리스트:
   - 수정 범위가 `web/src/view/WriterPage.jsx` + `web/src/view/WriterPage.test.jsx`뿐인가? (`Editor.jsx`·`editorPrefs.js`·`EditorPrefsDialog.jsx`·`server/`·`src/` 변경 0건)
   - 업로드가 여전히 `model.uploadFile`(Model 경유)로만 일어나는가?(ADR-003)
   - 새 본문 반영 경로가 생기지 않고 `commitBody`/`insertEmbedAtLine` 기존 경로만 쓰는가?
4. 결과에 따라 `phases/53-integrity-fixes/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "dragDrop 게이트 결선 지점·재사용한 핸들러·테스트 증감 요약"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- 드롭 전용 업로드/삽입 함수를 새로 만들지 마라. 이유: `pasteImageAtCaret`에는 phase 20 코드리뷰가 잡아낸 stale body·탭 전환 파손 방어(await 후 `activeTabRef` 재확인)와 실패 안내 정책이 들어 있다. 복제하면 그 방어가 빠진 두 번째 경로가 생긴다.
- `onPasteImageFile`을 `dragDrop` 게이트에 묶지 마라. 이유: 환경설정 항목은 드래그앤드롭이지 붙여넣기가 아니다(news.md 192행).
- `Editor.jsx`를 수정하지 마라. 이유: 드롭 차단·위임 계약은 step 2에서 확정됐고, 두 파일 동시 수정은 실패 격리를 막는다.
- `editorPrefs.js`의 기본값이나 저장 shape을 바꾸지 마라. 이유: `editorPrefs.test.js`가 `dragDrop: true` 기본값을 news.md 192행 근거로 잠그고 있다.
- 설정을 렌더마다 `loadEditorPrefs()`로 직접 읽어 prop을 만들지 마라. 이유: 다른 편집 설정은 전부 state + 두 게이트(마운트 복원 / 적용 시 갱신) 패턴이며, 직접 읽기는 취소한 설정까지 즉시 반영되는 비대칭을 만든다.
- 기존 테스트를 깨뜨리지 마라.
