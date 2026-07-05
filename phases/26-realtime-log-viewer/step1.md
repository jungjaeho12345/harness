# Step 1: log-stream-route — 로그 SSE 스트림 라우트(세션 게이트) + 최소 계측

## 배경 / 요구사항

step0의 `logService`(in-memory 링 버퍼 + `log` EventEmitter)를 서버 transport에 배선한다. 웹 페이지가 실시간으로 로그를 볼 수 있도록 **SSE 스트림 라우트**를 추가하고, 접속 시 최근 버퍼(백로그)를 재생한 뒤 신규 라인을 흘려보낸다. 또한 화면에 보여줄 실제 로그 컨텐츠가 생기도록 **기존 서버 수명주기/무효화 지점에 최소한의 계측**을 얹는다.

### 확정된 설계 결정 — SSE 채널: 기존 `/api/stream` 재사용이 아니라 **신규 `/api/logs/stream`** (근거를 반드시 남긴다)

오케스트레이터가 "신규 채널 `/api/logs/stream` vs 기존 `/api/stream`에 `log` 이벤트 추가" 중 근거를 들어 택일하라고 지시했다. **신규 전용 채널 `GET /api/logs/stream`을 만든다.** 근거(step md에 남길 것):

1. **의미 충돌**: 기존 `/api/stream`은 ADR-005에 따라 **행 데이터가 없는 "무효화 신호"**만 브로드캐스트한다(`event: change`, payload에 컨텐츠 없음 — 권한별 데이터 노출 회피). 로그 라인은 **실제 컨텐츠(메시지 텍스트)**를 담으므로 무효화-신호 계약과 근본적으로 다르다.
2. **소비자 오염 방지**: `/api/stream` 구독자(useViewController·useWriteController)는 `change` 신호로 재조회한다. 여기에 `log` 이벤트를 섞으면 모든 목록/작성 화면이 무관한 로그 이벤트를 수신·무시해야 한다.
3. **백로그 재생**: 로그 뷰어는 접속 즉시 최근 로그를 보여줘야 하므로 연결 시 버퍼를 재생한다. 무효화 채널은 백로그 개념이 없다(재생하면 잘못된 대량 재조회 유발).
4. **버스 분리**: step0의 `logService`가 **자체 EventEmitter**를 소유하므로, 기존 `bus`(무효화)와 로그 emitter를 물리적으로 분리해 관심사를 격리한다.

### 인증(신뢰 경계 = 서버)

- `/api/logs/stream`은 **검증된 세션으로만** 인가한다 — 기존 `/api/stream`(server/index.js L672~688)과 **동일하게** `readSessionToken(req)`(쿠키 우선 → `x-session-id` 헤더 폴백) → `sessionService.touchSession(sid)`. 세션 없으면 401 `UNAUTH`.
- **평문 `?session=` 쿼리 폴백을 추가하지 마라** — `/api/stream`이 이미 제거한 URL/프록시 로그 누출 표면이다(ADR-005 주석, sse-auth 테스트). 쿠키/헤더만 신뢰한다.
- 역할(R/D/Z) 게이트는 붙이지 않는다 — `/api/stream`과 동일하게 인증 세션 게이트만(any authenticated). (로그 뷰어의 역할 제한은 후속 하드닝 과제로 남긴다.)

이 step은 **서버 transport 레이어(`server/index.js`)만** 다룬다(+ 부트스트랩 배선). 다이제스트/스케줄러/프론트는 이후 step 책임이다. 라우트는 얇게 — 로직은 step0 `logService`에 위임(ADR-006).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 얇은 transport(라우팅·인가 게이트·shape 매핑만), 명령어.
- `/docs/ADR.md` — ADR-004(세션 인가·`req.body.role` 불신), ADR-005(SSE·EventEmitter·`?session=` 폴백 제거 근거), ADR-006(얇은 transport).
- `server/index.js` — **결선 지점**:
  - L169~176 `createApp({ controllers, sessionService, env, ... })` 시그니처 — 여기에 `logService` 주입 파라미터를 추가한다(미주입 시 step0 `createLogService()` 기본 생성).
  - L273~288 `readSessionToken`/`bus`/`app.notifyChange`/`sessionOf` — 세션 판독·무효화 방출 패턴.
  - L669~688 `GET /api/stream` — SSE 헤더 설정·`res.flushHeaders`·`event: ready`·`req.on('close')` 구독 해제. **이 패턴을 복제**해 로그 라우트를 만든다.
  - L699~732 `bootstrap()` — `createSessionService`/`createControllers`/`createApp`/`app.listen`/`createFtpWatcher` 배선. 여기서 `logService`를 1회 생성해 `createApp`에 주입한다(다음 step들과 **단일 인스턴스 공유**를 위해).
- `src/services/logService.js` — step0에서 만든 `createLogService`(`log`/`entries`/`subscribe`). **여기 로직을 재구현하지 마라 — 위임만.**
- `test/sse-auth.test.js` — SSE 인증 테스트 컨벤션(미인증 401·`?session=` 폴백 부재 단언). 로그 스트림도 같은 컨벤션으로 인증 경계를 고정한다.
- `test/server.test.js` — createApp 라우트 테스트 컨벤션(in-memory 주입·supertest 유무 확인 후 동일 방식 사용).

## 작업

TDD로 진행한다(`node --test`). **먼저 라우트/인증 테스트를 작성**하고 통과하는 구현을 만든다. 이 step은 서버 라우트 하나 + createApp 주입 배선 + 최소 계측만 다룬다.

### 1. createApp에 logService 주입

- `createApp` 옵션에 `logService`를 추가한다. 미주입 시 `logService = createLogService()`로 기본 생성한다(테스트가 in-memory 인스턴스를 주입할 수 있게).
- (선택) `app.logService = logService` 또는 클로저 참조로 라우트/계측이 접근하게 한다.

### 2. SSE 로그 스트림 라우트 — `GET /api/logs/stream`

- `/api/stream`(L672~688) 바로 뒤/근처에 등록한다. 얇게:
  - `readSessionToken(req)` → `sessionService.touchSession(sid)`. 세션 없으면 `res.status(401).json(UNAUTH)`.
  - SSE 헤더 설정(`text/event-stream`/`no-cache`/`keep-alive`) + `res.flushHeaders?.()` + `res.write('event: ready\ndata: {"ok":true}\n\n')`.
  - **백로그 재생**: `logService.entries()`(step0, 시각순 복사본)를 순회하며 각 엔트리를 `event: log\ndata: ${JSON.stringify(entry)}\n\n`로 쓴다. 대량 방지를 위해 **최근 N개만**(예: 마지막 200개 — 상수로 명시) 재생한다. 근거: 초기 렌더 부담·전송량 제한(24h 전체를 매 접속 재생하지 않음).
  - **신규 라인 구독**: `const off = logService.subscribe((entry) => res.write(\`event: log\ndata: ${JSON.stringify(entry)}\n\n\`))`. `req.on('close', off)`로 해제한다.
  - 엔트리 직렬화는 `{ ts, level, message, line }`을 그대로 JSON으로 싣는다(프론트는 `line`을 표시, 구조 필드는 여유). shape은 프론트(step4/5)와 1:1로 맞춘다.

### 3. 최소 계측 (실시간 표시용 컨텐츠 생성)

- 화면에 보일 실제 로그가 생기도록 **적은 수의** `logService.log(...)`를 배치한다(범위 최소화 — 서버 레이어 안에서만):
  - `bootstrap()`에서 서버 기동(`app.listen` 콜백)·FTP watcher 시작 시 `INFO` 로그 1~2건.
  - `app.notifyChange(kind)`를 감싸 무효화 방출 시 `logService.log('INFO', \`change: ${kind}\`)`를 함께 남긴다(기사 생성/수정/상태전이/잠금·수집 인제스트가 자연히 로그로 나타난다).
- 계측은 최소로만. 라우트 핸들러 전반에 로그를 흩뿌리지 마라(범위 밖).

### 4. 테스트 (먼저 작성)

- `test/`에 로그 스트림 라우트 테스트를 추가한다(server route 테스트 컨벤션):
  - **미인증(세션 없음) → 401** `UNAUTH`.
  - **인증 세션 → 200 + `Content-Type: text/event-stream`**, 초기 응답에 `event: ready`가 실린다.
  - 인증 접속 시 **백로그가 재생**된다: 주입한 `logService`에 미리 `log()` 몇 건을 넣고, 응답 스트림 초반에 해당 `event: log` 라인(직렬화된 엔트리)이 포함됨을 단언(스트림 일부만 읽고 종료).
  - `?session=` 쿼리로만 접근 시(쿠키/헤더 없음) **401**임을 단언(평문 폴백 부재 — sse-auth 컨벤션).
  - `app.notifyChange('create')` 호출 후 주입 `logService.entries()`에 `change: create` INFO 엔트리가 남음을 단언(계측 배선 검증).

> 참고: SSE는 응답이 끝나지 않는 스트림이다. 테스트는 기존 SSE 테스트(`test/sse-auth.test.js`) 방식대로 소켓/응답 일부를 읽고 명시적으로 종료(abort/req.destroy)하는 패턴을 따른다 — 무한 대기하지 않도록.

## Acceptance Criteria

```bash
npm run test          # 서버(node --test) — 로그 스트림 라우트/인증/계측 테스트 포함 전체 통과
npm run lint          # ESLint
npm run build         # 프로덕션 빌드(프론트 회귀 없음 — 이 step은 백엔드지만 빌드 그린 유지)
```

기대 단언(요약):
- `/api/logs/stream`이 미인증 401, 인증 시 `text/event-stream` + `event: ready`를 준다.
- 접속 시 최근 백로그가 `event: log`로 재생되고, 신규 `log()`가 구독자에게 흘러간다.
- 평문 `?session=` 단독 접근은 401이다(폴백 없음).
- `app.notifyChange`가 무효화와 함께 INFO 로그를 남긴다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 라우트는 위임만(로직 재구현 없음)·세션 게이트만(role 게이트 없음)·`?session=` 폴백 없음·`req.on('close')` 구독 해제로 리스너 누수 없음·백로그 상한(최근 N)·logService는 부트스트랩 단일 인스턴스 주입·파일 미저장 유지.
3. 결과에 따라 `phases/26-realtime-log-viewer/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- 기존 `/api/stream`(무효화 채널)에 `log` 이벤트를 섞지 마라. 이유: ADR-005 무효화-신호 계약(행 데이터 없음)과 충돌하고 목록/작성 구독자를 오염시킨다 — 로그는 전용 `/api/logs/stream` 채널.
- `?session=` 쿼리 인증 폴백을 추가하지 마라. 이유: URL/프록시 로그 누출 표면(ADR-005·sse-auth) — 쿠키/헤더만.
- 로그 스트림에 역할(R/D/Z) 게이트를 붙이지 마라(세션 게이트만). 이유: 기존 SSE와 동일한 인증 경계 유지(범위 최소화). 역할 제한은 후속 과제.
- 라우트에서 로그 버퍼 로직(배열 push/eviction/포맷)을 재구현하지 마라. 이유: step0 `logService`에 위임 — 얇은 transport(ADR-006).
- `req.on('close')` 없이 `subscribe`만 걸지 마라. 이유: 연결 종료 시 리스너가 누수돼 방출마다 죽은 소켓에 write한다.
- SSE 라우트 핸들러 내부에서 `logService.log(...)`를 호출하지 마라. 이유: write→log→emit→write 되먹임 루프 위험. 계측은 수명주기/notifyChange 지점에만.
- 로그를 파일/DB에 쓰거나 프론트/다이제스트/스케줄러 코드를 이 step에 넣지 마라. 이유: 파일 미저장 제약 + 각 레이어는 이후 step 책임.
