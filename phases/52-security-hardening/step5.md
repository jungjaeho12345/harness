# Step 5: sse-terminal-close

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `docs/ADR.md` — ADR-003(주입형 Model 계약: transport는 `httpModel` 뒤에만), ADR-005(SSE 무효화 스트림·EventSource 자동 재연결), ADR-007(로그 SSE는 Z 전용)
- `docs/ARCHITECTURE.md` — 프론트엔드 MVC(View ← Controller ← Model)
- `web/src/model/httpModel.js` — `subscribe(filter, onChange, onStatus)`와 `subscribeLogs(onLog, onStatus)`(둘 다 `new EventSource(url, { withCredentials: true })`, `ready`/`change`|`log`/`error` 리스너, 반환 `{ connected, unsubscribe }`)
- `web/src/model/contract.js` — `MODEL_KEYS`(계약 키 목록 — 이 step에서 바꾸지 않는다)
- `web/src/model/httpModel.test.js` — `installFakeEventSource(instances)` 헬퍼(`FakeEventSource`는 `closed` 플래그와 `emit(type, data)`를 제공한다)
- `web/src/controller/useLogsController.js`, `web/src/controller/useViewController.js` — `onStatus`로 연결 상태를 받는 소비처(이 step에서 수정하지 않는다)
- `phases/52-security-hardening/step3.md` — 서버가 보내는 종료 이벤트 계약

## 배경 (이 step 안에서 자기완결)

step 3에서 서버 SSE(`/api/stream`, `/api/logs/stream`)는 push 시점에 세션을 재검증하고, 실패하면 아래 이벤트를 1회 보낸 뒤 연결을 끝낸다:

```
event: unauthorized
data: {"ok":false,"reason":"unauthenticated"}
```

표준 `EventSource`는 연결이 끊기면 **자동으로 재연결**한다(ADR-005가 채택 이유로 든 특성). 세션이 이미 죽은 상태에서는 재연결이 매번 401로 실패하고 수 초 간격으로 무한 재시도가 돌며, 그 요청 하나하나가 서버 요청 로그(in-memory 링 버퍼)를 채운다. 즉 step 3의 보안 수정이 그대로 두면 **운영 잡음 회귀**를 만든다.

이 step은 그것을 막는다: 클라이언트가 `unauthorized` 이벤트를 받으면 **EventSource를 닫고 연결 끊김 상태로 보고**한다. transport 변경은 `httpModel` 안에서만 한다(ADR-003).

## 작업

### 1) 착수 전 실측

```bash
npm run test:web    # 87 files / 2006 tests pass 가 phase 시작 기준선
npm run lint
npm run build
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`web/src/model/httpModel.test.js`의 SSE 블록(`installFakeEventSource`를 쓰는 테스트들)에 케이스를 추가한다.

보안/종료 시나리오:

1. `subscribe(...)` 후 fake EventSource가 `unauthorized`를 emit하면 → 그 인스턴스의 `closed === true`이고, `onStatus`가 `false`로 호출되며, 반환 객체의 `connected()`가 `false`다.
2. `subscribeLogs(...)`도 동일하게 동작한다.
3. `unauthorized` 이후에 (fake가) `change`/`log`를 emit해도 `onChange`/`onLog` 콜백이 더 이상 새 데이터를 흘리지 않는다(닫힌 뒤 push는 없어야 한다 — 실제 EventSource는 close 후 이벤트를 주지 않으므로, 테스트는 "닫혔다"는 사실 + 구독 해제 상태를 단언하는 방식으로 작성해도 된다).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

4. `ready` → `connected() === true`, `change`/`log` 정상 전달, `unsubscribe()`가 `close()`를 호출하는 기존 동작이 그대로다.
5. `error` 이벤트만 왔을 때는 **닫지 않는다**(EventSource의 자동 재연결을 유지한다 — 일시적 네트워크 단절은 재연결로 회복돼야 한다).
6. `subscribe`/`subscribeLogs`의 URL·`withCredentials: true`·`?session=` 쿼리 미첨부(phase 51 step4가 잠근 계약)가 그대로다.
7. `MODEL_KEYS` 계약·시그니처·반환 shape(`{ connected, unsubscribe }`)이 불변이다(`web/src/model/contract.test.js` green).

### 3) 구현 — `web/src/model/httpModel.js`만 수정

`subscribe`와 `subscribeLogs` 각각에 리스너 한 개씩 추가한다:

```js
source.addEventListener('unauthorized', () => { setStatus(false); source.close(); });
```

- 두 함수의 시그니처·반환 shape·기존 이벤트 처리(`ready`/`change`/`log`/`error`)는 그대로 둔다.
- 이벤트 이름 `unauthorized`는 서버(step 3)와의 계약이다 — 다른 이름을 쓰거나 `data` 파싱 결과에 따라 분기하지 마라(payload는 고정 토큰이며 파싱 실패 시에도 닫아야 한다).
- 왜 닫는지(무한 재연결·로그 잡음 방지)와 `error`는 닫지 않는다는 구분을 주석으로 남겨라.
- `web/src/test/fakeModel.js`는 수정하지 않는다(가짜 모델은 EventSource를 쓰지 않는다).

## Acceptance Criteria

```bash
npm run test:web    # 2006 + 신규 케이스, fail 0
npm run lint        # clean
npm run build       # 번들 빌드 성공
npm test            # 백엔드 무접촉 확인 — 그대로 green
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증: `unauthorized` 리스너를 제거하면 시나리오 1·2가 red가 되는지 확인하고 원복한다.
3. 아키텍처 체크리스트:
   - 수정 범위가 `web/src/model/httpModel.js` + 그 테스트뿐인가? (View/Controller/`contract.js`/`fakeModel.js`/`server/`/`src/` 변경 0건)
   - ADR-003: `EventSource`/`fetch` 같은 transport가 `httpModel` 밖으로 새지 않았는가?
4. 결과에 따라 `phases/52-security-hardening/index.json`의 step 5를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "종료 이벤트 소비 방식·테스트 증감·계약 불변 확인 요약"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- `error` 이벤트에서 `close()`하지 마라. 이유: 일시적 네트워크 단절까지 영구 종료돼 실시간 목록·로그 뷰어가 새로고침 전까지 죽는다(ADR-005가 EventSource를 택한 이유인 자동 재연결을 없애는 것).
- 자체 재연결 타이머(`setTimeout`/`setInterval` 백오프)를 구현하지 마라. 이유: 표준 EventSource 재연결과 중복되고, ADR-008의 타이머 규율과도 어긋난다.
- 로그인 페이지 리다이렉트·세션 만료 배너·자동 재로그인 같은 UX 로직을 `httpModel`에 넣지 마라. 이유: Model은 transport 배선만 담당한다(ADR-003) — 화면 전환은 Controller/View 책임이며 별도 phase 범위다.
- `MODEL_KEYS`(계약 키)나 `subscribe`/`subscribeLogs`의 시그니처·반환 shape을 바꾸지 마라. 이유: 계약 변경은 `contract.test.js`·`fakeModel`·모든 소비처를 동시에 흔든다.
- `?session=` 등 URL에 세션 토큰을 다시 붙이지 마라. 이유: phase 51 step4가 제거한 평문 토큰 노출 표면이다.
- 서버 코드(`server/index.js`)를 이 step에서 수정하지 마라. 이유: 서버 측 종료 계약은 step 3에서 확정됐다.
- 기존 테스트를 깨뜨리지 마라.
