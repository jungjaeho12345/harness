# Step 4: marker-align

## 목표

**"(끝)" 마커를 재생성하는 3곳에서 그 줄의 정렬(align)이 조용히 사라지는 결함**을 수정한다.

세 함수 모두 "마커를 항상 최종 블록으로" 정규화하려고 기존 마커 블록을 **버리고 새로 만든다** — 이때 `textBlock(END_MARKER)`(single-arg)라 `align` 필드가 유실된다.

| 파일 | 함수 | 지점 | 언제 도는가 |
|---|---|---|---|
| `web/src/view/writerBody.js` | `serializeBodyFromBlocks` | L23 | **본문 타이핑 커밋마다**(`WriterPage.onTextChange`) |
| `web/src/view/writerBody.js` | `insertEmbedAfterLine` | L60 | 임베드(이미지/영상/표…) 삽입 |
| `web/src/view/editorShortcuts.js` | `insertContinueMarker` | L103 | Ctrl+Y "(계속)" 삽입 |

수정은 phase 49 step4가 `editorEditOps.sortDocument`에서 확정한 규칙과 **동형**이다 — 재생성 전에 **문서 순서상 첫 마커**의 align을 잡아 `textBlock(END_MARKER, prevMarker.align)`으로 승계한다.

> **선행**: web 패스의 세 번째 step. 시작 기준선은 `npm run test:web` 실패 0, `npm test` 실패 0. step2·step3와 파일 중복 없음.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/news.md` — "(끝)" 마커 규칙(마커 뒤 입력 차단·최종 블록 유지)과 보기>정렬 4종.
- `docs/ADR.md` — ADR-003(프론트 MVC: View 순수 함수).
- `web/src/view/editorContent.js` — **L18~22 `textBlock(text = '', align)`**: `isValidAlign(align)`이면 `block.align = align`, 아니면 **키 자체를 생략**한다. `normalizeBlocks`(L37~48)도 유효 align만 보존한다. **이 계약이 승계의 안전판**이다 — 원래 align이 없으면 `undefined`가 넘어가 키가 생기지 않는다(직렬화 바이트 안정).
- `web/src/view/writerBody.js` — 파일 전체(83줄).
  - **L18~25 `serializeBodyFromBlocks(blocks)`**: `isEnd` 판정(`type==='text' && String(text).trim()===END_MARKER`) → `hasEnd` → `rest = list.filter(!isEnd)` → **L23 `rest.push(textBlock(END_MARKER));`** ← 수정 대상 1.
  - **L45~70 `insertEmbedAfterLine(currentBody, embed, textLineIndex)`**: L56~60 동일 정규화 → **L60 `ordered.push(textBlock(END_MARKER));`** ← 수정 대상 2. L61~68의 `caretTextLine` 계산은 `b === emptyLine` **참조 비교**다(불변).
  - **L49 `const emptyLine = textBlock('');`** — 새로 만드는 빈 줄이라 single-arg가 정상(수정 금지).
- `web/src/view/editorShortcuts.js`
  - **L92~113 `insertContinueMarker(blocks, textLineIndex)`**: L95 새 "(계속)" 블록 생성(single-arg 정상), L100~103 마커 정규화 → **L103 `ordered.push(textBlock(END_MARKER));`** ← 수정 대상 3. L104~111 `caretTextLine`은 `b === marker` 참조 비교(불변).
  - **L63~69 `insertEndMarker(blocks)`** — 마커가 없을 때만 새로 추가하므로 승계할 원본이 없다(**수정 금지**).
- 참고(선례, 수정 금지): `web/src/view/editorEditOps.js` **L50~53**
  ```js
  const prevMarker = next.find(isEndMarkerBlock);
  const ordered = next.filter((b) => !isEndMarkerBlock(b));
  if (prevMarker) ordered.push(textBlock(END_MARKER, prevMarker.align));
  ```
  — 같은 모양으로 맞춰라.
- `web/src/view/writerBody.test.js`, `web/src/view/editorShortcuts.test.js` — 기존 테스트 스타일(입력 blocks → 출력 blocks/직렬화 문자열 단언).
- 참고(읽기만): `web/src/view/Editor.jsx` **L92~97** — DOM `data-align`을 되읽어 블록에 되살린다. `web/src/view/editorAlign.js` **L20~29 `setLineAlign`** — 캐럿 줄 하나에 align을 설정한다(마커 줄 제외 가드는 **없다**).

## 배경 (자기완결) — 왜 결함인가

정렬은 텍스트 블록의 선택적 필드(`{type:'text', text, align?}`)이고, 보기>정렬 메뉴는 **캐럿이 놓인 텍스트 줄**에 그대로 적용된다(`WriterPage` L1038~1047 → `setLineAlign`). 캐럿이 "(끝)" 줄에 있으면 마커 블록에도 align이 붙는다. 그 커밋 경로는 `commitBody(serialize(...))`라 align이 살아서 저장되고, `Editor`는 `data-align`으로 렌더한 뒤 DOM에서 되읽는다.

문제는 그 다음이다. 사용자가 **아무 줄이나 타이핑**하면 `onTextChange` → `serializeBodyFromBlocks`가 돌면서 마커가 재생성되고 align이 사라진다 → `alignSig` 변화로 remount → **"(끝)" 줄 정렬이 저절로 풀린다.** 임베드 삽입(`insertEmbedAfterLine`)과 Ctrl+Y(`insertContinueMarker`)도 같다.

phase 49 step4는 정렬 op(`sortDocument`)의 마커 재정규화에서 이미 "align 승계"를 **확정 결정**으로 채택했다. 그 결정이 이 3곳에서 매 커밋마다 되돌려지고 있으므로, 일관성 관점에서도 승계가 맞다. (반대 방향 — `setLineAlign`에 마커 가드를 넣어 애초에 정렬을 막는 안 — 은 스펙 변경이라 이번 phase에서 기각됐다. `index.json`의 `excluded` 참조.)

## TDD — 테스트 먼저

세 함수 각각에 대해 red→green으로 추가한다. `textBlock`·`END_MARKER`를 import해 정렬된 마커 블록을 만든다.

`writerBody.test.js` — `serializeBodyFromBlocks`:
- 정렬된 마커 승계: `[textBlock('본문'), textBlock('(끝)', 'center')]` → 직렬화 결과를 `deserialize`했을 때 마지막 블록이 `(끝)`이고 `align === 'center'`.
- 스퍼리어스 금지: 마커에 align이 없으면 결과 마커 블록에 `'align' in block === false`.
- 다중 마커 방어: 마커가 두 개(첫 번째만 `'right'`)면 결과는 마커 1개이고 align은 **첫 마커**의 값.
- 회귀: 마커가 없으면 마커를 만들지 않는다 / 마커는 항상 최종 블록 / 임베드 순서 보존 / 앞뒤 공백 마커(`' (끝) '`)도 정규 `(끝)` 텍스트로 되쓴다(기존 동작).

`writerBody.test.js` — `insertEmbedAfterLine`:
- 정렬된 마커가 있는 본문에 임베드를 삽입해도 마커 align이 유지된다.
- 반환 `caretTextLine`(새 빈 줄의 텍스트-줄 인덱스)이 기존과 동일하다(회귀).

`editorShortcuts.test.js` — `insertContinueMarker`:
- 정렬된 마커가 있는 블록에 "(계속)"을 삽입해도 마커 align이 유지된다.
- 삽입된 "(계속)" 줄에는 align 키가 없다(새 줄은 미정렬이 정상).
- 반환 `caretTextLine`이 기존과 동일하다(회귀).

`insertEndMarker`(Alt+Y)에는 **테스트를 추가하지 않는다** — 이 step의 대상이 아니다.

## 작업

세 곳 모두 동일 패턴이다. **필터 전에** 첫 마커를 잡아둔 뒤 승계한다.

1. `web/src/view/writerBody.js` `serializeBodyFromBlocks`:
   ```js
   const prevMarker = list.find(isEnd);
   const rest = list.filter((b) => !isEnd(b));
   if (prevMarker) rest.push(textBlock(END_MARKER, prevMarker.align));
   ```
   기존 `hasEnd` 불리언은 `prevMarker` 존재 판정으로 대체하거나 유지하되, **판정 기준(어떤 블록이 마커인가)은 바꾸지 마라**.
2. `web/src/view/writerBody.js` `insertEmbedAfterLine`(L56~60): 같은 방식. 승계 소스는 `next`(임베드·빈 줄이 이미 들어간 배열)에서 찾은 첫 마커다.
3. `web/src/view/editorShortcuts.js` `insertContinueMarker`(L100~103): 같은 방식. 승계 소스는 `next`의 첫 마커.

각 함수 주석에 "마커 재생성 시 정렬(align)은 승계한다" 한 줄만 정확히 반영하라(주석 재작성 금지).

불변 사항: 시그니처, 반환 shape(`string` / `{ body, caretTextLine }` / `{ blocks, caretTextLine }`), 마커 텍스트를 정규 `END_MARKER`로 되쓰는 동작, 다중 마커를 1개로 병합하는 동작, 임베드 순서·`caretTextLine` 참조 비교 계산.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web    # 실패 0 — 기준선(2006 + step2·3 신규)에 이번 신규 케이스만큼 증가
npm test            # 백엔드 무접촉 — 실패 0(개수는 step0·1 종료 시점과 동일)
```

`git diff --name-only`는 `web/src/view/writerBody.js`, `web/src/view/editorShortcuts.js`, `web/src/view/writerBody.test.js`, `web/src/view/editorShortcuts.test.js` **4개뿐**이어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `WriterPage.test.jsx`·`Editor.test.jsx`의 기존 본문/임베드/마커 테스트가 **무수정 green**인지 확인한다(미정렬 본문의 직렬화 바이트가 그대로라는 증거).
2. 변이 검증: 세 곳 중 하나에서 2번째 인자를 지우면 대응 테스트가 red가 되는지 확인한다.
3. 전수 확인: `git grep -n "textBlock(END_MARKER" -- web/src`로 남은 single-arg 재생성이 없는지 훑는다. `editorShortcuts.js`의 `insertEndMarker`(신규 마커 생성)만 single-arg로 남아야 한다. 그 밖에 발견되면 **고치지 말고** step 요약에 보고하라(범위 밖 확장 금지).
4. 아키텍처 체크리스트:
   - View의 순수 헬퍼만 수정했는가(DOM/React/transport 미도입)?
   - `editorContent.js`(`textBlock`/`isValidAlign`/`normalizeBlocks`)를 수정하지 않았는가?
   - 미정렬 블록에 `align` 키가 새로 생기지 않는가(직렬화 바이트 안정)?
5. `phases/50-hygiene-cleanup/index.json`의 step4를 `completed` + `summary`로 갱신한다. 승계 소스가 "문서 순서상 첫 마커"임을 summary에 명시하라.

## 금지사항

- `editorShortcuts.insertEndMarker`(L68)·`writerBody`의 `textBlock('')`(L49)·`insertContinueMarker`의 새 "(계속)" 블록(L95)을 건드리지 마라. 이유: 이들은 **새로 만드는 줄**이라 승계할 원본이 없다 — 임의 align을 주면 없던 정렬이 생긴다.
- `editorAlign.setLineAlign`에 "(끝)" 줄 가드를 추가하지 마라. 이유: 마커 정렬 자체를 금지하는 것은 위생이 아니라 스펙 변경이며, phase 49 step4가 채택한 승계 규칙과 충돌한다(이번 phase에서 기각 — `index.json` excluded).
- `editorEditOps.js`·`editorContent.js`를 수정하지 마라. 이유: 선례 코드와 블록 계약은 이미 옳다 — 이 step은 소비 측 3곳만 맞춘다.
- 미정렬 마커에 기본 align(`'left'` 등)을 채우지 마라. 이유: `{type,text}`만 있던 블록에 키가 생기면 직렬화 바이트가 바뀌어 저장·이력 비교·기존 회귀 테스트가 흔들린다.
- 마커 판정 기준(`String(text).trim() === END_MARKER`)이나 "마커는 항상 최종 블록" 정규화를 바꾸지 마라. 이유: 송고 자격 판정("(끝)" 유무)의 근거이며 백엔드 `hasEndMarker`와 같은 기준이다.
- `WriterPage.jsx`·`Editor.jsx`를 수정하지 마라. 이유: 호출부는 반환 shape만 소비한다 — 바꿀 것이 없다.
- `.claude/skills/claude-code-review-harness/SKILL.md`를 읽거나 수정하거나 커밋에 포함하지 마라. 이유: 사용자가 편집 중인 파일이다.
