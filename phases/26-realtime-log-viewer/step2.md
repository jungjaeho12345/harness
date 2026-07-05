# Step 2: digest-core-and-api — 순수 다이제스트 집계 코어 + 조회 API(세션 게이트, 읽기 전용)

## 배경 / 요구사항

`docs/LOGS.md`: "매일 오전 6시에 **전날 하루부터 오전 5시 59분까지** 발생한 로그를 모아 harness-orchestrator에게 전달한다." 이 step은 그 집계의 **결정적 순수 코어**와, 그것을 pull로 조회하는 **읽기 전용 API**를 만든다. 실제 06:00 트리거와 Slack 전송은 step3(스케줄러/어댑터) 책임 — 이 step은 그 코어가 트리거 방식과 무관하게 테스트 가능하도록 분리해 둔다.

### 확정된 설계 결정 (그대로 구현 — 오케스트레이터가 사용자와 합의한 ② (B)+(A) 조합의 코어+B 부분)

- **순수 집계 함수/서비스가 코어다.** 입력 = 로그 엔트리 배열 + 기준시각(run date), 출력 = **전날 06:00:00 ~ 당일 05:59:59 윈도우**로 필터·집계한 다이제스트. **결정적, 외부 의존 0** → 단위 테스트가 쉬워야 한다.
- 그 코어 위에 **(B) 다이제스트 조회 API** `GET /api/logs/digest?date=`(세션 게이트, 읽기 전용)를 얹어 pull 가능하게 한다. (A) 06:00 push 어댑터는 step3.
- 24시간 윈도우를 담으려면 링 버퍼(step0)가 ~24h 엔트리를 보유해야 한다 — 이는 여전히 **파일 미저장**이다.

이 step은 **백엔드 도메인(`src/`) + 컨트롤러 위임 + 얇은 조회 라우트(`server/`)** 한 수직 읽기 슬라이스다. 읽기 전용이고 단일 계약이라 phase 25 step0(읽기 전용 스냅샷 조회 슬라이스) 선례와 동일한 응집도로 함께 검증한다. **DB를 접촉하지 않는다**(전부 in-memory).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 계층 분리(services→controllers→route), 얇은 transport, 명령어.
- `/docs/ADR.md` — 철학(순수·결정적·TDD·외부 의존 0), ADR-004(읽기 전용은 세션 게이트만), ADR-006(위임만·주입형).
- `/docs/LOGS.md` — 다이제스트 윈도우 정의(전날 06:00~당일 05:59).
- `/home/user/harness/src/services/logService.js` — step0. `entries({ since })`가 시각순 복사본을 준다(집계 입력). **로그 버퍼 로직 재구현 금지 — 스냅샷만 소비.**
- `/home/user/harness/src/controllers/index.js` — **결선 지점**: `createControllers(db, { sessionService, ... })`. 여기에 `logService`를 주입받아(부트스트랩·createApp과 단일 인스턴스 공유) `logs` 도메인 진입점을 추가한다. `const article = { ... }` 위임 패턴 참고(로직 재구현 없이 서비스 위임).
- `/home/user/harness/server/index.js` — **결선 지점**: L406~414 `GET /api/articles/:id`(세션 게이트·읽기 전용 위임·shape 매핑) 패턴. `sessionOf(req)`/`UNAUTH`/`fail(res, r)` 사용법. 라우트는 얇게 — 컨트롤러 위임만. `createControllers`/`createApp` 호출부(L706~712)에 `logService` 전달.
- `/home/user/harness/test/articleService.test.js` — 순수 서비스 `node --test` 컨벤션.
- `/home/user/harness/test/server.test.js` — 라우트 테스트 컨벤션(in-memory 주입).

## 작업

TDD로 진행한다(`node --test`). **먼저 순수 코어 테스트**를 작성하고, 그 다음 컨트롤러·라우트 테스트를 작성한 뒤 통과 구현을 만든다.

### 1. 순수 다이제스트 코어 — `src/services/logDigest.js`

- **윈도우 경계 순수 함수** `digestWindow(runDate)` → `{ start, end }`(epoch ms). `runDate`(집계 실행일, 예: 06:00 트리거가 도는 그날)를 기준으로:
  - `start` = **전날 06:00:00.000**(runDate의 로컬 날짜에서 하루 빼고 06:00).
  - `end` = **당일 05:59:59.999**(runDate 로컬 날짜의 05:59:59 끝).
  - 로컬 Date 컴포넌트 기반으로 계산한다(step0 포맷터와 동일 근거 — tz 무관 결정적). DST 등 예외는 범위 밖(단순 로컬 컴포넌트 산술).
- **집계 순수 함수** `computeLogDigest(entries, runDate)` → 다이제스트 객체. 입력 `entries`는 step0 `entries()` 형태(`{ ts, level, message, line }[]`). 계약:
  - `digestWindow(runDate)`로 윈도우를 구하고 `start <= ts <= end`인 엔트리만 필터.
  - 반환 shape(재량이되 계약 준수): `{ date, window: { start, end }, total, byLevel: { INFO, WARN, ERROR, ... }, lines }`.
    - `date`: 대상 표기(예: `YYYY-MM-DD` — runDate 기준 또는 윈도우 종료일; 주석에 어느 쪽인지 명시).
    - `total`: 윈도우 내 엔트리 수.
    - `byLevel`: 레벨별 카운트(맵).
    - `lines`: 윈도우 내 포맷된 라인(`line`) 배열(시각순). 매우 클 수 있으니 상한(예: 최근/전체 상한 상수)을 두되, 기본은 윈도우 전체를 담는다(다이제스트 목적). 상한을 둔다면 주석에 근거를 남긴다.
  - **결정적·순수**: 같은 `entries`+`runDate`면 항상 같은 결과. `Date.now()`/전역 상태 접근 금지 — 시각은 인자로만.

### 2. 다이제스트 서비스/컨트롤러 위임

- `logService`(또는 별도 `logDigestService`)에 조회 진입점을 노출한다. 최소한 컨트롤러에서 다음을 만들 수 있어야 한다:
  - `logs.digest(dateStr)` — `dateStr`(`YYYY-MM-DD` 또는 미지정)에서 `runDate`를 도출(미지정이면 현재 시각 = 오늘 06:00 실행 가정), `computeLogDigest(logService.entries(), runDate)`를 반환. 반환 `{ ok: true, digest }` shape.
  - 잘못된 date 문자열이면 `{ ok: false, reason: 'invalid-date' }`(coerce 실패 시). throw 금지.
- `src/controllers/index.js`에 `logs` 도메인 객체를 추가한다(위임만, 로직 재구현 금지 — ADR-006):
  ```js
  const logs = { digest: (dateStr) => logService.digest(dateStr) };   // 또는 logDigestService 위임
  return { auth, user, article, media, translation, receiverConfig, collection, logs };
  ```
  - `logService`는 `createControllers` 인자로 주입받는다(없으면 `createLogService()` 기본 — 단, 부트스트랩·createApp과 **동일 인스턴스**를 공유하도록 배선한다).

### 3. 조회 라우트 — `GET /api/logs/digest?date=`

- `server/index.js`에 읽기 전용 라우트를 추가한다(얇게):
  - `sessionOf(req)` → 미인증이면 401 `UNAUTH`(세션 게이트만 — 읽기 전용, ADR-004. 역할 게이트 없음).
  - `controllers.logs.digest(req.query.date)`에 위임. `ok`면 `res.json({ ok: true, digest })`, `invalid-date`면 `fail(res, r)`(400).
  - `STATUS_BY_REASON`에 `'invalid-date': 400` 매핑을 추가한다(없으면 fallback 400이라 필수는 아니지만 명시 권장).
- `createControllers`/`createApp` 호출부에 `logService` 단일 인스턴스를 주입해 라우트·다이제스트·(step3)스케줄러가 같은 버퍼를 본다.

### 4. 테스트 (먼저 작성)

- `test/logDigest.test.js`(순수 코어):
  - `digestWindow(runDate)`가 전날 06:00.000 ~ 당일 05:59:59.999를 준다(로컬 컴포넌트로 만든 고정 Date 단언).
  - `computeLogDigest`가 윈도우 **경계 포함/제외**를 정확히 처리한다(전날 05:59:59는 제외, 06:00:00 포함, 당일 05:59:59 포함, 06:00:00 제외).
  - `byLevel` 카운트·`total`·`lines`(시각순)가 맞다.
  - 결정성: 같은 입력 두 번 호출 결과 동일.
- 컨트롤러/라우트 테스트(server 컨벤션):
  - 미인증 → 401.
  - 인증 세션 + 주입 `logService`에 윈도우 내/외 로그를 심은 뒤 `GET /api/logs/digest?date=YYYY-MM-DD` → `digest.total`/`byLevel`이 윈도우 필터를 반영.
  - `date` 미지정 시 오늘 기준 윈도우로 동작(고정 clock 주입).
  - 잘못된 `date`(예: `foo`) → 400 `invalid-date`.

## Acceptance Criteria

```bash
npm run build && npm run lint && npm run test
```

기대 단언(요약):
- `digestWindow`/`computeLogDigest`가 전날 06:00~당일 05:59 윈도우를 경계 정확히 필터·집계한다(결정적·순수).
- `GET /api/logs/digest`가 세션 게이트 아래 다이제스트를 반환하고, 미인증 401·잘못된 date 400이다.
- DB/파일을 전혀 접촉하지 않는다(in-memory 스냅샷 집계).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 코어는 순수·결정적(시각은 인자)·외부 의존 0·DB 미접촉·라우트는 위임만·세션 게이트만(role 없음)·읽기 전용(로그 버퍼 변형 없음)·logService 단일 인스턴스 공유.
3. 결과에 따라 `phases/26-realtime-log-viewer/index.json`의 step 2를 갱신(completed+summary / error / blocked).

## 금지사항

- 집계 코어에서 `Date.now()`/전역 시각/랜덤/전역 상태를 읽지 마라. 이유: 결정성·단위 테스트 용이성이 이 코어의 존재 이유(②) — 시각은 인자로만 받는다.
- 다이제스트 계산 중 로그 버퍼를 변형(정렬 in-place/삭제)하지 마라. 이유: `entries()`는 복사본이지만 append-only·읽기 전용 불변을 유지한다(DB 비파괴 정신).
- 다이제스트 라우트에 역할(R/D/Z) 게이트를 붙이지 마라(세션 게이트만). 이유: 읽기 전용은 기존 읽기 라우트와 동일한 인증 경계.
- 라우트/컨트롤러에서 윈도우·집계 로직을 재구현하지 마라. 이유: `src/services/logDigest.js` 순수 코어에 위임 — 얇은 transport(ADR-006).
- 06:00 타이머/스케줄러/Slack 전송 코드를 이 step에 넣지 마라. 이유: step3(스케줄러/어댑터) 책임 — 코어는 트리거 무관해야 테스트 가능(③).
- DB 테이블/스키마를 만들거나 건드리지 마라. 이유: 이 기능은 in-memory 전용 — DB 미접촉이 원칙(DB 비파괴).
- 잘못된 date 입력에 throw하지 마라(`invalid-date` 객체 반환). 이유: 로깅/다이제스트 조회가 500으로 터지면 안 된다(graceful).
