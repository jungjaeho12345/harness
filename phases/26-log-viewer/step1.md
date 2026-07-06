# Step 1: server-instrumentation — createApp에 logService 주입 + 서버 계측(미들웨어/에러/로그인/수집/부트배너/ftpWatcher)

## 배경 / 요구사항

Step 0에서 zero-dep 로거 `src/services/logService.js`(팩토리 `createLogService({ now, cap, tzOffsetMinutes })`, record shape `{ seq, ts, level, message, line }`, 메서드 `log/debug/info/warn/error/snapshot/subscribe/digest/size/subscriberCount`)를 만들었다.

현재 서버는 **런타임 로깅이 사실상 전무**하다:
- console 출력은 부트 배너 2곳뿐(`server/index.js` 기동 로그).
- 전역 에러 핸들러는 `err`를 **기록하지 않고** 500 JSON만 반환한다.
- `ftpWatcher`는 `handle(filename).catch(() => {})`로 실패를 **무음 삼킨다**(`server/ftpWatcher.js`).
- 로그인 성공/실패·계정잠금·기사/수집 액션 로그가 없다.

이 step은 **서버 transport 계층(`server/index.js` + `server/ftpWatcher.js`)에 logService를 결선**해 위 지점을 계측한다. **로그를 소비/노출하는 API(/api/logs/*)는 이 step이 아니라 step 2다** — 여기서는 로그를 **생산**만 한다.

## 읽어야 할 파일

먼저 아래를 읽고 얇은 transport·DI·부트스트랩 가드·마스킹 규율을 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 얇은 transport(ADR-006), 신뢰 경계=서버, 명령어.
- `/docs/ADR.md` — ADR-004(신원은 세션에서만·비밀번호는 bcrypt), ADR-006(주입 가능 의존성). 철학(외부 의존성 최소화).
- `/docs/LOGS.md` — 어떤 이벤트를 로그로 남길지의 근거.
- `src/services/logService.js` (Step 0 산출물) — 팩토리 시그니처·`info/warn/error`·record shape. **이 step은 이 모듈을 import해 주입/호출한다.**
- `src/services/sessionService.js` — **주입 선례**: `createApp`이 `sessionService`를 직접 주입받아 쓰는 것과 동일하게 `logService`를 직접 주입한다(컨트롤러 경유 아님 — 인프라 서비스).
- `server/index.js` — **결선 지점(실측)**:
  - `createApp({ controllers, sessionService, env, cookieSecure, forceHttps, uploadDir })`(L169~176) — 여기 옵션에 `logService`를 추가한다(기본값 제공).
  - 전역 JSON 파서 미들웨어 등록부(L238~245) — 요청 로깅 미들웨어를 이 근처(라우트보다 앞)에 둔다.
  - 로그인 라우트 `app.post('/api/login', ...)`(L301~314) — `controllers.auth.login` 결과로 성공/실패/잠금 로깅.
  - 수집 라우트 `POST /api/collection/receive`(L641~652), `POST /api/collection/pull`(L656~667) — 결과로 수집 성공/실패 로깅.
  - 전역 에러 핸들러(L690~694) — `err` 로깅(응답 바디는 불변).
  - 부트스트랩 `bootstrap()`(L701~732) — `console.log` 배너 2곳(L716·L730)을 logService로 대체, 실제 logService 생성해 createApp에 주입, ftpWatcher onError 결선.
  - 부트스트랩 가드(L734~736) — listen/watcher는 bootstrap()에서만(테스트 import 시 미실행).
- `server/ftpWatcher.js` — **결선 지점**: `createFtpWatcher({ dir, onFile, watch, readFile })`(L12~17)와 `handle(filename).catch(() => {})`(L34, 무음 삼킴).
- `test/sse-auth.test.js` — 서버 앱 통합 테스트 골격(in-memory `DatabaseSync(':memory:')` → `createSchema` → `createControllers` → `createApp` → `listen(0)` → fetch/`http.request`). **이 골격을 본떠 계측 테스트를 쓴다.**
- `test/ftpWatcher.test.js` — ftpWatcher 단위 테스트(가짜 watch/readFile 주입, 파일 이벤트 발사). onError 단언을 여기에 추가한다.

## 작업

TDD로 진행한다(`node --test`). **테스트를 먼저 작성**하고 통과하는 계측을 만든다. 이 step은 서버 transport 계층만 다룬다.

### 마스킹 규율 (모든 계측에 강제되는 핵심 불변식)

- **세션 토큰(sid/x-session-id)·비밀번호·Authorization·Cookie 헤더 값·업로드 base64 본문·기사 본문(markupVersion)을 로그 message에 절대 넣지 마라.** 로그에는 식별용 최소 필드(method, path, status, ms, userId, sourceId, reason)만 담는다. `userId`/`sourceId`는 비밀이 아니므로 허용. 비밀번호·토큰은 값 자체를 문자열에 넣지 않는다(존재 여부/reason만).

### 1. createApp에 logService 주입 — `server/index.js`

- 파일 상단 import에 `import { createLogService } from '../src/services/logService.js';` 추가.
- `createApp({ ... })` 옵션에 `logService = createLogService()`를 추가한다(기본값 제공 — 주입하지 않는 기존 테스트가 무회귀로 동작하고, 부트스트랩/테스트가 자기 인스턴스를 주입 가능하게). `sessionService`와 나란히 두는 인프라 서비스로 취급한다(컨트롤러 경유 금지).

### 2. 요청 로깅 미들웨어(INFO) — `server/index.js`

- 라우트보다 앞(예: 전역 JSON 파서 등록 근처)에 미들웨어를 추가한다. 요청 완료 시점(`res.on('finish', ...)`)에 소요시간·최종 status를 알 수 있으므로 거기서 기록한다:
  - `logService.info(\`${req.method} ${req.path} ${res.statusCode} ${ms}ms\`)` 형태.
  - **`req.path`(쿼리 제외)만** 쓴다 — 전체 URL/쿼리스트링을 넣지 마라(토큰 누출 표면). 헤더/쿠키/바디를 넣지 마라(마스킹).
  - 노이즈 억제(선택): `/api/health`, `OPTIONS`(CORS preflight)는 로깅을 건너뛰어도 좋다(구현 재량).
  - **주의(피드백 루프 없음)**: 이 미들웨어가 로그를 남겨도 그 자체가 새 HTTP 요청을 만들지 않으므로 루프가 없다. step2의 `/api/logs/stream` 요청도 한 번만 기록된다.

### 3. 로그인 로깅(INFO/WARN) — `server/index.js`

- `POST /api/login`에서 `controllers.auth.login(userId, password)` 결과 `r`로:
  - `r.ok` → `logService.info(\`login ok userId=${userId}\`)`.
  - `r.reason === 'locked'`(계정 잠금) → `logService.warn(\`login locked userId=${userId}\`)`.
  - 그 외 실패 → `logService.warn(\`login failed userId=${userId} reason=${r.reason}\`)`.
  - **`password`를 로그에 절대 넣지 마라.** `userId`만.

### 4. 수집 로깅(INFO/WARN) — `server/index.js`

- `POST /api/collection/receive`, `POST /api/collection/pull`에서 결과로:
  - ok → `logService.info(\`collection ${받은경로} sourceId=${sourceId} ok\`)`.
  - 실패 → `logService.warn(\`collection ${경로} sourceId=${sourceId} reason=${r.reason}\`)`.
  - **`payload`(수집 본문)를 로그에 넣지 마라** — sourceId + 결과만.

### 5. 전역 에러 핸들러(ERROR) — `server/index.js`

- 4-arg 에러 핸들러(L692~694)에서 500을 반환하기 **전에** `logService.error(...)`로 기록한다. message에는 `err.message`(+ 요청 식별 `${req.method} ${req.path}`)를 담는다.
- **응답 바디는 불변**: 여전히 `{ ok:false, reason:'internal-error' }`만 반환하고 **스택/내부정보를 HTTP 응답에 노출하지 마라**(ADR 보안 경계). 스택은 in-memory 로그(Z 전용 뷰어)에만 남겨도 무방하나, HTTP로는 새지 않게 한다.

### 6. 부트 배너 → logService (bootstrap 내부) — `server/index.js`

- `bootstrap()`에서 실제 logService를 만들어 createApp에 주입한다:
  ```js
  const logService = createLogService();
  const app = createApp({ controllers, sessionService, logService, forceHttps });
  ```
- `console.log('API server on ...')`(L716), `console.log('FTP watcher watching ...')`(L730)를 `logService.info(...)`로 대체한다.

### 7. ftpWatcher 무음 삼킴 해제 — `server/ftpWatcher.js` + bootstrap 결선

- `createFtpWatcher({ dir, onFile, watch, readFile })`에 **선택적 `onError` 콜백**을 추가한다:
  ```js
  export function createFtpWatcher({ dir, onFile, watch = fsWatch, readFile = fsReadFile, onError }) { ... }
  ```
- `handle(filename).catch(() => {})`(L34)를 `handle(filename).catch((err) => { onError?.(err, filename); })`로 바꾼다. **여전히 throw하지 않는다**(watcher는 계속 살아 있어야 함) — 다만 무음 삼킴 대신 onError로 알린다. `onError` 미주입 시 기존과 동일하게 조용히 무시(하위호환).
- bootstrap의 watcher 생성부에 결선:
  - `onFile` 성공 시 `logService.info(\`collection ftp received sourceId=${sourceId}\`)`(payload 제외), `r.ok` 아니면 `logService.warn(...)`.
  - `onError: (err) => logService.warn(\`ftp watcher error: ${err?.message ?? err}\`)`.
  - bootstrap 배선은 최소화한다(bootstrap은 부트 가드로 단위 테스트되지 않음 — onError **파라미터 자체**는 ftpWatcher.test.js로 테스트한다).

### 8. 테스트 (먼저 작성)

**서버 계측** — `test/sse-auth.test.js`의 `start()` 골격을 본떠, `createApp`에 **스파이 logService를 주입**해 검증한다. 스파이는 실제 `createLogService()` 인스턴스면 충분하다(`snapshot()`으로 기록을 확인). 새 파일 `test/server-logging.test.js` 권장:
- 요청 로깅: 인증 불필요한 `GET /api/health`(또는 임의 요청)를 fetch한 뒤, 주입한 logService `snapshot()`에 `/GET \/api\/health 200/`에 매치하는 INFO 라인이 있음을 단언.
- 로그인 성공/실패: 사용자 시드 후 올바른 pw 로그인 → `login ok userId=...` INFO. 틀린 pw → `login failed userId=... reason=...` WARN. **어떤 로그 라인에도 비밀번호 문자열이 없음**을 단언(마스킹 회귀 가드 — `snapshot().every(r => !r.line.includes('<pw>'))`).
- 에러 핸들러: 특정 라우트에서 던지도록 **throw하는 컨트롤러 스텁**을 주입(예: `controllers.article.query = () => { throw new Error('boom'); }`)하고 `GET /api/articles`를 인증해 호출 → **HTTP 응답은 500 + `{reason:'internal-error'}`(스택 미노출)**, **동시에** logService `snapshot()`에 `ERROR ... boom` 라인이 있음을 단언.
- 마스킹(요청 로깅): 세션 헤더/쿠키를 실은 요청 후, 로그 라인에 sid 값·`cookie`·`x-session-id` 값이 포함되지 않음을 단언.

**ftpWatcher onError** — `test/ftpWatcher.test.js`에 추가:
- `readFile`가 reject하도록 주입하고 파일 이벤트를 발사하면, 주입한 `onError`가 호출됨(무음 삼킴 아님)을 단언. `onError` 미주입 시에도 throw 없이 조용히 통과함을 단언(하위호환).

## Acceptance Criteria

```bash
npm run test          # node --test — 서버 계측 + ftpWatcher onError 신규 테스트 + 기존 전체 통과(회귀 없음)
npm run lint          # ESLint
```

기대 단언(요약): createApp이 logService 주입을 받고(기본값 있음) 요청/로그인/수집/에러가 적절한 레벨로 기록·비밀번호/토큰/쿠키/본문이 로그에 없음(마스킹)·에러 응답 바디는 스택 미노출 불변·ftpWatcher 실패가 onError로 표면화(무음 삼킴 제거)·부트 배너가 logService 경유.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: logService는 sessionService처럼 createApp 직접 주입(컨트롤러 우회 인프라)·기본값 제공으로 무회귀·요청 로깅은 `req.path`만(쿼리/헤더/바디 제외)·마스킹 준수·에러 응답 바디 불변(스택 미노출)·ftpWatcher는 여전히 throw 안 함(계속 구동)·새 npm 의존성 0.
3. 결과에 따라 `phases/26-log-viewer/index.json`의 step 1을 갱신(completed+summary / error / blocked). summary에 계측 지점 목록과 "logService는 createApp 옵션 주입(기본값 createLogService())"를 남긴다.

## 금지사항

- 로그 message에 비밀번호·세션 토큰(sid/x-session-id)·Cookie/Authorization 헤더 값·업로드 base64·기사 본문(markupVersion)·수집 payload를 넣지 마라. 이유: 로그 뷰어(Z 전용이라도)로 비밀이 새면 안 된다 — 최소 식별 필드만.
- 요청 로깅에서 전체 URL/쿼리스트링(`req.originalUrl`)을 넣지 마라. 이유: 쿼리에 토큰이 실릴 수 있는 누출 표면 — `req.path`만.
- 전역 에러 핸들러의 HTTP 응답에 `err.message`/스택을 노출하지 마라. 이유: ADR 보안 경계(내부 스택 비노출) — 스택은 in-memory 로그에만.
- `logService`를 `controllers`를 거쳐 주입하지 마라. 이유: 로깅은 cross-cutting 인프라 — sessionService와 동일하게 createApp 직접 주입(ADR-006 계층은 도메인 로직 대상).
- `createApp`에서 `logService`의 기본값을 없애 필수 인자로 만들지 마라. 이유: 기본값이 없으면 logService를 주입하지 않는 기존 서버 테스트가 전부 깨진다(무회귀 요구).
- ftpWatcher `handle().catch`에서 다시 throw하거나 onError를 필수로 만들지 마라. 이유: watcher는 한 파일 실패에도 계속 살아 있어야 하고, onError 미주입 하위호환을 지켜야 한다.
- 이 step에서 `/api/logs/*` 라우트나 `web/`·`docs/ADR.md`를 건드리지 마라. 이유: 이 step은 로그 **생산**(계측)만 — 소비 API는 step2, 클라이언트는 step3~4.
- 새 npm 패키지를 추가하지 마라. 이유: zero-dep 확정.
- 기존 테스트를 깨뜨리지 마라.
