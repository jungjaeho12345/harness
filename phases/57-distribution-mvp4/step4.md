# Step 4: retry-wiring

## 목표

배부 실패 조회·재전송에 **Z 전용 인가 게이트**를 붙이고, 합성 루트(`createControllers`)에 서비스를 결선한다.

- `src/services/authorization.js` — capability `manageDistributionFailure: ['Z']` + 게이트 함수 1개(additive).
- `src/controllers/index.js` — `distributionRetryService` 결선 + `controllers.distribution.failures` / `controllers.distribution.retry` 진입점.

HTTP 라우트는 step5 소관이다.

## 읽어야 할 파일

- `docs/ADR.md` **ADR-004**(acting role은 검증된 `x-session-id` 세션에서만 도출, `req.body.role` 불신)·ADR-006·**ADR-008 (3)**. **읽기 전용(무접촉)**.
- `src/services/authorization.js` 전체(83줄) — L6~12 `CAPABILITIES`, L19~24 `assertAuthorized`, L68~77 `runDistributionTick`(세션에서 `userId`까지 돌려주는 선례 — 이력 `actorUserId` stamp에 필요).
- `src/controllers/index.js` 전체(214줄) — 특히 L60~61 세션 가드(**원본이 아니라 가드를 쓴다**), L63~68 `historyErrorLogger`, L70~94 스풀/배부 서비스 조건부 결선(`env.DIST_SPOOL_DIR`), L110~124 tick 서비스 결선, L187~198 `distribution.tick`(**인가를 먼저 통과시키고 그 다음 서비스 가용성 판정** — 설정 상태 노출 최소화).
- `src/services/distributionRetryService.js`(step3) — `list`/`retry` 시그니처와 거부 사유 토큰.
- `test/authorization.test.js` — 게이트 테스트 스타일(가짜 sessionService 주입).
- `test/controllers.test.js` — 컨트롤러 결선 테스트 스타일(in-memory db + `createControllers`).

## 배경 (자기완결)

`controllers.distribution.tick`이 이미 확립한 규율을 그대로 따른다.

```js
async tick(sessionId) {
  const gate = authorization.runDistributionTick(sessionId);
  if (!gate.ok) return gate;                       // 인가 먼저
  if (!distributionTickService) return { ok:false, reason:'spool-disabled' };
  return distributionTickService.run({ actorUserId: gate.userId ?? null });
}
```

핵심 두 가지:

1. **인가가 먼저**다 — 비-Z/미인증에는 스풀 설정 여부조차 알려주지 않는다.
2. `actorUserId`는 **검증된 세션**(`gate.userId`)에서만 온다 — 클라이언트 값은 절대 쓰지 않는다.

`distributionRetryService`는 `spoolWriter`가 없어도 `list`가 동작해야 하므로(과거 실패 조회는 스풀 설정과 무관) **항상 결선**하고, `spoolWriter`는 있으면 넘긴다(없으면 `retry`가 스스로 `spool-disabled`를 돌려준다 — step3 계약).

## TDD — 테스트 먼저

### `test/authorization.test.js` 추가

1. Z 세션 → `manageDistributionFailure(sid)`가 `{ ok:true, role:'Z', userId }`를 준다(`userId`가 세션 값과 같다).
2. R·D 세션 → `{ ok:false, reason:'forbidden' }`.
3. 미인증(없는 sid) → `{ ok:false, reason:'unauthenticated' }`이고 role은 응답에 없다.
4. 게이트는 `touchSession`을 쓴다(일반 REST 경로의 슬라이딩 갱신 계약 — 기존 게이트들과 동형. 스파이로 확인).
5. `assertAuthorized(role, 'manageDistributionFailure')`가 Z만 허용한다.

### `test/controllers.test.js` 추가

6. `controllers.distribution.failures(sid)`: Z 세션이면 `{ ok:true, items:[…] }`(실패 이력을 시드한 뒤 확인).
7. 비-Z 세션이면 `{ ok:false, reason:'forbidden' }`이고 **서비스가 호출되지 않는다**(스파이 0회 — 인가 우선).
8. 미인증이면 `unauthenticated`.
9. `controllers.distribution.retry(sid, { articleId, targetId })`: Z 세션이면 서비스에 위임되고 `actorUserId`가 **세션 userId**로 채워진다(스파이 인자 확인).
10. `retry` 인자에 `actorUserId`/`role`/`kind`를 클라이언트가 실어 보내도 **무시**된다(서비스에 전달되는 값은 세션 파생 값뿐 — ADR-004 잠금).
11. 스풀 미설정(`env.DIST_SPOOL_DIR` 없음) 환경: `failures`는 정상 동작(`ok:true`)하고 `retry`는 `{ ok:false, reason:'spool-disabled' }`다.
12. 비-Z가 `retry`를 호출하면 스풀 설정 여부와 무관하게 `forbidden`이다(설정 상태 비노출 — 인가가 먼저).
13. 회귀: `controllers.distribution.tick`의 기존 동작(게이트·spool-disabled·actorUserId)이 그대로다(기존 케이스 무수정 green).

## 작업

### `src/services/authorization.js`

1. `CAPABILITIES`에 한 줄 추가:

```js
manageDistributionFailure: ['Z'], // 배부 실패 조회·재전송 — Z 전용 (ADR-008, MVP-4)
```

2. 게이트 함수 추가 후 반환 객체에 노출한다(`runDistributionTick`과 동형 — `userId`까지 반환).

```js
// Z 전용 게이트 — 배부 실패 조회/재전송. userId를 함께 돌려주는 이유:
// 재전송 이력의 actorUserId로 stamp해야 감사 추적이 끊기지 않는다.
function manageDistributionFailure(sessionId) {} // → { ok:true, role, userId } | { ok:false, reason }
```

기존 게이트·`assertAuthorized`·`CAPABILITIES` 다른 항목은 변경 금지.

### `src/controllers/index.js`

3. `createDistributionRetryService`를 import하고 결선한다(모델 3종 + 선택 `spoolWriter` + `now` + 로그 콜백).

```js
// 배부 실패 조회·재전송(ADR-008 MVP-4). 조회는 스풀 설정과 무관하므로 **항상** 결선한다.
// spoolWriter가 없으면 retry가 스스로 spool-disabled를 반환한다(설정 판정 단일 지점).
const distributionRetryService = createDistributionRetryService({
  articleHistoryModel, distributionTargetModel, articleModel, spoolWriter, now,
  onFailure: ({ articleId, targetId, kind, reason }) => {
    logService?.warn?.(`distribution retry failed articleId=${articleId} targetId=${targetId} kind=${kind} reason=${reason}`);
  },
  onHistoryError: historyErrorLogger,
});
```

4. `distribution` 객체에 진입점 2개를 추가한다(`tick`은 그대로).

```js
failures(sessionId, filters) {}  // 게이트 → distributionRetryService.list({ limit })
retry(sessionId, payload) {}     // 게이트 → distributionRetryService.retry({ articleId, targetId, actorUserId: gate.userId ?? null })
```

규칙:

1. 인가를 **먼저** 통과시킨다(서비스 가용성·존재 판정보다 앞).
2. 컨트롤러에서 도메인 규칙(미해소 판정·상태 allowlist·투영)을 재구현하지 마라 — 서비스 위임만(ADR-006).
3. `payload`에서 **`articleId`·`targetId`만** 뽑아 서비스에 넘긴다(통짜 스프레드 금지 — `actorUserId`/`kind` 주입 경로가 열린다).
4. 기존 결선(`spoolWriter`·`distributionService`·`distributionTickService`·`articleService`)은 변경 금지.
5. 새 로그 문자열에는 식별자·고정 사유만 담는다(본문·세션 토큰·경로 금지 — LOGS.md 마스킹 규율).

## Acceptance Criteria

```bash
npm test          # 실패 0 — step3 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `src/services/authorization.js`, `src/controllers/index.js`, `test/authorization.test.js`, `test/controllers.test.js` **4개뿐**.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 3종(확인 후 원복):
   - `manageDistributionFailure`의 허용 역할에 `'D'`를 추가하면 케이스 2가 red.
   - `retry`에서 `actorUserId: payload.actorUserId`로 바꾸면 케이스 10이 red.
   - 게이트 호출을 서비스 호출 뒤로 옮기면 케이스 7이 red(서비스 스파이 호출 0회 단언).
3. 아키텍처 체크리스트:
   - 게이트가 세션 가드(`session`, 원본 `rawSession` 아님) 경유인가?
   - 컨트롤러에 SQL·판정 분기가 없는가?
   - `distribution.tick` 기존 경로가 그대로인가?
4. `phases/57-distribution-mvp4/index.json`의 step4를 `completed` + `summary`로 갱신한다. summary에 새 capability 이름·게이트 반환 shape·컨트롤러 진입점 시그니처·결선 조건(항상 생성, spoolWriter 선택)을 명시하라.

## 금지사항

- `req.body`/payload의 `role`·`actorUserId`·`kind`를 신뢰하지 마라. 이유: acting 신원은 검증된 세션에서만 도출한다(ADR-004) — 위조 시 Z 권한·감사 추적이 무너진다.
- 인가 판정보다 먼저 스풀 설정 여부나 실패 존재 여부를 응답하지 마라. 이유: 비인증 사용자에게 서버 구성·데이터 존재를 노출한다(`distribution.tick`이 명시한 규율).
- 세션 원본(`rawSession`)을 게이트에 쓰지 마라 — 반드시 `createSessionGuard`로 감싼 `session`을 쓴다. 이유: 한 갈래라도 원본을 쓰면 그 경로만 옛 스냅샷 권한으로 남아 권한 상승 구멍이 된다(파일 상단 CRITICAL 주석).
- `distributionRetryService`를 `spoolWriter` 유무로 조건부 생성하지 마라. 이유: 스풀 미설정 환경에서 과거 실패 목록 조회까지 막히고, 미가용 판정이 두 곳으로 갈라진다.
- 컨트롤러에서 실패 목록을 가공·필터·정렬하지 마라. 이유: 투영·정렬은 서비스가 단일 출처이며(경로 유출 방지 투영 포함), 두 곳으로 갈라지면 한쪽만 위생 규칙을 잃는다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
