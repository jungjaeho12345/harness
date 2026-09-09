# Step 9: login-screen

ui 레이어의 **로그인 화면**을 만든다 — `login`/`logout`/`restoreSession`을 net Model(step7)에 배선한 로그인 뷰 + 컨트롤러. 서버 없이 `FakeModel` 주입으로 단위 테스트하고, 세션·자격증명은 저장하지 않는다.

## 읽어야 할 파일
- `web/src/controller/useLogin.js` (정본 컨트롤러 로직 — 로그인 흐름·에러 표시·세션 복원 F5 경로) · `web/src/view/` 로그인 관련 뷰(있는 것)
- `web/src/model/httpModel.js` (`login`·`logout`·`restoreSession` 응답/에러 shape)
- `docs/news.md` 로그인·권한 관련 절(로그인 실패·잠금 5회/15분 423 · 세션 복원)
- `docs/ADR.md` ADR-004(세션·role은 서버 도출 · 클라 role 불신 · 1시간 슬라이딩) · ADR-003(FakeModel 주입 테스트)
- `docs/ARCHITECTURE.md` 「상태 관리」(세션 복원 — F5 시 `/api/session` 확인 후 복원 · 복원 전까지 로그인으로 안 보냄 · 세션·자격증명 미저장)
- `phases/77-cpp-client-skeleton/index.json` decisions (4)(5)(7) · `client-qt/net/`(step7·8 — `INewsModel`·`FakeModel`) · `client-qt/shell/`(step4 — config·probe)

## 작업
1. **TDD**: `LoginControllerTest`를 먼저 쓴다 — `FakeModel` 주입 · 성공 시 세션 상태 전이 · 실패(잘못된 자격·423 잠금)의 에러 표시 · `restoreSession` 성공/실패 분기. red 확인 후 구현.
2. `client-qt/ui/`에:
   - **로그인 뷰**(QWidget) — 아이디·비밀번호 입력 + 로그인 버튼 + 에러 라벨. 최소 화면.
   - **로그인 컨트롤러**(`useLogin.js` 동형 — Model 주입) — `login()`→성공 시 목록 화면으로 전환 신호·실패 시 사유(reason) 표시. `logout()`. 앱 시작 시 `restoreSession()`으로 서버 확인 후 복원(복원 전까지 로그인으로 강제 이동하지 않음).
   - Model은 주입(테스트=FakeModel · 실행=HttpModel). 뷰는 transport 비의존.
3. **서버 주소 연결**: 로그인 전 서버 origin은 step4의 config/probe에서 온다 — config에 serverUrl이 없으면 설정(주소 입력) 화면을 먼저 보여준다(shell 프로브로 `{ok:true}` 확인 후 저장). 이 화면 배선은 최소로.
4. **보안**: 세션ID·비밀번호를 config·로그·diag에 저장/기록하지 않는다(금지키 규율 — step5 Diag).

## Acceptance Criteria
```
cmake --build client-qt/build
QT_QPA_PLATFORM=offscreen ctest --test-dir client-qt/build --output-on-failure   # LoginControllerTest green
cd /home/user/harness && git diff --stat    # client-qt/ui·tests 만 바뀐다
```
- `LoginControllerTest`가 FakeModel로 성공·실패(423 잠금 포함)·restoreSession 분기를 단언한다.
- 세션·비밀번호가 config/diag에 실리지 않음을 확인하는 경로가 있다(보안 불변식).

## 검증 절차
1. 컨트롤러가 role을 클라에서 판단하지 않고 서버 응답(세션)에서만 받는지 확인(ADR-004).
2. `restoreSession` 실패 전까지 로그인 화면으로 강제 이동하지 않는 흐름인지 확인(ARCHITECTURE 상태 관리).
3. 뷰가 Model을 직접 fetch하지 않고 주입 인터페이스만 쓰는지 확인(ADR-003 seam).

## 금지사항
- 세션ID·비밀번호를 config.json·로그·diag에 저장/기록하지 마라. 이유: 신뢰 경계 밖 저장은 유출 표면이다(ADR-011 · decisions (7)).
- 클라이언트에서 role을 판단해 화면 권한을 게이트하지 마라. 이유: 인가는 서버가 세션에서 도출한다 — 클라 판단은 우회 가능하다(ADR-004).
- 목록 외 화면(writer·rcvMgmt·userMgmt·logs·distMgmt)을 만들지 마라. 이유: P4는 로그인·목록 2화면뿐이다(excluded (b)).
