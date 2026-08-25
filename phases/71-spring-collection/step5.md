# Step 5: collection-http

수집 2 라우트를 결선한다 — `POST /api/collection/receive` · `POST /api/collection/pull`. fail-closed 가드(503) → 토큰 가드(401) → 서비스 판정(403/400/200)의 **순서가 계약**이다. 이 step에서 **계약 3파일이 동시에 green**이 된다.

**green 지점 1/3**: `contract/cases/default/collection.contract.js` · `contract/cases/minimal/collection-open.contract.js` · `contract/cases/failclosed/collection-disabled.contract.js`. 세 파일이 **같은 2 라우트를 서로 다른 서버 구성에서** 관측하므로 한 파일만 green이 되는 중간 상태가 없다.

## 읽어야 할 파일

- `phases/71-spring-collection/index.json` — decisions **(4)(5)(6)(9)(10)(11)(12)** · order (b) · open_questions **(e)**
- `server/index.js` 120~157행(`isLoopbackHost`·`resolveHost`·`logHostDiagnostics`) · 1067~1125행(**두 라우트의 가드 순서 원본**) · 1345행(`requireCollectionToken: !isLoopbackHost(host)`) · 318행(`UNAUTH`) · 322~352행(`STATUS_BY_REASON` — `unregistered:403`이 여기 있고 `collection-disabled`는 **없다**)
- `contract/cases/default/collection.contract.js` — 전문(토큰 축·파서 축·비활성 축·pull 4케이스·수신설정 삭제가 기사를 지우지 않는다는 A-8 케이스)
- `contract/cases/minimal/collection-open.contract.js` — 전문(토큰 미설정 서버는 헤더를 **아예 읽지 않는다**)
- `contract/cases/failclosed/collection-disabled.contract.js` — 전문(503이 **최상단** 가드 · 토큰 헤더가 있어도 503 · health·session은 정상)
- `scripts/spring-contract.mjs` — step0이 만든 프로파일 표(이 step에서 `files`를 채운다)
- `server-spring/src/main/java/harness/news/web/RoutePolicy.java` 44~47행·164~165행 — `AuthClass.TOKEN`(requiresSession=**false**)이 이미 두 라우트에 걸려 있다
- `server-spring/src/main/java/harness/news/web/ReasonStatus.java` · `web/JsonHttp.java` · `controller/ReceiverConfigController.java`(컨트롤러 관례: `JsonHttp.write` · `readBody` · `queryFilters`)
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` — `IMPLEMENTED_ROUTES` 27행 · 메서드명 `exactlyTheTwentySevenImplementedRoutesHaveHandlers` · 실패 메시지의 '27 라우트'
- `server-spring/src/main/resources/application.properties` · `config/AppProperties.java` — 설정 바인딩 관례
- 이 phase의 step3·step4 산출물

## 배경 (동결된 계약 사실)

### 가드 순서 (세 파일이 함께 잠근다)

1. **fail-closed 503** — `requireCollectionToken && 토큰 미설정` → `503 {ok:false, reason:'collection-disabled'}`(2키). **토큰 헤더가 있어도 503**이다(401로 새면 red). `requireCollectionToken = !isLoopbackHost(bindHost)`.
2. **토큰 401** — 서버에 토큰이 **설정돼 있을 때만** 검사한다. 헤더 부재·불일치 → `401 {ok:false, reason:'unauthenticated'}`. **토큰 미설정 서버는 헤더를 읽지도 않는다**(minimal: 아무 값이나 보내도 200).
3. **서비스 판정** — `unregistered` 403 · `inactive` 403 · `no-active-api-source` 400 · `fetch-failed` 400 · 성공 200 `{ok:true, articleId}` 2키.

### 프로파일별 구성

| 프로파일 | 바인드 | 토큰 | 관측 |
|---|---|---|---|
| default | 127.0.0.1 | 설정 | 401(부재·불일치) · 403 · 400 · 200 |
| minimal | 127.0.0.1 | 미설정 | 토큰 무시 · 403 · 200 |
| failclosed | 0.0.0.0 | 미설정 | **503 전부**(health·session은 정상) |

### `collection-disabled`는 전역 표에 넣지 않는다

Node는 그 응답을 `fail()`이 아니라 라우트에서 직접 쓴다. Spring도 컨트롤러가 직접 503을 쓴다. **`ReasonStatus`에 추가하는 것은 `unregistered`(403) 하나뿐**이다(`inactive`·`unauthenticated`·`not-found`는 이미 있고, `no-active-api-source`·`fetch-failed`는 폴백 400이어야 하므로 **넣으면 안 된다**).

## 작업

### A. Node 실측 대조(decisions (14))

세 파티션의 Node 리포트를 리포 **밖** 임시 경로에 뽑아 `status`·`bodyKeys`·`values`를 확인한다:

```
node scripts/contract-run.mjs --profile default   --files contract/cases/default/collection.contract.js       --out <임시>/default-collection-node.json
node scripts/contract-run.mjs --profile minimal   --files contract/cases/minimal/collection-open.contract.js  --out <임시>/minimal-collection-node.json
node scripts/contract-run.mjs --profile failclosed --files contract/cases/failclosed/collection-disabled.contract.js --out <임시>/failclosed-node.json
```

각 리포트의 **관측 수**를 기록한다 — step 종료 후 Spring 쪽 관측 수와 같아야 한다.

### B. 설정 — 바인드 주소와 수집 토큰 (**`AppProperties`는 건드리지 않는다**)

- `application.properties`에 **두 줄만** 추가한다:
  - `app.collection.host=${server.address:127.0.0.1}` — **`${HOST:...}`를 한 벌 더 쓰지 마라.** `server.address`가 이미 `${HOST:127.0.0.1}`이고, 그것이 **실제 바인드 주소의 유일한 출처**다. `${HOST:...}`를 복제하면 `SERVER_ADDRESS`만 설정된 배포에서 Tomcat은 전 인터페이스에 열리는데 fail-closed 판정은 `127.0.0.1`로 남아 **수집 2 라우트가 무토큰 개방**된다(fail-closed가 막으려던 바로 그 상태 — decisions (4)).
  - `app.collection.token=${COLLECTION_TOKEN:}` — 빈 값 = 미설정.
- **신설 `CollectionProperties`**(`@ConfigurationProperties("app.collection")` record: `host`, `token`)를 만들고 `AppConfig`의 `@EnableConfigurationProperties`에 **항목 1개만** 더한다.
  - **`AppProperties`에 필드를 추가하지 마라**: record이고 `new AppProperties(...)` 호출부가 테스트 **9곳**(`config/AppPropertiesTest.java` 8 · `web/AllowedOriginsTest.java` 1)이라, 필드를 더하면 그 두 파일이 반드시 함께 바뀌어 이 step의 증분 목록이 자기모순이 된다(decisions (5)).
  - `host`는 빈 값이면 `127.0.0.1`로 수렴(Node `resolveHost`의 "빈 문자열/공백은 기본값" 규율).
  - `token`은 **trim하지 않는다**(토큰 값을 서버가 고치면 클라이언트와 갈린다). **빈 문자열은 '미설정'이고 공백 1칸은 '설정됨'**이다 — Node truthy 판정 그대로(`!process.env.COLLECTION_TOKEN`은 `' '`에 대해 false다).
- **`CollectionTokenSource`** — 1메서드 seam(`String current()`), 기본 구현이 `CollectionProperties`에서 읽는다(decisions (4)). 컨트롤러는 이 seam만 본다.

### C. 순수 정책 — `CollectionAccess`

- `static boolean isLoopbackHost(String host)` — Node 문자 그대로: null/비문자열 → false · trim+소문자 후 `localhost`·`::1`·`[::1]` → true · `^127(\.\d{1,3}){3}$` → true · **그 외 전부 false**(호스트명 `127.example.com`은 loopback이 아니다).
- `static Decision decide(String bindHost, String configuredToken, String headerToken)` → `DISABLED` | `UNAUTHENTICATED` | `ALLOWED`. 위 가드 순서를 이 함수 하나가 소유한다(두 라우트가 같은 함수를 부른다 — 복제 금지).
- 토큰 비교는 **상수 시간**으로 한다(`MessageDigest.isEqual`, UTF-8 바이트). 관측은 동일하고 타이밍 표면만 닫힌다. null 헤더는 곧바로 `UNAUTHENTICATED`.
- **`CsrfOriginFilter`의 `isLoopbackOrigin`과 공유하지 마라** — 저쪽 입력은 origin URL이고 이쪽은 바인드 주소 문자열(`0.0.0.0`·`::`)이라 문법이 다르다(server/index.js 126~127행이 같은 이유로 분리했다).

### D. `CollectionController` (`harness.news.controller`)

- `@PostMapping("/api/collection/receive")` · `@PostMapping("/api/collection/pull")`.
- 각 핸들러: `CollectionAccess.decide(...)` → `DISABLED`면 `JsonHttp`로 **503 `{ok:false,reason:'collection-disabled'}`** · `UNAUTHENTICATED`면 401 `{ok:false,reason:'unauthenticated'}` · 아니면 본문에서 `sourceId`(+`payload`)만 뽑아 서비스 호출 → 성공 200 `{ok:true,articleId}` · 실패 `ReasonStatus.of(reason)`(폴백 400).
- **본문에서 읽는 키는 `sourceId`·`payload` 둘뿐**이다(통짜 스프레드 금지). `payload`는 타입을 강제하지 않고 그대로 넘긴다(문자열·객체·배열·숫자·부재).
- **세션을 읽지 마라**(`SessionTokens` 호출 0). 이 라우트는 세션 라우트가 아니다.
- 응답은 전부 `JsonHttp` 한 지점으로만 쓴다(decisions (12)).
- 로깅은 Node 동형으로 **`sourceId` + 결과만**(성공/사유). `payload`(수집 본문)·토큰은 절대 담지 않는다.

### E. `ReasonStatus`에 `unregistered` → 403 추가

- 그 한 줄만. `collection-disabled`·`no-active-api-source`·`fetch-failed`는 **추가하지 않는다**.

### F. 인벤토리·scope 동기화 (같은 step에서)

- `HandlerInventoryTest.IMPLEMENTED_ROUTES`에 2행 추가(27 → **29**) + **메서드명과 실패 메시지의 수치도 함께 갱신**(`exactlyTheTwentyNineImplementedRoutesHaveHandlers` · '29 라우트'). 수치가 목록과 어긋나면 그 테스트의 주장이 거짓이 된다.
- `scripts/spring-contract.mjs` SCOPE:
  - `default.files`에 `contract/cases/default/collection.contract.js`를 **알파벳 위치**(`auth.contract.js` 뒤, `crosscutting.contract.js` 앞)에 넣는다.
  - `minimal.files`에 `contract/cases/minimal/collection-open.contract.js`를 **`transitions.contract.js` 앞**에 넣는다.
  - `failclosed.files`를 `['contract/cases/failclosed/collection-disabled.contract.js']`로 채우고 **step0이 넣은 `bootOnly: true`를 제거**한다. 그때부터 다중 프로파일 실행·`--parity`·`--dual-run`이 이 프로파일을 정상 대상으로 본다(step0 작업 C).
  - 각 행에 담당 step 주석을 남긴다(기존 행 관례).
  - step0 작업 F-4의 자기 검사(`bootOnly`가 아닌 프로파일의 `files`는 비어 있으면 안 된다)가 여전히 green인지 확인한다.

### G. 테스트 (먼저 쓴다)

- `CollectionAccessTest`(순수): loopback 판정 표(`127.0.0.1`·`127.0.0.2`·`127.255.255.255`·`localhost`·`::1`·`[::1]`·`0.0.0.0`·`::`·`192.168.0.1`·`127.example.com`·`''`·null) · `decide` 3분기 · **가드 순서**(비-loopback + 무토큰 + 올바른 토큰 헤더 → `DISABLED`).
- `CollectionWireTest`(`@SpringBootTest` + `Wire`): 세 구성(프로퍼티로 host/token을 바꾼 3개 컨텍스트)에서
  1. default 구성: 헤더 없음 401 · 틀린 토큰 401 · 올바른 토큰 + 미등록 403 `unregistered` · 등록 소스 200 `{ok,articleId}` 2키 · 비활성 403 `inactive` · payload 누락 200.
  2. minimal 구성(토큰 미설정·loopback): 헤더 없이 403(미등록) · 아무 토큰 헤더나 보내도 200.
  3. failclosed 구성(host=0.0.0.0·토큰 미설정): receive·pull 모두 503 2키 · **토큰 헤더가 있어도 503** · 같은 서버의 `/api/health` 200.
     **[환경 위험 — 착수 전 판단]** 기존 와이어 테스트는 전부 `webEnvironment=RANDOM_PORT`(실제 Tomcat 바인드)다. 이 구성을 그대로 쓰면 **`mvnw verify` 안에서 java가 0.0.0.0에 바인드**되는데, 그것은 `open_questions (b)`가 `blocked` 사유로 지정한 바로 그 환경 위험이고 `mvnw verify`는 step1~6과 phase 72의 **상시 회귀 게이트**라 위험이 영구화된다. **판단 기준**: step0의 `--profile failclosed --boot-check` 실측이 **정상이면 `RANDOM_PORT`를 유지**한다. `blocked` 서명(방화벽 프롬프트 + health 45s 타임아웃)이 나왔다면 이 케이스와 아래 G-7을 **`webEnvironment=MOCK` 컨텍스트의 `CollectionProperties.host()` 바인딩 단언 + `CollectionAccessTest`의 `DISABLED` 행동 단언 조합**으로 대체한다(실제 바인드 없이 단일 출처 잠금과 가드 순서는 그대로 유지된다). 어느 쪽을 택했는지와 근거를 요약에 적어라.
  4. **응답 본문에 토큰·payload 원문이 없다**.
  5. `sourceId`를 반복 쿼리/배열·객체로 보냈을 때의 동작이 Node와 같은지(값 바인딩 정책 → 예외 → 500).
  6. **한글 payload 왕복**(제목·본문이 저장·조회에서 깨지지 않는다 — 계약이 일부만 본다).
  7. **`server.address` 단일 출처 잠금(decisions (4))**: `@SpringBootTest(properties = "server.address=0.0.0.0")`(토큰 미설정)에서 `POST /api/collection/receive`·`/pull`이 **503 `collection-disabled`**임을 단언한다. 이 테스트가 red면 `app.collection.host`가 `server.address`에서 파생되지 않았다는 뜻이다(문자열 비교가 아니라 **행동**으로 잠근다). **G-3의 환경 위험 판단이 여기에도 그대로 적용된다** — `blocked` 서명이 나왔다면 `webEnvironment=MOCK` + `CollectionProperties.host()` 바인딩 단언 + `CollectionAccessTest`의 `DISABLED` 단언 조합으로 대체하되, **단일 출처 잠금 자체를 빼지는 마라**(그것이 이 med의 핵심이다).
  8. **중복 `x-collection-token` 헤더(decisions (10))**: 같은 헤더를 두 번 보내되 (i) 첫 값이 올바르고 둘째가 틀린 경우 (ii) 첫 값이 틀리고 둘째가 올바른 경우. **Node 실측을 먼저 뽑아**(express `req.get`은 반복 헤더를 `", "`로 합친다 → 합쳐진 문자열은 실제 토큰과 다르므로 **양쪽 다 401**이 예상된다) 그 동작에 맞춘다. Spring `getHeader`는 **첫 값만** 주므로 순진한 구현은 (i)에서 **통과**해 갈린다. 처분과 실측을 요약에 적고 forward_note로 남긴다.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --dual-run
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · `Adr008DisciplineTest` green.
- 2번: exit 0 · **5 프로파일** · default `covered=25/39` · minimal `covered=3/39`(또는 실측치) · **failclosed 케이스 전건 통과**. 커버 수치는 실측을 기록한다.
- 3번: exit 0 · **5 프로파일 diffs 0** · 관측 수 = 215 + (default collection) + (minimal collection-open) + (failclosed 5). **A에서 뽑은 Node 관측 수와 일치**해야 한다.
- 4번: exit 0 · 5 프로파일 diffs 0(자기 결정성).
- 5번 증분 = `.../service/CollectionAccess.java` · `.../service/CollectionTokenSource.java` · `.../controller/CollectionController.java` · **`.../config/CollectionProperties.java`(신설)** · `.../config/AppConfig.java`(`@EnableConfigurationProperties` 항목 1개) · `src/main/resources/application.properties`(2줄) · `.../web/ReasonStatus.java`(1행) · 테스트 2개 + `HandlerInventoryTest.java` · `scripts/spring-contract.mjs` · `phases/71-spring-collection/index.json`. **`config/AppProperties.java`·`config/AppPropertiesTest.java`·`web/AllowedOriginsTest.java`는 증분에 없어야 한다**(decisions (5) — 있으면 설정을 잘못된 자리에 넣은 것이다).

## 검증 절차

1. **red 먼저**: 와이어 테스트를 구현 전에 돌려 실패 서명을 실측한다(현재는 404가 나온다 — 그 사실을 기록).
2. **진단 실행**: 구현 전에는 `--profile failclosed --boot-check`(step0의 `bootOnly` 규칙)로 기동만 확인하고, `files`·`bootOnly`를 이 step에서 바꾼 **직후에** `node scripts/spring-contract.mjs --profile failclosed`를 돌려 실패 지점을 확인한 뒤 구현 후 green으로 바뀌는지 대조한다.
3. **가드 순서 변이(원복)**: 토큰 검사를 503 가드보다 **앞으로** 옮겨 failclosed의 '토큰 헤더가 있어도 503' 케이스가 red인지 확인 → 원복.
4. **loopback 판정 변이(원복)**: 판정을 `host.startsWith("127.")`로 넓혀 `127.example.com` 테스트가 red인지 확인 → 원복. 반대로 `"127.0.0.1".equals(host)`로 좁혀 `127.0.0.2` 테스트가 red인지 확인 → 원복.
5. **토큰 미설정 처리 변이(원복)**: 토큰이 미설정이어도 헤더를 비교하도록 바꿔 minimal의 '아무 토큰 무시' 케이스가 red인지 확인 → 원복.
6. **`ReasonStatus` 변이(원복)**: `no-active-api-source`를 전역 표에 넣어(예: 503) `pull-ftp-source` 계약이 red인지 확인 → 원복.
7. **단일 출처 변이(원복) — MED 축**: `app.collection.host`를 `${HOST:127.0.0.1}`로 되돌리고 `@SpringBootTest(properties = "server.address=0.0.0.0")` 테스트(G-7)가 **red**인지 확인 → 원복. (red가 나지 않으면 그 테스트가 공허하다.)
8. **중복 헤더 변이(원복)**: 토큰 비교를 `request.getHeader(...)` 첫 값만 보도록 되돌려 G-8의 (i) 케이스가 red인지 확인 → 원복.
9. AC 실행. 리포 `news.db`·`uploads/` 무변 · java 프로세스 잔존 0 · 리포트·로그에 토큰 값 0건.
10. index.json step5 상태 갱신.

## 금지사항

- 수집 라우트에 세션 게이트를 붙이지 마라. 이유: `AuthClass.TOKEN`(requiresSession=false)이 이미 계약이며, 붙이면 세 파일 전부 401로 red다.
- `collection-disabled`를 `ReasonStatus` 전역 표에 넣지 마라. 이유: Node 표에 없다 — 표를 부풀리면 다른 라우트가 그 토큰을 낼 때 조용히 503이 된다.
- `no-active-api-source`·`fetch-failed`를 전역 표에 넣지 마라. 이유: fail fallback **400**이 계약이다.
- fail-closed 판정을 필터로 옮기거나 두 벌로 만들지 마라. 이유: 두 라우트가 같은 `decide()` 하나를 써야 순서가 갈리지 않는다(계약이 순서를 관측한다).
- 바인드 주소를 `InetAddress`·소켓에서 런타임 탐지하지 마라. 이유: 명시 설정 주입이 포팅 불변식이고, 탐지는 컨테이너·프록시 환경에서 갈린다.
- `app.collection.host`를 `${HOST:...}`로 직접 읽지 마라. 이유: 실제 바인드는 `server.address`가 정한다 — 출처가 둘이 되면 `SERVER_ADDRESS`만 설정된 배포에서 **수집 라우트가 무토큰으로 전 인터페이스에 열린다**.
- `AppProperties`에 필드를 추가하지 마라. 이유: record 생성자 호출부 9곳이 함께 바뀌어 증분 목록이 자기모순이 되고, 설정 소유 경계가 흐려진다(별도 `CollectionProperties`가 정답이다).
- `scripts/contract-run.mjs`·`contract/**`를 고치지 마라. 이유: 계약 정본이다.
- scope 표에 배부 계약 파일(`distribution-tick`·`distribution-disabled`)을 미리 넣지 마라. 이유: 확정 red이며, scope는 green이 되는 step(phase 72-spring-distribution step9)에서만 늘린다.
