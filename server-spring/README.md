# server-spring

기사 작성기의 **Spring Boot 서버**다(포팅 계획서 P1 — REST 계약 패리티 대상). 현행 Node 서버(`server/**`·`src/**`)와
**공존**하며, 두 서버가 같은 계약(`docs/api-contract/**`)을 만족하는지는 계약 스위트(`contract/**`)가 판정한다.
계약과 다르면 **Spring을 고친다** — Node·계약은 이 포팅에서 무수정이다.

- 좌표: groupId `harness` · artifactId `server-spring` · base package `harness.news` · Java 21 · Spring Boot 4.1.0
- 계층: `controller → service → repository → db` (컨트롤러는 shape 매핑만, 서비스는 서블릿 타입 비의존, **생성자 주입만**)
- 현재 구현 범위(phase 68 **인증/세션 축** + phase 69 **기사 도메인** + phase 70 **관리자 CRUD** + phase 71 **수집 인제스트**
  + phase 72 **배부 실행** + phase 73 **미디어·업로드·사진·번역**): 라우트 **37개**. 계약 18파일(default 12 · minimal 3 ·
  auth-negative 1 · **failclosed 1** · prod-cookie 1) = **5 프로파일**이 이 서버 대상에서 green이고 Node 리포트 대비
  **패리티 diff 0**이다 (phase 73 마감 실측 2026-08-28 — 연속 2회 동일: 관측 **296**(default 229 · minimal 55 ·
  auth-negative 4 · failclosed 5 · prod-cookie 3) · diffs 0 · 자기 결정성(`--dual-run`) 296관측 diffs 0 ·
  Java **1246 테스트 0 실패**(⑤ 코드리뷰 반려 폐색 재측정 2026-08-29 — 본문 상한 3건 + 정적 서빙 별칭 2건이
  늘었다. 관측 296·diffs 0·라우트 37은 불변) · jar 약 **35.78 MB**(clean 빌드에서도 수 KB 흔들린다 — 정확
  바이트로 인용하지 마라. 2026-08-29 clean 2회 실측 35,780,997 B와 35,778,319 B) ·
  Node 축 `npm test` **1328/1328**(2회 실행 중 1회는 `test/distribution-failure-api.test.js`가 `bad port` fetch flake로
  1건 실패했고 **재실행 2회 green** — Spring 축과 공유 자원이 없는 하네스 flake다)). **남은 것은 SSE 2개뿐**이다(아래 라우트 표).
- 설계 결정과 그 대가는 `docs/ADR.md`의 **ADR-013**에 있다(starter-security·Spring Session 미채택 · DDL 0 · 자체 필터 체인 · 패리티 판정 주체).
- **[P1·P2 마감 실측 — 위 항목의 phase 73 수치는 그 시점의 기록이고 현재값은 이것이다]** 구현 라우트는 **39/39**이고(phase 74에서 SSE 2가 닫혀 P1이 완결됐다)
  계약은 **20파일 = 5 프로파일**이다. **phase 75(P2) 마감 재실측(2026-09-04 · 연속 2회 동일 · 포터블 JDK 25.0.4.1+1)**: `./mvnw -B clean verify`
  **Tests run 1469 / Failures 0 / Errors 0 / Skipped 0**(350초·345초) · jar **38,404,108 B** · `node scripts/spring-contract.mjs --parity`와
  **`--db mysql --parity`가 각각 313관측 diffs 0**(default 246 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) · 두 모드의 `--dual-run`도 동일 ·
  `--db mysql --require-full-coverage` **39/39 · 미커버 0** · Node 축 `npm test` **1328 pass / 0 fail**.
- **저장소는 이제 둘이다 — Node=SQLite / Spring=MySQL 병존이 정상 상태다**(ADR-016 ②). 이 서버는 `DB_KIND`(`sqlite` 기본 · `mysql`)로 방언을 **명시 주입**받고
  **URL로 추론하지 않는다**(모순이면 기동 거부). MySQL 스키마의 정본은 `tools/news-migrator`의 Flyway 기반선이고 이 모듈은 여전히 **DDL 0**이다
  (`NoSchemaSqlInMainSourcesTest`는 P2에서 **0줄** 바뀌었다). 방언 철자는 **`harness/news/db/NewsDataSource.java` 한 파일**에만 있고 `DialectSeamTest`가
  파일 **집합**으로 잠근다. 운영 절차는 `docs/ops-mysql.md`, 타입·collation 매핑과 잔여 divergence는 `docs/db-mysql-mapping.md`가 소유한다.

## 구현한 라우트 · 아직 구현하지 않은 라우트

인벤토리(`docs/api-contract/endpoints.json`)의 39 라우트 중 이 서버가 **핸들러를 가진 것은 39개 — 전부다**
(`HandlerInventoryTest`가 이 집합을 **정확 일치**로 잠근다 — 목록을 늘리려면 같은 커밋에서 계약 scope 표도 늘려야 한다).
**"아직 구현하지 않은 라우트"는 phase 74에서 0이 됐다**(P1 포팅 라우트 완결). 인벤토리 **밖**의 표면 2종은 여전히 그 밖이다:
`/uploads/**` 리소스 핸들러(아래 절)와 Spring Boot 기본 `ANY /error`(`FRAMEWORK_ROUTES`).

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
| `GET /api/receiver-config` | admin(Z) | 원소 SAFE_FIELDS **10키** · `password`·`apiKey`는 쓰기 전용 시크릿(투영 밖) · 화이트리스트 AND 동등 필터 |
| `POST /api/receiver-config` | admin(Z) | 응답 `{ok,id}`뿐(시크릿 미반향) · 입력 검증 없음(계약이 동결) |
| `DELETE /api/receiver-config/:id` | admin(Z) | **이 서버 유일의 행 삭제 라우트** — 설정 행만 지우고 수집된 Article/Contents는 불변(DB 비파괴 원칙의 명시적 예외 경계, SCHEMA.md 76행). 없는 id·재삭제·비수치 id(`/abc`=NaN) 전부 200 `changes:0`(404 아님) |
| `GET /api/distribution-targets` | admin(Z) | 원소 SAFE_FIELDS **7키**(spoolDir 실림) · `active`로 자동 필터링하지 않는다(비활성 행도 목록에 남는다) |
| `POST /api/distribution-targets` | admin(Z) | 검증 순서 name→kind→spoolDir→active · 거부 5토큰(invalid-name·-kind·-spool-dir·duplicate-spool-dir·invalid-active) 전부 폴백 **400** |
| `PUT /api/distribution-targets/:id` | admin(Z) | present-only · 없는/비수치 id는 **404 not-found**(500 아님) · `{active:"N"}`이 soft delete의 두 번째 진입점 |
| `POST /api/distribution-targets/:id/deactivate` | admin(Z) | **soft delete** — 행을 지우지 않고 `active='N'` UPDATE(update와 같은 `applyPatch`로 수렴, updatedAt stamp). 제거 라우트는 없다 |
| `POST /api/collection/receive` | token | 세션 라우트가 **아니다**(`x-collection-token` + 바인드 주소). 가드 순서 **503 `collection-disabled` → 401 `unauthenticated` → 403 `unregistered`/`inactive` → 200**. `attribute='자동기사'`·`status='RDS'`로 **신규 삽입만** · payload가 없어도 200 |
| `POST /api/collection/pull` | token | 등록된 활성 API 소스를 **한 번** 호출(재시도 0 · 리다이렉트 미추종 · connect 10초 · request 30초 · 본문 16 MiB 상한)하고 응답을 receive와 같은 경로로 등록한다. 타임아웃·상한 초과는 다른 실패와 **같은 사유**(`fetch-failed`)로 접힌다. `no-active-api-source`·`fetch-failed`는 전역 표에 없고 **폴백 400**이 계약이다 |
| `POST /api/distribution/tick` | admin(Z) | 외부 cron이 당기는 **엠바고 시점 배부**(앱 내 타이머 0 — ADR-008). **body를 읽지 않는다**(핸들러에 `@RequestBody` 파라미터가 0개임을 리플렉션 테스트가 잠근다 — 시각·대상·역할 주입 경로 차단) · 응답은 화이트리스트 **6키**(`ok,at,scanned,distributed,failed,invalid`)이고 스풀 경로·파일명이 한 글자도 실리지 않는다 · 프로세스 내 single-flight(재진입은 스캔 없이 `skipped:'in-progress'` 7키) · 스풀 미설정이면 **인가 통과 후** 503 `spool-disabled` |
| `GET /api/distribution/failures` | admin(Z) | 미해소 실패 목록 — `(articleId,targetId,action)` 그룹의 **최대 id 행**이 `distribute-failed`면 미해소(`distribute-retry`면 해소). 항목 **10키**(경로성 필드 0) · `limit`은 Node `Number()` 동형(기본 200 · 상한 1000 · 반복 키는 NaN → 기본값 200) · **스풀 설정과 무관하게 항상 200**이다 |
| `POST /api/distribution/retry` | admin(Z) | 입력은 **`historyId` 하나**뿐이고 articleId·targetId·kind는 그 실패 행에서만 도출한다(ADR-004). 게이트 순서가 계약이고 **어떤 거부 경로에서도 스풀 쓰기·이력 기록이 없다** · 409 4종(`status-changed`·`kind-changed`·`stale-cycle`·`retry-in-flight`) · 서버측 장애 3토큰(`spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`)은 **이 라우트에서만** 500으로 재매핑한다(전역 표에 넣으면 배부 대상 CRUD의 400이 깨진다) · 성공은 append-only `distribute-retry` 이력 + `distributedAt` 갱신 |
| `GET /api/media/search` | session | 서버 보유 키 프록시(ADR-014) — **키가 없으면 외부 호출을 아예 하지 않고** 결정적 데모 폴백(이미지 6 · 영상 4) + `error:false`로 **graceful degrade**한다(4xx/5xx가 아니다 · 응답은 `{ok,items,error}` 3키 재조립). `type`은 `"image"` **엄격 비교**라 `?type[]=image`도 video이고, `q`는 반복 키를 콤마로 잇는 Node 규칙(`NodeString.queryText`) · 외부 URL의 값은 `NodeUri.encodeURIComponent` 이식본으로 만든다 · 호출은 **1회**뿐이다 |
| `POST /api/upload` | session | **multipart가 아니라 base64 JSON**(`{filename, contentBase64}`)이다. 게이트 순서 **타입 → 확장자 → 크기**이고 확장자는 Node `path.win32.extname` 이식본 + 화이트리스트 **14종**(`invalid-file` 400), 상한은 **디코드된 5 MiB 초과**(`too-large` 400). 디코드는 Node의 **관대한 base64**(`NodeBase64` — 알파벳 밖 문자를 버리지 않고 UTF-16 코드유닛의 하위 1바이트로 절단해 표를 찾는다. 엄격 디코더로 바꾸면 200이어야 할 요청이 500이 된다). 저장명은 **서버가 발급하는 32-hex**이고 `CREATE_NEW`로만 만든다(클라 파일명은 경로에 닿지 않는다) · uploads 루트는 **첫 저장 직전 lazy mkdir** · 응답은 `{ok,path,filename}` |
| `POST /api/photos` | session | **append-only**(수정·삭제 라우트 없음) · `registeredBy`는 **세션에서 재도출한 사용자**이고 body의 같은 이름 필드는 **읽지 않는다**(ADR-004) · `src` 없으면 `invalid-src` 400 |
| `GET /api/photos/search` | session | `q`로 `caption` 부분일치(`LIKE '%q%'` · **`ESCAPE` 없음** — 정본이 `%q%`를 그대로 바인딩한다) · **id DESC** · 빈 질의는 400이 아니라 전체 · 반복 키는 콤마 결합(Node `String(array)` 동형) · 투영은 `SELECT *`가 아니라 **6컬럼 명시**다(`id,src,caption,sourceArticleId,registeredBy,createdAt` — 컬럼이 늘어도 응답이 저절로 넓어지지 않는다) |
| `GET /api/stream` | session | **SSE**(ADR-005·ADR-015) — 로그인만 요구한다(역할 게이트 없음). 무효화 **신호**만 보내고 **행 데이터를 싣지 않는다**(payload 키가 정확히 `kind` 하나: `create`·`update`·`status`·`lock`) · 발행 지점은 컨트롤러 **11곳**(정본 `server/index.js`와 1:1) · push마다 **비연장 peek**로 세션을 재검증하고 죽었으면 `unauthorized` 1회 후 봉인 |
| `GET /api/logs/stream` | admin(Z) | **SSE**(ADR-007·ADR-015) — 로그인 + **role Z**다(게이트를 빼면 R/D가 전 사용자 요청 흔적을 본다). 401은 경로 정책 필터가, **403은 컨트롤러가** 내며 **둘 다 스트림을 열기 전 JSON**이다 · 접속 시 버퍼 **최근 2000줄**을 `event: log`로 replay한 뒤 live push · push마다 **비연장 peek + role Z 재확인**이고 강등·비활성·로그아웃이면 **그 줄을 한 줄도 쓰지 않고** 봉인한다 |
| `POST /api/articles/:id/translate` | session | 서버 보유 키 프록시(ADR-014) — 키가 없으면 **200 + `{ok:false, reason:'no-key'}` + 원문 폴백**이다(`no-key`·`error`는 `ReasonStatus`에 넣지 않았다 — 200 본문의 필드다). 번역할 본문은 **서버가 기사에서 도출**하고 요청 body의 `text`는 **쓰지 않는다**(ADR-004) · 외부 URL 인코딩은 `encodeURIComponent`가 아니라 **`URLSearchParams`**(공백이 `+`) · 빈 본문은 **호출 0회 · 2키** 응답 · 어떤 실패도 `{ok:false,reason:'error',translatedText:원문}`로 접힌다 |

**배부 대상에는 행 삭제 경로가 없다** — `DELETE /api/distribution-targets/:id`는 핸들러 미등록으로 **404**다
(Express는 method+path를 함께 매칭해 미등록 메서드를 405가 아니라 404로 떨구므로, Spring도 메서드 불일치를
`GlobalErrorHandler`에서 404로 수렴시킨다 — phase 70 `distribution-targets.contract.js`가 이 동형을 계약으로 관측한다).
같은 매핑이 **`GET /api/distribution/tick`도 404 `text/html`**로 떨군다(POST만 붙였고 그 경로에 GET 특수처리를 새로 만들지
않았다 — phase 72 실측 확인, `distribution-tick.contract.js`의 `x-distribution-tick-get` 관측).

**스텁 금지 프로브의 대상이 사라졌다** — 인벤토리 39 라우트가 전부 구현됐으므로 "미구현 라우트"라는 프로브 대상이 더는
존재하지 않는다. 그래서 phase 74 step5가 `PathPolicyWireTest`의 프로브를 **인벤토리 밖 경로**(`GET /api/undefined-path-probe`)로
옮기고 **이름도 바꿨다**(`anUndefinedPathIs404HtmlNotAJsonError`) — 의미가 "스텁 금지"에서 **"미정의 경로의 404 shape"**으로
바뀌었기 때문이다(같은 이름을 남기면 다음 사람이 스텁 금지가 여전히 지켜지는 줄 안다). 단언은 그대로 **404 +
`text/html; charset=utf-8`**이고, **스텁 금지는 이제 `HandlerInventoryTest`의 정확 집합 단언이 단독으로 지킨다.**
경로 정책 필터는 인벤토리의 `auth` 클래스를 그대로 읽어

- 세션을 요구하는 클래스(`session`·`session-role`·`admin`·`lock-holder`)는 **미인증이면 401 JSON**
  (`{"ok":false,"reason":"unauthenticated"}`) — Node가 라우트 안에서 만드는 결과와 동형이다,
- **인증된 요청은 통과시켜 404**가 되게 한다 — 구현 여부가 정직하게 드러나는 것이 의도다(스텁 금지),
- `auth: "token"` 2건(수집)은 세션 요구 대상이 **아니다**(`x-collection-token` + 바인드 주소가 유일한 방어다).
  phase 71에서 구현됐고, 그래서 그 2건은 미인증이어도 401이 아니라 **컨트롤러의 가드 순서**(503 → 401 → 403)를 만난다.

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
아니라 **경로 정규화 정책을 한 번에 다루는 별도 판단**이 필요하다. **라우트를 늘리는 phase마다 같은 divergence가 새로 생긴다** —
phase 74가 SSE 2를 붙이면서 그 표면은 **39 라우트 전부**로 넓어졌다(더 늘 곳이 없다 — P1 라우트가 완결됐다).

## SSE 두 스트림 (`GET /api/stream` · `GET /api/logs/stream`)

**근거는 `ADR-015`**(phase 74 step0 신설)다. 요점 다섯:

- **와이어 지점이 하나 더 있다.** JSON은 `JsonHttp`, SSE는 **`harness/news/web/SseHttp.java`**이며 **둘 다 같은
  `RawContentType` seam**(coyote 응답에 완성 문자열을 직접 기록)을 쓴다. 그것만이 정본 실측값
  `Content-Type: text/event-stream; charset=utf-8`의 **세미콜론 뒤 공백 1바이트와 소문자 `utf-8`**을 지킨다 —
  서블릿 API로 지정하면 컨테이너가 재조립해 그 공백이 사라지고 **전 SSE 관측이 diff**가 된다(마감 변이로 실증: 공백 1개를
  지우면 `--parity` **diffs 3**). `SseEmitter`·`ResponseBodyEmitter`·`StreamingResponseBody`·메시지 컨버터·WebFlux는 쓰지 않는다.
  seam 호출자의 **집합**(`HtmlErrors`·`JsonHttp`·`SseHttp` **셋** — `HtmlErrors`는 404 `text/html`을 낸다)을
  `SseHttpTest.exactlyThreeFilesWriteTheContentTypeBytes`가 정확 집합으로 잠근다(네 번째를 심으면 red).
- **프레임 원문.** ready는 `event: ready\ndata: {"ok":true}\n\n` **32바이트**이고 개행은 **LF만**이다.
  프레임 하나가 청크 하나이고 **write마다 flush**한다(빼면 계약 케이스가 10초 타임아웃 red). 초기 코멘트·`id:`·`retry:`·
  heartbeat·패딩은 **0건**이며 정본에도 0건이다. 종료 프레임은 `event: unauthorized\ndata: {"ok":false,"reason":"unauthenticated"}\n\n`.
  `Content-Length`는 없고 `Transfer-Encoding: chunked`다. **`Connection` 헤더는 앱이 지정하지 않는다** — 지정하면
  컨테이너 값과 겹쳐 와이어에 `keep-alive, keep-alive`가 나갔고, 손을 떼면 Tomcat 단독으로 정본과 **같은 바이트**가 나갔다(step4 실측).
- **인가 등급이 두 라우트에서 다르다.** `/api/stream`은 로그인만, `/api/logs/stream`은 로그인 + **role Z**다.
  두 라우트 모두 미인증 401은 경로 정책 필터가 **스트림을 열기 전에** 만들고, 비-Z 403은 컨트롤러가 낸다(둘 다 JSON이다 —
  200 SSE 헤더가 나간 뒤에는 거부를 상태코드로 표현할 수 없다).
- **실행 모델: 서블릿 비동기 + 트리거 스레드 직접 쓰기.** `startAsync()` + `setTimeout(0)`이라 **스트림 수명 동안 워커를
  점유하지 않고**(테스트가 `server.tomcat.threads.max=5`에서 스트림 8개를 연 채 다른 라우트의 200을 단언한다),
  프레임은 `ChangeBus.publish`/`LogService.log`를 부른 그 스레드가 쓴다. **앱 내 타이머·워커풀·재시도가 0**이라
  `Adr008DisciplineTest`의 예외 목록을 넓히지 않았다(아래 절).
- **접속 시퀀스는 정본과 동형이 아니다 — replay-gate.** 정본은 단일 스레드라 "ready 쓰기 → 구독 등록" 사이에 다른 요청이
  처리되지 않지만 **Spring은 다른 워커가 동시에 돈다**. 그 창의 신호·로그 유실을 막으려고 `SseHttp.Stream`을 **prelude 모드**로
  열고(`write`는 큐에 적재된다) 컨트롤러가 「**구독 먼저** → 스냅샷 → `writePrelude(READY)` → replay → `endPrelude(마지막 replay seq)`」
  순서로 진행한다. `endPrelude`는 write monitor 안에서 「순서키 ≤ dropUpTo 제거 → FIFO 드레인 → live 전환」을 **원자적으로** 한다.
  결과는 **ready가 첫 프레임 · 유실 0 · 중복 0 · 역전 0**이다. `open()`~`endPrelude` 구간은 `catch (RuntimeException) → seal`로
  수렴시킨다(안 하면 클라이언트가 헤더만 받고 영원히 기다린다).

**계약이 보는 것과 보지 못하는 것을 구분하라.** 계약(`sse-stream.contract.js` 10관측 + `logs.contract.js` 7관측)이 보는 것은
헤더 3종·ready 원문 바이트·쿠키 인증·`kind` 한 키·동시 2연결 fanout·세션 무효화 봉인·replay/live의 존재뿐이다.
**다음 축은 계약이 구조적으로 보지 못하며 Java 테스트가 유일한 방어선이다**(각각 변이로 실증했다):

| 축 | 유일한 방어선 |
|---|---|
| 등록 창의 신호·로그 유실(replay-gate) | `LogsStreamWireTest`의 훅 3종(`logLinesRaisedRightAfterTheSnapshotAreNotLost` 등) · `LogsStreamReplayWireTest.fiftyRoundsOfConnectingWhileLoggingLoseNothing` |
| `seq` 역전(Node에 없는 현상) | `LogServiceTest.seqNeverArrivesOutOfOrderAcrossThreads`(8스레드 × 200회) |
| replay 상한 2000 | `LogsStreamReplayWireTest.theReplayIsCappedAtTwoThousandAndKeepsTheNewest` |
| 강등(Z→D)·비활성·로그아웃 봉인 | `LogsStreamWireTest.aDemotedAdminGetsNoFurtherLogLine` 외 2 |
| push 시점 **비연장** peek(`authorizePeek`) | `LogsStreamWireTest.pushRevalidationNeverExtendsTheSessionExpiry` + 소스 철자 스캔(두 방어선은 서로를 대체하지 않는다) |
| 발행 11지점(tick·retry·collection은 계약이 영원히 못 본다) | `ChangePublishWireTest` 22건 |
| 구독 누수 0 · 워커 점유 0 · 로그 재귀 0 | `StreamWireTest`·`LogsStreamWireTest` |

**계약의 하한 함정을 그대로 적어 둔다**: `logs.contract.js`의 live-push 케이스는 `seq > seqBefore`의 **하한만** 본다(그 파일
170~178행 주석이 명시한다). 그 하한은 **늦게 도착한 replay 잔여 프레임**으로도, **SSE 요청 자신의 액세스 로그**로도 충족된다
(`RequestLogFilter`는 async 가드가 없는 plain `Filter`라 `finally`가 컨트롤러 반환 직후 돈다 — 정본은 스트림 종료 시점이라
그 줄이 스트림 중에 나가지 않는다. **관측 가능한 divergence이고 재귀는 아니다**). 그래서 구독을 `endPrelude` 뒤로 옮기거나
`endPrelude` 호출을 아예 지워도 **계약은 313관측 diffs 0으로 통과한다**(phase 74 마감 변이 M5-5·M5-5d·M6-11로 실증).

## `/uploads` 정적 서빙은 39 라우트 인벤토리 밖이다

`POST /api/upload`가 저장한 파일은 `GET /uploads/<32hex>.<ext>`로 나간다(Node `server/index.js`의
`app.use('/uploads', express.static(uploadDir))`와 같은 자리). 이것은 **컨트롤러 매핑이 아니라 리소스 핸들러**로 붙였다
(`WebConfig`의 `WebMvcConfigurer` 빈 1개 · `/uploads/**` → `file:<app.data-dir>/uploads/` · `@EnableWebMvc` 없음).
이유는 정직성이다: `@RequestMapping`을 붙이면 그 핸들러가 `RequestMappingHandlerMapping`에 나타나 **`HandlerInventoryTest`가
즉시 red**가 된다(인벤토리 39 라우트에 없는 매핑이기 때문). 리소스 핸들러는 그 목록에 나타나지 않으므로 **인벤토리 밖에**
그대로 둔다 — 계약은 이 경로를 `x-uploads-static` 유사 라우트 **1관측**으로만 본다.

- **세션을 요구하지 않는다**(미인증 200). 발행된 HTML에 재임베드된 이미지가 로드돼야 하고 Node도 그렇다 —
  URL 자체가 **capability**(32-hex 서버 발급명)다. `RoutePolicy`에 `/uploads` 행을 넣으면 계약 관측이 401로 red다(변이로 실증).
- 루트 도출은 **`AppProperties.uploadsDirPath()` 한 지점**이다(저장측 `UploadStore`와 공유). 두 곳에서 도출하면
  업로드는 200인데 서빙은 404가 되는 조용한 divergence가 생긴다. 부팅 시점에 디렉토리가 **없어도** 된다(lazy mkdir과 정합).
- `Content-Type: image/png`(**charset 없음**)를 와이어 실측으로 확인했다 — `JsonHttp`·`RawContentType`은 한 줄도 넓히지 않았다.
- **경로 탈출 9종**(`../` · `..%2f` · `%2e%2e/` · `%2e%2e%2f` · `....//` · `..%5c` · `%252e%252e/` · `..%c0%af` · 원문 `..\`)이
  전부 비-200이고 어느 응답에도 `SQLite format 3` 바이트가 없다(데이터 디렉토리에 실제 `news.db`를 둔 배치로 관측).
  형제 파일·디렉토리 목록도 노출되지 않고 응답 어디에도 서버 절대경로가 없다.
- **헤더 divergence는 고치지 않았다**: express.static은 `Cache-Control: public, max-age=0`과 약한 `ETag`를 싣지만 Spring은
  **둘 다 없다**(계약 리포트가 싣지 않는 헤더이고, 조건부 요청 304 경로를 새로 여는 것은 표면만 넓힌다).
  `.txt`의 `Content-Type`도 Node `text/plain; charset=UTF-8` 대 Spring `text/plain`(charset 없음)이다.
- **Win32 이름 별칭은 `UploadsResourceResolver`로 닫았다**(2026-08-29 ⑤ 리뷰 반영). 정본은 `fs.stat`(libuv)이고
  libuv는 경로를 `\\?\` 장문 형태로 열어 **Win32 레거시 이름 정규화를 받지 않는다** — 그래서 `x.png.`·`x.png `·`CON`이
  전부 **ENOENT**다(같은 호스트 `fs.statSync` 직접 실측). Java의 파일 접근은 그 정규화를 그대로 받으므로 손대기 전에는
  `.png.`·`.png%20`·`.png%2e`·`.png..`·`.png%20%20`·`.png%20.`·`<하위디렉토리>./<파일>` **7종이 200**(정본은 전부 404)이었고
  `CON`·`NUL`·`AUX` 등 **예약 장치명은 500**(정본 404)이었다 — 실재하는 장치로 열려 조회가 예외를 던진 것이다.
  리졸버는 세그먼트를 **퍼센트 디코딩한 뒤**(이 층의 `resourcePath`는 아직 인코딩된 원문이라 디코딩 없이는 `%2e`·`%20`이
  그대로 통과한다) 후행 점·공백과 예약 장치명을 "없는 리소스"로 접는다. 체인은 `resourceChain(false)`라 캐시 리졸버가
  끼지 않아 응답 헤더는 한 바이트도 달라지지 않는다. 반대로 **정본도 200인 셋**
  (`::$DATA` = `application/octet-stream` · `.PNG` · `./<hex>.png`)은 **그대로 둔다** — 여기서 막으면 divergence가 오히려 는다.
  이 규칙은 강화가 아니라 **정본 실측의 재현**이며, 표기별 상태코드 14종 + 장치명 12종을 `UploadsStaticWireTest`가 표로 동결한다.

**배부 실행은 phase 72에서 결선됐다**(ADR-008 이식 — 파일 스풀 outbound · 외부 cron tick pull · 앱 내 타이머 0 · 배부 축
네트워크 egress 0 · 자동 재시도·백오프·큐 0). 결선 여부를 정하는 **판정 지점은 `SpoolProperties.rootPath()` 하나**다:
`DIST_SPOOL_DIR`이 없으면 `SpoolWriter`가 없고 → `DistributionService`가 없고 → tick·retry는 **인가를 통과한 뒤** 503
`spool-disabled`, `GET /api/distribution/failures`는 스풀과 무관하게 200, **송고 즉시 배부 훅은 결선되지 않는다**
(Node `src/controllers/index.js` 71~130행 동형 · 기본 경로를 추정하지 않는다). 그래서 `minimal` 프로파일의 전이 결정성
전제가 그대로 유지된다(스풀 없음 → 훅 없음 → DES→EPS→DPS 승격 없음). 스풀이 주입된 `default`에서는 반대로 **실제 배부가
일어난다** — `distribution-tick.contract.js`가 활성 대상을 만들고 tick이 임시 스풀 디렉토리에 파일을 게시하며
(`.tmp` 쓰기 → `ATOMIC_MOVE`), `distributedAt` 갱신·`distribute` 이력·엠바고 승격(`promotedStatus: DPS`)이 관측된다.
그 파일도 `after`에서 대상을 **deactivate로 회수**하므로 활성 대상이 다른 파일과 공존하지 않는다. 추정이 아니라
`default` **229관측**을 포함한 **296관측 diffs 0**(연속 2회 · phase 73 마감 재측정 2026-08-28)으로 확인한 사실이다.
tick 응답에는 **스풀 절대경로도 스풀 파일명도 실리지 않는다**(5개 리포트 전문 문자열 검색에서 드라이브 문자로 시작하는
절대경로 0건 · `<articleId>_<stamp>.json` 패턴 0건 — 실패 사유는 예외 메시지가 아니라 **고정 토큰만** 쓴다).

그래서 계약 스위트는 **담당 도메인 파일만**(`--files`·scope 표) 돌린다. `--require-full-coverage`는 P1 도메인 phase가 전부 끝난 뒤에만
쓸 수 있다(지금 쓰면 남은 **SSE 2 라우트** 때문에 영구 red이며, 그 red가 정상이다 — Spring 대상 커버리지는 프로파일별로
`default` 29/39 · `minimal` 2/39 · `prod-cookie` 1/39이고, **Node 대상 전 프로파일 합산에서만 39/39**가 된다).

필터 순서는 계약의 일부다: **CORS(10) → 요청 로그(15) → CSRF Origin/Referer(20) → 로그인 레이트리밋(30) → 경로 정책(40)**
(`FilterOrder` 상수 단일 지점, `FilterWiringTest`가 순서를 잠근다).

## SPA 동일 출처 서빙 (`SPA_DIR` — 미설정이 기본이고 그때는 비활성이다)

phase 76 step2가 붙였다(ADR-017 결정 1). Node `server/index.js` **174~250행**(규칙 3함수)과 **1219~1238행**
(`express.static` + 폴백)의 동형이며, 규칙의 정본은 `test/spa-serving.test.js` **25항(A1~F25)**이다.
**이식하지 않으면 Electron 클라가 붙을 수 없다** — `client/lib/serverUrl.js`의 `appUrl(origin)`은 `${origin}/`이고
`client/main.js` 303행이 그것을 `loadURL`한다(클라는 자기 안에 화면이 없다).

- **설정 키는 `app.spa-dir`(환경변수 `SPA_DIR`) 하나**다. 미설정·공백·`<dir>/index.html` 부재면 **비활성**이고
  그때는 핸들러를 **하나도 등록하지 않는다** — 런타임 동작이 이 step 이전과 완전히 같다(되돌림 비용이 구조적으로 0).
  판정은 **부팅 시 1회**이고 기준은 디렉토리가 아니라 **`index.html` 파일**이다: 파일이 없는데 폴백을 켜면
  미정의 GET마다 파일 부재가 전역 에러 핸들러로 흘러 **404가 500으로 뒤집힌다**(Node `resolveSpaRoot`의 CRITICAL 주석).
- **jar에 임베드하지 않는다**(파일시스템 경로다). 화면 갱신이 jar 재빌드를 요구하지 않아야 하고, 롤백 시 Node exe 배치와
  **같은 `web/dist`를 두 서버가 공유**한다(open_questions (7)).
- **폴백 3게이트**(`SpaFallbackRules` — 순수 판정, `SpaFallbackRulesTest`가 A1~A4를 잠근다):
  ① `GET`·`HEAD`만 ② 경로를 **소문자화**해 `/api`·`/uploads`와 정확히 같거나 그 하위면 폴백 금지
  (`/apidocs`는 폴백 대상이다 — 단순 `startsWith` 금지) ③ `Accept`에 `text/html` 포함일 때만.
  `GET /`는 예외적으로 `Accept`를 보지 않는다(정본에서 `express.static`의 `index` 옵션이 처리하는 자리다).
- **인벤토리 밖이다**: `SpaHandlerMapping`(`SimpleUrlHandlerMapping`)이라 `HandlerInventoryTest`가 보는
  `RequestMappingHandlerMapping`에 나타나지 않는다(`/uploads/**` 선례). `@RequestMapping`·`@EnableWebMvc` 금지.
- **404 규약은 한 글자도 바뀌지 않는다**: SPA가 맡지 않기로 한 요청에는 매핑이 `null`을 돌려주어 요청이 **기존 경로
  그대로** 흐른다(`/uploads/**` 정적 → Boot 기본 `/**` → `NoResourceFoundException` → `GlobalErrorHandler` →
  `HtmlErrors.notFound`). 404를 직접 만들지 않는 이유가 그것이다 — 바이트가 갈리지 않는 유일한 방법이다.
  매핑 순서는 `RequestMappingHandlerMapping`(0) → **SPA(`LOWEST_PRECEDENCE-2`)** → 리소스 핸들러(`-1`)다.
- **dotfiles·Win32 이름 별칭**: 점으로 시작하는 세그먼트는 (하위까지) 서빙되지 않고(Node `dotfiles:'ignore'`),
  Win32 별칭 판정은 `/uploads`와 **같은 `LibuvNames`**를 쓴다(`x.png.`·`CON` 등 — 후자를 빼면 `/NUL`이
  **실재 장치로 열려 500**이 된다).
- **CSP는 SPA 응답에만 싣는다**(`ContentSecurityPolicy.NODE_ORIGINAL` — 값의 단일 소유 지점). Node helmet 원문과
  **바이트 동일**(344바이트)이며 **지시자는 7종이 아니라 14종**이다: `server/index.js` 494~506행이 명시한 7종 뒤에
  helmet 기본 6종(`base-uri`·`font-src`·`form-action`·`object-src`·`script-src-attr`·`upgrade-insecure-requests`)이
  따라 붙고 구분자는 **공백 없는 `;`**다(2026-09-05 원시 소켓 실측 — 소스만 읽고 조립하면 갈린다).
  **`/api`·`/uploads` 응답에는 붙이지 않았다**(나머지 보안 헤더 10종과 함께 이월 — `excluded` (d) ②) 그리고
  **HSTS는 넣지 않았다**(Node도 `forceHttps`일 때만 켠다. 평문 LAN 배치에 보내면 이후 접속이 깨진다).
- **계약은 이 면을 보지 않는다 — 실측이다.** `scripts/spring-contract.mjs`의 `javaChildEnv()`는 허용목록 방식이라
  `SPA_DIR`을 자식에게 넘기지 않는다. 2026-09-05 변이 실측: **예약 접두사에서 `/api`를 지워 미정의 `/api` 경로가
  SPA 200으로 뒤집힌 상태에서도 `--parity`는 313관측 diffs 0**이었고, **CSP를 통째로 떼어낸 상태에서도 313관측
  diffs 0**이었다. 그래서 이 축의 **유일 방어선**은 다음 파일들이다:
  `SpaFallbackRulesTest`(규칙) · `SpaServingWireTest`(와이어 20항 — 404 바이트·CSP 경계·`/uploads` 무손상) ·
  `SpaDisabledWireTest`/`SpaEmptyRootWireTest`/`SpaMissingRootWireTest`(비활성 3종) ·
  `SpaRealDistWireTest`(실제 `web/dist` — 인라인 스크립트 0·동일 출처 절대 경로) · `SpaPropertiesTest`(활성 판정).
- **`SpaRealDistWireTest`는 `web/dist`를 요구한다**(skip 하지 않는다 — 조용한 skip은 "실제 산출물을 한 번도 서빙해
  보지 않은 green"을 만든다). 그 디렉토리는 `.gitignore` 대상이므로 **`npm run build`를 먼저 돌려라**.
- **문서화된 divergence**(맞추지 않는다 · step3 대조기가 리포트에 출력한다): 문서·자산의 `Content-Type`에
  **charset 파라미터가 없다**(Node `text/html; charset=UTF-8` · 여기 `text/html`), `ETag`·`Cache-Control`이 없다,
  그리고 Node가 함께 싣는 **보안 헤더 10종**(HSTS 제외 · `X-Content-Type-Options` 등)이 없다.

## 이 서버는 스키마를 만들지 않는다

DDL을 **한 줄도 실행하지 않는다**: `ddl-auto`·`schema.sql`·`data.sql`·Flyway·Liquibase 전부 금지이고 코드에도
`CREATE`/`ALTER`/`DROP` 문자열이 없다. 스키마 생성·마이그레이션은 Node 서버(`src/db/schema.js`)가 소유한다.
행 삭제 SQL도 0이다(무효화는 soft delete·UPDATE로만).

같은 이유로 **`app.data-dir`은 필수**다. 미설정이면 기동을 거부한다 — 경로를 추정하면 설정 누락이 조용히
리포의 `news.db`를 여는 사고가 된다("모르면 뜨지 않는다").

## 빌드 · 테스트 · 실행

시스템 `java`는 1.8이라 **`JAVA_HOME`을 명시하지 않으면 빌드가 실패한다**. 포터블 JDK 25(LTS)를 쓴다.

```bash
# 테스트 포함 전체 빌드
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B verify

# 실행 가능한 jar 만들기 (target/server-spring-0.0.1-SNAPSHOT.jar)
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B package -DskipTests

# 기동 (DATA_DIR 필수 — 아래 표 참조)
DATA_DIR=/경로/임시데이터 PORT=15731 "D:/agents/tools/jdk-25.0.4.1+1/bin/java.exe" \
  -jar target/server-spring-0.0.1-SNAPSHOT.jar

# 생존 확인
curl -i http://127.0.0.1:15731/api/health   # 200 {"ok":true}
```

의존성·mvnw 배포판은 `~/.m2`에 이미 캐시돼 있어 `-o`(오프라인)로도 `verify`가 통과한다.

> **⚠ phase 75(P2) 이후 `verify`는 MySQL 서버를 요구한다 — 위 문장은 "의존성 해결"의 이야기이고 이제 그것만으로는 부족하다.**
> MySQL 관련 테스트는 접속 설정이 없으면 **skip이 아니라 fail**이다(ADR-016 ⑧ · `MysqlConfiguredGuardTest`).
> 조용한 skip을 택하면 다른 사람이 다른 날 이 스위트를 돌릴 때 P2의 모든 게이트가 **아무 말 없이 사라지기** 때문이다
> (이 리포의 게이트가 실제로 뚫린 방식이 정확히 그것이다). 대가는 오프라인·MySQL 없는 개발이 불가해지는 것이고, 그 트레이드오프는 ADR-016이 기록한다.
>
> 스위트가 요구하는 환경변수는 **6개**다 — `NEWS_CT_MYSQL_URL`·`NEWS_CT_MYSQL_USERNAME`·`NEWS_CT_MYSQL_PASSWORD`(임시 DB 측정)와
> `NEWS_APP_MYSQL_URL`·`NEWS_APP_MYSQL_USERNAME`·`NEWS_APP_MYSQL_PASSWORD`(최소 권한 계정의 스모크·권한 경계).
> **`NEWS_DB_*`라는 이름 그대로 실으면 안 된다**: 그 이름은 서버가 읽는 키라서 `DB_KIND` 기본값(`sqlite`)과 모순되어
> **모든 `@SpringBootTest`가 기동을 거부**한다(설계된 거부). 이름만 옮겨 싣는 정확한 형태는 `docs/ops-mysql.md` §3에 있다.
> 빠진 키가 있으면 실패 메시지가 **어느 키를 옮겨야 하는지 지목**한다.

## 계약 스위트로 검증하기

이 서버가 계약(`docs/api-contract/**`)을 만족하는지는 `scripts/spring-contract.mjs` 하나가 판정한다.
**"Spring을 어떻게 띄우는가"를 아는 코드는 그 파일뿐**이다(계약 러너 `scripts/contract-run.mjs`가 Node 서버에
대해 갖는 소유 경계와 동형). 이 하네스가 이후 phase의 진행률 측정 수단이다 — 각 step의 합격 기준이
"이 커맨드로 계약 파일 N개가 green"이다.

scope 표에는 지금 **5 프로파일**이 올라 있다(`default` **14파일** · `minimal` 3 · `auth-negative` 1 · `failclosed` 1 ·
`prod-cookie` 1 = 계약 **20파일**). phase 74가 끝나면서 **표의 파일 집합이 각 프로파일 디렉토리 전체와 같아졌다** —
즉 Spring 대상이 Node 대상의 전수 케이스와 같은 집합을 돈다(그 사실 자체를 하네스가 검사한다).
현재 마감 수치는 **패리티 관측 313, diffs 0**(default **246** · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3)이다.

**커버리지 함정 — `default` 단독의 `covered=32/39`는 미달이 아니다.** 이 하네스는 프로파일마다 `contract-run.mjs`를 **따로
spawn**하므로 러너가 출력하는 `covered=<n>/39`는 **그 프로파일 안에서만** 센 값이다. `39/39`는 **5 프로파일 합산에서만**
나온다(Node 대상은 한 프로세스가 5 프로파일을 전부 돌기 때문에 `npm run test:contract -- --require-full-coverage`가 곧바로
39/39다). 그래서 Spring 대상에는 **합산 게이트**를 따로 뒀다:

```bash
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" \
  npm run test:contract:spring -- --require-full-coverage
#   합산 커버리지(Spring 5리포트 · 관측 313) covered=39/39 미커버 쌍=0
```

판정 단위는 러너와 같은 **(routeId, `endpoints.json`의 `expect` 태그) 쌍**이고 `x-` 접두 관측은 제외한다.
**규칙의 정본은 `scripts/contract-run.mjs` 451~473행 `judgeCoverage`이며 하네스의 구현은 그 복제다**(러너는 무수정 목록이다) —
정본이 바뀌면 둘 다 고쳐라. 합산 대상은 **Spring 쪽 리포트만**이다(`--parity`의 Node 대조도 `--dual-run`의 b 패스도 아니다.
섞으면 Node가 관측한 쌍이 Spring의 공백을 메워 게이트가 조용히 공허해진다). 부분 실행(`--profile`·`--files`·`--boot-check`)에서는
켤 수 없게 막았다 — 확정 실패가 되고, **영구 red 게이트는 다음 사람이 무시하게 되어 없는 것보다 나쁘다.**
게이트가 비어 있지 않다는 것은 **scope 표에서 `logs.contract.js` 1행을 지워** 확인했다(**exit 1** + 미커버 4쌍 나열 +
합산 37/39). scope 표에서 행을 빠뜨리면 **다른 게이트는 조용히 통과한다** — `--parity`는 exit 0인 채 관측 수만 줄어든다
(phase 74 실측: 246 → 239).

프로파일마다 **구성 축 3개**(`host` 바인드 주소 · `spool`=`DIST_SPOOL_DIR` 주입 여부 ·
`token`=`COLLECTION_TOKEN` 주입 여부)를 갖고 그 값은 러너(`scripts/contract-run.mjs`)의 `PROFILES`와 **반드시 같다** —
갈리면 두 대상이 서로 다른 서버 구성을 측정하게 되고 그 구성 차이가 "계약 차이"로 위장된다(하네스가 실행 초반에 대조한다).

- `default` — 표준 구성(스풀·수집 토큰 있음). 인증·기사 읽기/쓰기·잠금·users·수집·배부와
  **미디어/업로드/사진/번역**(`media-upload.contract.js` — phase 73이 올린 12번째 파일)이 여기 있다.
  phase 74가 **SSE 2**(`sse-stream.contract.js` 10관측 · `logs.contract.js` 7관측 — 후자는 `logs-digest` 3관측을 함께 데려왔다)를
  올려 **14파일**이 됐다.
  **외부 API 키는 계약 env에 애초에 존재하지 않는다** — Node 자식은 러너 `cleanEnv()`가 `GOOGLE_API_KEY`·`GOOGLE_CSE_ID`·
  `YOUTUBE_API_KEY`·`GOOGLE_TRANSLATE_API_KEY` 4종을 지우고, java 자식은 `javaChildEnv()`가 **OS 허용 목록만** 통과시킨다.
  그래서 계약이 관측하는 것은 언제나 **키 없는 폴백 경로**이고, 키가 설정된 경로와 키 비유출은 계약이 아니라
  Java 단위 테스트(`HttpExternalProxyClientTest`·`MediaSearchServiceTest`·`TranslationServiceTest`)가 소유한다.
- **`minimal`** — 러너 프리셋이 `spool:false, token:false`이고 **env를 주지 않는 것**이 프로파일의 정의다. 스풀·수집 토큰이
  없으면 Node에서 배부 결선 자체가 없어 송고 훅(비동기 배부 → `syncEmbargoStatus` 승격 DES→EPS→DPS)이 발화하지 않는다
  = **전이 관측이 결정적**이다. 그래서 상태 기계 계약(`transitions.contract.js`)이 이 프로파일에 있다. phase 72가 배부를
  구현한 뒤에도 **추가 env가 필요 없다**(`extraEnv: {}`) — 두 서버 모두 스풀 루트가 없으면 배부가 전면 비활성이고
  (실행 계열 503 `spool-disabled` · 조회 200), 그 상태 자체를 `distribution-disabled.contract.js`가 직접 관측한다.
- `auth-negative` — 로그인 실패·잠금·레이트리밋 전용 인스턴스(카운터 격리).
- **`failclosed`** — phase 71이 올린 다섯 번째 프로파일. **비-loopback 바인딩(`0.0.0.0`) + 수집 토큰 미설정** = 수집이
  **fail-closed**로 잠긴 서버다(두 라우트가 503 `collection-disabled`). 구성이 곧 계약인 축이라 케이스 파일은 **하나뿐**이며
  다른 도메인을 여기에 넣지 마라 — 비-loopback 바인딩은 환경(방화벽)에 영향을 받고, 그 환경 문제로 무관한 계약이 함께
  무너지면 진단이 무너진다. 접속은 언제나 `127.0.0.1`로 하고 바인드 주소만 바꾼다.
- `prod-cookie` — `APP_ENV=production`(쿠키 Secure·SameSite=None).

```bash
# 1) jar를 먼저 만든다 — 하네스는 Maven을 호출하지 않는다(빌드 실패가 계약 실패와 섞이면 진단이 무너진다)
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests

# 2) 기동 경로만 실증(케이스 없이 기동 → /api/health → 세션 준비 → 종료·정리)
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" \
  npm run test:contract:spring -- --boot-check --profile auth-negative --profile prod-cookie

# 3) 계약 케이스 실행(프로파일 미지정 = scope 표 전부)
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" npm run test:contract:spring

# 4) Node 리포트와 기계 비교 — 이것이 패리티 판정이다
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" npm run test:contract:spring -- --parity

# 5) 대상의 자기 결정성(같은 입력 → 같은 리포트) — 프로파일마다 새 DATA_DIR + 새 프로세스로 2패스
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" npm run test:contract:spring -- --dual-run
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
| `app.data-dir` | `DATA_DIR` | **없음(필수)** | 데이터 디렉토리 절대경로. 미설정이면 기동 실패(메시지에 키·환경변수 이름 포함). **`app.db.kind=mysql` 에서도 여전히 필수다** — 아래 표 다음 문단 참조. |
| `app.db.kind` | `DB_KIND` | `sqlite` | 저장소 방언. `sqlite` \| `mysql` 만 허용하며 **그 밖의 값은 기동 실패**다(허용 값을 지목한다). **URL 을 보고 추론하지 않는다**(ADR-016 · 포팅 불변식 7): 추론하면 `DB_KIND` 누락이 조용히 옛 파일로 되돌아가고, 그 누락이 이관 중 가장 흔한 사고다. `app.db.url` 의 스킴과 **모순이면 기동을 거부**한다. |
| `app.db.url` | `NEWS_DB_URL` | 빈 값 | mysql 모드의 JDBC URL(`jdbc:mysql://호스트:포트/DB?파라미터`). **접속 파라미터는 이 값이 통째로 실어 온다 — 서버가 덧붙이지 않는다**(필수 파라미터가 없다는 것이 실측이고 선택 집합은 배포마다 다르다: `docs/db-mysql-mapping.md` §5). **자격을 URL 에 넣지 마라**(프로세스 목록·로그 유출 — `SecretHygieneTest` 가 그 형태를 리포 전역에서 금지한다). sqlite 모드에서는 무시하되 **스킴이 다르면 모순으로 거부**한다. |
| `app.db.username` | `NEWS_DB_USERNAME` | 빈 값 | mysql 모드의 계정. 운영은 최소 권한 계정(`news_app` — `SELECT/INSERT/UPDATE` + `ReceiverConfig` 테이블 단위 `DELETE` 1건)이다. |
| `app.db.password` | `NEWS_DB_PASSWORD` | 빈 값 | mysql 모드의 비밀번호. **다듬지 않는다**(앞뒤 공백도 비밀번호의 일부일 수 있다). `kind=mysql` 인데 위 3키 중 하나라도 비면 **없는 키 이름을 지목하며 기동 실패**한다 — 조용한 sqlite 폴백은 없다. |
| `app.env` | `APP_ENV` | `development` | `production`이면 프로덕션 분기(쿠키 Secure·SameSite=None, CSRF allowlist 엄격). Node의 `NODE_ENV`를 읽지 않는다. |
| `app.allowed-origins` | `ALLOWED_ORIGINS` | 빈 목록 | CORS allowlist(콤마 구분). |
| `server.port` | `PORT` | `15000` | 계약 하네스는 **[15000, 20000)**에서 빈 포트를 프로브해 주입한다(러너·verify 구간과 서로소). |
| `server.address` | `HOST` | `127.0.0.1` | **미설정이면 loopback 바인드** — `HOST` 명시 설정 시에만 LAN에 열린다(Node 서버와 동일 규율). 수집 fail-closed 판정의 입력이기도 하다(바로 아래). |
| `app.collection.token` | `COLLECTION_TOKEN` | 빈 값(미설정) | 수집 토큰. **미설정이면 `x-collection-token` 헤더를 아예 읽지 않는다**(어떤 값이 와도 무시 — loopback 바인드에서 개방). 설정돼 있으면 불일치·부재가 401이다. 빈 문자열이 '미설정'이고 **공백 1칸은 '설정됨'**이다(Node truthy 판정 그대로 — 다듬지 않는다). |
| `app.distribution.spool-dir` | `DIST_SPOOL_DIR` | 빈 값(미설정) | 배부 스풀 루트(phase 72 배선 · `AppProperties`가 아니라 별도 `SpoolProperties` record로 분리했다 — `CollectionProperties` 선례). **미설정이면 배부가 전면 비활성**이다: `POST /api/distribution/tick`·`POST /api/distribution/retry`는 **인가를 통과한 뒤** 503 `spool-disabled`, `GET /api/distribution/failures`는 **200**(스풀과 무관), 송고 즉시 배부 훅은 **결선되지 않는다**. **기본값을 하드코딩하지 않는다**(cwd·`DATA_DIR` 하위 추정 금지 — 모르면 배부하지 않는다). 값은 `NodeString.trim`으로 다듬으며 **공백만 있는 값은 '미설정'으로 수렴한다**(Node truthy 판정과 갈리는 지점 · 계약 미관측 · 방향은 안전측). |
| `app.spa-dir` | `SPA_DIR` | 빈 값(미설정) | SPA 정적 루트(phase 76 · ADR-017 결정 1 · `SpaProperties`). **미설정이면 SPA 서빙이 전면 비활성**이고 미정의 경로는 전부 기존 404 그대로다. 활성 판정은 **`<dir>/index.html` 파일 존재**이며 부팅 시 1회다(디렉토리만 있으면 비활성 — 켜면 404가 500으로 뒤집힌다). **파일시스템 경로**이고 jar 임베드는 없다. 파싱조차 불가능한 값(따옴표 포함 등)은 경고 1줄과 함께 **비활성으로 수렴**한다(기동을 죽이지 않는다). 계약 하네스는 이 키를 자식에게 넘기지 않는다. |
| `app.media.google-api-key` | `GOOGLE_API_KEY` | 빈 값(미설정) | 미디어 검색 이미지(Google CSE)용 서버 보유 키(ADR-014 · `MediaProperties`). **이미지는 키와 엔진 id가 둘 다 있어야** 외부 호출이 열린다. |
| `app.media.google-cse-id` | `GOOGLE_CSE_ID` | 빈 값(미설정) | 위와 짝이 되는 CSE 엔진 id. |
| `app.media.youtube-api-key` | `YOUTUBE_API_KEY` | 빈 값(미설정) | 미디어 검색 영상(YouTube Data v3)용 서버 보유 키. **영상은 키 하나면** 열린다. |
| `app.translate.google-api-key` | `GOOGLE_TRANSLATE_API_KEY` | 빈 값(미설정) | 번역(Google Translate v2)용 서버 보유 키(ADR-014 · `TranslateProperties` — `MediaProperties`를 4키로 넓히지 않고 분리했다). 미설정이면 `POST /api/articles/:id/translate`가 **200 + `{ok:false, reason:'no-key'}` + 원문 폴백**이다. |

미디어·번역 키 4종의 공통 규율(ADR-014): 값은 **OS 환경변수에서만** 오고 `application.properties`에 실제 키를 적지 않는다 ·
**미설정이면 외부 호출을 아예 하지 않는다**(미디어는 결정적 데모 폴백 + `error:false`) · 키 문자열은 응답·`LogService` 링 버퍼·
예외 메시지·원인 체인 어디에도 실리지 않는다(센티넬 키로 3면 단언) · **공백뿐인 값은 '미설정'으로 수렴한다**
(JS truthy는 공백 1칸을 '설정됨'으로 보므로 이것은 **의도된 divergence**이고 `app.collection.token`과 반대 선택이다 —
`.env` 오타가 조용한 egress로 번지지 않게 하는 쪽으로 틀렸다. 미설정 판정에만 다듬기를 쓰고 **설정된 키 값 자체는 원문 그대로** 쓴다).

**`app.db.kind=mysql` 에서도 `DATA_DIR` 은 필수다.** 그 값이 내는 것은 DB 경로만이 아니라 **업로드 루트**
(`AppProperties.uploadsDirPath()` = `<data-dir>/uploads/`)이기 때문이다 — mysql 모드에서는 `news.db` 파일을
열지 않을 뿐, 첨부·사진 원본은 여전히 그 디렉토리에 저장되고 `/uploads/**` 가 거기서 서빙된다.
업로드 루트에 전용 키를 만들지 않은 이유는 아래 문단과 같다(저장측과 서빙측이 갈리는 것을 막는다).
mysql 모드로 뜬 서버의 `DATA_DIR` 을 sqlite 시절과 다른 곳으로 옮기면 **기존 업로드 파일이 404 가 된다** —
컷오버 런북(`docs/ops-mysql.md`)이 그 경로를 함께 옮기는 항목을 갖는 이유다.

**업로드 루트에는 전용 환경변수가 없다** — `POST /api/upload`의 저장 위치와 `/uploads/**` 정적 서빙 위치는 둘 다
`app.data-dir` 하위의 `uploads/`이고, 그 경로를 도출하는 **유일한 지점이 `AppProperties.uploadsDirPath()`**다
(Node `resolveRuntimePaths.uploadDir`와 같은 자리). 별도 키를 만들지 않은 이유는 저장측과 서빙측이 갈리는 것을 막기 위해서다 ·
디렉토리는 부팅이 아니라 **첫 저장 직전 lazy mkdir** 한 자리에서만 만든다 · Node `createApp`의 기본값 `'uploads'`(cwd 상대)는
**이식하지 않았다**(그것을 이식하면 설정 누락이 프로세스 cwd에 파일을 쓴다).

**`app.collection.host`는 `server.address`에서 파생한다**(`app.collection.host=${server.address:127.0.0.1}`) — `${HOST:127.0.0.1}`를
한 벌 더 쓰면 **출처가 둘**이 되어, `SERVER_ADDRESS`만 설정된 배포에서 Tomcat은 전 인터페이스에 열리는데 fail-closed 판정만
`127.0.0.1`로 남는다(= 수집 2라우트가 **무토큰으로 개방**되는, fail-closed가 막으려던 바로 그 상태). 그래서 판정의 입력은
**실제 바인드 주소 하나**여야 하고, `@SpringBootTest(properties = "server.address=0.0.0.0")`에서 수집 라우트가 **503**임을
단언하는 와이어 테스트가 그 파생을 **행동으로** 잠근다(문자열 비교가 아니다). loopback 판정은 Node `isLoopbackHost`를 문자
그대로 옮겼다(`localhost`·`::1`·`[::1]`·`^127(\.\d{1,3}){3}$` — 호스트명 `127.example.com`은 loopback이 **아니다**).

## 시계

세션 만료·계정 잠금·로그 다이제스트 창은 전부 주입된 `java.time.Clock` 빈을 쓴다
(`System.currentTimeMillis()` 직접 호출 금지 — 테스트 결정성의 전제). 프로덕션 빈은 `Clock.systemUTC()`이고,
테스트는 `@TestConfiguration` + `@Primary`로 고정 시계를 끼운다(`ClockBeanTest` 참조).

## ADR-008 규율은 정적 게이트가 지킨다

이 서버는 **앱 안에서 스스로 무언가를 하지 않는다**(ADR-008: 주기 실행·비동기/재시도·아웃바운드 네트워크·파일 쓰기 금지).
문서로만 두면 지켜지지 않으므로 `Adr008DisciplineTest`가 `src/main/java` **전체를 스캔**해 금지 패턴 4군을 red로 만든다:
① 주기 실행(`@Scheduled`·`@EnableScheduling`·`TaskScheduler`·`Thread.sleep(` 등) ② 비동기·재시도(`@Async`·`@Retryable`·
`CompletableFuture.*Async` 등) ③ 네트워크 클라이언트(`HttpClient`·`RestTemplate`·`WebClient`·`new Socket(` 등)
④ 파일 쓰기(`Files.write`·`FileOutputStream`·`Files.createDirectories` 등). 판정은 주석을 제거한 뒤 하고,
애노테이션은 **한정 이름**(`@org.springframework.scheduling.annotation.Scheduled`)까지 잡는다.

**예외는 파일 단위로 정확히 4개**이며(phase 73에서 2 → 4로 늘었다) ①②는 여전히 **예외 0**이다.
네 자리는 **군마다 근거가 다르고** `theExceptionListIsExactlyFourFiles`가 목록의 크기·구성·자리(경로)를 통째로 단언한다:

- `service/HttpApiSourceFetcher.java` — ③의 예외 ①. 수집 `pull`의 아웃바운드 어댑터다(능동 수집은 아웃바운드 호출이
  **기능 그 자체**다 — `rcv.md`). 재시도 0 · 리다이렉트 미추종 · connect timeout 10초 · 본문은 UTF-8 고정.
- `service/HttpExternalProxyClient.java` — ③의 예외 ②(**phase 73 신설 · 근거는 `ADR-014`**). 미디어 검색·번역의 외부 호출을
  서버 보유 키로 대행하는 어댑터다. 71a의 안전 파라미터를 **명문 승계**한다: 재사용 필드 · connect **10초** · request **30초** ·
  본문 **16 MiB** · `Redirect.NEVER` · **`sendAsync` 금지**(블로킹 `send`에 요청 타임아웃이 없으면 Tomcat 워커를 잠식해
  전 라우트가 죽는다) · 실패는 예외가 아니라 값(`ok=false`).
- `service/SpoolWriter.java` — ④의 예외 ①. 배부 스풀 outbound 어댑터이고 파일 쓰기가 **기능 그 자체**다
  (ADR-008 (2)의 "전송은 파일 게시로만"). 같은 디렉토리의 `.tmp`에 쓰고 `ATOMIC_MOVE`로 게시 · 일반 move 폴백 없음
  · UTF-8 명시 · **throw 0**(모든 실패는 `{ok:false, reason}` 고정 토큰).
- `service/UploadStore.java` — ④의 예외 ②(**phase 73 신설**). `POST /api/upload`의 저장 어댑터다. **경로를 밖에서 받지 않는다** —
  루트는 `AppProperties.uploadsDirPath()`에서 스스로 도출하고 파일명은 서버 발급 32-hex이며 `CREATE_NEW`로만 만든다
  (문자열을 경로에 이어 붙이는 API를 노출하지 않는다는 것을 `UploadStoreTest`가 단언한다).

**군 교차는 새지 않는다** — 예외는 자기 파일의 **자기 군에만** 열린다(`UploadStore`의 `HttpClient`는 네트워크 군 위반,
`HttpExternalProxyClient`의 `Files.write`는 파일 쓰기 군 위반이다). 게이트가 마감 시점에도 살아 있음은
**군 × 파일 6종 교차 변이**로 실증했다(2026-08-28 · **6/6 red** · 각각 원복 후 pristine 사본과 byte-identical 확인):

| 심은 곳 | 심은 코드 | 실제 red를 낸 테스트 |
|---|---|---|
| `HttpApiSourceFetcher.java` | 한정 이름 `@…Scheduled(fixedDelay = 1000)` | `mainSourcesRunNoTimersOrRetries` |
| `HttpExternalProxyClient.java` | `Files.write(p, b)` | `onlyTheDeclaredWritersWriteFiles` |
| `SpoolWriter.java` | `HttpClient.newHttpClient()` | `onlyTheDeclaredOutboundAdaptersTalkToTheNetwork` |
| `UploadStore.java` | `CompletableFuture.runAsync(() -> { })` | `mainSourcesRunNoTimersOrRetries` |
| `UploadService.java`(비-예외) | `Files.write(p, b)` | `onlyTheDeclaredWritersWriteFiles` |
| `MediaSearchService.java`(비-예외) | `HttpClient.newHttpClient()` | `onlyTheDeclaredOutboundAdaptersTalkToTheNetwork` |

**네 자리가 모두 찼다** — 다음 phase가 파일을 하나 더 넣으려 하면 그것은 예외 확대이며 별도 근거·리뷰가 필요하다.
예외가 둘에서 넷이 되면서 **스캔 사각도 두 배**가 됐다는 사실을 함께 기억한다(ADR-014 트레이드오프).

**phase 74(SSE)는 이 목록을 0줄 고쳤다.** SSE는 비동기·스레드 군과 정면으로 만나는 유일한 코드인데도 예외가 필요 없었다 —
연결 유지는 서블릿 비동기 컨텍스트(`startAsync` + `setTimeout(0)`)가, 프레임 쓰기는 **트리거가 된 요청의 스레드**가 하므로
앱이 만드는 타이머·스케줄러·워커풀·백그라운드 스레드·heartbeat가 **0**이기 때문이다(ADR-015). 마감 시점에 **5종 변이**로
게이트가 살아 있음을 재확인했다(2026-08-31 · **5/5 red** · 각각 원복 후 pristine 사본과 byte-identical 확인):

| 심은 곳 | 심은 코드 | 실제 red를 낸 테스트 |
|---|---|---|
| `controller/StreamController.java`(SSE) | 한정 이름 `@…Scheduled(fixedDelay = 1000)` | `mainSourcesRunNoTimersOrRetries` |
| `controller/LogsController.java`(SSE) | `java.util.concurrent.Executors.newSingleThreadExecutor()` | `mainSourcesRunNoTimersOrRetries` |
| `web/SseHttp.java`(SSE 와이어) | `java.net.http.HttpClient.newHttpClient()` | `onlyTheDeclaredOutboundAdaptersTalkToTheNetwork` |
| `service/ChangeBus.java`(SSE 버스) | `java.nio.file.Files.write(p, b)` | `onlyTheDeclaredWritersWriteFiles` |
| `service/SpoolWriter.java`(예외 4파일 중 하나) | `Thread.startVirtualThread(() -> { })` | `mainSourcesRunNoTimersOrRetries`(군 교차 누출 금지 재확인) |

**알려진 사각 하나가 더 있다 — JDK 25가 추가한 표면이다**(기준선이 21 → 25로 옮겨진 뒤 phase 74가 조사·기록만 했다.
**패턴은 추가하지 않았다** — 게이트 확장은 그 자체가 아키텍처 결정이라 별도 ADR·리뷰가 필요하다):

| 후보 철자 | 게이트 결과 | 사실 |
|---|---|---|
| `ScopedValue`(JEP 506 · JDK 25 **정식**) | **green = 우회로** | `ChangeBus`에 `ScopedValue.where(V,"x").run(() -> {})`를 심어도 12/12 통과했다. 5군 패턴에 그 철자가 0건이다 |
| `StructuredTaskScope`(JEP 505 · 25에서도 **preview**) | **green(철자 미적중)** | 실사용은 `--enable-preview` 없이 **컴파일되지 않는다**(실측: `is a preview API and is disabled by default`). 지금은 도달 불가일 뿐 게이트가 막는 것이 아니다 |
| 모듈 import 선언(`import module java.base;`)으로 패턴 우회 | **우회되지 않는다** | 75개 패턴 전부가 `\b식별자\b`·사용 형태 매칭이고 import 문에 의존하는 패턴이 0건이다. 한정 이름으로 적어도 잡힌다(위 표의 M6-2·M6-4가 **import 없이** 한정 이름만으로 red였다) |

그 사이를 메우는 것은 이 phase가 만든 SSE 소스의 **자기 스캔**이다 — `SseHttpTest`·`StreamWireTest`·`LogsStreamWireTest`가
각자 `StructuredTaskScope`·`ScopedValue`·`Subtask` 철자 0건을 단언한다. **게이트 통과는 허가가 아니다.**

예외를 파일 단위로 두는 이유는 `ClockDisciplineTest.CLOCK_FACTORY_FILES`와 같다: **예외가 늘어나면 그 사실이 diff에 보인다.**
동시에 한계를 알고 쓴다 — 문자열을 끊어 쓰거나 리플렉션으로 만든 호출은 정적 스캔을 통과한다. 실질 방어선은 각 도메인의
**행동 단언**(요청 횟수·파일 개수·응답 키 집합)이다. 알려진 사각 하나를 명시해 둔다: **②군 패턴에 `sendAsync` 철자가 없어**
`HttpClient.sendAsync(...)`는 정적으로 잡히지 않는다(패턴이 보는 것은 `CompletableFuture.*Async(`다). 그래서 phase 73은
`HttpExternalProxyClient`가 **`sendAsync`를 한 번도 쓰지 않는다는 것을 소스 스캔 테스트로 따로 잠갔다**
(`HttpExternalProxyClientTest.theAdapterSourceHasNoAsyncSendAndNoLogSink`) —
게이트를 넓히는 대신 그 파일의 행동을 잠근 것이고, 게이트에 넣는다면 후보는 `\.\s*sendAsync\s*\(` · `\bCompletableFuture\b`다.

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
- **NULL 키 보존**(비-Z 사용자 투영)·**숫자 바인딩 표현**(`42` → `"42.0"`)·**비-ASCII 필터 값의 쿼리 왕복** — 계약 픽스처가
  그 입력을 만들지 않는다(부서가 채워진 계정·문자열 전용·ASCII 토큰). Java 와이어/단위 테스트가 유일한 관측점이다.
  `hasSnapshot`의 **정수/불리언 구분은 계약이 관측한다**(`contract/cases/default/articles-read.contract.js`가 `1`을
  단언하고 리포트 값으로도 싣는다 — ④ 테스터 변이 (k)가 default red로 실증). 와이어 **원문 문자열** 단언이 추가로 덮는 것은
  **숫자 표현**(`1` 대 `1.0` — JSON 파서를 거치면 같아진다)이다.
- 반복 쿼리 키의 **미동결 조합** 일부(`?sendOnly=1&sendOnly=0` 등) · **대괄호 표기 키**(`?status[]=RDS`) ·
  `historyId`의 비십진 표기 — 실측으로 동형을 맞췄거나(반복 키·`historyId`) 도달 경로가 없어 남겼으나(대괄호 표기)
  계약이 동결한 축이 아니다(`NodeNumberTest`·와이어 테스트가 덮는다).
- **인코딩·경로 파라미터가 붙은 인증 요청**의 도달 여부(위 divergence) — 계약 밖이며 **고치지 않았다**.
- **부트 백필 미이식** — Node 부팅은 `snapshotTitle` 빈 컬럼을 채우지만(쓰기) Spring은 하지 않고 조회 폴백으로 같은 표시 값을
  만든다. 레거시 이력 행이 있는 실 DB를 두 서버가 번갈아 여는 P3 전환기에는 **동작이 다르다**.

수집 인제스트(phase 71)가 남긴 공백 — 각 항목의 **유일한 방어선**을 함께 적는다:

- **비-loopback 바인딩의 실제 원격 접근** — `failclosed` 프로파일은 `0.0.0.0`으로 **바인드**하지만 접속은 언제나
  `127.0.0.1`이다. "다른 호스트에서 실제로 닿는가"는 이 환경에서 검증된 적이 없다(fail-closed 503 판정 자체는 계약 5관측과
  `CollectionDisabledWireTest`가 덮는다).
- **FTP 스풀 수집 경로 전체**(`RCV_SPOOL_DIR`·watcher) — HTTP 라우트가 아니라 계약이 관측하지 않고 **이식하지 않았다**.
  Node 부트 경고도 그 사실을 말한다("FTP spool ingest is unaffected").
- **부트 진단 경고**(Node `logHostDiagnostics`)를 이식하지 않았다 — 비-loopback + 토큰 미설정 서버가 뜰 때 Node가 남기는
  경고 문구가 Spring에는 없다(계약은 로그 본문을 관측하지 않는다). fail-closed **동작**은 같다.
- **수집 성공의 변경 신호(SSE)** — Node는 `receive`·`pull` 성공에서 `notifyChange('create')`를 부르지만 Spring에는 SSE 자체가
  없다(seam도 만들지 않았다). SSE 도메인 phase가 결선한다.
- **수집 토큰의 회전·만료** — 그런 개념이 Node에도 없다(값 비교뿐). 토큰이 새면 재기동 전까지 막을 수단이 없다.
- **의도된 divergence 3건**(고치지 않았고 안전 방향이다): ① 아웃바운드 `HttpClient`는 **리다이렉트를 따라가지 않는다**
  (Node `fetch`는 따라간다 — 등록된 endpoint 밖으로 요청이 새지 않는 쪽으로 틀렸다) · ② **connect 10초 + request 30초**
  (Node `fetch`에는 요청 타임아웃이 **없다**). 무한 대기의 대가가 두 서버에서 다르기 때문이다 — Node는 이벤트 루프라
  기다리는 동안에도 다른 요청을 처리하지만 Spring은 **Tomcat 워커 하나**가 묶여 응답 없는 소스 하나 + 반복 pull이 37 라우트를
  전부 굶긴다(phase 73에서 그 표면이 미디어·번역까지 넓어졌다 — 아래 참조). 타임아웃은 단일 요청의 상한일 뿐 재시도가 아니다(ADR-008 (6) 유지). · ③ **응답 본문 16 MiB 상한**
  (없으면 거대 응답의 `OutOfMemoryError`가 `catch` 밖에서 JVM을 죽인다 — Node는 V8 문자열 상한 `RangeError`가
  `fetch-failed`로 접힌다). ②③ 모두 초과 시 **기존 실패 shape 그대로**(`ok=false` → `fetch-failed`)이며 새 사유 토큰은 없다.
  **잔여 위험**: `HttpRequest.timeout`은 **응답 헤더까지만** 덮는다(JDK 21·25 실측 — 본문을 3초에 걸쳐 흘리는 서버는 상한
  500ms에도 3,082ms를 기다렸다). 본문을 천천히 흘리는 소스는 여전히 워커를 점유한다(막으려면 타이머·별도 스레드가 필요하고
  그것이 ADR-008 (3)(6) 위반이라 하지 않았다).
- **정수값의 실수 표기** — payload JSON의 `2.0`이 Node 파서에서는 `"2"`, Jackson→Java에서는 `"2.0"`으로 문자열화된다.
  JS `Number::toString` 전체 규칙(1e21 임계·지수 표기)을 부분 재구현하면 더 위험해 고치지 않았고, 전용 테스트가 가시화한다.
- **깨진 JSON 본문** — Node는 `express.json()`이 라우트보다 먼저 돌아 **가드 이전에 500**이 되고 Spring은 가드가 먼저라
  503·401이 된다(계약 미관측 — 경로 정책 필터 401과 같은 계열).

배부 실행(phase 72)이 남긴 공백 — 각 항목의 **유일한 방어선**을 함께 적는다:

- **실패 원장이 비어 있지 않은 상태의 계약(HTTP) 관측이 없다** — API만으로 결정적으로 만들 수 없다(배부 대상 CRUD가 잘못된
  `spoolDir`를 애초에 400으로 거부한다). 그래서 failures 비어 있지 않은 목록·retry 성공·409 4종·500 3종은 **실패 이력을
  리포지토리로 직접 시드한 Java 와이어/단위 테스트**(`DistributionWireTest`·`DistributionRetryServiceTest`)가 유일한 관측점이다.
  서버·파일시스템 권한을 조작해 실패를 유도하지 않았다(환경 의존이라 재현되지 않는다).
- **tick 재진입 스킵 응답**(7키 · `skipped:'in-progress'`) — 계약 스위트는 직렬 실행이라 도달하지 못한다.
  `DistributionTickServiceTest.aReentrantCallIsSkippedWithoutScanning`과 `DistributionSeamWireTest`(테스트 소스의
  `GatedSpoolWriter` 지연 seam — main에는 `Thread.sleep`이 0이다)가 유일한 방어선이다.
- **다중 인스턴스 중복 tick** — single-flight는 **프로세스 내**뿐이다(분산 락은 ADR-008이 금지한다). "외부 cron 단일 트리거"
  라는 **운영 규율**이 소유하며 앱은 막지 않는다.
- **스풀 파일을 외부 전송기가 실제로 집어가는 경로 전체** — 이 서버 밖이다(게시까지가 이 서버의 책임).
- **원자적 이동의 원자성 자체** — 단위 테스트로 증명할 수 없다. 잠근 것은 **구현 형태**뿐이다
  (`SpoolWriterTest.theAtomicPublishSequenceIsTempWriteThenAtomicMove`가 `SpoolFs` seam으로 `.tmp write → ATOMIC_MOVE`
  **호출 순서**를 단언한다).
- **엠바고 과거 시각·파싱 불가의 계약 관측** — 계약 픽스처가 전부 미래 시각이다(phase 69 공백 승계).
  `EmbargoPolicyTest`·`NodeInstantsTest`가 덮는다.
- **`Date.parse` 부분 이식 divergence**(의도적 · 안전측) — `NodeInstants`가 덮는 범위는 Z 표기 · 오프셋 표기 · `YYYY-MM-DD`
  뿐이고, **오프셋 없는 날짜-시각(`YYYY-MM-DDTHH:mm`)과 레거시 문자열은 null**이다. JS는 그것을 **로컬 시간**으로 읽으므로
  이식하면 서버 TZ가 배부 판정에 들어와 결정성이 무너진다. 틀리는 방향이 "미도래 → 배부 안 함"이고 그 사실은
  tick 응답의 `invalid` 배열로 표면화된다.
- **배부 성공의 변경 신호(SSE)** — Node는 tick 성공(**배부 1건 이상일 때만**)과 retry 성공(**거부·실패에는 보내지 않는다**)에
  `notifyChange('status')`를 부르지만 Spring에는 SSE 자체가 없다(seam도 만들지 않았다). SSE 도메인 phase가 결선한다.
- **"송고 응답의 `status`는 배부 이전 값(`finalStatus`)"** — Node는 fire-and-forget이라 자연히 그렇고 Spring은 동기 훅이라
  구현으로 지켜야 한다. **계약이 못 보는 축**이다(phase 72 step6에서 반환 status를 승격 후 값으로 바꾸는 변이를 심었더니
  당시 236관측 `--parity`가 그대로 diffs 0으로 통과했고 Java 테스트 1건만 red였다).
  `ArticleLifecycleServiceTest`의 해당 단언 1건이 유일한 방어선이다.

미디어·업로드·사진·번역(phase 73)이 남긴 공백 — 각 항목의 **유일한 방어선**을 함께 적는다:

- **키가 설정된 서버의 실제 미디어/번역 응답** — 계약 하네스가 API 키를 자식 env에서 지우므로(위 `default` 절)
  **계약 env에는 키 문자열이 애초에 존재하지 않는다**. 따라서 "계약 리포트에 키가 없다"는 사실은 아무것도 증명하지 못한다
  (리포트 위생 검사에 키 항목을 넣어도 **공허**하다). 이 축의 유일한 방어선은 `HttpExternalProxyClientTest` ·
  `MediaSearchServiceTest` · `TranslationServiceTest`의 **센티넬 키 비유출 3면 단언**(반환 맵 직렬화 전문 ·
  `LogService` 링 버퍼 전 줄 · 예외 메시지와 **원인 체인**)이다. 링 버퍼는 `GET /api/logs/digest`로 **밖으로 나간다**(ADR-007) —
  거기 들어간 한 조각은 곧 응답이다.
- **업로드 5 MiB 정확 경계** · **32-hex 저장명 충돌의 500 경로** · **동시 업로드의 디렉토리 생성 경쟁** — 계약은 관측하지 않는다
  (`UploadServiceTest`·`UploadStoreTest`가 유일한 관측점).
- **정적 서빙의 대용량 파일·`Range` 요청** · **`/uploads` 파일의 수명·정리 정책** — 앱은 업로드 파일을 지우지 않는다(**운영 소유**).
- **비-ASCII 파일명의 응답 왕복 인코딩** — 계약 픽스처는 ASCII뿐이다(확장자 도출 자체는 `UploadNamesTest`의 골든 벡터가 덮는다).
- **요청 본문 크기 상한은 `POST /api/upload` 한 라우트에만 있다**(2026-08-29 ⑤ 리뷰 반영). Node는 전역 100kb +
  기사 쓰기/업로드 2라우트만 10mb인데, 업로드는 base64 본문이라 **큰 본문을 정상적으로 받는 유일한 라우트**여서
  상한이 없으면 세션 하나로 수백 MB JSON을 밀어 힙을 태울 수 있었다. 그래서 그 라우트만 **10 MiB**로 막았고
  경계·부등호·응답을 정본 실측에 맞췄다(`10,485,760` 통과 · `+1`부터 **500 `internal-error`** — `raw-body`의 413을
  Node 전역 에러 핸들러가 `err.status`를 보지 않고 500으로 접는다). 상한은 **디코드 전 원문 바이트**에 걸리고
  `Content-Length`를 믿지 않는다(헤더 없는 chunked도 같은 경계에서 끊긴다 — 양쪽 실측 동일).
  **전역 상한(100kb)과 기사 쓰기 라우트의 10mb는 여전히 없다** — 전역 도입은 37 라우트 전부의 거부 경계를 한꺼번에
  움직이는데 그 경계를 관측하는 계약이 하나도 없다(조용히 갈릴 축을 새로 만드는 셈이다).
  단, 상한을 넘긴 요청의 **응답 시점은 갈린다**(의도된 divergence): 이 서버는 초과를 감지한 자리에서 곧바로 500이고,
  정본은 `body-parser`가 `stream.resume()` + `onFinished(req, ...)`로 **요청이 끝나기를 기다렸다가** 오류를 넘기므로
  선언한 `Content-Length`를 채우지 않고 멈춘 클라이언트에는 **응답을 아무것도 주지 않는다**(20초 관측 TIMEOUT).
  정본은 그동안 수신 바이트를 버리기만 해 힙이 늘지 않고, 이쪽은 조기 종료로 같은 보호를 준다. 계약 미관측 축이다.
- **`path.extname`을 win32 알고리즘으로 이식했다**(의도된 선택) — POSIX 호스트의 Node와 갈리는 입력이 실재한다
  (`C:.png`는 win32 400/posix 200 · `a.png\`는 win32 200/posix 400 — 계획서의 "영향 없음"은 실측으로 반증됐다).
  Node 서버가 도는 곳이 win32라 win32를 골랐고, 그 선택이 상태코드를 가른다는 사실을 `UploadNamesTest`가 잠근다.
- **번역·미디어의 잔여 divergence 3건**(기록만): `targetLang`이 객체·실수면 문자열화가 갈린다(둘 다 쓰레기 값이라
  provider가 거부해 `reason:'error'`로 수렴) · provider 응답의 `translations`가 배열이 아니라 객체 맵이면 JS는 찾아내고 Java는
  `error`다(Google v2는 배열만 준다) · 짝 없는 서러게이트 처분이 두 인코더에서 반대다
  (`encodeURIComponent`는 던지고 `URLSearchParams`는 U+FFFD로 치환 — 이식본도 그대로 따랐다).
- **`HttpRequest.timeout`의 잔여 위험이 미디어·번역까지 넓어졌다** — 71a가 실측한 것과 동일하게 **응답 헤더까지만** 덮으므로
  본문을 천천히 흘리는 외부 API는 Tomcat 워커를 계속 점유한다. 막으려면 타이머·별도 스레드가 필요하고 그것이 ADR-008 위반이다.
- **`Redirect.NEVER`는 의도된 divergence**다 — Node `fetch`는 302를 따라가지만 그 URL에는 **서버 보유 키가 들어 있다**.
  등록된 endpoint 밖으로 키가 새지 않는 쪽으로 틀렸다.

SSE 2 스트림(phase 74)이 남긴 공백 — 각 항목의 **유일한 방어선**을 함께 적는다:

- **블로킹 소비자 1개가 서버 전체를 정지시킬 수 있다 — 정본과 비대칭이다.** Node `res.write`는 **논블로킹 버퍼링**이고
  `ServletOutputStream#write`는 **블로킹**이다. 완전히 멈춘 소비자가 `LogService`의 `notifyLock`을 물면
  `RequestLogFilter`의 `finally`가 전 요청에서 그 락을 기다린다. **동시 연결 상한도 없다**(정본 `bus.setMaxListeners(0)` 동형 ·
  `sse.md`가 "구독자 수 제한이 없다"로 동결). **2026-08-31 실측(관측이지 단언이 아니다)**: 읽지 않는 소비자 하나가
  **15,112줄**을 소켓 버퍼로 흡수한 뒤에야 push가 멈췄고, 그 상태에서도 `GET /api/health`는 **2ms**에 응답했으며 정지 중에도
  액세스 로그가 **6줄** 더 쌓였다 — **"서버 전체 정지"는 재현되지 않았고** 관측된 것은 push 처리량 급락이다(응답이 액세스
  로그보다 먼저 커밋된다). 소비자를 끊으면 write 실패 → 자기 봉인 → 구독 해제로 **회복**된다(이것만 단언한다).
  **더 느린 소비자·더 많은 연결에서 어떻게 되는지는 검증된 적이 없다.** 해법(비블로킹 write · write 타임아웃 · 연결 상한)은
  전부 ADR-008 금지 철자이거나 `sse.md`가 배제한 축이라 **P2 소유**다. `LogsStreamReplayWireTest`의 관측 테스트가 유일한 계기다.
- **prelude 큐의 총 메모리에 상한이 없다.** 스트림당 상한은 `PRELUDE_MAX`(4096) 프레임이고 실측 프레임 크기는
  액세스 로그 208 B·change 39 B·ready 32 B이므로 **로그 스트림 하나당 최악 약 0.81 MiB**(`/api/stream`은 약 0.15 MiB)인데,
  **동시 연결 상한이 없어 총량은 `연결 수 × 그 값`으로 무한히 는다.** 드롭(drop-oldest) 경로는 정상 부하에서 도달 불가라고
  판단했을 뿐 **실부하로 확인하지 않았다** — `SseHttpTest`의 단위 테스트가 유일한 방어선이다.
- **실제 브라우저 `EventSource`와의 상호운용** · **웹 클라이언트(`web/**`)가 Spring 서버에 붙었을 때의 재연결 동작** —
  이 phase는 **서버측 패리티만** 소유했다(`web/**`·`client/**`는 무접촉). 계약 하네스의 `fetch` 기반 클라이언트가 유일한 관측점이다.
- **프록시·리버스프록시의 버퍼링** — `X-Accel-Buffering`은 정본도 보내지 않는다(실측). 프록시 뒤 배치는 **운영 소유**다.
- **수백 개 동시 연결**에서의 트리거 요청 지연 · **replay 2000건의 실제 전송 시간** — 측정한 적이 없다
  (테스트는 스트림 8개 · 버퍼 2500건까지만 만든다).
- **컨테이너 종료 중 열린 스트림의 정리** — 종료 훅을 만들지 않았다(만들면 앱이 스스로 하는 일이 하나 늘어난다).
- **소켓 강제 끊김에서 Tomcat이 `onError`/`onComplete`를 즉시 내지 않는다**(실측 · divergence로 기록). `setTimeout(0)`이라
  회수는 **다음 write 실패**까지 지연된다 — `/api/stream`에서는 publish **2회**가 필요했다(첫 write는 OS 버퍼에 성공하고
  두 번째가 RST를 만난다). 그래서 테스트는 "끊자마자 0"이 아니라 "끊김 후 신호를 내면 0"으로 단언한다.
- **SSE 요청 자신의 액세스 로그가 스트림이 열린 상태에서 자기 스트림으로 push된다**(정본은 스트림 종료 시점) —
  `RequestLogFilter`가 async 가드 없는 plain `Filter`이기 때문이다. **관측 가능한 divergence이고 재귀는 아니다**
  (그 write는 새 로그를 만들지 않는다). 계약은 이것을 red로 만들지 않는다(위 「하한 함정」).
