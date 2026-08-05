# Step 0: selection-range-model

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md` — TDD(테스트 먼저), DB 비파괴
- `docs/ADR.md` — ADR-003(Model/View/Controller 분리, View는 순수 로직 + 컴포넌트)
- `docs/ARCHITECTURE.md` — 프론트엔드 MVC(View ← Controller ← Model)
- `docs/news.md` 158~178행 — 기사 에디터 규칙. 특히 167~170행("(끝)" 마커는 자기 줄·최종 블록, 마커 뒤 입력 차단, 삭제/이동/선택은 항상 허용), 173~175행(줄 삭제 시 임베드 동반 삭제·임베드 × 버튼·블록 구조 보존)
- `web/src/view/editorNewline.js` — **이 step이 수정하는 유일한 프로덕션 파일**. `insertTextIntoBlocks(blocks, caret, text)`(L70~114)의 좌표 계약과 폴백 분기를 정독하라
- `web/src/view/editorContent.js` — `textBlock(text, align)`·`normalizeBlocks`·`blocksToText`·`isTextBlock`/`isEmbedBlock`·`isValidAlign`·`END_MARKER`
- `web/src/view/writerBody.js` L16~25 — `serializeBodyFromBlocks`가 `String(b.text).trim() === END_MARKER`로 마커 블록을 식별해 항상 최종 블록으로 재정규화한다(이 step이 지켜야 할 계약)
- `web/src/view/editorClipboard.js` L13~33 — `insertTextIntoBlocks`의 또 다른 호출부(편집 메뉴 '텍스트 붙여넣기'). 시그니처를 바꾸면 여기가 깨진다. **특히 L24~27**: 캐럿 미상 + 마커 있는 본문이면 아예 no-op으로 막는다("폴백(마지막 텍스트 줄 끝)이 마커 줄을 오염시킬 수 있어") — 같은 위험을 이 step이 순수 계층에서 구조적으로 없앤다
- `web/src/view/editorDate.js` L86~92, `web/src/view/editorGlyph.js` L84~90 — align 승계 관례("교체-전 원본에서 읽어 승계한다. 새 줄 생성 분기는 승계 대상 아님")
- `web/src/view/editorNewline.test.js`, `web/src/view/editorClipboard.test.js` — 기존 계약 테스트

## 배경 (이 step 안에서 자기완결)

`web/src/view/Editor.jsx`는 Enter(L463~467)와 여러 줄 붙여넣기(L497~504)에서 `e.preventDefault()`로 브라우저 기본 동작을 막고 `emitInsert`로 위임한다. `emitInsert`는 캐럿 한 점만 읽어 `insertTextIntoBlocks`로 "순수 삽입"을 하는데, **선택 범위(비-collapsed selection)를 지우는 코드가 경로 전체에 없다.**

재현: 본문 `hello world`에서 `world`를 선택하고 `A\nB`를 붙여넣으면 기대값은 `hello A` / `B`인데 실제로는 `hello A` / `Bworld`가 되어 선택 텍스트가 잔존한다. Enter도 동일하다. 한 줄 붙여넣기는 `preventDefault`를 하지 않아 네이티브가 선택을 정상 대체하므로 **같은 제스처가 입력 내용에 따라 다르게 동작**한다.

이 step은 그 결함을 닫는 **순수 계층 함수**를 만든다. DOM에서 선택 범위를 읽어 좌표로 환산하는 일과 결선은 step 1(Editor.jsx)이 한다. 이 step은 DOM을 전혀 건드리지 않는다.

## 작업

### 1) 착수 전 실측

```bash
npm run test:web    # 87 files / 2011 tests pass 가 phase 시작 기준선
npm run lint
npm run build
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`web/src/view/editorNewline.test.js`에 `replaceRangeInBlocks` describe 블록을 추가한다. 좌표 헬퍼는 기존 `caretAt(blocks, lineIndex, inLine)` 패턴을 그대로 재사용하라.

결함 재현 케이스(구현 전 red여야 한다):

1. `[textBlock('hello world')]` + range = (line0,col6)~(line0,col11) + text `'A\nB'` → `blocksToText` 결과가 정확히 `'hello A\nB'`(선택 텍스트 `world` 소멸), `caretLineIndex === 1`.
2. 같은 range + text `'\n'`(Enter) → `'hello \n'`(선택 삭제 후 분할).
3. 여러 줄에 걸친 선택: `['ab','cd','ef']`에서 (line0,col1)~(line2,col1) + `'X'` → `'aXf'` 한 줄(중간 줄 제거 + head/tail 병합).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

4. **collapsed 동치성**: 대표 fixture 여러 개(줄 중간 / 줄 끝 / 첫 줄 / 마지막 줄 / 임베드 포함 / 캐럿 null)에 대해 `blocksToText(replaceRangeInBlocks(b, { start: c, end: c }, t).blocks)`가 `blocksToText(insertTextIntoBlocks(b, c, t).blocks)`와 **문자열로 동일**하고 `caretLineIndex`도 같다. `range: null`·`{ start: null, end: null }`도 캐럿 미상 폴백과 동일해야 한다.
   - **단 하나의 예외**: "캐럿 미상 + 마커 있는 문서"는 규칙 1-b(폴백 대상 = 마커 줄 직전)로 결과가 의도적으로 달라진다(케이스 11). 동치성 fixture의 캐럿 null 항목은 **마커 없는 문서**로 구성하고, 마커 있는 문서는 케이스 11에서 새 기대값으로 단언하라.
5. 기존 `insertTextIntoBlocks` describe 블록 전체가 그대로 green이다(텍스트 결과 계약 불변).

경계·계약 케이스:

6. **역방향 선택**: start와 end를 뒤바꿔 넘겨도 4·1과 같은 결과(내부 정규화).
7. **임베드 보존**: `[text('ab'), embed(E), text('cd')]`에서 (line0,col1)~(line1,col1) + `'X'` → 임베드 E가 결과 블록 배열에 **그대로 남아 있고**(개수·내용 동일), 텍스트는 `'aXd'`이며, 남은 임베드는 병합된 텍스트 줄 뒤에 원래 상대 순서로 온다.
8. **마커 clamp**: `[text('본문'), text('꼬리'), text('(끝)')]`에서 (line0,col1)~(line2,col3)(마커 줄 끝까지) 선택 + `'X'` → 결과 블록에 `{ type:'text', text:'(끝)' }` 블록이 **정확히 하나 그대로** 남고, `serializeBodyFromBlocks(결과 blocks)`(`web/src/view/writerBody.js` import)를 `deserialize`하면 마커가 여전히 **최종 블록**이다. 마커 줄 텍스트에 다른 문자가 붙지 않는다.
9. **마커 앞 삭제는 정상 동작**: 같은 문서에서 (line0,col1)~(line1,col2) 선택 + `'X'` → `'본X'` + `'(끝)'`(마커 온전, 앞 줄만 삭제·병합).
10. **문서 전 범위 선택**(step 1의 '전체 선택' 제스처가 만드는 좌표): `['ab','cd','ef']`에서 (line0,col0)~(line2,col2) + `'A\nB'` → `'A\nB'`(문서가 통째로 대체된다). 임베드가 섞여 있으면 임베드는 그대로 남는다(규칙 4).
11. **캐럿 미상 + 마커 폴백(결함 재현 — 구현 전 red)**: `[text('본문'), text('(끝)')]` + `range: null` + `'A\nB'` → 결과가 `['본문', 'A', 'B', '(끝)']` 계열이어야 하며 **절대 `'(끝)A'`가 나오면 안 된다**. `serializeBodyFromBlocks` 라운드트립에서 `'(끝)'` 블록이 정확히 하나·최종 블록으로 유지된다. (오늘 코드는 마지막 텍스트 줄=마커 줄에 이어붙여 `'(끝)A'`를 만든다.)
12. **마커 없는 문서의 폴백은 불변**: `[text('가'), text('나')]` + `range: null` + `'X'` → 오늘의 `insertTextIntoBlocks(blocks, null, 'X')`와 동일 결과(마지막 줄 끝 덧붙임).
13. **마커가 2개인 문서**: `[text('본문'), text('(끝)'), text('꼬리'), text('(끝)')]`에서 (line0,col1)~(line3,col3) 선택 + `'X'` → clamp 기준은 **첫 번째** 마커 줄이라 첫 마커 이후 블록(둘째 마커 포함)이 전혀 변경되지 않는다.
14. **정렬 승계**: `[textBlock('가운데정렬', 'center')]`에서 collapsed 캐럿 Enter → 두 결과 줄 **모두** `align:'center'`. 비-collapsed 병합에서는 첫 줄이 start 줄 align, 마지막 줄이 end 줄 align을 갖는다. 무효 align(`'middle'` 등)은 키 자체가 생기지 않는다(`isValidAlign` 필터).
15. **불변성**: 입력 `blocks` 배열과 그 원소가 mutate되지 않는다(호출 전후 deep equal 스냅샷 비교).

### 3) 구현 — `web/src/view/editorNewline.js`만 수정

새 export를 추가한다:

```js
// range: null | { start: Point|null, end: Point|null },  Point = { lineIndex, offset }
// 반환: { blocks, caretLineIndex }  — insertTextIntoBlocks와 동일 shape
export function replaceRangeInBlocks(blocks, range, text)
```

좌표 계약(기존 `insertTextIntoBlocks`의 caret 계약과 **완전히 동일**):
- `lineIndex` = 텍스트 블록 순번(임베드 제외), `offset` = `blocksToText` 기준 절대 텍스트 오프셋.

핵심 규칙(설계 의도 — 벗어나지 마라):

1. **정규화**:
   - (a) `start`/`end` 중 하나가 없으면 있는 쪽으로 collapsed 취급한다. `(lineIndex, offset)` 비교로 start > end면 서로 바꾼다(역방향 선택).
   - (b) 둘 다 없으면(캐럿 미상) 폴백은 **"마커 줄 직전의 마지막 텍스트 줄" 끝**에 삽입한다. 마커가 없으면 오늘과 동일하게 **마지막 텍스트 줄** 끝이다.
     **이유(결함)**: 오늘의 폴백은 무조건 마지막 텍스트 줄에 이어붙이는데, 그 줄이 `'(끝)'`이면 `'(끝)A'`가 되어 `serializeBodyFromBlocks`(trim 정확 비교)가 마커를 못 알아보는 반면 송고 가드 `hasEndMarker`(substring)는 통과한다 → 오염된 본문이 송고·배부된다(불가역 스풀 기록). 실제로 step 1이 결선할 "전체 선택"(`selectNodeContents(root)`)은 **root 요소 앵커**라 `readCaret`도 null을 돌려줘 `caretBlocked`가 걸리지 않으므로 이 폴백이 실행된다. 같은 계층의 `editorClipboard.js` L24~27은 같은 위험을 "마커 있으면 통째로 no-op"으로 회피하고 있다 — 이 함수는 no-op 대신 **삽입 위치를 마커 앞으로 옮겨** 사용자의 붙여넣기를 살리면서 마커를 지킨다.
   - 텍스트 블록이 하나도 없으면 오늘과 동일(맨 앞에 새 텍스트 블록 생성).
2. **collapsed 동치**: 정규화 후 start와 end가 같으면 결과 텍스트·`caretLineIndex`가 오늘의 `insertTextIntoBlocks`와 동일해야 한다. 달라지는 것은 규칙 5의 align 키와, **규칙 1-b의 "캐럿 미상 + 마커 있는 문서" 한 경우**뿐이다(그 경우는 오늘 동작이 결함이므로 의도적으로 바뀐다).
3. **마커 end clamp**: 텍스트 줄 중 `String(text).trim() === END_MARKER`인 **첫 번째** 줄 인덱스를 M이라 하면, `end`가 M 줄 시작 이상이면 `end`를 M 직전 텍스트 줄의 끝으로 clamp한다. clamp 결과가 start보다 앞이면 삭제 없이 삽입만 한다. **M 줄과 그 뒤 블록은 이 함수가 절대 변경하지 않는다.** 이 clamp는 range 경로와 규칙 1-b 폴백 경로 **양쪽 모두**에 적용된다(폴백 삽입 지점도 M 줄 앞이어야 한다). `start`는 clamp하지 않는다(마커 뒤 삽입 차단은 호출부 책임 — Editor의 `caretBlocked`, editorClipboard의 `isInputBlocked`).
   - **마커 식별 기준이 두 가지라는 사실을 주석으로 못박아라**: 이 함수는 `trim() === END_MARKER`(블록 단위 정확 비교 — `serializeBodyFromBlocks`가 재정규화 주체이므로 **그 기준을 따른다**)를 쓰고, `isInputBlocked`는 `lastIndexOf(END_MARKER)`(텍스트 substring)를 쓴다. 둘을 섞지 마라 — 재정규화가 인식하지 못하는 줄을 보호 대상으로 삼으면 보호가 헛돌고, 반대로 substring 기준으로 clamp하면 `'(끝)'`을 본문 중간에 인용한 기사에서 정상 편집이 막힌다.
4. **임베드 보존**: 범위 안의 임베드 블록은 제거하지 않는다. 텍스트 블록만 규칙대로 병합/제거하고, 범위 안에 있던 임베드들은 원래 상대 순서를 유지한 채 병합 결과 **직후**에 배치한다.
5. **정렬 승계**: 새로 만들어지는 줄의 align은 — 첫 줄 = start 줄의 align, 마지막 줄 = end 줄의 align, 중간에 새로 생기는 줄 = start 줄의 align. 삽입 줄이 1개면(개행 없는 text) 첫 줄 = 마지막 줄이며 start 줄 align을 쓴다. `textBlock(text, align)`을 쓰면 `isValidAlign` 필터가 자동 적용된다(무효/부재는 키 생략 — 직렬화 바이트 안정).
   - `editorDate.js` L86~92·`editorGlyph.js` L84~90은 "새 줄 생성 분기는 승계 대상 아님"이라는 반대 관례를 갖는다. **여기서 승계하는 이유를 주석에 남겨라**: 그 두 곳의 "새 줄"은 삽입 대상 줄이 아예 없어서 만들어내는 **무연고 줄**이지만, Enter/범위 대체가 만드는 줄은 **원본 줄을 두 조각으로 쪼갠 연속물**이라 양쪽 모두 원본 줄의 서식을 이어받는 것이 맞다(정렬된 문단에서 Enter를 쳤을 때 양쪽이 정렬을 잃는 현행 동작은 워드프로세서 표준과도 어긋난다).
6. **caretLineIndex** = `start.lineIndex + (삽입 줄 수 - 1)`(오늘 공식과 동일).
7. **순수**: DOM/`window`/React/전역 상태 접근 0. 입력 배열·원소를 mutate하지 않는다(`normalizeBlocks` 복사본 위에서 작업).

그리고 `insertTextIntoBlocks(blocks, caret, text)`는 **시그니처·반환 shape을 유지한 채** `replaceRangeInBlocks(blocks, { start: caret, end: caret }, text)`에 위임해 로직 단일 출처를 만든다(같은 규칙을 두 벌 유지하지 마라). 캐럿 미상 폴백 분기도 새 함수 안에서 동일하게 성립해야 한다.

함수 상단에 규칙 3·4·5의 **이유**를 주석으로 남겨라(마커 계약이 풀리면 송고 가드가 substring이라 오염 본문이 통과한다 / 임베드 무음 소실 금지 / 정렬 pair-following).

## Acceptance Criteria

```bash
npm run test:web    # 2011 + 신규 케이스, fail 0
npm run lint        # clean
npm run build       # 번들 빌드 성공
npm test            # 백엔드 무접촉 확인 — 751 그대로 green
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증(각각 확인 후 반드시 원복):
   - 마커 end clamp 절을 제거하면 케이스 8·13이 red가 되는가?
   - 폴백 대상을 "마지막 텍스트 줄"로 되돌리면(규칙 1-b 제거) 케이스 11이 red가 되고 케이스 12는 green으로 남는가?
   - 임베드 보존 절을 제거(범위 안 블록을 통째로 splice)하면 케이스 7이 red가 되는가?
   - 역방향 정규화(swap)를 제거하면 케이스 6이 red가 되는가?
   - align 승계 절을 제거하면 케이스 14가 red가 되는가?
3. 아키텍처 체크리스트:
   - 수정 범위가 `web/src/view/editorNewline.js` + `web/src/view/editorNewline.test.js`뿐인가? (`Editor.jsx`·`WriterPage.jsx`·`writerBody.js`·`editorClipboard.js`·`server/`·`src/` 변경 0건)
   - ADR-003: 순수 함수에 DOM/transport 의존이 새지 않았는가?
   - CLAUDE.md: 테스트를 먼저 작성해 red를 확인했는가?
4. 결과에 따라 `phases/53-integrity-fixes/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "함수 시그니처·규칙(마커 clamp/임베드 보존/align 승계)·테스트 증감·collapsed 동치성 확인 요약"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- 범위 안의 임베드 블록을 삭제하지 마라. 이유: 미디어가 무음으로 사라지면 복구 수단이 없고, 삭제 수단은 임베드 × 버튼과 줄 삭제(news.md 173·174행)로 이미 존재한다.
- `'(끝)'` 마커 블록의 텍스트를 변형하거나 다른 줄과 합치지 마라. 이유: `serializeBodyFromBlocks`가 trim 정확 비교로 마커를 식별하므로 `'B(끝)'`이 되면 재정규화·정렬 제외·치환 가드가 전부 풀리는데, 송고 가드 `hasEndMarker`는 substring이라 **오염된 본문이 그대로 송고·배부된다**.
- `insertTextIntoBlocks`의 export 시그니처(인자 순서·반환 shape)를 바꾸지 마라. 이유: `Editor.jsx`와 `editorClipboard.js` 두 호출부가 의존하며, 이 step은 두 파일을 수정하지 않는다.
- `blocksToText` 기준 텍스트 결과를 collapsed 경로에서 바꾸지 마라. 이유: Enter는 가장 빈번한 편집 조작이고 이 phase의 결함 목록에 없다 — 텍스트가 바뀌면 회귀다(바뀌어도 되는 것은 align 키뿐). **예외는 규칙 1-b 하나뿐이다**: "캐럿 미상 + 마커 있는 문서"의 폴백 삽입 지점이 마커 줄 앞으로 옮겨진다(오늘 동작이 마커를 오염시키는 결함이므로 의도된 변경 — 케이스 11로 새 기대값을 잠근다).
- DOM/`window.getSelection`/`document`를 이 파일에서 참조하지 마라. 이유: 순수 계층 계약(ADR-003)이며, DOM 의존이 들어오면 jsdom 없이 전수 테스트가 불가능해진다.
- `web/src/view/writerBody.js`·`editorContent.js`를 수정하지 마라. 이유: 마커 정규화·블록 모델 계약은 이번 수정의 전제이지 대상이 아니다(phase 50 계획이 writerBody.js를 별도로 다룬다).
- 기존 테스트를 깨뜨리지 마라.
