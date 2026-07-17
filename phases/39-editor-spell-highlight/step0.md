# Step 0: spell-highlight-model

이 phase는 환경설정 맞춤법 탭의 **"오류 표현(굵게/밑줄)"을 에디터 본문 내 하이라이트로 표시**한다(설정 effect 로드맵 2/3). step0은 그 전제인 **순수 세그먼트 모델**만 만든다 — "본문 텍스트 + 오류 오프셋" → "줄별 하이라이트 세그먼트"로 나누는 결정적 함수. DOM/렌더/상태는 step1·step2다.

## 배경 (자기완결 — 이전 대화 참조 없이 여기서 이해하라)

- 규칙엔진(`editorSpell.js`)의 `checkSpelling(text, {groups, range})`는 오류 후보를 `[{ start, end, group, message, suggestion }]`로 반환한다. `start`/`end`는 **`blocksToText(blocks)`(텍스트 블록만 `\n`으로 이은 평문)의 절대 오프셋**(코드유닛 기준, end 배타적)이다. phase 30에서 이 검사와 결과 다이얼로그(`SpellCheckDialog`)·환경설정 소비(checkOption/errorTypes/errorStyle)는 이미 결선됐다.
- **이 phase의 신규 범위는 "그 오류들을 본문 위치에 하이라이트로 그리는 것"뿐**이다. step0은 그 하이라이트를 그릴 수 있도록 "각 줄의 텍스트를 하이라이트 구간과 비-하이라이트 구간의 세그먼트 목록으로 분할"하는 순수 함수를 제공한다.
- 서로 다른 규칙군의 이슈는 **겹칠 수 있다**(`editorSpell.js` L203 주석: "서로 다른 규칙끼리는 겹칠 수 있다"). 따라서 세그먼트 분할 전에 **오프셋 구간을 합집합으로 병합**해야 한다(겹치거나 맞닿은 span은 하나의 하이라이트 구간으로).

## 읽어야 할 파일

먼저 아래를 읽어 좌표계·계약·설계 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 프론트 MVC, ADR-003. 이 모듈은 순수 view 헬퍼(DOM/transport 비의존)다.
- `/docs/news.md` L216~219 — 맞춤법 탭(오류 표현: 굵게, 밑줄). L171 — Alt+Y 브라우저 네이티브 맞춤법은 **별개 기능**(이 모듈과 무관, 혼동 금지).
- `web/src/view/editorSpell.js` — 전체. 특히 L92~94(`issue()` = `{start,end,group,message,suggestion}`), L1~4·L214~216(오프셋이 `blocksToText` 절대 오프셋·코드유닛), L202~203(규칙 간 겹침 가능), L217~238(`checkSpelling` 반환·정렬·중복제거).
- `web/src/view/editorSpell.test.js` — 테스트 스타일(vitest, 리터럴 케이스, 오프셋 단언)을 본보기로.
- `web/src/view/editorContent.js` — `blocksToText`의 정의(텍스트 블록만 `\n`으로 잇고 임베드는 제외하는지 확인). 이 모듈의 "줄" 인덱스는 `blocksToText(text).split('\n')`의 줄 인덱스와 **정확히 일치**해야 한다(step1 렌더가 이 인덱스로 텍스트 줄을 매핑).

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

신규 순수 모듈 `web/src/view/editorSpellHighlight.js`를 만든다(zero-dep — React/DOM/Date/랜덤 import 금지).

### export 시그니처 (고정 — 구현은 재량)

```js
// 본문 평문(blocksToText 결과)과 오류 span 목록을 받아, 줄별 하이라이트 세그먼트 배열을 반환한다.
// text: string (blocksToText 평문). spans: [{ start, end }] (blocksToText 절대 오프셋, end 배타적; issue 객체를
//   그대로 넘겨도 start/end만 읽는다). 반환: text.split('\n')의 줄 인덱스로 색인된 배열이며,
//   각 원소는 그 줄의 세그먼트 목록 [{ text: string, hl: boolean }]다.
//   불변식: 각 줄 세그먼트의 text를 순서대로 이으면 그 줄 텍스트와 정확히 같다(공백 포함, 손실/추가 없음).
export function buildLineHighlights(text, spans) // -> Array<Array<{ text, hl }>>
```

### 못박는 규칙

1. **병합 우선**: 입력 span들을 먼저 정규화·병합한다 — 각 span을 `[max(0,start), min(text.length,end)]`로 clamp하고, `start >= end`(빈/역전)·비유한 값은 버린다. 남은 구간을 시작 오프셋 오름차순으로 정렬한 뒤 **겹치거나 맞닿은(다음.start <= 현재.end) 구간을 하나로 병합**한다(합집합). 이유: 규칙 간 겹침(editorSpell L203) + 맞닿은 두 하이라이트가 시각적으로 갈라지지 않게.
2. **줄 좌표 매핑**: `text.split('\n')`로 줄을 나누고, 각 줄의 전역 시작 오프셋을 누적한다(줄 길이 + `\n` 1). 병합 구간과 각 줄 `[lineStart, lineEnd)`의 교집합만 그 줄에 반영한다. **`\n` 자체는 하이라이트 대상이 아니다**(줄 사이 경계). 한 span이 여러 줄에 걸치면 각 줄에서 해당 줄에 걸친 부분만 하이라이트된다.
3. **세그먼트 구성**: 각 줄에서 하이라이트 구간과 그 사이 비-하이라이트 구간을 **문서 순서대로 번갈아** 낸다. 하이라이트가 줄 시작에서 시작하면 앞 비-hl 세그먼트는 없고, 줄 끝까지면 뒤 세그먼트는 없다. 하이라이트가 없는 줄은 **`[{ text: <줄 전체>, hl: false }]`** 단일 세그먼트로 낸다(빈 줄은 `[{ text: '', hl: false }]`). 이유: step1 렌더가 "세그먼트 없음/단일 비-hl"이면 기존과 동일하게 순수 텍스트 노드로 렌더해 DOM 동일성을 유지한다.
4. **코드유닛 일관성**: 오프셋은 JS 문자열 인덱스(UTF-16 코드유닛)다. `slice`도 코드유닛 기준이라 `checkSpelling`이 낸 오프셋과 자동 정합한다. 한글(BMP·1 코드유닛)은 안전하다. **서로게이트 쌍(이모지 등) 중간에서 경계를 임의로 만들지 마라** — 입력 span 경계를 그대로 쓰되(엔진이 쌍 중간을 가리키지 않음), 인위적 반올림/분할을 하지 않는다.
5. **순수·불변**: 입력 `text`/`spans`를 mutate하지 않는다. 같은 입력 → 같은 출력(결정적).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(이 phase는 백엔드 무관 — `npm test`(node --test)는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. `editorSpellHighlight.test.js`에 아래 케이스가 모두 있는지 확인(TDD로 먼저 작성):
   - 줄 중간 span → `[before, hl, after]` 3세그먼트, 이어붙이면 원문.
   - 줄 시작 span → 앞 세그먼트 없음(`[hl, after]`). 줄 끝까지 span → 뒤 세그먼트 없음(`[before, hl]`). 줄 전체 span → `[hl]` 1세그먼트.
   - 겹치는 span(`{0,3}`,`{2,5}`) → 병합 `{0,5}` 단일 hl. 맞닿은 span(`{0,2}`,`{2,4}`) → 병합 `{0,4}` 단일 hl.
   - 여러 줄에 걸친 span → 각 줄의 걸친 부분만 hl(`\n` 미포함), 각 줄 이어붙이면 원문.
   - 범위 밖/역전/비유한 span → 무시(무-하이라이트).
   - 하이라이트 없는 줄 → `[{text, hl:false}]`; 빈 줄 → `[{text:'', hl:false}]`; 빈 text → `[[{text:'',hl:false}]]`.
   - 한글 오탈자 span(예: `'됫다'`가 포함된 줄에서 그 2글자 구간) → 정확히 그 글자만 hl.
   - `spans`에 issue 객체(추가 필드 group/message 포함)를 그대로 넣어도 start/end만 읽어 동작.
3. 아키텍처 체크: DOM/React/Date/랜덤 import 없음(순수), `editorSpell.js`·`Editor.jsx`·`WriterPage.jsx` 미변경, UTF-8 저장.
4. 결과에 따라 `phases/39-editor-spell-highlight/index.json`의 step0을 업데이트(성공 → completed + summary 한 줄 / 3회 수정 후 실패 → error + error_message / 개입 필요 → blocked + blocked_reason).

## 금지사항

- React/DOM/Date/랜덤을 import하지 마라. 이유: 순수 결정적 모델이라야 단위 테스트로 경계/겹침/멀티라인 케이스를 완전 검증할 수 있다(step1의 렌더 위험과 분리).
- 세그먼트 text의 공백을 접거나 정규화하지 마라(`trim`/`replace` 금지). 이유: 이어붙인 결과가 원문과 정확히 같아야 렌더가 본문을 왜곡하지 않는다(공백-전용 오류 조각도 보존 — SpellCheckDialog snippet 선례).
- 입력 `text`/`spans`를 mutate하지 마라. 이유: 표시 전용 파생값이며 호출부가 원본을 재사용한다.
- `editorSpell.js`를 수정하지 마라(규칙 추가·오프셋 변경 금지). 이유: 검출 엔진과 표시-매핑 레이어를 분리 유지한다 — 엔진 계약(오프셋 의미)을 바꾸면 다이얼로그(phase 30)까지 오염된다.
- `phases/index.json`(top-level)을 수정하지 마라. 이유: 오케스트레이터가 일괄 관리한다.
- 기존 테스트를 깨뜨리지 마라.
