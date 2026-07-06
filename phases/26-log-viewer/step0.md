# Step 0: log-service — 자체 경량 로거(포맷/레벨/링버퍼/구독/다이제스트) 순수 모듈

## 배경 / 요구사항

이 phase는 **웹에서 실시간으로 서버 로그를 확인하는 뷰어**(스펙 `docs/LOGS.md`)를 만든다. 이 step은 그 토대인 **자체 경량 로거 서비스**를 만든다. 다른 코드는 건드리지 않는다(순수 모듈 + 테스트만).

### 확정된 설계 결정 (그대로 구현 — 사용자 확정, 변경 불가)

- **자체 경량 로거 = zero-dep 구현.** LOGS.md의 "log4j를 사용한다"는 **log4j '스타일'(레벨 체계 + `[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지` 포맷)의 무의존 구현**으로 해석 확정됐다. **새 npm 의존성을 절대 추가하지 마라**(log4js/winston/pino/node-cron 등 금지). Node 표준 기능만 쓴다(ADR 철학 — 런타임 의존성 최소화).
- **보존 = in-memory 링 버퍼(파일/DB 저장 금지).** LOGS.md "log 파일은 저장하지 않는다"를 준수한다. **DB에도 저장하지 않는다** — CLAUDE.md "DB 내용 절대 삭제 금지" 규칙상 로그를 DB에 넣으면 prune이 불가능해 무한 증식한다. 로그는 상한(cap)이 있는 메모리 링 버퍼에만 담고, cap 초과 시 **가장 오래된 항목부터 버린다**. 서버 재시작 시 버퍼 유실은 스펙 내재 트레이드오프로 수용한다.
- **다이제스트 = pull 방식.** 매일 오전 6시 전달(LOGS.md)은 이 앱이 아니라 **하네스 운영 루틴(phase 범위 밖)**이 API를 읽어 수행한다. 이 모듈은 6시 타이머/외부 전송을 넣지 않고, "전날 06:00 ~ 당일 05:59:59.999" 24시간 창을 계산해 돌려주는 **순수 함수 `digest()`만** 제공한다.

### 시계·타임존 결정 (이 계획에서 확정 — 결정성 확보)

- **`now`는 주입한다.** `sessionService`(src/services/sessionService.js)가 `createSessionService({ now = () => Date.now() })`로 시계를 주입해 결정성을 얻는 선례를 그대로 따른다. **`Date.now()`를 모듈 내부에서 직접 호출하지 마라** — 테스트가 가짜 시계를 주입한다.
- **타임존 = 주입 가능한 고정 오프셋, 기본값 KST(UTC+9 = `tzOffsetMinutes: 540`).** 이유: LOGS.md의 표시 포맷 `[YYYY-MM-DD HH:MM:SS]`와 다이제스트 "오전 6시" 경계는 한국 뉴스룸의 **벽시계(로컬) 시각**을 의미한다. 프로세스 TZ에 의존하면 테스트가 비결정적이므로, `now`(epoch ms)에 오프셋을 더해 **UTC 필드로 포맷/경계 계산**한다(프로세스 `TZ` 환경변수에 의존 금지 — 결정성). `Intl`/외부 tz 라이브러리를 쓰지 마라(zero-dep).

## 읽어야 할 파일

먼저 아래를 읽고 아키텍처·시계 주입·zero-dep 철학을 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 백엔드 계층(services는 transport 비의존·주입 가능), 명령어(`npm run test` = node --test, `npm run lint`).
- `/docs/ADR.md` — 철학(외부 의존성 최소화·표준 기능 우선·TDD), ADR-002(Node 내장 모듈만).
- `/docs/LOGS.md` — 스펙 원문(로그 포맷·파일 미저장·다이제스트).
- `src/services/sessionService.js` — **시계 주입 선례**: `createSessionService({ now = () => Date.now() } = {})`, `now()`로 만료 계산, 팩토리가 클로저 상태(Map)를 캡슐화하고 메서드 객체를 반환하는 패턴. **이 형태를 그대로 본떠라.**
- `test/sessionService.test.js` — 시계를 가짜로 주입해 시간 경계를 결정적으로 검증하는 테스트 컨벤션(`node --test` + `node:assert/strict`).

## 작업

TDD로 진행한다(`node --test`). **테스트를 먼저 작성**하고 통과하는 구현을 만든다. 이 step은 **`src/services/logService.js` 순수 모듈 + `test/logService.test.js` 하나**만 만든다. 다른 파일은 건드리지 않는다.

### 1. 모듈 — `src/services/logService.js`

팩토리 시그니처(구현은 재량이되 계약·불변식은 준수):

```js
export const LOG_LEVELS = Object.freeze(['DEBUG', 'INFO', 'WARN', 'ERROR']); // log4j 스타일 서열(낮음→높음)

// now: 시계 주입(epoch ms). cap: 링 버퍼 상한(줄 수). tzOffsetMinutes: 표시/다이제스트 경계 타임존(기본 KST=540).
export function createLogService({ now = () => Date.now(), cap = 10000, tzOffsetMinutes = 540 } = {}) {
  // ... 링 버퍼 + 구독자 집합 + 단조 seq 카운터 (클로저 캡슐화)
  return {
    log,        // (level, message) => record   — level을 대문자화·검증(미지값은 'INFO')
    debug, info, warn, error, // (message) => record — log(LEVEL, message) 편의 래퍼
    snapshot,   // () => record[]                — 현재 버퍼 복사본(오래된→최신). SSE 접속 replay용.
    subscribe,  // (listener) => unsubscribe     — 새 record마다 listener(record) 호출. 반환은 해제 함수.
    digest,     // (atMs = now()) => record[]    — 아래 창 규칙 구간의 record 배열.
    size,       // () => number                  — 현재 버퍼 길이(테스트/관측용).
    subscriberCount, // () => number             — 현재 구독자 수(step2 SSE 구독 해제 누수 테스트 관측용).
  };
}
```

**record shape (파이프라인 전체에서 이 형태를 유지 — step2 SSE·step3 model·step4 뷰가 이 필드에 의존):**

```js
{ seq, ts, level, message, line }
```
- `seq`: 프로세스 수명 동안 **단조 증가하는 정수**(1부터). 버퍼에서 항목이 evict돼도 재사용하지 않는다. 이유: step4 클라이언트가 SSE 재연결 replay 시 `seq`로 중복을 걸러낸다(React key로도 씀).
- `ts`: `now()`가 준 epoch ms.
- `level`: `LOG_LEVELS`의 한 값(대문자).
- `message`: 문자열(비문자열은 `String(...)`로 강제).
- `line`: `[YYYY-MM-DD HH:MM:SS] [LEVEL] message` 포맷 문자열(LOGS.md 그대로).

**포맷 규칙 (핵심 불변식):**
- `line`은 정확히 `` `[${YYYY-MM-DD HH:MM:SS}] [${LEVEL}] ${message}` `` 형태다. 날짜/시각은 `ts + tzOffsetMinutes*60000`을 만든 뒤 **UTC getter(getUTCFullYear 등)로 자릿수 0-pad** 해서 뽑는다(프로세스 `TZ`에 의존 금지). 별도 pure 헬퍼(예: `export function formatTimestamp(ts, tzOffsetMinutes)`)로 빼서 단위 테스트하는 것을 권장한다.

**링 버퍼 불변식 (핵심):**
- 버퍼 길이는 **절대 `cap`을 초과하지 않는다.** 초과 시 **가장 오래된 record부터 버린다**(FIFO evict).
- 과거 record는 변형하지 않는다(append-only 메모리). 파일/DB에 쓰지 않는다.
- `cap`은 기본 10000(저트래픽 전제에서 24시간 다이제스트 창을 감당하는 크기 — step1의 요청당 INFO 로깅 볼륨이 크면 부족할 수 있다). 단, 24시간에 10000줄을 넘기면 오래된 항목이 evict되어 `digest()`가 그만큼 놓칠 수 있다 — **문서화된 트레이드오프로 수용**(cap을 무한으로 만들지 마라).

**`digest(atMs)` 창 규칙 (정확히 이 반열림 구간):**
- `boundary` = `atMs` 이하이면서 로컬(tzOffset 적용) 시각이 **06:00:00.000**인 가장 최근 순간.
- 반환 = 버퍼 record 중 `start <= ts < boundary` 인 것들. 여기서 `start = boundary - 24h`.
- 즉 운영 루틴이 D일 06:00:00에 호출하면 창은 **[D-1 06:00:00, D 06:00:00)** = "전날 06:00 ~ 당일 05:59:59.999"(LOGS.md). D 05:59:59.999 로그는 포함, D 06:00:00 로그는 제외.
- **비밀 마스킹은 이 모듈 책임이 아니다** — logService는 받은 문자열을 그대로 저장한다. 호출자(step1)가 세션 토큰·비밀번호를 message에 넣지 않을 책임을 진다.

### 2. 테스트 — `test/logService.test.js` (먼저 작성)

가짜 시계(`let clock; const now = () => clock;`)를 주입해 결정적으로 검증한다:
- `info('x')` 후 `snapshot()`에 record 1건, `line`이 `/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[INFO\] x$/`에 매치.
- `formatTimestamp`(있으면)가 고정 ts + `tzOffsetMinutes:540`에서 기대 문자열을 낸다(예: ts가 KST 06:00에 해당하는 값 → `... 06:00:00`). ts는 직접 계산해 넣는다.
- 레벨 서열: `debug/info/warn/error`가 각각 올바른 `level`을 record에 넣는다.
- `seq`가 1,2,3…으로 단조 증가한다.
- **링 버퍼 evict**: `cap:3`으로 5건 기록 후 `snapshot()`이 최신 3건(seq 3,4,5)만, `size()===3`. cap을 넘겨도 길이가 3을 유지.
- `subscribe(listener)`: 구독 후 기록하면 listener가 record로 호출되고, `unsubscribe()` 후에는 호출되지 않는다.
- `subscriberCount()`: 구독 2건 등록 시 2, 각 unsubscribe 후 감소해 0으로 복귀한다.
- **`digest` 경계**: 가짜 시계로 D-1 05:59 / D-1 06:00 / D-1 12:00 / D 05:59 / D 06:00 시점 record를 심고, `digest(D일 06:00:00 ms)`가 **[D-1 06:00:00, D 06:00:00)** 구간만 반환(D-1 05:59 제외, D-1 06:00 포함, D 06:00 제외)함을 단언. `tzOffsetMinutes:540` 기준 경계 ms는 테스트에서 직접 계산.
- **`now` 미직접호출 확인(선택)**: `now`를 주입하지 않고도 기본값이 동작하지만, 주입한 `now`만으로 모든 시간 결과가 결정됨을 위 테스트들이 이미 보장한다.

## Acceptance Criteria

```bash
npm run test          # node --test — logService 신규 테스트 + 기존 전체 통과(회귀 없음)
npm run lint          # ESLint
```

기대 단언(요약): 포맷 `[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지` 정확·레벨 서열·단조 seq·링 버퍼가 cap에서 오래된 항목 evict·subscribe/unsubscribe·subscriberCount 관측·digest가 [전날06:00, 당일06:00) 반열림 창을 KST 기준으로 반환.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 새 npm 의존성 0(package.json 미변경)·`Date.now()` 직접호출 없음(now 주입)·파일/DB 쓰기 없음(순수 메모리)·링 버퍼 cap 강제·record shape(`seq/ts/level/message/line`) 준수·`src/services/`에만 파일 추가.
3. 결과에 따라 `phases/26-log-viewer/index.json`의 step 0을 갱신(completed+summary / error / blocked). summary에 파일 경로(`src/services/logService.js`)·record shape·팩토리 시그니처·digest 창 규칙을 한 줄로 남겨 다음 step이 참조하게 한다.

## 금지사항

- 새 npm 패키지를 추가하지 마라(log4js/winston/pino/node-cron 등). 이유: 사용자 확정 결정 — zero-dep 자체 구현. package.json dependencies를 건드리면 이 phase의 전제가 무너진다.
- 로그를 파일이나 DB에 쓰지 마라. 이유: LOGS.md "파일 미저장" + CLAUDE.md "DB 삭제 금지"(DB에 넣으면 prune 불가·무한 증식). 링 버퍼(메모리)만.
- 링 버퍼에 상한을 두지 않거나(무한 배열) evict를 생략하지 마라. 이유: 장시간 구동 시 메모리 무한 증식.
- 모듈 내부에서 `Date.now()`/`new Date()`(인자 없는)를 직접 호출하지 마라. 이유: 결정성 — 시계는 `now` 주입으로만 얻는다(sessionService 선례).
- 타임존을 프로세스 `TZ`나 로컬 `getHours()` 등 로컬 getter로 계산하지 마라. 이유: 비결정적 — `tzOffsetMinutes` 적용 후 UTC getter로만 포맷/경계 계산.
- 6시 타이머·setInterval·외부 전송(fetch/webhook)을 넣지 마라. 이유: 다이제스트는 pull 전용(순수 `digest()`), 전달은 운영 루틴 책임(phase 범위 밖).
- `server/`·`web/`·다른 서비스/컨트롤러를 이 step에서 수정하지 마라. 이유: 이 step은 logService 순수 모듈 + 그 테스트만. 결선은 step1~4.
- 기존 테스트를 깨뜨리지 마라.
