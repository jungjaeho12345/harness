# Step 0: embargo-policy

엠바고 배부의 **판정 규칙만** 담는 순수 모듈 `src/services/embargoPolicy.js`를 신설한다.
"어떤 kind를 지금 배부해야 하는가(도래 판정)"와 "배부 이력이 이러할 때 기사 상태는 무엇이어야 하는가(DES/EPS/DPS)"를
DB·HTTP·파일시스템·타이머와 무관한 순수 함수로 고정한다. **이 step은 아무 것도 결선하지 않는다**(호출자는 step2·step3).

## 배경 (phase 48 전체 맥락 — 이 step만 읽어도 되게 요약)

- 배부 3부작: phase 46(배부 대상 CRUD) → phase 47(송고 즉시 배부) → **phase 48(DES 상태 신설 + 엠바고 시점 배부 tick)**.
- 사용자 확정 스펙(2026-07-28)이 정한 엠바고 기사 생애주기: **데스크 송고 → DES(배부 전 대기) → 첫 배부 실행 → EPS(배부 진행) → 배부 완결 → DPS**.
  `docs/news.md` "기사 생애주기" 절에 "엠바고 기사는 RDS->DES->EPS 가 기본 생애주기가 된다"로 기재돼 있다.
- 배부 규칙(`docs/news.md` "엠바고 규칙" 절)이 유일한 실질 스펙이다:
  - 1차 엠바고 시각 → **언론사(press)** 에만 배부
  - 2차 엠바고 시각 → **비언론사(nonpress)** 배부, 단 **송고 시 바로 언론사(press)** 배부
  - 1+2차 → 1차 시각에 언론사 먼저, 2차 시각에 비언론사

## 읽어야 할 파일

- `docs/news.md` — "엠바고 규칙" 절 전문 + "기사 생애주기" 절 전문(특히 `엠바고 기사는 RDS->DES->EPS` 행).
- `docs/ADR.md` — ADR-008 (3)(4)(5)(시점 배부는 tick pull, 앱 타이머·egress 금지 / 배부 완결 시 상태 전이).
- `docs/SCHEMA.md` — Contents 절(`embargoAt`·`secondEmbargoAt`·`distributedAt`·`status`, "시간 컬럼은 ISO-8601 UTC 문자열").
- `src/services/lifecycle.js` — 전이표의 형태·주석 관례(순수 모듈이 어떻게 생겼는지의 본보기).
- `src/services/distributionService.js` — 특히 `KINDS = ['press','nonpress']`(15행)와 `record({ articleId, eventType:'distribute', action: kind })`(87행).
  **이 이력 행이 "이미 배부됨" 판정의 유일한 근거다.**
- `src/models/articleHistoryModel.js` — `queryByArticle(articleId)`가 돌려주는 행 shape(`{ id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot }`).
- `src/services/spoolDir.js`, `src/services/fileRef.js` — 이 프로젝트의 "작은 순수 검증 모듈" 관례(파일 크기·주석 밀도 참고).

## 작업

**TDD: `test/embargoPolicy.test.js`를 먼저 쓰고 red(ERR_MODULE_NOT_FOUND)를 확인한 뒤 구현한다.**

### 1) 노출할 시그니처 (구현은 재량, 계약은 고정)

```js
// src/services/embargoPolicy.js
export const EMBARGO_DISTRIBUTABLE_STATUSES; // Object.freeze(['DES','EPS','DPS'])

export function requiredKinds(contents = {});            // → ['press'] | ['nonpress'] | ['press','nonpress'] | []
export function distributedKinds(historyRows = []);      // → 중복 없는 ['press'|'nonpress'...]
export function unparsableEmbargoFields(contents = {});  // → ['embargoAt'|'secondEmbargoAt'...]
export function dueKinds({ status, contents, distributed = [], now });   // → 지금 배부해야 할 kinds
export function embargoStatusFor({ status, contents, distributed = [] }); // → 'DES'|'EPS'|'DPS'|null
```

### 2) 규칙 (news.md 직역 — 임의 확장 금지)

**requiredKinds(contents)** — "이 기사의 엠바고 배부가 완결되려면 어떤 kind가 필요한가":
- `embargoAt`이 truthy면 `'press'` 포함 (1차 엠바고 = 언론사)
- `secondEmbargoAt`이 truthy면 `'nonpress'` 포함 (2차 엠바고 = 비언론사)
- 둘 다 없으면 `[]` (엠바고 기사가 아님 → 이 모듈은 관여하지 않는다)
- 반환 순서는 항상 `['press','nonpress']` 부분집합 순서로 고정한다(단언 안정성).
- 주의: 2차만 설정된 기사의 "송고 즉시 press 배부"는 **완결 요건이 아니다**(required는 `['nonpress']`).
  근거: 사용자 확정 스펙 A.3 "EPS→DPS: 2차만=2차 배부 후".

**distributedKinds(historyRows)** — `eventType === 'distribute'`인 행의 `action`만 모은다. `'press'|'nonpress'` 외 값은 버린다.
- 근거: `distributionService`는 실제로 스풀에 1건 이상 기록됐을 때만 이 행을 남긴다(거짓 기록 금지 — distributionService.js:84-88).

**dueKinds({ status, contents, distributed, now })** — "지금 시각에 배부해야 할 kind":
- `status`가 `EMBARGO_DISTRIBUTABLE_STATUSES`(DES·EPS·DPS)에 없으면 무조건 `[]`.
  **CRITICAL**: RDS·RRH·RRK·DDH·DDK(미송고·보류·킬)와 EEK(엠바고 킬)·EEH(엠바고 보류)·DPD(삭제 승인)는 전부 제외다.
  이유: 데스크가 송고하지 않은 기사나 킬/보류/삭제된 기사가 외부 수신처로 나가면 회수 수단이 없다.
- `'press'`: `contents.embargoAt`이 truthy && 파싱 가능 && `파싱값 <= now` && `distributed`에 `'press'` 없음
- `'nonpress'`: `contents.secondEmbargoAt`이 truthy && 파싱 가능 && `파싱값 <= now` && `distributed`에 `'nonpress'` 없음
- **`now` 인자의 타입은 ISO-8601 UTC 문자열로 고정한다(숫자 epoch ms 허용 금지).**
  이유: `now`는 step3(`now = () => new Date().toISOString()`)과 step4(부트스트랩·가짜 시계 주입)를 가로지르는 **크로스-step 계약**이다.
  숫자로 통일하면 `Date.parse(1700000000000)`이 `NaN`이 되어 모든 기사가 조용히 "미도래"로 떨어지고 **엠바고가 영원히 배부되지 않는 무음 실패**가 된다.
  `docs/SCHEMA.md:48`의 저장 규약("시간 컬럼은 ISO-8601 UTC 문자열")과도 같은 타입이다.
- 시각 비교는 `Date.parse`로 epoch ms를 얻어 비교한다(`now`도 동일하게 파싱). JSDoc/주석에 `@param {string} now ISO-8601 UTC`를 명시하라.
- `now`가 파싱 불가(숫자·`undefined`·쓰레기 문자열)면 `dueKinds`는 `[]`를 반환한다(안전 기본값 — 잘못된 시계로 조기 배부 금지).
- **파싱 불가 값(사용자가 자유 입력한 잘못된 문자열)은 "미도래"로 취급해 배부하지 않는다**(안전 기본값).
  이유: 엠바고 시간 입력란은 자유 텍스트 input이다(`web/src/view/WriterPage.jsx:1914`) — 파싱 실패를 "즉시 배부"로 해석하면 엠바고가 깨진다.
  대신 `unparsableEmbargoFields()`로 그 사실을 호출자가 표면화할 수 있게 한다(무음 삼킴 금지).

**embargoStatusFor({ status, contents, distributed })** — "배부 이력이 이러할 때 상태는 무엇이어야 하는가". 변경 필요가 없으면 `null`:
- `requiredKinds(contents).length === 0`(엠바고 미설정) → `null`
- 현재 `status`가 `'DES'`도 `'EPS'`도 아니면 → `null`
  **CRITICAL**: DPS(레거시·완결)·EEK·EEH·DPD·RDS 등은 절대 건드리지 않는다. 상태 역행/부활 금지.
- `requiredKinds ⊆ distributed`(완결) → `'DPS'`
- 아니고 `distributed`에 1건 이상 있으면 → `'EPS'` (첫 배부 실행 = DES→EPS)
- 아니면 → `'DES'`
- 계산 결과가 현재 `status`와 같으면 `null`을 반환한다(무의미한 쓰기 금지).
- **역행 금지**: 현재 `'EPS'`인데 계산이 `'DES'`면 `null`을 반환한다(이력 유실·부분 실패로 뒤로 가지 않는다).

**범위 밖 명시(설계상 의도된 공백)**: 엠바고 관리에서 `embargoAt`·`secondEmbargoAt`를 **모두 지운** DES/EPS 기사는
`requiredKinds`가 `[]`이므로 `embargoStatusFor`가 `null`이 되고 tick 후보에서도 빠진다 → 대기 상태에 남는다.
이것은 **phase 48의 범위 밖**이며 운영 액션(KILL→EEK / 보류→EEH, D·Z)으로 처리한다. 레거시 EPS 행도 동일한 성질이라 새로 생기는 회귀가 아니다.
이 공백을 메우려고 "엠바고가 사라지면 DPS로 승격" 같은 규칙을 **발명하지 마라** — 배부되지 않은 기사를 배부 완결로 만드는 결과가 된다.

### 3) 시나리오 표 (테스트로 그대로 잠글 것)

| 엠바고 | required | 사건 | distributed | embargoStatusFor(현재 DES) | 근거 |
|---|---|---|---|---|---|
| 1차만 | `['press']` | 송고 직후 | `[]` | `null`(DES 유지) | 1차 시각 전엔 배부 없음 |
| 1차만 | `['press']` | 1차 tick 배부 | `['press']` | `'DPS'` | 완결(1차만=1차 배부 후) |
| 2차만 | `['nonpress']` | 송고 즉시 press | `['press']` | `'EPS'` | 첫 배부 실행 → EPS |
| 2차만 | `['nonpress']` | 2차 tick 배부 | `['press','nonpress']` | `'DPS'` | 완결(2차만=2차 배부 후) |
| 1+2차 | `['press','nonpress']` | 1차 tick 배부 | `['press']` | `'EPS'` | 첫 배부, 미완결 |
| 1+2차 | `['press','nonpress']` | 2차 tick 배부 | `['press','nonpress']` | `'DPS'` | 완결 |

- **1차만 기사가 DES에서 곧장 DPS로 가는 것은 의도된 결과다**(같은 배부가 "첫 배부"이자 "완결"이므로 완결이 이긴다 — 사용자 확정 스펙 A.3).
  중간에 EPS를 억지로 한 번 거치게 만들지 마라(쓰기 2회·이력 2행은 근거 없는 발명).

### 4) 테스트 (`test/embargoPolicy.test.js`, node:test)

최소한 다음을 잠근다:
- `requiredKinds`: 1차만/2차만/1+2차/미설정 4행 + 빈 문자열·null은 미설정 취급.
- `distributedKinds`: `eventType='status'`(송고 이력)·`eventType='edit'` 행은 무시, `distribute` 행의 `action`만 수집, 중복 제거.
- `dueKinds`: 위 시나리오 표의 각 시점 + **도래 전(now < embargoAt)은 `[]`** + **이미 배부된 kind는 재배부 없음(멱등)** +
  제외 상태 8종(`RDS`,`RRH`,`RRK`,`DDH`,`DDK`,`EEK`,`EEH`,`DPD`) 각각에 대해 `[]`.
- `dueKinds`: `embargoAt`이 `'내일 오전'` 같은 파싱 불가 문자열이면 `[]`, `unparsableEmbargoFields`가 `['embargoAt']`을 돌려준다.
- `dueKinds`: **`now`가 ISO 문자열이 아닐 때(`Date.now()` 같은 숫자, `undefined`, 쓰레기 문자열) `[]`** — 도래한 엠바고가 있어도 배부하지 않는다.
  이 케이스는 크로스-step 계약 위반을 조기에 잡는 가드다. 케이스 이름에 "now는 ISO-8601 UTC 문자열이어야 한다"를 남겨 실패 시 원인이 즉시 보이게 하라.
- `embargoStatusFor`: 위 표 6행 + 현재 status가 DPS/EEK/EEH/DPD/RDS일 때 전부 `null` + EPS에서 DES로 역행하지 않음.
- 순수성: 인자로 넘긴 객체/배열을 변형하지 않는다(호출 전후 `deepEqual`).

## Acceptance Criteria

```bash
node --test test/embargoPolicy.test.js
npm test
npm run lint
```

- 신규 테스트 전부 green.
- `npm test` 기준선: **총 527 / pass 523 / fail 4**. 이 4건은 phase 47 머지본의 **기존 실패**(Windows 경로 구분자 `\` vs `/` 단언)이며 phase 48 범위 밖이다:
  1. `createControllers: DIST_SPOOL_DIR 설정 시 송고가 활성 수신처 스풀에 배부된다` (`test/controllers.test.js`)
  2. `레거시 행의 잘못된 spoolDir는 실제 writer가 거부해 failed로 격리된다(경로 조작 방어)` (`test/distributionService.test.js:265`)
  3. `spoolWriter: 수신처 폴더를 recursive mkdir 후 임시 파일에 쓰고 rename으로 게시한다` (`test/spoolWriter.test.js`)
  4. `spoolWriter: 파일명은 <articleId>_<timestamp>.json 이며 재배부해도 덮어쓰지 않는다` (`test/spoolWriter.test.js`)
  → **합격 조건은 "fail이 위 4건 그대로, 신규 실패 0, pass는 신규 테스트 수만큼 증가"** 이다.
- `npm run lint` clean.
- web 무접촉이므로 `npm run test:web`/`npm run build`는 이 step의 AC가 아니다.

## 검증 절차

1. 구현 전에 테스트를 돌려 red를 확인한다(모듈 부재 에러).
2. 구현 후 `node --test test/embargoPolicy.test.js` green.
3. `npm test` 실행 후 **fail 목록이 위 4건과 정확히 일치**하는지 이름으로 대조한다(신규 실패 0).
4. `git diff --stat`이 `src/services/embargoPolicy.js` + `test/embargoPolicy.test.js` **2개 파일뿐**인지 확인한다.
5. 금지 API 부재를 grep으로 확인: `setTimeout|setInterval|fetch|node:fs|node:sqlite|prepare\(` → `src/services/embargoPolicy.js`에서 0건.

## 금지사항

- DB·모델·HTTP·파일시스템을 이 모듈에서 건드리지 마라. 이유: 이 모듈의 존재 이유가 "시계·저장소 없이 결정적으로 테스트되는 판정"이다. 조회는 호출자(step3)가 한다.
- `setInterval`/`setTimeout`/자체 스케줄러를 만들지 마라. 이유: ADR-008 (3) — 시점 실행은 외부 cron의 tick pull이며 앱에 타이머를 두지 않는다.
- `new Date()`를 모듈 안에서 호출하지 마라(`now`는 항상 인자). 이유: 가짜 시계로 도래/미도래 경계를 테스트할 수 없게 된다.
- 파싱 불가 엠바고 값을 "지금 도래"로 해석하지 마라. 이유: 엠바고 시각 입력은 자유 텍스트라 오타 하나가 즉시 유출로 이어진다.
- `embargoStatusFor`에서 DPS·EEK·EEH·DPD 상태를 다른 값으로 계산하지 마라. 이유: 킬/보류/삭제 기사의 부활과 완결 기사의 역행은 DB 무결성 훼손이다.
- 기존 파일(`lifecycle.js`·`articleService.js`·`distributionService.js`)을 이 step에서 수정하지 마라. 이유: 결선은 step2·step3의 책임이며, 여기서 손대면 실패 원인 격리가 불가능해진다.
- news.md·ADR.md를 수정하지 마라. 이유: 스펙 문서는 사용자 소유이며 phase 48 착수 전 커밋(ab3cbef)으로 확정됐다.
