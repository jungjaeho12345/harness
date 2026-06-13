# Step 8: http-server

## 읽어야 할 파일

- `/docs/news.md` — **API 명세서, 보안** 섹션(엔드포인트 목록, 세션/권한, CORS, CSP, 레이트리밋)
- `/docs/RCV.md` — 수집(자동기사) 수신: 등록되지 않은 ID 차단, FTP event 방식, attribute '자동기사'
- `/docs/ADR.md` — ADR-004(세션 인가, req.body.role 불신), ADR-005(SSE 무효화 스트림)
- `/docs/ARCHITECTURE.md` — 얇은 transport, `server/ftpWatcher.js`
- `src/controllers/index.js`(step7 — `collection.receive` 포함), `src/db/schema.js`(step1), `src/services/sessionService.js`(step4)

## 작업

Express REST/SSE 전송 계층을 구현한다. **비즈니스 로직 없음 — 컨트롤러 위임 + 인가 게이트 + shape 매핑만.** 의존성은 주입 가능하게(테스트가 in-memory db/서비스로 구동). TDD.

1. `server/index.js`:
   - `export function createApp({ controllers, sessionService })` 반환 Express app.
     - `express.json()`, `helmet`(CSP: scriptSrc 'self', imgSrc 'self' data: https:, connectSrc 'self', frameAncestors 'self' 등 SPA+SSE+외부 썸네일 동작하도록), `cors({ origin: ['http://localhost:5173','http://127.0.0.1:5173'] })`.
     - 세션 식별: 요청 헤더 `x-session-id` → `sessionService.touchSession`으로 acting 신원/role 도출. **`req.body.role` 신뢰 금지.**
     - 로그인 레이트리밋: `/api/login`에만 15분/10회.
   - 라우트(news.md API 명세):
     - `GET /api/health`
     - `POST /api/login`, `POST /api/logout`, `GET /api/session`(F5 복원)
     - `GET /api/users`(세션 게이트: Z=전체 명단, 그 외=부서 등 최소 필드), `POST /api/users`·`PUT /api/users/:id`(**Z 전용**)
     - `GET/POST /api/receiver-config`, `DELETE /api/receiver-config/:id`(**Z 전용**)
     - `GET /api/articles`(세션 게이트), `GET /api/articles/search`, `POST /api/articles`(R/D/Z 저장; 부서 비면 세션 부서 stamp)
     - `POST /api/articles/:id/action`(송고/보류/KILL/삭제승인 — **role은 세션에서 도출**, `req.body.role` 무시. action ∈ `send|hold|kill|approveDelete`. 인가는 세션 role의 capability 게이트(미인증/정의 외 권한 거부)이고, 실제 (상태,권한,액션) 유효성은 `applyAction`/lifecycle이 강제한다. **`/action`에 editDps를 쓰지 말 것** — editDps는 아래 DPS 편집 진입 전용)
     - `PUT /api/articles/:id`(부분 수정 — **잠금 보유자만**: assertLockHolder)
     - `POST /api/articles/:id/lock` · `/unlock` · `/force-unlock`(force는 D/Z 전용. **DPS 기사의 편집 진입(고침/포털고침) lock 획득은 D만** — `authorization.editDps` 게이트, R·그 외 거부. 단순 lock 획득 자체는 상태값 전이를 일으키지 않는다)
     - `GET /api/media/search`(세션 게이트)
     - `POST /api/collection/receive`(수집 인제스트 — **사용자 세션 라우트 아님**. body `{ sourceId, payload }`를 `controllers.collection.receive`에 위임. **등록되지 않은 sourceId는 거부**(collectionService가 판정), 등록 시 attribute='자동기사'로 등록. 127.0.0.1 바인딩/선택적 토큰으로 외부 노출을 좁힌다)
     - `GET /api/stream`(SSE) — in-process `EventEmitter`로 기사 create/update/status/lock 변경 시 `event: change` 브로드캐스트(**행 데이터 없는 무효화 신호**). EventSource가 헤더를 못 보내므로 `?session=` 쿼리 인증 폴백 허용(이 라우트 한정).
   - 전역 에러 핸들러(4-arg, 마지막 등록): 내부 스택 비노출, `{ ok:false, reason:'internal-error' }`.
   - 프로덕션 부트스트랩: 직접 실행 시 루트 `news.db` 열고 `createSchema`, `createSessionService` + `createControllers` 결선, `PORT`(기본 3001) listen. **수집 FTP watcher 기동**: `RCV_SPOOL_DIR`(미설정 시 watcher 비활성)을 감시하는 `createFtpWatcher`를 만들어 `controllers.collection.receive`에 연결해 `start()`. 테스트 import 시에는 listen/watcher 모두 기동하지 않는다.
2. `server/ftpWatcher.js` — `export function createFtpWatcher({ dir, onFile, watch, readFile })` → `{ start, stop }`:
   - `watch`(기본 `node:fs.watch`)·`readFile`(기본 `node:fs/promises.readFile`)는 **주입 가능**(테스트는 실제 FS 미사용). 새 파일 이벤트 시 파일을 읽어 `onFile({ sourceId, payload })`를 호출한다.
   - **sourceId 도출**: 스풀 레이아웃 `<dir>/<sourceId>/<file>`의 상위 서브디렉토리명을 sourceId로 사용한다(외부 FTP 계정이 자기 폴더에 파일을 떨군다고 가정). 등록 여부 판정은 collectionService가 하므로 watcher는 도출·전달만 한다.
   - 외부 FTP 서버 자체를 코드에 띄우지 않는다 — 스풀 디렉토리를 감시하는 event 방식이다(RCV.md "event 방식").
3. 테스트(`test/server*.test.js`, `test/ftpWatcher.test.js`): in-memory db로 createApp을 만들어 핵심 경로 — 미인증 거부, 세션 인가, `req.body.role` 무시(세션 role 사용), 송고/보류/KILL/삭제승인 전이, 잠금 보유자 가드, DPS 편집 lock=D 전용, Z 전용 게이트, `POST /api/collection/receive`의 미등록 sourceId 거부·등록 시 attribute='자동기사', SSE ready 이벤트 — 를 검증. ftpWatcher는 주입한 가짜 watch/readFile로 파일 이벤트→onFile→receive 흐름을 검증(실제 FS·FTP 없음). (가능하면 `app.listen(0)` + fetch, 또는 라우트 핸들러 직접 호출.)

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. AC 실행.
2. 체크리스트: 모든 acting role이 세션에서 도출되는가(body.role 무시)? Z 전용/잠금 보유자/세션 게이트가 강제되는가? `/action`이 capability 게이트만 쓰고 editDps는 DPS lock 경로에만 있는가? approveDelete가 D/Z만 통과하는가? 수집 인제스트가 미등록 sourceId를 거부하는가? ftpWatcher가 주입형 watch로 테스트되는가? SSE가 무효화 신호만 보내는가? 부트스트랩이 createSchema만(삭제 없음) 호출하는가?
3. step 8 업데이트(completed + summary: createApp 시그니처와 라우트 표, 인가 모델).

## 금지사항

- 라우트 핸들러에 비즈니스 로직을 넣지 마라. 이유: ADR-006 — 컨트롤러/서비스 위임.
- `req.body.role`을 신뢰하지 마라. 이유: ADR-004 권한 상승 방지.
- 등록되지 않은 sourceId의 수집을 통과시키지 마라. 이유: RCV.md 수신 명세(미등록 ID 차단).
- 실제 FTP 서버를 띄우거나 외부 네트워크를 부트스트랩/테스트에 하드코딩하지 마라(스풀 디렉토리 watch + watch/readFile 주입). 이유: 테스트 결정성과 결합도.
- 부트스트랩에서 DROP/DELETE/마이그레이션 삭제를 하지 마라. 이유: DB 비파괴.
- 기존 테스트를 깨뜨리지 마라.
