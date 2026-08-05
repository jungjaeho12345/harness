# Step 2: editor-drop-guard

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md` — TDD(테스트 먼저)
- `docs/ADR.md` — ADR-003(View는 transport 비의존 — 업로드는 Model 경유로 상위가 수행)
- `docs/news.md` 167~170행("(끝)" 마커 계약), 192행(환경설정 편집 > 드래그앤드롭: "이미지를 드래그앤 드롭이 허용된다. 기본값은 된다")
- `web/src/view/Editor.jsx` — **이 step이 수정하는 유일한 프로덕션 파일**. `handlePaste`(L480~505)의 이미지 위임 패턴, `caretBlocked`, `handleInput`(L514~522), 편집 div의 이벤트 결선부(L550~571)
- `web/src/view/editorContent.js` L84~87 — `hasEndMarker(blocks)`가 substring 판정이라는 사실
- `web/src/view/writerBody.js` L16~25 — `serializeBodyFromBlocks`가 `trim() === '(끝)'` 정확 비교로 마커를 식별한다
- `web/src/view/Editor.test.jsx` — 붙여넣기 테스트(`pasteImageEvent`/`pasteTextEvent` 헬퍼)와 `preventDefault` 스파이 패턴
- `web/src/view/editorPrefs.js` — `DEFAULT_EDITOR_PREFS.edit.dragDrop === true`(이 step은 prefs를 읽지 않는다. 게이트 결선은 step 3)

## 배경 (이 step 안에서 자기완결)

편집 div(L550~571)에는 `onDrop`/`onDragOver` 핸들러가 **없다**. `caretBlocked` 가드는 `keydown`(L468)·`paste`(L496)·`compositionstart`(L509)에만 결선돼 있다. 따라서 네이티브 드롭이 `"(끝)"` 마커 뒤·마커 줄 안쪽에 텍스트를 그대로 삽입하고, `handleInput`이 그것을 그대로 본문으로 커밋한다.

결과: 마커 줄이 `'(끝)단어'`가 되면 `serializeBodyFromBlocks`의 **trim 정확 비교**에서 마커 블록으로 인식되지 않아 재정규화·정렬 제외·치환 가드가 전부 풀리는데, 송고 가드 `hasEndMarker`는 **substring**이라 `'(끝)단어'`에도 true를 돌려준다 → **오염된 본문이 그대로 송고·배부된다**(ADR-008: 송고 즉시 스풀에 기록되며 되돌릴 수 없다).

이 step의 결정(재논의하지 마라):
- **네이티브 드롭은 전면 차단**한다(텍스트·HTML·파일 불문). 브라우저가 편집 div에 임의 DOM을 떨구는 경로를 남기지 않는다.
- **이미지 파일 드롭만** 상위로 위임한다 — news.md 192행이 정의하는 유일한 드롭 스펙이고, 위임 대상은 phase 20이 검증한 붙여넣기 이미지 경로(업로드 → 경로 임베드)와 **같은 계약**이다.
- 텍스트 드래그 이동(drag-move)은 결선하지 않는다(스펙 부재 + 원본 범위 삭제 의미론 필요 — 범위 밖).

## 작업

### 1) 착수 전 실측

```bash
npm run test:web    # step 1까지 완료된 상태가 전부 green인지 확인
npm run lint
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`web/src/view/Editor.test.jsx`에 드롭 describe 블록을 추가한다. 드롭 이벤트는 붙여넣기 헬퍼와 동형으로 만든다:

```js
const ev = createEvent.drop(box, {});
Object.defineProperty(ev, 'dataTransfer', {
  value: { files: [file], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => 'dropped text' },
});
```

결함 재현 케이스(구현 전 red여야 한다):

1. 텍스트 드롭(`dataTransfer`에 이미지 item 없음, `getData('text/plain')`가 문자열) → `preventDefault`가 호출되고 `onTextChange`가 호출되지 않으며 본문 blocks가 그대로다.
2. `[textBlock('본문'), textBlock('(끝)')]` 문서에서 마커 줄에 텍스트 드롭 → 본문 무변경(마커 오염 없음).
3. `dragover` 이벤트에서 `preventDefault`가 호출된다(드롭 이벤트 수신 보장 + 네이티브 삽입 준비 차단).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

4. 이미지 파일 드롭 + `onDropImageFile` prop 있음 → `preventDefault` 1회 + `onDropImageFile(file, caret)`이 정확히 1회 호출되고, `caret`은 현재 캐럿(`{ lineIndex, offset }`) 또는 selection이 없으면 `null`이다. `onTextChange`는 호출되지 않는다(본문 반영은 상위 책임).
5. `onDropImageFile` prop이 없으면(환경설정 off) 이미지 드롭도 **차단만** 된다 — `preventDefault`는 호출되고 본문은 불변, 콜백 호출 0회.
6. `readOnly`/`textEditable=false`(매핑·읽기전용)에서도 네이티브 드롭은 차단된다. 이미지 위임은 `onDropImageFile`이 주어졌을 때만 일어난다(매핑에서 임베드 삽입이 허용되는 기존 정책과 동형 — `onPasteImageFile` 결선과 같은 취급).
7. 기존 붙여넣기·Enter·타이핑·`"(끝)"` 차단 테스트가 전부 그대로 green이다.

### 3) 구현 — `web/src/view/Editor.jsx`만 수정

1. props에 `onDropImageFile`을 추가한다(기본값 `undefined`). `onPasteImageFile`과 **별도 prop**으로 둔다 — 상위가 환경설정으로 드롭만 끌 수 있어야 한다.

2. 핸들러 두 개를 추가하고 편집 div에 결선한다:

```js
const handleDragOver = (e) => { /* 네이티브 기본 처리 차단 + drop 이벤트 수신 보장 */ };
const handleDrop = (e) => { /* 항상 preventDefault → 이미지 파일만 위임 */ };
```

- `handleDrop`은 **어떤 경우에도 먼저 `e.preventDefault()`** 를 호출한다(조건 분기보다 앞).
- 이미지 판정: `e.dataTransfer`의 `files`/`items`에서 `type`이 `'image/'`로 시작하는 첫 파일. `items`는 `getAsFile()`로 꺼낸다(`handlePaste`의 판정과 같은 규칙 — 헬퍼로 뽑아 공유해도 좋다).
- 캐럿은 위임 **전에 동기로** `readCaret(e.currentTarget)`으로 확보해 `onDropImageFile(file, caret)`로 넘긴다(이후 비동기 업로드 동안 selection이 사라질 수 있다 — `handlePaste`와 동일 계약).
- 텍스트/HTML 등 그 외 데이터는 **아무것도 하지 않는다**(삽입 금지, 콜백 없음).
- `caretBlocked`로 이미지 드롭을 막지 마라 — 임베드 삽입은 `insertEmbedAfterLine`이 `"(끝)"`을 항상 최종 블록으로 재정규화하므로 마커 무결성이 유지된다(`handlePaste`의 이미지 분기와 동일한 이유·동일한 정책).
- 왜 전면 차단인지(마커 계약 우회 → 송고 가드 substring 통과)와 왜 이미지만 위임하는지(news.md 192행)를 주석으로 남겨라.

3. `handleInput`·`handlePaste`·`handleKeyDown`·`emitInsert`는 수정하지 않는다.

## Acceptance Criteria

```bash
npm run test:web    # step1 기준선 + 신규 케이스, fail 0
npm run lint        # clean
npm run build       # 번들 빌드 성공
npm test            # 백엔드 무접촉 확인 — 751 그대로 green
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증(각각 확인 후 반드시 원복):
   - `handleDrop`의 `preventDefault`를 제거하면 케이스 1·2가 red가 되는가?
   - 이미지 위임 분기를 제거하면 케이스 4가 red가 되는가?
3. 아키텍처 체크리스트:
   - 수정 범위가 `web/src/view/Editor.jsx` + `web/src/view/Editor.test.jsx`뿐인가? (`WriterPage.jsx`·`editorPrefs.js`·`server/`·`src/` 변경 0건)
   - Editor 안에서 `fetch`/업로드/Model 접근이 일어나지 않는가?(ADR-003 — raw File만 상위로 넘긴다)
   - base64(data URL)를 만들지 않는가?(phase 20이 제거한 본문 폭증 경로)
4. 결과에 따라 `phases/53-integrity-fixes/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "drop/dragover 차단 규칙·onDropImageFile 계약(인자·호출 조건)·테스트 증감 요약 — step3 결선이 소비할 prop 이름과 시그니처를 반드시 명시"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- 드롭된 텍스트/HTML을 본문에 삽입하지 마라. 이유: news.md에 텍스트 드롭 스펙이 없고, drag-move는 원본 범위 삭제 의미론까지 필요해 이번 결함 수정보다 회귀 표면이 크다. 이 step의 목적은 "계약 우회 경로를 닫는 것"이다.
- `document.caretRangeFromPoint`/`caretPositionFromPoint`로 드롭 좌표 캐럿을 계산하지 마라. 이유: jsdom 미구현이라 회귀 테스트를 걸 수 없고 브라우저별 비표준 분기가 프로덕션 경로에 들어간다.
- `handleDrop` 안에서 `FileReader`/`fetch`/업로드를 수행하거나 data URL 임베드를 만들지 마라. 이유: ADR-003(View는 transport 비의존)이고, phase 20이 본문 base64 폭증을 없앤 결정을 되돌리게 된다.
- 편집 div DOM을 직접 조작하지 마라(드롭 지점에 노드 삽입 등). 이유: 파일 상단 CRITICAL(브라우저 변형 DOM ↔ React 재조정 = 캐럿 소실·크래시).
- 환경설정(`loadEditorPrefs`)을 이 파일에서 읽지 마라. 이유: Editor는 prop 주입형 순수 컴포넌트이며, 설정 게이트는 step 3에서 WriterPage가 담당한다.
- `onPasteImageFile` prop을 재사용해 드롭을 처리하지 마라(같은 prop에 두 제스처를 묶지 마라). 이유: 환경설정 dragDrop이 off일 때 붙여넣기까지 함께 죽는다.
- `web/src/view/WriterPage.jsx`를 이 step에서 수정하지 마라. 이유: 두 파일 동시 수정은 실패 격리를 막는다 — 결선은 step 3이다.
- 기존 테스트를 깨뜨리지 마라.
