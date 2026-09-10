# Step 10: ui-login

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `decisions` (2)(6)(7)(9)(12) · `open_questions` (3)(4)(8) · `excluded` (b)(c)
- `docs/ADR.md` **ADR-018** · **ADR-003**(View ← Controller ← Model) · **ADR-004**(신뢰 경계)
- `docs/news-md-overrides.md` — **L22**(bcrypt · 타이밍 균등화 · **5회/15분 계정 잠금**) · **L142**(IP 15분/10회 · **423 vs 429는 다른 축**) · **L123-128**(신원 매 요청 재도출 — 캐시 금지) · **L23**(로그인 성공은 목록으로) · **L125**(웹의 지속 쿠키 — 네이티브는 다르다: `decisions` (6))
- `docs/news.md` **L19-26**(사용자 함수·로그인) · **L140-145**(워크플로우·레이트리밋) — **반드시 오버라이드 대장과 함께 읽어라**
- `docs/UI_GUIDE.md` — 로그인 카드·버튼·입력 스타일(명조 700 CTA · 블루 기조 · 장식 금지)
- **계약(읽기 전용)**: `docs/api-contract/endpoints.json`의 `login`·`logout`·`session` 행 + `notes`(로그인 응답 `user`는 **6키**, `GET /api/session`은 **정확히 5키** — shape이 다르다) · `docs/api-contract/reason-tokens.md`
- **정본 구현(읽기 전용)**: `web/src/controller/useLoginController.js`(있다면) · `web/src/view/LoginPage.jsx` — 흐름과 문구의 참고
- `phases/77-qt-client-skeleton/step5.md`~`step9.md` 산출물(셸·전송·Model·SSE)

## 배경

로그인은 **네이티브 클라가 처음으로 서버와 실제로 말하는 화면**이다. 세 가지가 이 화면의 하중을 받는다.

1. **실패 축 3종을 구분해 표시**한다: 401(자격 오류) · **423 계정 잠금**(5회 실패 → 15분 · 올바른 비밀번호도 거부) · **429 IP 레이트리밋**(15분/10회). override L22·L142가 「구분하지 못하면 사용자가 무엇을 해야 하는지 알 수 없다」는 지점이다.
2. **신원을 캐시하지 않는다**(`decisions` (7)). 로그인 응답의 `role`은 **표시용**이고, 화면 권한 판정의 정본이 아니다. P4에는 액션 버튼이 없으므로 **역할 기반 진리표를 만들지 마라**(P7의 것이다).
3. **자동 검증이 이 화면부터 실기로 붙는다** — 그래서 앱에 **자동화 훅**이 필요하다(아래 A).

## 작업

### A. 자동화 훅 (하네스가 UI를 몰 수 있게)

네이티브 앱에는 CDP가 없어 드라이버가 버튼을 누를 수단이 없다. **`CLIENT_SELFTEST=1`일 때만 동작하는 시나리오 훅**을 둔다(`open_questions` (8)에 대안과 함께 기록된 결정).

- CLI: `--scenario login`(이후 step11이 `list` 추가). **`CLIENT_SELFTEST=1`이 아니면 fail-closed로 거부하고 비-0으로 종료**한다.
- **가드의 성격을 정직하게 다뤄라(② 검토 반영 · `open_questions` (8) 확정)**: 이 가드는 **보안 경계가 아니라 사고 방지 장치다** — 누구나 환경변수를 켤 수 있으므로 막아 주는 것은 「실수로 자동 로그인 경로가 도는 것」이지 악의적 사용이 아니다. **README·ADR-018에 그렇게 적어라**(「가드가 있으니 안전하다」 금지).
- **이월(P8)**: 프로덕션 빌드에서 훅 코드를 **컴파일 타임에 제거**하는 것(별도 빌드 구성/매크로)은 배포 형상 결정과 함께 가야 하므로 **P8로 이월**한다. 이 사실을 step12 `forward_notes`에 남긴다.
- 자격은 env `CLIENT_SCENARIO_USER`·`CLIENT_SCENARIO_PASSWORD`로 받는다. **어떤 diag에도 비밀번호를 적지 마라**(금지 키 필터가 1차 방어선이지만, 애초에 넣지 마라).
- 훅은 **컨트롤러 계층을 호출**한다(위젯을 프로그램으로 클릭하지 마라 — 화면 구조가 바뀔 때마다 깨진다). 전송은 **실제 HTTP**다(가짜 Model 금지 — 실기의 의미가 사라진다).
- 훅이 하는 일은 「컨트롤러의 로그인 액션 1회 호출」뿐이다. 그 뒤의 화면 전환·목록 조회는 **앱의 정상 경로**가 한다.

### B. Model 주입과 컨트롤러

- `LoginController(INewsModel&, Diag*)` — 위젯 타입을 받지 않는다. 결과는 **결과값/신호**로 올린다.
- 컨트롤러 단위 테스트는 **`FakeNewsModel`** 로 돈다: 200 성공 · 401 · 423 · 429 · 네트워크 실패 5축.
- 성공하면 상위(합성 루트)가 목록 화면으로 전환하고 `login{status:200}` diag를 남긴다. **`GET /api/session`으로 신원을 다시 받는 경로**를 여기서 만든다(step11의 목록 진입이 그것을 쓴다).

### C. 화면

- `docs/UI_GUIDE.md`를 따른 최소 로그인 카드: 아이디·비밀번호 입력 + CTA + **오류 메시지 영역**.
- 오류 문구는 세 축을 구분한다(문구 자체는 재량 — 다만 **423과 429를 같은 문장으로 뭉개지 마라**).
- 비밀번호 입력은 마스킹하고 **어디에도 로그하지 않는다**.

### D. 드라이버 시나리오 `login` 추가

`scripts/verify-qt-client.mjs`에 시나리오를 **덧붙인다**(step6의 구조 재사용):

1. 서버 기동 + 임시 `DATA_DIR` 시드(계정 `desk`/`desk123`).
2. 유효 `serverUrl` config로 클라 기동(`CLIENT_SELFTEST=1` · `--scenario login` · env로 자격 주입).
3. **diag 시퀀스 판정**: `app-ready` → `config-loaded{hasServerUrl:true}` → `app-window` → `net-request{route:'login',status:200}` → `login{status:200}` → `net-request{route:'session',...}`(신원 재확인 경로가 있다면).
4. **서버 측 교차 확인**: 드라이버가 같은 서버에 **Node fetch로 로그인**해 200과 `sessionId`를 받는지 확인한다(클라가 성공했다고 주장하는데 서버가 그 계정을 모르면 모순 — 두 축 교차의 최소형).
5. **부정 경로 1건**: 틀린 비밀번호로 한 번 더 기동해 `login{status:401}`이 남고 **화면이 넘어가지 않음**(`list-loaded`가 없음)을 단언.
6. **라우트 원장 판정**(step6의 `judgeRouteLedger`): 이 시나리오에서 관측된 `net-request.route`가 전부 계약 39 안이고 **금지 2행이 0건**.

**주의(레이트리밋)**: 부정 경로를 **같은 서버 인스턴스에서 여러 번 반복하지 마라** — 계정 잠금 5회/15분, IP 10회/15분이라 이후 시나리오가 423/429로 죽는다(`open_questions` (3)). 부정 경로는 **1회**만, 또는 자기 서버 인스턴스에서.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario boot --server exe
node scripts/verify-qt-client.mjs --scenario login --server exe
node scripts/verify-qt-client.mjs --scenario login --server spring
npm test
npm run lint
git status --porcelain
```
- 전부 exit 0 · 컨트롤러 단위 테스트 5축(200·401·423·429·네트워크 실패)이 존재 · 무접촉 경로 diff 0.
- **`cmd /c client-qt\run.bat --scenario login`을 `CLIENT_SELFTEST=1` 없이 실행하면 앱이 비-0으로 거부**함을 실증한다(수동 1회 + 요약 기록 · 직접 exe 실행 금지 — Qt DLL PATH는 `run.bat`이 싣는다).

## 검증 절차

1. **TDD red 실증** 후 구현.
2. **변이 3종**:
   - M10-1 423을 401과 같은 문구로 뭉갠다 → 컨트롤러 테스트가 red인가? 원복.
   - M10-2 로그인 실패인데 화면을 넘긴다 → 드라이버의 부정 경로가 red인가? 원복.
   - M10-3 자동화 훅의 `CLIENT_SELFTEST` 가드를 제거 → 「가드 없이 거부」 확인이 red인가? 원복.
3. **비밀번호 유출 점검**: 시나리오 실행 후 diag 파일 전문을 검색해 **비밀번호 문자열이 0건**임을 확인한다(요약에 기록).
4. **flake 확인**: `--scenario login`을 **연속 2회** 돌려 같은 결과인지 본다.

## 되돌림

이 step의 화면·컨트롤러 소스와 드라이버의 `login` 시나리오 블록을 제거하면 step9 상태다.

## 금지사항

- **로그인 응답의 role/active를 화면 권한의 정본으로 캐시하지 마라.** 이유: 서버가 매 요청 신원을 재도출하며(override L123-128), 캐시는 이 프로젝트가 이미 고친 stale-privilege 버그의 원인 패턴이다.
- **자동화 훅을 가드 없이 두지 마라.** 이유: 프로덕션 바이너리에 살아 있는 자동 로그인 경로는 그 자체가 취약점이다.
- **가짜 Model로 실기 시나리오를 돌리지 마라.** 이유: 전송·계약·서버가 검증되지 않은 채 green이 된다(공허 통과).
- **비밀번호를 diag·로그·화면 캡션 어디에도 남기지 마라.**
- **부정 경로를 반복 실행하지 마라.** 이유: 계정 잠금(5회/15분)·IP 제한(10회/15분)이 후속 시나리오를 죽인다.
- **역할 기반 버튼 진리표·관리 화면을 만들지 마라.** 이유: P7의 것이다(`excluded` (b)(c)).
