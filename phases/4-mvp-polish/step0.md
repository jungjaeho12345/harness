# Step 0: merge-reconcile

병렬 클라우드/Slack 세션이 같은 Phase-1 기능(기사 이력·보안 하드닝·계정 잠금)을 서로 다른 설계로 구현해 모두 `feat-0-mvp`로 머지되면서 HEAD가 깨졌다(server/index.js의 중복 `const isProd`·미정의 `env|nodeEnv` 참조로 인한 SyntaxError, 미정의 `historyEntry()` 호출, 중복 phase 플랜 폴더). 이 step은 **충돌을 하나의 정본(canonical) 설계로 수렴**하고 **중복 phase 폴더를 제거해 phases/index.json을 정본 목록으로 동기화**하는 housekeeping baseline이다. 새 기능은 추가하지 않는다 — 병렬 머지 잔재를 걷어내고 한 벌의 설계만 남긴다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 어떤 설계가 정본이고 무엇이 반쯤 머지된 잔재인지 파악하라:

- `/docs/ADR.md` — ADR-003(프론트 MVC, Model 계약 경유·직접 fetch 금지), ADR-004(role은 서버 세션에서만 도출 — 클라이언트가 role을 싣지 않는다·토큰은 권한 정보를 담지 않는 무작위 64-hex), ADR-006(백엔드 controllers→services→models 계층, 가능한 한 무변경).
- `/docs/news.md` — 세션 쿠키/인증 표면, 이력·재송·매핑 등 메뉴 액션 정의. 어떤 라우트가 정본인지 대조.
- `/server/index.js` — **이 step에서 통합할 핵심 파일.** 머지된 3개 보안 구현의 충돌 지점: 쿠키명 상수가 `SESSION_COOKIE_NAME='yh.sid'`와 로컬 `SESSION_COOKIE='sid'` 두 벌, 중복 `parseCookies`/`parseCookie`, `createApp`에 `cookieSecure`/`forceHttps`/`nodeEnv`/`env`가 섞여 `isProd`가 두 번 선언되고 정의되지 않은 식별자를 참조한다. `/api/session`·`/api/stream`에 평문 `?session=` 쿼리 인증 폴백이 남아있고, 번역 라우트가 미정의 본문 추출 함수를 호출한다.
- `/src/db/schema.js` — `SCHEMA`에 1-history 설계가 남긴 중복 `ArticleHistory` 테이블 키(id/articleId/eventType/actorUserId/actorRole/fromStatus/toStatus/title/createdAt). 정본 이력은 1-menu-actions의 `action` 컬럼 설계다.
- `/src/models/articleModel.js` — `createArticleModel(db, { articleHistoryModel })`의 선택 주입·`recordHistory`·`insert/update`의 `history` 인자 스레딩(원자적 이력 합류). 정본 설계에서 이력은 op 이후 best-effort `record()`로 분리됐으므로 이 스레딩은 사문화됐다.
- `/src/services/articleService.js` — `create`/`update`가 미정의 `historyEntry()`를 호출(SyntaxError/런타임 에러원). 정본은 `update` 성공 후 `record({eventType:'edit'})`만, `create`는 이력 미기록.
- `/src/services/userService.js` — 계정 잠금 옵션이 `lockoutThreshold/lockoutWindowMs`(security 브랜치)와 `maxFailedAttempts/lockDurationMs`(security-hardening 브랜치) 두 명명으로 갈림. 잠금 판정 순서(`isLocked` vs `invalid-credentials`)도 충돌.
- `/src/controllers/index.js` — `getHistory`/`getSendHistory` 노출 및 `userService` 결선(lockoutPolicy 전달 여부).
- `/web/src/model/contract.js` — `MODEL_KEYS`에 정본에 없는 `getArticleHistory`/`getSendHistory` 키 잔존. 정본 이력 키는 `queryHistory`다.
- `/web/src/model/httpModel.js`, `/web/src/test/fakeModel.js` — 위 두 키의 대응 구현, `login`/`logout`의 sessionId 폴백 보관.
- `/web/src/controller/useViewController.js` — 사문화된 `resendArticle`/`viewHistory`/`viewSendHistory` 콜백. 정본 재송은 ListPage가 `resend`로, 후속/계속은 `createFollowUp`/`createContinue`로 디스패치한다.
- `/web/src/view/ListPage.jsx` — `onCtxSelect` switch에 중복된 `followUp`/`continue`/`resend`/`mapping` case.
- `/web/src/view/ContextMenu.jsx`, `/web/src/view/writerButtons.js` — 미사용 `history`/`sendHistory` 항목 빌더, `mode==='mapping'` 버튼 분기(`[]` → `['save']`).
- `/phases/index.json` 및 `/phases/1-history`, `/phases/1-security`, `/phases/security-hardening` — 같은 기능에 대한 중복 phase 플랜. 정본은 `1-menu-actions`(이력)·`1-security-hardening`(보안)이다.

이전 머지 잔재를 꼼꼼히 식별한 뒤 작업하라.

## 작업

이것은 신규 기능이 아니라 **병렬 머지 충돌 수렴 + 중복 제거**다. 아래를 한 벌의 정본 설계로 정리한다.

1. **기사 이력 — 1-menu-actions 설계를 정본으로 유지하고 1-history 잔재 제거.**
   - `schema.js`: 중복 `ArticleHistory` 테이블 키(eventType/actorRole/fromStatus/toStatus 컬럼 설계)를 `SCHEMA`에서 삭제한다. 정본 이력 테이블(`action` 컬럼 설계)만 남긴다.
   - `articleModel.js`: `createArticleModel(db, { articleHistoryModel })` → `createArticleModel(db)`로 단순화. `recordHistory()`와 `insert/update`의 `history` 인자 스레딩(같은 tx 합류)을 제거한다 — 정본은 op 이후 best-effort `record()`로 이력을 남기므로 모델 레이어 스레딩이 불필요하다.
   - `articleService.js`: `create`/`update`에서 미정의 `historyEntry()` 호출을 제거한다. `create`는 이력을 남기지 않고, `update`는 성공 후 기존 `record({ eventType:'edit', actorUserId: fields.modifier })`만 호출한다.
   - `controllers/index.js`: `getHistory`/`getSendHistory` 노출을 제거한다(정본은 `queryHistory(articleId, opts)`).

2. **server/index.js — 머지된 3개 보안 구현을 한 벌로 통합(SyntaxError 해결).**
   - 쿠키명을 단일 `export const SESSION_COOKIE_NAME = 'sid'`로 통일하고, 로컬 `SESSION_COOKIE`/`SESSION_COOKIE_MAX_AGE_S` 중복 상수와 모듈 상단 `'yh.sid'`를 제거한다. Max-Age는 `SESSION_COOKIE_MAX_AGE_MS = ONE_HOUR_MS`로 단일화.
   - 중복 `parseCookies(header)`를 삭제하고 `parseCookie(header, name)` 한 벌만 남기되 `decodeURIComponent` URIError 폴백(잘못된 퍼센트 인코딩이면 원본값 반환)을 통합한다.
   - `createApp({ controllers, sessionService, env = process.env.NODE_ENV, cookieSecure, forceHttps })`로 시그니처를 정리하고, 내부에서 `const isProd = env === 'production'`, `const secure = cookieSecure ?? isProd`, `const httpsEnforced = forceHttps ?? isProd` **한 벌만** 선언한다. 중복 `const isProd` 두 번 선언과 미정의 `nodeEnv`/`env` 참조로 인한 SyntaxError를 제거한다. helmet HSTS·trust proxy·HTTP→HTTPS 308 리다이렉트·`setSessionCookie`/`clearSessionCookie`는 모두 `secure`/`httpsEnforced`/`SESSION_COOKIE_NAME`을 참조하도록 통일한다.
   - `/api/session`·`/api/stream`에서 평문 `?session=` 쿼리 인증 폴백을 제거한다(URL/프록시 로그 누출 표면). 인증은 `readSessionToken`(쿠키 → `x-session-id` 헤더)만 신뢰한다.
   - 번역 라우트용 `articleToText(found)`를 정의한다: `found.article.markupVersion`을 JSON 파싱해 `blocks[].text`를 `\n`으로 잇고(trim 후 비면 폴백), 파싱 실패 시 평문 레거시 본문 → `contents.title` → `article.title` → `''` 순으로 폴백한다. **본문은 서버 DB에서만 취한다(ADR-004).**

3. **계정 잠금 — 두 명명 규칙 수용, 잠금 우선 판정.**
   - `userService.createUserService`가 `lockoutThreshold/lockoutWindowMs`와 `maxFailedAttempts/lockDurationMs`를 **둘 다 수용**한다. 내부 `threshold = maxFailedAttempts ?? lockoutThreshold ?? LOCKOUT_THRESHOLD`, `windowMs = lockDurationMs ?? lockoutWindowMs ?? LOCKOUT_DURATION_MS`.
   - 기본 상수를 `export const LOCKOUT_THRESHOLD = 5`, `export const LOCKOUT_DURATION_MS = 15*60*1000`으로 export한다(테스트가 무옵션 기본값으로 가정).
   - `login`에서 `isLocked(row)` 판정을 `invalid-credentials`보다 **앞에** 두어, 잠긴 계정은 올바른 비밀번호여도 `reason:'locked'`를 우선 반환한다.
   - `resetLockout`은 `lockedUntil`/`lastFailedLoginAt`을 SQL `null`로 비운다(행 삭제 없음 — DB 비파괴).
   - `controllers/index.js`의 `createUserService` 결선에 `lockoutPolicy`를 전달한다.

4. **프론트 — 죽은 이력 키·콜백·중복 case 정리.**
   - `contract.js` `MODEL_KEYS`에서 `getArticleHistory`/`getSendHistory`를 제거한다. `httpModel.js`/`fakeModel.js`의 대응 메서드도 제거한다.
   - `httpModel.js`의 `login`/`logout`을 `async`로 바꿔, 응답 `sessionId`를 `writeSessionId`로 sessionStorage에 보관(dev cross-origin 쿠키 미적재 폴백 — 이후 `x-session-id` 헤더 병행)하고 logout 시 비운다.
   - `useViewController.js`에서 사문화된 `resendArticle`/`viewHistory`/`viewSendHistory`와 미사용 import(`PENDING_NEW_KEY`)를 제거한다.
   - `ListPage.jsx` `onCtxSelect` switch의 중복 `followUp`/`continue`/`resend`/`mapping` case를 정리해 `createFollowUp`/`createContinue`/`resend`로 일원화한다.
   - `ContextMenu.jsx`에서 미사용 `history`/`sendHistory` 항목 빌더를 제거한다.
   - `writerButtons.js`의 `mode==='mapping'` 분기를 `[]` → `['save']`로 고친다(매핑은 임베드 추가 PUT — 저장 단일 버튼).

5. **테스트 마이그레이션 — 정본 API로 수렴(신규 기능 테스트 추가 없음).**
   - `test/server.test.js`를 정본 API로 마이그레이션한다(`history?sendOnly=1`, `x-session-id` 스트림 인증). `?session=` 쿼리 인증 테스트는 제거.
   - `test/articleHistoryWiring.test.js`(1-history 설계 전용)와 `test/schema.test.js`의 `ArticleHistory` 케이스를 삭제한다.
   - `controllers.test.js`/`httpModel.test.js`/`ContextMenu.test.jsx`/`useViewController.test.jsx`의 죽은 헬퍼·단언(`getArticleHistory`/`getSendHistory`)을 정리하고 `WriterPage.test.jsx`를 정본 동작에 맞춘다.

6. **중복 phase 폴더 제거 + phases/index.json 동기화.**
   - `phases/1-history`, `phases/1-security`, `phases/security-hardening` 세 폴더(중복 플랜)를 통째로 삭제한다 — 정본은 `1-menu-actions`(이력)·`1-security-hardening`(보안)이다.
   - `phases/index.json`을 정본 머지 phase 목록으로 동기화한다: `0-mvp`·`1-menu-actions`·`1-security-hardening`·`2-followup-resend`·`3-mapping`(모두 `completed`). 누락된 파일 끝 newline을 추가한다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다. server/index.js SyntaxError가 사라지고 backend/web 테스트가 통과해야 한다(머지 전 깨졌던 HEAD 회복·무회귀).
2. 아키텍처 체크리스트(ARCHITECTURE.md 디렉토리 구조·ADR 기술스택·CLAUDE.md CRITICAL):
   - 쿠키명·`isProd`/`secure`/`httpsEnforced`가 server/index.js에 **한 벌만** 선언되는가? 중복 상수/미정의 식별자 참조가 없는가?
   - `/api/session`·`/api/stream`에 평문 `?session=` 쿼리 인증이 남아있지 않은가(쿠키→x-session-id만)?
   - acting role이 세션에서만 도출되는가(ADR-004 — 클라가 role 미전송)? 본문은 서버 DB에서만 취하는가(`articleToText`)?
   - 백엔드 controllers→services→models 계층이 유지되는가(ADR-006)? 프론트는 Model 계약 경유만 하는가(ADR-003 — 죽은 계약 키 제거)?
   - DB 비파괴인가? `schema.js`는 중복 테이블 **정의**만 삭제하고, `resetLockout`은 행을 지우지 않고 필드만 null로 비우는가?
   - `phases/index.json`이 정본 5개 phase만 나열하고, 중복 폴더(1-history/1-security/security-hardening)가 제거됐는가?
3. 결과에 따라 index.json step status를 갱신한다(성공 → `completed` + summary, 수정 3회 실패 → `error` + error_message, 개입 필요 → `blocked` + blocked_reason).

## 금지사항

- 1-history 설계(eventType/actorRole/fromStatus/toStatus 컬럼·history 인자 스레딩·historyEntry())를 되살리지 마라. 이유: 정본 이력은 1-menu-actions의 `action` 컬럼 + op 이후 best-effort `record()` 설계다. 두 설계를 섞으면 머지 충돌이 재발하고 미정의 `historyEntry()` 호출로 런타임이 깨진다.
- server/index.js에서 `isProd`/쿠키명/cookie 파서를 두 벌로 다시 만들지 마라. 이유: 중복 선언이 정확히 이번 SyntaxError의 원인이었다 — 통합된 한 벌(`SESSION_COOKIE_NAME`·`isProd`/`secure`/`httpsEnforced`·`parseCookie`)만 유지하라.
- `?session=` 쿼리 인증 폴백을 복원하지 마라. 이유: 평문 토큰이 URL·프록시 로그에 누출되는 표면이다 — 인증은 HttpOnly 쿠키와 `x-session-id` 헤더만 신뢰한다.
- `resetLockout`/`schema.js` 정리에서 DB 행을 삭제하지 마라. 이유: DB 비파괴(CLAUDE.md). 잠금 해제는 필드만 null로 비우고, 스키마 정리는 테이블 정의 코드만 제거한다.
- 정본 phase 폴더(1-menu-actions·1-security-hardening·2-followup-resend·3-mapping)나 그 step 파일을 삭제하지 마라. 이유: 제거 대상은 중복/사문화 폴더(1-history·1-security·security-hardening)뿐이다 — 정본 플랜을 지우면 기록이 유실된다.
- 충돌 정리를 핑계로 동작을 바꾸는 새 기능을 끼워 넣지 마라. 이 step은 baseline 정리다 — 한 설계로 수렴하되 정본 동작은 보존한다.
- 기존 테스트/기능을 깨뜨리지 마라. 이유: 머지로 이미 깨진 HEAD를 회복하는 것이 목표다 — backend/web 테스트가 모두 통과해야 한다.
