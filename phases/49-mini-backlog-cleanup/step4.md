# Step 4: sort-align

## 목표

**문서/문단 정렬(sort) op가 줄의 정렬(align)을 유실하는 결함**을 수정한다. `editorEditOps.js`의 `sortDocument`/`sortParagraph`는 정렬된 텍스트 값을 슬롯에 되쓸 때 `textBlock(sorted[k])`(single-arg)로 블록을 재생성해 **모든 대상 줄의 align을 날려버린다**(가나다순 정렬 한 번에 문단 전체의 정렬 설정이 소실된다). 여기에 더해 `sortDocument`의 **"(끝)" 마커 재정규화**(L49~51)도 원 마커를 버리고 align 없는 새 블록을 만들어 **마커 줄의 정렬까지 함께 지운다** — 두 지점을 같이 고친다.

phase 45 step0은 이 두 함수를 "align이 값을 따라가야 하나 슬롯에 남아야 하나가 모호한 별도 설계 결정 사안"으로 보고 의도적으로 제외했다. **이 step이 그 결정을 내린다:**

> **결정: align은 텍스트 값을 따라 이동한다(pair-following).** 한 줄 = `{텍스트, 정렬}` 한 쌍으로 보고, 정렬은 그 쌍 전체를 재배치한다.

근거: (a) 사용자 관점에서 "가운데 정렬한 줄"은 그 **문장**의 속성이지 문서 N번째 위치의 속성이 아니다(워드프로세서의 문단 정렬 이동과 동일한 직관). (b) 현재 동작은 두 의미론 중 어느 쪽도 아닌 **데이터 유실**이라 어떤 일관된 규칙이든 개선이다. (c) 대안(슬롯 고정 = align은 자리에 남는다)은 "2번째 줄은 내용과 무관하게 항상 가운데"라는 설명하기 어려운 동작이 된다.

이 step은 **`web/src/view/editorEditOps.js` 한 모듈만** 다룬다(+ 그 테스트). DOM/컨트롤러/모델/서버 무접촉.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`(프론트 MVC), `docs/ADR.md`(ADR-003), `docs/news.md` L161·165~169(정렬 정책: "(끝)" 마커는 정렬 대상 제외·항상 최종 블록, 임베드는 자리 고정).
- `web/src/view/editorContent.js` — `textBlock(text = '', align)`(L18~22, 무효/undefined align은 **키 자체 생략**), `isValidAlign`, `normalizeBlocks`, `blocksToText`, `END_MARKER`.
- `web/src/view/editorEditOps.js` — **전체**. 수정 대상:
  - `sameBlocks(a, b)`(L23~31) — `changed` 판정 헬퍼(텍스트 값/참조만 비교). **sortDocument에서만 쓰인다. 이 step에서 수정하지 않는다(§2 근거).**
  - **`sortDocument(blocks)`(L36~53)** — 텍스트 블록 슬롯 수집 → 값 정렬 → L48 `next[slots[k]] = textBlock(sorted[k]);` ← **수정 대상 1**. 그 아래 **마커 재정규화 L49~51**(`hasEnd` → `ordered.push(textBlock(END_MARKER))`)도 원 마커 블록을 버리고 align 없는 새 블록을 만든다 ← **수정 대상 2**(§1-b).
  - **`sortParagraph(blocks, caretLineIndex)`(L59~83)** — 문단 범위의 텍스트 줄 수집 → 값 정렬 → L78 `next[bi] = textBlock(sorted[k]);` ← **수정 대상 3**(마커는 건너뛰기만 하므로 재정규화 승계는 불필요).
  - `deleteWordAt`(L88~99) — phase 45가 이미 승계로 고친 **선례**(L97에서 `list[blockIndex].align`을 넘긴다). **수정하지 마라.**
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(텍스트 줄 인덱스 → 블록 배열 인덱스, 없으면 -1).
- `web/src/view/editorRange.js` — `paragraphBoundsAt(lines, lineIndex)`(빈 줄 경계 문단 범위, lineIndex는 이미 clamp됨).
- `web/src/view/editorEditOps.test.js` — 이 step의 테스트가 들어갈 파일(기존 스타일: 입력 blocks → 출력 blocks 단언).

## 배경 (자기완결)

`sortDocument`는 텍스트 블록(마커 제외)의 **인덱스 목록(slots)**과 **텍스트 값 목록(values)**을 따로 모아 값만 `localeCompare` 오름차순으로 정렬한 뒤 슬롯에 되쓴다. `sortParagraph`도 같은 구조인데 슬롯이 "문단 범위의 텍스트 줄"이다. 두 경우 모두 되쓸 때 align 인자를 넘기지 않아 **정렬 대상 줄 전부에서 align이 사라진다**.

pair-following으로 고치면 값과 align을 **한 쌍으로 묶어** 정렬하면 된다. JS `Array#sort`는 **안정 정렬**이므로 텍스트가 같은 줄들의 상대 순서(따라서 align 배치)도 보존된다.

여기에 더해 `sortDocument`에는 **두 번째 유실 지점**이 있다: 마커 재정규화(L49~51)가 원래 마커 블록을 필터로 버리고 `textBlock(END_MARKER)`(align 없음)를 새로 push한다. 그래서 **실제로 정렬이 일어나는 모든 호출**(`changed:true`)에서 "(끝)" 줄의 정렬이 함께 사라져 커밋된다. 텍스트 슬롯만 고치고 여기를 놓치면 "정렬하면 마커 정렬만 풀린다"가 남는다.

## TDD — 테스트 먼저

`web/src/view/editorEditOps.test.js`에 red→green으로 추가한다(`textBlock`, `embedBlock` import).

`sortDocument`:
1. **쌍 이동(핵심)**: `[textBlock('zebra','center'), textBlock('apple','right')]` → 결과 `[{text:'apple', align:'right'}, {text:'zebra', align:'center'}]`, `changed === true`.
2. **스퍼리어스 금지**: 미정렬 줄만 정렬하면 결과 블록에 `'align' in b === false`.
3. **혼합**: 정렬된 줄 + 미정렬 줄이 섞이면 각 값이 자기 align(또는 무 align)을 그대로 데리고 간다.
4. **회귀**: "(끝)" 마커는 정렬 대상 제외 + 항상 최종 블록, 임베드는 자리 고정, 이미 정렬된 입력이면 `changed === false`.
4-a. **마커 align 유지(핵심 — high 지적 회귀 가드)**: `[textBlock('z'), textBlock('a'), textBlock('(끝)','center')]`(실제로 정렬이 일어나는 입력) → 텍스트가 `a`,`z` 순으로 재배치되고 `changed === true`이며, **최종 블록인 마커의 `align === 'center'`가 유지**된다. 마커 승계를 빼면 이 단언이 red다(현재 코드의 실제 결함). 덧붙여 이미 정렬된 입력(`[textBlock('a'), textBlock('(끝)','center')]`)에서는 `changed === false`이고 마커 align도 그대로여야 한다.
4-b. **malformed 마커 승계**: 마커가 중간에 있는 입력(`[textBlock('z'), textBlock('(끝)','right'), textBlock('a')]`) → 마커가 최종 블록으로 재정규화되면서 **`align === 'right'`를 유지**하고, 텍스트 슬롯은 정상 정렬된다.
4-c. **마커 무 align 회귀**: 정렬되지 않은 마커(`textBlock('(끝)')`)는 결과에도 `'align' in marker === false`(스퍼리어스 금지).

`sortParagraph`:
5. **쌍 이동**: 빈 줄로 나뉜 문단 안에서 정렬 시 align이 텍스트를 따라간다.
6. **문단 밖 불변**: 다른 문단의 줄과 그 align은 건드리지 않는다.
7. **스퍼리어스 금지**: 미정렬 문단 정렬 결과에 align 키 없음.
8. **회귀**: 단일 줄 문단(`values.length <= 1`)은 `changed === false`이고 blocks가 그대로, 마커 줄은 정렬 대상에서 제외.
9. **안정 정렬**: 텍스트가 같고 align이 다른 두 줄(`textBlock('같음','left')`, `textBlock('같음','right')`)의 상대 순서가 보존된다(= 값이 같은 줄들 사이에서 align이 뒤섞이지 않는다). 이 케이스는 `changed === false`여야 한다.
9-a. **중복 텍스트 + 재배치(핵심 — 슬롯 국소 skip 회귀 가드)**: `[textBlock('b'), textBlock('a','left'), textBlock('a','right')]`(한 문단) 정렬 → 결과 `[{text:'a',align:'left'}, {text:'a',align:'right'}, {text:'b'}]`, `changed === true`. 되쓰기 가드를 텍스트만으로 두면 k=1 슬롯이 skip되어 `[a(left), a(left), b]`가 나오므로 **red**가 된다(`'right'` 소실 + `'left'` 오배정).

## 작업

### 1) `sortDocument` — 정렬 슬롯 되쓰기 + **마커 재정규화 align 승계**

(a) 값 목록을 `{ text, align }` 쌍으로 모으고, 비교자를 `(a, b) => a.text.localeCompare(b.text)`로 바꾼 뒤 `textBlock(pair.text, pair.align)`으로 되쓴다. 슬롯 수집 로직·임베드 위치 보존은 **그대로**다.

(b) **마커 재정규화(L49~51)도 align을 승계해야 한다.** 현재 코드는
```js
const hasEnd = next.some(isEndMarkerBlock);
const ordered = next.filter((b) => !isEndMarkerBlock(b));
if (hasEnd) ordered.push(textBlock(END_MARKER));   // ← align 없는 새 블록으로 교체된다
```
로 **원래 마커 블록을 버리고 align 없는 새 블록을 push**한다. 이건 이미 실제 결함이다: 텍스트가 한 줄이라도 자리를 바꾸면 `changed:true`가 되어 호출부가 결과 blocks를 커밋하므로, **정렬이 실제로 일어나는 모든 호출에서 "(끝)" 줄의 정렬이 함께 지워진다**(정렬 대상 줄만 고치고 여기를 놓치면 "정렬하면 마커 정렬만 풀린다"가 남는다). 그래서 재정규화는 **원 마커 블록의 align을 승계**해야 한다:

- 필터 전에 원 마커 블록을 찾아 그 align을 보관한다(`next.find(isEndMarkerBlock)` — 문서 순서상 **첫 번째** 마커. 마커가 여러 개인 malformed 입력을 하나로 합치는 기존 동작은 유지한다).
- `ordered.push(textBlock(END_MARKER, prevMarkerAlign))`.
- 마커가 없으면(`hasEnd === false`) 지금처럼 아무것도 push하지 않는다.
- 마커 텍스트는 항상 정규 `END_MARKER` 상수로 되쓴다(원문 공백 등 변형을 그대로 살리지 마라 — 기존 정규화 계약).

### 2) `sameBlocks`(changed 판정)는 **텍스트 비교 그대로 둔다** — 수정 금지

align 동등성 비교를 추가하고 싶어질 수 있으나 **추가하지 마라.** 근거:

- `Array#sort`는 **안정 정렬**이라 텍스트가 같은 항목들의 상대 순서가 보존된다 → 어떤 입력에서도 "슬롯별 텍스트는 그대로인데 align만 이동한" 결과가 나올 수 없다(값이 자리를 바꾸면 반드시 텍스트도 바뀐다). 즉 align 비교는 **어떤 테스트로도 참/거짓을 구분할 수 없는 죽은 조건**이다(변이 검증 불가 = 정당화 불가).
- 반대로 align 비교를 넣으면 위험이 생긴다: (1-b)를 빠뜨린 상태에서는 **이미 정렬된 문서(정렬 op가 no-op이어야 하는 입력)** 에서도 "마커 align 유실"이 차이로 잡혀 `changed:true`가 되고, 그 순간 align이 지워진 본문이 커밋된다(지금은 `changed:false`라 커밋되지 않는 경로다). 이득 없이 실패 표면만 넓힌다.
- 마커 align 보존은 (1-b) 승계가 담당하며, 그 승계는 `changed` 판정과 무관하게 **반환 blocks 자체를 옳게** 만든다(케이스 4-a·4-b가 잠근다).

`sameBlocks`는 **한 줄도 바꾸지 않는다.**

### 3) `sortParagraph`

수집 루프에서 각 줄의 블록 인덱스(`textLineToBlockIndex(list, ln)`)로 align을 함께 읽어 `{ text, align }` 쌍을 만든다(매핑 실패(-1)면 align은 `undefined`). 정렬 후 되쓰기는:

```js
if (next[bi].text !== pair.text || next[bi].align !== pair.align) {   // 텍스트 OR 정렬이 다르면 되쓴다
  next[bi] = textBlock(pair.text, pair.align);
  changed = true;
}
```

- **align 비교 절을 절대 빼지 마라.** §2의 "죽은 조건" 논거는 `sameBlocks`의 **전체 시퀀스 비교**에만 해당하고, 여기 **슬롯 국소 비교**에서는 거짓이다 — 텍스트가 같은 줄들 사이에서 align은 실제로 이동한다.
  반례: 한 문단이 `[b, a(left), a(right)]`일 때 정렬 결과는 `[a(left), a(right), b]`여야 하는데, 텍스트만 비교하면 k=1 슬롯(원래 `a(left)`, 넣어야 할 쌍은 `a(right)`)이 "텍스트 동일"로 skip되어 **`[a(left), a(left), b]`** 가 된다(`'right'` 소실 + `'left'` 오배정).
- 동등한 대안: `sortDocument`처럼 슬롯을 **무조건 되쓰고**(`next[bi] = textBlock(pair.text, pair.align)`) `changed`만 되쓰기 전 블록과의 쌍 비교(`text` 또는 `align` 차이)로 판정해도 된다. 둘 중 하나를 택하되, "텍스트만 보고 skip"은 금지다.
- `values.length <= 1` 조기 반환, 마커 줄 제외, 매핑 실패 슬롯 skip(`bi < 0`), 반환 shape(`{ blocks, changed }`)은 **불변**이다.
- `sortParagraph`는 마커를 **재생성하지 않고 건너뛰기만** 하므로 (1-b) 같은 승계가 필요 없다(마커 블록이 원본 그대로 남는다).

### 4) 주석

두 함수의 주석에 **"align은 텍스트 값을 따라 이동한다(줄=텍스트+정렬 한 쌍)"** 규칙을 한 줄로 명시하라. phase 45 step0이 보류했던 결정이 여기서 내려졌다는 사실도 한 줄로 남긴다(다음 독자가 규칙의 출처를 찾을 수 있게). `sortDocument`의 마커 재정규화 줄에는 **"마커의 align도 승계한다(재정규화가 정렬을 지우지 않게)"** 를 한 줄 덧붙인다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web        # 87 files, 실패 0 (기준선 1944 pass + 신규 케이스)
npm test                # 620/620 green — 백엔드 무접촉 증명(step0 이후 기준선)
```

`git diff --name-only`에 `src/`·`server/`·`test/`가 없어야 한다(웹 파일만).

## 검증 절차

1. 위 AC 커맨드 실행 — web 전량 green, 백엔드 620/620.
2. 변이 검증 2종:
   - `textBlock(pair.text, pair.align)`의 2번째 인자를 지우면 케이스 1·5가 red.
   - **마커 승계(§1-b)를 되돌리면**(`textBlock(END_MARKER)`) 케이스 4-a(마커 align 단언)와 4-b가 red.
   - **`sortParagraph` 되쓰기 가드에서 align 비교 절을 제거하면**(텍스트만 비교) 케이스 9-a가 red.
   - (참고) `sameBlocks`는 수정 대상이 아니다 — align 비교를 넣어도/빼도 구분하는 테스트가 존재할 수 없으므로(§2 근거) 손대지 않는 것이 정답이다. 만약 구현 중 `sameBlocks`를 고쳤다면 되돌려라.
3. 아키텍처 체크리스트:
   - view 순수 헬퍼만 수정했는가(DOM/React 미도입)?
   - `editorContent.js`·`writerBody.js`·`editorRange.js`를 수정하지 않았는가?
   - 정렬 정책(마커 최종 블록·임베드 자리 고정)이 보존됐는가?
4. `phases/49-mini-backlog-cleanup/index.json`의 step4를 갱신한다. `summary`에 **채택한 의미론(pair-following)**을 반드시 남겨라(후속 세션이 규칙을 뒤집지 않도록).

## 금지사항

- 슬롯 고정(positional) 의미론으로 구현하지 마라(`textBlock(sorted[k], next[bi].align)`). 이유: 이 step의 설계 결정은 pair-following이다 — 두 규칙이 섞이면 sortDocument와 sortParagraph가 서로 다르게 동작한다.
- 임베드 블록의 위치를 정렬 대상에 포함하거나 재배치하지 마라. 이유: news.md 정책상 임베드는 자기 자리를 지킨다(텍스트 값만 슬롯에 되쓴다).
- "(끝)" 마커를 정렬 대상에 넣거나 최종 블록 재정규화를 제거하지 마라. 이유: 마커 위치는 송고 자격 판정(`hasEndMarker`)의 근거다. **단 하나의 예외가 §1-b다** — 재정규화로 만드는 마커 블록에 원 마커의 align을 승계하는 것(위치 규칙·마커 텍스트·다중 마커 병합 동작은 그대로, align 인자만 추가).
- `sameBlocks`에 align 비교를 추가하지 마라. 이유: 안정 정렬 하에서 **전체 시퀀스**로 보면 "텍스트 동일·align만 이동"이 발생할 수 없어 어떤 테스트로도 구분되지 않는 죽은 조건이고(§2), §1-b를 놓치면 마커 align 유실을 `changed:true`로 커밋시키는 부작용만 남는다. **이 금지는 `sameBlocks` 한 함수에만 적용된다** — `sortParagraph`의 슬롯 국소 되쓰기 가드(§3)에서는 align 비교가 **필수**다(중복 텍스트 재배치에서 align이 실제로 이동한다 — 케이스 9-a).
- 미정렬 줄에 기본 align을 채워 넣지 마라. 이유: 없던 `align` 키가 생기면 직렬화 바이트가 바뀐다(저장·이력 비교 회귀).
- 캐럿 위치 보정(clamp/이동) 로직을 추가하지 마라. 이유: 두 함수는 전체 transform 정책상 캐럿을 의도적으로 재배치하지 않는다(phase 45가 확인한 기존 계약) — 범위 밖이다.
- `deleteWordAt`·`companyCodeConvert`·`abbrevConvert`·`simpTradConvert`를 건드리지 마라. 이유: 이미 승계가 적용됐거나(전자) 직전 step의 범위다(후자) — 중복 수정은 diff 충돌과 원인 격리 실패를 만든다.
- 기존 테스트를 깨뜨리지 마라(기준: web 87 files / 1944 pass 이상, lint·build clean, 백엔드 620/620 green 유지).
