# Step 4: web-model-log — Model 계약 확장(로그 SSE 구독 + 다이제스트 조회) + httpModel/fakeModel 배선

## 배경 / 요구사항

프론트 로그 뷰어(step5)가 쓸 **Model 계약**을 먼저 확장한다. 프론트 MVC(ADR-003)에서 실시간/네트워크 배선은 반드시 `httpModel`(EventSource/fetch) 뒤에 격리하고, View/Controller는 계약(`MODEL_KEYS`)만 본다. 테스트는 `fakeModel`을 주입한다. 이 step은 **Model 레이어만** 다룬다(Controller/View는 step5).

추가할 계약 메서드 2개:
- `subscribeLogs(onLine, onStatus)` — 서버 `GET /api/logs/stream`(step1) SSE를 구독해 새 로그 엔트리를 `onLine(entry)`로 흘리고, 연결 상태를 `onStatus(bool)`로 알린다. `{ connected, unsubscribe }`를 반환(기존 `subscribe`와 동형).
- `queryLogDigest(date)` — 서버 `GET /api/logs/digest?date=`(step2)를 조회해 `{ ok, digest }`를 반환(읽기 전용 pull).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC(Model/View/Controller), Model 계약 seam, 명령어(`npm run test:web`/`build`/`lint`).
- `/docs/ADR.md` — ADR-003(주입형 Model 계약·`MODEL_KEYS`·httpModel/fakeModel·백엔드 shape 수동 동기화), ADR-005(EventSource·자동 재연결·`withCredentials`).
- `/home/user/harness/web/src/model/contract.js` — **결선 지점**: `MODEL_KEYS` 배열(L5~33)에 `subscribeLogs`·`queryLogDigest`를 추가한다. `assertModel`이 모든 키가 함수인지 런타임 검증한다.
- `/home/user/harness/web/src/model/httpModel.js` — **결선 지점**: L245~265 `subscribe(filter, onChange, onStatus)`(EventSource·`event: ready`/`change`·`error`·`withCredentials`·`onStatus`·`connected`/`unsubscribe`). **이 패턴을 복제**해 `subscribeLogs`를 만든다(`event: log`, `/api/logs/stream`). `request(path, {query})` 헬퍼(L80~96)로 `queryLogDigest`를 만든다. `readSessionId`/base/`buildQuery` 컨벤션.
- `/home/user/harness/web/src/model/httpModel.test.js` — httpModel 단위 테스트 컨벤션(EventSource/fetch 모킹).
- `/home/user/harness/web/src/model/contract.test.js` — 계약 테스트 컨벤션(`assertModel`·키 존재).
- `/home/user/harness/web/src/test/fakeModel.js` — **결선 지점**: L213~221 `subscribe(filter, onChange, onStatus)`(in-memory listeners·`onStatus?.(true)`·`connected`/`unsubscribe`). 같은 방식으로 `subscribeLogs`·`queryLogDigest`를 in-memory 모사로 추가한다.
- step1 라우트(`GET /api/logs/stream`, `event: log`, 엔트리 `{ ts, level, message, line }`)와 step2 라우트(`GET /api/logs/digest?date=`, `{ ok, digest }`) — **응답 shape을 1:1로 맞춘다**(ADR-003 수동 동기화).

## 작업

TDD로 진행한다(`vitest`, `npm run test:web`). **먼저 contract/httpModel/fakeModel 테스트를 작성/갱신**하고 통과 구현을 만든다. Model 레이어만.

### 1. 계약 — `web/src/model/contract.js`

- `MODEL_KEYS`에 `'subscribeLogs'`, `'queryLogDigest'`를 추가한다(배열 끝, 주석으로 phase26 로그 뷰어 표기). 이유: `assertModel`이 두 키를 함수로 요구하게 해 httpModel/fakeModel 동기화를 강제.

### 2. httpModel — `web/src/model/httpModel.js`

- `queryLogDigest(date)`:
  ```js
  queryLogDigest(date) {
    return request('/api/logs/digest', { query: date ? { date } : {} });
  }
  ```
  - 응답 `{ ok, digest }`를 그대로 반환(읽기 전용).
- `subscribeLogs(onLine, onStatus)` — 기존 `subscribe`(L245~265) 복제, 채널만 다르게:
  - `const url = \`${base}/api/logs/stream\`;`(로그 스트림). **평문 `?session=` 쿼리를 붙이지 마라** — server가 쿠키/헤더만 인증한다(step1). `new EventSource(url, { withCredentials: true })`.
  - `event: ready` → `onStatus(true)`, `event: error` → `onStatus(false)`.
  - `event: log` → `event.data`를 JSON 파싱(실패 시 스킵/무시)해 엔트리 `{ ts, level, message, line }`를 `onLine(entry)`로 넘긴다.
  - `{ connected: () => connected, unsubscribe: () => source.close() }` 반환(기존 동형).

### 3. fakeModel — `web/src/test/fakeModel.js`

- 로그용 in-memory 리스너 집합/시드(예: `seed.logs`)를 둔다.
- `subscribeLogs(onLine, onStatus)` — listeners에 핸들러 등록, `onStatus?.(true)`, 시드 백로그를 즉시 `onLine`으로 흘려도 됨(재량). `{ connected: () => true, unsubscribe }` 반환. (선택) `logLine(entry)` 헬퍼로 테스트가 신규 라인을 밀어넣게 한다.
- `queryLogDigest(date)` — 시드 로그(또는 시드 digest)에서 `{ ok: true, digest }`를 모사 반환(httpModel과 같은 shape). date 파싱 실패 모사가 필요하면 `{ ok:false, reason:'invalid-date' }`.
- **비밀번호·민감정보를 어떤 응답에도 넣지 않는다**(기존 fakeModel 원칙 유지).

### 4. 테스트 (먼저 작성)

- `contract.test.js`: `MODEL_KEYS`가 `subscribeLogs`/`queryLogDigest`를 포함하고, fakeModel이 `assertModel`을 통과한다.
- `httpModel.test.js`:
  - `queryLogDigest(date)`가 `/api/logs/digest?date=...`로 GET하고 `{ ok, digest }`를 돌려준다(fetch 모킹).
  - `subscribeLogs`가 `/api/logs/stream`에 `withCredentials`로 EventSource를 열고, `log` 이벤트의 JSON을 파싱해 `onLine(entry)`로 전달하며, `ready`/`error`가 `onStatus`를 토글한다(EventSource 모킹). `unsubscribe`가 `close()`한다. **URL에 `?session=` 평문 토큰이 없음**을 단언.
- `fakeModel` 사용 테스트: `subscribeLogs`/`queryLogDigest`가 계약대로 동작(구독→라인 수신→해제, digest shape).

## Acceptance Criteria

```bash
npm run build && npm run lint && npm run test:web
```

기대 단언(요약):
- `MODEL_KEYS`에 두 키가 있고 httpModel/fakeModel이 계약을 만족한다(`assertModel` 통과).
- `subscribeLogs`가 `/api/logs/stream`을 `withCredentials`로 구독하고 `log` 이벤트를 파싱해 라인을 전달한다(평문 `?session=` 없음).
- `queryLogDigest`가 `/api/logs/digest`를 조회해 `{ ok, digest }`를 반환한다.
- 기존 Model/httpModel/fakeModel 계약 테스트가 회귀 없이 통과한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: transport(EventSource/fetch)는 httpModel에만·View/Controller 미접촉·shape이 서버(step1/step2)와 1:1·`?session=` 평문 폴백 없음·fakeModel에 민감정보 없음·`MODEL_KEYS`/httpModel/fakeModel 3곳 동기화.
3. 결과에 따라 `phases/26-realtime-log-viewer/index.json`의 step 4를 갱신(completed+summary / error / blocked).

## 금지사항

- `subscribeLogs` URL에 `?session=`(또는 어떤 세션 토큰도) 평문으로 붙이지 마라. 이유: URL/프록시 로그 누출 표면 — server(step1)는 쿠키/헤더만 인증한다.
- 로그 SSE를 기존 `subscribe`(무효화 채널)에 얹지 마라. 이유: 채널 분리(step1 결정) — `/api/logs/stream`을 별도 구독한다.
- `MODEL_KEYS`만 추가하고 httpModel/fakeModel 중 하나를 빠뜨리지 마라. 이유: `assertModel`이 앱 부팅/테스트에서 throw한다(계약 3곳 동기화 필수).
- Controller 훅·View 컴포넌트·라우팅을 이 step에서 만들지 마라. 이유: step5 책임 — 이 step은 Model 레이어만(범위 최소화).
- fakeModel 응답에 비밀번호/시크릿을 넣지 마라. 이유: 기존 fakeModel 불변(어떤 응답에도 민감정보 없음).
- `queryLogDigest`가 오류를 throw하게 두지 마라(서버가 준 `{ ok:false, reason }`를 그대로 반환). 이유: graceful — 조회 실패가 UI를 깨면 안 된다.
