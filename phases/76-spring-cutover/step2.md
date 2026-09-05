# Step 2: spa-serving

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — `baseline` (A)(B)(G) · `decisions` (1)(2)(3)(4)
- `docs/ADR.md` **ADR-017**(step1이 신설) · **ADR-013**(DDL 0 · 자체 필터 체인 · 와이어 규율) · **ADR-009**(CSRF/CORS)
- **Node 정본**: `server/index.js` **174~250행**(`SPA_EXCLUDED_PREFIXES` · `isSpaFallbackRequest` · `resolveSpaRoot` · `resolveSpaDir` · `resolveRuntimePaths`) · **1219~1238행**(마운트 순서와 폴백) · **1335~1355행**(부팅 로그)
- **Node 규칙의 정본 테스트**: `test/spa-serving.test.js` **전문 25항(A1~F25)** — 이 파일은 **무접촉**이고, 여기서는 **명세서로만** 읽는다
- `server-spring/src/main/java/harness/news/web/WebConfig.java` — 특히 `uploadsStaticResources`의 javadoc **39~65행**(왜 리소스 핸들러인가 · 왜 `@EnableWebMvc`가 아닌가 · 끝 슬래시 규율)
- `server-spring/src/main/java/harness/news/web/UploadsResourceResolver.java`
- `server-spring/src/main/java/harness/news/web/GlobalErrorHandler.java` 60~80행 · `HtmlErrors.java` 전문 · `RawContentType.java`
- `server-spring/src/main/java/harness/news/web/PathPolicyFilter.java` · `RoutePolicy.java`(무접촉) · `FilterOrder.java`
- `server-spring/src/main/java/harness/news/config/AppProperties.java` · `server-spring/src/main/resources/application.properties`
- `server-spring/src/test/java/harness/news/web/PathPolicyWireTest.java`(404 프로브) · `NotFoundWireTest` · `UploadsStaticWireTest`(리소스 핸들러 와이어 테스트의 형태를 그대로 본뜬다) · `HandlerInventoryTest`(무접촉)
- `server-spring/src/test/java/harness/news/testsupport/Wire.java`(요청줄 원문을 보내는 도구 — 인코딩 변형 시험에 필요)

## 배경

**Spring은 웹 SPA를 서빙하지 않는다.** 이것이 P3의 가장 큰 공백이고, 이 step이 그것을 메운다. Node는 `web/dist`를 **같은 출처**로 서빙하며(phase 60), Electron 클라는 자기 안에 화면이 없어 `${origin}/`을 `loadURL`한다. 즉 SPA 서빙이 없으면 **클라가 Spring에 붙을 수 없고**, 클라를 고치면 롤백 속성('클라 무변경')을 잃는다.

**이 step의 진짜 난이도는 서빙이 아니라 '아무것도 깨뜨리지 않는 것'이다.** 세 개의 살아 있는 계약이 바로 옆에 있다:

1. **미정의 경로 404 shape** — `GlobalErrorHandler.handleNotFound`가 `NoResourceFoundException` 등을 받아 `HtmlErrors.notFound`(404 + `text/html; charset=utf-8` + 고정 HTML)를 낸다. `PathPolicyWireTest.anUndefinedPathIs404HtmlNotAJsonError`(`GET /api/undefined-path-probe`, 인증됨)와 `NotFoundWireTest`(`GET /api/does-not-exist`)가 잠근다. `/**` 폴백을 잘못 붙이면 **이 요청들이 200 HTML로 뒤집힌다.**
2. **39 라우트 인벤토리** — `HandlerInventoryTest`가 `RequestMappingHandlerMapping`의 **정확 집합**을 단언한다. 컨트롤러 매핑을 붙이면 즉시 red다. 리소스 핸들러는 `SimpleUrlHandlerMapping`에 들어가 인벤토리 **밖**에 정직하게 남는다(`/uploads/**` 선례).
3. **계약 313관측 × 2축** — 하네스는 `SPA_DIR`을 자식에게 넘기지 않으므로(`javaChildEnv()`는 허용 목록 방식) **SPA 서빙이 꺼진 상태로** 313관측이 돈다. 그래서 이 step의 무회귀는 구조적이지만, **깨지면 그건 설계 위반**이다(예: 서빙을 기본 활성으로 만들었거나, 폴백이 `Accept` 게이트를 빠뜨려 API 404를 삼켰거나).
4. **CSP**(② 검토가 지목한 축) — Node는 helmet으로 **브라우저가 실행하는 문서에** CSP를 싣고 E22가 그것을 잠근다. Spring은 0건이다. **문서를 서빙하기 시작하는 이 step이 그 표면을 만들었으므로, CSP 부재는 기존 공백이 아니라 회귀다** — 아래 작업 D가 그것을 메운다(범위는 SPA 응답 1종. `/api`와 나머지 10종은 이월이며 그 경계를 테스트가 잠근다).

Node의 규칙은 `test/spa-serving.test.js` 25항이 정본이다. **그 25항을 Java 와이어 테스트로 동형 이식하는 것이 이 step의 뼈대다.**

**[② 재검토 반영] 이 step은 크다 — 절단선을 미리 정해 둔다.** 작업 A~E · 테스트 17항 · 변이 11종이다. **정체되면 작업 D(CSP)와 변이 M9~M11을 떼어 `step2b`(name: `spa-csp`)로 넘긴다.** 그 절단이 성립하는 이유: A~C+E는 **그 자체로 완결된 green**(SPA가 Node 규칙대로 서빙되고 313관측 × 2축 무회귀)이고, D는 **응답 헤더 1종을 더하는 독립 작업**이라 앞의 어떤 판정도 되돌리지 않는다. **절단하면 반드시 함께 해야 할 일 셋**: ① `step3`의 CSP 판정(SPA 경로 실패 diff)은 **step2b 완료 전까지 켜지 않는다**(켜면 step3이 구조적으로 red다 — 대신 그 시점에는 CSP를 **허용 diff로 두되 리포트에 출력**하고, step2b가 실패 diff로 승격한다) ② `excluded (d)`의 분할 재판정 문장을 **"step2b 소유"** 로 갱신 ③ **step2b를 건너뛴 채 컷오버로 진행하지 마라** — 그 경우 런북 §0 낭독 문구가 "SPA 문서에도 CSP가 없다"로 **더 나빠지므로**, 낭독 문구를 그렇게 고치는 것까지가 절단의 대가다. **절단은 기본 경로가 아니다** — CSP는 이 phase가 만든 표면의 회귀이고, 미루면 그 표면이 방어 없이 운영에 나간다.

## 작업

### A. 설정 표면 — `SPA_DIR` (미설정 = 비활성)

`application.properties`에 한 줄을 추가한다(기존 키 규율을 그대로 따른다 — 값은 OS 환경변수에서만 오고 절대경로 하드코딩 금지):

```
# SPA 정적 루트(ADR-017). 미설정(빈 값) = 서빙 비활성이다. 기본 경로를 추정하지 않는다 —
# 추정하면 설정이 없는 배포가 조용히 어딘가의 파일을 서빙한다(DIST_SPOOL_DIR와 같은 규율).
app.spa-dir=${SPA_DIR:}
```

`AppProperties`(또는 별도 `SpaProperties` — 기존 `SpoolProperties`·`MediaProperties`의 형태를 따르라)에 다음 시그니처의 판정을 둔다. **구현은 재량이되 규칙은 고정이다.**

```java
/** SPA 루트. 미설정·공백·<dir>/index.html 부재면 Optional.empty()(= 서빙 비활성)다. throw 하지 않는다. */
Optional<Path> spaRootPath();
```

- 판정 기준은 **디렉토리가 아니라 `<dir>/index.html` 파일 존재**다(Node `resolveSpaRoot`의 CRITICAL 주석 — 파일이 없는데 폴백을 켜면 404가 500으로 뒤집힌다).
- 확인은 **부팅 시 1회**다(요청마다 stat 금지).
- 비활성일 때 **핸들러를 아예 등록하지 않는다**(등록해 두고 런타임에 분기하면 404 경로가 두 갈래가 된다).
- 부팅 로그 1줄(활성일 때만 — Node `serving SPA from <root>`와 같은 자리).

### B. 서빙 — 리소스 핸들러 2개

`WebConfig`에 `uploadsStaticResources`와 **같은 형태**로 등록한다.

1. **정적 자산**: `/**` 패턴 · 위치는 SPA 루트(**끝 슬래시 강제** — `UrlResource#createRelative`가 마지막 세그먼트를 파일로 보고 잘라낸다. `WebConfig` 52~59행의 실측 주석을 그대로 따르라) · `resourceChain(false)`.
2. **폴백**: 위 핸들러의 리졸버가 **자산을 못 찾았을 때** `index.html`을 돌려줄지 판정한다.

**폴백 판정은 Node `isSpaFallbackRequest`의 규칙을 그대로 이식한다. 순수 판정으로 분리하고 단위 테스트로 잠근다:**

```java
/** 이 요청에 index.html을 돌려줘야 하는가(= 브라우저 내비게이션인가). HTTP 없이 규칙만 잠근다. */
static boolean isSpaFallbackRequest(String method, String path, String accept);
```

규칙(전부 Node 실측이다):
- `method`가 **`GET`·`HEAD`가 아니면 false**.
- `path`를 **소문자화**해 예약 접두사 `"/api"`·`"/uploads"` 와 **정확히 같거나** `"<prefix>/"` 로 시작하면 **false**. (소문자화의 이유: Express 라우팅이 기본 case-insensitive라 `/API/unknown`도 API 네임스페이스다. 대소문자를 구분하면 매칭 라우트 없는 `/API/unknown`이 HTML을 받는다 — Node 176~180행 주석.)
- `accept`가 **`text/html`을 포함하지 않으면 false**. (없으면 해시 어긋난 `/assets/*.js`가 200 HTML이 되어 화면이 조용히 깨진다 — `test/spa-serving.test.js` C16.)
- 그 외 true.

**폴백하지 않기로 판정한 요청은 리졸버가 `null`을 돌려주어 기존 404 경로(`NoResourceFoundException` → `GlobalErrorHandler` → `HtmlErrors.notFound`)로 흘러가게 한다.** 직접 `sendError`·`setStatus`로 새 404를 만들지 마라 — 바이트가 갈린다.

**경로 탈출**은 기본 `PathResourceResolver`가 위치 밖 리소스를 거부해 막는다(`UploadsResourceResolver` 선례). **dotfiles**: Node는 `{dotfiles:'ignore'}`로 `/.hidden/secret.txt`를 막는다(1226행 주석) — Spring에서도 **점으로 시작하는 세그먼트를 거부**하고 그 사실을 와이어 테스트로 잠근다.

**등록 순서 위험**: Boot 기본 `/**` 리소스 핸들러와 이 핸들러가 같은 레지스트리에 들어간다. 어느 쪽이 먼저 잡히는지에 따라 404 경로가 달라질 수 있다 — **와이어 테스트로 실제 응답을 보고 판정하라**(코드를 읽고 추론하지 마라). `/uploads/**`가 더 구체적이라 먼저 잡히는지도 **다시 확인**한다(업로드 정적 서빙이 SPA 폴백에 먹히면 이미지가 HTML이 된다).

### C. 테스트 — `test/spa-serving.test.js` 25항의 Java 동형 이식

새 와이어 테스트(예: `SpaServingWireTest`)와 순수 판정 테스트(예: `SpaFallbackRulesTest`)를 만든다. **TDD: 테스트를 먼저 쓰고 red를 본 뒤 구현한다.** 최소 항목(괄호 안은 Node 정본의 번호):

1. `isSpaFallbackRequest` 4축 — 내비게이션 true(A1) · 메서드 게이트(A2) · 예약 접두사 게이트(정확 일치·하위·**대소문자 무관**)(A3) · `Accept` 게이트(A4).
2. `GET /` → 200 + `index.html` 본문(B5).
3. `GET /assets/<실제 파일>` → 200 + 그 파일 바이트(B6).
4. `GET /list.do` (Accept: text/html) → 200 index.html(B7) · **7개 `.do` 경로 전부**(`login.do`·`writer.do`·`list.do`·`rcvMgmt.do`·`userMgmt.do`·`logs.do`·`distMgmt.do` — `web/src/app/routing.js` 7행).
5. `GET /writer.do?articleId=A1` → 200(쿼리 무관)(B8).
6. `HEAD /list.do` → 200 · 본문 없음(B9).
7. `GET /api/health` → 200 JSON(C10) · `GET /api/articles` 미인증 → **401 JSON**(C11) · `GET /api/stream` 미인증 → 401 JSON(C12).
8. `GET /api/unknown-path` → **404 + `Content-Type: text/html; charset=utf-8` + `HtmlErrors` 본문 바이트**(C13) — 그리고 **기존 두 프로브 경로**(`/api/undefined-path-probe` 인증 · `/api/does-not-exist` 미인증)도 같은 응답인지 **직접** 단언한다.
9. `GET /uploads/missing.png` → 404이며 index.html이 아니다(C14).
10. `POST /list.do` (Accept: text/html) → 404(비-GET은 폴백 대상 아님)(C15).
11. `GET /assets/does-not-exist.js` (Accept: `*/*`) → **404**(HTML 200 함정 차단)(C16).
12. **경로 탈출** — SPA 루트 밖 파일 내용이 응답에 실리지 않는다. `Wire`로 **요청줄 원문**을 보내 인코딩·이중 인코딩·백슬래시 변형을 시험한다(`UploadsStaticWireTest`의 9종 변형을 본뜬다)(C17).
13. **dotfiles** — `/.hidden/x` 류가 서빙되지 않는다.
14. **CSRF 무간섭** — SPA 활성 상태에서도 악성 Origin의 POST는 403 `forbidden-origin`(C18).
15. **비활성 경로** — `SPA_DIR` 미주입이면 미정의 경로가 전부 404(D19) · 빈 디렉토리(index.html 없음)면 404이며 **500이 아니다**(D20) · 존재하지 않는 경로면 **throw 없이** 404(D21).
16. **실제 `web/dist` 서빙 + CSP**(E22 · `test/spa-serving.test.js` **274~299행**) — 리포 `web/dist`를 루트로 주고 `index.html`·`assets/*` 왕복(파일 부재 시 skip이 아니라 **fail**로 둘지 판단하라. 이 리포에는 실재한다). **초안은 E22를 절반만 인용했다 — 그 테스트는 네 가지를 함께 단언한다**: ① `index.html` 본문이 파일과 동일 ② `<script src>`를 추출해 그대로 요청하면 200 + `javascript` 타입 ③ **응답 헤더 `content-security-policy`가 `script-src 'self'`를 포함** ④ **내용 있는 인라인 `<script>` 0건**과 **모든 `src`/`href`가 `/`로 시작(동일 출처 절대 경로)**. ③이 아래 E의 근거이고, ④는 **`web/dist`가 이미 CSP 호환으로 빌드돼 있다**는 사실의 잠금이다(그래서 Spring에 CSP를 달아도 화면이 깨지지 않는다 — 그러나 **그 사실도 실측하라**: 실제 브라우저에서 콘솔 CSP 위반 0건인지).
17. **인벤토리 무변** — `HandlerInventoryTest`가 여전히 green(핸들러 39 + 프레임워크 `/error`)임을 이 step의 AC로 확인한다.

### D. CSP — SPA 응답 1종 (② 검토 반영으로 이 step의 범위가 됐다)

**근거**(index.json `baseline` 실측 (I) · `excluded` (d) 분할 재판정): Node는 `server/index.js` **488~506행**에서 helmet을 전역으로 걸어 **브라우저가 실행하는 문서**에 CSP를 싣는다. Spring에는 0건이다. **step2가 문서를 서빙하는 순간, CSP 부재는 '원래 있던 공백'이 아니라 이 phase가 만든 표면의 회귀**다. 그리고 **계약은 이 축을 못 본다**(`contract/lib/record.js`의 허용 헤더에 보안 헤더가 없다) — 유일 방어선은 여기서 만드는 테스트다.

- **범위는 SPA 핸들러가 응답하는 것뿐이다**(폴백 `index.html` + 정적 자산). **`/api` 응답과 `/uploads` 응답에는 이 phase에서 붙이지 않는다** — 나머지 10종과 함께 이월이고(excluded (d) ②), 그 경계를 **와이어 테스트로 못 박아라**: `GET /login.do`·`GET /assets/<파일>`에는 CSP가 **있고**, `GET /api/health`·`GET /uploads/<32hex>.<ext>`에는 **없다**. 경계를 테스트로 고정하지 않으면 다음 사람이 '반쯤 붙은 상태'를 완성된 것으로 오해한다.
- **지시자는 Node 실측 7종을 그대로** 쓰고, **SPA 문서·자산 응답의 CSP는 Node 원문과 바이트 동일이어야 한다**(`default-src 'self'` · `script-src 'self'` · `img-src 'self' data: https:` · `connect-src 'self'` · `frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com` · `frame-ancestors 'self'` · `style-src 'self' 'unsafe-inline'` — **직렬화 순서·구분자·공백까지**). **[② 재검토 반영 · 판정 일원화] 초안의 「다르면 divergence로 기록」은 삭제한다** — step3 대조기가 같은 축을 **실패 diff**로 판정하므로 두 step이 어긋나면 한쪽이 반드시 거짓말을 한다. **이 축은 divergence 허용 대상이 아니다**: 값은 우리가 정하는 상수이고 컨테이너가 재조립하지 않는 평범한 헤더라, 74 `Connection`(컨테이너가 hop-by-hop을 자체 관리)의 선례가 적용되지 않는다. Node 원문을 실측해 상수에 박고 테스트가 **원문 문자열**로 단언한다. **판정 경계는 step3과 같다: SPA 문서·자산 = 바이트 동일(실패 diff) · `/api`·`/uploads` = 허용 diff(부재가 현재 설계).**
- **HSTS는 붙이지 마라.** 이유: Node도 `httpsEnforced`일 때만 켠다. 평문 HTTP LAN 배치에 HSTS를 보내면 **이후 접속이 깨진다**(`server/index.js` 489~490행 주석 · bat의 `FORCE_HTTPS` 경고와 같은 축).
- 값은 **상수 1곳**이 소유하고, 그 문자열을 테스트가 **원문으로** 단언한다.

### E. 문서

`server-spring/README.md`에 「SPA 동일 출처 서빙」 절을 신설한다: 설정 키 · 비활성이 기본인 이유 · 폴백 규칙 3게이트 · **인벤토리 밖인 이유**(`/uploads` 절과 나란히) · 404 규약과의 관계 · 계약 하네스가 이 면을 보지 않는다는 사실과 **그래서 유일 방어선이 무엇인지**(파일·메서드 이름으로) · **CSP 절**(붙인 범위 = SPA 응답만 · 붙이지 않은 범위 = `/api`·`/uploads`와 나머지 10종 · HSTS를 뺀 이유 · 그 경계를 잠그는 테스트 이름).

## Acceptance Criteria

```bash
# 1) Java 전체 (신규 테스트 포함) — Tests run 증가 · Failures/Errors/Skipped 0
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify

# 2) 계약 무회귀 2축 (jar를 먼저 굽는다 — 하네스는 스스로 빌드하지 않는다)
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity
node scripts/spring-contract.mjs --db mysql --require-full-coverage

# 3) 인벤토리·정책 파일 0줄
git diff --stat -- server-spring/src/main/java/harness/news/web/RoutePolicy.java \
  server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java \
  server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java \
  server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java   # 무출력

# 4) 무접촉 경로 0줄
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json   # 무출력
```

- 2번의 두 `--parity`가 각각 **313관측 diffs 0**, `--require-full-coverage`가 **39/39 · 미커버 0쌍**.
- 3·4번 `git diff --stat`이 **무출력**.
- **변이 전건 결과표(필수 · 미기록 시 step 미완)** — 최소 8종을 심어 red를 보고 **원복(바이트 동일 확인)** 한다:
  - **M1** `Accept` 게이트 제거 → 기대: C16 동형 테스트 red(`/assets/does-not-exist.js`가 200 HTML).
  - **M2** 예약 접두사에서 `/api` 제거 → 기대: 404 프로브 3종 red(`/api/unknown-path`·`/api/undefined-path-probe`·`/api/does-not-exist`가 200).
  - **M3** 예약 접두사 비교에서 소문자화 제거 → 기대: `/API/unknown` 케이스 red.
  - **M4** 예약 접두사에서 `/uploads` 제거 → 기대: C14 동형 red.
  - **M5** 메서드 게이트 제거(POST 허용) → 기대: C15 동형 red.
  - **M6** 활성 판정을 `index.html` 파일에서 **디렉토리 존재**로 바꿈 → 기대: D20 동형 red(404가 500이 된다).
  - **M7** 위치 문자열의 끝 슬래시 제거 → 기대: 형제 파일이 서빙되는지 확인하는 테스트 red(`UploadsStaticWireTest.theSiblingOfTheUploadsRootIsNotServed` 동형).
  - **M8** SPA 핸들러를 컨트롤러 매핑(`@GetMapping`)으로 바꿈 → 기대: **`HandlerInventoryTest` red**(이 변이는 '왜 리소스 핸들러인가'를 실증한다).
  - **M9** CSP 헤더를 아예 붙이지 않음 → 기대: E22 동형 테스트 red. **그리고 같은 상태에서 `--parity`를 돌려 313관측 diffs 0인지 재라** — 0이면 "계약은 보안 헤더를 구조적으로 못 본다"가 실측으로 확정된다(그 문장을 README·forward_notes에 넣어라).
  - **M10** CSP를 `/api` 응답에도 붙임(범위 초과) → 기대: 경계 잠금 테스트(`GET /api/health`에 CSP가 **없다**) red. **범위를 넘는 변경도 red가 되게 하는 것이 이 게이트의 목적**이다(반쯤 붙은 상태를 완성으로 오해하지 않게).
  - **M11** `script-src`를 `'self' 'unsafe-inline'`으로 완화 → 기대: 상수 원문 단언 red. **완화가 조용히 통과하지 않는지**의 실증이다(E22 주석이 "red면 CSP 완화가 아니라 빌드 설정을 의심하라"고 적은 그 축).
  - 각 변이에 **기대 / 실제 / 어느 테스트가 잡았나 / 원복 확인**을 적는다. **기대와 실제가 다르면 그것이 발견이다 — 숨기지 마라.**
- 추가 관측 기록: **M2를 심은 채 `--parity`를 돌려 diffs가 0인지** 재라. 0이면 "계약은 이 결함을 못 본다"가 실측으로 확정되고, 그 문장을 README와 forward_notes에 넣는다(추측으로 적지 마라).

## 검증 절차

1. TDD 순서를 지켜라: 25항 동형 테스트를 먼저 쓰고 **전부 red**인 것을 본 뒤 구현한다.
2. `clean verify`를 쓴다(IDE가 `target/`에 남긴 클래스 때문에 `Tests run: 0` + FAILURE가 난다).
3. 계약 하네스와 `mvnw verify`를 **동시에 돌리지 마라**.
4. 실제 브라우저로 한 번 열어 본다(수동 · 판정은 자동 테스트가 한다): `SPA_DIR=<리포>/web/dist DATA_DIR=<임시> PORT=15xxx java -jar server-spring/target/*.jar` 후 `http://127.0.0.1:15xxx/login.do`. **개발자 콘솔에서 CSP 위반 0건**과 화면이 실제로 뜨는지를 함께 본다(CSP를 붙인 뒤 화면이 깨지면 그것은 지시자가 Node와 다르다는 신호다). **리포 `news.db`를 가리키지 마라** — 임시 `DATA_DIR`을 만들어 써라.
5. 변이 실행마다 출력에 **`Tests run:` 이 있는지** 확인한다(없으면 그 실행은 무효다).

## 되돌림 절차

- 코드 되돌림: 이 step이 추가한 파일 삭제 + `application.properties`·`WebConfig`의 추가분 제거. `SPA_DIR`을 주지 않으면 **런타임 동작은 이 step 이전과 완전히 같다**(비활성이 기본이라 되돌림 비용이 구조적으로 0에 가깝다 — 그것이 이 설계의 이점이다).
- 운영 되돌림: 해당 없음(아직 운영에 아무것도 배포하지 않았다).

## 금지사항

- **`@RequestMapping`/`@GetMapping` 컨트롤러로 SPA를 서빙하지 마라.** 이유: `HandlerInventoryTest`가 즉시 red이고, 그것을 피하려 인벤토리에 행을 더하는 것은 계약 명세 수정이라 금지다.
- **`@EnableWebMvc`를 쓰지 마라.** 이유: Boot 기본 MVC 설정이 통째로 꺼져 39 라우트가 함께 움직인다(`WebConfig` 63행).
- **404를 직접 만들지 마라(`sendError`·`setStatus`+본문).** 이유: `HtmlErrors`가 소유한 바이트와 갈리고, `RawContentType`을 거치지 않으면 컨테이너가 Content-Type을 재조립해 Node와 어긋난다(ADR-013 ④).
- **`RoutePolicy`에 SPA 경로를 넣지 마라.** 이유: 세션을 요구하는 순간 로그인 화면 자체가 401이 되고, 그 파일은 무접촉이다.
- **계약 하네스에 `SPA_DIR`을 넘기도록 고치지 마라.** 이유: 계약 리포트가 SPA 응답을 관측하기 시작해 Node/Spring 두 대상의 프로파일 구성이 갈린다(decisions (4)).
- **jar 안에 SPA를 임베드하지 마라.** 이유: 화면 갱신마다 jar 재빌드가 필요해지고, 롤백 시 Node와 다른 산출물을 보게 된다(open_questions (7)).
- **`web/**`·`client/**`·`test/**`를 고치지 마라.** 이유: 무수정이 롤백 속성의 근거다. `test/spa-serving.test.js`는 **명세서로만** 읽는다.
- **캐시·ETag·`Cache-Control`을 새로 켜지 마라.** 이유: 조건부 요청 304 경로를 새로 열면 표면만 넓어진다(`WebConfig` 64~65행이 `/uploads`에서 이미 내린 판단).
