# Step 6: shell-instance-bounds

shell 레이어의 창 생명주기 2종을 이식한다: (a) **단일 인스턴스 잠금**(클라이언트 축 — 서버 ADR-012와 별개) (b) **창 bounds 영속**(close 시 1회 저장 · workArea 교차 판정). 부팅 순서 계약(`userData 지정 → 잠금 요청`)을 지킨다.

## 읽어야 할 파일
- `docs/ADR.md` ADR-011(부팅 순서: `userData` 지정 → 단일 인스턴스 잠금 순서 고정 · 잠금 키가 userData에서 파생 · 미등록 webContents는 가장 제한적 취급 fail-closed) · ADR-012(서버 축과의 차이 — "클라이언트 Electron 셸의 requestSingleInstanceLock과는 별개 축")
- `docs/ARCHITECTURE.md` 「배포 산출물(Windows 클라이언트 EXE)」(단일 인스턴스 · 창 bounds 저장 close 시 1회 · workArea 교차 · 부팅 순서 계약)
- `client/lib/clientConfig.js` (bounds shape·`sanitizeBoundsShape` — step4에서 이식한 부분과 연결) · `client/lib/windowPolicy.js`(창 옵션 기본값 참고 — width/height)
- `scripts/verify-client.mjs` (시나리오 A의 `second-instance` 단언 — 두 번째 인스턴스 즉시 종료·기록)
- `phases/77-cpp-client-skeleton/index.json` decisions (8) · step4에서 만든 `client-qt/shell/`의 config 모듈

## 작업
1. **TDD**: `InstanceLockTest`·`WindowBoundsTest`를 먼저 쓴다. 잠금은 순수 판정으로 떼기 어려우니 **키 파생**(userData 경로 → 잠금 키)과 **bounds sanitize/workArea 교차 판정**을 순수 함수로 분리해 단위 테스트한다. red 확인 후 구현.
2. **단일 인스턴스**: `client-qt/shell/`에 `QLockFile`(또는 named mutex) 기반 잠금. 키는 **userData 경로에서 파생**(뒤집으면 실사용자 프로필 오염·검증 거짓 통과). 두 번째 인스턴스는 즉시 종료 + `second-instance` diag(step5의 Diag 사용). 잠금 획득 순서는 `userData 지정 → 잠금 요청` 고정.
3. **창 bounds 영속**: bounds는 **close 시 1회** 저장(주기 저장 금지 — ADR-008). 복원 시 **현재 모니터 workArea와 교차** 판정으로 화면 밖 복원을 막는다(`sanitizeBounds` 상당 — 순수 함수). 최소 크기(MIN_WIDTH=800/MIN_HEIGHT=600) 위반은 거부. bounds는 step4의 config 화이트리스트에 이미 있는 `{width,height,x,y,maximized}`로 저장한다.
4. **미등록 창 fail-closed**: 새 창/내비게이션 정책은 등록된 것만 허용, 미등록은 가장 제한적 취급(원격 페이지 창과 로컬 셸 창 분리 — `windowPolicy.js` 정신 승계). P4에는 창이 메인+(설정/오류) 정도이므로 최소 정책만.

## Acceptance Criteria
```
cmake --build client-qt/build
QT_QPA_PLATFORM=offscreen ctest --test-dir client-qt/build --output-on-failure   # InstanceLockTest·WindowBoundsTest green
cd /home/user/harness && git diff --stat    # client-qt/shell·tests 만 바뀐다
```
- `WindowBoundsTest`가 화면 밖 bounds(모든 workArea와 교차 0)·최소 크기 미만·정수 아님을 거부하는 것을 단언한다.
- 단일 인스턴스 키가 userData 경로에서 파생됨을 단언하는 테스트가 있다(경로가 다르면 키가 다르다).

## 검증 절차
1. bounds 저장이 close 시 1회 경로임을 코드로 확인(타이머 저장 없음 — ADR-008).
2. 잠금 획득이 userData 지정 **이후**임을 확인(부팅 순서 계약).
3. 두 번째 인스턴스 경로가 `second-instance` diag를 남기고 종료하는지 확인(step5 Diag 연동).

## 금지사항
- bounds를 주기 타이머로 저장하지 마라. 이유: 앱 내 타이머 0 원칙(ADR-008) — close 시 1회다.
- 잠금 키를 userData 경로 외의 것으로 파생하거나 잠금을 userData 지정 전에 요청하지 마라. 이유: 실사용자 프로필 오염과 검증 거짓 통과가 난다(ADR-011 부팅 순서 계약).
- 서버의 ADR-012 잠금(SQLite EXCLUSIVE)을 클라이언트에 이식하지 마라. 이유: 대상·메커니즘·실패 모드가 다른 별개 축이다 — 클라는 userData 기반 파일/뮤텍스 잠금이다.
