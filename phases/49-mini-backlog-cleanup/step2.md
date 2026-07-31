# Step 2: distribute-status-guard

## 목표

**배부 실행 중 기사가 KILL/보류/삭제로 전이되면 남은 수신처 쓰기를 중단한다.**

`distributionService.distribute()`는 시작 시 기사 행을 **한 번** 읽고(`articleModel.getById`), 그 스냅샷으로 활성 수신처 전부에 순차 `await spoolWriter.write(...)`를 돈다. 수신처가 2곳 이상이면 첫 쓰기의 `await` 동안 데스크가 KILL(EEK)·보류(EEH)·삭제승인(DPD)을 눌러도 **나머지 수신처로는 그대로 나간다**. 외부로 나간 기사는 회수 수단이 없다.

`distributionTickService`는 이미 배부 지시 **직전**에 최신 행을 재조회해 상태를 재검증한다(phase 48). 그러나 그 방어는 `distribute()` **호출 전 1회**뿐이라 **수신처 사이의 창**은 막지 못한다. 이 step이 그 마지막 창을 닫는다.

이 step은 **`src/services/distributionService.js` 한 모듈만** 수정한다(+ 테스트, + `embargoPolicy.js`의 **주석 1곳**). articleService·tick·spoolWriter·라우트 무접촉.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`([배부] 흐름), `docs/ADR.md` **ADR-008**(앱은 스풀에 쓰기만 — egress·타이머 없음), `docs/SCHEMA.md`(Contents.status/distributedAt).
- `src/services/distributionService.js` — **전체**. 구조:
  - 상단 주석의 "책임이 아닌 것" 목록(L9~12) — 시점 판정·kind 판정·상태 전이는 여기 책임이 아니다. **이 step이 추가하는 것은 "전이"가 아니라 "안전 중단(abort) 가드"다.** 주석을 그에 맞게 정확히 갱신하라.
  - `distribute(articleId, { kinds, actorUserId })`(L41~99): `wanted` 필터 → `articleModel.getById`(L48) → kind 루프(L54) → 활성 target 루프(L59~82) → kind별 이력 기록(L86~88) → `distributedAt` 갱신(L94~96).
- `src/services/embargoPolicy.js` — `EMBARGO_DISTRIBUTABLE_STATUSES = Object.freeze(['DES','EPS','DPS'])`(L16)와 그 위 주석(L13~15, 현재 "**엠바고 tick이** 배부를 허용하는 상태"로 tick 전용처럼 읽힌다). **이 상수가 배부 가능 상태의 단일 출처다** — 이 step에서 소비자가 하나 늘어나므로 주석을 갱신한다(§3).
- `src/services/distributionTickService.js` — L145~159의 TOCTOU 재검증 블록과 `STATUS_CHANGED = 'status-changed'` 토큰(L28). **같은 사유 토큰을 재사용**해 운영 요약의 어휘를 통일한다. (이 파일은 수정하지 마라.)
- `src/services/articleService.js` — 송고 훅(L185~205)이 `distribute`를 fire-and-forget으로 부르고, `res.distributed`의 성공 kind로만 승격한다(L194~201). 가드가 켜져도 이 계약이 유지돼야 한다.
- `test/distributionService.test.js` — **전체**. `fakeWriter()`, in-memory SQLite + 실제 `articleModel`/`distributionTargetModel`/`historyModel`, `contentsOf(db)`/`historyOf(db)` 헬퍼가 있다. 이 step의 테스트가 들어갈 파일이다.

## 배경 (자기완결)

호출 경로는 둘뿐이다.

1. **송고 훅**(`articleService.applyAction`) — 상태를 DPS 또는 DES로 쓴 **직후** 호출한다. 둘 다 `EMBARGO_DISTRIBUTABLE_STATUSES` 안에 있다.
2. **tick**(`distributionTickService.run`) — 후보를 DES/EPS/DPS로 한정하고 배부 직전 재검증한 뒤 호출한다.

따라서 "쓰기 직전 최신 status가 `['DES','EPS','DPS']` 밖이면 중단"이라는 가드는 **두 정상 경로를 절대 막지 않으면서** KILL/보류/삭제 레이스만 차단한다.

## 작업

### 1) 쓰기 루프 안 상태 재확인

`distribute()`의 **수신처 루프 안, `spoolWriter.write` 호출 직전**에 최신 행을 재조회해 상태를 검사한다.

```js
import { EMBARGO_DISTRIBUTABLE_STATUSES } from './embargoPolicy.js';
...
for (const t of targets) {
  // TOCTOU 가드: 앞 수신처의 await 동안 KILL(EEK)·보류(EEH)·삭제(DPD)로 전이됐을 수 있다.
  // 한 번 나간 기사는 회수 수단이 없으므로 매 쓰기 직전 최신 status를 확인한다.
  const cur = articleModel.getById(articleId);
  if (!cur?.contents || !EMBARGO_DISTRIBUTABLE_STATUSES.includes(cur.contents.status)) { ...중단... }
  ...
}
```

규칙:

- **페이로드는 최초 스냅샷(`row`)을 계속 쓴다.** 재조회 결과는 **status 판정에만** 사용한다. 이유: 한 배부 배치는 같은 본문을 내보내야 한다(수신처마다 다른 내용이 나가면 정정 추적이 불가능하다).
- 가드에 걸리면 **남은 수신처와 남은 kind 전부를 중단**한다(그 kind만 건너뛰고 다음 kind를 계속하지 않는다). 이유: 상태가 배부 불가로 바뀐 기사는 어떤 kind로도 나가면 안 된다.
- **무음 삼킴 금지 — 중단된 것은 두 종류 전부 `failed`에 남긴다**:
  1. **처리 못 한 수신처**(현재 kind에 남아 있던 target들): `{ articleId, targetId: t.id, kind, spoolDir: t.spoolDir, reason: 'status-changed' }` — 기존 `failed` 항목 shape 그대로.
  2. **아예 시작도 못 한 kind**(중단 시점 이후의 `wanted` 원소): `{ articleId, targetId: null, kind, reason: 'status-changed' }`.
  - 2번을 빠뜨리면 **tick이 그 kind를 `no-active-target`으로 오보한다**: tick은 `res.distributed ∪ res.failed`에 등장한 kind 집합(`touched`)을 만들고, due kind가 거기 없으면 "활성 수신처 0곳"으로 단정한다(`distributionTickService.js` L182~193). 실제로는 수신처가 있는데 상태 변경으로 중단된 것이므로 운영자가 원인을 잘못 읽는다.
  - 두 종류 모두 `notifyFailure(...)`로도 표면화한다(미발송은 운영자가 알아야 한다 — 기존 정책).
  - 새 상태값(EEK/EEH/DPD 등)은 담지 마라(요약 어휘 최소화 — tick이 이 값을 화이트리스트 투영해 HTTP 응답으로 내보낸다).
- **이미 성공한 쓰기는 사실이다**: 중단 전에 성공한 수신처의 `distributed` 항목·kind별 `distribute` 이력·`distributedAt` 갱신은 **그대로 남긴다**(append-only 사실 기록 — 되돌리면 tick의 멱등 근거가 깨진다).
- 반환 shape은 불변: `{ ok:true, distributed:[...], failed:[...] }`. `{ ok:false, reason }`으로 바꾸지 마라(호출자가 `ok!==true`를 "배부 자체가 성립하지 않음"으로 해석한다).
- 최초 `articleModel.getById`(L48)와 `not-found` 반환은 그대로 둔다.

### 2) 비용/트레이드오프 주석

수신처 수만큼 `getById` 읽기가 늘어난다(N+1). in-process SQLite 단건 조회라 비용이 작고, 유출 대비 가치가 크다는 판단을 함수 주석에 한 줄로 남겨라.

### 3) 주석 갱신 (2곳, 코드 무변경)

- `distributionService.js` 상단 "책임이 아닌 것" 목록에 오해가 없도록, 이 가드는 **상태 전이가 아니라 배부 안전 중단**임을 한 줄로 명시한다(상태를 쓰지 않는다 — 읽기만 한다).
- `embargoPolicy.js` L13~15의 `EMBARGO_DISTRIBUTABLE_STATUSES` 주석을 **"엠바고 tick이 배부를 허용하는 상태" → "배부 가능 상태 — 송고 훅·tick·배부 실행(distributionService)이 공유하는 단일 출처"** 로 갱신한다. 이유: 이 step에서 소비자가 tick 외에 하나 더 늘었는데 주석이 tick 전용처럼 읽히면 다음 독자가 이 상수를 tick 스캔 필터로 오해해 임의 변경한다. **상수 값·순서·freeze는 절대 건드리지 마라**(주석 줄만 수정).

## TDD — 테스트 먼저

`test/distributionService.test.js`에 red→green으로 추가한다. 레이스는 **주입된 `spoolWriter`의 write 안에서 DB를 갱신**해 결정적으로 재현한다(타이머·랜덤 금지).

1. **수신처 사이 KILL 차단(핵심)**: 같은 kind에 활성 target 2곳. 가짜 writer의 첫 호출에서 `articleModel.update(articleId, { contents: { status: 'EEK' } })`를 수행 → `distribute(articleId,{kinds:['press']})` 결과가
   - `distributed.length === 1`(첫 수신처만),
   - `failed`에 두 번째 수신처가 `reason:'status-changed'`로 담기고,
   - writer 호출 횟수가 **정확히 1회**.
2. **kind 사이 차단**: press 1곳·nonpress 1곳 활성. press 쓰기 중 상태를 `DPD`로 바꾸면 nonpress 쓰기는 일어나지 않고 `nonpress` 이력도 생기지 않는다. **추가 단언**: `failed`에 `{ articleId, targetId: null, kind: 'nonpress', reason: 'status-changed' }`가 정확히 1건 들어 있다(= tick의 `no-active-target` 오보 방지 — 이 단언이 med 등급 지적의 회귀 가드다).
3. **사실 보존**: 케이스 1에서 `Contents.distributedAt`이 갱신되고 `press` distribute 이력이 1건 남는다(성공한 쓰기는 되돌리지 않는다).
4. **정상 경로 무영향**: 상태 DPS/DES/EPS에서 수신처 3곳 배부가 전부 성공하고 writer가 3회 호출된다(회귀 가드).
5. **onFailure 표면화**: 중단으로 건너뛴 수신처가 `onFailure` 콜백으로도 보고된다.
6. **기존 케이스 전부 green**(활성 필터·부분 실패 격리·distributedAt 갱신·레거시 spoolDir 거부 등).
7. (권장·선택) `test/distributionTickService.test.js`에 통합 가드 1건: 실제 `distributionService`를 주입한 tick 실행에서 kind 사이 중단이 일어나면 요약의 해당 kind 사유가 `no-active-target`이 **아니라** `status-changed`로 보고된다. 배선 비용이 크면 생략해도 되지만, 생략 시 그 근거를 step 요약에 남겨라.

## Acceptance Criteria

```bash
node --test test/distributionService.test.js test/articleSendDistribution.test.js test/distributionTickService.test.js test/distribution-tick-api.test.js test/controllers.test.js
npm test          # fail 0 (step0 기준선 유지)
npm run lint
```

`git diff --name-only`에 `web/`·`server/`가 없어야 한다. 예상 변경: `src/services/distributionService.js`(코드) + `src/services/embargoPolicy.js`(**주석만** — `git diff`로 코드 줄 변경 0을 확인하라) + 테스트 파일.

## 검증 절차

1. 위 AC 커맨드 실행 — `npm test` **fail 0**.
2. 변이 검증: 가드 조건을 제거하면 케이스 1·2가 red가 되는지 확인한다.
3. 아키텍처 체크리스트:
   - 상태 allowlist는 `embargoPolicy.EMBARGO_DISTRIBUTABLE_STATUSES` 단일 출처를 import했는가?(문자열 배열을 이 파일에 새로 정의하지 않았는가)
   - `distributionService`가 status를 **쓰지** 않는가?(읽기 전용 — 전이는 lifecycle/articleService의 단일 책임)
   - DB 비파괴: 행 삭제·이력 삭제 0건인가?
   - ADR-008: 타이머·egress 0건인가?
4. `phases/49-mini-backlog-cleanup/index.json`의 step2를 갱신한다(`completed` + `summary` / `error` + `error_message` / `blocked` + `blocked_reason`).

## 금지사항

- 재조회한 최신 행(`cur`)의 본문·메타로 **페이로드를 교체하지 마라**. 이유: 한 배부 배치 안에서 수신처마다 다른 내용이 나가면 무엇이 배부됐는지 추적할 수 없다. 재조회는 status 판정 전용이다.
- 이미 성공한 쓰기의 `distributed` 항목·`distribute` 이력·`distributedAt`을 되돌리거나 지우지 마라. 이유: 스풀 파일은 이미 나갔다 — 사실을 지우면 tick의 멱등 근거(append-only 이력)가 깨져 재배부가 발생한다. 그리고 DB 행 삭제는 프로젝트 최상위 금지사항이다.
- `distributionService`에서 status를 쓰거나(`articleModel.update({contents:{status}})`) 전이 판정을 하지 마라. 이유: 생애주기 단일 출처는 lifecycle/articleService다(규칙이 두 곳으로 갈라지면 DES/EPS/DPS 판정이 발산한다).
- 상태 allowlist를 이 파일에 문자열로 복제하지 마라. 이유: `EMBARGO_DISTRIBUTABLE_STATUSES`가 단일 출처다 — 복제하면 상태가 추가될 때 한쪽만 갱신돼 유출/미배부가 생긴다.
- 새 사유 토큰을 만들지 마라(`'status-changed'` 재사용). 이유: tick이 실패 항목을 HTTP 응답으로 투영하므로 어휘가 갈라지면 운영 cron 파서가 깨진다.
- 병렬 쓰기(`Promise.all`)로 바꾸지 마라. 이유: 순차 처리는 tick·테스트의 결정성 전제이며, 병렬화하면 이 가드 자체가 무의미해진다.
- 기존 테스트를 깨뜨리지 마라(기준: 백엔드 620/620 green, lint clean).
