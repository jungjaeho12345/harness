# Step 3: digest-scheduler — 06:00 트리거(주입형·비활성 가능) + Slack 전송 어댑터(주입형)

## 배경 / 요구사항

`docs/LOGS.md`: "매일 오전 6시에 전날 하루치 로그를 모아 harness-orchestrator에게 전달한다." step2에서 만든 순수 다이제스트 코어(`computeLogDigest`) 위에 **(A) 매일 06:00 트리거 → Slack `#harness` 전송 어댑터**를 얇게 얹는다. 코어/조회 API와 분리해, 스케줄러는 트리거 방식과 무관하게 코어를 재사용하고, 전송은 주입형으로 격리한다.

### 확정된 설계 결정 (그대로 구현 — 오케스트레이터가 사용자와 합의)

- **코어와 스케줄러/Slack 어댑터를 분리한다.** 코어(step2 `computeLogDigest`)는 이미 순수·결정적이다. 이 step은 그것을 호출하는 **얇은 트리거 + 주입형 전송**만 만든다.
- **전송 어댑터는 주입형(전송 함수 주입)**이다. 실제 Slack 연동이 수동 설정/토큰을 요구하면 그 부분은 blocked 대상이 될 수 있으므로, 어댑터를 코어/API와 분리해 **코드 자체는 no-op/console 기본 전송으로 완결**되게 한다(아래 blocked 후보 명시).

### ③ 스케줄러 위치 결정: **in-process 타이머(주입형·기본 off, 부트스트랩에서만 명시 start)**  — 근거를 반드시 남긴다

오케스트레이터가 in-process vs 외부 스케줄(하네스 Routine/cron) 중 택일하고 근거를 남기라고 했다. **in-process 타이머**를 택한다. 근거(step md에 남길 것):

1. **자기완결성**: 로그 버퍼가 in-memory(파일 미저장)라 다이제스트도 **같은 프로세스 메모리**에서만 계산 가능하다. 외부 cron이 별도 프로세스로 돌면 이 버퍼에 접근할 수 없다(외부 cron은 결국 API를 때려 pull해야 하는데, 그건 이미 step2 `GET /api/logs/digest`가 제공한다). 즉 **push는 in-process, pull은 외부**라는 자연 분업이 성립한다.
2. **기존 패턴 정합**: 부트스트랩에서 `createFtpWatcher`를 조건부로 `start()`하는 패턴(server/index.js L719~731)과 동일하게, 스케줄러도 부트스트랩에서만 조건부 `start()`한다.
3. **테스트/수명주기 부담 회피**: 타이머·전송·clock을 **모두 주입**하고 **기본 off**(명시 `start()` 전엔 아무 것도 안 함)로 둔다. `createApp`/테스트는 스케줄러를 절대 켜지 않으므로 실제 타이머가 테스트를 오염시키지 않는다.

이 step은 **스케줄러 도메인 모듈(`src/`) + 부트스트랩 조건부 배선(`server/index.js` bootstrap)** 한 레이어다. `createApp`(라우트) 자체는 건드리지 않는다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 주입 가능성·계층 분리·명령어. CLAUDE.md "각 작업이 끝날 때마다 slack의 harness 채널로 내용 전달" (Slack #harness 맥락).
- `/docs/ADR.md` — 철학(외부 의존 최소·TDD), ADR-006(주입형·부트스트랩 조립).
- `/docs/LOGS.md` — 06:00 트리거·전날 하루치·harness-orchestrator 전달.
- `/home/user/harness/src/services/logDigest.js` — step2. `digestWindow`/`computeLogDigest`(순수). **재구현 금지 — 재사용.**
- `/home/user/harness/src/services/logService.js` — step0. `entries()` 스냅샷(집계 입력).
- `/home/user/harness/server/index.js` — **결선 지점**: L699~732 `bootstrap()`. 특히 L719~731 `createFtpWatcher({ dir, onFile }).start()` **조건부 시작 패턴**(env 미설정 시 비활성). 여기에 스케줄러 조건부 `start()`를 추가한다. `logService` 단일 인스턴스(step1/step2에서 생성)를 스케줄러에 넘긴다.
- `/home/user/harness/server/ftpWatcher.js` — 주입형 watcher 팩토리(`createFtpWatcher({...})` + `start/stop`, 실제 FS/타이머 주입 가능) 컨벤션. **스케줄러도 이 형태(주입형 setTimer + start/stop)를 따른다.**
- `/home/user/harness/test/ftpWatcher.test.js` — 주입형 타이머/의존성으로 실제 타이머 없이 테스트하는 컨벤션.

## 작업

TDD로 진행한다(`node --test`). **먼저 스케줄러 테스트(주입 타이머/전송/clock)**를 작성하고 통과 구현을 만든다. 이 step은 스케줄러 모듈 + 부트스트랩 배선만.

### 1. 다음 06:00까지의 지연 순수 함수 — `src/services/digestScheduler.js`

- `msUntilNextRun(now, hour = 6)` → 다음 `hour`시(로컬)까지 남은 ms. `now`가 오늘 06:00 이전이면 오늘 06:00, 이후면 내일 06:00. 순수·결정적(now는 인자). 로컬 Date 컴포넌트 기반(step0/step2 근거와 동일).

### 2. 스케줄러 팩토리(주입형·기본 off) — `src/services/digestScheduler.js`

- `createDigestScheduler({ logService, sendDigest, clock, setTimer, clearTimer, hour } = {})`:
  - `logService`: step0 인스턴스(`entries()`).
  - `sendDigest(digest)`: **주입형 전송 함수**(Slack 어댑터). 기본값은 no-op(또는 `logService.log('INFO', ...)`로 흔적만). 실제 전송은 부트스트랩이 주입.
  - `clock`: `() => new Date()`(기본). 테스트 고정 시각 주입.
  - `setTimer`/`clearTimer`: 기본 `setTimeout`/`clearTimeout`. 테스트가 즉시 실행/취소 가짜를 주입.
  - `hour`: 기본 6.
  - 노출: `start()` / `stop()`. **생성만으로는 아무 것도 하지 않는다(기본 off) — `start()` 호출 시에만 타이머 예약.**
  - `start()`: `msUntilNextRun(clock(), hour)`만큼 `setTimer`로 예약 → 발화 시 (a) `runDate = clock()`로 `computeLogDigest(logService.entries(), runDate)` 계산, (b) `sendDigest(digest)` 호출(예외는 try/catch로 격리 — 전송 실패가 스케줄러를 죽이면 안 됨), (c) 다음 06:00 재예약. `stop()`은 `clearTimer`로 예약 취소.
  - **결정적 테스트 가능**: 실제 시간 흐름 없이, 주입 `setTimer`가 콜백을 즉시/수동 실행하게 해 발화→집계→sendDigest 경로를 단언한다.

### 3. Slack 전송 어댑터(주입형·무의존) — `src/services/slackDigestSender.js` (또는 동일 파일 내 팩토리)

- `createSlackDigestSender({ webhookUrl, fetchFn, formatDigest } = {})` → `sendDigest(digest)` 함수를 반환.
  - `webhookUrl` **미설정이면 no-op(또는 콘솔/logService 기록)** — 토큰/URL 없이도 코드가 완결된다.
  - 설정 시 `fetchFn`(기본 전역 `fetch`, ADR 최소 의존 — `@slack/*` 등 라이브러리 금지)으로 Incoming Webhook에 `{ text: formatDigest(digest) }`를 POST. 실패는 삼켜서(로그만) 스케줄러를 방해하지 않는다.
  - `formatDigest(digest)` 순수 함수: 다이제스트 → 사람이 읽을 텍스트(날짜·total·byLevel 요약·주요 라인). Slack 마크다운은 최소.
- **CRITICAL(blocked 후보)**: 실제 Slack 배달에는 **Incoming Webhook URL(사용자/오케스트레이터 제공 시크릿)**이 필요하다. 이는 런타임 env(`SLACK_WEBHOOK_URL` 등) 설정 사안이지 코드 blocker가 아니다 — 어댑터는 URL 미설정 시 no-op으로 완결된다. 다만 **"라이브 Slack 배달 검증"을 요구받으면 webhook URL이 없어 그 검증 항목은 blocked**가 될 수 있다. 이 경우 코드/테스트(주입 전송으로 경로 검증)는 완료하고, 라이브 배달만 blocked로 보고한다(아래 금지사항/주의 참조).

### 4. 부트스트랩 조건부 배선 — `server/index.js` `bootstrap()`

- `createFtpWatcher` 조건부 시작(L719~731)과 **같은 형태**로 스케줄러를 조건부 시작한다:
  - step1/step2에서 만든 `logService` 단일 인스턴스를 재사용.
  - `sendDigest`는 `createSlackDigestSender({ webhookUrl: process.env.SLACK_WEBHOOK_URL })`로 만든다(env 없으면 no-op).
  - 스케줄러 자동 시작은 **명시 opt-in**: 예) `process.env.DIGEST_SCHEDULER === 'on'`(또는 `SLACK_WEBHOOK_URL` 존재)일 때만 `scheduler.start()`. 기본은 off(테스트/로컬에서 타이머가 안 돈다). 근거를 주석에 남긴다.
- `createApp`(라우트 팩토리)는 **수정하지 않는다** — 스케줄러는 부트스트랩 전용 배선이다.

### 5. 테스트 (먼저 작성)

- `test/digestScheduler.test.js`:
  - `msUntilNextRun`: now가 06:00 이전/이후 각각 오늘/내일 06:00까지의 ms를 맞게 준다(고정 로컬 Date 단언).
  - 생성만으로는 `setTimer`가 호출되지 않는다(기본 off), `start()` 후에만 예약된다.
  - 주입 `setTimer`로 발화를 수동 트리거 → `sendDigest`가 그 시점 다이제스트(step2 코어 결과)로 호출된다. 재예약이 걸린다.
  - `sendDigest`가 throw해도 스케줄러가 죽지 않고 재예약된다(격리).
  - `stop()`이 `clearTimer`로 예약을 취소한다.
  - `createSlackDigestSender`: `webhookUrl` 없으면 `fetchFn` 미호출(no-op), 있으면 주입 `fetchFn`으로 POST(요청 shape 단언), fetch 실패를 삼킨다.

## Acceptance Criteria

```bash
npm run build && npm run lint && npm run test
```

기대 단언(요약):
- `msUntilNextRun`이 다음 06:00까지를 정확히 계산한다(결정적).
- 스케줄러가 기본 off, `start()` 시에만 예약, 발화 시 step2 코어로 집계해 주입 `sendDigest`를 호출하고 재예약한다(주입 타이머로 실시간 없이 검증).
- Slack 어댑터가 webhook 미설정 시 no-op, 설정 시 주입 fetch로 POST하며 실패를 격리한다.
- `createApp`/기존 라우트/서버 테스트에 회귀가 없다(스케줄러는 부트스트랩 전용).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 스케줄러 기본 off·타이머/전송/clock 전부 주입·전송 실패 격리·코어(step2) 재사용(재구현 없음)·`createApp` 미접촉·`@slack/*` 등 외부 의존 없음(fetch만)·파일/DB 미접촉.
3. 결과에 따라 `phases/26-realtime-log-viewer/index.json`의 step 3을 갱신(completed+summary / error / **blocked**(라이브 Slack webhook 미제공 시 라이브 배달 항목만)).

## 금지사항

- 스케줄러를 `createApp`이나 모듈 로드 시점에 자동 시작하지 마라. 이유: 테스트/로컬에서 실제 타이머가 돌아 수명주기·테스트를 오염시킨다(③) — 부트스트랩에서 명시 opt-in start만.
- 실제 `setTimeout`/`Date.now()`에 테스트가 의존하게 하지 마라. 이유: 결정성 상실 — `setTimer`/`clock`을 주입해 수동 발화로 검증한다.
- `@slack/web-api`·`node-cron` 등 외부 라이브러리를 추가하지 마라. 이유: ADR 최소 의존성 — Incoming Webhook + 전역 `fetch`로 충분.
- 전송(`sendDigest`) 실패를 삼키지 않고 던지게 두지 마라. 이유: Slack 장애가 스케줄러/서버를 죽이면 안 된다(try/catch 격리).
- 다이제스트 윈도우/집계 로직을 스케줄러에 재구현하지 마라. 이유: step2 `computeLogDigest` 순수 코어에 위임(단일 소스).
- 로그/다이제스트를 파일이나 DB에 저장하지 마라. 이유: LOGS.md 파일 미저장 + 이 기능은 in-memory 전용(DB 비파괴).
- Slack webhook URL/토큰을 코드/설정 파일에 하드코딩하지 마라. 이유: 시크릿은 런타임 env(`SLACK_WEBHOOK_URL`)로만. 미설정이면 no-op으로 완결하고, 라이브 배달 검증이 요구되면 **blocked 후보**로 보고한다(사용자 개입=webhook URL 필요).
