# client-qt — Qt 네이티브 클라이언트 (로드맵 P4 · phase 77)

`docs/porting-plan-cpp-spring.md` §7 **P4 「C++ 클라 골격」** 의 산출물이다. Electron 셸 + 웹 SPA(`client/` + `web/`)를
대체할 네이티브 클라이언트를 여기에 세운다. **P4까지는 Electron 클라가 상시 대체재**이므로(로드맵 187행) 이 모듈이
동작하지 않아도 운영은 영향을 받지 않는다.

## 빌드 · 실행

```
cmd /c client-qt\build.bat        빌드(app + tests) 후 테스트 실행 — 실패하면 비-0 종료
cmd /c client-qt\run.bat          앱 실행(인자는 그대로 전달)
cmd /c client-qt\run.bat --selftest   CLIENT_SELFTEST=1과 똑같이 부팅(창 생성·diag 기록·표시 없음)한 뒤
                                      셸 불변식을 자기검사하고 이벤트 루프 없이 종료 — 통과 0 · 위반 1
```

- `--selftest`는 **실제 부팅과 같은 user-data 폴더를 쓴다**(`CLIENT_USER_DATA`가 없으면 `%APPDATA%\기사작성기-qt`를
  만든다). 하네스·검증은 언제나 `CLIENT_USER_DATA`로 임시 폴더를 준다. 같은 폴더를 쥔 인스턴스가 이미 떠 있으면
  자기검사를 돌리지 못했으므로 **exit 1**이다(돌지 않은 자기검사가 성공으로 보고되는 길을 막는다).

- **`run.bat`을 거치지 않고 `release\news-client.exe`를 맨 셸에서 실행하면 Qt DLL 부재로 즉사한다.** Qt는 동적
  링크이고 PATH에 `D:\agents\tools\Qt\6.8.3\msvc2022_64\bin`이 있어야 한다. Qt 경로의 정본은 **`env.bat` 한 곳**이고
  `build.bat`·`run.bat`이 그것을 `call` 한다. (자동 검증 드라이버만 exe를 직접 spawn하며, 같은 PATH를 자기가 싣는다.)
- 빌드 환경(MSVC · Windows SDK)은 `build.bat`이 명시 설정한다 — **이 머신은 VsDevCmd가 고장**이라
  `INCLUDE`/`LIB`/`PATH`를 직접 넣어야 `cl.exe`가 뜬다. 값은 P0 스파이크(`spikes/p0-qt-editor/build.bat`)가
  실증한 레시피의 복제다: MSVC `14.50.35717` · SDK `10.0.26100.0` · Qt `6.8.3 msvc2022_64`.
- **배치 파일은 전부 ASCII로 유지한다.** `cmd`가 배치를 cp949로 파싱하기 때문에 한글을 넣으면 조용히 깨진다.

## 디렉토리 규약

```
client-qt.pro   subdirs(app, tests)     — 두 타깃을 순차 빌드
common.pri      공통 소스/헤더 목록 · INCLUDEPATH · CONFIG(c++17) · QT 모듈
src/shell/      프로브 판정 · config · diag · 창 정책 · 단일 인스턴스 · 앱 셸   (step2~5)
src/net/        라우트 표 · 전송 · Model 인터페이스 · SSE        (step7~9)
src/ui/         서버 주소 설정 · 빈 메인 창(step5) · 로그인 · 목록(step10~11)
app/            TARGET = news-client        → client-qt/release/news-client.exe
tests/          TARGET = client-qt-tests    → client-qt/tests/release/client-qt-tests.exe
```

- **새 모듈은 `common.pri`의 `CLIENT_SOURCES`/`CLIENT_HEADERS`에 등록한다.** 앱과 테스트 러너가 항상 같은 코드를
  컴파일하게 하기 위해서다.
- **새 테스트 클래스는 `tests/main.cpp`의 `runTestClass<...>()` 한 줄로 등록한다.** 러너는 실행한 테스트 함수 수를
  세고 **0건이면 green을 거부**한다(exit 2).

## 이 트리에서 실측한 사실 (2026-09-10 · step0)

- **qmake `subdirs` 다중 타깃은 이 머신에서 실제로 선다.** 폴백(독립 `.pro` 2개 순차 호출)은 쓰지 않았다.
- **QtTest 자신의 PASS/FAIL 출력은 stdout이 리다이렉트되면 사라진다**(기본값도 `-o -,txt`도 동일 · 파일 로거는 정상).
  그래서 `tests/main.cpp`가 클래스마다 임시 파일 로거를 붙이고 그 내용을 자기 손으로 stdout에 다시 쓴다. 이 우회를
  걷어내면 `build.bat` 로그에 실패 건수만 남고 **어느 테스트가 깨졌는지 알 수 없게 된다**.
- 앱은 스파이크와 같이 **콘솔 서브시스템**으로 링크된다(`--selftest`가 셸에 결과를 찍어야 한다). 출시 바이너리의
  서브시스템·한글 제품명·아이콘·`windeployqt`·설치 패키징은 **P8(배포)의 결정**이지 P4가 아니다.

## 셸 모듈 이식 현황

| 모듈 | 정본 | Qt | step |
|---|---|---|---|
| 서버 주소·health 판정 | `client/lib/serverUrl.js` | `src/shell/serverurl.{h,cpp}` · 테스트 `tests/serverurltest.{h,cpp}` | step2 |
| 설정 파싱·직렬화(순수) | `client/lib/clientConfig.js` | `src/shell/clientconfig.{h,cpp}` · 테스트 `tests/clientconfigtest.{h,cpp}` | step3 |
| 설정 저장소(파일시스템 경계) | `client/lib/clientConfig.js` + `client/main.js`의 경로 결선 | `src/shell/configstore.{h,cpp}` · 테스트 `tests/configstoretest.{h,cpp}` | step3 |
| OS 가시 이름 상수 블록 | (정본에 대응 파일 없음) | `src/shell/appidentity.h` | step3 |
| 진단 JSONL(diag) | `client/diag.js` + `client/main.js`의 19개 호출 지점 | `src/shell/diag.{h,cpp}` · 테스트 `tests/diagtest.{h,cpp}` | step4 |
| 창 정책(순수 결정) | `client/lib/windowPolicy.js` 39-42·46-53·61-62 + `client/main.js` 263-277·367-377의 결정부 | `src/shell/windowpolicy.{h,cpp}` · 테스트 `tests/windowpolicytest.{h,cpp}` | step5 |
| 단일 인스턴스(잠금 + 알림) | `client/main.js` 55-63·81-89(`requestSingleInstanceLock` + `second-instance`) | `src/shell/singleinstance.{h,cpp}` · 테스트 `tests/singleinstancetest.{h,cpp}` | step5 |
| 프로브 주입 지점 | `client/main.js` 188-200(`probeOrigin`) | `src/shell/proberunner.{h,cpp}` · 테스트 `tests/proberunnertest.{h,cpp}` | step5 |
| 앱 셸(부팅·화면 수명·bounds 저장) | `client/main.js` 결선 전체(`wireApp`·`createAppWindow`·`showLocalWindow`·`saveBoundsFrom`·`persistConfig`) | `src/shell/appshell.{h,cpp}` · 테스트 `tests/appshelltest.{h,cpp}` | step5 |
| 화면 2개 · 테마 상수 | `client/pages/setup.html` · (앱 창은 원격 SPA라 대응 없음) | `src/ui/setupscreen.*` · `src/ui/mainwindow.*` · `src/ui/theme.h` | step5 |
| 합성 루트 | `client/main.js` 26-63 | `app/main.cpp` | step5 |

### `serverUrl` — 정본과의 의도적 이탈 (2026-09-10 · step2)

정본(`client/lib/serverUrl.js`)과 명세서(`test/client-shell-core.test.js`·`test/client-probe-origin.test.js`)는
**한 줄도 고치지 않았다**(읽기 전용). 아래는 관측 가능 동작이 정본과 다른 자리 전부다 — 조용한 「개선」은 다음
감사에서 회귀와 구분되지 않으므로 여기에 다 적는다.

1. **`appUrl(origin)`은 이식하지 않았다.** Electron 셸은 `${origin}/`을 `loadURL()`해 **서버가 서빙하는 SPA**를
   띄웠지만, 네이티브 클라는 자기 화면을 직접 그리므로 그 개념 자체가 없다. 함수를 남겨 두면 언젠가 내비게이션
   경로에 결선되어 「웹뷰로 가는 뒷문」이 생긴다.
2. **`http:/x`·`http:///x`는 `invalid`로 거부한다.** WHATWG는 특수 스킴의 슬래시를 접어 호스트 `x`를 **추론**한다
   (node로 실측: 둘 다 origin `http://x`). `QUrl`은 추론하지 않고 호스트 없는 URL로 둔다 — 이 포트는 추측 대신
   거부한다(fail-closed: 운영자가 치지 않은 호스트가 저장 주소가 되지 않는다).
3. **`no-host` reason은 산출되지 않는다.** 정본 계약의 5번째 reason이지만 정본에서도 **도달 불가**다(http/https에서
   호스트가 빈 입력은 `new URL()`이 전부 throw → `invalid`가 먼저 잡는다 — 실측). Qt에서 도달시키려면 정본이
   `invalid`로 답하는 입력을 다른 문자열로 답해야 해서, 도달 케이스를 만들지 않았다.
4. **`isSameOrigin`의 비특수 스킴 비교.** WHATWG는 `app://a`·`app://b`에 **불투명 origin 문자열 `"null"`**을 주므로
   정본은 서로 다른 두 `app://` URL을 **같은 출처로 판정**한다(실측). 이 포트는 실제 구성요소를 비교해 `false`를
   준다 — 호출부(외부 링크를 기본 브라우저로 여는 정책)가 원하는 방향이 fail-closed이기 때문이다.
   `ftp://h/x` vs `ftp://h/y`처럼 **같은 호스트면 정본과 동일하게 참**이다.
5. **비문자열 입력은 타입으로 소멸한다.** 정본이 `null`·`undefined`·`123`·`{}`·배열에 대해 잠근 동작은 C++
   시그니처(`const QString&` / `std::optional<QString>`)에서 표현 불가다. 대표로 **null `QString`**과
   **`std::nullopt`** 행만 남겼다.
6. **네트워크 실패 센티널은 `status < 0`이다**(정본은 `status`가 `null`/`undefined`). 전송 계층이 「HTTP 응답 자체가
   없음」을 음수로 사상해야 하며, **실제 HTTP status를 그 자리에 넣으면 안 된다**. `status == 0`은 http-status다.
7. **IPv4 옥텟 범위 검사가 없다.** `new URL('http://192.168.0.300:3001')`은 throw하지만(실측) `QUrl`은 평범한
   호스트명으로 받는다 — 이 포트는 QUrl의 관대함을 그대로 물려받는다(오타 주소는 프로브에서 unreachable로 죽는다).
   옥텟 검사는 secure-origin 규칙(step5)의 몫이지 이 모듈의 것이 아니다.
8. **trim 집합이 다르다.** `QString::trimmed()`와 JS `String.prototype.trim()`은 공백·탭·CR·LF에서 일치하지만
   BOM(U+FEFF) 등 이색 문자에서 갈린다(JS는 트림, Qt는 아님 — JS 쪽만 실측). 흔한 공백은 케이스로 잠갔다.

### `serverUrl` — 안전망 없는 규칙의 처분

포트 스펙이 「오늘 어떤 테스트로도 잠기지 않는다」고 지목한 3건의 처리다.

- **R8**(파싱 후 방어적 스킴 재검사) — 이식했다. 분기 자체는 여전히 **도달 불가**(스킴 보정이 http/https를 보장한다)
  이지만, 그 술어(`isAllowedScheme`)는 `resolveFinalOrigin`의 ftp·file·data·chrome-error 행이 공유해 잠근다.
- **R10**(`no-host`) — 위 이탈 3 참조. **미산출**이고 케이스도 없다.
- **R24**(`isHttpsOrigin`의 fail-open-to-general-rule) — **새 케이스로 잠갔다**: 요청 origin이 파싱 불가(`garbage`)
  이거나 빈 문자열이면 http 최종 URL이라도 **승격한다**. 이 헬퍼를 fail-closed로 뒤집는 변이(M2-3)가 red다.

### `serverUrl` — 이 모듈 밖으로 넘긴 계약

- **R26 — 승격은 성공 판정일 때만.** `resolveFinalOrigin`은 프로브 성공/실패를 스스로 판정하지 않는다. 호출부가
  `verdict.ok ? resolveFinalOrigin(...) : {요청 origin, changed=false}`로 갈라야 하며, 그 잠금은 **프로브 실행
  step(step5·step7)의 몫**이다(정본에서도 이 규칙은 순수 함수가 아니라 `client/main.js` 결선에만 있다).
  → **step5가 `shell::probeOrigin()`으로 이식해 행동 테스트로 잠갔다**(`promotesTheOriginOnlyOnASuccessfulProbe` · 변이
  M5-10). step7의 실제 러너는 이 함수를 거쳐 호출돼야 한다.
- **리다이렉트 최종 URL 관측 가능성은 미검증이다.** 정본조차 Electron 실왕복으로 검증한 적이 없다(phase 66 step4
  기록). Qt에서 `QNetworkReply::redirected`가 진짜 최종 URL을 주는지는 전송 계층 step이 **자기 손으로 실측**해야
  하고, 그 전에는 `resolveFinalOrigin`의 입력을 신뢰한다고 주장하면 안 된다.

### `clientConfig` — 사용자 데이터 폴더와 OS 이름 (2026-09-10 · step3)

**Qt 클라의 설정은 `%APPDATA%\기사작성기-qt\config.json`이다 — Electron 클라(`%APPDATA%\기사작성기`)와 분리한다.**
근거는 `index.json` decisions (11): 두 클라가 P8까지 공존하는데 같은 파일을 원자적으로 번갈아 덮어쓰면 「마지막에 쓴 쪽이
이긴다」가 되어 서로의 `serverUrl`·`bounds`를 지운다(rename은 원자적일 뿐 병합이 아니다).

- **OS에 보이는 이름은 `src/shell/appidentity.h` 한 블록에 모았다** — 폴더명 · 단일 인스턴스 mutex(`ArticleClientQt-SingleInstance`) ·
  `QLocalServer` 이름(`ArticleClientQt-Shell`) · env 이름(`CLIENT_USER_DATA`). 나중 감사가 「Electron 이름을 재사용했나」를
  **grep 한 번**으로 답할 수 있어야 하기 때문이다. 단일 인스턴스 결선 자체는 step5의 몫이고 이름만 여기 있다.
- 폴더명 리터럴은 **universal character name(`기…`)으로 적었다** — 이 파일을 ASCII로 유지해 어떤 도구도(cmd는 배치를
  cp949로, MSVC는 BOM/`-utf-8`이 없으면 시스템 코드페이지로 읽는다) 그 한 리터럴을 조용히 망가뜨릴 수 없게 한다.
- `CLIENT_USER_DATA`가 있으면 **절대 경로로 해석해 우선**한다(env 이름은 Electron 셸에서 승계). 하네스·테스트가 실사용자
  폴더를 건드리지 않는 유일한 수단이다. 값이 비었거나 공백뿐이면 무시하고 `%APPDATA%` 경로로 내려간다(프로세스 작업
  디렉토리에 쓰는 사고 방지).
- **세션ID·비밀번호·쿠키·토큰 필드는 없다**(정본 머리 CRITICAL · decisions (6)). 결과는 **재시작하면 재로그인**이고 그것은
  웹(1시간 지속 쿠키로 F5 복원)과의 **의도된 divergence**다.

### `clientConfig` — 설정 파일에 마이그레이션 경로가 **없다** (C-N1)

`parseConfig`는 파일의 `schemaVersion`을 **읽지 않는다**. 정본도 그렇다(`clientConfig.js:50`이 `defaultConfig()`로 현재
상수를 덮어쓰고, 41-58행 어디에서도 저장된 값을 보지 않는다). 따라서 `schemaVersion: 99`·`"corrupt"`·키 부재가 정상
버전과 **완전히 같게** 파싱된다 — **버전 검사도, 마이그레이션도, 미래 스키마 거부도 0**이다. 버전 상수는 **쓸 때만** 쓰인다.

「정본 어딘가에 마이그레이션이 있겠지」라고 찾지 마라. 없다. 반대로 Qt에서 버전 인지 처리를 새로 만들면 그것은 **정본
이탈**이므로 이 문서에 먼저 적어야 한다. 이 사실은 `ignoresTheStoredSchemaVersion` 테스트가 잠근다.

### `clientConfig` — 정본과의 의도적 이탈 (2026-09-10 · step3)

정본(`client/lib/clientConfig.js`)과 명세서(`test/client-shell-core.test.js`)는 **한 줄도 고치지 않았다**(읽기 전용).

1. **폴더가 다르다**(위 절). 스키마·파일명(`config.json`)·화이트리스트·원자적 쓰기 규율은 **동일 이식**이다.
2. **읽기 함수는 동기 1개뿐이다.** 정본의 `readConfigFile`(async)/`readConfigFileSync` 이중화는 「Chromium 초기화 전에
   동기로 읽어야 한다」는 Electron 제약의 산물이다(R13). Qt에는 그 제약이 없어 `loadConfig` 하나만 만들었다.
3. **`configPath`는 던지지 않는다.** 정본 `configPath`는 이 모듈에서 유일하게 throw할 수 있는 export다(`path.join`에
   비문자열 · C-N4). 이 포트는 빈/공백 디렉토리에 **빈 경로**를 돌려주고, `saveConfigAtomically`가 그것을 **실패 결과**로
   거른다(`CLIENT_USER_DATA`가 빈 문자열로 풀리는 실제 경로가 있다).
4. **`serializeConfig`의 「쓰레기 인자」는 타입으로 소멸한다**(C-N3). C++ 시그니처에 비객체를 넘길 방법이 없으므로, 대응
   보증은 「기본 구성 구조체·반쯤 채운 구조체도 기본 shape로 강등되고 실패하지 않는다」로 잠갔다.
5. **C-N5(옵션 인자 구조분해)는 이식하지 않았다.** 「`undefined`에서 구조분해하면 try 밖에서 throw」는 C++에 대응 개념이
   없다 — 포트 스펙의 판정도 「기록만 하고 이식하지 마라」다.
6. **int 범위를 벗어난 정수는 거부한다.** JS `Number.isInteger(1e12)`는 true라 정본은 통과시키지만, Qt 지오메트리는 int이고
   표현할 수 없는 값은 사각형이 아니다. `1e12`가 red인 케이스를 뒀다.
7. **직렬화 형식**: `QJsonDocument`가 키를 **알파벳 순**으로, 들여쓰기 **4칸**으로 쓴다(정본은 삽입 순서 · 2칸). 두 클라가
   파일을 공유하지 않으므로 호환 축이 아니고, 테스트가 잠근 계약은 **키 집합**과 **후행 개행 정확히 1개**다(후행 개행은
   `QJsonDocument::toJson()`의 동작에 기대지 않고 직접 붙인다 — 가장 조용히 사라지는 항목이다).
8. **덮어쓰기 rename은 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`이다.** `QFile::rename()`은 대상이 있으면 **거부**해서
   두 번째 저장이 실패한다. `QSaveFile`을 쓰지 않은 이유는 임시 파일 이름과 호출 순서를 **관측·주입할 수 없어** M3-2 변이
   (직접 덮어쓰기)를 잡지 못하기 때문이다.
9. **쓰기 실패 시 정리·재시도가 없다**(정본 동형). 남은 `config.json.tmp`는 다음 저장이 truncate로 덮는다.

### `clientConfig` — 안전망 없는 규칙의 처분

포트 스펙이 「오늘 어떤 테스트로도 잠기지 않는다」고 지목한 5건 + 간접 1건의 처리다.

- **R11**(폴더 분리 — 최고 위험) — **새 케이스로 잠갔다**: `namesAreDistinctFromTheElectronShell`(이름 축)과
  `fallsBackToItsOwnAppDataFolder`(경로 산술 축). 폴더명을 Electron 것으로 되돌리는 변이(M3-3)가 두 테스트에서 red다.
- **C-N1**(읽을 때 schemaVersion 무시) — 위 절 · `ignoresTheStoredSchemaVersion`으로 잠갔다.
- **C-N3**(쓰레기 인자 직렬화) — 이탈 4 · `serializesDegradedInputWithoutFailing`으로 잠갔다.
- **C-N4**(`configPath`만 throw 가능) — 이탈 3 · `buildsTheConfigPath`의 빈/공백 행과
  `rejectsAnEmptyDirectoryWithoutTouchingTheFilesystem`으로 잠갔다.
- **C-N5**(옵션 인자 구조분해) — 이탈 5 · **미이식**(케이스 없음).
- **R16**(구조 검증과 화면 검증의 분리 — 정본에도 이 분리 자체를 단언하는 테스트가 없다) —
  `separatesTheShapeCheckFromTheScreenCheck`가 「화면 밖 사각형이 파싱은 통과하고 `sanitizeBounds`에서만 떨어진다」로 잠갔다.

### `clientConfig` — 이 모듈 밖으로 넘긴 계약

- **최소 크기 상수는 2개이고 통합하지 않는다**(포트 스펙 X5). 이 모듈의 **저장 하한은 800×600**(`kMinStoredWidth/Height`)이고,
  **창 최소 크기 1024×720**은 step5(`windowPolicy` 대응)의 것이다. 저장된 **850×650이 이 검증을 통과하는 것이 정상**이다.
- **`workArea` 교차 판정(`sanitizeBounds`)은 이 step이 실행하지 않는다.** 파싱 시점에는 모니터 구성을 모른다는 이유로 정본이
  분리한 함수이고, 창 복원에서 **step5가 호출**한다. `QRect::intersects()`를 쓰지 않고 정본의 네 부등식을 그대로 적었다
  (`x+width-1` 관례가 모서리에서 답을 바꾼다).
- **쓸 때 `serverUrl`을 재정규화하지 않는다**(정본 R7 동형). 호출부(step5의 주소 저장 경로)가 `normalizeServerUrl`의 결과만
  넘기고, **읽을 때 재검증**(R4)이 손편집 파일에 대한 이중 방어다.

### `diag` — 이벤트 처분 표 (확정 · 2026-09-10 · step4)

**이 표가 P4의 경계다.** `shell::allowedDiagEvents()`가 아래 **21개 이름**을 상수 집합으로 들고 있고, `Diag::log()`는
집합 밖 이름을 **거부한다**(줄을 쓰지 않고 `rejectedEventCount()`를 올린 뒤 경고한다). 이름을 늘리려면 그 파일을
고쳐야 하고, 그 diff가 곧 「범위가 넓어졌다」는 신호다. `tests/diagtest.cpp`의 `allowsExactlyTheDispositionTable`이
집합 전체를, `refusesToWriteAnEventOutsideTheAllowedSet`이 거부 동작을 잠근다.

step4.md의 4갈래 제안을 **그대로 확정**했다(변경 0). 근거: `docs/porting-plan-cpp-spring.md` 152행이 「이벤트
이름·필드 유지 + 렌더러 계열 4이벤트만 재매핑」을 포팅 조건으로 적었고, 이름을 바꾸면 판정 어휘를 새로 배워야 하는
비용만 늘 뿐 얻는 것이 없다.

| 갈래 | 수 | 이벤트 (네이티브에서의 의미 · P4의 payload 계약) |
|---|---|---|
| **승계** | 8 | `app-ready` · `config-loaded{hasServerUrl}` · `config-saved{origin}` · `probe{origin,ok,reason}` · `second-instance` · `setup-shown{reason}` · `restart-required{origin}` · `window-open{url,action}`(외부 링크를 기본 브라우저로) |
| **재매핑** | 4 | `app-window` = 메인 창 표시 · `local-window{page}` = 설정/오류 화면 · `did-finish-load` = **화면 준비 완료**(정본의 `title` 필드는 싣지 않는다 — C절) · `load-failed{errorCode}` = 서버 도달 실패 |
| **소멸** | 6 | `secure-origin-switch` · `navigation` · `ipc` · `render-process-gone` · `unresponsive` · `did-navigate` — **집합에 없다.** 렌더러 프로세스·Chromium 커맨드라인 스위치·contextBridge가 없는 앱에서 이 이름을 쓰면 판정자가 **일어나지 않은 일을 읽는다**. 대체 관측이 필요하면 **새 이름**을 만든다(`ipc` → `net-request`) |
| **신설** | 9 | `net-request{route,method,status,ms}` · `login{status}` · `session{status}` · `sse-open` · `sse-ready` · `sse-change{kind}` · `sse-unauthorized` · `sse-closed{reason}` · `list-loaded{menu,count}` |

**신설 9개는 필드 화이트리스트가 코드로 강제된다**(`contractedFields()`): 표에 없는 필드는 조용히 버려진다. 승계·재매핑
12개는 정본과 같이 열린 payload를 쓰되 아래 유출 규칙 전부를 통과한다.

### `diag` — 유출 방지 규율 (step4.md C절의 기계화)

1. **정본 금지 키 7종**(`body`·`sessionId`·`cookie`·`cookies`·`password`·`token`·`headers`)은 **대소문자 정확 일치**로
   버린다(정본 R3 그대로 — `Set.has()`의 의미론). 따라서 `Token`·`Body`는 **정본과 똑같이 통과한다**;
   `matchesForbiddenKeysCaseSensitively`가 그 사실을 잠근다. 대소문자 무시로 「개선」하면 정본과 다른 필터링 결과가
   나오므로 하지 않았다 — 실제 보증은 4번(호출부 규율)이다.
2. **기사 제목·본문·사용자 이름 금지**(이 포트가 새로 만든 규칙이므로 **대소문자 무시**): `title`·`content`·`text`·
   `name`·`username`. 그래서 재매핑된 `did-finish-load`는 정본이 싣던 `title`을 **싣지 않는다**. 목록은 `count`만 적는다.
3. **`route` 값 검사**: 라우트 id(`articles-get`) 또는 경로 템플릿(`/api/articles/:id`)만 통과하고, 구체 기사아이디가
   들어간 경로(`/api/articles/42`)는 **`<invalid-route>`로 대체**된다. 정본이 쿼리를 지운 이유와 같은 축이다.
4. **가장 중요한 규율은 필터가 아니라 호출부다**(정본 주석 `diag.js:7-8` · 포트 스펙 D-N3). 금지 키 7종 **밖의** 필드로
   본문이 새는 것을 막는 것은 「payload를 언제나 명시 리터럴로 구성한다」는 상위 규칙이며, **응답/요청 객체를 통째로
   넘기는 API를 만들지 마라.** `Diag::log`가 `QVariantMap`만 받는 것이 그 규율의 타입 수준 표현이다.

### `diag` — 정본과의 의도적 이탈 (2026-09-10 · step4)

정본(`client/diag.js`)과 명세서(`test/client-shell-main.test.js`)는 **한 줄도 고치지 않았다**(읽기 전용).

1. **`formatDiagLine`은 `QByteArray`(UTF-8)를 돌려준다.** step4.md의 스케치는 `QString`이었지만, 이 함수의 계약은
   **바이트**(UTF-8 · `\n` 하나 · CRLF 금지)이므로 쓰는 시점에 인코딩이 암묵적으로 결정되지 않게 했다.
2. **payload 필드 순서는 키 순서다.** `QVariantMap`은 `QMap`이라 정렬된다(정본은 JS 객체의 삽입 순서). `ts`→`event`는
   **언제나 앞 두 자리**이고(줄을 손으로 조립한다 — `QJsonObject`를 쓰면 `ts`조차 알파벳 순으로 밀린다), 판정자는 JSON
   파서를 쓰므로 순서 의존이 없다. AC의 비교 대상인 `{ok,url}`은 두 규칙에서 같은 순서가 된다.
3. **`about:blank`·`file:` 분기는 이식했지만 실호출부가 없다.** 전자는 Chromium이 `window.open()` 대상에 주는
   placeholder이고 후자는 `loadFile()`로 로컬 HTML을 여는 개념이다 — 네이티브에는 둘 다 없다. AC가 케이스를 요구하고
   순수 함수의 계약이므로 남겼다.
4. **호스트 없는 http/https(`http:/x`)는 `"http:"`로 답한다.** WHATWG는 슬래시를 접어 호스트 `x`를 **추론**하지만
   `QUrl`은 추론하지 않는다(step2의 같은 divergence). 원문을 fail-open으로 돌려주면 **쿼리가 살아남는 유일한 경로**가
   생기므로, 그 자리는 스킴만 남기는 쪽(최대 리댁션)으로 정했다.
5. **`QByteArray` 값은 문자열로 취급한다.** C++에서 문자열 리터럴이 가장 쉽게 실려 오는 형태이고, 버리면 다음 step들이
   **조용히 필드를 잃는다**. UTF-8로 디코드해 넣는다.
6. **`undefined`는 「키 부재」로, `QVariant()`(무효)는 `null`로 매핑한다.** 정본의 두 값 구분에 대응하는 C++ 표현이
   없다 — 부재는 폐기(정본 동형), 무효 QVariant는 출력에 `null`로 남는다(정본 R6 동형).
7. **R13·D-N1은 타입으로 소멸한다.** 정본은 payload가 배열이면 가드를 통과해 **인덱스가 필드처럼 새어나가고**
   (`typeof [] === 'object'`), 비객체면 `{}`가 된다. `QVariantMap` 시그니처에는 그 두 입력이 **표현 불가능**하므로
   방어를 따로 넣지 않았다(정본의 누출 동작도 재현되지 않는다).
8. **`redactDiagEvent`는 `event` 인자를 실제로 쓴다**(정본은 받기만 하고 쓰지 않는다) — 신설 9 이벤트의 필드
   화이트리스트를 고르는 데 필요하다.
9. **`log()`는 허용 집합 밖 이름을 거부한다**(정본에는 그런 게이트가 없다). R18을 코드로 세운 자리이고, 거부는
   `rejectedEventCount()`로 관측된다. 이 검사는 **diag가 꺼져 있을 때도** 돈다(경고는 남는다).
10. **`ts`/`event` 덮어쓰기(R2)는 정본대로 재현했다** — payload가 이긴다. 21개 payload 계약 중 그 이름을 쓰는 것이
    없고, 신설 9 이벤트는 필드 화이트리스트가 기계로 막는다.
11. **경로 문자열은 trim한다**(`Diag`의 생성자 · `CLIENT_DIAG_FILE`이 공백으로 풀리는 실제 경로가 있다 — configstore와
    같은 처리). 정본은 falsy 검사뿐이다.

### `diag` — 안전망 없는 규칙 12건의 처분

포트 스펙이 「오늘 어떤 테스트도 잠그지 않는다」고 지목한 12건 중 **10건을 새 케이스로 잠갔다**(X7 — 정본에 없는
커버리지를 만드는 것은 동작 변경이 아니다).

| 규칙 | 처분 | 잠근 케이스 |
|---|---|---|
| R2 payload의 `ts`/`event` 덮어쓰기 | **잠금** | `letsThePayloadOverrideTsAndEvent` |
| R4 `cookies`·`headers` 드롭(호출부·테스트 전무) | **잠금** | `dropsEveryForbiddenKey(cookies)`·`(headers)` |
| R6 `null` 값 통과 | **잠금** | `keepsNullAndOmitsAbsentFields` |
| R9 `redactUrl` fail-open | **잠금** | `matchesTheCanonicalRedaction(not a url · relative · empty)` |
| R12 기타 스킴은 **콜론 포함** 스킴만 | **잠금** | 같은 표의 `mailto`·`ftp`·`data`·`chrome-error` 행 |
| R16 동기 append | **잠금(관측 가능한 범위)** | `appendsEachLineBeforeLogReturns` — `log()`가 반환한 시점에 이미 디스크에 있다 |
| R17 디렉토리 미생성 → 무음 실패 | **잠금** | `swallowsWriteFailuresOnAMissingDirectory`(디렉토리도 만들지 않는다) |
| R18 이벤트 이름 집합 | **잠금** | `allowsExactlyTheDispositionTable` + `refusesToWriteAnEventOutsideTheAllowedSet` |
| R19 소멸 6종 | **잠금** | `keepsTheExtinctElectronEventsOut` |
| D-N2 NaN/Infinity → `null` | **잠금(실측 후)** | `writesNonFiniteNumbersAsNull` |
| D-N1 최상위 배열 payload | **미잠금 — 타입으로 소멸**(이탈 7) | 없음(표현 불가) |
| D-N3 호출부 명시 구성 규율 | **미잠금 — 규율은 호출부에 있다** | 부분 기계화(신설 9의 필드 화이트리스트 + 사람 텍스트 키 차단). 실호출부는 step5·7·10이 만든다 |

부분 잠금이던 4건도 넓혔다: **R3**(정본 5종 → 7종 전건 + 대소문자 민감성) · **R5**(object/array → 12개 타입 행) ·
**R7**(`url` 키 → `hourly`·`imageUrl`·`URL`로 substring-vs-suffix 경계) · **R13**(`undefined`만 → 부재 키/무효 QVariant).

### `diag` — 정본 바이트 대조 (실측 · 2026-09-10)

```
node --input-type=module -e "import('./client/diag.js').then(({formatDiagLine})=>console.log(formatDiagLine('probe',{ok:true,url:'http://h:3001/api/health?x=1'},0)))"
{"ts":"1970-01-01T00:00:00.000Z","event":"probe","ok":true,"url":"http://h:3001/api/health"}
```

**C++ 출력은 바이트 단위로 같다.** `matchesTheCanonicalProbeLineByte`가 그 비교를 테스트로 들고 있고, 같은 케이스가
`qInfo`로 두 줄(`canonical:` / `qt      :`)을 **빌드 로그에 매번 찍는다** — 감사자가 이 문서를 믿지 않아도 되도록.
URL 리댁션 17행(위 표의 케이스들)도 전부 정본을 직접 실행해 얻은 값이며, 소스를 읽고 옮겨 적은 값이 아니다.

**형식 상호운용도 실측했다**: C++가 쓴 diag 파일을 `scripts/verify-client.mjs`의 `readDiag`(94행)와 **같은 방식**으로
(`split('\n')` → `filter(Boolean)` → `JSON.parse`) node로 읽어 **전 줄 파싱 · 전 줄 `event`·`ts` 보유 · CR 0바이트**를
확인했다. 같은 판정을 `writesLinesTheJudgeCanParse`가 QtTest 안에서 상시 반복한다.

### `appShell` — 부팅 순서와 두 부팅 경로 (2026-09-11 · step5)

`app/main.cpp`는 **얇은 합성 루트**다: user-data 폴더를 해석하고, 잠금 가드·diag·설정 파일시스템·프로브 러너·
workArea 공급원을 만들어 `shell::AppShell`에 **주입**한 뒤 이벤트 루프를 돈다. 결정은 전부 `src/shell`에 있고,
화면(`src/ui`)은 받은 데이터를 그리고 신호만 낸다(전역·싱글턴에서 의존성을 꺼내지 않는다 — ADR-003의 정신).

```
(0) user-data 폴더 해석 — CLIENT_USER_DATA가 있으면 그것, 없으면 %APPDATA%\기사작성기-qt   (R1 · W-N3)
(1) 잠금 가드(이름은 (0)의 폴더에서 파생) — 두 번째 실행이면 노크만 하고 exit 0              (R2)
(2) user-data 폴더 생성 → app-ready → 설정 1회 읽기 → config-loaded{hasServerUrl}
(3) serverUrl ? app-window{origin} : local-window{page:setup} → setup-shown{reason:no-config}
    — 부팅 경로에 probe 없음(프로브는 사용자 액션에만)
```

실측 diag 원문(`run.bat` 경유 · `CLIENT_SELFTEST=1` · 임시 폴더):

```
A  {"event":"app-ready"} → {"event":"config-loaded","hasServerUrl":true} → {"event":"app-window","origin":"http://127.0.0.1:3001"}
B  {"event":"app-ready"} → {"event":"config-loaded","hasServerUrl":false} → {"event":"local-window","page":"setup"}
   → {"event":"setup-shown","reason":"no-config"}
```

- **B의 순서는 정본을 따른다(`local-window` → `setup-shown`).** `client/main.js:338-339`가 그 순서로 쓰고, 판정자
  (`scripts/verify-client.mjs:293-303`)는 둘의 상대 순서를 고정하지 않는다(`local-window`는 별도 시퀀스로 존재만 본다).
  step5.md 검증 절차 2-B의 산문은 `setup-shown` → `local-window`로 적었지만 X4(코드 > 계획 산문)로 코드를 따랐다.
- **닫을 때의 bounds 저장은 `config-saved`를 남기지 않는다.** step5.md 배경 4는 「창을 닫을 때 bounds 1회 저장
  (`config-saved`)」으로 적었지만, 정본 `saveBoundsFrom()` → `persistConfig()`는 **조용히** 쓰고 `config-saved{origin}`은
  **주소 저장**(`saveServer`)에서만 남긴다(`main.js:136-137`). X4로 코드를 따랐다.
- **`CLIENT_SELFTEST=1`**(값이 정확히 `"1"` — `main.js:28`): 창은 **생성**되고 diag도 전부 쓰이지만 **표시하지 않는다**.
  그래서 `shown`이 영영 거짓이라 bounds도 저장되지 않는다(R10). 보안 경계가 아니라 사고 방지 장치다(ADR-018 ②).

### 단일 인스턴스 — 잠금과 알림을 따로 만들었다 (R-instance-ipc)

Electron `requestSingleInstanceLock()`은 **배타 잠금 + 두 번째 실행 알림**을 한 번에 준다. Qt에는 둘 다 없어 분리했다.

| 기능 | 수단 | 이름 |
|---|---|---|
| 배타 잠금 | Windows named mutex(`CreateMutexW` · `ERROR_ALREADY_EXISTS` = 이미 누가 쥠) — 핸들이 살아 있는 동안이 잠금이고, 프로세스가 죽으면 OS가 치운다(잔류 잠금 없음) | `Local\ArticleClientQt-SingleInstance-<digest>` |
| 두 번째 실행 알림 | 잠금 보유자가 `QLocalServer`(사용자 한정 접근)를 연다. 두 번째 실행은 `QLocalSocket`으로 붙었다 끊는다 — **연결 자체가 메시지** | `ArticleClientQt-Shell-<digest>` |

- **`<digest>` = 해석된 user-data 폴더의 SHA-256 앞 16 hex**(구분자·`.`·끝 슬래시 정규화, 대소문자 접기 — Windows 경로는
  대소문자 무시). 정본 잠금 키가 userData에서 파생되는 것(`main.js:6-7`)과 **같은 범위**다: 임시 `CLIENT_USER_DATA`로 뜬
  하네스는 실사용자의 클라와 잠금을 다투지도, 그 창을 앞으로 끌어내지도 않는다. 그래서 **폴더 해석이 잠금보다 먼저**다
  (R1) — `main.cpp`에서 가드는 폴더 문자열로부터만 만들어지므로 순서를 뒤집을 수 없다.
- 기반 이름 두 개는 `src/shell/appidentity.h` 한 블록에 있고 **Electron 이름이 아니다**(R13 — 두 클라를 나란히 띄워 대조).
- **두 번째 실행은 노크 외에 아무것도 하지 않는다**(R2): 폴더 생성·설정 읽기·diag 한 줄·창 전부 0. 실측 163 ms에 exit 0,
  첫 인스턴스 diag에 새로 생긴 줄은 `second-instance` **한 줄뿐**이었다.
- **첫 인스턴스**는 `second-instance`를 남기고, SELFTEST면 창을 건드리지 않으며, 아니면 앱 창(없으면 설정 화면)을 앞으로
  가져온다 — **최소화일 때만** 최소화 비트를 풀고(R3), 그다음 `show` · `raise` · `activateWindow`.
- **알려진 한계**: 두 실행이 **같은 순간** 뜨면 이긴 쪽이 `listen()` 하기 전에 진 쪽이 노크할 수 있다 — 진 쪽은 노크 실패를
  무시하고 exit 0(잠금이 이미 1차 인스턴스의 존재를 증명했으므로 잃는 것은 「창을 앞으로」 한 번이다). 재시도 루프는
  두지 않았다(ADR-008 — 앱 내 주기 작업 금지).

### 창과 bounds — 정본 계약의 「살아 있는 창」 절반

정본은 bounds 계약의 **순수 절반**(`sanitizeBoundsShape`·`sanitizeBounds`·`buildWindowOptions`)만 테스트로 잠갔고, 살아
있는 창 절반(`createAppWindow`·`saveBoundsFrom`·second-instance 핸들러)은 BrowserWindow가 필요해 **무잠금**이었다. 이
포트는 그 결정을 `src/shell/windowpolicy.*`의 순수 함수로 끌어내고, 결선은 `AppShell`에 가짜를 주입해 잠갔다.

- **복원 = all-or-nothing.** 저장된 사각형이 **어느 workArea와도 겹치지 않으면 bounds 전체(위치 + 크기)를 버리고**
  기본 1440×900으로 연다(`clientConfig.js:82`). 겹침은 **엄격 부등호**(모서리만 닿으면 겹침 아님) — 판정은 step3의
  `sanitizeBounds` 하나이고, 복원 경로가 그것을 **실제로 부르는지**를 `opensAtTheDefaultsWhenNoWorkAreaHoldsTheStoredBounds`가
  잠근다(위치를 받지 못한 창은 `WA_Moved`가 거짓 — `move(0,0)` 같은 센티널을 쓰지 않았다는 증거).
- **최소 크기 상수는 2개이고 통일하지 않는다**(X5): 저장 검증 하한 **800×600** vs 창 최소 **1024×720**. 저장된 850×650은
  검증을 **통과**한 뒤 창에서 **1024×720으로 조용히 clamp**된다(W-N1). `setMinimumSize`를 크기보다 **먼저** 부른다. 밴드
  7행(850×650 · 800×600 · 1023×719 · 한 축만 밴드 2행 · 경계·상한 대조군 2행)을 새로 잠갔고, 두 상수를 합치면
  `appshell.cpp`의 `static_assert`가 **컴파일을 막는다**.
- **생성 후 최대화**(R8): 저장된 normal 사각형으로 만든 뒤 `maximized`면 `showMaximized()` — 최대화된 창 밑에 normal
  사각형이 남는다.
- **저장은 `normalGeometry()`**(R9 — `getNormalBounds()` 대응): 최대화 상태로 닫혀도 normal 사각형 + `maximized:true`를
  저장한다. **포트 스펙이 「가정하지 말고 재라」고 한 stale/0 사각형 함정은 이 타깃(Windows · Qt 6.8.3)에서 재현되지 않았다** —
  QtTest 바이너리를 **실 windows QPA**로도 1회 돌려(기본은 offscreen) 최대화 캡처 케이스가 green이었다(2026-09-11). 만일
  빈 사각형이 오면 `capturedBounds`가 무효로 만들고, 아래 W-N2 규칙이 직전 값을 지킨다.
- **화면에 뜬 적 없는 창은 저장하지 않는다**(R10) · **저장은 닫을 때 1회**(R11 — resize/move 훅 없음. 리사이즈·이동을 여러
  번 해도 쓰기 0, 닫으면 정확히 1회를 행동으로 잠갔다) · **쓰기 실패는 삼키고 창은 닫힌다**(R12 — 표준 오류에 경고 1줄).
- **닫는 시점 검증 실패 = 이전 값 유지 후 그대로 기록 — 정본 재현으로 결정했다**(W-N2). `main.js:371-373`에는 `else`가
  없다: 모니터를 뗀 뒤 닫혀 지금 사각형이 어느 workArea와도 안 겹치면, 부팅 때 읽은(또는 마지막으로 통과한) 값을 **그대로
  다시 쓴다** — null로 리셋하지도 새(무효) 위치를 쓰지도 않는다. 근거: 사용자가 마지막으로 **보이게** 둔 배치를 잃지 않는
  쪽이 fail-safe이고, 리셋은 정본에 없는 새 동작이다.

### 프로브 — 주입 지점만 있다. **연결 확인은 step7에서 실제 HTTP로 붙는다**

- `shell::ProbeRunner`가 주입 지점이고, step5의 합성 루트는 **`UnimplementedProbeRunner`**를 넣는다: 요청을 **보내지
  않고** 항상 `{ok:false, reason:"unreachable"}`을 돌려준다. **성공한 척하지 않는다.** 그 사실은 러너의
  `limitationNotice()`가 설정 화면 하단에 **경고색으로 그대로 표시**한다 — 실제 러너(step7)가 주입되는 날 문구가 저절로
  사라지도록 화면이 아니라 러너가 그 문장을 소유한다.
- `shell::probeOrigin()`이 정본 `probeOrigin`(`main.js:188-200`)의 이식이고, 정본에서 `main.js` 텍스트 스캔으로만 잠겨
  있던 **R26**(승격은 **성공 판정일 때만** — 캡티브 포털·오류 페이지로의 리다이렉트가 저장 주소를 바꾸지 못하게)을 행동
  테스트로 잠갔다. diag는 `probe{origin, ok, finalOrigin, promoted[, reason]}` 한 줄(정본 필드 그대로).
- 부팅 경로는 프로브를 부르지 않는다(A·B 실측 모두 `probe` 0줄). 프로브는 [연결 확인] 버튼에서만 돈다.

### `appShell` — 정본과의 의도적 이탈 (2026-09-11 · step5)

정본(`client/main.js`·`client/lib/windowPolicy.js`·`client/lib/clientConfig.js`)과 명세서(`test/**`)는 **한 줄도 고치지
않았다**(읽기 전용).

1. **[저장]은 프로브 없이 정규화 통과만으로 저장한다**(step5.md D의 결정). 정본 `saveServer`는 **먼저 프로브하고 성공한
   판정의 최종 origin만** 저장한다(`main.js:129-134` — 「실패한 주소는 저장하지 않는다」). 러너가 미구현이라 정본 순서로는
   저장이 영영 불가능하기 때문이며, **step7이 실제 러너를 붙일 때 정본 순서(프로브 성공 → 최종 origin 저장 · R26)로 되돌려야
   한다.** 설정 화면 경고문이 이 사실도 함께 적는다.
2. **잠금 = named mutex + `QLocalServer`, 알림 = 연결 자체.** Electron은 두 번째 실행의 argv/cwd를 실어 보내지만 정본이
   쓰지 않으므로(`main.js:81`) 싣지 않았다.
3. **최소화 복원은 `setWindowState(state & ~WindowMinimized)`다 — `showNormal()`이 아니다.** Electron `restore()`는
   최소화 이전 상태로 돌아가지만 Qt `showNormal()`은 그 밑의 최대화까지 푼다. 포트 스펙 R3의 대응 스케치(`if (isMinimized())
   showNormal()`)를 그대로 쓰면 「최대화 상태에서 최소화한 창」이 되살아날 때 최대화가 풀린다(변이 M5-3a가 red).
4. **bounds 사각형은 창 프레임 제외(클라이언트 영역)다.** Electron bounds는 프레임 포함이다. 저장은 `normalGeometry()`,
   복원은 `setGeometry()`로 **둘 다 프레임 제외**라 왕복이 일치한다 — `resize()`+`move()`로 복원하면 `move()`는 프레임
   위치라 **재시작마다 창이 제목 표시줄 높이만큼 내려간다.** 두 클라는 파일을 공유하지 않으므로 호환 축이 아니고, workArea
   겹침도 클라이언트 사각형으로 판정한다(바깥 사각형보다 몇 픽셀 작다 — 실무상 무의미).
5. **「크기만 있고 위치 없는 bounds」는 표현할 수 없다**(R5 일부 타입 소멸). 유효한 `Bounds`는 네 정수를 모두 가져야
   통과하므로(`sanitizeBoundsShape`), 위치 부재 경로는 「bounds 없음 = 기본값」에서만 생긴다. 그 경로가 창을 **옮기지 않는다**는
   것을 `WA_Moved`로 잠갔다.
6. **부팅 시 user-data 폴더를 만든다.** Electron은 Chromium이 userData를 시작 시 만든다 — Qt에는 그 주체가 없어 `AppShell`이
   잠금을 쥔 **직후** 만든다(두 번째 실행은 만들지 않는다). 결과: 운영 첫 부팅은 빈 `%APPDATA%\기사작성기-qt`를 만든다
   (Electron의 첫 부팅과 같다). 하네스 diag 파일이 그 폴더 안에 있으므로(`verify-client.mjs:208-209`) 폴더가 없으면
   diag가 조용히 사라진다(diag는 폴더를 만들지 않는다 — step4 R17).
7. **`app-window` payload는 `{origin}`이다**(정본 `{url: appUrl(origin)}` — `appUrl`은 R13 소멸). 앱 창 표시에서
   `did-finish-load`는 남기지 않는다(원격 SPA 로드 개념이 없다 — Qt 부팅 시퀀스의 판정 어휘는 step6이 정한다).
8. **`restart-required`는 발생하지 않는다.** 원인(secure-origin 스위치)이 네이티브에서 소멸했다(ADR-018 ⑤).
9. **mutex 생성 자체가 실패하면(예: 같은 이름의 다른 종류 커널 객체) 경고 후 가드 없이 부팅한다.** 막아서 못 뜨게 하는 오탐보다
   낫다는 ADR-012(서버 잠금)의 선택을 따랐다. `ERROR_ALREADY_EXISTS`(= 진짜 두 번째 실행)와는 다른 경로다.
10. **메뉴(서버 변경 · 다시 연결 · 정보)는 이 step 범위 밖이다.** 그래서 주소를 한 번 저장하면 **화면 안에서 설정 화면으로
    돌아갈 길이 없다**(`config.json`을 지우거나 `CLIENT_USER_DATA`로 새 폴더를 주는 수밖에 없다). 어느 step이 소유할지
    계획에 없다 — step12 `forward_notes` 후보.
11. **`--selftest`는 정본에 대응물이 없다.** CLIENT_SELFTEST 부팅 + 불변식 자기검사(부팅 후 잠금 보유 · 잠금 이름이 폴더에서
    파생 · 화면 정확히 1개이고 부팅 판정과 일치 · 창 비표시 · 부팅 중 프로브 0 · diag 거부 0 · 셸 어휘 ⊂ step4 허용 집합).

### `appShell` — 안전망 없는 규칙 11건의 처분

포트 스펙 §6이 창/bounds/단일 인스턴스 축에서 「오늘 어떤 테스트로도 잠기지 않는다」고 지목한 11건 — **11건 전부 새 케이스로
잠갔고, 각각 변이로 red를 실증했다.**

| 규칙 | 잠근 케이스 | 변이 |
|---|---|---|
| R3 최소화일 때만 복원 · SELFTEST는 기록만 | `restoresOnlyAMinimizedWindow`(5행) · `bringsAMinimizedWindowBackWithoutUnmaximizingIt` · `leavesAMaximizedWindowMaximizedWhenActivated` · `recordsASecondInstanceWithoutTouchingWindowsUnderSelftest` | M5-3a · M5-3b |
| R-instance-ipc 잠금 + 알림 분리 | `grantsTheLockToExactlyOneGuard` · `releasesTheLockWithItsHolder` · `carriesASecondLaunchToThePrimary` · `failsQuietlyWhenNobodyListens` · `aSecondShellOnTheSameFolderOpensNoWindow` | M5-1a · M5-1b |
| R8 생성 후 최대화 | `startsMaximizedOnlyWhenTheStoredBoundsSaySo` · `restoresTheStoredRectangleThenMaximizes` | M5-9 |
| R9 normal 사각형 저장 | `capturesTheNormalRectangleOfAMaximizedWindow` · `savesTheNormalRectangleOfAMaximizedWindow`(둘 다 「최대화가 실제로 다른 사각형」 비공허성 가드 포함 · 실 windows QPA에서도 green) | M5-4 |
| R10 shown 게이트 | `savesBoundsOnlyForAWindowThatWasShown` · `doesNotSaveBoundsForAWindowThatWasNeverShown` | M5-8 |
| R11 close 1회 · resize 훅 없음 | `savesBoundsOnceOnCloseAndNeverOnResize` | M5-5 |
| R12 저장 실패 삼킴 | `closesEvenWhenTheConfigCannotBeWritten` | M5-14 |
| R13 폴더·잠금 이름 분리 | step3 `namesAreDistinctFromTheElectronShell` + step5 `derivesTheNamesFromTheUserDataFolder`(실제로 쓰는 OS 객체 이름) | M5-13 (+ step3 M3-3) |
| W-N1 clamp 밴드 | `clampsTheMinimumSizeBandToTheWindowMinimum`(7행) · `clampsBandBoundsToTheWindowMinimumOnBoot` · `usesTheCanonicalWindowConstants` + `static_assert` | M5-7a · M5-7b |
| W-N2 닫는 시점 stale 유지 | `keepsThePreviousBoundsWhenTheClosingRectangleIsOffScreen` · `keepsThePreviousBoundsWhenTheWindowClosesOffScreen` | M5-6 |
| W-N3 `CLIENT_USER_DATA` 조건부 | `followsTheResolvedUserDataFolder`(설정/미설정 두 갈래 모두 잠금 이름까지 따라감) | M5-13(이 케이스 포함 red) |

부분 잠금 2건도 넓혔다: **R1**(정본은 AC의 grep 위치 게이트뿐) — 잠금 이름이 폴더 문자열의 함수라 순서가 구조로 강제되고,
파생을 끊는 변이 M5-13이 red · **R2**(정본은 첫 인스턴스 쪽 절반만) — 두 번째 실행의 「폴더·설정·diag·창 0」을
`staysSilentAsASecondInstance`가 잠그고 변이 M5-12(노크 전에 diag 1줄)가 red.

### `appShell` — 변이 결과표 (2026-09-11 · 전건 기대 = 실제 · 원복 후 소스 md5 동일)

| 변이 | 내용 | 결과(`build.bat`) |
|---|---|---|
| **M5-1a** | `AppShell::start()`에서 잠금 판정 제거 | exit 1 · 3 red(`staysSilentAsASecondInstance` · `aSecondShellOnTheSameFolderOpensNoWindow` · `selfTestPassesAfterACleanBoot`) |
| M5-1a 프로세스 | 같은 변이 바이너리로 실프로세스 2개(`run.bat`) | 두 번째가 **15초 안에 끝나지 않고** 자기 `app-ready → config-loaded → app-window`를 씀(= 창 하나 더) · `second-instance` 없음 |
| **M5-1b** | `ERROR_ALREADY_EXISTS` 무시(모든 가드가 1차) | exit 1 · 4 red(SingleInstance 3 + AppShell 1) |
| **M5-2a** | 복원 경로가 workArea 검사 없이 구조 검사만 | exit 1 · 1 red(`opensAtTheDefaultsWhenNoWorkAreaHoldsTheStoredBounds`) |
| **M5-2b** | `sanitizeBounds` 겹침을 항상 참으로 | exit 1 · 4 red(step3 2 + step5 2) |
| M5-3a | 최소화 복원을 `showNormal()`로 | exit 1 · 1 red |
| M5-3b | 최소화 여부와 무관하게 항상 `showNormal()` | exit 1 · 3 red |
| M5-4 | `normalGeometry()` → `geometry()` | exit 1 · 2 red |
| M5-5 | 리사이즈마다 저장(`resizeEvent` → `closing()`) | exit 1 · 1 red |
| M5-6 | 닫는 시점 검증 실패 시 「bounds 없음」으로 리셋 | exit 1 · 2 red |
| M5-7a | `setMinimumSize` 제거 | exit 1 · 8 red(밴드 표 7행 전부 + 부팅 경로 1) |
| M5-7b | 저장 하한을 1024×720으로 통일 | exit 1 · **컴파일 실패**(`static_assert` C2338) |
| M5-8 | 표시된 적 없는 창도 저장 | exit 1 · 2 red |
| M5-9 | 저장된 `maximized` 무시 | exit 1 · 2 red |
| M5-10 | 실패 판정에서도 승격(R26 위반) | exit 1 · 2 red(FAILURE 2행) |
| M5-11 | 부팅 경로에 프로브 | exit 1 · 3 red |
| M5-12 | 두 번째 실행이 노크 전에 diag 1줄 | exit 1 · 2 red |
| M5-13 | 잠금 이름을 폴더와 무관하게 | exit 1 · 5 red |
| M5-14 | 닫기 이벤트 거부 | exit 1 · 4 red |
| M5-15a | 미구현 러너가 경고문을 숨김 | exit 1 · 2 red |
| M5-15b | 미구현 러너가 성공한 척 | exit 1 · 3 red |

## 무엇이 P4가 아닌가

| 범위 밖 | 소유 phase |
|---|---|
| 에디터(텍스트 엔진·블록 모델·IME·undo·자동저장) | P5 |
| 임베드·맞춤법·찾기바꾸기·표·인쇄·다이얼로그 17종·환경설정 8탭·i18n | P6 |
| 조회 6메뉴·컬럼 설정·우클릭 14액션·상세보기 창·관리 4화면 | P7 |
| 한글 제품명 exe·아이콘·windeployqt·설치 패키징·Electron 은퇴 | P8 |

**서버·웹·Electron 클라·계약(`server/**`·`src/**`·`web/**`·`client/**`·`contract/**`·`docs/api-contract/**`)은 이
모듈이 한 줄도 고치지 않는다.** 계약은 동결(P1)이고 클라이언트는 그것만 믿는다.
