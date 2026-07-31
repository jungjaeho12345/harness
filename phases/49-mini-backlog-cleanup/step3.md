# Step 3: transform-align

## 목표

**전체-본문 텍스트 변환이 줄의 정렬(align)을 유실하는 결함**을 수정한다. 순수 헬퍼들이 변환된 줄을 `textBlock(next)`(single-arg)로 재생성하면서 기존 블록의 선택적 `align` 필드를 떨어뜨린다. 결과: **가운데/오른쪽 정렬한 줄에 기업코드 변환·약어 변환·간체↔번체 변환·찾아바꾸기를 하면 그 줄의 정렬이 조용히 풀린다.**

수정은 phase 45 step0(`editop-align-inherit`)와 **동형**이다 — 재생성 시 원래 블록의 align을 `textBlock(text, align)` 2번째 인자로 승계한다.

대상은 **4개 파일 5곳**이다(전수 grep 확인 결과 — 원 백로그 후보의 3곳에 `editorFind` 2곳을 더한다. 완전 동형 결함을 같은 계층에 남기면 즉시 재백로그화된다):

| 파일 | 함수 | 지점 | align 소스 |
|---|---|---|---|
| `companyCodeConvert.js` | `convertCompanyCodeInBlocks` | L64 | `block.align`(map 인자) |
| `abbrevConvert.js` | `expandAbbrevInBlocks` | L66 | `block.align` |
| `simpTradConvert.js` | `convertSimpTradInBlocks` | L49 | `block.align` |
| `editorFind.js` | `replaceAtMatch`(replaceOne 경유) | L68 | `list[blockIndex].align` |
| `editorFind.js` | `replaceAll` | L120 | `b.align`(map 인자) |

이 step은 **web/src/view의 순수 헬퍼만** 다룬다 — DOM/컨트롤러/모델/서버/DB 무접촉. 네 파일 모두 같은 계층·같은 구조(제자리 재생성 + 마커 가드 + 임베드 통과)·같은 "2번째 인자 추가"라 하나의 관심사(align 보존)로 묶는다.

> **실행 패스**: 여기서 **web 패스(step3~8)** 가 시작된다. 앞선 backend 패스(step0~2)가 완료돼 `npm test`가 620/620 green인 상태를 전제로 하며, web 패스의 모든 step은 그 기준선 유지를 AC로 검증한다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`(프론트 MVC: view는 순수 함수/컴포넌트), `docs/ADR.md`(ADR-003), `docs/news.md`의 "보기 > 정렬"(텍스트 줄 단위 align).
- `web/src/view/editorContent.js` — **`textBlock(text = '', align)`(L18~22)**: `isValidAlign(align)`이면 `block.align = align`, 아니면 **키 자체를 생략**한다. `normalizeBlocks`(L37~)는 유효 align만 보존한다. **이 계약이 승계의 안전판이다** — 원래 align이 없던 줄은 `undefined`가 넘어가 키가 생기지 않는다(직렬화 바이트 안정).
- `web/src/view/companyCodeConvert.js` — **`convertCompanyCodeInBlocks(blocks)`(L56~67)**. L64 `return textBlock(next);` ← **수정 대상 1**.
- `web/src/view/abbrevConvert.js` — **`expandAbbrevInBlocks(blocks, pairs)`(L58~69)**. L66 `return textBlock(next);` ← **수정 대상 2**.
- `web/src/view/simpTradConvert.js` — **`convertSimpTradInBlocks(blocks, direction)`(L41~52)**. L49 `return textBlock(next);` ← **수정 대상 3**.
- `web/src/view/editorFind.js` — 두 곳:
  - **`replaceAtMatch(list, text, match, replacement)`(L57~70)** — `replaceOne`(L77~97)이 쓰는 내부 헬퍼. L60 매핑 실패 no-op, L62 "(끝)" 마커 no-op 가드가 이미 있고, L68 `next[blockIndex] = textBlock(newText);` ← **수정 대상 4**(align 소스는 `list[blockIndex].align`).
  - **`replaceAll(blocks, query, replacement, opts)`(L101~123)** — L107 임베드 통과, L109 마커 가드, L111 매치 0개면 원본 블록 반환. L120 `return textBlock(out);` ← **수정 대상 5**(align 소스는 map 인자 `b.align`).
  - `findMatches`/`nextMatchIndex`/`replaceOne`의 반환 shape(`{ blocks, replaced, matchStart, caretOffset }`·`{ blocks, count }`)과 캐럿 오프셋 계산은 **불변**이다.
- `web/src/view/companyCodeConvert.test.js`, `abbrevConvert.test.js`, `simpTradConvert.test.js`, `editorFind.test.js` — 기존 테스트 스타일(입력 blocks → 출력 blocks 단언)을 그대로 따른다.
- 참고(수정 금지): `web/src/view/editorShortcuts.js`의 `transformTextLine`(L117~124)이 phase 45에서 이미 승계로 고쳐진 **선례 코드**다 — 같은 모양으로 맞춰라.

## 배경 (자기완결)

`align`은 텍스트 블록의 선택적 필드다(`{type:'text', text, align?}`). 변환 3종은 구조가 동일하다:

```js
const out = list.map((block) => {
  if (!isTextBlock(block) || String(block.text).trim() === END_MARKER) return block; // 임베드·"(끝)"은 불변
  const next = <변환>(block.text, ...);
  if (next === block.text) return block;      // 변화 없음 → 원본 그대로(align 보존됨)
  changed = true;
  return textBlock(next);                     // ← 여기서 align이 사라진다
});
```

즉 **변환이 실제로 일어난 줄에서만** align이 사라진다. 값이 그대로인 줄은 원본 블록을 반환하므로 align이 남는다 — 그래서 "일부 줄만 정렬이 풀리는" 형태로 나타난다.

이 세 함수는 `map`으로 도는 `block`이 곧 원본이므로, 승계 소스는 **`block.align`**이다(별도 인덱스 조회 불필요).

`editorFind`의 두 곳도 같은 결함이다. `replaceAll`은 위와 완전히 같은 `map` 구조이고(승계 소스 `b.align`), `replaceAtMatch`는 캐럿이 있는 한 줄만 인덱스로 찾아 제자리 교체하므로 승계 소스가 **`list[blockIndex].align`**이다(phase 45가 고친 `deleteWordAt`·`transformTextLine`와 같은 모양). 증상은 "본문에서 찾아바꾸기를 하면 바뀐 줄의 정렬만 풀린다"이며, `replaceAll`은 문서 전체에서 동시에 발생한다.

## TDD — 테스트 먼저

각 대응 테스트 파일에 red→green으로 추가한다. `textBlock`을 import해 정렬된 입력 블록을 만든다.

`companyCodeConvert.test.js`:
- 정렬된 줄이 변환되면 align 유지: `convertCompanyCodeInBlocks([textBlock('삼성전자 주가', 'center')])` → `blocks[0].text`에 코드가 붙고 **`align === 'center'`**, `changed === true`.
- 미정렬 줄 변환 결과에는 `'align' in blocks[0] === false`(스퍼리어스 align 금지).
- 임베드·"(끝)" 블록은 참조 그대로(기존 계약 회귀 가드).

`abbrevConvert.test.js`:
- 정렬된 줄의 약어 확장 후 `align === 'right'` 유지.
- 미정렬 줄 결과에 align 키 없음.

`simpTradConvert.test.js`:
- 정렬된 줄의 간체→번체 변환 후 `align === 'justify'` 유지.
- 미정렬 줄 결과에 align 키 없음.

`editorFind.test.js`:
- `replaceOne([textBlock('hello world','center')], 'world', 'earth')` → 결과 블록 텍스트가 바뀌고 **`align === 'center'` 유지**, `replaced === true`, `caretOffset`은 기존 계산 그대로.
- `replaceAll([textBlock('a a','right'), textBlock('a')], 'a', 'b')` → 첫 블록 `align === 'right'` 유지, 둘째 블록엔 align 키 없음, `count`는 기존과 동일.
- 마커 가드 회귀: `[textBlock('(끝)','center')]`는 `replaceOne`/`replaceAll` 어느 쪽에서도 치환되지 않고 **블록이 참조 그대로**(마커 무결성 + align 무손실).
- 임베드 통과 회귀: 임베드 블록은 참조 동일.

네 파일 공통으로 **"변환이 일어나지 않은 정렬 줄은 원본 블록 참조 그대로"**(기존 동작)도 확인한다.

## 작업

다섯 곳 모두 동일 패턴 — 재생성 호출에 그 블록의 align을 넘긴다.

1. `web/src/view/companyCodeConvert.js` `convertCompanyCodeInBlocks`: `return textBlock(next, block.align);`
2. `web/src/view/abbrevConvert.js` `expandAbbrevInBlocks`: `return textBlock(next, block.align);`
3. `web/src/view/simpTradConvert.js` `convertSimpTradInBlocks`: `return textBlock(next, block.align);`
4. `web/src/view/editorFind.js` `replaceAtMatch`: `next[blockIndex] = textBlock(newText, list[blockIndex].align);`
   — align 소스는 반드시 **교체 전 원본**(`list[blockIndex]`)이다. `next[blockIndex]`를 덮어쓴 뒤 읽으면 승계가 무효가 된다.
5. `web/src/view/editorFind.js` `replaceAll`: `return textBlock(out, b.align);`

각 함수 주석에 "정렬(align) 필드는 승계한다" 한 줄만 정확히 반영하라(주석 재작성 금지). 시그니처·반환 shape(`{ blocks, changed }` / `{ blocks, replaced, matchStart, caretOffset }` / `{ blocks, count }`)·`changed`/`count` 판정 기준·마커 no-op 가드·임베드 불변 규칙은 **전부 그대로**다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web        # 87 files / 1944 + 신규 테스트 수, 실패 0 (기준선 1944 pass)
npm test                # 620/620 green — 백엔드 무접촉 증명(step0 이후 기준선)
```

`git diff --name-only`에 `src/`·`server/`·`test/`가 없어야 한다(웹 파일만).

## 검증 절차

1. 위 AC 커맨드를 실행한다. `npm run test:web`은 **87 파일 전부 pass**, 총 개수는 1944 + 이번에 추가한 케이스 수여야 한다(기존 실패 0). `npm test`는 620/620.
2. 전수 확인: `grep -rn "textBlock(" web/src/view/*.js`로 **align 없이 재생성하는 지점이 더 남아 있지 않은지** 훑는다(새 줄 생성 분기는 승계할 원본이 없으므로 single-arg가 정상이다 — 제자리 재생성만 대상). 남은 것이 있으면 고치지 말고 **step 요약에 목록으로 보고**하라(범위 밖 확장 금지).
3. 변이 검증: 다섯 곳 중 하나에서 2번째 인자를 지우면 대응 테스트가 red가 되는지 확인한다.
4. 아키텍처 체크리스트:
   - view의 순수 헬퍼만 수정했는가(DOM/React/transport 미도입)?
   - `textBlock`/`isValidAlign`/`normalizeBlocks`(editorContent.js)를 수정하지 않았는가?
   - CLAUDE.md 규칙(TDD·DB 비파괴)을 위반하지 않았는가?
5. `phases/49-mini-backlog-cleanup/index.json`의 step3을 갱신한다(`completed` + `summary` 등). `summary`에 **editorFind 2곳 포함**을 명시하라.

## 금지사항

- `editorContent.js`(`textBlock`/`isValidAlign`/`normalizeBlocks`)를 수정하지 마라. 이유: 계약이 이미 옳다 — 소비 측 5곳만 승계 인자를 넘기면 된다. 계약을 바꾸면 40개 파일의 직렬화 바이트가 흔들린다.
- 미정렬 줄에 기본 align(`'left'` 등)을 채워 넣지 마라. 이유: `{type,text}`만 있던 블록에 키가 생기면 직렬화 바이트가 바뀌어 저장·이력 비교·회귀 테스트가 전부 흔들린다.
- `changed`/`count`/`replaced` 판정을 align까지 비교하도록 바꾸지 마라. 이유: 이 다섯 지점은 **텍스트만** 바꾼다 — align은 승계될 뿐 변하지 않으므로 판정 기준을 넓히면 no-op 저장(dirty 유발)이 생긴다. (정렬 op는 값이 재배치되므로 사정이 다르다 — step4에서 별도로 다룬다.)
- `editorFind`의 마커 no-op 가드(L62·L109)·캐럿 오프셋 계산(`caretOffset`)·매치 탐색 로직을 건드리지 마라. 이유: 마커 무결성은 송고 자격 판정의 근거이고, 캐럿 계산은 찾기 UI가 의존하는 계약이다 — 이 step의 범위는 align 인자 1개 추가뿐이다.
- `editorEditOps.js`의 `sortDocument`/`sortParagraph`를 이 step에서 건드리지 마라. 이유: 정렬은 값을 슬롯 사이에서 재배치해 승계 규칙이 다르다 — **다음 step(step4)의 범위**이며, 같이 손대면 실패 원인 격리가 불가능해진다.
- `WriterPage.jsx` 등 결선부를 수정하지 마라. 이유: 호출부는 `{ blocks, changed }`만 소비한다 — 변경할 것이 없다.
- 기존 테스트를 깨뜨리지 마라(기준: web 87 files / 1944 pass, lint·build clean, 백엔드 620/620 green 유지).
