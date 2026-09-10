# Step 5: app-shell

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `decisions` (1)(2)(11)(12) · `excluded` (a)(b)(e)
- `docs/ADR.md` **ADR-018** · **ADR-011**(창 정책의 정신) · **ADR-012**(단일 인스턴스 잠금의 근거 — 서버 축이지만 이유가 같은 계열이다)
- **정본 소스(읽기 전용)**: `client/main.js` — 부팅 순서(`app-ready` → `config-loaded` → 앱 창 또는 설정 화면) · `second-instance` 처리 · bounds 저장 시점 · 외부 링크 처리
- **정본 소스(읽기 전용)**: `client/lib/windowPolicy.js` — 창 2종 분리 · bounds/`workArea` 교차 판정 · fail-closed 규율
- **판정자(읽기 전용)**: `scripts/verify-client.mjs` **149행 이하 `main()`** — 시나리오 A(설정 있음 → 앱 창) / B(설정 없음 → 설정 화면)의 **정확한 이벤트 시퀀스**. 여기서 판정되는 것이 step6이 이식할 시퀀스다. 특히 **프로브는 사용자 액션에만 발생한다**(파일 머리 주석 — 부팅 경로에 `probe`가 남지 않는다).
- `phases/77-qt-client-skeleton/step2.md`~`step4.md` 산출물(`client-qt/src/shell/`: 주소 정규화·config 저장소·diag)

## 배경

여기서 **앱이 실제로 뜬다.** 셸이 책임지는 것은 넷이다: 단일 인스턴스 · 설정 로드 → 창 또는 설정 화면 · 창 bounds · diag 결선.

정본의 부팅 순서(이식 대상):

1. 단일 인스턴스 잠금 획득 실패 → **두 번째 프로세스는 즉시 종료**하고, 첫 프로세스가 `second-instance`를 남기며 창을 앞으로 가져온다.
2. `app-ready` → 설정 로드 → `config-loaded{hasServerUrl}`.
3. `serverUrl`이 있으면 메인 창(`app-window`), 없으면 **설정 화면**(`setup-shown{reason:'no-config'}` + `local-window{page:'setup'}`).
4. 창을 닫을 때 bounds를 **1회** 저장(`config-saved`).

**Electron과 다른 지점 둘**(`decisions` (11)): 사용자 데이터 폴더는 `%APPDATA%\기사작성기-qt`이고, **단일 인스턴스 잠금 이름도 Electron과 다르다** — 두 클라를 나란히 띄워 화면을 대조하는 것이 P4~P7의 기본 개발 방식이라 이름을 공유하면 그 대조가 불가능해진다.

**프로브 실행은 이 step이 하지 않는다.** 주소 판정 함수는 step2에 있고 HTTP 실행은 net 계층(step7)의 것이다. 여기서는 **주입 지점만** 만든다.

## 작업

### A. 합성 루트와 주입

`client-qt/app/main.cpp`는 **얇은 합성 루트**다: 설정 저장소·diag·프로브 실행기·(이후) Model을 만들어 화면에 **주입**한다. 화면이 전역이나 싱글턴에서 의존성을 꺼내 오지 않게 하라(ADR-003의 정신 — 그래야 테스트가 가짜를 넣는다).

```cpp
struct ProbeRunner {  // step7이 실제 HTTP 구현을 넣는다
  virtual HealthVerdict probe(const QString& origin, QString* finalUrl) = 0;
};
```
- 이 step의 합성 루트는 **미구현 러너**를 주입한다: 즉시 `{ok:false, reason:"unreachable"}`을 돌려주고 `probe{ok:false,reason:...}` diag를 남긴다. **그 사실을 설정 화면 UI와 README에 명시**하라(「연결 확인은 step7에서 실제 HTTP로 붙는다」). 조용히 성공한 척하지 마라.

### B. 단일 인스턴스

- Windows named mutex(또는 동등물). 이름은 Electron과 **다르게** 하고 README에 적는다.
- 두 번째 인스턴스: **창을 만들지 않고 즉시 종료**(exit 0). 첫 인스턴스가 `second-instance` diag를 남기고 창을 활성화한다.

### C. 창과 bounds

- 메인 창 기본 크기는 정본 앱 창과 같게 둔다(`client/lib/windowPolicy.js`의 값 — 1440×900 · 최소 1024×720).
- 복원 시 **`workArea` 교차 판정**: 저장된 위치가 현재 모니터 배치 밖이면 위치를 버리고 크기만 쓴다(정본 규율).
- 저장은 **닫을 때 1회**. 매 이동/리사이즈마다 쓰지 마라(디스크·원자적 쓰기 낭비).
- **`CLIENT_SELFTEST=1`이면 창을 표시하지 않는다**(env 이름 승계 — 하네스가 데스크톱을 오염시키지 않는 수단). 창 **생성과 diag는 그대로** 일어난다.
- `--selftest` 인자는 셸 불변식 자기검사(합성 루트가 전부 주입됐는지 등)를 돌리고 **창 없이 종료**한다.

### D. 화면 2개(이 step의 범위)

- **설정 화면**: 서버 주소 입력 + 저장(step2 정규화 통과분만) + 연결 확인 버튼(주입된 러너 호출). 저장 성공 시 `config-saved{origin}`.
- **빈 메인 창**: 상단바 자리와 상태 표시 자리만 있는 껍데기. **로그인·목록은 step10·step11**이 채운다.
- UI 톤은 `docs/UI_GUIDE.md`를 따른다(신문형 밀도 · 블루 기조 · 장식 금지). **P4에서 CSS/QSS 토큰을 완성하려 하지 마라** — 색 4종·간격 규칙만 상수로 두고 화면 step에서 쓴다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
```
- exit 0 · 테스트 총계 증가 · 실패 0(창 없이 도는 단위 테스트: bounds workArea 교차 판정 · 부팅 분기 판정(설정 유무 → 어느 화면인가) · 이벤트 이름 집합).

```
set CLIENT_USER_DATA=%TEMP%\qtcli-a& set CLIENT_DIAG_FILE=%TEMP%\qtcli-a\diag.jsonl& set CLIENT_SELFTEST=1& cmd /c client-qt\run.bat --selftest
```
- exit 0이고 diag 파일에 **`app-ready`와 `config-loaded`가 남는다**(설정이 없는 임시 폴더이므로 `hasServerUrl=false`).
- **반드시 `client-qt\run.bat`으로 실행하라 — `release\news-client.exe`를 직접 부르면 Qt DLL 부재로 즉사한다**(Qt는 동적 링크이고 PATH를 싣는 자리는 `run.bat`과 step6 드라이버뿐이다 · step0 D).
- 위 커맨드는 PowerShell에서는 `$env:` 형식으로 바꿔 쓴다(**bash에 한글·비ASCII를 넣지 마라**).

```
npm test
npm run lint
git status --porcelain
```
- 무회귀 · `client/**`·`test/**` diff 0 · **실사용자 `%APPDATA%\기사작성기`·`%APPDATA%\기사작성기-qt` 무변**(실행 전후 비교 결과를 요약에 적는다).

## 검증 절차

1. **TDD red 실증** 후 구현.
2. **두 부팅 경로를 손으로 한 번씩** 돌려 diag를 확인한다(자동 판정은 step6). **손으로 띄우는 모든 실행은 `cmd /c client-qt\run.bat [인자]`로 한다**(Qt DLL PATH):
   - A: 임시 `CLIENT_USER_DATA`에 `config.json`(유효 `serverUrl`)을 두고 기동 → `app-ready` → `config-loaded{hasServerUrl:true}` → `app-window`.
   - B: 빈 폴더로 기동 → `app-ready` → `config-loaded{hasServerUrl:false}` → `setup-shown` → `local-window{page:'setup'}`.
   - 두 경로 모두 **부팅만으로 `probe`가 남지 않는지** 확인한다(정본 설계 — 프로브는 사용자 액션에만).
3. **두 번째 인스턴스**: 첫 인스턴스를 띄운 채 다시 실행 → 두 번째가 **즉시 종료**하고 첫 diag에 `second-instance`가 남는지 확인.
4. **변이 2종**:
   - M5-1 단일 인스턴스 잠금을 제거 → 두 번째 인스턴스가 창을 하나 더 띄운다. 이 사실을 **테스트가 잡는가?** 잡지 못하면 잠금 획득 판정을 순수 함수로 분리해 테스트하고 다시 실증. 원복.
   - M5-2 bounds의 `workArea` 교차 판정을 제거 → 화면 밖 좌표가 그대로 복원되는 케이스가 red인가? 원복.

## 되돌림

이 step의 소스·테스트·`common.pri` 항목 제거. `app/main.cpp`는 step0의 최소판으로 되돌린다.

## 금지사항

- **Electron과 같은 mutex 이름·같은 config 폴더를 쓰지 마라.** 이유: 두 클라가 P8까지 공존하며 서로를 막거나 설정을 지운다(`decisions` (11)).
- **여기서 HTTP를 구현하지 마라.** 이유: 전송 계층은 step7의 것이고, 두 곳에 생기면 헤더·쿠키·타임아웃 규율이 갈린다.
- **연결 확인이 미구현인 사실을 숨기지 마라.** 이유: 조용히 성공한 척하는 UI는 step7에서 진짜 실패가 났을 때 원인을 감춘다.
- **화면을 더 만들지 마라.** 이유: P4의 화면은 **로그인·목록·설정 3개**이고 그 인벤토리를 step11이 잠근다(`excluded` (b)(c)).
- **`client/**`·`test/**`를 고치지 마라.**
