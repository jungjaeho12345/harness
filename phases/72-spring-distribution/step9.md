# Step 9: distribution-http

배부 실행 3 라우트를 결선한다 — `POST /api/distribution/tick` · `GET /api/distribution/failures` · `POST /api/distribution/retry`. 인가(Z)는 **서비스가 세션에서 도출**하고, 스풀 설정 판정은 **인가 뒤**에 온다.

**green 지점 2·3/3**: `contract/cases/minimal/distribution-disabled.contract.js`(스풀 미설정 축)와 `contract/cases/default/distribution-tick.contract.js`(실배부 축)가 이 step에서 green이 된다. 컨트롤러 파일이 하나이고 스텁 금지 규율상 3 라우트를 절반만 결선할 수 없어 두 축이 같은 step에 온다 — **검증 절차가 minimal → default 순서로 실패 원인을 분리한다.**

## 읽어야 할 파일

- `phases/72-spring-distribution/index.json` — decisions **(4)(5)(13)(18)(20)(21)(22)** · order (b) · open_questions **(b)**
- `server/index.js` 740~787행 — **세 라우트의 원본**. 특히 tick이 body를 읽지 않는다는 주석 · failures가 `limit`만 화이트리스트로 넘긴다는 주석 · retry의 **500 재매핑 3토큰**과 그것을 전역 표에 넣지 않는 이유
- `src/controllers/index.js` 205~236행 — 인가 → 서비스 위임 순서(`tick`은 게이트 **먼저**, 그다음 `spool-disabled`)
- `src/services/authorization.js` 6~12행·72~89행 — `runDistributionTick: ['Z']` · `manageDistributionFailure: ['Z']`
- `contract/cases/default/distribution-tick.contract.js` — **전문**(인가 3축 · GET 404 · 6키 · body 무시 · 실배부 · 멱등 · failures limit 4프로브 · retry 404 4프로브 · 회수)
- `contract/cases/minimal/distribution-disabled.contract.js` — **전문**(tick·retry 503 · **인가가 설정보다 먼저** · failures 200 · 수신처 CRUD 무관)
- `server-spring/src/main/java/harness/news/service/Authorization.java` — capability 상수·맵·`authorize`
- `server-spring/src/main/java/harness/news/web/ReasonStatus.java`
- **`server-spring/src/main/java/harness/news/web/GlobalErrorHandler.java` 60~77행** — `handleNotFound`가 `NoResourceFoundException`·`NoHandlerFoundException`·**`HttpRequestMethodNotSupportedException`**을 `HtmlErrors.notFound`(404 · text/html)로 매핑한다(phase 70이 `DELETE /api/distribution-targets/:id`를 404로 동결하면서 도입). javadoc이 415를 **일부러 넣지 않은 이유**도 함께 읽어라
- `server-spring/src/main/java/harness/news/web/HtmlErrors.java` — **package-private**이다(컨트롤러에서 부를 수 없다)
- `server-spring/src/main/java/harness/news/controller/DistributionTargetsController.java` — 컨트롤러 관례(`tokenOf` · `JsonHttp.write` · `readBody` · `queryFilters`)
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` — 29행 목록 · 메서드명·메시지의 수치
- `scripts/spring-contract.mjs` — scope 표
- 이 phase의 step7·step8 산출물

## 배경 (동결된 계약 사실)

### 인가 → 설정 순서

세 라우트 전부 **Z 전용**이다: 미인증 401 `unauthenticated` · **R도 D도 403** `forbidden`. 그리고 **인가가 스풀 설정 판정보다 먼저**다 — 비-Z에게는 배부 설정 상태조차 알려주지 않는다(minimal 계약이 `r-session-not-disabled` 케이스로 그 순서를 관측한다).

capability 2개를 `Authorization`에 추가한다: `RUN_DISTRIBUTION_TICK → [Z]` · `MANAGE_DISTRIBUTION_FAILURE → [Z]`(Node `runDistributionTick`/`manageDistributionFailure` 동형). **`actorUserId`는 검증된 세션에서만** 온다.

### 라우트별 규율

- **tick** — `@PostMapping`만. **body 파라미터 0개**(decisions (5)). 게이트 → tick 서비스 없으면 `spool-disabled` → `run(actorUserId)`. 성공 응답은 서비스가 만든 맵 그대로(6키). **`app.notifyChange`(SSE) 등가는 만들지 않는다**(excluded (d)·decisions (23)).
- **failures** — `GET`. 게이트 → `list(limit)`. **쿼리는 `limit`만** 화이트리스트로 넘긴다(통짜 전달 금지). 정규화·클램프는 서비스 책임. **반복 쿼리 키는 값 리스트 그대로** 넘겨 `NodeNumber.toNumber` 의미론으로 수렴시킨다(`?limit=1&limit=2` → NaN → 기본값 → **200**). `limit`이 무엇이든 **400이 아니다**.
- **retry** — `POST`. 게이트 → body에서 **`historyId` 하나만** 읽는다(`articleId`·`targetId`·`kind`·`role`을 함께 보내도 무시 — 계약 `extra-fields-ignored`가 관측한다) → `retry(historyId, actorUserId)`.
  - 실패 시: `spool-write-failed`·`invalid-spool-dir`·`invalid-article-id` **3토큰만 라우트에서 500**으로 올리고, 나머지는 `ReasonStatus.of(reason)`(폴백 400).
  - **이 3토큰을 전역 표에 넣지 마라**(decisions (4)) — `invalid-spool-dir`는 배부 대상 CRUD의 400 계약과 같은 토큰이다.

### `ReasonStatus`에 추가하는 7토큰

`spool-disabled`(503) · `tick-failed`(500) · `no-failure`(404) · `status-changed`(409) · `kind-changed`(409) · `stale-cycle`(409) · `retry-in-flight`(409). (`unregistered`는 phase 71-spring-collection step5에서 이미 추가됐다.) **각 토큰에 HTTP 도달 테스트가 있어야 한다** — 뒤 4개는 실패 원장을 직접 시드한 와이어 테스트로 도달시킨다.

### `GET /api/distribution/tick`은 **이미 404다 — 새 특수처리를 만들지 마라**

계약이 `status === 404`와 `json?.ok === undefined`를 단언한다. **그 404는 이미 성립한다**: `GlobalErrorHandler.handleNotFound`가 `HttpRequestMethodNotSupportedException`을 `HtmlErrors.notFound`(404 · text/html)로 매핑한다(phase 70이 `DELETE /api/distribution-targets/:id`를 404로 동결하면서 도입했고, 그 계약이 지금 green이라는 사실이 이 경로의 증거다). 따라서 POST 매핑을 붙여도 같은 경로의 GET은 404다.

처분(decisions (20) · open_questions (b)):

- **실측으로 확인만 한다**(작업 A-2). 404가 나오면 그것으로 끝이다.
- **405가 나오면 새 처리를 만들지 말고 원인을 규명하라** — 기존 매핑이 왜 안 걸렸는가(핸들러 매핑 형태·필터 순서·예외 타입 중 무엇이 달라졌는가). 그것이 진짜 문제이고, 라우트별 우회는 그 문제를 덮을 뿐이다.
- 컨트롤러 레벨 '좁은 처리'는 **애초에 불가능하다**: `HtmlErrors`는 package-private이라 `harness.news.controller`에서 부를 수 없다. 손으로 404를 흉내 내면 본문·Content-Type이 다른 404가 하나 더 생긴다.
- **다른 39 라우트의 405/415 동작을 바꾸지 마라**(미동결 축 — phase 68 forward_notes (13)).

### default 프로파일 env

phase 71-spring-collection step0이 이미 `DIST_SPOOL_DIR`을 주입하고 있다. 이 step에서 그 스풀이 **실제로 쓰이기 시작**한다.

## 작업

### A. Node 실측 대조 + GET 405/404 실측

1. 두 파티션의 Node 리포트를 리포 **밖**에 뽑는다:
   ```
   node scripts/contract-run.mjs --profile minimal --files contract/cases/minimal/distribution-disabled.contract.js --out <임시>/minimal-dist-node.json
   node scripts/contract-run.mjs --profile default --files contract/cases/default/distribution-tick.contract.js  --out <임시>/default-tick-node.json
   ```
   각 리포트의 **관측 수·status·bodyKeys·values**를 기록한다.
2. 현재 Spring jar를 띄운 상태에서 `GET /api/distribution/tick`(Z 세션)이 **404인지 405인지** 실측하고, POST 매핑을 붙인 뒤 다시 실측해 변화를 기록한다. **기대값은 양쪽 다 404**다(`GlobalErrorHandler.handleNotFound` — 위 배경). 대조군으로 `DELETE /api/distribution-targets/1`(phase 70이 404로 동결한 같은 경로 계열)도 함께 찍어 두면 매핑이 살아 있음을 한눈에 보여 준다.

### B. `Authorization`에 capability 2개 추가

- 상수 2개 + 맵 항목 2개(`→ List.of("Z")`). `authorize(token, capability)` → `unauthenticated`/`forbidden`.

### C. `ReasonStatus`에 7토큰 추가

- 위 표 그대로. **`collection-disabled`·`no-active-api-source`·`fetch-failed`·`spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`는 넣지 않는다.**

### D. `DistributionController` (`harness.news.controller`)

- 세 핸들러. 세션 토큰은 `SessionTokens`(쿠키 우선·`x-session-id` 폴백)로 읽는다.
- 응답은 전부 `JsonHttp` 한 지점(decisions (22)).
- **`ContentsRow`를 알지 마라**(`ControllerProjectionBoundaryTest`) — 서비스가 만든 맵만 만진다.
- tick 핸들러에 `@RequestBody`·`readBody` **금지**.

### E. 인벤토리·scope 동기화 (같은 step에서)

- `HandlerInventoryTest.IMPLEMENTED_ROUTES` 29 → **32** + 메서드명·실패 메시지의 수치 갱신(`exactlyTheThirtyTwoImplementedRoutesHaveHandlers` · '32 라우트').
- `scripts/spring-contract.mjs` SCOPE:
  - `default.files`에 `contract/cases/default/distribution-tick.contract.js`를 **알파벳 위치**(`distribution-targets.contract.js` 뒤, `health.contract.js` 앞)에 넣는다.
  - `minimal.files`에 `contract/cases/minimal/distribution-disabled.contract.js`를 **알파벳 위치**(`collection-open.contract.js` 뒤, `transitions.contract.js` 앞)에 넣는다.
  - 각 행에 담당 step 주석.
- `PathPolicyWireTest`의 스텁 금지 프로브(`GET /api/media/search`)를 **손대지 마라** — 이 phase는 media-search를 구현하지 않으므로 여전히 유효하다.

### F. 테스트 (먼저 쓴다 — `DistributionWireTest`)

**인가·설정 축(스풀 미설정 컨텍스트)**

1. 세 라우트 미인증 401 2키 · R 403 · D 403(`role:'Z'` body 스푸핑 무효).
2. Z tick → 503 `spool-disabled` 2키 · Z retry → **404보다 먼저** 503 · Z failures → **200** `{ok,items}`.
3. R tick/retry → **403**(503 아님 — 순서 실증).

**실배부 축(스풀 설정 컨텍스트 + `@TempDir`)**

4. Z tick(빈 DB) → 200 · **정확 6키** · `scanned≥0` · 세 배열.
5. tick에 주입 body(`role`·`now:'2999-…'`·`targets`·`articleId`·`kinds`)를 보내도 6키이고 `at`이 2999가 아니며 주입 `articleId`가 `distributed`에 없다.
6. **리플렉션 단언**: tick 핸들러 시그니처에 `@RequestBody` 파라미터가 **0개**다.
7. 도래한 엠바고 기사 + 활성 press 수신처 → `distributed` 1건(3키) · `kinds:['press']` · `status:'DPS'` · 되읽기 `distributedAt` 채워짐 · **재실행 시 재배부 0**.
8. **경로 유출 0**: 응답 전문에 `spoolDir` 슬러그·`.json`·경로 구분자 없음.
9. `GET /api/distribution/tick` → **404**(`ok` 키 없음).
10. failures `limit` 프로브: 없음·`1`·`'abc'`·`-1`·**반복 키** 전부 **200**.
11. retry 프로브: 없는 id·누락·문자열·추가 필드 동봉 전부 **404 `no-failure`**.
12. **409 4종 도달**(계약이 못 보는 축 — Java가 유일 방어선):
    - `stale-cycle`·`kind-changed`·`status-changed` 3종은 **실패 원장을 직접 시드**해 각각 **HTTP 409**로 관측한다.
    - **`retry-in-flight`는 원장 시드로 도달하지 않는다** — 같은 `(articleId, targetId)`에 대한 **두 요청이 실제로 겹쳐야** 한다. step8 test 13이 쓴 **쓰기 지연 seam**(가짜 `SpoolFs`/writer가 래치를 기다렸다가 반환)을 그대로 재사용해 요청 A가 `write` 안에 머무는 동안 요청 B를 보내 **409**를 관측하고, 래치를 풀어 A가 200으로 끝나는지까지 확인한다.
    - **main 소스에 `Thread.sleep`·타이머를 넣지 마라**(71a 정적 게이트 1군이 red를 낸다) — 지연은 **테스트 전용 seam 구현체**에만 둔다.
13. **500 재매핑 3종 도달**: writer가 각 토큰을 내도록 만들어 `spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`가 **HTTP 500**임을 관측. 그리고 같은 컨텍스트에서 `POST /api/distribution-targets`의 `invalid-spool-dir`가 여전히 **400**임을 단언(전역화 금지의 행동 그물).
14. **retry 성공** 도달: 시드한 실패를 실제로 재전송해 200 5키 · 파일 1개 · `distribute-retry` 이력.
15. `tick-failed` 500 도달(후보 조회가 실패하도록 주입).
16. **DB 비파괴 그물**: 세 라우트를 전부 호출한 뒤 `Article`·`Contents`·`ArticleHistory`·`User`·`ReceiverConfig`·`DistributionTarget` **행 수가 줄지 않았다**(이력·상태는 늘거나 변할 수 있다 — 감소 0을 단언).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile minimal
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile default
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --dual-run
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 정적 게이트 3종 green · `HandlerInventoryTest` green(32 라우트).
- 2번(**green 2**): exit 0 · `distribution-disabled.contract.js` 전건 통과.
- 3번(**green 3**): exit 0 · `distribution-tick.contract.js` 전건 통과.
- 4번: exit 0 · **5 프로파일 diffs 0** · 관측 수 = 이전 값 + A에서 실측한 두 파티션의 관측 수.
- 5번: exit 0 · 5 프로파일 diffs 0(**실배부가 결선된 상태의 자기 결정성** — 이 phase에서 가장 중요한 판정 중 하나).
- 6번 증분 = `.../controller/DistributionController.java` · `.../service/Authorization.java`(capability 2) · `.../web/ReasonStatus.java`(7행) · 대응 테스트 + `HandlerInventoryTest.java` · `scripts/spring-contract.mjs` · `phases/72-spring-distribution/index.json`.

## 검증 절차

1. **red 먼저**: 와이어 테스트를 구현 전에 돌려 실패 서명을 실측한다(현재 404).
2. **진단 실행 순서**: `--profile minimal`을 **먼저** green으로 만들고(인가·503·failures 축), 그다음 `--profile default --files .../distribution-tick.contract.js`(실배부 축)를 본다. 두 축을 동시에 디버깅하지 마라.
3. **GET 404 실측**(A-2)의 결과를 요약에 적는다. **404가 기대값**이다(`GlobalErrorHandler`가 이미 그렇게 매핑한다). 405가 나왔다면 **좁은 처리를 만들지 말고** 기존 매핑이 걸리지 않은 원인을 규명해 그 진단을 요약에 남기고, 그래도 해결되지 않으면 step을 멈추고 보고한다.
4. **변이 (a) 원복**: 인가와 스풀 판정 순서를 뒤집어 minimal의 `r-session-not-disabled` 케이스가 red인지 확인 → 원복.
5. **변이 (b) 원복**: tick 핸들러에 `@RequestBody Map<String,Object> body`를 추가하고 `now`를 그 값에서 읽게 해 계약 `z-body-ignored`가 red인지 + 6번 리플렉션 단언이 red인지 확인 → 원복. (**엠바고 무력화**가 방어 대상이다.)
6. **변이 (c) 원복**: 500 재매핑 3토큰을 전역 표로 옮겨 13번 후반(`distribution-targets`의 400)이 red인지 + `distribution-targets.contract.js`가 red인지 확인 → 원복. **표와 라우트 폴백을 한 쌍으로** 본 실증이다.
7. **변이 (d) 원복**: `failures`의 `limit` 판독을 **첫 값만 읽도록**(`request.getParameter("limit")`) 바꿔 **반복 키 프로브(F-10의 `?limit=1&limit=2`) red** 확인 → 원복. (`getParameter`는 첫 값 `'1'`을 주어 `limit=1`이 되는데, Node는 배열 → `Number(['1','2'])` = NaN → 기본값이라 **목록 크기가 갈린다**. decisions (18)이 실제로 방어하는 축이 이것이다 — '쿼리를 통짜로 넘기는' 변이는 서비스가 `limit`만 읽으므로 관측이 같아 red를 내지 못한다.)
8. **변이 (e) 원복**: `ReasonStatus`에서 `spool-disabled` 행을 지워 minimal이 400을 내는지(red) 확인 → 원복.
9. **`--parity` 연속 2회 green**(비고정 flake 0)을 확인한다. flake가 보이면 그 원인을 반드시 규명한다(활성 수신처와 송고의 시간 창 — step6 A-2 조사 결과와 대조).
10. AC 실행. 리포 `news.db`·`uploads/` 무변 · **리포 안에 스풀 파일 0** · java 프로세스 잔존 0 · 리포트·로그에 세션 토큰·경로 0건.
11. index.json step9 상태 갱신.

## 금지사항

- tick 핸들러에서 body를 읽지 마라. 이유: role·시각·대상 목록을 클라가 주입하면 엠바고가 무력화된다(ADR-004).
- `spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`를 `ReasonStatus`에 넣지 마라. 이유: `invalid-spool-dir`가 배부 대상 CRUD의 400 계약과 같은 토큰이라 phase 70 계약이 그 자리에서 red다.
- `collection-disabled`·`no-active-api-source`·`fetch-failed`를 전역 표에 넣지 마라. 이유: 각각 라우트 직접 503과 폴백 400이 계약이다.
- 스풀 설정 판정을 인가보다 앞에 두지 마라. 이유: 비-Z에게 배부 설정 상태를 알려주면 minimal 계약이 red다.
- retry 입력에서 `historyId` 외의 값을 읽지 마라. 이유: 기사·수신처·kind는 실패 행에서만 도출한다.
- SSE 신호(`notifyChange` 등가)를 만들지 마라. 이유: SSE는 이 phase 범위 밖이고, 검증되지 않은 seam은 만들지 않는다(발행 지점은 forward_notes로 인계한다).
- 39 라우트 전체의 405/415 정책을 바꾸지 마라. 이유: 그 축은 미동결이며 전 라우트의 판정을 함께 움직인다(phase 68 forward_notes (13)).
- `GET /api/distribution/tick`을 위한 **전용 404 처리를 만들지 마라**(컨트롤러 GET 매핑 추가·`HtmlErrors` 흉내·`@ExceptionHandler` 신설 전부). 이유: `GlobalErrorHandler.handleNotFound`가 이미 그 404를 낸다 — 겹쳐 만들면 본문·Content-Type이 다른 404가 하나 더 생기고, 그 divergence는 계약이 보지 않아 조용히 남는다.
- `PathPolicyWireTest`의 스텁 금지 프로브를 옮기거나 지우지 마라. 이유: `GET /api/media/search`는 이 phase에서 구현하지 않으므로 프로브가 유효하다.
- `--require-full-coverage`(Spring 대상)를 켜지 마라. 이유: 7 라우트가 남아 영구 red이고 그 red가 정상이다.
