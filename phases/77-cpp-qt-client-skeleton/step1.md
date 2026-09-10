# Step 1: contract-types

## 읽어야 할 파일

- `/docs/porting-plan-cpp-spring.md` (§6.2 "`model/contract.js`의 35 메서드 계약과 `fakeModel`(357줄) 패턴을 C++ 인터페이스 + 목 구현으로 이식" · §4 불변식 5 "응답 투영 단일 지점")
- `/docs/ADR.md` (ADR-003 주입 가능한 Model 계약 · ADR-004 신뢰 경계=서버)
- `/docs/api-contract/endpoints.json` (39 라우트 — 요청/응답 shape의 정본)
- `/docs/api-contract/reason-tokens.md` (사유 토큰 21종 → HTTP 상태 매핑)
- `/docs/SCHEMA.md` (`## Contents Table` 절 — Contents 필드 15종 + 잠금 컬럼 4종 + 공통정보 8종. ContentsVO 명세 대체본)
- `/docs/news-md-overrides.md` (**L131 · L131-132·154 · L21 · L302 필독** — 아래 규칙의 근거)
- `web/src/model/contract.js` (있으면 — `MODEL_KEYS` 35 메서드의 정본. 읽기 전용)
- `phases/77-cpp-qt-client-skeleton/step0.md` (생성된 CMake 타깃 `newsclient_core`)

## 작업

`client-cpp/core/`에 **전송 계층에 독립적인 계약 타입 + Model 인터페이스 + 목 구현**을 만든다. 실제 네트워크 배선은 없다(step 2~3이 구현). 이 step은 ADR-003의 seam을 C++로 옮긴다.

1. **도메인 값 타입(`core/contracttypes.h`)**: 서버 응답 shape을 담는 구조체 — `Article`, `Contents`, `User`, `SessionInfo`, `HistoryEntry`, `DistributionTarget`, `ReceiverConfig` 등. `docs/SCHEMA.md`와 `endpoints.json` 응답 필드에 1:1로 맞춘다.
2. **사유 토큰 열거(`core/reasontoken.h`)**: `docs/api-contract/reason-tokens.md`의 21종을 `enum class ReasonToken`으로. 토큰 문자열 ↔ enum 변환 순수 함수 + 토큰→HTTP 상태 매핑 순수 함수.
3. **상태값 열거**: 기사 status 11종을 `enum class ArticleStatus`로 + 문자열 변환.
4. **Model 인터페이스(`core/imodel.h`)**: `web/src/model/contract.js`의 **35 메서드**를 순수 가상 함수를 가진 추상 클래스 `IModel`로 정의한다(비동기는 콜백/`std::function` 또는 Qt 시그널 반환 핸들 — step 2에서 확정하되 인터페이스 형태만 여기서 고정). 각 메서드는 계약의 요청 인자와 응답 타입을 시그니처로 표현한다.
5. **목 구현(`core/fakemodel.h/.cpp`)**: `fakeModel`(357줄) 패턴 이식 — 인메모리 픽스처로 `IModel`을 구현해 서버 없이 UI를 개발/테스트할 수 있게 한다. 로그인/목록/무효화 신호 시뮬레이션을 포함한다.

**반드시 박아넣을 핵심 규칙(위반 = high 결함):**
- **`lockerSessionId`·`lockerClientId` 필드를 어떤 응답 타입에도 두지 마라.** 이유(`news-md-overrides.md` L131): 이 두 컬럼은 서버 투영 단계에서 제거되며 응답 와이어에 실리지 않는다 — 타입에 넣으면 과거 권한 상승 취약점을 재도입한다. 대신 `lockYN`·`lockerUserId`·`lockedAt`은 UI 계약이므로 **유지**한다.
- **편집 잠금 신원은 세션이 아니라 탭(`x-edit-client` clientId)이다**(L131-132·154). lock/unlock/force-unlock 메서드 시그니처는 clientId(탭 식별자)를 1급 인자로 받아야 한다. session id를 잠금 보유자 키로 두지 마라.
- **사용자 삭제 메서드를 만들지 마라**(L21·L302). `DELETE /api/users`는 존재하지 않는다 — 비활성화는 `active='N'` update다. IModel에 user delete를 두면 계약과 어긋난다.
- **클라이언트는 role로 인가를 판정하지 않는다**(ADR-004). 타입에 role을 담더라도 그것은 서버가 준 표시용이며, 어떤 클라이언트 로직도 그 값으로 서버 권한을 우회/판정하지 않는다는 주석을 IModel 상단에 명시하라.

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
```
(테스트: 사유 토큰↔상태 매핑 전수 · status 문자열 변환 왕복 · fakeModel 로그인/목록 시나리오 · 응답 타입에 locker 세션/클라 필드 부재를 정적으로 확인하는 컴파일/리플렉션 없는 명시 테스트)

## 검증 절차

1. AC 커맨드 실행.
2. 아키텍처 체크리스트: core/는 Qt Widgets/Network에 의존하지 않는가(가능하면 Qt Core만)? IModel이 순수 가상인가? locker 세션/클라 필드가 정말 어디에도 없는가?
3. news-md-overrides의 L131/L131-132·154/L21이 코드/테스트에 반영됐는가?
4. 결과 반영: 성공 → completed + summary(만든 타입·IModel 35 메서드·fakeModel). 실패 3회 → error.

## 금지사항

- 응답 타입에 `lockerSessionId`/`lockerClientId`를 두지 마라. 이유: 서버가 제거하는 필드이며 권한 상승 취약점의 재료다.
- 잠금 보유자를 session id로 식별하지 마라. 이유: 실제 키는 (userId, x-edit-client clientId)다.
- user delete 메서드를 만들지 마라. 이유: 그런 엔드포인트가 없고 DB 비파괴 규율에 어긋난다.
- 실제 HTTP/소켓 코드를 넣지 마라. 이유: 전송은 step 2~3의 net 계층 책임이다.
- 기존 테스트를 깨뜨리지 마라.
