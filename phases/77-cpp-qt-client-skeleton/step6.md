# Step 6: login-screen

## 읽어야 할 파일

- `/docs/news.md` (로그인 흐름 절 — 원문) **+** `/docs/news-md-overrides.md` (**L22 bcrypt+계정 잠금(423) · L23 로그인 후 list.do · L126 쿠키 세션 · L142 계정 5회/15분 423** 필독 — news.md 줄을 만나면 오버라이드가 이긴다)
- `/docs/ADR.md` (ADR-003 Model-View-Controller seam · ADR-004 신뢰 경계)
- `web/src/view/LoginPage.jsx` · `web/src/controller/` 로그인 관련 (있으면 — 화면/컨트롤러 동작 명세. 읽기 전용)
- `phases/77-cpp-qt-client-skeleton/step1.md`(IModel/fakeModel) · `step2.md`(HttpModel/쿠키 세션) · `step4.md`(config/서버 origin)

## 작업

`client-cpp/ui/`에 **로그인 화면(View) + 컨트롤러**를 만든다. Model은 `IModel`을 **주입**받는다(테스트는 fakeModel, 실행은 HttpModel) — ADR-003 seam.

1. **View(`ui/LoginView`)**: 아이디·비밀번호 입력 + 로그인 버튼 + 오류 표시 영역. Qt Widgets. UI 문자열은 UTF-8.
2. **Controller(`ui/LoginController`)**: 입력을 받아 `model.login(...)`을 호출하고 결과에 따라 상태 전이. **성공 시 목록 화면(list) 진입 신호**를 방출한다(L23 — 로그인 성공은 목록으로 간다. 작성/목록 합본 화면 아님).
3. **오류 분기**(사유 토큰 기반, L22·L142): `401 invalid-credentials`(자격 불일치) · `423 locked`(계정 5회 실패 15분 잠금 — 올바른 비밀번호도 거부) · IP 레이트리밋(15분/10회) · `403 inactive`(비활성 계정)를 **구분해** 사용자 메시지로 표시한다. 클라이언트는 이 판정을 하지 않고 서버 응답을 해석만 한다.
4. **세션 지속**: 로그인 성공 시 서버가 준 `sid` 쿠키가 HttpModel의 쿠키 자에 보관돼 이후 요청에 자동 첨부된다(L126). 클라이언트가 읽는 저장소에 세션 id를 넣지 마라.
5. **테스트**(TDD, fakeModel 주입): 성공 → list 진입 신호 · invalid-credentials 표시 · 423 locked 표시(비밀번호 정확해도) · inactive 표시 · 네트워크 오류 표시. View는 컨트롤러 신호에 반응만.

**핵심 규칙:**
- **비밀번호를 로그·diag·config에 남기지 마라**(LOGS.md 마스킹 · ADR-011).
- **클라이언트가 자격 검증/계정 잠금을 판정하지 마라**(ADR-004). 서버가 판정하고 클라는 사유 토큰을 해석만 한다.
- **로그인 성공을 작성/목록 합본 화면으로 보내지 마라**(L23). 목적지는 목록(list)이다.
- **Model을 직접 생성하지 말고 주입받아라**(ADR-003). 이유: 테스트가 fakeModel을 주입해 서버 없이 검증한다.

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
```

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트: Model 주입 seam인가? 성공→list 신호? 오류 분기(401/423/403/레이트리밋)를 구분 표시하는가? 비밀번호가 로그/config에 없는가?
3. news-md-overrides L22/L23/L126/L142 반영 확인.
4. 결과 반영: 성공 → completed + summary(LoginView/Controller · 주입 seam · 오류 분기). 실패 3회 → error.

## 금지사항

- 비밀번호를 로그/diag/config에 남기지 마라. 이유: 민감정보 유출.
- 클라이언트에서 자격/잠금을 판정하지 마라. 이유: 신뢰 경계는 서버다.
- 로그인 성공을 목록 외 화면(합본 화면 등)으로 보내지 마라. 이유: 계약상 목적지는 list다.
- Model을 화면에서 직접 생성하지 마라. 이유: 주입 seam이 테스트/전송 분리의 근간이다.
- 기존 테스트를 깨뜨리지 마라.
