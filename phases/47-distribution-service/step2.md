# Step 2: send-hook

송고(`send`) 성공 시점에 **즉시 배부**를 트리거하는 훅을 `articleService.applyAction`에 붙인다.
"언제 어떤 kind로 배부하는가"의 판정(엠바고 규칙)이 이 step의 핵심이며, 실제 실행은 step1의 `distributionService.distribute`에 위임한다.

## 읽어야 할 파일

- `docs/news.md` — **"엠바고 규칙" 절 전문**(아래 판정표의 유일한 근거) + "기사 생애주기" 절.
- `docs/ADR.md` — ADR-008 (3)(4)(5).
- `src/services/articleService.js` — `applyAction`의 현재 흐름(transition → `(끝)` 마커 검증 → RDS+D/Z+send+엠바고 → EPS 후처리 → `articleModel.update` → `record()` 이력).
- `src/services/lifecycle.js` — 전이표(EPS는 `send` 미정의, DPS는 재송고 DPS 유지, R의 RDS→send는 RDS 유지).
- `src/services/distributionService.js` — **step1에서 생성**.
- `test/articleService*.test.js` / `test/lifecycle.test.js` — 기존 송고 테스트 관례.

## 판정표 (news.md 엠바고 규칙 + ADR-008 (4)에서 그대로 도출 — 임의 확장 금지)

`applyAction`의 `action==='send'`가 **성공**한 직후에만 평가한다.

| 송고 후 status | `embargoAt` | `secondEmbargoAt` | 즉시 배부 kinds | 근거 |
|---|---|---|---|---|
| `DPS` | 없음 | 없음 | `['press','nonpress']` | ADR-008 (4) 엠바고 없는 기사는 송고 즉시 전체 배부 |
| `EPS` | 없음 | 있음 | `['press']` | news.md "2차 엠바고 시간에는 비언론사에 배부하는데, **송고시 바로 언론사에 배부**한다" |
| `EPS` | 있음 | 없음/있음 | 없음(즉시 배부 0) | 1차·1+2차는 1차 엠바고 **시각**에 언론사 배부 → tick(phase 48) |
| `RDS`(R 권한 송고) | — | — | 없음 | 데스크 미송고 상태 유지 = 아직 배부 대상 아님 |
| 그 외(hold/kill/approveDelete) | — | — | 없음 | 배부 트리거는 송고뿐 |

- `DPS` 재송고(DPS→DPS)와 `DDH`→`DPS` 송고도 위 첫 행에 해당한다(status가 DPS면 배부).
  근거: ADR-008 (4)는 "송고 즉시 배부"를 조건 없이 규정하며, 고침/포털고침 후 재송고는 수신처가 갱신본을 받아야 한다.
  스풀 파일은 타임스탬프 파일명이라 이전 배부본을 덮어쓰지 않는다(step0).
- 판정은 **DB에 반영된 최종 status**와 **DB의 엠바고 컬럼 값**으로 한다. 클라이언트가 보낸 값은 쓰지 않는다(ADR-004).
- 엠바고 "설정됨"의 판정은 기존 EPS 후처리와 동일하게 **truthy**(빈 문자열/null은 미설정)로 통일한다.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `test/articleSendDistribution.test.js` (신규, node:test)

가짜 `distributionService`(호출 인자 기록)를 주입해 판정표 각 행을 잠근다:

- 엠바고 없는 RDS 기사를 D가 송고 → status `DPS`, `distribute(articleId, { kinds:['press','nonpress'], actorUserId })` 1회 호출.
- 2차 엠바고만 설정된 RDS 기사를 D가 송고 → status `EPS`, `kinds:['press']` 1회 호출.
- 1차 엠바고만 / 1+2차 설정 기사를 D가 송고 → status `EPS`, **`distribute` 미호출**.
- R이 RDS 기사를 송고 → status `RDS`, **미호출**.
- `hold`/`kill`/`approveDelete` → **미호출**.
- `(끝)` 마커 없어 거부된 송고 → **미호출**(거부 경로에서 배부되면 안 된다).
- 전이 거부(예: EPS에 send) → **미호출**.
- DPS 재송고 → `kinds:['press','nonpress']` 호출.
- **배부 실패 격리**: `distribute`가 reject하거나 `{ok:false}`를 반환해도 `applyAction`은 `{ ok:true, status }`를 반환하고 status 전이·이력은 그대로 유지된다.
- `distributionService` **미주입**이면 기존 동작과 완전히 동일하다(하위호환 — 기존 테스트 무회귀의 근거).

### 2) `src/services/articleService.js` 수정

- `createArticleService({ articleModel, db, historyModel, distributionService })` — **선택 의존성**으로 추가(미주입 시 훅 비활성).
- `applyAction`은 **동기 반환 계약을 유지한다**. 배부는 부수효과이므로 호출 결과를 기다려 반환값을 바꾸지 않는다.
  `record()`와 같은 격리 패턴을 쓴다: try/catch + Promise rejection 삼킴(`.catch(() => {})`).
  이유: `applyAction`을 `await` 없이 호출하는 기존 라우트/테스트가 그대로 동작해야 한다.
- 판정 로직은 작은 순수 헬퍼(예: `distributionKindsForSend(status, contents)`)로 분리해 테스트 가능하게 둔다.

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 신규 테스트 green, 기존 백엔드 테스트 **무회귀**(기존 `applyAction` 테스트가 한 건도 깨지지 않아야 한다).

## 검증 절차

1. 신규 테스트 red 확인 후 구현 → green.
2. 기존 `test/articleService*.test.js`·`test/api*.test.js` 계열이 전부 통과하는지 확인(반환 계약 유지 증거).
3. `git diff --stat`이 `src/services/articleService.js` + 신규 테스트 파일뿐인지 확인.

## 금지사항

- `applyAction`을 `async`로 바꿔 반환 계약을 바꾸지 마라. 이유: 라우트(`/api/articles/:id/action`)와 다수 기존 테스트가 동기 반환을 전제한다 — 조용한 회귀가 광범위하게 생긴다.
- 배부 실패를 송고 실패로 전환하지 마라. 이유: 스풀 쓰기 실패로 기사 상태 전이가 막히면 편집자가 복구할 수단이 없다(ADR-008: 앱은 발송 결과를 알지 못한다).
- 판정표에 없는 상태/조건을 발명하지 마라(예: 문서에 없는 새 status, "1차만 있으면 송고 시 비언론사 배부" 같은 추정). 이유: news.md 엠바고 규칙이 유일한 실질 스펙이다.
- 엠바고 시각과 현재 시각을 비교해 즉시 배부 여부를 정하지 마라. 이유: 시점 판정은 tick(phase 48) 책임이다.
- `lifecycle.js` 전이표를 수정하지 마라. 이유: 이 phase는 배부만 추가하며 생애주기 전이는 무변경이다.
