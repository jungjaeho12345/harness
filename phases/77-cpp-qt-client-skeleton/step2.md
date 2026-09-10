# Step 2: rest-client

## 읽어야 할 파일

- `/docs/api-contract/endpoints.json` (39 라우트 — 경로·메서드·인증 클래스·요청/응답 shape의 정본)
- `/docs/api-contract/reason-tokens.md` (사유 토큰→HTTP 상태 21종)
- `/docs/api-contract/README.md` (부수 계약: 허용 헤더 4종 `Content-Type, x-session-id, x-collection-token, x-edit-client` · 본문 직렬화 `{format:'yh-editor',version:1,blocks:[]}` · 업로드 응답 경로 형식)
- `/docs/ADR.md` (ADR-004 신뢰 경계 · ADR-005 SSE 인증=쿠키 · ADR-009 CSRF Origin/Referer)
- `/docs/news-md-overrides.md` (**L126 쿠키 세션 · L131-132·154 x-edit-client · L239 잠금 3종 의미론 · L301 CORS/Origin · L22 로그인 423 잠금 · L80 unauthorized** 필독)
- `web/src/model/httpModel.js` (있으면 — 35 메서드 REST 배선의 정본. 읽기 전용)
- `phases/77-cpp-qt-client-skeleton/step1.md` (IModel 인터페이스 · 계약 타입 · reason 매핑)

## 작업

`client-cpp/net/`에 **`IModel`의 REST 부분(35 메서드)을 Qt Network로 구현한 `HttpModel`**을 만든다. SSE는 step 3에서 별도 구현하되 같은 `HttpModel`이 소유한다.

1. **전송 코어**: `QNetworkAccessManager` 기반. base URL(서버 origin)은 주입받는다(하드코딩 금지 — step 4의 config가 공급). 모든 요청에 `Content-Type: application/json` + 세션 자격증명을 붙인다.
2. **세션 = 쿠키 자(cookie jar) 우선**(L126): 서버가 발급하는 HttpOnly `sid` 쿠키를 `QNetworkCookieJar`로 보관/자동 재전송한다(브라우저 `credentials:'include'` 대응). `x-session-id` 헤더는 **비쿠키 dev/cross-origin 폴백**으로만 지원(기본 경로 아님).
3. **편집 잠금 3종**(L239 · L131-132·154): `lock`/`unlock`/`forceUnlock` 요청에 **`x-edit-client` 헤더로 탭 clientId**를 실어 보낸다. 의미론을 클라이언트 기대에 반영: 같은 탭 재획득(F5) 허용 · 같은 사용자 재로그인 takeover · 같은 세션 다른 탭 차단 · unlock은 멱등(이미 해제도 ok) · force-unlock은 D/Z만(R은 403). 클라이언트는 이 규칙을 **강제하지 않고**(서버가 판정) 응답 사유 토큰을 해석해 UI에 반영만 한다.
4. **에러 shape 매핑**: 응답 `{ok:false, reason:...}`을 step 1의 `ReasonToken`으로 파싱하고 HTTP 상태(401/403/404/400/409/423/500/503)와 함께 호출자에게 전달한다. 특히 로그인 `423 + reason:'locked'`(L22 계정 잠금)와 `401 reason:'locked'`(편집 잠금 충돌)를 구분해 노출한다.
5. **35 메서드**를 `endpoints.json`의 요청/응답 shape에 맞춰 채운다. 본문 직렬화는 `{format:'yh-editor',version:1,blocks:[]}` 계약을 지킨다.
6. **테스트**: 실제 원격 서버 없이 검증한다 — `QNetworkAccessManager`를 향한 요청을 가로채는 로컬 목 HTTP 서버(`QTcpServer`) 또는 주입형 transport로 요청 헤더/바디·응답 파싱·쿠키 왕복·x-edit-client 부착·reason 매핑을 단언한다(TDD: 테스트 먼저).

**핵심 규칙:**
- **base URL·자격증명을 하드코딩하지 마라.** 주입만 받는다(테스트가 로컬 목 서버로 대체).
- **`req.body`에 role을 실어 인가를 요청하지 마라**(ADR-004). 클라이언트가 보낸 role은 서버가 불신한다 — 권한은 세션에서 도출된다.
- **lock/unlock/force-unlock에서 세션 id를 잠금 키로 보내지 마라.** 탭 식별자는 `x-edit-client`다.
- **user delete 요청 메서드를 두지 마라**(그런 라우트 없음).

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
```

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트: net/가 IModel을 구현하는가? base URL 주입인가? 쿠키 자 세션이 1차 수단인가? x-edit-client 부착이 lock 계열에만 붙는가? reason 토큰 매핑이 전수 커버되는가?
3. news-md-overrides L126/L131-132·154/L239/L22/L301 반영 확인.
4. 결과 반영: 성공 → completed + summary(구현 라우트 수/35 · 쿠키 세션 · x-edit-client 계약 · reason 매핑). 실패 3회 → error. 원격 의존이 필요한 항목은 blocked가 아니라 목 서버로 해결하라(외부 인증 키가 필요한 경우만 blocked).

## 금지사항

- base URL/세션 토큰을 소스에 하드코딩하지 마라. 이유: 서버 주소는 config(step 4)가 런타임에 공급하고, 테스트는 로컬 목으로 대체한다.
- `x-session-id` 헤더를 1차 세션 수단으로 쓰지 마라. 이유: 1차는 HttpOnly 쿠키이고 헤더는 dev 폴백이다.
- 잠금 보유자 신원을 session id로 전송하지 마라. 이유: 실제 키는 탭 clientId(`x-edit-client`)다.
- 계약 명세(`docs/api-contract/**`)를 고치지 마라. 이유: 계약은 동결이며 클라가 계약에 맞춘다.
- 기존 테스트를 깨뜨리지 마라.
