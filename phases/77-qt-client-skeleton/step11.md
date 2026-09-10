# Step 11: ui-list

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `scope`(완료 게이트) · `baseline`(F) · `decisions` (5)(7)(8)(9)(12) · `excluded` (a)(b)(c)(d)
- `docs/ADR.md` **ADR-018** · **ADR-003** · **ADR-005**
- `docs/news-md-overrides.md` — **L80**(SSE = 단일 신호 + 전체 재조회) · **L97·L100**(기본 컬럼 11종 + 배부시간 토글) · **L104**(시간 형식은 환경설정 전역값 — P4는 기본값 고정) · **L123-128** · **L91·L96-99**(우클릭 메뉴 — **P4 범위 아님**)
- `docs/news.md` **L78-104**(기사 조회페이지) — **오버라이드 대장과 함께 읽어라**
- **정본(읽기 전용)**: `web/src/controller/useViewController.js` **28행·70~72행**(메뉴별 필터 — `deskUnsent = {status:['RDS','DDH']}`) · **143~147행**(SSE kind 무시하고 `refresh()`) · `web/src/view/columnConfig.js` **6~20행**(컬럼 카탈로그 12종 · `distributedAt`만 기본 숨김) · `web/src/view/listFormat.js`(시간·셀 포맷)
- **계약(읽기 전용)**: `docs/api-contract/endpoints.json`의 `articles-list` 행 — **필터 화이트리스트 13키** · **페이징·총수 필드 없음**(⇒ 10개씩 페이징은 **클라이언트가 한다**) · 반복 쿼리 키는 배열(IN)
- `docs/UI_GUIDE.md` — 표 스타일(thead `#f5f5f5` · th 하단 2px 블루 · td 1px `#ddd` · 행 hover 틴트) · 상태 배지 색 · 상단바 48px(우측에 로그인 사용자 정보 + **실시간 상태바**)
- `phases/77-qt-client-skeleton/step6.md`(드라이버 구조) · `step8.md`(Model) · `step9.md`(SSE) · `step10.md`(로그인·자동화 훅)

## 배경

**이 step이 로드맵 P4의 완료 게이트를 닫는다**: 「로그인 → 목록 **SSE 실시간 갱신** 실기 + diag 이벤트로 자동 검증」.

P4 목록의 경계(넓히지 마라 — `excluded` (b)):

- **메뉴는 `deskUnsent` 1개**(필터 `{status:['RDS','DDH']}`). 6메뉴 탭·부서 멀티셀렉트·검색은 P7.
- **읽기 전용**: 우클릭 메뉴 없음 · 편집 진입 없음 · 상세보기 새 창 없음 · 컬럼 설정 모달 없음.
- **기본 컬럼 11종 고정**(카탈로그 12종 중 `distributedAt` 제외 — override L97·L100). 컬럼 토글은 P7.
- **페이징 10**은 클라이언트가 한다(계약에 페이징이 없다 — `baseline` (F)).
- 시간 형식은 **기본값 `YYYY-MM-DD HH:mm` 고정**(전역 설정 연동은 P6 — override L104).
- 상태 배지 색은 `docs/UI_GUIDE.md`의 값을 쓴다.

실시간 규율(override L80): `change` 신호를 받으면 **kind를 무시하고** 같은 필터로 **전체 재조회**한다. 부분 갱신 금지.

## 작업

### A. 컨트롤러

```cpp
class ListController {   // 위젯 타입을 받지 않는다
public:
  ListController(INewsModel&, Diag*);
  void enter();          // GET /api/session 으로 신원 재확인 → queryArticles(deskUnsent 필터)
  void refresh();        // 전체 재조회 (SSE change 수신 시 호출)
  void onStreamEvent(...); // ready / change{kind} / unauthorized
  // 페이징 상태(10개씩)는 여기 · 정렬은 시간 내림차순
};
```

- **신원 캐시 금지**(`decisions` (7)): 진입마다 세션을 재확인하고, 401을 받으면 로그인 화면으로 돌아간다.
- `unauthorized` SSE 프레임을 받으면 **재연결하지 않고** 세션 종료 처리(step9의 계약).
- 조회 결과 수를 `list-loaded{menu,count}` diag로 남긴다(**기사 제목·아이디를 적지 마라** — step4 C).
- **재조회를 유발하는 것은 `change` 신호와 사용자 액션뿐이다** — `ready` 수신·주기 타이머로 재조회하지 마라(C.4 (iii)의 「호출 횟수 정확히 2」가 이 규칙 위에 선다).
- 컨트롤러 단위 테스트는 **`FakeNewsModel`** 로 돈다: 필터가 `{status:['RDS','DDH']}`인가 · `change` 수신 시 재조회가 **정확히 1회** 일어나는가 · **`ready` 수신만으로는 재조회가 0회**인가 · **주기 재조회 타이머가 없는가**(같은 시간 경과에 호출 수 불변) · kind별 분기가 **없는가** · 페이징 경계(0건·9건·10건·11건·23건).

### B. 화면

- 상단바(48px): 좌측 타이틀, 우측 `유저아이디 · 부서 · (권한)` + **실시간 상태 표시**(연결됨/끊김). 권한 표시는 **표시용**이다.
- 표: 11컬럼 · 시간 내림차순 · 페이징 10 · 상태 배지. 행 hover 틴트까지만(우클릭·더블클릭 동작 없음).
- **화면 인벤토리 잠금(② 검토 반영 — 자기신고 레지스트리를 소스 스캔과 교차한다)**:
  1. **「화면」의 정의를 `client-qt/README.md`에 명문화**한다. 기본 정의: **사용자에게 보이는 최상위 창(top-level window) 또는 그 창의 주 내용 패널 하나**. step5의 「빈 메인 창」은 **화면이 아니라 창 껍데기**이며, 그 안에 들어가는 `로그인`·`목록` 패널이 화면이다 — 즉 P4의 화면 id는 **`login`·`list`·`setup` 3개**다. 정의를 바꾼다면 README에 이유와 함께 적어라(정의 없는 숫자 단언은 의미가 없다).
  2. 레지스트리 단언: 등록된 화면 id 집합 == `{login, list, setup}`.
  3. **소스 스캔 교차 검증**(레지스트리가 자기신고라는 약점을 메운다): `client-qt/src/ui` 아래에서 **최상위 창/화면 클래스로 선언된 것의 목록**을 텍스트 스캔으로 뽑아(예: `QMainWindow`/`QDialog`/화면 기반 클래스를 상속하는 클래스 이름) **레지스트리 집합과 대조**한다. 미등록 화면 클래스가 있으면 **red**다. 스캔 규칙과 그 한계(주석 처리·동적 생성은 못 본다)를 README에 한 줄로 적어라.
  4. 화면을 더 만들면 red — 범위 확장이 조용히 일어나는 것을 막는다(`decisions` (5)).

### C. 드라이버 시나리오 `list` (완료 게이트)

`scripts/verify-qt-client.mjs`에 덧붙인다:

1. 서버 기동 + 임시 `DATA_DIR` 시드 · 클라 기동(`--scenario list` · `desk`/`desk123`).
2. **diag 시퀀스**: `app-window` → `login{status:200}` → `net-request{route:'articles-list',status:200}` → `list-loaded{menu:'deskUnsent',count:N0}` → `sse-open`/`sse-ready`.
3. **서버 측 사실 주입(교차 축)**: 드라이버가 **Node fetch로 `reporter` 세션을 만들어 기사 1건 생성**(`POST /api/articles` — 새 기사는 `RDS`라 `deskUnsent` 필터 안이다).
4. **실시간 판정(② 검토 반영 — 폴링 클라가 통과하지 못하게 한다)**. 판정식은 **세 조건의 논리곱**이다:
   - **(i) 트리거는 반드시 `sse-ready` 관측 뒤에 쏜다**(`docs/api-contract/sse.md` 「판정 시 주의」 — `ready` 전에 쏘면 신호를 놓친다).
   - **(ii) 유한 시간 안에 `sse-change` 프레임이 **1건 이상** 도착한다 — `kind` 값은 보지 않고 개수·순서도 단언하지 않는다**(같은 문서가 **정확 kind·개수 단언은 flake**라고 명시한다. 다른 kind가 섞여 와도 통과다). 이어 **`list-loaded{count: N0+1}`** 이 도착한다.
   - **(iii) 라우트 원장에서 시나리오 전 구간의 `articles-list` 호출 횟수가 정확히 2**다(진입 1회 + 신호 후 재조회 1회). **이 조건이 「주기 재조회(폴링) 클라」를 배제한다** — (ii)만 있으면 SSE를 아예 무시하고 2초마다 재조회하는 앱도 green이 되고, 그러면 M11-1 변이도 red가 나지 않는다.
   - 그러므로 **컨트롤러는 `ready` 수신으로 재조회하지 않는다**(진입 조회가 이미 있다). 재조회를 유발하는 것은 **`change` 신호와 사용자 액션뿐**이다 — A에 이 규칙을 명시하고 단위 테스트로 잠근다.
   **이것이 P4 완료 게이트의 본체다.**
5. **라우트 원장 판정**: 관측된 `net-request.route`가 전부 계약 39 안 · 금지 2행 0건 · **기대 집합**(`login`·`session`·`articles-list`·`stream`)을 포함.
6. **관측 수 확인**: 판정한 이벤트 수·항목 수를 출력하고 최소치 미만이면 실패(공허 통과 차단).
7. **데이터 안전 스냅샷**(step6과 동일) — 리포 `news.db`·`uploads/`·실사용자 `%APPDATA%` 2폴더·`dist/*/data` 무변.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario boot  --server exe
node scripts/verify-qt-client.mjs --scenario login --server exe
node scripts/verify-qt-client.mjs --scenario list  --server exe
node scripts/verify-qt-client.mjs --scenario list  --server spring
npm test
npm run lint
npm run build
node scripts/spa-parity.mjs
node scripts/spool-parity.mjs
git status --porcelain
```
- 전부 exit 0. **`--scenario list`는 두 서버 모드 모두 exit 0**이어야 한다(`decisions` (10) — 클라가 동결 계약만 믿는다는 기계 증거).
- 무접촉 경로(`server/**`·`src/**`·`web/**`·`client/**`·`contract/**`·`docs/api-contract/**`·`test/**`) **diff 0**.
- 화면 인벤토리 테스트가 **레지스트리 3(`login`·`list`·`setup`)** 을 단언하고, **`src/ui` 소스 스캔 결과와 교차 대조**한다(미등록 화면 클래스 0건).
- 완료 게이트 판정이 **C.4의 (i)(ii)(iii) 세 조건 전부**를 검사한다(특히 `articles-list` 호출 횟수 == 2).

## 검증 절차

1. **TDD red 실증** 후 구현.
2. **변이 4종(완료 게이트의 비공허성)** — 각각 심고 `--scenario list`가 **red**인지 확인하고 원복한다:
   - M11-1 SSE `change` 수신 시 재조회를 **하지 않게** 한다 → 실시간 판정 (ii)(iii)가 red인가?
   - **M11-1p(폴링 변이 · 필수)** SSE를 **무시**하고 2초 주기 타이머로 목록을 재조회하게 한다 → **(iii) `articles-list` 호출 횟수 == 2**가 red인가?(화면은 갱신되므로 (ii)의 `list-loaded`만 보면 green이 된다 — 이 변이가 새 조건의 존재 이유다.) 원복.
   - M11-2 재조회는 하되 **화면 갱신 없이** `list-loaded`만 남긴다 → 이 게이트가 **잡지 못한다**면 그 사실을 정직하게 적어라(diag는 화면 픽셀을 보지 못한다 — 그것이 이 판정의 한계이고, 육안 체크리스트가 그 자리를 메운다).
   - M11-3 필터를 `{status:['RDS']}`로 바꾼다 → 컨트롤러 테스트가 red인가?
   - M11-4 화면을 하나 더 **등록**한다 → 레지스트리 인벤토리 테스트가 red인가?
   - **M11-5 화면 클래스를 하나 더 만들되 레지스트리에 등록하지 않는다** → **소스 스캔 교차 검증**이 red인가?(자기신고 레지스트리만 있으면 이 변이가 통과한다 — 그것이 교차 검증을 넣은 이유다.) 원복.
3. **연속 2회 실행**으로 flake 확인(SSE 타이밍 축). 다르면 재실행 2회 규약으로 판정하고 사실을 기록한다.
4. **육안 확인 1회**(자동 판정 불가 축): `CLIENT_SELFTEST` 없이 **`cmd /c client-qt\run.bat`** 으로 앱을 띄워(직접 exe 실행은 Qt DLL 부재로 즉사한다) 로그인 → 목록이 **실제로 그려지는지**, 다른 창에서 기사를 만들면 **목록이 스스로 갱신되는지** 눈으로 본다. 스크린샷 또는 관찰 결과를 요약에 남긴다(P4의 유일한 육안 항목이다).

## 되돌림

이 step의 화면·컨트롤러 소스와 드라이버의 `list` 시나리오 블록 제거.

## 금지사항

- **kind별 부분 갱신을 만들지 마라.** 이유: 서버가 행 데이터를 주지 않는다(override L80).
- **메뉴·우클릭·컬럼 설정·상세보기 창을 만들지 마라.** 이유: P7의 것이고, 지금 만들면 권한 매트릭스가 캐시된 신원 위에 서게 된다(`excluded` (b)(c)).
- **편집 진입·잠금 획득을 붙이지 마라.** 이유: 에디터는 P5이고, 잠금은 편집 표면 수명과 함께 설계되어야 한다(`decisions` (3)).
- **`lockerSessionId`·`lockerClientId`를 기대하는 파싱을 넣지 마라.** 이유: 그 필드는 응답에 없다(override L131).
- **서버측 페이징 파라미터를 만들어 보내지 마라.** 이유: 계약에 없다 — 필터 화이트리스트 밖 키는 서버가 무시하거나 거부하고, 있는 척하면 조용히 전량 조회가 된다.
- **`npm test`·계약 게이트가 흔들리면 넘어가지 마라.** 이유: 이 phase는 서버·웹·계약을 고치지 않으므로 흔들림은 **설계 위반의 신호**다.
