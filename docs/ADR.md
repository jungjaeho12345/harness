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
**이유**: 클라이언트가 보낸 역할 값을 신뢰하면 권한 상승이 가능하다. 신뢰 경계를 서버에 두어 인가를 단일 지점에서 강제하고, 비밀번호는 bcrypt 해시로 저장한다. helmet(CSP)·CORS allowlist·로그인 레이트리밋으로 표면을 추가로 좁힌다.
**트레이드오프**: 서버 세션 스토어가 필요하다(현재 in-process라 다중 인스턴스 시 공유 스토어로 교체해야 함). 세션ID가 HttpOnly 쿠키가 아닌 헤더 방식이라 쿠키 전환·HTTPS 강제 등 추가 하드닝이 후속 과제로 남는다.

### ADR-005: SSE 단방향 무효화 스트림으로 실시간 동기화 (WebSocket 대신)
**결정**: 기사 생성/수정/상태전이/편집잠금 변경을 서버 in-process `EventEmitter` → SSE(`/api/stream`)로 브로드캐스트한다. 페이로드는 행 데이터가 없는 "무효화 신호"이며, 클라이언트가 자기 필터로 재조회한다.
**이유**: 동기화는 서버→클라이언트 단방향이면 충분하다(클라이언트 변경은 일반 REST로 올라간다). SSE는 표준 `EventSource`로 추가 의존성 없이 자동 재연결을 제공한다. 행 없는 신호 방식이라 역할별 데이터 노출 문제를 회피한다.
**트레이드오프**: 양방향 통신은 불가하다(필요해지면 WebSocket으로 교체). 신호마다 클라이언트 재조회가 발생한다(서버측 필터링 없는 naive broadcast). `EventSource`가 커스텀 헤더를 못 보내 이 라우트만 `?session=` 쿼리 인증 폴백을 둔다.

### ADR-006: 얇은 transport + 계층형 도메인 백엔드 (controllers → services → models)
**결정**: `server/index.js`는 비즈니스 로직 없는 얇은 REST/SSE 라우팅만 담당하고, 도메인 로직은 `controllers → services → models → db` 계층에 둔다. 모든 의존성은 주입 가능하게 만들어 테스트에서 in-memory로 대체한다.
**이유**: 전송(HTTP)과 도메인 로직을 분리하면 로직을 HTTP 없이 직접 테스트할 수 있고, 라우트는 shape 매핑과 인가 게이트만 검증하면 된다. 광범위한 테스트 스위트(`node --test` / Vitest)가 회귀를 막는다.
**트레이드오프**: 파일·계층 수가 많아져 작은 변경도 여러 계층을 거친다. 계층 간 계약을 수동으로 유지해야 한다.
