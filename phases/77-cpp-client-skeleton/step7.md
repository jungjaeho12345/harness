# Step 7: net-rest-client

net 레이어의 **REST 부분**을 이식한다 — `MODEL_KEYS` 35 중 **REST 33 메서드**를 주입형 Model 인터페이스(ADR-003)로 정의하고, `QNetworkAccessManager` 배선 구현 + 서버 없는 화면 개발용 fake 구현을 만든다. 쿠키 세션·헤더 4종·동일 출처 상대 경로 계약을 지킨다. (SSE 2메서드 `subscribe`·`subscribeLogs`는 step8.)

## 읽어야 할 파일
- `web/src/model/contract.js` (정본 — `MODEL_KEYS` 35 · `assertModel` — 모든 키가 구현됐는지 검증하는 패턴)
- `web/src/model/httpModel.js` (정본 배선 — REST base 기본값 빈 문자열(동일 출처 `/api/...`) · `x-session-id` 헤더 · 쿠키 `withCredentials` · 응답 shape·에러 shape `{ok:false,reason}` · 각 메서드 → 라우트 매핑)
- `docs/porting-plan-cpp-spring.md` 부록 A(39 라우트 계약표 — 인증 등급·용도) · §6.2(net 계층 35 계약 메서드 · fakeModel 357줄 패턴)
- `docs/ADR.md` ADR-003(주입형 Model 계약 · fakeModel 주입) · ADR-004(세션·`x-session-id` · 클라 role 불신) · 부수 계약(허용 헤더 4종 · 사유 토큰→상태 매핑 21종 · 업로드 응답 경로 · 본문 직렬화 `{format:'yh-editor',version:1,blocks:[]}`)
- `phases/77-cpp-client-skeleton/index.json` decisions (4)(5) · `client-qt/net/`(step3 골격)

## 작업
1. **TDD**: `HttpModelTest`를 먼저 쓴다 — 각 메서드가 올바른 METHOD·경로·헤더·body로 요청을 만들고 응답/에러 shape를 파싱하는지. 네트워크는 **주입된 transport**(fake HTTP) 뒤로 두어 실서버 없이 단언한다(테스트는 리포 news.db·서버에 절대 바인딩하지 않는다).
2. `client-qt/net/`에:
   - **주입형 인터페이스** `INewsModel`(순수 가상) — `MODEL_KEYS` 33 REST 메서드를 시그니처로 선언(login, logout, restoreSession, queryUsers, createUser, updateUser, queryArticles, getArticle, searchArticles, searchMedia, publishPhoto, searchPhotos, applyAction, saveArticle, lockArticle, unlockArticle, forceUnlockArticle, queryReceiverConfig, createReceiverConfig, deleteReceiverConfig, queryDistributionTargets, createDistributionTarget, updateDistributionTarget, deactivateDistributionTarget, queryDistributionFailures, retryDistribution, runDistributionTick, queryHistory, deriveArticle, translate, uploadFile, getHistorySnapshot, getLogsDigest). SSE 2메서드는 step8이 같은 인터페이스에 추가한다.
   - **`HttpModel`**(배선 구현) — `QNetworkAccessManager` · base는 동일 출처 상대(`/api/...`) · 쿠키 자가 `sid` 자동 반송 · 허용 헤더 4종(`Content-Type, x-session-id, x-collection-token, x-edit-client`)만 · 응답 `{ok,...}`/에러 `{ok:false,reason}` 파싱(QJson).
   - **`FakeModel`**(서버 없는 화면 개발용 — `web/src/model/fakeModel` 패턴) — 결정적 in-memory 응답. 화면 step9/step10이 이걸 주입해 서버 없이 테스트한다.
   - **`assertModel` 상당** — 33(step8 후 35) 키가 전부 구현됐는지 컴파일/런타임 검증(누락 키를 알려준다).
3. **계약 동결 준수**: 경로·shape·헤더를 늘리거나 줄이지 않는다 — `httpModel.js`와 1:1. 본문(article body)은 net이 **불투명 blob**으로 나른다(P4는 에디터가 없으므로 파싱하지 않는다).

## Acceptance Criteria
```
cmake --build client-qt/build
QT_QPA_PLATFORM=offscreen ctest --test-dir client-qt/build --output-on-failure   # HttpModelTest green
cd /home/user/harness && git diff --stat    # client-qt/net·tests 만 바뀐다
```
- `INewsModel`이 `MODEL_KEYS`의 REST 33 메서드를 전부 선언하고, 누락 키를 잡는 assert 테스트가 있다.
- `HttpModelTest`가 대표 메서드(login POST /api/login · queryArticles GET /api/articles · applyAction POST /api/articles/:id/action · uploadFile POST /api/upload)의 METHOD·경로·헤더·에러 shape를 fake transport로 단언한다.

## 검증 절차
1. `MODEL_KEYS` 35 중 REST 33이 인터페이스에 다 있는지 대조(SSE 2는 step8 몫으로 표시).
2. 요청 헤더가 허용 4종 밖을 쓰지 않는지 확인(계약 동결).
3. 테스트가 실서버/실 news.db에 붙지 않고 주입 transport로만 도는지 확인.

## 금지사항
- 계약 shape·경로·헤더를 임의로 바꾸거나 늘리지 마라. 이유: 서버 계약은 동결(§2)이다 — 클라가 계약을 흔들면 패리티 전제가 깨진다(excluded (d)).
- `req.body`에 role·시각·대상 같은 권한 값을 넣어 서버 판단을 대신하려 하지 마라. 이유: 신뢰 경계는 서버다 — 서버가 세션에서 role을 재도출한다(ADR-004).
- 본문(article body)을 파싱/렌더하는 로직을 넣지 마라. 이유: 에디터는 P5다 — P4 net은 본문을 불투명 blob으로만 나른다.
- SSE(`subscribe`·`subscribeLogs`)를 여기서 구현하지 마라. 이유: SSE는 쿠키 인증·unauthorized 프레임·재조회 규율이 달라 step8로 분리한다(원칙 1).
