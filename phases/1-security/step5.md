# Step 5: prod-hardening

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-001(독립 Express 서버, 127.0.0.1 바인딩), ADR-004(helmet CSP·CORS allowlist·레이트리밋 표면 축소), ADR-006(얇은 transport)
- `/docs/ARCHITECTURE.md` — 보안 경계(helmet CSP, CORS allowlist, 전역 에러 핸들러 내부 스택 비노출)
- `/docs/PRD.md` — "MVP 제외 사항"의 HTTPS 강제 후속 과제
- `server/index.js` — 현재 `helmet({ contentSecurityPolicy: {...} })` 설정, `cors`(step 3에서 credentials:true), 쿠키 발급(step 3의 `yh.sid`, 프로덕션 Secure 분기), 부트스트랩(`bootstrap()`, `app.listen(port, '127.0.0.1')`)
- step 3·4 summary — 쿠키 속성·Secure 프로덕션 분기·CORS credentials 상태.

step 3에서 쿠키에 이미 프로덕션 Secure 분기를 넣었는지 확인하고, 이 step은 그 위에 HSTS·환경 분기 문서화를 더한다(중복 구현 금지).

## 작업

프로덕션에서 **HTTPS/보안 헤더를 강제**한다(로컬 개발은 http 유지). **transport(server/index.js) 계층 + 환경 분기 + 문서화**만 다룬다. TDD: 헤더 검증 테스트 먼저.

### 결정 사항(이 step에서 고정)

- 환경 판별: `process.env.NODE_ENV === 'production'`을 프로덕션 신호로 쓴다(step 3 Secure 분기와 동일 기준).
- **HSTS**: 프로덕션에서만 helmet HSTS를 켠다(`Strict-Transport-Security`, 예: `maxAge` 약 1년, `includeSubDomains`). 개발(http)에서는 끈다 — http에서 HSTS는 의미 없고 로컬 접근을 방해할 수 있다.
- **Secure 쿠키**: step 3에서 이미 프로덕션 Secure 분기를 넣었다면 재구현하지 말고 동작만 검증한다. 누락됐다면 여기서 보강한다.
- **CSP**: 기존 directives(scriptSrc 'self', imgSrc data: https:, frameSrc youtube 등)는 기능 동작에 필요하므로 **유지**한다. 프로덕션에서 `upgrade-insecure-requests`를 추가할지는 재량(추가 시 http 로컬 동작을 막지 않도록 프로덕션 분기). connectSrc는 SPA(:5173)가 API(:3001)를 호출하므로 cross-origin 동작을 깨지 않게 주의(프론트는 별 origin이라 서버 CSP의 connectSrc는 서버 자신이 서빙하는 문서에만 적용됨 — 과도하게 좁히지 말 것).

### 구현

1. `server/index.js` `createApp`의 `helmet(...)` 옵션을 환경 분기로 감싼다:
   - 프로덕션: HSTS 활성(`hsts: { maxAge: ..., includeSubDomains: true }`).
   - 개발: HSTS 비활성(`hsts: false`) — 로컬 http 유지.
   - CSP는 양쪽 공통 유지(필요 시 프로덕션에서만 `upgrade-insecure-requests` 추가).
2. 쿠키 Secure: step 3 분기를 확인/보강해 프로덕션에서 `Secure`가 붙고 개발에서 빠지는지 보장한다(중복 정의 금지 — 한 곳에서 쿠키 옵션을 만들도록 정리).
3. **문서화**: `server/index.js` 부트스트랩/헤더 설정 근처에 "프로덕션은 리버스 프록시(예: nginx) 뒤 HTTPS 종단을 가정한다. 서버 자체는 127.0.0.1 http로 바인딩하고 TLS는 프록시가 담당하며, 프록시는 `X-Forwarded-Proto`를 전달한다. Secure 쿠키가 프록시 뒤에서도 동작하려면 Express `app.set('trust proxy', 1)`이 필요할 수 있다"는 가정을 주석으로 명시한다. 프로덕션에서 `trust proxy` 설정이 필요하면 추가하되, **개발 동작을 깨지 않게** 환경 분기한다.
4. 테스트(`test/server.test.js`):
   - 기본(개발) 환경에서 응답에 `Strict-Transport-Security` 헤더가 **없는지**(http 개발 유지 검증).
   - `NODE_ENV=production`을 모의한 createApp(가능하면 환경변수를 테스트 내에서 설정/복원)에서 HSTS 헤더가 **있는지**, 쿠키에 `Secure`가 붙는지. (환경변수 전역 오염을 피하려고 `try/finally`로 원복하거나, 헬퍼에 `nodeEnv` 주입이 가능하면 그 경로 사용.)
   - 기존 helmet/CSP 관련 동작(있다면)이 유지되는지.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - HSTS·Secure가 프로덕션 분기이고 개발(http)에서 비활성인가?
   - CSP directives가 기존 기능(YouTube iframe·외부 썸네일·SPA)을 깨지 않게 유지되는가?
   - 라우트/비즈니스 로직을 건드리지 않았는가(헤더·환경 분기만 — ADR-006)?
   - 부트스트랩이 여전히 127.0.0.1 바인딩 + createSchema(삭제 없음)인가?
3. 결과에 따라 `phases/1-security/index.json`의 step 5를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 HSTS 프로덕션 분기·Secure 쿠키·trust proxy/리버스 프록시 가정 문서화를 기록.
   - 실패/blocked → 절차 동일.

## 금지사항

- HSTS/Secure/`upgrade-insecure-requests`를 개발 기본으로 강제하지 마라. 이유: 로컬 http 개발이 막힌다(브라우저가 https로 강제 업그레이드하거나 쿠키를 끊는다).
- 기존 CSP directives를 무분별하게 좁히지 마라. 이유: YouTube iframe(frameSrc)·외부 썸네일(imgSrc https:)·SPA(scriptSrc 'self')가 깨진다.
- 환경변수 `NODE_ENV`를 테스트에서 전역으로 바꾼 뒤 원복하지 않는 채로 두지 마라. 이유: 후속 테스트가 프로덕션 모드로 오염된다(try/finally 원복).
- 라우트·세션 로직을 변경하지 마라. 이유: 이 step은 헤더/환경 하드닝 전용.
- 기존 테스트를 깨뜨리지 마라.
