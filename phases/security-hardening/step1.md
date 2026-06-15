# Step 1: https-enforcement

## 목표
프로덕션에서 HTTPS를 강제한다 — HSTS 헤더 + http→https 리다이렉트 + 신뢰 프록시(trust proxy) 설정. step0에서 도입한 Secure 쿠키와 정합한다(프로덕션 HTTPS면 Secure 쿠키가 실제로 전송됨). 로컬 개발(http)·테스트(`createApp` in-memory)에는 영향이 없어야 한다. 이 step은 **transport 계층(`server/index.js`)만** 손댄다 — 도메인/세션/DB/프론트는 무변경.

## 읽어야 할 파일
- `/home/user/harness/docs/ADR.md` — ADR-001(2-process 분리, Express API 서버 `127.0.0.1:3001`), ADR-004(helmet/CORS/레이트리밋으로 표면 축소). 보안 하드닝이 후속 과제라는 26행 주석
- `/home/user/harness/docs/PRD.md` — `## MVP 제외 사항` 23행(HTTPS 강제가 이번 phase 대상임을 확인)
- `/home/user/harness/docs/ARCHITECTURE.md` — `## 보안 경계`(53~55행: helmet CSP·CORS allowlist·레이트리밋·전역 에러 핸들러)
- `/home/user/harness/server/index.js` — 현재 transport 전부. 특히 `app.use(helmet({...}))`(66~80행)의 CSP 설정, `app.use(cors({...}))`(81~85행), `bootstrap()`의 `app.listen(port, '127.0.0.1', ...)`(367~370행)
- `/home/user/harness/phases/security-hardening/step0.md` — step0가 도입한 `sessionCookieOptions(env)`의 `secure` env 분기. HTTPS 강제와 같은 env 신호(`NODE_ENV==='production'`)를 써야 정합한다
- `/home/user/harness/test/server.test.js` — `start()`가 `createApp`을 `app.listen(0)`(http)로 띄우는 방식(25~35행). 이 테스트들이 http에서 무회귀로 통과해야 한다

## 작업 (TDD — 테스트 먼저)
1. HTTPS 강제 미들웨어를 `createApp` 안에 둔다. **env로 분기**해 프로덕션에서만 활성화한다(`NODE_ENV==='production'`). 헬퍼 예: `enforceHttps(env)` → Express 미들웨어 반환(비프로덕션이면 no-op 미들웨어).
   - 프로덕션에서 요청이 평문 http면(프록시 뒤에서는 `req.secure` 또는 `X-Forwarded-Proto` 헤더로 판정) `301`/`308`로 동일 경로의 `https://` URL로 리다이렉트한다.
   - GET/HEAD가 아닌 메서드(POST 등)에 대한 리다이렉트는 바디 손실을 유발할 수 있으므로, 안전을 위해 **비-GET 평문 요청은 리다이렉트 대신 403/400으로 거부**하거나 308(메서드·바디 보존 리다이렉트)을 사용한다. 택1하고 근거를 summary에 남겨라.
2. `app.set('trust proxy', ...)`를 프로덕션에서 설정한다 — TLS 종단(리버스 프록시) 뒤에 있을 때 `req.secure`·`X-Forwarded-Proto`를 신뢰하기 위함. 신뢰 범위는 좁게(예: `1` = 첫 프록시만, 또는 loopback). 무분별한 `trust proxy: true`는 스푸핑 위험이 있으므로 쓰지 마라.
3. HSTS: helmet의 `strictTransportSecurity`(HSTS) 옵션을 프로덕션에서 켠다(`maxAge` 충분히 길게, `includeSubDomains` 검토). 현재 `helmet({...})`는 CSP만 명시 커스터마이즈 중이고 helmet 기본 HSTS는 켜져 있으나 **HSTS는 https 응답에만 유효**하다 — 프로덕션 https 보장과 함께 의도적으로 설정 근거를 남겨라. CSP 등 기존 helmet 디렉티브는 **그대로 유지**한다(임베드/썸네일 깨짐 방지).
4. 미들웨어 등록 순서: HTTPS 리다이렉트는 helmet/cors **앞** 또는 직후의 이른 위치에 두어, 평문 요청이 도메인 로직까지 도달하지 않게 한다. 단 `/api/health`는 인프라 헬스체크가 http로 올 수 있으므로 리다이렉트 예외 처리 여부를 결정하고 근거를 남겨라.

## 테스트 계획 (`test/https-enforcement.test.js` 신규)
- 테스트는 `createApp`을 직접 만들고, env 신호(`NODE_ENV`)를 주입/설정해 검증한다. **실제 TLS는 띄우지 않는다**(단위 수준).
  - 비프로덕션(기본): 평문 GET 요청이 리다이렉트 없이 정상 200을 받는다(로컬/테스트 무영향 회귀 가드).
  - 프로덕션: `X-Forwarded-Proto: http`로 온 GET 요청이 `https://`로 리다이렉트(301/308)된다. `X-Forwarded-Proto: https`면 통과한다.
  - 프로덕션 https 응답에 HSTS(`Strict-Transport-Security`) 헤더가 있다.
  - 비-GET 평문 요청 처리(택한 정책: 308 또는 거부)가 의도대로 동작한다.
- env 분기는 `createApp` 호출 시점/요청 시점 중 어디서 읽는지 명확히 하고, 테스트가 결정적이도록 env를 주입 가능한 형태로 노출한다(전역 `process.env` 직접 의존보다 주입 권장 — sessionService의 `now` 주입 패턴과 일관).

## Acceptance Criteria
```bash
npm run lint
npm run build
npm test
```

## 검증 절차
1. AC 실행. 기존 `test/server.test.js`(http로 `app.listen(0)`) 전부 무회귀 통과 확인 — 비프로덕션이 기본이므로 리다이렉트가 끼면 안 된다.
2. 체크리스트: 비프로덕션에서 http가 그대로 통과하는가? 프로덕션에서 평문→https 리다이렉트/HSTS가 동작하는가? `trust proxy`가 좁게 설정됐는가? 기존 CSP 디렉티브가 보존됐는가?
3. index.json의 step 1을 completed + summary(env 분기 신호·리다이렉트 코드·비-GET 정책·trust proxy 범위·health 예외 여부)로 갱신.

## 금지사항 / 불변규칙 체크리스트
- 로컬/테스트(비프로덕션)에서 HTTPS 리다이렉트를 켜지 마라. 이유: http로 띄우는 기존 테스트·로컬 개발이 전부 깨진다(무한 리다이렉트/연결 실패).
- `trust proxy: true`(무제한 신뢰)를 쓰지 마라. 이유: `X-Forwarded-Proto`/IP 스푸핑으로 HTTPS 강제·레이트리밋이 우회된다.
- 기존 helmet CSP 디렉티브(imgSrc/frameSrc 등)를 삭제·축소하지 마라. 이유: YouTube 임베드·외부 썸네일·data URI 미리보기가 깨진다.
- 세션/도메인/DB 코드를 건드리지 마라(이 step은 transport HTTPS 강제만). DB 비파괴 원칙.
- acting role을 클라 입력에서 도출하거나 `req.body.role`을 신뢰하지 마라(ADR-004). 이 step은 인가 경로를 바꾸지 않는다.
