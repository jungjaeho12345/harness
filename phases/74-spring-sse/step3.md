# Step 3: change-publishers

## 읽어야 할 파일

**계획 문서**
- `phases/74-spring-sse/index.json` — `decisions` (7)(12)·`excluded` (a).
- `phases/74-spring-sse/step0.md` — 「배경」 (2)의 **발행 지점 11곳 실측 행 번호**.

**정본 (무수정 — 읽기만). 각 행의 조건식을 눈으로 확인하라.**
- `server/index.js` **749** — `POST /api/distribution/tick`: `if (!r.ok) return fail(res, r);` 뒤에 `if (Array.isArray(r.distributed) && r.distributed.length > 0) app.notifyChange('status');`
- `server/index.js` **787** — `POST /api/distribution/retry`: 성공 분기 안(`!r.ok`의 500 재매핑 3토큰과 `fail`을 **전부 지난 뒤**) `app.notifyChange('status');`
- `server/index.js` **867** — `POST /api/articles`: `if (r.ok) app.notifyChange('create');`
- `server/index.js` **883** — `POST /api/articles/:id/action`: `if (!r.ok) return fail(res, r, 409);` 뒤 `app.notifyChange('status');`
- `server/index.js` **902** — `POST /api/articles/:id/derive`: `if (!r.ok) return fail(res, r);` 뒤 `app.notifyChange('create');`
- `server/index.js` **944** — `PUT /api/articles/:id`: `if (r.ok) app.notifyChange('update');`
- `server/index.js` **963 / 976 / 988** — lock · unlock · force-unlock: `if (r.ok) app.notifyChange('lock');`
- `server/index.js` **1090 / 1116** — `POST /api/collection/receive` · `POST /api/collection/pull`: 성공 분기 안 `app.notifyChange('create');`
- `docs/api-contract/sse.md` — 「`/api/stream` — 무효화 신호의 발생 라우트 표」와 그 아래 두 각주(**거부/실패 응답은 신호를 내지 않는다** · **송고 훅의 비동기 엠바고 승격은 자체 신호를 내지 않는다**).

**Spring 현행 (이 step이 고치는 것)**
- `server-spring/src/main/java/harness/news/controller/ArticlesController.java`
- `server-spring/src/main/java/harness/news/controller/DistributionController.java`
- `server-spring/src/main/java/harness/news/controller/CollectionController.java`
- 각각의 와이어 테스트: `ArticleCrudWireTest` · `ArticleLifecycleWireTest` · `EditLockWireTest` · `DistributionWireTest` · `DistributionSeamWireTest` · `CollectionWireTest`(무회귀 대상 + 증설 대상)

**직전 step 산출물**
- `server-spring/src/main/java/harness/news/service/ChangeBus.java`(step0) — `publish(String kind)` · 상수 `CREATE`/`UPDATE`/`STATUS`/`LOCK`.

## 배경 (동결된 사실)

1. **이 step은 계약이 하나도 관측하지 못한다.** 구독자가 아직 없어서 발행이 와이어로 나가지 않는다. `--parity` 296관측 diffs 0이 **불변**인 것이 AC다. 따라서 **Java 테스트가 이 step의 유일한 방어선**이다 — 72에서 송고 훅의 반환 status 변이가 계약 198관측을 diffs 0으로 통과하고 Java 1건만 red였던 것과 같은 축이다.
2. **하나라도 빠지면 그 화면의 배지가 조용히 갱신되지 않는다.** 그리고 SSE는 계약이 구조적으로 못 보는 축이라 **diff 0으로 통과한다**. 그래서 이 step의 완료 조건은 **11 지점 항목별 확인**이다.
3. **기사 4종(`create`·`update`·`status`·`lock`)만 계약(`sse-stream.contract.js` A-4)이 관측한다.** tick·retry·collection 3묶음은 **영원히 Java 테스트만 본다**.
4. **발행은 transport(컨트롤러)에서 한다.** Node 정본이 라우트에서 발행한다. 서비스층으로 내리면 같은 서비스를 부르는 다른 경로(송고 훅 내부의 `syncEmbargoStatus` 등)에서 **Node에 없는 신호**가 추가로 나간다 — sse.md가 "송고 훅의 비동기 엠바고 승격은 자체 신호를 내지 않는다"로 동결한 축이다.
5. **`ChangeBus.publish`는 절대 던지지 않는다**(step0의 계약). 그래도 컨트롤러는 발행을 **응답을 쓴 뒤가 아니라 Node와 같은 자리**(응답 직전)에 둔다 — Node의 순서는 `notifyChange` → `res.json(r)`이다.

## 작업

### A — 발행 결선 11 지점

| # | Spring 지점 | 조건 | kind |
|---|---|---|---|
| 1 | `ArticlesController` create 성공 분기 | 결과 `ok`가 참일 때만 | `CREATE` |
| 2 | `ArticlesController` derive 성공 분기 | `fail` 반환을 지난 뒤 | `CREATE` |
| 3 | `ArticlesController` action 성공 분기 | 409/400/403 거부를 지난 뒤 | `STATUS` |
| 4 | `ArticlesController` update 성공 분기 | 결과 `ok`가 참일 때만 | `UPDATE` |
| 5 | `ArticlesController` lock 성공 분기 | 결과 `ok`가 참일 때만 | `LOCK` |
| 6 | `ArticlesController` unlock 성공 분기 | 결과 `ok`가 참일 때만 | `LOCK` |
| 7 | `ArticlesController` force-unlock 성공 분기 | 결과 `ok`가 참일 때만 | `LOCK` |
| 8 | `DistributionController` tick 성공 분기 | **`ok` 참 AND `distributed`가 리스트이고 원소 1개 이상일 때만** | `STATUS` |
| 9 | `DistributionController` retry 성공 분기 | `if (Boolean.TRUE.equals(result.get(OK)))` **안** — 4xx 거부에도, `spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`의 **500 재매핑 분기**에도 보내지 않는다 | `STATUS` |
| 10 | `CollectionController` receive 성공 분기 | 성공일 때만 | `CREATE` |
| 11 | `CollectionController` pull 성공 분기 | 성공일 때만 | `CREATE` |

- 판정 입력 `distributed`는 `DistributionTickService` 반환 맵에 이미 있다(새로 계산하지 마라).
- 컨트롤러는 `ChangeBus`를 **생성자 주입**으로 받는다(ADR-013 · 생성자 주입만). 필드 주입·정적 참조 금지.
- **컨트롤러가 `ContentsRow` 등 모델 타입을 새로 알게 되면 안 된다**(`ControllerProjectionBoundaryTest`가 red다). 발행은 kind 문자열 하나만 넘긴다.

### B — 테스트 (먼저 작성한다)

관측 수단: 각 와이어 테스트에서 컨텍스트의 `ChangeBus` 빈에 테스트 구독자를 붙여 **kind 시퀀스를 수집**한다(빈을 교체하지 말고 실제 빈에 `subscribe`하라 — 배선이 실제로 그 빈을 쓰는지까지 함께 검증된다).

최소 항목:
1. **발행 11건** — 위 표의 성공 경로를 각각 실제 요청으로 태우고 **정확히 1회**, **정확한 kind**가 발행됨을 단언한다(11개 테스트).
2. **미발행 — 거부·실패 경로**(각각 발행 0건):
   - create/derive/action의 400·403·404·409
   - update의 잠금 미보유 403 · 미존재 404
   - lock/unlock/force-unlock의 실패(not-holder·not-found·forbidden)
   - **tick의 `distributed` 0건 성공**(200인데 발행 0 — 가장 중요한 한 건)
   - **tick의 실패**(`spool-disabled` 503 등)
   - **retry의 4xx 거부** 전부
   - **retry의 500 재매핑 3토큰**(`spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`)
   - collection receive/pull의 401·403·400·503
3. **kind 어휘 잠금** — 발행된 문자열이 `create|update|status|lock` 4종 밖이면 red.
4. **발행이 응답을 바꾸지 않는다** — 구독자가 `RuntimeException`을 던지는 상태에서 위 11 경로를 다시 태워 **응답 status·본문이 동일**함을 단언한다(Node `server/index.js` 1144~1150의 위험: 예외가 새면 성공한 저장이 500으로 뒤집힌다).
5. **송고 훅은 자체 신호를 내지 않는다** — 배부 결선이 있는 구성에서 `POST /api/articles/:id/action`(send)이 내는 신호가 **`status` 1건뿐**이고 엠바고 승격에서 추가 신호가 없음을 단언한다(sse.md 각주).
6. 기존 와이어 테스트 **전건 무회귀**.

## Acceptance Criteria

```bash
# 1) Java 전체
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B clean verify
#   기대: BUILD SUCCESS · Tests run: <step2 종료 수치 + 신규 N> · Failures 0 · Errors 0 · Skipped 0

# 2) 계약 무회귀 — 관측 수와 diff가 **불변**이어야 한다
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && SPRING_JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
#   기대: exit 0 · profiles=5 · 296관측 diffs 0
#   (관측 수가 변했다면 이 step이 응답 shape을 건드린 것이다 — 즉시 원인을 찾아라)

# 3) 발행 지점 11곳이 실제로 코드에 있다 — 세어서 기록하라
grep -rn "changeBus.publish\|ChangeBus\." server-spring/src/main/java/harness/news/controller/ | grep -c publish
#   기대: 11

# 4) 계층 게이트
#   ControllerProjectionBoundaryTest · ResponseBodyProjectionGuardTest가 green(위 1)에 포함)

# 5) 무접촉 경로 · ADR-008 게이트 0줄 · 핸들러 집합 불변
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json spikes
git diff --stat -- server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java
git diff --stat -- server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java
#   기대: 셋 다 출력 없음
```

**종료 조건 — 아래 두 가지를 summary에 기록한다. 미기록 시 이 step은 미완이다.**
1. **발행 11 지점 항목별 체크리스트**(지점 · 조건 · kind · 그것을 잠그는 테스트 이름).
2. **변이 전건 결과표.**

## 검증 절차 (변이)

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M3-1 | tick의 `distributed.length > 0` 조건 제거(성공이면 항상 발행) | 「tick 0건 성공 → 발행 0」 red |
| M3-2 | retry의 500 재매핑 분기에서도 발행 | 「500 재매핑 → 발행 0」 red |
| M3-3 | create의 `ok` 조건 제거 | 「create 실패 → 발행 0」 red |
| M3-4 | action의 kind를 `update`로 바꿈 | 항목 1(action) red |
| M3-5 | unlock의 발행을 통째로 삭제 | 항목 1(unlock) red |
| M3-6 | collection pull의 발행을 삭제 | 항목 1(pull) red |
| M3-7 | 구독자 예외를 컨트롤러가 잡지 않도록(step0 `ChangeBus`의 격리를 끄고) | 항목 4 red — 응답이 500으로 뒤집힌다 |
| M3-8 | **위 M3-1~M3-6 각각에 대해 `--parity`를 돌려라** | **전건 296관측 diffs 0(green)** — "계약이 이 축을 구조적으로 못 본다"의 실증. 이 결과를 표에 명시하라 |

M3-8은 이 step에서 가장 중요한 기록이다: **계약이 green인데 기능이 깨져 있는 상태를 실제로 만들어 보고**, 그 상태를 잡는 것이 Java 테스트뿐임을 증명한다.

## 금지사항

- **거부·실패 응답에 발행하지 마라.** 이유: sse.md가 "거부/실패 응답은 신호를 내지 않는다(변경 0건 재조회 낭비 + 오신호 방지)"로 동결했다. tick의 `distributed` 0건도 같은 축이다.
- **발행을 서비스층(`ArticleWriteService`·`DistributionTickService`·`CollectionService` 등)으로 내리지 마라.** 이유: Node 정본이 transport에서 발행한다. 서비스층에 두면 같은 서비스를 부르는 다른 경로(송고 훅의 엠바고 승격)에서 Node에 없는 신호가 추가로 나가고, 그것은 계약이 관측하지 못한다.
- **송고 훅의 비동기 엠바고 승격(DES→EPS→DPS)에 신호를 붙이지 마라.** 이유: sse.md가 "자체 신호를 내지 않는다 — 상태 변화 관측은 tick 라우트의 `status` 신호 또는 재조회에 의존한다"로 동결했다.
- **FTP watcher 경로(`server/index.js` 1379행의 `notifyChange('create')`)를 이식하지 마라.** 이유: 수집 watcher 자체가 Spring 미이식이다(`excluded`). 없는 소비자를 위한 발행을 만들면 검증되지 않은 표면이 쌓인다.
- **발행을 위해 응답 조립 순서를 바꾸지 마라.** 이유: `JsonHttp.write`가 응답을 커밋한 뒤 발행하면 구독자 write가 느릴 때 트리거 응답이 이미 나간 상태가 되어 Node와 순서가 갈린다. Node 순서는 `notifyChange` → `res.json`이다.
- **컨트롤러에 `ContentsRow`·모델 타입을 새로 import하지 마라.** 이유: `ControllerProjectionBoundaryTest`가 즉시 red다(ADR-006·013).
- **`contract/**`·`server/**`·`src/**`·`test/**`·`spikes/**` 등 무접촉 목록을 고치지 마라.**
