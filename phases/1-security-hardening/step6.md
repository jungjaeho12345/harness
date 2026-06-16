# Step 6: https-enforcement

## 읽어야 할 파일

먼저 아래 파일들을 읽고 현재 서버 보안 헤더/부트스트랩을 파악하라:

- `/docs/news.md` — "보안"(서버는 보안 헤더(CSP 등)를 적용, 오류에 내부 스택 비노출, CORS는 localhost:5173만)
- `/docs/ARCHITECTURE.md` — "보안 경계"(helmet(CSP), CORS allowlist, 전역 에러 핸들러), 개요(API 서버는 `127.0.0.1:3001` 바인딩)
- `/docs/ADR.md` — ADR-004(helmet/CORS/레이트리밋으로 표면 축소), ADR-001(두 origin), 철학(외부 의존성 최소화)
- `/docs/PRD.md` — MVP 제외 사항 23행(HTTPS 강제가 후속 과제)
- `server/index.js` — **현재 transport/부트스트랩**:
  - `app.use(helmet({ contentSecurityPolicy: { directives: {...} } }))` — CSP만 커스텀, **HSTS 등 나머지 helmet 기본값** 적용 상태 확인.
  - `bootstrap()`이 `app.listen(port, '127.0.0.1', ...)`로 **HTTP**(TLS 아님)로 바인딩. HTTPS 리다이렉트 미들웨어 없음.
  - 전역 에러 핸들러, CORS allowlist.
- `test/server.test.js` / `test/integration.smoke.test.js` — `createApp`을 HTTP로 띄워 검증하는 패턴. **HTTPS 강제가 이 테스트들을 깨면 안 된다**(테스트는 HTTP로 앱을 호출한다).
- `phases/1-security-hardening/step3.md` 산출물 — 세션 쿠키 `Secure` 속성이 환경 토글된다. HTTPS 강제는 `Secure` 쿠키의 전제이기도 하다.

## 작업

**HTTPS 강제(enforcement)** 를 추가한다. 이 프로젝트는 TLS 종단을 앱이 직접 하지 않을 수 있으므로(리버스 프록시 종단이 일반적), HTTPS 강제는 **(a) HSTS 헤더 적용 + (b) HTTP 요청을 HTTPS로 리다이렉트**하는 미들웨어로 구현한다. **개발/테스트(HTTP)에서는 비활성**되도록 환경 토글한다. TDD — 테스트 먼저.

핵심: 강제는 **운영(production)에서만 켜진다**. 테스트와 로컬 dev는 HTTP로 돌아야 하므로 토글로 끈다(step3의 `Secure` 토글과 동일한 환경 기준을 쓰는 것을 권장).

1. **HSTS**: helmet의 HSTS(`Strict-Transport-Security`)를 명시적으로 활성화한다. helmet 기본 HSTS가 켜져 있는지 확인하고, max-age·includeSubDomains 등을 운영 적합하게 설정한다. **HSTS는 HTTPS 응답에서만 의미가 있으므로** 프로덕션 토글과 함께 적용한다(HTTP dev에 HSTS를 보내면 이후 접속이 깨질 수 있음 — 토글로 끈다).
2. **HTTP→HTTPS 리다이렉트 미들웨어**: 프로덕션에서, 요청이 평문 HTTP면 동일 경로의 `https://`로 **301/308 리다이렉트**한다.
   - 프록시 뒤를 고려해 `X-Forwarded-Proto` 헤더로 원 프로토콜을 판정한다(`app.set('trust proxy', ...)` 적절히 설정). 프록시 신뢰 설정 범위를 최소화하라.
   - 토글이 꺼진(개발/테스트) 환경에서는 미들웨어가 **no-op**이어야 한다(HTTP 요청을 그대로 통과).
   - 미들웨어 등록 순서: helmet 다음, 라우트보다 앞. CORS preflight(OPTIONS)·`/api/health`가 리다이렉트로 깨지지 않게 주의하라(health는 모니터링이 HTTP로 칠 수 있음 — 다만 운영 정책상 health도 HTTPS면 통과).
3. **토글**: 강제 on/off 기준을 환경변수/주입으로 둔다(예: `process.env.NODE_ENV === 'production'` 또는 `FORCE_HTTPS`). `createApp`이 이 옵션을 받아 테스트가 켜고 끌 수 있게 하라(주입 가능 — ADR-006).
4. 부트스트랩(`bootstrap()`)은 그대로 `127.0.0.1`에 listen하되(TLS 종단은 외부 프록시 가정), HTTPS 강제 토글을 환경에서 읽어 `createApp`에 전달한다. **앱이 직접 TLS 인증서를 로드하는 코드는 범위 밖**이다(인프라 책임).

시그니처(가이드):
```
createApp({ controllers, sessionService, forceHttps = false })
// forceHttps=true 이면: HSTS 적용 + X-Forwarded-Proto !== 'https' 요청을 https로 리다이렉트
// forceHttps=false(기본, 테스트/dev): no-op
```

테스트(`test/server.test.js` 보강 또는 신규 `test/server.https.test.js`):
- `forceHttps: false`(기본)에서 HTTP 요청이 정상 처리된다(기존 모든 테스트 무회귀).
- `forceHttps: true`에서 `X-Forwarded-Proto: http`로 요청하면 `https://`로 리다이렉트(3xx + Location 헤더)된다.
- `forceHttps: true` + `X-Forwarded-Proto: https`면 정상 처리되고 응답에 `Strict-Transport-Security` 헤더가 있다.
- `/api/health`·CORS preflight 동작이 깨지지 않는다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - HTTPS 강제가 **토글**되어 테스트/dev(HTTP)에서 no-op인가? (기존 테스트 무회귀)
   - 프로덕션에서 HSTS 헤더가 적용되고 HTTP→HTTPS 리다이렉트가 동작하는가?
   - `X-Forwarded-Proto` 판정과 `trust proxy` 설정이 과도하지 않은가(최소 신뢰)?
   - `forceHttps` 옵션이 `createApp`에 주입 가능한가(ADR-006)?
   - 앱이 TLS 인증서를 직접 로드하는 범위 밖 코드를 넣지 않았는가?
3. `phases/1-security-hardening/index.json`의 step 6 업데이트(completed + summary: 토글 기준·HSTS 설정·리다이렉트 상태코드·trust proxy 범위). 실패 시 error, 모호 시 blocked.

## 금지사항

- HTTPS 강제를 테스트/개발 환경에서 무조건 켜지 마라. 이유: 테스트와 로컬 dev는 HTTP로 동작한다 — 토글 없이 켜면 기존 전체 테스트 스위트가 리다이렉트로 깨진다.
- `trust proxy`를 무제한(`true`)으로 열지 마라. 이유: `X-Forwarded-Proto` 스푸핑으로 HTTPS 강제를 우회할 수 있다 — 신뢰 프록시 범위를 최소화하라.
- 앱 내부에 TLS 인증서 로딩/HTTPS 서버 생성 코드를 넣지 마라. 이유: TLS 종단은 인프라(리버스 프록시) 책임이며 이 phase 범위 밖이다. 앱은 HSTS + 리다이렉트만 책임진다.
- CORS allowlist·CSP·전역 에러 핸들러 등 기존 보안 미들웨어를 변경하거나 약화시키지 마라. 이유: 무관한 회귀를 막는다(scope 최소화).
