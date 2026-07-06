# Step 3: model-log-seam — Model 계약 3면에 subscribeLogs · getLogsDigest 추가

## 배경 / 요구사항

Step 2에서 서버가 Z 전용 로그 API 두 개를 노출했다:
- `GET /api/logs/stream` — SSE. `event: ready`(연결됨) → `event: log` + record JSON(`{ seq, ts, level, message, line }`)를 접속 시 replay + 이후 실시간 push.
- `GET /api/logs/digest` — `{ ok: true, items: [record...] }` JSON(24시간 창).

이 step은 프론트엔드 **Model 계약(ADR-003)**에 이 두 API를 잇는다. Model은 View/Controller가 transport를 모르게 하는 단일 통합 seam이다. **키를 추가하면 3개 파일을 함께 고쳐야 한다**(안 그러면 `assertModel`이 throw해 앱/테스트 전체가 부팅 실패):
1. `web/src/model/contract.js` — `MODEL_KEYS`에 키 추가.
2. `web/src/model/httpModel.js` — 실제 EventSource/fetch 배선.
3. `web/src/test/fakeModel.js` — in-memory 모사.

이 step은 **model 계층만** 다룬다. 페이지/컨트롤러/라우팅은 step4다.

**참고**: `getLogsDigest`는 이 phase에서 웹 화면 소비자가 없는 **의도적 선행 제공(forward-provisioning)** 이다 — 다이제스트 전달은 운영 루틴이 서버 API를 직접 pull하고, step4는 다이제스트 UI를 만들지 않는다(별도 phase). 미결선 누락이 아니므로 소비자를 새로 만들지 마라.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC, 명령어(`npm run test:web`=vitest, `npm run build`, `npm run lint`).
- `/docs/ADR.md` — ADR-003(Model 계약 seam — MODEL_KEYS를 httpModel·fakeModel과 동기화), ADR-004(role은 서버 세션에서 도출 — 클라가 안 싣는다), ADR-005/007(SSE).
- `web/src/model/contract.js` — `MODEL_KEYS`(frozen 배열)와 `assertModel`. **키 2개 추가.**
- `web/src/model/httpModel.js` — **결선 지점(실측)**:
  - `request(...)`(L80~96) — REST 단일 통로(credentials:'include' + JSON).
  - `queryHistory`(L167~171) / `getHistorySnapshot`(L172~176) — GET 위임 패턴(role 안 실음).
  - `subscribe(filter, onChange, onStatus)`(L245~265) — **EventSource(withCredentials) 선례**: `new EventSource(url, { withCredentials: true })`, `addEventListener('ready'|'change'|'error')`, `onStatus`(ready→true/error→false), 반환 `{ connected: () => bool, unsubscribe: () => source.close() }`. **이 패턴을 그대로 본떠 로그 스트림을 잇는다.**
- `web/src/test/fakeModel.js` — **결선 지점(실측)**:
  - `histories` seed·`queryHistory`/`getHistorySnapshot`(L124~135) — seed 기반 조회 모사 선례.
  - `listeners` Set + `subscribe`(L213~221) — 구독자 집합 + `onStatus?.(true)` + `unsubscribe` 모사 선례.
- 기존 web 테스트 `web/src/model/contract.test.js`·`web/src/model/httpModel.test.js` — contract/httpModel 테스트 컨벤션(신규 단언은 여기에 추가). `web/src/test/`에는 기존 테스트 파일이 없다 — fakeModel 로그 단언은 신규 파일로 작성.

## 작업

TDD로 진행한다(vitest). **테스트를 먼저 작성**하고 통과하는 배선을 만든다. **3개 파일을 반드시 함께** 고친다.

### 1. 계약 — `web/src/model/contract.js`

- `MODEL_KEYS`에 두 키를 추가한다: `'subscribeLogs'`, `'getLogsDigest'`.
- **주의: httpModel·fakeModel 둘 다 함수로 구현하지 않으면 `assertModel`이 throw한다 — 반드시 3곳 함께.**

### 2. httpModel — `web/src/model/httpModel.js`

- `getLogsDigest()` 추가 — `queryHistory`와 동일한 `request(...)` 사용, role 안 실음(세션 도출, ADR-004):
  ```js
  // 로그 다이제스트 — Z 전용(서버 게이트). 응답 { ok, items } 그대로 반환. 읽기 전용.
  getLogsDigest() {
    return request('/api/logs/digest');
  },
  ```
- `subscribeLogs(onLog, onStatus)` 추가 — 기존 `subscribe`의 EventSource 패턴을 본뜬다:
  ```js
  // 실시간 로그 스트림(Z 전용). 인증 1차 수단은 HttpOnly 세션 쿠키 → withCredentials:true로 자동 전송.
  // 서버는 접속 시 버퍼를 replay(event: log) 후 실시간 push한다. 재연결 중복은 Controller가 record.seq로 거른다.
  subscribeLogs(onLog, onStatus) {
    const source = new EventSource(`${base}/api/logs/stream`, { withCredentials: true });
    let connected = false;
    const setStatus = (next) => { connected = next; onStatus?.(next); };
    source.addEventListener('ready', () => setStatus(true));
    source.addEventListener('log', (event) => {
      let record = null;
      try { record = event.data ? JSON.parse(event.data) : null; } catch { record = null; }
      if (record) onLog(record);
    });
    source.addEventListener('error', () => setStatus(false));
    return { connected: () => connected, unsubscribe: () => source.close() };
  },
  ```
  - 반환 shape은 기존 `subscribe`와 동일(`{ connected, unsubscribe }`). `onLog`는 record 하나씩 받는다(replay·실시간 구분 없음 — 구분/중복제거는 step4 컨트롤러가 `seq`로).
  - `EventSource`는 헤더를 못 보내므로 인증은 쿠키(withCredentials)로만 — role 게이트는 서버가 강제(ADR-004/007).

### 3. fakeModel — `web/src/test/fakeModel.js`

- seed에 로그를 받는다: `const logs = [...(seed.logs ?? [])];` (record 배열, 각 `{ seq, ts, level, message, line }` 모사). 다이제스트 seed는 `seed.logsDigest ?? logs`.
- `getLogsDigest()` 추가 — `{ ok: true, items: (seed.logsDigest ?? logs).map(r => ({ ...r })) }`(원본 불변).
- `subscribeLogs(onLog, onStatus)` 추가 — seed 로그를 **즉시 replay**한 뒤 구독 등록(서버 replay 모사):
  ```js
  subscribeLogs(onLog, onStatus) {
    for (const r of logs) onLog({ ...r });   // 접속 replay 모사
    const handler = (r) => onLog({ ...r });
    logListeners.add(handler);
    onStatus?.(true);                        // fake 스트림은 즉시 연결됨
    return { connected: () => true, unsubscribe: () => logListeners.delete(handler) };
  },
  ```
  - `logListeners`는 파일 상단의 `listeners`처럼 별도 `Set`으로 둔다. (실시간 push를 테스트에서 구동할 필요가 있으면 seed replay만으로 충분 — 무리한 emit API를 만들지 말고 최소화.)
  - **원본 seed를 변형하지 않는다**(읽기 전용 모사).

### 4. 테스트 (먼저 작성)

- **contract**: `MODEL_KEYS`에 `subscribeLogs`·`getLogsDigest`가 있고, `createFakeModel()`가 `assertModel`을 통과함을 단언(누락 시 throw 재현).
- **fakeModel**: seed `logs`를 주고 `getLogsDigest()`가 `{ ok, items }`에 그 로그를 담아 반환, `subscribeLogs`가 seed 로그를 `onLog`로 replay하고 `onStatus(true)`를 호출하며 `unsubscribe()`가 핸들러를 제거함을 단언.
- **httpModel**(가능 범위): `getLogsDigest`가 `GET /api/logs/digest`를 호출함을 `fetch` 모킹(전역 fetch stub)으로 단언. `subscribeLogs`는 `EventSource`를 모킹(jsdom에 없거나 제한적이면 전역 `EventSource`를 가짜 클래스로 주입)해 `ready`→`onStatus(true)`, `log`→`onLog(record)`가 전달됨을 단언. 기존 httpModel 테스트에 `EventSource`/`fetch` 모킹 선례가 있으면 그대로 따른다.

## Acceptance Criteria

```bash
npm run test:web      # vitest — 신규 model 단언 + assertModel 통과 + 전체 회귀
npm run build         # Vite 프로덕션 빌드(계약/배선 정합)
npm run lint          # ESLint
```

기대 단언(요약): `MODEL_KEYS`에 `subscribeLogs`/`getLogsDigest` 추가·httpModel·fakeModel 둘 다 구현해 `assertModel` 통과·`getLogsDigest`가 `{ ok, items }` 반환·`subscribeLogs`가 `{ connected, unsubscribe }` 반환하고 record를 `onLog`로·연결상태를 `onStatus`로 전달·role을 클라가 싣지 않음.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: MODEL_KEYS·httpModel·fakeModel **3곳 동기화**(assertModel 통과)·EventSource는 httpModel 안에만(View/Controller는 transport 비의존, ADR-003)·role 미탑재(서버 도출)·subscribeLogs 반환 shape이 기존 subscribe와 일관(`{ connected, unsubscribe }`)·fakeModel 원본 불변.
3. 결과에 따라 `phases/26-log-viewer/index.json`의 step 3을 갱신(completed+summary / error / blocked). summary에 추가한 두 키·`subscribeLogs(onLog, onStatus)`/`getLogsDigest()` 시그니처·반환 shape을 남긴다.

## 금지사항

- `MODEL_KEYS`에 키를 추가하고 httpModel/fakeModel 중 하나라도 구현을 빠뜨리지 마라. 이유: `assertModel`이 throw해 앱/테스트 전체가 부팅 실패한다.
- `EventSource`/`fetch`를 View·Controller에서 직접 호출하는 코드를 만들지 마라(이 step에서도, 다음 step에서도). 이유: transport는 httpModel 뒤에만(ADR-003).
- 요청에 role/권한 값을 싣지 마라. 이유: role은 서버 세션에서만 도출(ADR-004) — 서버가 Z 게이트를 강제한다.
- subscribeLogs URL에 `?session=` 쿼리 폴백을 붙이지 마라(기존 `subscribe`의 buildQuery 복붙 주의). 이유: 서버는 쿼리 토큰을 읽지 않으며(평문 토큰 URL 누출 표면 제거됨), 인증은 HttpOnly 쿠키(withCredentials)로만.
- `subscribeLogs`에서 클라이언트 측 로그 버퍼 캡/중복제거/자동스크롤을 구현하지 마라. 이유: 그건 Controller(step4) 책임 — model은 transport 배선만. 계층 혼입 금지.
- fakeModel의 seed 원본 배열/객체를 변형(push/mutate)하지 마라. 이유: 읽기 전용 모사 — 테스트 격리.
- `server/`·`src/`(백엔드)·라우팅/페이지/컨트롤러/css를 이 step에서 수정하지 마라. 이유: 이 step은 model 계층만 — 서버는 step2 완료, 페이지는 step4.
- 새 npm 패키지를 추가하지 마라. 이유: zero-dep 확정.
- 기존 테스트를 깨뜨리지 마라(특히 다른 페이지의 `assertModel`/contract 테스트).
