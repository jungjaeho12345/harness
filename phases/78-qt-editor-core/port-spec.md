# P5 에디터 코어 — 포트 스펙 (durable rule inventory)

- **상태**: 계획 산출물 (2026-09-15) — phase 78 `78-qt-editor-core`의 명세 정본.
- **왜 이 파일이 있는가**: 이전 세션이 이 스펙을 **휘발성 스크래치패드에만** 두어 유실했다(오케스트레이터 인계 사실). 이번에는 규칙·근거·발산 결정·웹-테스트 이식 지도를 전부 리포에 커밋되는 파일로 남긴다. 이 파일이 없으면 step 파일들이 각자 다른 전제로 움직인다.
- **읽는 법**: 각 규칙은 **웹 소스 `파일:행`** 을 인용한다. news.md 요구사항을 인용할 때는 언제나 `docs/news-md-overrides.md`(대장 39건)를 함께 본다 — 줄 번호가 부딪히면 대장이 이긴다(ADR-018 승계, `client-qt/README.md:1182`).
- **경계**: 이식 대상은 **순수 계산 모듈**(웹 `web/src/view/editor*.js` + `writerBody.js`)과 **텍스트 위젯**(P0 스파이크 `spikes/p0-qt-editor/`가 실증한 QPlainTextEdit 축)이다. 임베드 7종·맞춤법·찾기바꾸기·표·인쇄·다이얼로그·환경설정은 **P6**, 조회/관리 화면은 **P7**이다.

---

## 0. 좌표계·오프셋 계약 (가장 먼저 고정)

- **캐럿/선택 오프셋 = UTF-16 코드유닛.** 웹은 JS 문자열 인덱스(`.length`·`.charCodeAt`·`slice`)를 쓰고(`editorCaret.js:11-16`·`editorNewline.js:46-63`), 이는 UTF-16 코드유닛이다. Qt `QString`도 UTF-16 코드유닛 인덱스라 **1:1로 그대로 이식**한다 — 발산 아님. P0 스파이크가 이미 `editorlogic.h:26`에 "UTF-16 코드유닛 오프셋"으로 못박아 실증했다. **검증 완료(소스 대조).**
- **좌표 계약(순수 계층 공용)**: `lineIndex` = 텍스트 블록 순번(임베드 제외, 0-base), `offset`/`inLine` = `blocksToText`(텍스트 블록만 `'\n'` 조인) 기준 절대 텍스트 오프셋. `editorNewline.js:85-88`·`writerBody.js:28-40`가 정의. DOM↔좌표 환산은 웹에선 `Editor.jsx`의 `readCaret`/`readPointForInsert`(DOM 워킹, `Editor.jsx:254-303`)가 했다 — **이 DOM 워킹 코드는 이식 대상이 아니다**(Qt는 `QTextCursor`/`QTextLayout`가 대신한다). 이식하는 것은 **좌표 계약과 순수 판정**이다.
- **서로게이트 페어**: astral 문자(이모지)는 high(0xD800–0xDBFF)+low(0xDC00–0xDFFF) 2 코드유닛. overwrite 판정이 페어를 인지한다(`editorNewline.js:31-63`). Qt에서도 `QString`이 같은 페어라 로직 그대로.

---

## 1. requirements (news.md 정본 — 대장 병독)

| # | 규칙 | 출처 |
|---|---|---|
| R1 | 본문 영역 위 '본문' 라벨 미표시(aria-label 유지) | `news.md:162` |
| R2 | 1줄=제목(파랑), 2~5줄=부제(빨강), 단 부제 구간에 빈 줄 2회↑면 2줄부터 본문(검정) | `news.md:165-167`·`editorColoring.js:41-51` |
| R3 | Alt+Y → "(끝)" 골드로 최종 블록 삽입(본문→임베드→"(끝)"), 이미 있으면 미삽입 | `news.md:170-172`·`editorShortcuts.js:63-69` |
| R4 | "(끝)" 자기 줄, 본문이 개행으로 끝나거나 비면 이중 개행 없이 | `news.md:171`·`editorNewline.js:14-20` |
| R5 | **"(끝)" 마커 뒤 모든 입력 차단(타이핑/Enter/붙여넣기/IME). 앞 줄 편집·삭제/이동/선택은 허용. 마커 삭제 시 입력 재개** | `news.md:173`·`editorNewline.js:22-29` |
| R6 | Alt+Y 시 맞춤법 on(spellcheck=true, lang=ko) — 그 전엔 off | `news.md:174`·`editorShortcuts.js:62` |
| R7 | Ctrl+D 라인 제거, Backspace/Delete/Ctrl+D 시 그 줄 임베드 1개 동반 삭제 | `news.md:175-176`·`editorShortcuts.js:71-87` |
| R8 | 본문은 블록 구조(markupVersion)로 저장, 레거시 평문도 로드 | `news.md:178`·`editorContent.js:60-81` |
| R9 | IME 조합 중 재색칠 금지 — 조합 완료/포커스 이탈/로드에만 재색칠 | `news.md:179`·`editorColoring.js:65-71` |

- **본문 저장/검색 실측**: 서버는 본문을 **검증하지 않는다**. 본문은 `Contents`/`Article`의 `markupVersion` 컬럼(블록 JSON 직렬화 문자열)에만 저장되고 평문 `content` 컬럼은 미사용(`SCHEMA.md:53`·`news-md-overrides.md:208`). 검색은 `markupVersion LIKE`(같은 208행). → **직렬화 바이트가 곧 저장 내용이자 검색 대상**이므로 아래 S군(직렬화) 바이트 패리티가 핵심 계약이다.

---

## 2. block-model — `editorContent.js` (96행) → `editor/blockmodel.{h,cpp}`

| 규칙 | 출처 |
|---|---|
| 블록 = `{type:'text',text[,align]}` 또는 `{type:'embed',...}`. text는 `String()` 강제 | `editorContent.js:18-34` |
| `align`은 화이트리스트 4종(left/center/right/justify)만, 무효/부재는 **키 자체 생략**(직렬화 바이트 안정) | `editorContent.js:10-22,43` |
| `normalizeBlocks`: 알 수 없는 타입 제거, 입력 배열/원소 **불변**(복사본) | `editorContent.js:37-48` |
| `serialize` = `{format:'yh-editor',version:1,blocks:[...]}` **JSON**(compact) | `editorContent.js:6-7,51-53` |
| `deserialize`: null/''/undefined→[], 배열/객체/문자열 분기, JSON 시도 후 **전량 드롭이면 평문 폴백**(원문 보존), 빈 문서(source.length===0)는 빈 배열, 부분 드롭은 정규화 결과 | `editorContent.js:60-81` |
| `blocksToText` = 텍스트 블록만 `'\n'` 조인(임베드 제외) — 색상/마커/좌표 기준 텍스트 | `editorContent.js:84-86` |
| `hasEndMarker(blocks)` = `blocksToText(...).includes('(끝)')` (**substring 기준**) | `editorContent.js:94-96` |

---

## 3. serializer / 마커 계약 — `writerBody.js`(85행) + `editorNewline` 마커부

| 규칙 | 출처 |
|---|---|
| `serializeBodyFromBlocks`: deserialize→정규화, **"(끝)"은 항상 최종 블록으로**(첫 마커의 align 승계), 임베드는 커서/DOM 순서 보존 | `writerBody.js:19-26` |
| `textLineToBlockIndex`: 텍스트 줄 인덱스→블록 인덱스, null/음수/범위밖 = -1 | `writerBody.js:31-40` |
| `insertEmbedAfterLine`/`appendEmbedToBody`: 마커 앞 삽입 + 마커 최종 정규화(P6가 실제 임베드 UI를 붙이나 순수 규칙은 P5가 보유) | `writerBody.js:46-85` |
| `appendEndMarker(text)`: 중복이면 그대로, 개행/빈문자면 개행 없이 | `editorNewline.js:15-20` |
| **`isInputBlocked(text, offset)`: `lastIndexOf('(끝)')` 이상이면 차단(substring 기준)** | `editorNewline.js:24-29` |
| **`isMarkerBlock(b)`: `String(b.text).trim() === '(끝)'`(trim 정확 비교)** | `editorNewline.js:82` |

- **⚠ 이중 기준 공존은 의도다(발산 아님 — 재파생 확인)**: `isInputBlocked`는 **substring**(`lastIndexOf`), 재정규화/직렬화(`isMarkerBlock`·`serializeBodyFromBlocks`)는 **trim 정확비교**. 이 둘을 섞으면 안 된다(`editorNewline.js:78-101` CRITICAL 주석): (a) substring으로 clamp하면 "(끝)"을 본문 중간에 **인용한** 기사의 정상 편집이 막히고, (b) trim 기준을 입력 차단에 쓰면 재정규화가 인식 못하는 줄이 보호되어 헛돈다. **두 기준을 그대로 이식한다.**

### S군 — 직렬화 바이트/키순서 패리티 (load-bearing)

- **JS `JSON.stringify`는 공백 0 + 키 삽입 순서**를 낸다. 봉투 키순서 = `format, version, blocks`(`editorContent.js:52`). 텍스트 블록 키순서 = `type, text[, align]`(`:19-21,42-43` — align은 있을 때 뒤에 추가). **임베드 블록 키순서 = 원본 키들… 그 다음 `type`**(`embedBlock`/`normalizeBlocks`의 `{...embed, type:'embed'}` — `:25,45`).
- **Qt 함정**: `QJsonObject`는 키를 **알파벳 정렬**한다 → `{"blocks":…,"format":…,"version":…}`가 되어 **바이트 패리티가 깨진다**. `QJsonDocument`로 직렬화하면 안 된다.
- **결정(ADR-019 후보 D1)**: 순서 보존 직렬화기를 손으로 구현한다. 봉투·텍스트 블록은 **알려진 키순서로 결정적 emit**(compact, `"`/`\` 이스케이프는 JSON 규격 = `JSON.stringify`와 동일: `"`,`\`,`\n`,`\r`,`\t`,`\b`,`\f`,`\u00xx` 제어문자). **임베드 블록은 파싱 시 원본 JSON 텍스트를 불투명 문자열로 보존해 verbatim 재출력**하고 P6에서 rich 편집을 붙일 때 순서 보존 모델로 승격한다(P5는 임베드를 **무손실 라운드트립**만 보장). 이 결정이 검색(LIKE)·저장 내용·웹↔Qt 혼재 기사 호환의 근거다.

---

## 4. edit-ops — `editorNewline.js`(range) + `editorEditOps.js`(sort/word)

| 규칙 | 출처 |
|---|---|
| `replaceRangeInBlocks(blocks, range, text)`: 순수. head+삽입줄+tail 병합, "1줄=1 텍스트블록" 유지 | `editorNewline.js:110-206` |
| 규칙 1-a: 한쪽만 있으면 collapsed, 역방향(start>end) swap | `:136-141` |
| 규칙 1-b: 캐럿 미상 폴백 = **마커 줄 직전**(마커 없으면 마지막 텍스트 줄 끝), 마커가 첫 줄이면 그 앞 새 줄 | `:143-174` |
| **규칙 3(마커 clamp)**: start가 마커 줄 이상이면 마커 직전으로 되돌림, end는 마커 줄 시작 이전으로 clamp — 전체선택/문단선택의 요소 앵커 제스처가 마커를 오염시키는 것을 순수 계층에서 차단 | `:176-190` |
| 규칙 4(임베드 보존): 삭제 범위 내 임베드는 삭제 안 되고 병합 결과 **뒤**에 원래 순서로 남음 | `:192-204` |
| 규칙 5(정렬 승계): 첫 줄=start align, 마지막 줄=end align, 중간=start align | `:106-109,195-201` |
| `insertTextIntoBlocks` = collapsed range 특수형(위임) | `:74-76` |
| `shouldOverwriteNextChar` / `overwriteExtendLength`: 수정(overwrite) 모드 캐럿 뒤 1글자 대체 판정 + 서로게이트 페어 확장(1/2) | `editorNewline.js:44-63` |
| `sortDocument`: 전체 텍스트 줄 `localeCompare` 안정 정렬, "(끝)"·임베드 제외, align은 텍스트 따라 이동, 마커 최종 재정규화, `{blocks,changed}` | `editorEditOps.js:40-58` |
| `sortParagraph`: 캐럿 문단(빈 줄 경계)만 정렬, 매핑 실패/단일 줄이면 no-op | `editorEditOps.js:67-94` |
| `deleteWordAt`: `wordBoundsAt`(\S 런) 삭제, 마커 줄/매핑 실패/단어 없음이면 no-op, align 승계, `caretColumn` 반환 | `editorEditOps.js:99-110` |

- **⚠ 발산 후보 D2 (localeCompare)**: `sortDocument`/`sortParagraph`가 `String.prototype.localeCompare`(`:50,81`)를 쓴다. 기본 로케일 정렬은 JS 엔진(ICU)에 의존한다. Qt는 `QString::localeAwareCompare`(OS 로케일) 또는 `QCollator`를 써야 하며 **정렬 순서가 미묘하게 다를 수 있다**. **결정**: `QCollator`(기본 로케일, numericMode off)로 이식하고, 웹 테스트 케이스의 기대 순서와 **불일치가 관측되면 그 케이스와 회피책을 실측 기록**한다(관측 없이 "같다"고 적지 않는다 — ADR-018 규율). 순수 정렬 결과의 완전 동일성은 P5 종료 조건이 아니라 **정렬 대상 선정·마커/임베드 제외·align 이동·changed 판정**이 종료 조건이다.

---

## 5. shortcuts (단축키) — `editorShortcuts.js`(150행) + `editorFind.js:14`

키 인식 predicate는 **레이아웃 무관**하게 `e.key`와 `e.code`를 함께 본다. Qt에선 `QKeyEvent`의 `key()`/`nativeScanCode` 대신 `key()` + modifiers로 매핑한다(한글 레이아웃에서도 KeyY/KeyD가 잡히도록 `Qt::Key` + text 병용).

| # | 단축키 | predicate | 액션 소유 | P5 결선? |
|---|---|---|---|---|
| 1 | Alt+Y "(끝)" 삽입 | `isInsertEndMarker` `:13-15` | `insertEndMarker` `:63-69` | **P5** |
| 2 | Ctrl+Y "(계속)" 삽입 | `isInsertContinueMarker` `:22-24` | `insertContinueMarker` `:92-114` | **P5** |
| 3 | Ctrl+D 라인 삭제 | `isDeleteLine` `:17-19` | `deleteLineAt` `:72-87` | **P5** |
| 4 | Backspace 빈줄 삭제/병합 | `WriterPage.jsx:1318-1333` | `deleteLineAt` | **P5**(+발산 D3) |
| 5 | Delete 빈줄 삭제 | 동상 | `deleteLineAt` | **P5** |
| 6 | Enter 개행 | `Editor.jsx:329-332,541` | `insertTextIntoBlocks('\n')` | **P5** |
| 7 | Insert 수정모드 토글 | `isToggleOverwrite` `:34-37` | overwrite state | **P5** |
| 8 | Ctrl+Z undo | `isUndo` `:40-43` | `editorHistory.undo` | **P5** |
| 9 | Ctrl+Shift+Z redo | `isRedo` `:46-49` | `editorHistory.redo` | **P5** |
| 10 | Alt+O 약물입력 | `isGlyphInput` `:52-54` | 다이얼로그 | predicate만(액션 **P6**) |
| 11 | Alt+V 원본 붙여넣기 | `isPasteOriginal` `:57-59` | 클립보드 이미지 | predicate만(액션 **P6**) |
| 12 | Ctrl+B 기업코드 변환 | `isCompanyCode` `:28-30` | 변환기 | predicate만(액션 **P6**) |
| 13 | Ctrl+F 찾기바꾸기 | `isFindReplace` `editorFind.js:14` | 다이얼로그 | predicate만(액션 **P6**) |

- **"13종"의 재파생**: 위 표가 P5 결선 대상 키 인식 13종이다. predicate(순수 판정 함수)는 13종 전부 이식·테스트하지만, **10~13의 액션은 P6 소유**다 — P5는 predicate를 인식해 `preventDefault` 상당 + no-op 스텁(forward note)으로 두고, P6가 다이얼로그/변환기를 붙인다. 이렇게 해야 키 충돌 규율(예: `isFindReplace`는 `!altKey`라 Alt+Y와 안 부딪힘 — `WriterPage.jsx:1251-1252`)을 P5에서 잠글 수 있다.
- 대소문자 변환 4종(`toUpper/toLower/capitalizeFirst/toggleCase` `:129-150`)과 `transformTextLine` `:119-126`은 보기 메뉴(P6) 소속이나 **순수 함수라 P5에서 함께 이식**한다(테스트 전환이 싸고, P6가 결선만 한다).

---

## 6. engine / IME / caret — `Editor.jsx`(740행) + `editorCaret.js` + P0 스파이크

- **위젯 축 = QPlainTextEdit + QSyntaxHighlighter**(P0 스파이크 `editorwidget.h:9`·`editorlogic.h`가 실증). contentEditable 방어 코드(`Editor.jsx:6-11`의 snapshot 고정·renderTick remount)는 **네이티브에서 구조적으로 불필요**(ADR-018 — Qt는 preedit를 문서에 넣지 않는다). → **이식 대상 아님**.
- **IME**: `inputMethodEvent`로 조합 처리, 조합 중 `m_composing=true`(스파이크 `editorwidget.h:21,35`). 조합 중 재색칠 금지(`shouldRecolor` composing 게이트 `editorColoring.js:68`). preedit는 `QInputMethodEvent`의 preedit 영역에만(문서 미삽입). 마커 차단 구간에선 플랫폼 IME off(`inputMethodQuery(ImEnabled)` — 스파이크 `editorwidget.h:24-25,33`).
- **caret**: 순수 계산은 `editorCaret.js`(`lines`/`lineAtOffset`/`removeLineFromText` `:4-38`). 프로그램적 캐럿 복원 = `focusLineStart(lineIndex)`(스파이크 `editorwidget.h:16-17`, 웹 `Editor.jsx:336-349`). Qt는 `QTextCursor`로 구현.
- **삽입성 키 판정**: 문자 입력+Enter만 삽입성, 삭제/이동/선택 키는 제외(`Editor.jsx:328-332`). 마커 뒤면 `caretBlocked`로 `preventDefault`(`:305-309,541-544`).
- **색상 트리거**: 재색칠은 compositionend/blur/load에만(`editorColoring.js:66`) → Qt: commit(조합완료)/focusOut/load. `recolorNow()`가 조합 중이면 no-op(스파이크 `editorwidget.h:18-19`).

- **⚠ 발산 D3 (마커 병합 가드)**: 웹은 비어있지 않은 줄의 문자 삭제(Backspace/Delete)를 **브라우저 네이티브**에 맡긴다(`WriterPage.jsx:1327-1328`은 빈 줄에만 개입). 그래서 "(끝)" 줄 시작에서 Backspace로 앞 줄과 **병합**하면(브라우저가 처리) `prev(끝)`가 되어 trim 기준 마커 인식이 깨지고, 송고 가드 `hasEndMarker`는 substring이라 **오염 본문이 그대로 송고·배부**된다(비가역 — `editorNewline.js:92-94`가 삽입 경로에 대해선 같은 위험을 기술). Qt는 삭제를 **앱이 전부 제어**하므로, **마커 줄로의 병합을 명시적으로 금지**한다: (a) "(끝)" 줄 시작에서 Backspace = no-op, (b) "(끝)" 바로 앞 줄 끝에서 Delete = no-op. 이는 웹 대비 **의도된 발산**이며(웹은 무가드로 브라우저에 위임), 근거는 마커 오염의 비가역성이다. step11 위젯에서 결선하고 테스트로 잠근다.

---

## 7. writer-state — undo · autosave (스냅샷 스택 · 초안)

### undo/redo — `editorHistory.js`(58행) → `editor/history.{h,cpp}`

| 규칙 | 출처 |
|---|---|
| shape `{entries:string[], index:number}`, `entries[index]`=현재, `entries[0]`=베이스라인(코얼레싱으로 교체 안 됨) | `:7-12` |
| `pushHistory`: 동일 body no-op(동일 참조), coalesce&최상단&비베이스라인이면 top 교체, 아니면 redo 분기 절단 후 push, limit 초과분 절단+index 보정 | `:17-36` |
| body는 **불투명 문자열** — deserialize/JSON.parse로 재정규화 **금지**(동일-body 판정이 어긋남) | `:4-5` |
| `undo`/`redo`/`canUndo`/`canRedo` | `:39-58` |
| 코얼레싱 시각 판정·탭→히스토리 매핑은 상위(웹 WriterPage, Qt 에디터 컨트롤러) | `:2-3` |

### autosave — `editorDraft.js`(118행) → `editor/draftstore.{h,cpp}`

| 규칙 | 출처 |
|---|---|
| `saveDraft/loadDraft/clearDraft`: key별 `{data, savedAt(ms)}`, 시각은 **인자(nowMs) 주입**(모듈 내부 `Date.now()` 금지 — 순수·결정성) | `:26-46,3` |
| `draftKeyFor(articleId, tabId)`: 기존 기사=articleId, 신규=`<scope>:<tabId>` | `:83-86` |
| `loadDraftForRecover`: 새 키 우선, 없으면 옛 키(tabId) 폴백(기존 기사엔 폴백 없음) | `:96-103` |
| `expireDrafts(retentionDays, nowMs)`: cutoff 이전 항목 제거 | `:106-118` |
| graceful 저장소 접근(불가/throw 시 기본/no-op) | `:9-24` |

- **⚠ 발산 D4 (초안 저장 백엔드)**: 웹은 `localStorage`(key별 초안) + `sessionStorage`(탭 스코프 id — 창 간 초안 충돌 방지 `:48-79`)를 쓴다. Qt엔 둘 다 없다. **결정**: 초안 저장을 **주입형 백엔드**(`DraftStorage` 인터페이스) 뒤에 두고, 프로덕션은 Qt userData 폴더(`%APPDATA%\기사작성기-qt\drafts.json`, ADR-018의 폴더 분리 승계)에 **tmp→rename 원자적 쓰기**(`configStore` 패턴 재사용)로, 테스트는 **인메모리 fake**로 주입한다. 스코프 id: Qt는 **단일 인스턴스**(named mutex, ADR-018)라 창 간 localStorage 공유 문제가 없다 → **스코프 접두사는 불필요**할 가능성이 크나, 한 프로세스가 같은 문서를 여러 편집 표면으로 여는 경우가 있으므로 **키를 articleId/탭id로 유지**한다(→ 열린 질문 OQ-3). `savedAt`은 계속 주입.
- **⚠ 발산 D5 (자동저장 타이머)**: 자동저장 주기 QTimer는 **클라이언트 UI 타이머**이지 ADR-008이 금지하는 "앱 내 주기 실행"이 **아니다**(그 축은 **서버**의 배부 자동 송출/egress — ADR-018 ④(b)가 SSE 재연결 타이머에 대해 같은 구분을 명문화). 단 phase 77 ④ 테스터가 `TimerPolicyTest`(소스 스캔)로 `setInterval`/반복 `startTimer`/`setSingleShot(false)`를 red로 막았다(`README.md:1189-1195`). → **자동저장은 반드시 `setSingleShot(true)` + 편집마다 재arm**하는 debounce 형태로 구현해 그 게이트를 통과시킨다(반복 타이머 금지).

---

## 8. "7 decisions" 재파생 (Slack 내러티브를 가설로만 취급 — 각 항 재검증)

이전 Slack 서사의 결정들을 **가설**로 두고 실소스에서 재파생한 판정:

1. **오프셋은 UTF-16 코드유닛** → **참(소스 대조).** §0. Qt QString과 자연 패리티.
2. **직렬화는 JSON 키순서/바이트 패리티가 계약** → **참, 그리고 QJsonObject 금지.** §3-S군. 순서 보존 직렬화기 필수(D1).
3. **"(끝)" 마커 substring/trim 이중 기준 공존은 의도** → **참(재파생).** §3. 섞지 마라.
4. **마커 뒤 입력 차단은 삽입에만, 삭제/이동/선택은 허용** → **참.** R5. 단 삭제 **병합**의 마커 오염은 웹 무가드 → Qt는 D3 가드로 발산.
5. **IME 조합 중 무개입·재색칠 금지** → **참, 그리고 Qt에서 방어 코드 불필요.** §6. preedit 문서 미삽입(ADR-018 실증).
6. **undo body는 불투명 문자열, 재정규화 금지** → **참.** §7. 동일-body 판정 근거.
7. **위젯은 QPlainTextEdit + QSyntaxHighlighter(위젯 갈래 고정)** → **참(P0 스파이크 실증).** ADR-018 ①. QML 금지.

추가로 재파생한 발산: **D2 localeCompare(QCollator 근사)**, **D4 초안 저장 백엔드(파일+주입)**, **D5 자동저장 debounce(반복 타이머 금지)**.

---

## 9. 웹 테스트 이식 지도 (명세 겸 회귀 스위트)

| 웹 테스트 | 행 | 이식 등급 | 대상 step |
|---|---|---|---|
| `editorContent.test.js` | 165 | **1:1** 테이블 전환 | step1 |
| `writerBody.test.js` | 184 | **1:1**(임베드 라운드트립 verbatim 포함) | step2 |
| `editorNewline.test.js`(마커부) | ~부분 | **1:1** | step2 |
| `editorNewline.test.js`(range/overwrite부) | 553 중 | **1:1** | step3 |
| `editorCaret.test.js` | 36 | **1:1** | step4 |
| `editorRange.test.js` | 86 | **1:1** | step4 |
| `editorEditOps.test.js` | 329 | **1:1**(localeCompare 순서는 QCollator 관측 후 확정) | step5 |
| `editorEncoding.test.js` | 88 | **1:1** | step5 |
| `editorShortcuts.test.js` | 247 | **1:1**(predicate) + 액션 P5분 | step6 |
| `editorColoring.test.js` | 86 | **1:1** | step7 |
| `editorHistory.test.js` | 197 | **1:1** | step8 |
| `editorDraft.test.js` | 190 | **hand-port**(주입 저장소로 재배선, 스코프 로직 제외) | step9 |
| `Editor.test.jsx` | (jsdom) | **드롭 → 재작성** | step10·11 위젯 QtTest + 육안 체크리스트 |
| `EditorToolBar/MenuBar/ContextMenu/GlyphBar/PrefsDialog.test.jsx` | — | **P6/P7 소관**(이식 안 함) | — |

- **1:1**: 입출력 테이블을 QtTest data-driven(`_data()`)으로 그대로 옮긴다.
- **hand-port**: 브라우저 저장소 의존을 주입 이음매로 바꾸므로 테스트 배선이 달라진다(단언 내용은 보존).
- **드롭**: contentEditable/jsdom DOM 워킹 테스트는 Qt에 대응물이 없다 — 위젯 QtTest(프로그램적 입력)와 **육안 체크리스트**로 대체(P5 완료 게이트: 순수 모듈=green, IME·캐럿=실기 체크리스트, `porting-plan-cpp-spring.md:182`).

---

## 10. 아키텍처 제약 (전 step 공통)

- **ADR-018 모듈 경계**: 순수 로직은 `client-qt/src/editor/`(위젯·QtGui 비의존, `QString`/`QColor`만 — 스파이크 `editorlogic.h:1-2` 구조 승계). 위젯은 `src/editor/`의 위젯 파일(`editorwidget.*`)이 소유하고 **컨트롤러는 위젯 타입을 모른다**(`README.md:1174`).
- **모듈 등록 2곳**: `common.pri`의 `CLIENT_SOURCES`/`CLIENT_HEADERS`(프로덕션) + `tests/main.cpp`의 `runTestClass<…>()`(`README.md:1176`).
- **테스트 더블은 `tests/tests.pro`에만**(`common.pri` 금지 — phase 77 F1, `README.md:1212-1213`). 프로덕션 exe에 링크되면 `rule7` red.
- **편집 표면 clientId**: `src/net/editclientid.h`의 `EditClientId`(복사·이동 금지)의 **수명을 에디터 표면 생성/소멸에 붙인다**(프로세스당·세션당·창당 아님 — ADR-018 ③, `README.md:1177-1179`). `lockerSessionId`/`lockerClientId`를 읽는 코드 금지(어떤 응답에도 없음).
- **DB 비파괴**: 어떤 step도 DB 행 삭제를 지시하지 않는다(CLAUDE.md·ADR). 에디터는 본문을 `markupVersion`으로 보낼 뿐이고 잠금 해제도 best-effort. 초안 저장은 **클라 로컬 파일**이지 서버 DB가 아니다.
- **빌드/검증**: `client-qt/build.bat`(qmake+nmake, env는 `env.bat` 정본) → QtTest 러너. stdout 리다이렉트 시 QtTest PASS/FAIL이 사라지는 함정과 파일 로거 우회는 `tests/main.cpp`에 이미 있음(`README.md`/ADR-018 트레이드오프 ②) — **걷어내지 마라.**
