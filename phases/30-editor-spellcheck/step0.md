# Step 0: spell-engine-pure — 맞춤법 검사 순수 엔진

## 배경 / 요구사항

`docs/news.md`의 에디터 "맞춤법" 메뉴 5종(L180)과 환경설정 "맞춤법" 탭(L213~215)을 실동작화하는 phase의 **1단계(순수 계산 엔진)**다. 외부 API/서버/형태소 분석 없이 **로컬 규칙 기반 MVP**로 본문 텍스트를 스캔해 오류 후보를 탐지한다.

이 step은 순수 함수 모듈 `web/src/view/editorSpell.js` 하나만 만든다 — DOM/`window`/`document`/transport/localStorage 미접촉. UI·다이얼로그·WriterPage 결선은 Step 1/2다. `editorFind.js`(찾기 순수 엔진)의 선례를 따른다: 좌표는 `blocksToText(blocks)`(텍스트 블록만 개행으로 이은 평문)의 절대 오프셋 기준이고, **본문을 절대 수정하지 않는다**(탐지·오프셋 반환만).

핵심 설계 결정(반드시 이대로 구현):
- **검사 = 탐지만.** 엔진은 오류 후보 목록(오프셋 + 규칙군 + 메시지 + 교정 제안)만 반환한다. 본문 문자열을 바꾸거나 일괄 자동교체하는 함수를 만들지 마라.
- **규칙군 6개**를 두고, 환경설정 `errorTypes`(6종 bool)·`checkOption`(단일 enum 5종)이 어떤 규칙군을 켜는지 순수 매핑으로 명시한다(아래 표).
- 완전한 한국어 맞춤법/형태소 분석은 out of scope. 규칙은 **결정적(deterministic)** 이어야 한다 — `Date`/랜덤/로케일 의존 금지.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 프론트 view 계층·ADR 철학(외부 의존성 0, 표준 기능 우선, TDD).
- `/docs/news.md` L180(맞춤법 메뉴), L213(검사옵션 5종), L214(오류 유형 6종), L215(오류 표현) — 스펙 원문.
- `web/src/view/editorFind.js` — **본보기 순수 엔진**. `findMatches(text, query, {caseSensitive})` 비중첩 리터럴 스캔 → `[{start,end}]`, `blocksToText` 절대 오프셋 기준, 입력 mutate 없음. 이 모듈의 함수 구조·순수성·주석 밀도를 그대로 따른다.
- `web/src/view/editorFind.test.js` — 순수 엔진 테스트 패턴(vitest, 경계 케이스: 빈 입력·no-op·오프셋 단조성).
- `web/src/view/editorContent.js` — `blocksToText`(좌표 기준 텍스트), `normalizeBlocks`. **엔진은 blocks가 아니라 이미 만들어진 text 문자열을 받는다**(Step 2가 `blocksToText(blocks)`를 넘김). blocks를 직접 다루지 마라.
- `web/src/view/editorCaret.js` — `lineAtOffset(text, caretOffset)` → `{lineIndex, start, end}`(문단 범위 계산에 재사용 후보). `lines(text)`.
- `web/src/view/editorPrefs.js` — `DEFAULT_EDITOR_PREFS.spellcheck` 스키마: `{ checkOption(enum 5종), errorTypes(6키 bool), errorStyle }`. 엔진이 받을 prefs shape의 출처(단, 엔진은 editorPrefs를 import하지 않는다 — prefs 객체는 인자로 받는다).

## 작업

TDD로 진행한다(vitest, 테스트 먼저). 새 모듈 `web/src/view/editorSpell.js`, 새 테스트 `web/src/view/editorSpell.test.js`.

### 규칙군 6개와 환경설정 매핑 (반드시 이 매핑 그대로)

`errorTypes`(store 6키) → 규칙군:

| errorTypes 키 | 한글(news.md) | 규칙군 키 | 규칙 예시 |
|---|---|---|---|
| `misuse` | 오용어 | `misuse` | 흔한 오탈자 사전(예: `됫다`→`됐다`, `왠만`→`웬만`, `역활`→`역할`, `금새`→`금세`, `어떻해`→`어떡해`) |
| `multiWord` | 다수어절 | `dupWord` | 연속 중복 어절(공백 경계로 같은 어절이 연달아 반복 — 예: `먹었다 먹었다`) |
| `semantic` | 의미문체 | `punctuation` | 문장부호 문체(마침표/쉼표 뒤 공백 누락, 문장부호 3연속 이상 `!!!`·`???`) |
| `circular` | 순환용어 | `loanword` | 외래어/순환용어 표기 사전(예: `메세지`→`메시지`, `쥬스`→`주스`, `악세사리`→`액세서리`) |
| `statSpacing` | 통계붙여쓰기 | `spacing` | 공백 오류(중복 공백 2칸 이상, 문장부호 앞 공백 ` ,`·` .`) |
| `others` | 그외 | `misc` | 나머지(줄 끝 공백, 탭 문자) |

`checkOption`(store 단일 enum) → **강제 포함** 규칙군(coarse override, 아래 `activeRuleGroups`에서 합집합):

| checkOption 값 | 한글 | 강제 포함 규칙군 |
|---|---|---|
| `procedure` | 절차오류 | (없음) |
| `spacing` | 띄어쓰기 | `spacing` |
| `joining` | 붙여쓰기 | `spacing` |
| `spacingJoining` | 띄어쓰기+붙여쓰기 | `spacing` |
| `circularLoan` | 순환용어·외래어 | `loanword` |

각 사전(misuse/loanword)의 항목 수는 소규모여도 된다(대표 5~10개). 사전 항목은 `{ bad, good }` 형태로 상수 배열에 두고, 규칙 함수가 `bad`의 비중첩 리터럴 매치를 스캔해 `suggestion=good`으로 이슈를 낸다.

### export 시그니처 (인터페이스만 — 구현 재량, 단 규칙은 이 계약을 지킴)

```js
// 규칙군 키(안정 상수).
export const RULE_GROUPS = ['misuse', 'dupWord', 'punctuation', 'loanword', 'spacing', 'misc'];

// errorTypes(store 키) → 규칙군 키.
export const ERROR_TYPE_RULE_GROUP; // { misuse:'misuse', multiWord:'dupWord', semantic:'punctuation', circular:'loanword', statSpacing:'spacing', others:'misc' }

// checkOption(store enum) → 강제 포함 규칙군 키(또는 null).
export const CHECK_OPTION_RULE_GROUP; // { procedure:null, spacing:'spacing', joining:'spacing', spacingJoining:'spacing', circularLoan:'loanword' }

// spellcheck prefs({checkOption, errorTypes}) → 활성 규칙군 키 배열(중복 제거).
//   errorTypes에서 true인 키의 규칙군 + checkOption의 강제 포함 규칙군을 합집합.
//   합집합이 비면(모든 errorTypes false + checkOption procedure) RULE_GROUPS 전체로 폴백한다.
//   (참고: store 기본값은 checkOption 'spacing'이라 첫 실행엔 spacing 규칙군이 활성된다 — 폴백은
//    checkOption 'procedure' + errorTypes 전부 false 조합에서만 발동하며, 그 조합이 "아무것도
//    안 걸림"으로 보이는 것을 막는 사용가능 기본값이다.)
export function activeRuleGroups(spellcheckPrefs) { /* → string[] */ }

// 검사 범위 슬라이스. scope ∈ 'all' | 'paragraph' | 'toCaret' | 'fromCaret'.
//   all → { start:0, end:text.length }
//   toCaret → { start:0, end:clamp(caretOffset) }
//   fromCaret → { start:clamp(caretOffset), end:text.length }
//   paragraph → caretOffset이 속한 "문단"(빈 줄로 구분된 연속 비어있지 않은 줄 그룹)의 { start, end }.
//     (lineAtOffset/lines 재사용 가능. 캐럿 줄이 빈 줄이면 그 빈 줄 하나를 문단으로 본다.)
//   caretOffset은 Number 강제 + [0, text.length]로 clamp.
export function spellRange(text, scope, caretOffset) { /* → { start, end } */ }

// 핵심 스캔. groups=활성 규칙군 키 배열. range={start,end} 있으면 그 구간과 겹치는 이슈만 남긴다(오프셋은 절대값 유지).
//   반환: [{ start, end, group, message, suggestion }] — start/end는 text 절대 오프셋, suggestion은 없으면 null.
//   start 오름차순 정렬. 같은 오프셋 다중 규칙은 중복 제거(같은 {start,end,group}는 1개).
//   본문을 절대 반환/수정하지 않는다(이슈 목록만).
export function checkSpelling(text, { groups = RULE_GROUPS, range } = {}) { /* → Issue[] */ }
```

이슈 `message`는 한국어 짧은 설명(예: `중복된 어절`, `문장부호 앞 공백`, `오탈자 의심`). `suggestion`은 사전 규칙(misuse/loanword)·정규화 가능한 공백/문장부호 규칙에서만 제공하고, 판단 불가하면 `null`.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수·결정적**: `window`/`document`/`localStorage`/`fetch`/`Date`/랜덤 미사용. 같은 입력 → 같은 출력. 이유: Step 2가 렌더 중/이벤트에서 호출하고 단위 테스트가 네트워크·시계 없이 검증한다.
2. **본문 불변**: 텍스트를 수정하거나 "치환된 텍스트"를 반환하는 함수를 만들지 마라. 엔진은 탐지(오프셋)만 한다. 이유: news.md 확정 정책 "본문 자동 수정 금지 — 일괄 자동교체 없음".
3. **절대 오프셋 유지**: `range`로 구간 검사를 해도 이슈의 `start`/`end`는 원본 `text` 기준 절대 오프셋이다(구간 시작을 빼지 마라). 이유: Step 2가 이 오프셋으로 캐럿을 이동한다(`lineAtOffset(bodyText, start)`).
4. **비중첩 스캔**: 한 규칙 안에서 매치는 비중첩으로 순차 스캔한다(`editorFind.findMatches` 방식 — 매치 끝 다음부터 재탐색). 이유: 겹치는 이슈로 오프셋이 꼬이는 것을 막는다.
5. **매핑 상수는 freeze**: `ERROR_TYPE_RULE_GROUP`/`CHECK_OPTION_RULE_GROUP`은 `Object.freeze`. 이유: 계약 안정성(Step 2가 참조).

## Acceptance Criteria

```bash
npm run test:web
npm run build
npm run lint
```

추가 단언(vitest, editorSpell.test.js — 최소 아래 케이스 포함):
- `checkSpelling('', {})` → `[]`(빈 입력 no-op). `checkSpelling(text)` 기본 groups는 전체 규칙군.
- `dupWord`: `'먹었다 먹었다'`에서 중복 어절 이슈 1개, `start`/`end`가 두 번째 어절(또는 반복 구간)을 정확히 가리키고 `group==='dupWord'`.
- `misuse` 사전: `'그건 역활이다'`에서 `역활` 이슈(`suggestion==='역할'`).
- `loanword` 사전: `'메세지 도착'`에서 `메세지` 이슈(`suggestion==='메시지'`).
- `spacing`: 중복 공백(`'가  나'`)·문장부호 앞 공백(`'안녕 ,'`)에서 이슈. `punctuation`: 문장부호 3연속(`'정말!!!'`)에서 이슈.
- `activeRuleGroups`: errorTypes 전부 false + checkOption `procedure` → RULE_GROUPS 전체(폴백). errorTypes `{misuse:true}` + checkOption `procedure` → `['misuse']`. checkOption `spacing`은 `spacing` 강제 포함(errorTypes와 합집합·중복 없음).
- `spellRange`: `all`은 전체, `toCaret`/`fromCaret`은 캐럿 기준 경계, `paragraph`는 빈 줄로 구분된 문단 경계. caretOffset 음수/초과는 clamp.
- `checkSpelling(text, { groups, range })`가 range 밖 이슈를 제외하되 남은 이슈의 오프셋은 절대값 유지.
- `checkSpelling`은 어떤 경로에서도 입력 `text`를 변형하지 않는다(같은 문자열 재호출 결과 동일).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: 순수 함수 모듈(ADR-003 view 로직), `editorSpell.js`가 `window`/`document`/`fetch`/`Date` import·호출 없음, 본문 수정 함수 없음, 매핑 상수 freeze.
3. 결과에 따라 `phases/30-editor-spellcheck/index.json`의 step 0을 업데이트(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked).

## 금지사항

- 본문을 치환·정규화해 돌려주는 함수를 만들지 마라. 이유: news.md 확정 정책(자동 수정 금지). 교정은 Step 1/2에서 "제안 표시"까지만.
- `Editor.jsx`·`WriterPage.jsx`·`EditorPrefsDialog.jsx`·`editorPrefs.js`를 수정하지 마라. 이유: 이 step은 엔진 모듈 신규 추가만. 결선은 Step 2.
- `Date`·랜덤·`Intl`/로케일 비교를 쓰지 마라. 이유: 비결정적 결과는 테스트 불가능하고 재현성이 깨진다.
- 외부 npm 패키지(맞춤법/형태소 라이브러리)를 추가하지 마라. 이유: ADR 철학(런타임 의존성 최소). 규칙은 로컬 상수 사전 + 정규식으로만.
- `blocksToText`가 만드는 좌표 규칙을 바꾸지 마라(엔진은 text만 받고 blocks/임베드를 모른다). 이유: Step 2 캐럿 이동이 이 좌표에 의존한다.
