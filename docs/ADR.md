# Architecture Decision Records

## 철학
외부 의존성을 최소화하고 언어/런타임 표준 기능을 우선한다(런타임 의존성은 Express와 보안 미들웨어뿐, DB·번들러·테스트는 내장/표준 도구 사용). 모든 기능은 테스트를 먼저 작성(TDD)하고 작동하는 최소 구현을 선택한다. 
신뢰 경계는 서버에 둔다 — 클라이언트가 보낸 값(특히 권한)은 신뢰하지 않는다. 
DB의 데이터는 절대 삭제하지 않는다(비파괴·멱등 마이그레이션만 허용).

---

### ADR-001: Vite + React SPA + 독립 Express API 서버 (Next.js 풀스택 대신)
**결정**: 프론트엔드는 Vite로 빌드하는 순수 클라이언트 React 19 SPA(`:5173`), 백엔드는 별도 Express REST/SSE 서버(`127.0.0.1:3001`)로 분리한다. 두 계층은 HTTP로만 통신한다.
**이유**: 사내 기사 작성 도구라 SEO/SSR 이점이 없다. SPA + 얇은 API 서버로 분리하면 프론트/백 경계가 명확해지고, API 서버를 테스트에서 in-memory 의존성으로 주입할 수 있다. Vite는 설정이 가볍고 HMR이 빠르다.
**트레이드오프**: SSR 대비 first-paint가 느리고 SEO가 불가하다. 두 origin 간 CORS와 세션 헤더(`x-session-id`) 전파 배선을 직접 관리해야 한다.

### ADR-002: Node.js 내장 SQLite(`node:sqlite`) + 직접 SQL (외부 DB/ORM 대신)
**결정**: 데이터는 Node 22의 내장 모듈 `node:sqlite`(`DatabaseSync`)로 단일 파일 `news.db`에 저장한다. ORM 없이 모델 계층에서 직접 SQL을 쓰고, User/Article/Contents 3개 테이블만 둔다(FK 미선언, 정합성은 애플리케이션이 유지).
**이유**: 외부 DB 서버·드라이버·ORM 의존성을 0으로 만든다. 단일 파일이라 백업/이식이 쉽고, 테스트는 in-memory DB로 빠르게 격리된다. 스키마 변경은 `CREATE TABLE IF NOT EXISTS`/additive `ALTER`만 사용해 기존 데이터를 보존한다(DB 비파괴 원칙).
**트레이드오프**: `--experimental-sqlite` 플래그와 Node ≥22.5가 필요한 실험적 API다. 동시 쓰기·수평 확장이 불가하고, 마이그레이션과 참조 정합성을 애플리케이션이 직접 책임진다.

### ADR-003: 주입 가능한 Model 계약으로 전송 계층 추상화 (프론트엔드 MVC)
**결정**: 프론트엔드를 Model/View/Controller로 분리하고, Model을 `freeze`된 메서드 집합(`MODEL_KEYS`)을 따르는 주입형 인터페이스(`contract.js`)로 정의한다. 실제 REST/SSE 배선은 `httpModel` 뒤에 격리하고, 테스트는 `fakeModel`을 주입한다.
**이유**: View/Controller를 transport-agnostic하게 유지하면 UI 로직을 실제 네트워크 없이 단위 테스트할 수 있다. 이 계약이 프론트와 백엔드 서비스 계약을 잇는 단일 통합 seam이 되어, 응답 shape 불일치를 한 곳에서 검증할 수 있다.
**트레이드오프**: 계약이라는 간접 계층이 추가되고, 백엔드 응답 shape과 `MODEL_KEYS`를 수동으로 동기화해야 한다(JS라 타입 강제가 없다).

### ADR-004: 세션 기반 서버측 인가 — 역할은 세션에서만 도출 (클라이언트 role 불신)
**결정**: 모든 보호된 라우트의 acting role은 `x-session-id`로 검증한 서버 세션에서만 도출하고, `req.body.role`은 신뢰하지 않는다. 세션은 1시간 슬라이딩 idle 만료를 가지며, R(기자)/D(데스크)/Z(관리자) 역할 게이트로 편집 잠금·송고/보류/킬·사용자/수신설정 관리를 강제한다.
**이유**: 클라이언트가 보낸 역할 값을 신뢰하면 권한 상승이 가능하다. 신뢰 경계를 서버에 두어 인가를 단일 지점에서 강제하고, 비밀번호는 bcrypt 해시로 저장한다. helmet(CSP)·CORS allowlist·로그인 레이트리밋으로 표면을 추가로 좁힌다. 세션 신원(role/active 등)은 **로그인 시점 스냅샷이 아니라 매 요청 User 행 재조회로 재도출**한다(세션 가드가 세션 스토어를 감싸고, 합성 루트가 모든 소비처에 그것만 주입한다) — 행이 없거나 `active='N'`이면 그 세션을 즉시 무효화한다.
**트레이드오프**: 서버 세션 스토어가 필요하다(현재 in-process라 다중 인스턴스 시 공유 스토어로 교체해야 함). 세션ID가 HttpOnly 쿠키가 아닌 헤더 방식이라 쿠키 전환·HTTPS 강제 등 추가 하드닝이 후속 과제로 남는다. 재도출 대가로 인증된 요청마다 User PK 조회가 1회 늘고(in-process SQLite, 마이크로초) DB 장애가 인가 게이트에서 먼저 드러나지만, 비활성화·역할 강등이 재로그인 없이 즉시 반영된다(캐시·TTL 없음).

### ADR-005: SSE 단방향 무효화 스트림으로 실시간 동기화 (WebSocket 대신)
**결정**: 기사 생성/수정/상태전이/편집잠금 변경을 서버 in-process `EventEmitter` → SSE(`/api/stream`)로 브로드캐스트한다. 페이로드는 행 데이터가 없는 "무효화 신호"이며, 클라이언트가 자기 필터로 재조회한다.
**이유**: 동기화는 서버→클라이언트 단방향이면 충분하다(클라이언트 변경은 일반 REST로 올라간다). SSE는 표준 `EventSource`로 추가 의존성 없이 자동 재연결을 제공한다. 행 없는 신호 방식이라 역할별 데이터 노출 문제를 회피한다.
**트레이드오프**: 양방향 통신은 불가하다(필요해지면 WebSocket으로 교체). 신호마다 클라이언트 재조회가 발생한다(서버측 필터링 없는 naive broadcast). `EventSource`가 커스텀 헤더를 못 보내 이 라우트의 인증 수단은 **HttpOnly 세션 쿠키(withCredentials)** 뿐이다 — 과거의 `?session=` 쿼리 폴백은 서버·클라이언트 양쪽에서 제거됐고(평문 토큰 URL 누출 표면 금지, ADR-007과 같은 규율) 그 대가로 cross-origin dev 구성에서는 SSE 인증이 불가하다(동일 출처 프록시 배치를 쓴다). 이 스트림도 로그 SSE와 동일하게 **push 시점 재검증(비연장 peek)** 을 적용한다 — 무효화된 세션에는 `change` 신호를 쓰지 않고 `event: unauthorized` 1회 후 연결을 끝낸다.

### ADR-006: 얇은 transport + 계층형 도메인 백엔드 (controllers → services → models)
**결정**: `server/index.js`는 비즈니스 로직 없는 얇은 REST/SSE 라우팅만 담당하고, 도메인 로직은 `controllers → services → models → db` 계층에 둔다. 모든 의존성은 주입 가능하게 만들어 테스트에서 in-memory로 대체한다.
**이유**: 전송(HTTP)과 도메인 로직을 분리하면 로직을 HTTP 없이 직접 테스트할 수 있고, 라우트는 shape 매핑과 인가 게이트만 검증하면 된다. 광범위한 테스트 스위트(`node --test` / Vitest)가 회귀를 막는다.
**트레이드오프**: 파일·계층 수가 많아져 작은 변경도 여러 계층을 거친다. 계층 간 계약을 수동으로 유지해야 한다.

### ADR-007: 관리자용 로그 SSE는 실데이터를 push (ADR-005 무효화 신호 원칙의 예외)
**결정**: 관리자용 실시간 로그 뷰어를 위해 `GET /api/logs/stream`(SSE)으로 **로그 라인 실데이터**(record `{ seq, ts, level, message, line }`)를 push하고, `GET /api/logs/digest`로 24시간 창(전날 06:00 ~ 당일 05:59:59.999 KST)을 pull한다. 로그는 **in-memory 링 버퍼**에만 보존한다(파일/DB 미저장). 두 엔드포인트는 **세션 role Z 전용**이다(미인증 401, 비-Z 403 — 로그인만 요구하는 `/api/stream`과 다르다). 스트림은 접속마다 버퍼 최근 2000건을 replay한 뒤 실시간을 잇고(Last-Event-ID 미구현, 중복은 클라이언트가 `seq`로 필터), EventSource 인증은 **HttpOnly 세션 쿠키(withCredentials)**로 한다 — 쿼리스트링에 토큰을 싣지 않는다(평문 토큰 URL 누출 표면 금지, 기존 `?session=` 폴백은 이미 제거됨).
**이유**: ADR-005의 "행 데이터 없는 무효화 신호" 원칙은 역할별 데이터 노출을 피하기 위함인데, 로그는 그 자체가 표시 대상이라 신호만으로는 불가능하다. Z 전용 게이트로 노출을 봉인해 위험을 좁힌다(role은 검증 세션에서만 도출 — ADR-004). zero-dep(log4j 스타일 자체 구현)으로 ADR 철학을 지키고, LOGS.md "파일 미저장" + DB 비파괴(무한 증식 방지)를 지킨다. LOGS.md의 "전날 하루부터 오전 5시 59분까지"는 **06:00 정렬 24시간 창 [D-1 06:00, D 06:00)** 으로 확정 해석한다.
**트레이드오프**: 서버 재시작 시 버퍼가 유실된다. cap(10000줄) 초과 시 오래된 로그가 evict되어 다이제스트가 일부를 놓칠 수 있다. 다이제스트의 매일 6시 전달은 앱이 아니라 운영 루틴이 pull로 수행한다(앱에 타이머/외부 egress 없음). 접속 시점 인증만으로는 로그아웃·만료·강등·비활성화 이후에도 push가 계속되던 문제(Z 전용 봉인이 시간축에서 깨짐)를 **push 시점 재검증(비연장 peek — `touch`면 열린 스트림이 세션을 무한 연장한다)** 으로 닫았고, 무효화 이후에는 로그가 단 한 줄도 전송되지 않는다(`event: unauthorized` 1회 후 종료). 다만 이벤트가 없으면 연결 종료가 다음 이벤트까지 지연된다 — 주기 재검증 타이머를 두지 않기 때문이다(ADR-008).

### ADR-008: 배부(distribution)는 파일 스풀 outbound + tick pull — 앱 내 타이머/외부 egress 금지 유지
**결정**: 배부 시스템(2026-07-26 스코프 확장)은 수집의 대칭 구조로 구현한다. (1) 전송 수단은 **파일 스풀 outbound** — 앱은 배부 스풀 디렉토리(수신처별 하위 폴더)에 기사 파일(JSON, markupVersion 포함)을 쓰기만 하고, 실제 발송은 외부 전송기가 담당한다(앱은 네트워크 egress 없음). (2) 배부 대상은 신규 **DistributionTarget** 테이블(kind=언론사|비언론사)로 관리한다 — ReceiverConfig는 수집(inbound) 전용이라 재사용하지 않는다. (3) 시점 배부(엠바고 1·2차 시각)는 앱 내 타이머가 아니라 **`POST /api/distribution/tick`(Z/시스템 전용) pull 엔드포인트**로 실행한다 — 외부 운영 루틴이 주기 호출한다. (4) 엠바고 없는 일반 기사(DPS)도 송고 즉시 언론사+비언론사 전체에 배부하고 `Contents.distributedAt`을 기록한다. (5) 배부 이벤트는 ArticleHistory에 기록하고, 엠바고 기사의 배부가 전부 완결되면 EPS→DPS로 전이한다.
**이유**: 수집이 "외부 FTPd가 스풀에 드롭 → 앱은 fs.watch"인 것과 동형으로, 배부도 "앱이 스풀에 드롭 → 외부 전송기가 발송"이면 앱에 네트워크 egress·재시도·타임아웃 복잡성이 생기지 않고 오프라인 테스트가 결정적이다. tick pull은 ADR-007의 "앱에 타이머/외부 egress 없음" 원칙을 유지한다(로그 다이제스트 pull과 동형). news.md 엠바고 규칙(1차→언론사, 2차→비언론사·송고 시 언론사 즉시, 1+2차 조합)이 유일한 실질 스펙이며, 위 결정들은 2026-07-26 사용자 확정이다.
**트레이드오프**: 실제 발송 성공/실패를 앱이 알지 못한다(스풀 기록 시각=distributedAt — 발송 완료가 아니라 배부 지시 완료다). 시점 배부의 정시성이 외부 tick 호출 주기에 의존한다. 외부 전송기와 운영 cron이 별도 운영 요소로 필요하다.

### ADR-009: CSRF 방어는 상태 변경 메서드의 Origin/Referer allowlist 검증 (CSRF 토큰·SameSite 변경 대신)
**결정**: `GET`/`HEAD`/`OPTIONS`를 제외한 모든 요청에 대해 전역 미들웨어(`csrfOriginGuard`)가 주장 출처를 검증한다. 주장 출처는 `Origin` 헤더, 없으면 `Referer`의 origin(파싱 실패 시 거부)이다. **자기 출처**(`${req.protocol}://${req.get('host')}`) · **허용 목록**(`allowedOrigins()` — 기본 `http://localhost:5173`·`http://127.0.0.1:5173` + `ALLOWED_ORIGINS` 콤마 목록) · **비프로덕션의 loopback 출처**(localhost/127.0.0.1/[::1], 포트 무관)만 통과시키고, 그 외(`Origin: null` 포함)는 `403 { ok:false, reason:'forbidden-origin' }`이다. 허용 목록은 CORS 옵션과 **단일 출처**를 공유한다. CSRF 토큰(double-submit cookie)은 도입하지 않고, 세션 쿠키의 SameSite/Secure 정책도 바꾸지 않는다. 미들웨어는 요청 로거 뒤(거부도 액세스 로그에 남는다) · 라우트 앞에 등록한다.
**이유**: CORS는 simple request(본문 없는 POST 등)의 **실행**을 막지 않고 **응답 읽기**만 막는다 — 프로덕션 세션 쿠키가 `SameSite=None; Secure`로 발급되므로 잠금 강제 해제·배부 대상 비활성화·tick·로그아웃 같은 부수효과 라우트가 cross-site에서 피해자 쿠키와 함께 실행될 수 있었다. 브라우저는 Fetch 표준상 비-GET 요청에 `Origin`을 항상 붙이고 공격자는 이를 생략시킬 수 없으므로 출처 검증이 유효한 방어다. 기존 CORS allowlist가 `localhost:5173` 고정이라 별도 출처 SPA 배포는 이미 preflight 단계에서 동작하지 않는다. 토큰 방식은 발급·저장·클라이언트 전 REST 경로 첨부·SSE 예외까지 전면 개조가 필요해 회귀 표면이 훨씬 크다.
**가정과 실패 모드**: 이 결정은 **동일 출처 배포를 전제**한다(리버스 프록시가 SPA와 `/api`를 같은 출처로 묶는 배치). 앱 자체는 SPA 번들을 서빙하지 않는다 — `express.static`은 `/uploads` 하나뿐이다. 별도 출처로 SPA를 띄우거나 프록시가 Host를 재작성하는 배포에서는 `ALLOWED_ORIGINS`를 명시 설정해야 하며, **미설정 시 프로덕션의 모든 쓰기 요청이 403**이 된다.
**트레이드오프**: `Origin`·`Referer`가 **모두 없는** 요청은 통과시킨다 — 서버-서버 클라이언트(수집 인제스트, 배부 tick cron, 테스트의 node 클라이언트)를 보존하기 위한 의도된 관용이며, 그 대가로 아주 오래된 브라우저의 form POST는 방어 밖이다. 비프로덕션 loopback 관용 때문에 `vite --host`로 LAN IP(`http://192.168.x.x:5173`)에서 띄우는 모바일 실기 테스트는 loopback이 아니라 비프로덕션에서도 쓰기가 403이 된다(그 경우 `ALLOWED_ORIGINS` 설정이 필요하다). `X-Forwarded-Host`는 신뢰하지 않는다(스푸핑으로 자기 출처 판정을 통과시킬 수 없게 `req.hostname` 대신 `req.get('host')`를 쓴다). 상태를 바꾸는 GET 라우트를 새로 만들면 이 방어 밖이다. 라우트별 예외 목록은 두지 않는다(예외 항목이 곧 우회 경로가 된다).
