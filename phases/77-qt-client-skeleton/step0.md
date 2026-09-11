# Step 0: baseline-and-build-skeleton

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `scope` · `baseline`(A)~(H) · `order` · `decisions` (1)(12) · `excluded` · `open_questions` (1)(5)
- `docs/porting-plan-cpp-spring.md` — **§7 P4 행(181행)** · **§6.2(144~171행)** 앱 구조 제안 · §8 검증 전략
- `spikes/p0-qt-editor/build.bat` **전문**(9줄) · `spikes/p0-qt-editor/spike.pro`(4줄) · `spikes/p0-qt-editor/.gitignore` — **빌드 레시피의 정본이다. 재발명 금지.**
- `.gitignore` — 빌드 산출물 무시 규칙을 어디에 어떻게 추가하는지(기존 절 구성 확인)
- `CLAUDE.md` — 최상위 규칙(DB 비파괴 · TDD · 커밋 규약)

## 배경

이 phase는 리포에 **새 최상위 모듈**(`client-qt/`)을 세운다. 그 전에 두 가지를 확정해야 한다.

1. **기준선** — 이 phase는 `server/**`·`web/**`·`client/**`·`contract/**`를 한 줄도 고치지 않으므로 기존 게이트 수치는 **구조적으로 무회귀**여야 한다. 그 사실을 주장하려면 **시작 시점의 값을 자기 손으로 재야** 한다. `index.json` `baseline`의 수치는 **인계값**이지 이 트리에서 잰 값이 아니다.
2. **빌드가 실제로 도는가** — 이 머신은 **VsDevCmd가 고장**이라 `INCLUDE`/`LIB`/`PATH`를 명시 설정해야 MSVC가 뜬다. 스파이크가 그 레시피를 실증했다. 그리고 **qmake `subdirs` 다중 타깃은 이 머신에서 실증된 적이 없다**(`open_questions` (1)) — 이 step이 답한다.

이 step이 끝나면 **컴파일되고 테스트가 도는 빈 골격**이 선다. 이후 step들은 전부 「모듈을 추가하고 그 테스트를 green으로 만든다」가 된다.

## 작업

### A. 기준선 재측정 (코드 변경 0)

아래를 **연속 2회** 실행해 두 회차 수치가 같은지 확인하고 표로 기록한다(다르면 flake이며 그 사실을 적는다).

- `npm test` · `npm run lint` · `npm run build`
- `node scripts/spring-contract.mjs --parity` (Java 축이 필요하면 `JAVA_HOME`은 `D:/agents/tools/jdk-25.0.4.1+1`)
- `node scripts/spa-parity.mjs` · `node scripts/spool-parity.mjs`
- 자산 지문: 리포 `news.db` 크기·md5 · `uploads/` 파일 수·총 바이트 · `git status --porcelain`(무출력이어야 한다)

`server-spring`·`tools/news-migrator`의 `clean verify`는 **선택**이다(이 phase는 Java를 고치지 않는다). 돌린다면 값을 적고, 돌리지 않았다면 **「미측정」이라고 적는다** — 인계값을 실측처럼 옮겨 적지 마라.

### B. `client-qt/` 골격 생성

디렉토리 구조(로드맵 §6.2의 앱 구조를 P4 범위로 축약):

```
client-qt/
  client-qt.pro         subdirs(app, tests) — 실패 시 open_questions (1)의 폴백
  common.pri            공통 소스/헤더 목록 · INCLUDEPATH · CONFIG(c++17)
  src/shell/            프로브 판정 · config · diag · 창 정책      (step2~5)
  src/net/              라우트 표 · 전송 · Model 인터페이스 · SSE  (step7~9)
  src/ui/               로그인 · 목록 · 서버 주소 설정            (step10~11)
  app/app.pro           TARGET = news-client   (GUI 진입점 main.cpp)
  tests/tests.pro       TARGET = client-qt-tests (콘솔 · QtTest)
  tests/main.cpp        각 테스트 클래스를 QTest::qExec로 순차 실행하고 실패 수 합산
  build.bat             ASCII only — env 4줄 + 빌드 + 테스트 실행
  run.bat               ASCII only — env(PATH에 Qt bin) 설정 후 news-client.exe 실행 (인자 그대로 전달)
  .gitignore
  README.md             빌드 방법 · 디렉토리 규약 · 무엇이 P4가 아닌가
```

**툴킷 조합은 확정이다**(`index.json` `open_questions` (5) — 2026-09-10 오케스트레이터 확정): **C++17 · `QT += widgets testlib network`**. 근거: **P5 에디터가 위젯 기반 스파이크로 `go` 판정**을 받았으므로 P4에서 QML 갈래를 열면 P5가 그 위에 서지 못한다. `.pro`를 이 조합으로 쓰고 다른 갈래를 열지 마라.

- **`build.bat`은 `spikes/p0-qt-editor/build.bat`의 env 4줄(`MSVC`/`SDK`/`PATH`/`INCLUDE`/`LIB`)을 그대로 복제**한다. 값은 이 트리에서 실재를 확인한 것들이다: MSVC `14.50.35717` · SDK `10.0.26100.0` · Qt `D:\agents\tools\Qt\6.8.3\msvc2022_64`. **파일 전체가 ASCII여야 한다**(cmd가 배치를 cp949로 파싱한다 — 스파이크 주석의 실측).
- `build.bat`은 ① 빌드(app + tests) ② **테스트 바이너리 실행**까지 하고, 어느 단계든 실패하면 **비-0으로 종료**한다.
- **`run.bat`을 같이 만든다(중요).** Qt는 **동적 링크**라 `news-client.exe`를 맨 셸에서 실행하면 **Qt DLL 부재로 즉사**한다(PATH에 `D:\agents\tools\Qt\6.8.3\msvc2022_64\bin`이 필요하다). PATH를 싣는 자리는 step6 드라이버 하나뿐이므로, **사람이 손으로 앱을 띄우는 모든 자리는 `run.bat`을 쓴다**: `build.bat`과 같은 env 줄을 공유하고(중복이 싫으면 `env.bat`으로 뽑아 둘 다 `call`한다) 인자를 그대로 앱에 전달한다. 이후 step5·step9·step11의 수동 실행 AC가 이 파일을 부른다.
- 이 step의 소스는 **빈 골격**이다: `app/main.cpp`는 `QApplication`을 만들고 `--selftest` 인자면 창 없이 즉시 0으로 끝난다. `tests/main.cpp`는 **의도적으로 실패하는 테스트 1건**을 먼저 넣어 red를 보고(TDD 규율), 통과하도록 고쳐 green을 만든다.
- 최소 1개의 실제 테스트 클래스를 둔다(예: `tests/SmokeTest`) — 러너가 **테스트를 0건 돌리고 green**이 되는 길을 막는다.

### C. `.gitignore` 갱신

`client-qt/.gitignore`(스파이크 패턴: `release/` · `debug/` · `Makefile*` · `.qmake.stash` · `*.exe` · `*.obj`)를 두고, 필요하면 리포 루트 `.gitignore`에도 한 묶음을 **추가만** 한다(기존 줄 삭제·수정 금지 — `SecretHygieneTest`가 특정 줄의 존재를 단언한다).

### D. 검증 자산 준비 확인 (step6 이후의 AC가 여기 걸려 있다)

step6~step12의 AC는 **`--server exe`와 `--server spring` 두 모드 green**을 요구한다(`decisions` (10)). 그런데 두 자산은 **빌드 산출물이라 깨끗한 트리에 없을 수 있다** — step6 첫 실행이 자산 부재로 exit 1이 되는 것이 정상 동작이지만, **그 사실을 step0에서 미리 확인해 둬야** 뒤 step이 「하네스가 고장났나」로 시간을 쓰지 않는다.

확인하고 요약에 기록한다(값: 존재/부재 · 경로 · 크기):

- **서버 SEA exe** — `dist/` 아래의 서버 실행 파일(경로는 `scripts/verify-integration.mjs`의 후보 목록을 그대로 읽어 확인하라). 없으면 `npm run dist:server`.
- **Spring jar** — `server-spring/target/server-spring-0.0.1-SNAPSHOT.jar`. 없으면 `cd server-spring && ./mvnw -B -q package -DskipTests`(`JAVA_HOME=D:/agents/tools/jdk-25.0.4.1+1`).
- **Qt bin 디렉토리** — `D:/agents/tools/Qt/6.8.3/msvc2022_64/bin`(존재 확인 · `run.bat`·드라이버가 PATH로 싣는 값).

**둘 중 하나라도 없으면 이 step에서 빌드해 둔다.** 빌드하지 않기로 했다면 그 사실과 「step6 첫 실행 전에 누가 언제 만들 것인가」를 요약에 적어라. **자산 부재를 skip으로 흡수하는 하네스를 만들지 마라**(step6 금지사항).

### E. `open_questions` (1) 답 기록

`subdirs`가 섰는지, 폴백으로 갔는지, 그 근거(에러 원문 요지)를 step 요약에 적는다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
cmd /c client-qt\run.bat --selftest
```
- `build.bat`: exit 0이고 출력에 **테스트 총계(예: `Totals: N passed, 0 failed`)** 가 보인다. `N >= 1`.
- `run.bat --selftest`: **exit 0**. 이것이 「맨 셸에서도 Qt DLL을 찾아 앱이 뜬다」의 실증이다(PATH 레시피 확인).

```
npm test
npm run lint
npm run build
node scripts/spa-parity.mjs
node scripts/spool-parity.mjs
git status --porcelain
```
- `npm test`·`lint`·`build` 무회귀(기준선과 동일) · 두 대조기 exit 0 · `git status`에 **빌드 산출물이 한 줄도 없다**(무시 규칙 확인).

## 검증 절차

1. **TDD red 실증**: `tests/main.cpp`에 실패 단언을 넣고 `build.bat`이 **비-0**으로 끝나는 것을 먼저 본다(출력에 실패 건수). 그다음 고쳐 green.
2. **변이 2종(게이트 비공허성)**:
   - M0-1 테스트 바이너리 실행 줄을 `build.bat`에서 제거 → 「테스트 총계 미출력」을 사람이 알아볼 수 있는가? 알아볼 수 없다면 **총계 문자열을 검사하는 줄을 build.bat에 넣어라**(예: `findstr`로 실패 0 확인). 원복.
   - M0-2 컴파일 에러를 심어 `build.bat`이 비-0으로 끝나는지 확인. 원복 후 `git diff`가 빈 것을 확인.
   - M0-3 `run.bat`의 PATH 줄에서 Qt `bin`을 빼고 실행 → **Qt DLL 부재로 앱이 뜨지 못하고 비-0**인가?(뜬다면 시스템 PATH에 다른 Qt가 있다는 뜻이다 — 그 사실을 요약에 적어라. 어느 Qt로 링크됐는지 모른 채 뒤 step을 진행하면 안 된다.) 원복.
3. 기준선 2회 실행 표를 요약에 남긴다(회차별 수치 · 차이 있으면 그 사실).

## 되돌림

`client-qt/`는 신규 디렉토리이므로 통째로 지우면 이 step 이전 상태다(다른 경로를 건드리지 않았다면). `.gitignore`에 추가한 묶음만 되돌리면 된다.

## 금지사항

- **`spikes/**`를 고치지 마라.** 이유: 그 디렉토리는 P0 go 판정의 증거이고 무접촉 자산이다. 필요한 것은 복사해 쓴다.
- **`build.bat`에 한글을 넣지 마라.** 이유: `cmd`가 배치 파일을 cp949로 파싱해 조용히 깨진다(스파이크 주석의 실측).
- **CMake로 갈아타지 마라.** 이유: 이 머신에서 성공한 적이 없고, P4가 사야 할 리스크가 아니다(`decisions` (1)).
- **Bash 명령줄에 비ASCII를 넣지 마라.** 이유: 이 환경에서 **exit 127**로 즉사한다. 한글 검색은 Grep 도구로, 파일 작성은 Write 도구로.
- **기능 코드를 쓰지 마라.** 이유: 이 step은 골격이다. 프로브·config·diag·net·화면은 각각 step2~11의 것이고, 여기서 먼저 쓰면 그 step들의 red 실증이 불가능해진다.
- **`git add -A`를 쓰지 마라.** 이유: 빌드 산출물(`release/`·`*.obj`·`Makefile`)이 통째로 실린다.
