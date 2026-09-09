# Step 8: net-sse-client

net 레이어의 **SSE 부분**을 이식한다 — `MODEL_KEYS`의 `subscribe`(무효화 신호 `/api/stream`)·`subscribeLogs`(Z 전용 로그 `/api/logs/stream`)를 step7의 `INewsModel`에 추가하고 배선한다. **행 데이터 없는 무효화 신호 → 클라가 자기 권한으로 재조회** 원칙과 쿠키 인증·`event: unauthorized` 종료 프레임 처리를 지킨다.

## 읽어야 할 파일
- `web/src/model/httpModel.js` 300~340행 부근 (정본 — `subscribe(filter,onChange,onStatus)` · `EventSource(/api/stream, {withCredentials:true})` · 쿠키 전용 인증 · 서버가 push 재인증 실패 시 보내는 종료 이벤트 처리 · `subscribeLogs`)
- `docs/ADR.md` ADR-005(SSE 무효화 신호 · change kind 4종 create/update/status/lock · 행 데이터 없음 · 클라 재조회 · push 시점 비연장 peek · `event: unauthorized` 1회 후 종료 · 쿠키 인증뿐 · `?session=` 제거) · ADR-007(로그 SSE는 실데이터 · Z 전용 · replay 최근 2000 · `seq` 중복 필터)
- `docs/porting-plan-cpp-spring.md` §4-3(SSE 무효화 신호 불변식) · 부록 A 37·39(stream·logs/stream)
- `phases/77-cpp-client-skeleton/index.json` decisions (5) · `client-qt/net/`(step7 — `INewsModel`·`HttpModel`)

## 작업
1. **TDD**: `SseClientTest`를 먼저 쓴다 — SSE 프레임 파서(`data:`·`event:`·종결자 `\n\n`)·change kind 4종 디스패치·`event: unauthorized` 수신 시 재조회 중단+상태 콜백·replay `seq` 중복 필터(logs). 프레임은 **주입된 스트림 소스**(fake)로 먹여 실서버 없이 단언.
2. `client-qt/net/`에:
   - **`SseClient`**(QtNetwork 기반 — `EventSource`가 없으므로 `QNetworkAccessManager`의 스트리밍 `readyRead`로 SSE 프레임을 파싱). 쿠키 자가 `sid` 자동 반송(커스텀 헤더 불가 — 쿠키 인증뿐).
   - `subscribe(filter, onChange, onStatus)` — `/api/stream` · 무효화 신호(kind create/update/status/lock)를 받으면 **행 데이터를 신뢰하지 않고** onChange로 "재조회하라"만 전달(재조회는 화면 controller가 자기 권한으로). 자동 재연결(EventSource 동형 — 끊김 시 재접속).
   - `subscribeLogs(...)` — `/api/logs/stream`(Z 전용) · 실데이터 record replay·`seq` 중복 필터.
   - 서버가 push 재인증 실패 시 보내는 **`event: unauthorized`(종료)** 프레임 수신 → 신호 사용 중단 + onStatus로 세션 무효 통지(화면이 로그인으로 되돌림).
   - `INewsModel`에 `subscribe`·`subscribeLogs`를 추가해 **35 메서드 계약 완결**(step7의 assert가 이제 35/35 green).
3. **행 데이터 push 금지**: SSE 페이로드에서 기사 행을 꺼내 화면에 직접 반영하지 않는다 — 무효화 신호일 뿐 재조회가 진실 공급원이다(권한별 노출 회피).

## Acceptance Criteria
```
cmake --build client-qt/build
QT_QPA_PLATFORM=offscreen ctest --test-dir client-qt/build --output-on-failure   # SseClientTest green · assertModel 35/35
cd /home/user/harness && git diff --stat    # client-qt/net·tests 만 바뀐다
```
- `SseClientTest`가 `event: unauthorized` 프레임 수신 시 재조회를 멈추고 상태 콜백을 부르는 것을 단언한다.
- `INewsModel`이 이제 `MODEL_KEYS` **35 전부**를 선언하고, 누락 assert가 35/35 green이다.
- change kind 4종(create/update/status/lock) 디스패치와 종결자 `\n\n` 프레임 파싱 테스트가 있다.

## 검증 절차
1. SSE 파서가 멀티라인 프레임·주석 라인·종결자를 웹 EventSource와 동형으로 처리하는지 확인.
2. 무효화 신호 payload에 행 데이터가 실려 와도 화면에 직접 쓰지 않고 재조회 트리거만 하는지 확인(ADR-005).
3. 인증이 쿠키뿐이고 URL/헤더에 세션 토큰이 없는지 확인(ADR-005/007).

## 금지사항
- SSE URL/쿼리에 세션 토큰을 싣지 마라. 이유: 평문 토큰이 프록시·액세스 로그·히스토리에 누출된다 — 인증은 쿠키뿐이다(ADR-005/007).
- 무효화 신호의 행 데이터를 화면에 직접 반영하지 마라. 이유: 서버가 권한별로 필터하지 않는 naive broadcast라, 재조회(자기 권한)만이 안전하다(ADR-005).
- SSE에 주기 재검증 타이머를 두지 마라. 이유: push 시점 재검증은 서버 몫이고 클라는 타이머 0이다(ADR-008) — 클라는 서버가 보내는 unauthorized 프레임에 반응만 한다.
