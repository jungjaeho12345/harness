# server-spring

기사 작성기의 **Spring Boot 서버**다(포팅 계획서 P1 — REST 계약 패리티 대상). 현행 Node 서버(`server/**`·`src/**`)와
**공존**하며, 두 서버가 같은 계약(`docs/api-contract/**`)을 만족하는지는 계약 스위트(`contract/**`)가 판정한다.
계약과 다르면 **Spring을 고친다** — Node·계약은 이 포팅에서 무수정이다.

- 좌표: groupId `harness` · artifactId `server-spring` · base package `harness.news` · Java 21 · Spring Boot 4.1.0
- 계층: `controller → service → repository → db` (컨트롤러는 shape 매핑만, 서비스는 서블릿 타입 비의존, **생성자 주입만**)
- 현재 구현 범위(phase 68 **인증/세션 축** + phase 69 **기사 도메인** + phase 70 **관리자 CRUD**): 라우트 **27개**. 계약 12파일
  (default 9 · minimal 1 · auth-negative 1 · prod-cookie 1) = **4 프로파일**이 이 서버 대상에서 green이고 Node 리포트 대비 **패리티 diff 0**이다
  (phase 70 마감 실측 2026-08-23: 관측 **215**(default 163 · minimal 45 · auth-negative 4 · prod-cookie 3) · diffs 0 ·
  자기 결정성 `--dual-run` 215관측 diffs 0 · default covered **23/39** · Java **661 테스트 0 실패**). 수집·배부 실행·미디어·SSE·번역은
  아직 없다(아래 라우트 표). 배부 수신처는 **검증·저장만** 하고 스풀 쓰기·tick은 배부 실행 phase 소유다(ADR-008).
- 설계 결정과 그 대가는 `docs/ADR.md`의 **ADR-013**에 있다(starter-security·Spring Session 미채택 · DDL 0 · 자체 필터 체인 · 패리티 판정 주체).

## 구현한 라우트 · 아직 구현하지 않은 라우트

인벤토리(`docs/api-contract/endpoints.json`)의 39 라우트 중 이 서버가 **핸들러를 가진 것은 27개**다
(`HandlerInventoryTest`가 이 집합을 **정확 일치**로 잠근다 — 목록을 늘리려면 같은 커밋에서 계약 scope 표도 늘려야 한다).

| 라우트 | 인증 | 비고 |
|---|---|---|
| `GET /api/health` | public | 부팅 판정 + `health.contract.js`가 잠근다 |
| `POST /api/login` | public | 계정 잠금 423(5회/15분) · IP 레이트리밋 429(15분/10회, 비-JSON 본문) |
| `POST /api/logout` | public | |
| `GET /api/session` | session | 매 요청 User 행 재도출(ADR-004) |
| `GET /api/users` | session | 역할별 투영 — Z는 6키, 비-Z는 `userId,name,department,departmentCode` 4키로 **재조립**(빼기 방식 금지) |
| `POST /api/users` | admin(Z) | 계약 픽스처 수단 — 입력 검증 없음(Node 실측 재현) |
| `PUT /api/users/:id` | admin(Z) | 없는 id도 `{ok:true, changes:0}`(동결된 계약) |
| `GET /api/logs/digest` | admin(Z) | in-memory 링 버퍼(cap 10000)의 06:00 정렬 24h 창 |
| `GET /api/articles` | session | 필터 13키 화이트리스트 · 반복 키가 IN/NOT IN이고 **콤마는 문법이 아니다** · 스칼라 전용 키를 반복하면 500(Node 실측 재현) |
| `GET /api/articles/search` | session | 리터럴이 `/{id}`보다 먼저 잡힌다(와이어로 실증) · `q` 미전달·빈 값 모두 빈 질의 |
| `GET /api/articles/:id` | session | `{ok,article,contents}` · contents는 **27키 투영**(`lockerSessionId`·`lockerClientId` 부재) · 한쪽 테이블 행이 없으면 그 키를 싣지 않는다 |
| `GET /api/articles/:id/history` | session | append-only 원장 조회 · 행 12키(본문 blob 없음) · 제목·version·status는 **조회 시 파생**(부트 백필 없음) |
| `GET /api/articles/:id/history/:historyId` | session | 스냅샷 본문 · 비정수·미존재·타 기사 스코프는 전부 404 |
| `POST /api/articles` | session-role | 서버 stamp 신뢰 경계 — `status`·`sender`·`articleId`·부서·작성자를 클라가 정하지 못한다 |
| `PUT /api/articles/:id` | lock-holder | 게이트 순서 **존재 404 → 보유자 403** · `modifier`는 세션 사용자 · `changes`는 두 갱신문의 합(실측 2) |
| `POST /api/articles/:id/lock` | session | 충돌은 **401 `locked`**(423·409가 아니다) · DPS 기사는 D 전용 · 응답은 `{ok:true}`뿐(보유자 은닉) |
| `POST /api/articles/:id/unlock` | lock-holder | 보유자가 아니면 403 `not-holder` · 멱등 200(이미 풀렸으면 아무것도 쓰지 않는다) |
| `POST /api/articles/:id/force-unlock` | session-role | D/Z 전용이고 게이트 순서가 **역할 403 → 존재 404**(다른 라우트와 반대) |
| `POST /api/articles/:id/action` | session-role | 전이표 → `(끝)` 마커 → 엠바고 DES 진입 → stamp·이력 · 사유 폴백 409 |
| `POST /api/articles/:id/derive` | session-role | `followUp`·`continue` 2모드 · 작성자는 `name ?? userId`(**null 병합** — create의 `||`와 다르다) |
| `GET /api/receiver-config` | admin(Z) | SAFE 10키 투영 · `password`·`apiKey`는 쓰기 전용 시크릿이라 어떤 응답에도 없다 · `createdAt`은 서버 미stamp라 `null` · 필터 원문 단일값(콤마 미분해) |
| `POST /api/receiver-config` | admin(Z) | 입력 검증 없음(Node 재현) · 응답은 `{ok,id}`뿐(시크릿 미반향) |
| `DELETE /api/receiver-config/:id` | admin(Z) | **이 서버 유일의 행 삭제 라우트** — `ReceiverConfig` 설정 행만 지운다(수집 Article/Contents 불변) · 재삭제·NaN id는 멱등 200 `changes:0` |
| `GET /api/distribution-targets` | admin(Z) | SAFE 7키 투영(`spoolDir` 포함 — Z 전용 관리 화면) · 필터 원문 단일값(콤마 미분해) |
| `POST /api/distribution-targets` | admin(Z) | 검증 순서 name→kind→spoolDir→active · 5종 거부 전부 폴백 400 · `createdAt`·`updatedAt` stamp |
| `PUT /api/distribution-targets/:id` | admin(Z) | present-only · 없는/비수치 id는 404 `not-found`(500 아님) · `{active:'N'}`은 soft delete 두 번째 진입점 |
| `POST /api/distribution-targets/:id/deactivate` | admin(Z) | soft delete — `active='N'`로 두고 행을 지우지 않는다(목록 생존) · 없는/비수치 id는 404 |

**배부 수신처에는 삭제 라우트가 없다**(`DELETE /api/distribution-targets/:id`는 매핑 미등록). Spring은 `PUT`이 매핑된
경로에 `DELETE`가 오면 405를 내지만, express는 method-mismatch를 404로 fall-through하므로 `GlobalErrorHandler`가 그 405를
미정의 경로와 같은 404 HTML로 접는다(Node 동형). 제거는 `active='N'` soft delete뿐이다(ADR-008·DB 비파괴).

**나머지 12 라우트에는 스텁을 만들지 않았다.** 대신 경로 정책 필터가 인벤토리의 `auth` 클래스를 그대로 읽어

- 세션을 요구하는 클래스(`session`·`session-role`·`admin`·`lock-holder`)는 **미인증이면 401 JSON**
  (`{"ok":false,"reason":"unauthenticated"}`) — Node가 라우트 안에서 만드는 결과와 동형이다,
- **인증된 요청은 통과시켜 404**가 되게 한다 — 구현 여부가 정직하게 드러나는 것이 의도다(스텁 금지),
- `auth: "token"` 2건(수집)은 세션 요구 대상이 **아니다**(`x-collection-token` + loopback 인증 — 수집 도메인 phase 소유).

경로 판정은 후행 슬래시(`/api/articles/`) · **경로 파라미터**(`/api/articles;a=b`) · **퍼센트 인코딩을 한 번 디코딩한 형태**
(`/api/artic%6Ces`)까지 본다 — Spring 디스패처는 세그먼트에서 `;name=value`를 떼어내고 퍼센트 인코딩을 디코딩해 라우팅하므로,
원문만 보면 **문자 한 개로 게이트가 통째로 우회된다**(2026-08-20 실측·회귀 테스트로 잠금: 우회 시절 미인증
`GET /api/articles;a=b`는 404였고 `POST /api/login;x=1`은 IP 레이트리밋을 무한 우회했다). 정규화 규칙은 `RoutePolicy` 한 곳이
소유하고 판정은 **넓은 쪽으로만** 틀린다(세지 않아 뚫리는 것보다 세고 나서 404가 되는 편이 안전하다).

그 규율에는 **알려진 divergence**가 딸려 있다(phase 69 step7 실측 2026-08-21 — 고치지 않고 기록한다). 라우트에 핸들러가
붙는 순간 **인증된** 요청의 도달 여부가 두 서버에서 갈린다: `GET /api/artic%6Ces/<id>`는 Node **404 text/html** · Spring
**200 JSON**이고, `GET /api/articles/<id>;v=2`는 Node 404 `{ok:false,reason:"not-found"}`(express는 `;v=2`를 id에 붙인다) ·
Spring **200**이다(디스패처가 경로 파라미터를 떼어낸다). 계약이 관측하는 축인 **미인증이면 401**은 양쪽 동형이며 그것은 경로 정책
필터가 잠근다. 고치지 않은 이유: 매칭 정책을 바꾸면 39 라우트 전부의 판정이 함께 움직이므로 도메인 phase가 개별로 판단할 것이
아니라 **경로 정규화 정책을 한 번에 다루는 별도 판단**이 필요하다. **라우트를 늘리는 phase마다 같은 divergence가 새로 생긴다.**

**배부 훅은 이 서버에 없다**(ADR-008을 따르는 배부 phase 소유 — 앱 내 타이머·직접 전송을 만들지 않았다). 그래도 패리티가
깨지지 않는 근거는 두 가지다: `minimal` 프로파일은 스풀 미설정이라 Node에서도 배부 결선 자체가 없고, `default`는 결선되지만
계약이 시드하는 DB에 **`DistributionTarget` 행이 0건**이라 송고의 관측 가능한 부수효과가 0이다(`distributedAt` 갱신·`distribute`
이력·DES→EPS 승격 어느 것도 생기지 않는다). 추정이 아니라 두 프로파일 **170관측 diffs 0**으로 확인한 사실이며, 배부 phase가
송고 훅을 붙일 때는 반드시 "명시 설정이 없으면 결선 없음"(Node `src/controllers/index.js` 동형)이어야 이 전제가 유지된다.

그래서 계약 스위트는 **담당 도메인 파일만**(`--files`·scope 표) 돌린다. `--require-full-coverage`는 P1 도메인 phase가 전부 끝난 뒤에만
쓸 수 있다(지금 쓰면 남은 12 라우트 때문에 영구 red이며, 그 red가 정상이다).

필터 순서는 계약의 일부다: **CORS(10) → 요청 로그(15) → CSRF Origin/Referer(20) → 로그인 레이트리밋(30) → 경로 정책(40)**
(`FilterOrder` 상수 단일 지점, `FilterWiringTest`가 순서를 잠근다).

## 이 서버는 스키마를 만들지 않는다

DDL을 **한 줄도 실행하지 않는다**: `ddl-auto`·`schema.sql`·`data.sql`·Flyway·Liquibase 전부 금지이고 코드에도
`CREATE`/`ALTER`/`DROP` 문자열이 없다. 스키마 생성·마이그레이션은 Node 서버(`src/db/schema.js`)가 소유한다.
행 삭제 SQL도 0이다(무효화는 soft delete·UPDATE로만).

같은 이유로 **`app.data-dir`은 필수**다. 미설정이면 기동을 거부한다 — 경로를 추정하면 설정 누락이 조용히
리포의 `news.db`를 여는 사고가 된다("모르면 뜨지 않는다").

## 빌드 · 테스트 · 실행

시스템 `java`는 1.8이라 **`JAVA_HOME`을 명시하지 않으면 빌드가 실패한다**. 포터블 JDK 21을 쓴다.

```bash
# 테스트 포함 전체 빌드
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify

# 실행 가능한 jar 만들기 (target/server-spring-0.0.1-SNAPSHOT.jar)
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B package -DskipTests

# 기동 (DATA_DIR 필수 — 아래 표 참조)
DATA_DIR=/경로/임시데이터 PORT=15731 "D:/agents/tools/jdk-21.0.12+8/bin/java.exe" \
  -jar target/server-spring-0.0.1-SNAPSHOT.jar

# 생존 확인
curl -i http://127.0.0.1:15731/api/health   # 200 {"ok":true}
```

의존성·mvnw 배포판은 `~/.m2`에 이미 캐시돼 있어 `-o`(오프라인)로도 `verify`가 통과한다.

## 계약 스위트로 검증하기

이 서버가 계약(`docs/api-contract/**`)을 만족하는지는 `scripts/spring-contract.mjs` 하나가 판정한다.
**"Spring을 어떻게 띄우는가"를 아는 코드는 그 파일뿐**이다(계약 러너 `scripts/contract-run.mjs`가 Node 서버에
대해 갖는 소유 경계와 동형). 이 하네스가 이후 phase의 진행률 측정 수단이다 — 각 step의 합격 기준이
"이 커맨드로 계약 파일 N개가 green"이다.

scope 표에는 지금 **4 프로파일**이 올라 있다(`default` 7파일 · `minimal` 1 · `auth-negative` 1 · `prod-cookie` 1 = 계약 10파일).

- `default` — 표준 구성(스풀·수집 토큰 있음). 인증·기사 읽기/쓰기·잠금·users가 여기 있다.
- **`minimal`** — 러너 프리셋이 `spool:false, token:false`이고 **env를 주지 않는 것**이 프로파일의 정의다. 스풀·수집 토큰이
  없으면 Node에서 배부 결선 자체가 없어 송고 훅(비동기 배부 → `syncEmbargoStatus` 승격 DES→EPS→DPS)이 발화하지 않는다
  = **전이 관측이 결정적**이다. 그래서 상태 기계 계약(`transitions.contract.js`)이 이 프로파일에 있다. Spring은 배부 구현이
  없어 그 상태가 구조적으로 참이고 추가 env가 필요 없다(`extraEnv: {}`).
- `auth-negative` — 로그인 실패·잠금·레이트리밋 전용 인스턴스(카운터 격리).
- `prod-cookie` — `APP_ENV=production`(쿠키 Secure·SameSite=None).

```bash
# 1) jar를 먼저 만든다 — 하네스는 Maven을 호출하지 않는다(빌드 실패가 계약 실패와 섞이면 진단이 무너진다)
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests

# 2) 기동 경로만 실증(케이스 없이 기동 → /api/health → 세션 준비 → 종료·정리)
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" \
  npm run test:contract:spring -- --boot-check --profile auth-negative --profile prod-cookie

# 3) 계약 케이스 실행(프로파일 미지정 = scope 표 전부)
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" npm run test:contract:spring

# 4) Node 리포트와 기계 비교 — 이것이 패리티 판정이다
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" npm run test:contract:spring -- --parity

# 5) 대상의 자기 결정성(같은 입력 → 같은 리포트) — 프로파일마다 새 DATA_DIR + 새 프로세스로 2패스
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" npm run test:contract:spring -- --dual-run
```

- **`JAVA_HOME`(또는 `SPRING_JAVA_HOME`·`--java-home`)이 필수다.** 시스템 `java`(1.8)로 폴백하지 않는다 —
  폴백하면 원인 불명 기동 실패가 된다. 미설정이면 하네스가 경로를 안내하고 즉시 종료한다.
- 프로파일마다 **임시 `DATA_DIR`을 새로 만들어** Node의 `src/db/schema.js`·`src/db/seed.js`로 시드하고
  전용 Spring 프로세스를 [15000, 20000) 구간의 빈 포트에 띄운다. 리포 `news.db`·`uploads/`는 **열지 않으며**
  실행 전후 스냅샷으로 무변을 단언한다(변하면 FAIL).
- `--dual-run`은 **이 하네스가 직접 수행**한다(러너에 전달하지 않는다). 같은 인스턴스에 2패스를 돌리면
  로그인 레이트리밋·계정 잠금 카운터가 누적돼 확정 red가 되기 때문이다 — 자기 결정성은 새 프로세스로만 판정한다.

### 실패했을 때 리포트 읽는 법

- 요약 마지막 줄이 판정이다: `spring-contract ok|FAILED profiles=<n> reports=<경로들> diffs=<n|->`.
  실패 사유는 stderr에 `FAIL ` 접두로 모인다.
- 리포트(`<outDir>/<profile>.json`)는 스키마 B(`{version, meta, observations, skipped}`)이고
  **마스킹·정규화가 끝난 값만** 담는다(세션 토큰·쿠키 값·비밀번호·본문 없음) — **그대로 공유해도 된다.**
  관측 매칭 키는 `(profile, routeId, tag, caseId)`이며 비교는 `scripts/contract-diff.mjs`가 소유한다.
- 리포트 디렉토리는 `--out-dir` 미지정 시 OS 임시 디렉토리(`mkdtemp`)이고 **리포 안에는 어떤 경우에도 쓰지 않는다**.
  성공 + `--keep` 없음이면 정리하고, 실패·`--keep`이면 진단 자산으로 보존한다(경로는 항상 출력한다).
- 기동 실패는 조용한 skip이 아니다 — java 자식의 stdout/stderr가 진단에 그대로 붙는다.
  (Windows 콘솔에서 JVM의 한글 메시지는 cp949라 깨져 보인다. 빌드·테스트 실패 진단은 `target/surefire-reports/`를 읽는다.)
- **`creds.json`·`targets.json`은 리포 밖 임시 디렉토리에만** 0600으로 만들어지고, 성패·`--keep`과 무관하게
  `finally`에서 **항상 삭제**된다. 리포에 쓰지 않으므로 커밋될 수 없다.

## npm 파이프라인과 분리돼 있다

Java 빌드를 npm 파이프라인에 섞지 않는다. `npm test`·`npm run lint`·`npm run build`는 이 모듈을 **보지 않는다**
(`eslint`는 `**/*.js`만 보고 `npm test`는 `test/**/*.test.js` 글롭인데, 여기에는 `.js` 파일이 없다).
반대로 Maven도 Node 쪽을 건드리지 않는다. 두 파이프라인은 각자의 커맨드로만 돈다.

## 설정 키 ↔ 환경변수

값은 전부 OS 환경변수에서 온다. `src/main/resources/application.properties`에는 **절대경로를 하드코딩하지 않는다**
— 계약 하네스가 프로파일마다 임시 `DATA_DIR`을 주입해야 하기 때문이다.

| 설정 키 | 환경변수 | 기본값 | 설명 |
|---|---|---|---|
| `app.data-dir` | `DATA_DIR` | **없음(필수)** | 데이터 디렉토리 절대경로. 미설정이면 기동 실패(메시지에 키·환경변수 이름 포함). |
| `app.env` | `APP_ENV` | `development` | `production`이면 프로덕션 분기(쿠키 Secure·SameSite=None, CSRF allowlist 엄격). Node의 `NODE_ENV`를 읽지 않는다. |
| `app.allowed-origins` | `ALLOWED_ORIGINS` | 빈 목록 | CORS allowlist(콤마 구분). |
| `server.port` | `PORT` | `15000` | 계약 하네스는 **[15000, 20000)**에서 빈 포트를 프로브해 주입한다(러너·verify 구간과 서로소). |
| `server.address` | `HOST` | `127.0.0.1` | 기본 loopback — `HOST` 명시 설정 시에만 LAN에 열린다(Node 서버와 동일 규율). |

## 시계

세션 만료·계정 잠금·로그 다이제스트 창은 전부 주입된 `java.time.Clock` 빈을 쓴다
(`System.currentTimeMillis()` 직접 호출 금지 — 테스트 결정성의 전제). 프로덕션 빈은 `Clock.systemUTC()`이고,
테스트는 `@TestConfiguration` + `@Primary`로 고정 시계를 끼운다(`ClockBeanTest` 참조).

## 테스트 규율

- 와이어 계약은 **전 기동(`RANDOM_PORT`) + 원시 HTTP 클라이언트**로만 판정한다. **MockMvc 금지** —
  이 포팅의 합격 기준은 실제 HTTP 바이트(헤더 문자열·Set-Cookie 직렬화)이고 MockMvc는 서블릿 컨테이너의
  직렬화 경로를 그대로 재현하지 않는다.
- 테스트는 리포 `news.db`를 열지 않는다. DB가 필요한 테스트는 `@TempDir`의 임시 파일 DB + **테스트 리소스에만
  존재하는 DDL 픽스처**를 쓴다(main 소스에는 DDL이 없다).

## 아직 검증되지 않은 것 (정직한 공백)

게이트가 전부 green이어도 다음은 **검증된 적이 없다**. 안전하다고 가정하지 말 것(자세한 목록·근거는
`phases/68-spring-auth/index.json`·`phases/69-spring-articles/index.json`의 `forward_notes`).

- 세션 1시간 슬라이딩 만료의 **실서버 시간축** — 계약 스위트는 시계를 주입할 수 없다(Java 단위 테스트만 덮는다).
- 로그인 `inactive` 403 경로 — 계약 스위트가 시드 계정을 비활성화하지 않아 도달 불가.
- 레이트리밋 15분 창의 **리셋** 타이밍(초과 관측까지만 동결) · 다이제스트 24h 창 경계의 실서버 검증.
- 동시성 실부하(계약 스위트는 직렬 실행이고 커넥션 풀은 1이다).
- **두 서버가 같은 `news.db`를 동시에** 여는 상황(P3 전환기) — 하네스는 프로파일마다 DB를 분리한다.
- helmet 등가 보안 헤더(CSP·X-Content-Type-Options·HSTS)·HTTPS 강제는 **구현되어 있지 않다**(계약 밖 축).

기사 도메인(phase 69)이 남긴 공백 8가지 — 각 항목의 **유일한 방어선**을 함께 적는다:

- 편집 잠금 **30분 TTL 만료**의 실서버 시간축 · **재로그인 takeover** — 계약은 시계를 주입할 수 없고 로그인 예산 규율상
  같은 사용자로 재로그인하지 않는다. `EditLockServiceTest`의 고정 시계 테스트가 유일한 방어선이다.
- **엠바고 시각 비교의 부재** — 과거 시각도 파싱 불가 문자열도 DES로 간다(Node 실측 동형). 계약 픽스처는 전부 미래 시각이라
  이 축을 관측하지 못하고 `ArticleLifecycleServiceTest`의 과거·파싱불가·동시각 3변형만 덮는다.
- `EPS`발 전이 2칸(kill→EEK · hold→EEH)과 `unknown-role` 403 — 계약 스위트에 **도달 경로가 없다**(EPS는 실제 배부 뒤에만 생기고
  시드 계정은 R/D/Z뿐). Java 단위 테스트가 리포지토리로 상태를 직접 놓아 덮는다.
- 본문 **10MB 경계** — Node는 기사 쓰기 라우트만 10mb 파서를 쓰고 Spring은 컨테이너 기본값이다(양쪽 다 미관측).
- **NULL 키 보존**(비-Z 사용자 투영)·**숫자 바인딩 표현**(`42` → `"42.0"`)·**비-ASCII 필터 값의 쿼리 왕복**·`hasSnapshot`의
  정수/불리언 구분 — 계약 픽스처가 그 입력을 만들지 않거나(부서가 채워진 계정·문자열 전용·ASCII 토큰) JSON 파서를 거치며
  구분이 사라진다. 전부 Java 와이어/단위 테스트가 유일한 관측점이다.
- 반복 쿼리 키의 **미동결 조합** 일부(`?sendOnly=1&sendOnly=0` 등) · `historyId`의 비십진 표기 — 실측으로 동형을 맞췄으나
  계약이 동결한 축이 아니다(`NodeNumberTest`·와이어 테스트가 덮는다).
- **인코딩·경로 파라미터가 붙은 인증 요청**의 도달 여부(위 divergence) — 계약 밖이며 **고치지 않았다**.
- **부트 백필 미이식** — Node 부팅은 `snapshotTitle` 빈 컬럼을 채우지만(쓰기) Spring은 하지 않고 조회 폴백으로 같은 표시 값을
  만든다. 레거시 이력 행이 있는 실 DB를 두 서버가 번갈아 여는 P3 전환기에는 **동작이 다르다**.
