# Step 11: sse-logs

**SSE 2 스트림과 로그 다이제스트 3 라우트**를 동결한다: `GET /api/stream`(#37) · `GET /api/logs/digest`(#38) · `GET /api/logs/stream`(#39). 계약 축은 **미인증은 스트림을 열기 전에 JSON으로 끝난다**, **프레임 바이트 문법**, **`change`는 행 데이터 없는 무효화 신호**, **로그 2 라우트는 Z 전용**이다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(9)(10)(11)(16)(18)** · excluded (i)
- `phases/67-port-p1-contract/step2.md` "작업 A" — `sse.openStream`/`waitFor` 시그니처와 사용 규율
- `docs/api-contract/sse.md`(step0 산출물) — 이 step이 실측으로 확인·보강할 대상
- `server/index.js` — `/api/stream`(1127~1159행: 401 JSON → 헤더 3종 → `ready` → push 시점 `peek` 재검증), `/api/logs/digest`(1168~1175행), `/api/logs/stream`(1180~1217행: Z 게이트 → `ready` → replay 2000 → live), `UNAUTHORIZED_FRAME`(423행), `app.notifyChange` 호출 지점 전수(create/update/status/lock)
- `src/services/logService.js` — 링 버퍼·`digest()`·`snapshot()`·record 필드(`seq,ts,level,message,line`)
- `docs/ADR.md` ADR-005(무효화 신호)·ADR-007(로그 SSE 예외·Z 전용·비연장 peek)
- `docs/LOGS.md` — 마스킹 규율(로그 라인을 리포트에 담지 않는 근거)
- `spikes/p0-spring/CONTRACT.md` "SSE 정확 프레임" 절 — 바이트 계약의 본보기(수정 금지)
- `test/sse-auth.test.js` · `test/sse-reauth.test.js` · `test/logs-api.test.js` — 예측 수립용

## 배경

- 인증 실패는 **스트림을 열기 전에** `res.status(401).json(...)`이다(SSE 헤더가 나가지 않는다). 로그 스트림의 비-Z는 403이다. 이 "열기 전 종료"가 계약이며, 열고 나서 오류 프레임을 보내는 구현은 위반이다.
- 프레임 문법: `event: <name>\ndata: <json>\n\n`. **종결자인 빈 줄이 빠지면 브라우저가 디스패치하지 않는다** — 바이트 단위로 확인해야 하는 이유다.
- `/api/stream`의 `change` payload는 `{"kind":"create|update|status|lock"}`뿐이다(행 데이터 없음).
- `/api/logs/stream`은 접속 즉시 최근 2000건을 `event: log`로 replay하고 실시간을 잇는다. 요청 로거가 매 요청마다 INFO를 남기므로 **스위트 자신의 요청도 로그로 흘러들어온다**(리포트·요약에 로그 라인을 담지 마라).
- 세션이 죽으면 `event: unauthorized` 1회 후 연결이 끝난다(push 시점 비연장 재검증). 이 종료 계약은 **다음 이벤트가 있어야** 관측된다.

## 작업

### A. `contract/cases/default/sse-stream.contract.js`

1. **미인증**: 세션 없이 `GET /api/stream` → **401** · `content-type`이 JSON · 본문 `{ok:false, reason:'unauthenticated'}` · 응답이 `text/event-stream`이 **아님**을 단언.
2. **연결·ready**: R 세션(헤더)으로 열기 → 200 · `content-type: text/event-stream` · `cache-control: no-cache` · **첫 프레임이 `event: ready` + `data: {"ok":true}`** · 프레임이 빈 줄로 종결됨(원문 바이트 확인 — 파서를 거친 결과만 보지 말고 raw 문자열에 `\n\n`이 있는지 1건 단언).
3. **쿠키 인증**: 헤더 대신 `Cookie: sid=<...>`로 열어도 동일하게 열리는지(EventSource는 커스텀 헤더를 못 보내므로 쿠키 경로가 실사용 경로다).
4. **change 신호 4종**: `ready` 수신 후 트리거를 쏘고 `waitFor(frame => frame.event==='change' && json.kind===X)`로 기다린다(다른 kind가 섞여 와도 통과 — 타임아웃 있는 조건 대기).
   - `create`: `POST /api/articles` · `update`: 잠금 보유 후 `PUT` · `status`: `POST .../action` · `lock`: `POST .../lock`.
   - 각 프레임의 **data 키 집합이 정확히 `['kind']`인지** 단언한다(행 데이터가 실리지 않는다는 계약의 핵심).
5. **동시 연결 2개**: 같은 세션으로 스트림 2개를 열고 트리거 1회로 **둘 다** 신호를 받는지 확인(SPA가 실제로 2개를 연다 — P0 CONTRACT.md 3항).
6. **세션 무효화 종료**: **프로파일 공용 세션(`actor()`/`sid()`)은 절대 파괴하지 않는다.** 이 케이스는 `credentials('R')`로 **자기 전용 세션을 1회 로그인해 만들고**, 그 세션으로 스트림을 연 뒤 → 그 전용 세션을 `POST /api/logout`으로 죽이고 → 아무 트리거나 1회(공용 세션으로) 발생시켜 → `event: unauthorized` 프레임을 받고 스트림이 끝나는지 확인한다.
   - **`default` 프로파일 로그인 예산 회계**: 러너 3 + step3(A-3) 1 + **여기 1** = **5회 ≤ 10회/15분**(`server/index.js` 609~614행 `loginLimiter`). 이 케이스에서 2회 이상 로그인하지 마라.
   - 로그인·로그아웃 자체의 계약은 step3이 이미 동결했다 — 여기서는 **SSE 종료 프레임**만 관측한다(같은 계약을 두 번 단언하지 마라).

### B. `contract/cases/default/logs.contract.js`

1. **인가**: `GET /api/logs/digest` — 미인증 401 · **R 세션 403** · **D 세션 403** · Z 세션 200. `GET /api/logs/stream` — 미인증 401 · 비-Z **403(스트림 열기 전)** · Z 200.
2. **digest shape**: Z 200 · `{ok:true, items:[...]}` · items 원소 키 집합 실측(`seq,ts,level,message,line` 등). **로그 내용은 리포트·요약에 담지 않는다**(키 이름만).
3. **stream ready·replay**: Z로 열기 → `event: ready` 후 `event: log` 프레임이 온다(replay). 프레임 data가 JSON으로 파싱되고 키 집합이 2와 동형인지 확인.
4. **live push**: 스트림을 연 채 아무 요청(예: `GET /api/health`)을 1회 보내고 새 `log` 프레임이 도착하는지 `waitFor`로 확인(요청 로거가 매 요청 INFO를 남긴다).
5. **비-Z 종료 계약**: 1의 403이 **스트림 헤더 없이** 끝났는지(`content-type`이 JSON) 단언.

### C. 명세 반영 `docs/api-contract/openapi.yaml` + `docs/api-contract/sse.md`

- openapi.yaml: 3 라우트 paths 추가. SSE 2건은 `responses.200.content['text/event-stream']`으로 두고, 프레임 문법은 `x-sse` 확장 + `docs/api-contract/sse.md` 링크로 서술한다(OpenAPI가 스트림 프레임을 표현하지 못하는 한계를 description에 명시).
- sse.md: step0에서 코드로 적은 내용을 **실측으로 교정·보강**한다(헤더 실측값, ready/change/log/unauthorized 프레임 원문, replay 상한, 어느 라우트가 어떤 kind를 쏘는지 표, 인증 실패 시 열기 전 종료).

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/sse-stream.contract.js,contract/cases/default/logs.contract.js
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. 예측 먼저: 3 라우트의 인증 실패 상태·헤더·프레임 원문을 코드에서 읽어 적고 실측과 대조한다.
2. **flake 사냥**: 이 step의 파일만 **연속 3회** 실행해 3회 모두 green인지 확인한다(SSE는 이 phase에서 flake 위험이 가장 큰 축이다). 1회라도 실패하면 원인을 고정 sleep이 아니라 **조건 대기·ready 선행**으로 고친다. 3회 실행 결과를 요약에 기록한다.
3. **연결 정리 확인**: 케이스가 끝난 뒤 열린 스트림이 남지 않는지 확인한다(러너가 서버를 종료할 때 지연되거나 멈추면 누수다). 프로파일 전체 실행 시간을 요약에 남긴다.
4. **vacuity 변이 2종**(각각 원복): (a) A-4의 data 키 집합 단언을 `['kind','articleId']`로 바꿔 red 확인 (b) B-1의 R 세션 기대를 200으로 바꿔 red 확인.
5. **누출 검사**: 리포트에 로그 라인 문자열이 단 한 줄도 없는지 확인한다(로그에는 경로·사용자 id가 들어간다 — LOGS.md 마스킹 규율).
6. AC 전부 실행.
7. `git status --porcelain` 증분 = 케이스 2파일 · `docs/api-contract/openapi.yaml` · `docs/api-contract/sse.md` · `phases/67-port-p1-contract/index.json`.
8. 아키텍처 체크: 서버 코드 무수정 · `npm test` 1327 유지.
9. index.json step11 status·summary 갱신(3회 실행 결과·A-6의 전용 세션 1회 로그인 회계(러너 3 + step3 1 + 여기 1 = 5) 포함).

## 금지사항

- 고정 `sleep`으로 프레임 도착을 기다리지 마라. 이유: 느린 머신에서 flake, 빠른 머신에서 낭비다 — `ready` 선행 + 조건 대기 + 타임아웃만 쓴다.
- 프레임 **개수**나 **순서**(다른 kind가 섞이지 않는다)를 단언하지 마라. 이유: 같은 프로파일의 다른 케이스와 서버 자신의 활동이 신호를 섞는다 — "유한 시간 안에 조건을 만족하는 프레임이 온다"만 단언한다.
- 로그 스트림에서 특정 로그 **내용**(경로·userId·메시지 문자열)을 단언하지 마라. 이유: 스위트 자신의 요청이 로그에 섞여 비결정적이고, 그 값을 리포트에 담으면 마스킹 규율 위반이다 — 키 집합·프레임 문법만 본다.
- `EventSource`(전역/폴리필)를 쓰지 마라. 이유: 헤더 인증이 불가능하고 Node 버전에 따라 존재 여부가 갈린다 — fetch 스트림 파서를 쓴다(step2의 lib).
- 스트림을 닫지 않은 채 케이스를 끝내지 마라. 이유: 서버 종료가 지연되고 다음 프로파일 기동이 밀린다(러너 타임아웃의 흔한 원인).
- **프로파일 공용 세션(`CONTRACT_SESSIONS`의 R/D/Z)을 파괴하지 마라 — 어떤 파일·어떤 위치에서도 금지다.** 이유: 그 세션은 프로파일 전체가 공유하는 자원이고, 죽는 순간 같은 프로파일의 **모든 후속 케이스가 401로 무너진다**(원인이 다른 파일에 있어 진단이 가장 어려운 실패다). 로그아웃·세션 만료를 관측해야 하면 `credentials(role)`로 **자기 전용 세션을 1회 만들어** 그것만 파괴한다(예산 회계는 A-6 참조).
