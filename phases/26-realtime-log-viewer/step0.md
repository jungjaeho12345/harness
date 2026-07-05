# Step 0: logging-core — 무의존 in-memory 링 버퍼 + 로그 포맷터 + EventEmitter 방출

## 배경 / 요구사항

`docs/LOGS.md`의 "실시간 로그 뷰어"는 **서버에서 발생하는 로그를 웹 페이지에 실시간으로 표시**하고, 매일 06:00에 전날 하루치 로그를 모아 전달하는 기능이다. 요구조건 중 핵심 제약:

- **로그 파일을 디스크에 저장하지 않는다.**
- 로그 라인 포맷은 정확히 `[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지`.

### 확정된 설계 결정 (그대로 구현 — 오케스트레이터가 사용자와 합의)

- **외부 로깅 라이브러리(winston/pino/log4js/log4j 등) 도입 금지.** LOGS.md의 "log4j"는 이 Node/JS 스택 + ADR 최소 의존성 철학(ADR.md 철학, 런타임 의존성은 Express·보안 미들웨어뿐)에 맞춰 **무의존 in-memory 방식**으로 해석한다. Node 내장 `EventEmitter`만 쓴다.
- **파일 미저장.** 로그는 메모리 링 버퍼에만 담는다. `fs`로 로그를 기록하지 마라.
- 다음 step들이 소비할 수 있도록, 링 버퍼는 **다이제스트 윈도우(24시간)를 담을 만큼**의 엔트리를 보유한다(용량 상한은 파라미터로 주입). 이는 여전히 "파일 미저장"이다.

이 step은 **백엔드 도메인 모듈(`src/`)만** 다룬다. HTTP/Express·SSE·다이제스트·스케줄러·프론트는 이후 step 책임이다. 순수/주입형으로 만들어 in-memory 단위 테스트가 쉬워야 한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 백엔드 계층 분리(controllers→services→models→db), 모든 의존성 주입 가능, 명령어(`npm run test`/`npm run lint`).
- `/docs/ADR.md` — 철학(외부 의존성 최소화·표준 기능 우선·TDD), ADR-005(서버 in-process `EventEmitter` 기반 실시간 — 이 패턴을 재사용한다), ADR-006(얇은 transport + 계층형 도메인·주입 가능).
- `/docs/LOGS.md` — 요구조건 전문(파일 미저장·라인 포맷·06:00 다이제스트).
- `server/index.js` L278~288 — 기존 SSE 무효화 버스(`const bus = new EventEmitter(); bus.setMaxListeners(0); app.notifyChange = ...`). **이 EventEmitter 패턴을 로그 방출에 재사용**한다(로그용 별도 emitter를 이 모듈이 소유).
- `src/services/sessionService.js` — 주입형 팩토리(`createXxx({...})`) 컨벤션 참고(순수·in-memory·의존성 주입).
- `test/sessionService.test.js` 또는 `test/articleService.test.js` — `node --test` 백엔드 테스트 컨벤션(팩토리 생성 → 동작 단언).

## 작업

TDD로 진행한다(`node --test`). **먼저 `test/logService.test.js`를 작성**하고 통과하는 최소 구현을 만든다. 이 step은 순수 도메인 모듈 하나(`src/services/logService.js`)와 그 테스트만 만든다.

### 1. 로그 포맷터 (순수 함수)

- 엔트리 → `[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지` 문자열을 만드는 **순수 함수** `formatLogLine(entry)`를 만든다.
- 타임스탬프는 엔트리의 시각(예: epoch ms 또는 `Date`)에서 **연/월/일/시/분/초를 로컬 Date 접근자(`getFullYear`/`getMonth`+1/`getDate`/`getHours`/`getMinutes`/`getSeconds`)로 도출**하고 2자리 zero-pad한다. 이유(반드시 준수): 로컬 컴포넌트 기반이면 테스트가 `new Date(2026, 6, 5, 6, 0, 0)`처럼 로컬 컴포넌트로 Date를 만들어 단언하므로 실행 머신의 타임존과 무관하게 결정적이다(외부 tz 라이브러리 불필요).
- LEVEL은 대문자 문자열(예: `INFO`/`WARN`/`ERROR`/`DEBUG`). 알 수 없는 값이 들어오면 대문자화만 한다(별도 검증/throw 금지 — 로깅이 애플리케이션을 멈추면 안 된다).
- 메시지는 문자열로 강제(coerce)한다(비문자열은 `String(...)`). 개행이 포함돼도 그대로 둔다(라인 자체는 한 엔트리).

### 2. in-memory 링 버퍼 + EventEmitter (주입형 팩토리)

- `src/services/logService.js`에 `createLogService({ capacity, clock, emitter } = {})` 팩토리를 만든다.
  - `capacity`: 보유할 최대 엔트리 수. 기본값은 24시간치를 넉넉히 담을 상수(예: `50000` 정도 — 정확한 수치는 재량이되 상수로 명시하고 주석에 "24h in-memory, 파일 미저장" 근거를 남긴다). 상한 초과 시 **가장 오래된 엔트리부터 제거**(FIFO)한다.
  - `clock`: 현재 시각을 주는 함수(기본 `() => Date.now()` 또는 `() => new Date()`). 테스트가 고정 시각을 주입할 수 있어야 한다.
  - `emitter`: 주입형 `EventEmitter`(기본 새 인스턴스). `setMaxListeners(0)`로 동시 구독 경고를 막는다(server/index.js L280 패턴).
- 노출 인터페이스(시그니처 수준 — 구현 재량, 계약은 준수):
  - `log(level, message)` — 현재 시각으로 엔트리 `{ ts, level, message, line }`(line=formatLogLine 결과)를 만들어 링 버퍼에 push(초과 시 shift)하고 `emitter.emit('log', entry)`로 방출한다. 반환값은 엔트리(또는 재량). **파일/DB 기록 없음.**
  - 편의 레벨 메서드(선택): `info/warn/error/debug`가 `log(LEVEL, msg)`로 위임. (필수는 아님 — `log(level,msg)`만으로도 계약 충족.)
  - `entries({ since } = {})` — 현재 버퍼의 엔트리 배열 **복사본**(원본 노출/변형 금지)을 시각 오름차순으로 반환. `since`(epoch ms)가 주어지면 그 이후만. 다음 step의 다이제스트가 이 스냅샷을 입력으로 쓴다.
  - `subscribe(onEntry)` — `emitter.on('log', onEntry)`를 걸고 `unsubscribe`를 돌려준다(구독 해제 함수). SSE 라우트(step1)가 이걸로 신규 라인을 받는다.
  - `LEVELS`(상수 배열/객체, 선택) 노출은 재량.
- **엔트리 구조**: 최소 `{ ts(epoch ms), level, message, line }`. `line`은 미리 포맷된 표시 문자열(프론트가 그대로 렌더). 구조체 필드(ts/level/message)도 보존해 다이제스트 집계(step2)가 시각·레벨로 필터/집계할 수 있게 한다.

### 3. 테스트 (먼저 작성)

`test/logService.test.js`:
- `formatLogLine`이 고정 Date로 정확히 `[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지`를 만든다(zero-pad 포함, 예: `[2026-07-05 06:00:00] [INFO] 서버 시작`).
- `log`이 엔트리를 버퍼에 쌓고 `entries()`가 시각순 복사본을 돌려준다(반환 배열을 변형해도 내부가 안 바뀜 — 복사본 단언).
- `capacity` 초과 시 가장 오래된 엔트리가 제거된다(작은 capacity 주입으로 FIFO 단언).
- `clock` 주입으로 타임스탬프가 결정적이다.
- `subscribe(fn)`가 이후 `log()` 호출마다 엔트리를 받고, `unsubscribe()` 후에는 더 이상 받지 않는다.
- `entries({ since })`가 경계 시각으로 올바르게 필터한다.

## Acceptance Criteria

```bash
npm run test          # 서버(node --test) — logService 신규 테스트 포함 전체 통과
npm run lint          # ESLint
```

기대 단언(요약):
- `formatLogLine`이 정확한 포맷 문자열을 만든다(로컬 컴포넌트 기반, tz 무관 결정적).
- 링 버퍼가 FIFO 상한을 지키고 `entries()`가 복사본을 돌려준다.
- `subscribe/unsubscribe`가 `log` 이벤트를 정확히 전달/해제한다.
- 파일시스템(`fs`)·DB·HTTP를 전혀 건드리지 않는다(순수 in-memory).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 외부 npm 의존 0(내장 `node:events`만)·파일 미저장·순수/주입형(clock/capacity/emitter 주입 가능)·`entries()` 복사본 반환·HTTP/Express 코드 없음.
3. 결과에 따라 `phases/26-realtime-log-viewer/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- winston/pino/log4js/log4j 등 외부 로깅 라이브러리를 추가하지 마라. 이유: ADR 최소 의존성 철학 — 내장 `EventEmitter`만 쓴다.
- 로그를 파일/DB에 쓰지 마라(`fs.writeFile`/`appendFile`/DB insert 금지). 이유: LOGS.md 요구조건 "로그 파일은 저장하지 않는다".
- `entries()`가 내부 버퍼 배열을 그대로 반환하지 마라. 이유: 외부 변형이 버퍼를 오염시킨다 — 복사본을 반환한다.
- 포맷터에서 `Intl`/외부 타임존 라이브러리나 `toISOString()`을 쓰지 마라. 이유: 포맷은 정확히 `[YYYY-MM-DD HH:MM:SS]`(ISO의 `T`/`Z` 아님)이며, 로컬 컴포넌트 기반이라야 테스트가 결정적이다.
- HTTP/Express 라우트·SSE·다이제스트·스케줄러·프론트 코드를 이 step에 넣지 마라. 이유: 각각 step1~5의 책임 — 이 step은 로깅 코어 한 레이어만.
- 로깅 실패(예: 이상한 level/message)에 throw하지 마라. 이유: 로깅이 애플리케이션 흐름을 중단시키면 안 된다(coerce/무시로 흡수).
