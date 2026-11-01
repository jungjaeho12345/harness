# client-qt — Qt 네이티브 클라이언트 (로드맵 P4 · phase 77 / P5 · phase 78)

`docs/porting-plan-cpp-spring.md` §7 **P4 「C++ 클라 골격」** 의 산출물이다. Electron 셸 + 웹 SPA(`client/` + `web/`)를
대체할 네이티브 클라이언트를 여기에 세운다. **P4까지는 Electron 클라가 상시 대체재**이므로(로드맵 187행) 이 모듈이
동작하지 않아도 운영은 영향을 받지 않는다.

**P5 갱신(phase 78 · 2026-11-01)**: 로드맵 P5 「에디터 코어」가 이 골격 위에 에디터(순수 이식층 `src/editor/` + 텍스트 엔진 ·
편집 상태 기계 `src/ui/`)를 얹었다 — 아래 「에디터 — P5」 장과 「P5 마감」 장 · 결정은 `docs/ADR.md` **ADR-019**. 아래 P4 장들의
서술은 그 시점의 기록이고, P5가 바꾼 자리에는 **「P5 갱신」** 표시를 덧붙였다.

## 빌드 · 실행

```
cmd /c client-qt\build.bat        빌드(app + tests) 후 테스트 실행 — 실패하면 비-0 종료
cmd /c client-qt\run.bat          앱 실행(인자는 그대로 전달)
cmd /c client-qt\run.bat --selftest   CLIENT_SELFTEST=1과 똑같이 부팅(창 생성·diag 기록·표시 없음)한 뒤
                                      셸 불변식을 자기검사하고 이벤트 루프 없이 종료 — 통과 0 · 위반 1
```

- `--scenario login`·`--scenario list`는 **하네스 전용 자동화 훅**이다(step10·11 — `list`도 로그인 컨트롤러 1회 호출이고 목록은
  앱 자신의 성공 경로로 따라온다). `CLIENT_SELFTEST=1`이 아니면 앱은 **아무것도 하지 않고
  exit 2**로 거부한다 — 이 가드는 **보안 경계가 아니라 사고 방지 장치**다(아래 「로그인 화면」 절).
  **P5 갱신**: `--scenario edit`가 더해졌다(phase 78 step9) — `main.cpp`가 `list`로 바꿔 **같은 무수정 가드**에 넘기고, 가드를 지나도
  `CLIENT_SCENARIO_ARTICLE`(편집할 기사 id)이 없으면 exit 2다(아래 「에디터 — P5」 장의 「자동화 훅과 드라이버」).
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
                · P5: 텍스트 엔진 위젯 · 편집 상태 기계 · 편집 페이지 조립 · edit 훅   (phase 78 step8~9)
src/editor/     P5 에디터 이식층 — 웹 editor*.js·writerBody.js 1:1 10모듈 + 이음매 2(초안 파일·입력 라우팅)
                · 위젯 비의존   (phase 78 step0~9)
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
| 쿼리 직렬화(순수) | `web/src/model/httpModel.js` 70-79(`buildQuery`) | `src/net/querystring.{h,cpp}` · 테스트 `tests/querystringtest.{h,cpp}` | step7 |
| HTTP 전송 계층 | `web/src/model/httpModel.js` 88-118(`request()`) | `src/net/httptransport.{h,cpp}` · 테스트 `tests/httptransporttest.{h,cpp}`(루프백 스텁 `tests/stubhttpserver.*`) · 순수 정책 `tests/netpolicytest.{h,cpp}` | step7 |
| 편집 표면 식별자 | `web/src/controller/useWriteController.js` 44-51(`nextClientId`) | `src/net/editclientid.{h,cpp}` · 테스트 `tests/netpolicytest.{h,cpp}` | step7 |
| 실제 프로브 러너 | `client/main.js` 209-248(`requestHealthViaNet`) | `src/net/httpproberunner.{h,cpp}` · 테스트 `tests/httpproberunnertest.{h,cpp}` | step7 |
| 라우트 표(데이터) | `docs/api-contract/endpoints.json`(동결 39) · `web/src/model/httpModel.js`의 호출 지점 | `src/net/routetable.{h,cpp}` · 테스트 `tests/routetabletest.{h,cpp}` · 계약 대조 `tests/routecontracttest.{h,cpp}` | step8 |
| Model 인터페이스 35 | `web/src/model/contract.js`(`MODEL_KEYS`) | `src/net/newsmodel.{h,cpp}`(`INewsModel` · `ModelResult`) | step8 |
| 실제 Model | `web/src/model/httpModel.js` | `src/net/httpnewsmodel.{h,cpp}` · 테스트 `tests/httpnewsmodeltest.{h,cpp}` | step8 |
| 가짜 Model | `web/src/test/fakeModel.js` | `src/net/fakenewsmodel.{h,cpp}` · 테스트 `tests/fakenewsmodeltest.{h,cpp}` | step8 |
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
| **신설** | 9 | `net-request{route,method,status,ms}` · `login{status}` · `session{status}` · `sse-open` · `sse-ready` · `sse-change{kind}` · `sse-unauthorized` · `sse-closed{reason,status}`(step9 — `status`는 `pre-open-rejected`에만) · `list-loaded{menu,count}` |

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

### 프로브 — 주입 지점(step5) + 실제 러너(step7)

- `shell::ProbeRunner`가 주입 지점이다. step5의 합성 루트는 **`UnimplementedProbeRunner`**(요청을 **보내지 않고** 항상
  `{ok:false, reason:"unreachable"}`)를 넣었고, **step7부터 합성 루트는 `net::HttpProbeRunner`를 넣는다**(아래 net 절).
  대역 러너는 테스트용으로 남았고, 그 경고문(`limitationNotice()`)은 러너가 소유하므로 **실 러너가 주입되자 설정 화면에서
  저절로 사라졌다**(`showsNoNoticeOnceTheRealRunnerIsInjected`가 잠근다).
- `shell::probeOrigin()`이 정본 `probeOrigin`(`main.js:188-200`)의 이식이고, 정본에서 `main.js` 텍스트 스캔으로만 잠겨
  있던 **R26**(승격은 **성공 판정일 때만** — 캡티브 포털·오류 페이지로의 리다이렉트가 저장 주소를 바꾸지 못하게)을 행동
  테스트로 잠갔다. diag는 `probe{origin, ok, finalOrigin, promoted[, reason]}` 한 줄(정본 필드 그대로).
- 부팅 경로는 프로브를 부르지 않는다(A·B 실측 모두 `probe` 0줄). 프로브는 [연결 확인] 버튼에서만 돈다.

### `appShell` — 정본과의 의도적 이탈 (2026-09-11 · step5)

정본(`client/main.js`·`client/lib/windowPolicy.js`·`client/lib/clientConfig.js`)과 명세서(`test/**`)는 **한 줄도 고치지
않았다**(읽기 전용).

1. ~~**[저장]은 프로브 없이 정규화 통과만으로 저장한다**(step5.md D의 결정).~~ **→ step7에서 정본 순서로 복원했다**:
   정규화 → 프로브 → **실패면 아무것도 저장하지 않음**(입력 주소조차) → 성공이면 **프로브가 끝난 최종 origin**(R26 승격값)을
   저장 → `config-saved{최종 origin}` → 앱 창(`main.js:130-141`). 잠금은 `savesNothingWhenTheProbeFails` ·
   `savesTheProbedFinalOriginAndOpensTheAppWindow` · `savesTheRedirectedOriginOfARealProbe`(실 HTTP 302) ·
   `savesNothingWhenARealProbeMeetsAPortal` — 변이 M7-8(step5 순서로 되돌림)이 5건 red.
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

## net 계층 — 전송 핵심 (2026-09-11 · step7)

전송 계층은 **한 곳**이다: `net::HttpTransport::send(RequestSpec)`가 헤더·쿠키·타임아웃·오류 판별을 전부 소유한다(정본
`httpModel.js` `request()`의 대응). 정본(`web/**`)·계약(`docs/api-contract/**`)·서버는 **읽기만 했다**.

### 규율 (코드가 강제하는 것)

| 규율 | 정본 근거 | Qt |
|---|---|---|
| 1회 시도 · 재시도 없음 | `httpModel.js` 102-117 | `send()`에 루프 없음 · 모든 상태 1요청(`deliversEachStatusAsADistinctOutcome`이 요청 수를 센다) |
| 본문은 상태와 무관하게 파싱, 비-JSON은 표시만 | 110-117 | `jsonOk=false` · 전송 계층은 사유 토큰을 **지어내지 않는다**(`network-error`/`invalid-response` 합성은 step8 Model 몫) |
| **본문 없음 ≠ `{}`** | 98-101 · 247-256 | `RequestSpec.body = std::optional<QJsonObject>` — `nullopt`면 **업로드 장치 자체가 없다**(Content-Type·본문·Content-Length 전부 없음 — 실측) · `{}`면 `application/json` + `{}` |
| 쿠키 자 = 세션 운반의 유일 수단 | override L126·L128 | 메모리 전용 `QNetworkCookieJar` · `x-session-id` 경로 **없음**(로그인 본문의 `sessionId`도 읽지 않는다) |
| Origin/Referer 미부착 | `server/index.js` 288-292 | Qt 기본 헤더 그대로(부착 코드 0) — 실서버에서 무-Origin POST가 403이 아니라 404(아래 실측) |
| `x-edit-client`는 **라우트로** 강제 | `server/index.js` 932·961·974 | `editClientRouteIds()` = {articles-lock, articles-unlock, articles-update}. 그 밖에서는 값이 있어도 **안 붙인다**(웹은 호출부 데이터 흐름으로 같은 트래픽을 지킨다 — 관측 트래픽 동일) · step8 라우트 표가 이 집합과 같아야 한다 |
| 세션 폐기 = **401 + `unauthenticated`만** | step7.md(네이티브 신규 정책) | 편집 잠금 충돌(401 `locked`)·로그인 자격 오류(401 `invalid-credentials`)·토큰 없는 401 페이지에서는 **유지** |
| 판별 키 = (라우트, 상태, 토큰) | `reason-tokens.md` 표1 #8·표2 #1 | `classifyResponse()` 순서: ① **429는 본문보다 먼저**(로그인 429는 text/html · 토큰 없음) ② 비-JSON → `InvalidResponse` ③ `(login,423,locked)`=AccountLocked · `(articles-lock,401,locked)`=EditLockConflict · `(login,401,invalid-credentials)` · `(*,401,unauthenticated)` ④ 상태 버킷. `locked`를 토큰만으로 해석하는 코드 없음 |
| 무한 대기 금지 | 정본 없음(fetch 무기한) | 요청 전체 데드라인(기본 15000 ms · 0 이하도 기본값) · 대기는 사용자 입력을 제외한 로컬 이벤트 루프 |
| 응답 캐시 없음 | ADR-004 | `AlwaysNetwork` + `CacheSaveControl=false` |
| diag | step4 C · ADR-018 ④ | 요청마다 `net-request{route,method,status,ms}` — `route`는 **라우트 id**(경로를 싣지 않는다: 상대 경로는 리댁션이 fail-open) · 응답 없음이면 `status:null` |

### 실측 (Qt 6.8.3 · 이 머신 · 2026-09-11)

- **리다이렉트 정책은 코드에서 명시했다**(Qt 6 기본값 `NoLessSafeRedirectPolicy`를 믿지 않는다). 스텁 302로 잰 결과:
  **API 요청 = `SameOriginRedirectPolicy`** — 같은 출처 302는 **따라가고 쿠키도 동행**(최종 URL = 이동 후) · **교차 출처
  302는 따르지 않는다**: 상대 서버 요청 0건 · 응답은 302 자체(상태 302 · 텍스트 본문 · URL 불변) → `InvalidResponse`.
  **프로브 = `NoLessSafeRedirectPolicy`** — 교차 출처 302를 따라가 최종 URL을 보고(승격 입력). 정본 `fetch`(API)는 교차 출처도
  따르므로 **API 쪽은 의도된 이탈**(쿠키·본문이 설정된 서버 밖으로 나가지 않는다 — 브라우저도 credentials 교차 출처는 CORS가
  막는다). https→http는 TLS 스텁이 없어 **미실측**이다(정책상 Qt가 거부 → 프로브 실패. 정본은 따라간 뒤 승격만 거절).
- **쿠키**: express 형식 `sid=…; Max-Age=3600; Path=/; Expires=…; HttpOnly; SameSite=Lax`(비프로덕션 · Secure 없음)를 Qt 자가
  **저장하고 다음 GET·POST에 `Cookie: sid=…`로 싣는다**(SameSite 판정 없음 — 비브라우저). `Max-Age=0`(logout)이면 지운다.
  **실서버 2종(Node exe · Spring)에서도 확인**: 로그인 → `/api/session` 200 → 무-Origin POST `/api/articles/<없는 id>/lock`이
  **404**(403 `forbidden-origin` 아님) → 로그아웃 → `/api/session` 401(수동 `LiveServerTest` — `CLIENT_QT_LIVE_ORIGIN`이 있을 때만
  러너가 등록하므로 `build.bat`은 돌리지도 skip으로 세지도 않는다).
- **`QUrl`이 `%7E`를 `~`로 되돌린다**: buildQuery는 URLSearchParams대로 `%7E`를 만들지만 와이어에는 `~`가 나간다(RFC 3986의
  비예약 문자 정규화 — URLSearchParams가 인코딩하는 문자 중 **비예약은 `~` 하나**다). 서버는 두 철자를 같게 디코드한다.
  예약 문자(`! ' ( ) , ; $ @ / ? + & =`)는 인코딩된 채 나간다(와이어 행으로 잠금).
- **`QUrlQuery`는 URLSearchParams가 아니다**: `{q:'a b', p:'a+b'}` → `q=a%20b&p=a+b`. `+`를 인코딩하지 않아 서버가 공백으로
  읽는다 → 인코더를 손으로 썼다(`documentsWhyQUrlQueryIsNotUsed`).
- **Windows 루프백의 연결 거부는 즉시가 아니다 — 약 4.1초**(빌드 13회 실측 4056~4109 ms). 프로브 데드라인 5000 ms에 가깝다:
  거부는 여전히 `NetworkError`(→ unreachable)로 데드라인 전에 판정된다.

### 정본과의 의도적 이탈 (net · step7)

1. **API 교차 출처 리다이렉트를 따르지 않는다**(위 실측).
2. **쿼리 쌍의 순서는 키 순서다**(`QVariantMap` 정렬 — 정본은 삽입 순서). 서버는 이름으로 읽는다.
3. **와이어의 `~`**(위 실측 — 비예약 문자 정규화).
4. **JSON 객체가 아닌 JSON 본문**(배열·문자열)은 `jsonOk=false`다(정본은 그 값을 그대로 돌려준다 — 서버의 모든 응답은 객체).
5. **GET에 본문을 주면 보내지 않고 `NetworkError`**(정본 `fetch`의 TypeError → network-error와 동형 · Qt는 그대로 보냈을 것이다).
6. **새 정책 3종은 정본에 대응이 없다**: 데드라인 · 401+unauthenticated 세션 폐기 · 라우트 강제 `x-edit-client`.
7. **재시작 = 재로그인**(쿠키 디스크 미저장 — ADR-018 ⑤의 divergence 그대로).

### 무잠금 7건의 처분 (net 포트 스펙 transport 갈래)

포트 스펙이 「오늘 어떤 테스트도 잠그지 않는다」고 센 transport 규칙 7건 — **7건 전부 새 케이스로 잠갔다**(+ 부분 잠금 2건 확장).

| 규칙 | 잠근 케이스 | 변이 |
|---|---|---|
| R2 세션 쿠키 지속(정본은 브라우저 저장소) | `keepsNoSessionAcrossARestart` · 쿠키 왕복 3건 | M7-3 |
| R9 `locked` 재사용 — (라우트, 상태) 키 | `neverReadsLockedFromTheTokenAlone` · `separatesTheTwoLockedTokens` · 분류 표 | M7-5 · M7-6 |
| R10 429 무토큰 — 상태 우선 | `judgesATextHtml429AsRateLimited` · 분류 표 3행 | M7-5 |
| R12 세션 폐기 조건 | `dropsTheSessionOnlyOnUnauthenticated`(8행) | M7-6 |
| R13 데드라인 | `timesOutInsteadOfWaitingForever` · `neverWaitsForever` · 프로브 `givesUpAtItsDeadline` | (행이 스텁을 매달아 두므로 데드라인 제거 변이는 red가 아니라 **무한 대기**가 된다 — 순수 `effectiveTimeoutMs` 행이 0/음수 경로를 잠근다) |
| R14 Origin/Referer 부재 | `sendsNoOriginRefererOrSessionHeader` + 실서버 404 | M7-2 |
| R15 SameSite=Lax 쿠키의 비브라우저 처리 | 스텁 쿠키 왕복(POST 포함) + 실서버 2종 | (실측 항목) |
| (부분) R4 create에 `x-edit-client` | `attachesTheEditClientOnlyOnItsThreeRoutes`(14행) | M7-1 |
| (부분) R5 action 없는 lock의 `{}` | `sendsAnEmptyObjectWhenTheBodyIsEmpty` · `sendsNeitherBodyNorContentTypeWithoutABody`(7행) | M7-4 |

크로스체크가 지목한 공백 2건도 잠갔다: **buildQuery**(`QueryStringTest` 27행 — 기대값은 전부 node로 정본을 실행해 얻었다 ·
와이어 7행) · **리다이렉트**(`followsOnlySameOriginRedirectsForApiCalls` · 프로브 302 3건).

### 변이 결과표 (2026-09-11 · 전건 기대 = 실제 · 원복은 소스 diff 0으로 판정)

| 변이 | 내용 | 결과(`build.bat`) |
|---|---|---|
| **M7-1** | `x-edit-client`를 값만 있으면 모든 라우트에 | exit 1 · **10 red**(3 라우트 밖 행 전부) |
| **M7-2** | `Origin: http://evil.example` 부착 | exit 1 · 1 red(`sendsNoOriginRefererOrSessionHeader`) |
| **M7-3** | 쿠키 자를 파일 지속 자로(`%TEMP%`에 저장·로드) | exit 1 · 2 red(`keepsNoSessionAcrossARestart` + 프로브 새 자) · 변이가 실제로 파일을 썼다 → 삭제 |
| **M7-4** | `body`를 `QJsonObject`로 합침(nullopt도 `{}`) | exit 1 · **6 red**(무본문 POST 5 + DELETE 1 · GET 행은 green) |
| **M7-5** | 판별 순서 뒤집기(JSON 먼저 → 상태) | exit 1 · 4 red(순수 2행 + text/html 429 + 상태 전수) |
| **M7-6** | 모든 401에서 세션 폐기 | exit 1 · 3 red(**편집 잠금 충돌** · 자격 오류 · 무토큰 401) |
| **M7-7a** | `null`을 `key=`로 | exit 1 · 4 red(순수 3 + 와이어 1) |
| **M7-7b** | 배열을 쉼표 결합 | exit 1 · **9 red**(deskUnsent·정본 행·빈 배열 2·원소 규칙 2·정본 반복 키·와이어 2) |
| **M7-8** | 저장 순서를 step5(프로브 없이 저장)로 | exit 1 · 5 red(**프로브 실패 시 미저장** 2 · 최종 origin 저장 2 · 이벤트 수 1) |

## net 계층 — 계약 대조 · Model (2026-09-12 · step8)

**라우트 표가 net 계층의 유일한 라우트 정본이다.** 메서드·경로 템플릿·인증 등급·본문 유무·`x-edit-client`·SSE가 한 곳
(`src/net/routetable.cpp`)에 데이터로 있고, `HttpNewsModel`은 **라우트 id만 말한다**(경로·HTTP 메서드 문자열 0개). 전송
계층의 `x-edit-client` 3 라우트 집합도 이제 이 표의 `sendsEditClient` 열에서 **파생**되고(step7의 별도 상수 폐지 — 정본 1개),
`HttpProbeRunner`도 `health` 행을 표에서 취한다. 정본(`web/**`)·계약(`docs/api-contract/**`)은 **읽기만 했다**.

### 라우트 표 — 37행 · 소비자 일대다

| 사실 | 값 |
|---|---|
| 행 수 | **37** = 계약 39 − 금지 2(`collection-receive`·`collection-pull` — `forbiddenRouteIds()`에만 있고 `findRoute()`는 `nullptr`) |
| 소비자(`consumer`) | 행마다 1개. **`saveArticle`만 2행**(`articles-create`·`articles-update`) · `health`의 소비자는 **`ProbeRunner`** · 나머지 36행 → `MODEL_KEYS` 35 |
| `sendsEditClient` | 정확히 `articles-lock`·`articles-unlock`·`articles-update` |
| `hasBody` | 본문 없는 POST 5종(`logout`·`articles-unlock`·`articles-force-unlock`·`distribution-targets-deactivate`·`distribution-tick`) · `articles-lock`은 **항상** 본문(`{}`) · GET/DELETE 없음. **표가 본문 유무를 결정한다**(호출부가 본문을 줘도 무본문 행이면 안 보낸다) |
| `roles` 열 | **의도적으로 없다** — 역할은 서버가 매 요청 세션에서 도출한다(ADR-004). 클라 역할 표는 권한 캐시가 된다 |
| 경로 인코딩 | `encodePathSegment` = `encodeURIComponent`(A-Z a-z 0-9 `- _ . ! ~ * ' ( )` 유지). **쿼리의 `buildQuery`(URLSearchParams)와 규칙이 다르다** — 기대값 8행은 node로 정본을 실행해 얻었다 |

### 기계 대조 C-1~C-8 (`tests/routecontracttest.cpp`)

QtTest가 **런타임에** `docs/api-contract/endpoints.json`과 `web/src/model/contract.js`를 **리포 루트 기준 상대 경로**로 찾아
(테스트 바이너리 디렉토리 → 작업 디렉토리 순으로 위로 걸어 올라간다) 읽는다. **라우트 목록은 테스트 어디에도 적혀 있지 않다** —
적힌 것은 계획이 고정한 정책(금지 2 · `x-edit-client` 3 · `saveArticle` 2 · 35)뿐이다.

| 항목 | 테스트 | 판정 |
|---|---|---|
| C-1 | `c1_idSetIsExactlyTheContract` | 표 ∪ 금지 = 계약 id 집합(중복·겹침 0 · 37+2=39) — 드리프트는 **id로** 보고 |
| C-2 | `c2_methodAndPathMatchTheContract` | method·path 문자 단위 일치 |
| C-3 | `c3_authMatchesTheContract` | auth 6어휘 그대로(`public`·`session`·`admin`·`session-role`·`lock-holder`·`token`) |
| C-4 | `c4_forbiddenRoutesAreNotInTheTable` | 금지 2행이 계약에 실재 · 표에 없음 · `findRoute`/`buildPath` 도달 불가 · **`token` 인증 행 전부가 금지** |
| C-5 | `c5_sseRowsMatchTheContract` | `sse:true` 양방향 일치(계약에 SSE 행이 0이면 공허로 red) |
| C-6 | `c6_editClientRowsAreExactlyThreeAndTheTransportsSet` | 정확히 3행 · 그 3 id · **`net::editClientRouteIds()`와 같음** · 계약의 `lock-holder` 행은 전부 포함 |
| C-7 | `c7_consumersMapOneToMany` | ① 행마다 소비자 1 ② `ProbeRunner` = `{health}` ③ 나머지 ⊂ `MODEL_KEYS` ④ `MODEL_KEYS` 35 전부 ≥1행 ⑤ 2행 이상은 `saveArticle`뿐이고 정확히 `{articles-create, articles-update}` |
| C-8 | `c8_modelKeysAreTheInterface` | `contract.js`의 `MODEL_KEYS` = `net::modelMethodNames()`(개수 35 · 이름 · **순서**). 이름 목록의 각 항목은 `&INewsModel::<name>`으로 **컴파일 결박**된다(없는 멤버 이름은 빌드가 안 된다) |

- **계약 파일 부재 = red(skip 아님) — 실증**: 같은 테스트 바이너리를 리포 밖 임시 폴더로 복사해 실행 → **rc 1 · FAIL 11**
  (파일 탐색 1 + C-1~C-8 전부 + 드리프트 1 + fake 무네트워크 스캔 1) · `SKIP` 0줄. 메시지가 탐색한 디렉토리를 전부 적는다.
- **드리프트 감지 — 실증 2겹**: ① 상주 테스트 `detectsDriftInACopyOfTheContract`가 메모리 사본(행 추가 · 행 삭제 · path · method ·
  auth · sse · 새 token 라우트 · create의 lock-holder화 · `MODEL_KEYS` 증감)마다 해당 비교기가 **그 이름을 보고**하는지 단언한다.
  ② 리포 밖 임시 루트에 **한 행 늘린 `endpoints.json` 사본**을 두고 실제 바이너리를 돌림 → C-1만 red
  (`contract routes neither in the table nor forbidden: articles-bulk-edit` · `table 37 + forbidden 2 != contract 40`).
  원본은 읽기만 했다 — `git diff -- docs/api-contract web` 무출력.
- **한계(decisions (4) ⑦)**: 이 대조는 「부른 경로가 계약에 있다」까지다. **요청 body shape의 전수 일치는 보증하지 않는다**
  (와이어 테스트가 정본 호출과 같은 본문을 단언하지만, 서버가 그 본문을 받아들이는지는 실기 200으로만 확인된다).

### Model — 결과 규약과 실기 범위

- `ModelResult{outcome, status, body}`: `body`는 **정본 `request()`가 돌려줄 값 그대로**(서버 JSON 객체 무가공 · 응답 없음 =
  `{ok:false, reason:"network-error"}` · 비-JSON = `{ok:false, reason:"invalid-response"}` — 합성은 이 둘뿐). **화면은 `outcome`으로
  분기한다**: 로그인 429는 text/html이라 `body`는 정본대로 `invalid-response`이고 **`outcome`(RateLimited)만** IP 제한을 말한다
  (`tellsARateLimitOnlyByOutcome`).
- **실기(실서버)로 부르는 메서드는 P4에서 6개**다 — `login`·`restoreSession`·`logout`·`queryArticles`·`subscribe` + `getArticle`(선택).
  **step8은 이 6개도 실서버에 붙이지 않았다**(step10·11의 화면·드라이버 시나리오가 부른다). **나머지 29개는 요청 조립만**
  구현했고, 루프백 스텁 위에서 정본 호출과 1:1로 잠갔다(`eachMethodSendsTheRouteTheTableGivesIt` — REST 33 메서드 34 호출의
  method·target·본문·`x-edit-client`·diag `route`·표의 `consumer`를 모두 대조하고, 커버리지가 「`MODEL_KEYS` − 스트림 2 = 33」
  「표 − health − SSE 2 = 34」와 같음을 단언). **그 29개의 실제 왕복은 P4 범위 밖이며 미검증이다**(P5·P7이 화면을 붙일 때 넓힌다).
- **`queryArticles` 결선**: 필터는 **step7의 `buildQuery`를 그대로** 거친다(`?status=RDS&status=DDH` · 정본 197~202행 동형 ·
  `author=a%2Bb+c`). 쉼표 결합(M8-7)도 `QUrlQuery` 조립(M8-7b — `+`가 맨몸으로 남아 서버가 공백으로 읽는다)도 red다.
- **SSE**: `subscribe()`는 **step9부터 `ChangeStream` 1개를 연다**(아래 「net 계층 — SSE」) ·
  `subscribeLogs()`는 **P4 내내 비활성**(Z 전용 · P7 — `neverOpensTheLogStreamInP4`).
- **기본 인자는 인터페이스에만 있다** — C++는 오버라이더가 기반의 기본 인자를 가린다(`fake.queryArticles()`가 컴파일되지 않음 —
  실측). 35개 오버라이더에 기본값을 복제하면 어긋날 수 있으므로 **호출자는 `INewsModel&`로 부른다**(컨트롤러가 원래 그렇다).

### 정본과의 의도적 이탈 (net · step8)

1. **로그인 결과에 `sessionId`가 없다**(`HttpNewsModel`·`FakeNewsModel` 둘 다). 세션은 쿠키 자에만 있고(decisions (6)) 토큰이
   컨트롤러·로그·화면에 닿지 않는다. 정본은 헤더 폴백 때문에 그 값을 돌려준다.
2. **`logout()`은 응답과 무관하게 쿠키 자를 비운다**(정본 `writeSessionId(null)`이 요청 뒤 무조건 도는 것과 동형 — 500이어도).
3. **빈/`.`/`..` 경로 파라미터는 요청을 보내지 않는다**(`notSentResult` = `network-error`). 정본은 `/api/articles/`(목록 라우트에 닿는다)나
   `/api/articles/..`(점 세그먼트 정규화)를 보낸다.
4. **`x-edit-client`는 표가 허락한 행에서만 전송 계층에 넘긴다**(전송 계층이 같은 집합으로 한 번 더 막는다) — `articles-create`에
   clientId를 줘도 붙지 않는다(관측 트래픽은 정본 호출부와 같다).

### FakeNewsModel — 규율과 정본 fake와 다른 점

규율 6종(각각 테스트 1개): **1 결정적**(카운터 시계 `2026-01-01T00:00:00Z`+1초/회 · ID 카운터 · 리스너는 등록 순 `std::map` —
`QHash`는 프로세스별 시드라 호출 순서가 흔들린다) · **2 무네트워크**(자기 소스 2파일에 네트워크·소켓 타입 이름 0 — 소스 스캔 +
`std::is_constructible` 단언) · **3 35 전 구현**(이름표 = `modelMethodNames()` · 전부 `{ok:bool}` 응답 · `!is_abstract`) ·
**4 비밀번호 없음**(서버 `SAFE_FIELDS` 허용목록 — 잠금 필드도 안 나간다 · 세션 5키/로그인 6키) · **5 soft-delete**(`deactivate`는 행 유지 ·
사용자 「삭제」는 `updateUser {active:'N'}` · 삭제 멤버 부재는 `static_assert`) · **6 `saveArticle`이 `body` 키를 버린다**(생성·수정 둘 다).

오버라이드 대장 제약: **L131** 어떤 응답에도 `lockerSessionId`·`lockerClientId`가 없다(시드 행에 있어도 — 보유자는 행 밖 표에 둔다) ·
**L123-128** 세션은 id만 들고 **매 호출 현재 행에서 신원을 재도출**한다(역할 변경 즉시 반영 · 비활성화 = 세션 폐기 후 재활성해도 부활 없음) ·
**L21** 사용자 삭제 메서드 없음.

정본 fake(`web/src/test/fakeModel.js`)와 다르게 한 자리들 — **전부 서버·동결 계약 쪽으로 옮겼다**(fake가 서버와 다르면 그 위의 컨트롤러 테스트가 거짓 green이다):
`updateUser`는 `{ok, changes}`(계약: not-found 없음 · 정본 fake는 `{ok,user}`/not-found) · 수신 설정 응답은 `SAFE_FIELDS`(password·apiKey 미노출) ·
`deleteReceiverConfig`는 `{ok, changes}` · 로그인은 비밀번호 필수(정본 fake는 `password===undefined`면 통과) · 비활성 계정 로그인은 403 `inactive` ·
`createUser`는 `active` 기본 `'Y'` · 목록 필터 `null` = 필터 없음(서버는 `buildQuery`가 키를 떨군 요청을 본다) · 결과에 서버 `STATUS_BY_REASON` 상태와
전송 계층과 같은 `outcome`을 싣는다. **유일한 행 제거는 `deleteReceiverConfig`**다 — 서버가 실제로 설정 행을 지우는 계약 유일의 DELETE이고
(수집 기사는 불변), 그대로 모사했다.

### 무잠금 5건의 처분 (net 포트 스펙 route-table 갈래)

| 규칙 | 처분 |
|---|---|
| 금지 2 라우트의 영구 배제 | **잠금** — C-4 + `findsNoForbiddenOrUnknownRoute` + `refusesAPathThatWouldLandElsewhere`(M8-3) |
| `articles-create`의 `x-edit-client` | **잠금** — 와이어 행(clientId를 줘도 없음) + C-6(M8-4) |
| auth 대조 | **잠금** — C-3(M8-5) |
| 경로 파라미터 퍼센트 인코딩 | **잠금** — `encodesAPathSegmentLikeEncodeURIComponent` 8행 + 와이어 `AKR%201` |
| `roles` 열 부재 | **의도로 기록** — 위 표(ADR-004) |

### 변이 결과표 (2026-09-12 · 전건 기대 = 실제 · 원복은 소스 diff 0으로 판정)

| 변이 | 내용 | 결과(`build.bat`) |
|---|---|---|
| **M8-1** | 표에서 `users-update` 행 삭제 | exit 1 · 5 red(C-1 · C-7 · 드리프트 · 와이어 · 경로 채우기) |
| **M8-2** | `articles-get` path를 `/api/article/:id`로 | exit 1 · 6 red(**C-2** · 드리프트 · 와이어 · 경로 3) |
| **M8-3** | `collection-receive`를 표에 삽입 | exit 1 · 4 red(**C-4** `forbidden route 'collection-receive' is in the table` · C-1 · C-7 · 커버리지) |
| **M8-4** | `sendsEditClient`를 4행으로(`articles-create`) | exit 1 · 4 red(**C-6** + step7 `namesExactlyThreeEditClientRoutes`·`attachesTheEditClientOnlyOnItsThreeRoutes` — 전송 계층이 표에서 파생된다는 증거 · 와이어) |
| **M8-5** | `login`의 auth를 `session`으로 | exit 1 · 2 red(**C-3** `login: auth 'session' != contract 'public'` · 드리프트) |
| **M8-6** | `articles-create`의 소비자를 비움 | exit 1 · 3 red(**C-7** ①⑤ 둘 다 이름으로 보고 · `routesOf` · 와이어 consumer) |
| **M8-7** | `queryArticles`가 배열을 쉼표로 결합 | exit 1 · 2 red(**결선 테스트** `status=RDS%2CDDH` · 와이어) |
| M8-7b | 쿼리를 `QUrlQuery`로 조립해 경로에 붙임 | exit 1 · 2 red(`author=a+b%20c` · `q=a%20b`) |
| MF-1 | fake가 `body` 키를 보존 | exit 1 · 1 red(규율 6) |
| MF-2 | fake에 `#include <QNetworkAccessManager>` | exit 1 · 1 red(규율 2 `names QNetwork`) |
| MF-3 | fake 시계를 벽시계로 | exit 1 · 1 red(규율 1 — 20 ms 간격의 두 실행이 다른 바이트) |
| MF-4 | `queryUsers`가 행을 통째로 | exit 1 · 1 red(규율 4 `password in …`) |
| MF-5 | `deactivate`가 행을 지움 | exit 1 · 2 red(규율 5 · 배부 대상 왕복) |
| MF-6 | 기사 투영에서 locker 필드를 안 지움 | exit 1 · 1 red(L131) |
| MF-7 | 로그인 시점 신원 스냅샷을 캐시 | exit 1 · 1 red(L123-128 — 2026-08 감사 권한상승 패턴) |

## net 계층 — SSE (2026-09-12 · step9)

`GET /api/stream`의 무효화 신호를 받는다. 정본은 `web/src/model/httpModel.js` 313~337행(브라우저 `EventSource`)이고
와이어 정본은 `docs/api-contract/sse.md`다. 정본·계약·서버는 **읽기만 했다**.

| 부분 | 파일 | 역할 |
|---|---|---|
| 순수 파서 | `src/net/sseparser.*` | 바이트 → 이벤트. 네트워크·이벤트 루프·어휘를 모른다 |
| 스트림 | `src/net/changestream.*` | 연결·헤드 판정·재연결·diag. **인스턴스마다 독립**(모듈 상태 0) |
| 전송 | `HttpTransport::openStream` | 같은 쿠키 자·URL 조립·캐시/리다이렉트 규칙 + `Accept: text/event-stream` · **본문 데드라인 없음**(R13의 유일한 예외) · `net-request{route:'stream'}` 연결마다 1줄 |
| Model | `HttpNewsModel::subscribe` | 정본 핸들 `{connected(), unsubscribe()}` · `FakeNewsModel::endStreamSession()`은 같은 순서를 흉내 내는 시험 이음매 |

### 파서 규칙 (정본이 브라우저에 맡기던 WHATWG 규칙)

- **증분 상태기계** — 모든 2분할점 · 1바이트씩 · 「세 개 반」이 같은 결과. 「한 read = 한 프레임」 가정 없음(phase 74 교훈:
  Node의 「write 1 = 청크 1」은 그 서버의 성질이지 전송의 보증이 아니다).
- 빈 줄 전에는 **디스패치 0** · 스트림이 끝나면 미완성 프레임은 버린다(내보내지 않는다).
- event 줄 없음 = `message` · data 여러 줄은 LF 결합 · 콜론 뒤 공백 **1개만** 제거 · data 없는 프레임은 이름까지 잊는다 ·
  `:` 주석·`id:`·`retry:`·미지 필드 무시 · 미지 이벤트 이름은 파서가 그대로 넘기고 `ChangeStream`이 무시한다.
- **CRLF·CR 수용(결정)**: 계약은 LF지만 브라우저 EventSource는 셋 다 받는다. 더 엄격하면 줄끝을 바꾸는 프록시 뒤에서
  **unauthorized 프레임까지 삼켜** sse.md 35행의 「닫지 못하고 무한 재연결」이 된다. 청크 경계에 걸린 CRLF도 줄끝 1개다.
- 처리 안 함: 선두 UTF-8 BOM(서버가 쓰지 않는다).

### 종결 3 · 재연결 1 (`CloseReason`)

| 사유 | 조건 | 재연결 | `unauthorized()` | diag |
|---|---|---|---|---|
| `PreOpenRejected` | HTTP 응답이 「200 + `text/event-stream`」이 아니다(401·503·302·200 text/html·Content-Type 없음) | **0** | **401일 때만** | `sse-closed{reason:'pre-open-rejected',status}` |
| `UnauthorizedFrame` | 열린 뒤 `unauthorized` 프레임 | **0** | 예 | `sse-unauthorized` → `sse-closed{reason:'unauthorized-frame'}` |
| `Transient` | **HTTP 응답 없음**(거부·리셋·열기 데드라인) 또는 열린 스트림이 끝남 | 백오프 | 아니오 | `sse-closed{reason:'transient'}` |
| `Stopped` | `stop()` | 0 | 아니오 | `sse-closed{reason:'stopped'}` |

- **헤드가 판정이다**: 상태 200 **그리고** Content-Type의 MIME 본질이 `text/event-stream`(대소문자·파라미터 무시 ·
  `text/event-streamx`는 아님). `Cache-Control`·`Connection`은 **판정하지 않고 diag도 안 남긴다** — 프록시가 바꿀 수 있고
  아무것도 결정하지 않는다(실서버 두 종 모두 `no-cache`·`keep-alive`로 관측).
- 200인데 SSE가 아니면 **즉시 끊는다**(캡티브 포털 본문은 끝나지 않을 수 있다 · 파싱 0). 비-200은 짧은 본문을 끝까지 읽어
  **401 + `unauthenticated`면 `send()`와 같은 규칙으로 세션을 버린다**(`classifyResponse` 재사용).
- **열리기 전 「응답 없음」은 Transient다** — WHATWG는 네트워크 오류에서 재연결하고 **틀린 HTTP 응답만** 실패로 닫는다(서버
  재시작 중의 연결 거부가 실시간을 영구히 끄면 안 된다). 열기 데드라인은 **헤드까지만**(기본 15 s = 전송 계층 기본값) — 본문은
  무기한이다(서버에 하트비트가 없어 무이벤트 스트림은 몇 시간씩 조용하다 · ADR-008).
- **읽고 나서 판정**: 서버는 unauthorized 프레임을 쓰고 곧바로 `res.end()`한다(sse.md 60) — 바이트와 종료가 한 번에 오면
  `finished`에서 남은 바이트를 **먼저** 파싱한다. 거꾸로 하면 일시 단절로 분류돼 재연결한다(포트 스펙 sse 실측 함정 (c)).
- **봉인**: 닫힌 뒤에는 같은 read에 실린 후속 프레임도 내보내지 않는다(정본 R6 — `QNetworkReply::abort()`에는
  `EventSource.close()`의 보증이 없다).
- **백오프**: 1 s → 2 s → 4 s … 상한 30 s · **`ready`를 받으면 사다리 초기화**(살아 있음이 증명된 스트림은 처음부터).
  브라우저 EventSource는 `retry:` 없이 대략 상수 간격이다 → **완화 방향의 divergence**. ADR-008의 「앱 내 주기 실행」이
  아니다(클라 연결 복구 · decisions (8)).

### 단일 무효화 신호 · 세션 종료 · 동시 연결

- `change`는 **kind와 무관하게 같은 신호**(`changed(kind)`) — kind는 diag 기록용이고 분기 0(L80 · sse.md 89행이 정확 kind
  단언을 flake로 경고). 빈 data·파싱 불가·객체 아닌 JSON도 change(kind `""`) — 정본 318~324행의 `{}` 폴백.
- Model 결선: `onChange({kind}` 또는 `{}`, **호출자 filter 그대로**) · ready → `onStatus(true)` · unsubscribe를 뺀 모든 종료 →
  `onStatus(false)` · unauthorized 프레임 또는 열리기 전 401 → **`onSessionEnd()`**(선택 인자 · **네이티브 추가** — 정본은
  EventSource를 닫고 `onStatus(false)`만 한다). 순서는 `onStatus(false)` → `onSessionEnd()`. `unsubscribe()`·핸들 파기는
  **화면을 부르지 않는다**(사라지는 중일 수 있다).
- **동시 연결**: 같은 세션(전송 계층의 쿠키 자)으로 두 스트림이 동시에 돌고, 하나를 멈춰도 다른 하나는 계속 받는다 — 반 프레임을
  교차 주입해 파서 분리까지 잠갔다.
- **세션 연장 착각 금지(L127)**: 스트림은 `GET /api/stream` 외에 어떤 요청도 보내지 않고 유휴 타이머가 없다.

### 정본과의 의도적 이탈 (net · step9)

1. 지수 백오프(정본 = 브라우저의 상수 간격 재시도).
2. `onSessionEnd` 추가(열리기 전 401 → 로그인 화면 — step9.md의 「상위에 세션 종료」).
3. change 신호 객체는 `{kind}` 또는 `{}`뿐이다(정본은 파싱한 값을 그대로 넘긴다 — 서버는 `{kind}`만 보낸다).
4. 열리기 전 401 + `unauthenticated`에서 세션 폐기(정본에 없음 — step7 규칙을 스트림 경로에도 적용).
5. `unsubscribe()` 뒤 `connected()`는 false(정본은 마지막 값을 유지한다 — 그것을 단언하는 정본 테스트는 없다).

### 실측 — `open_questions` (2) (2026-09-12 · 이 머신 · Qt 6.8.3 · 루프백)

`LiveStreamTest`(수동 — `CLIENT_QT_LIVE_SSE`가 있을 때만 러너가 등록한다. **`build.bat`에서는 돌지도, skip으로 세지도 않는다** —
step7 `LiveServerTest` 선례). 같은 이벤트 루프의 **raw `QTcpSocket` 기준 리더**(QNAM 미경유 · 별도 계정)와 Qt 스트림이 같은
서버 스트림을 읽고, 작성자 세션의 `POST /api/articles`를 트리거로 각자의 도착 시각을 잰다. **`qt − raw`가 QNAM이 더하는 지연이다.**

| 서버 | 헤드 | 첫 프레임(ready) Qt / raw | change qt−raw min/median/max | 트리거→Qt median | 35 s 무이벤트 뒤 |
|---|---|---|---|---|---|
| Node exe | 200 · HTTP/2 **미사용** · Content-Encoding **없음** · chunked | 17 ms(헤드 15) / 32 ms · 앞 회차 206 / 221 ms | **1 / 1 / 2 ms**(9회) · 앞 회차 0 / 1 / 1 | 35 ms · 앞 회차 21 | 끊김 0 · change 도착 +80 ms |
| Spring | 동일 | 33 ms(헤드 31) / 49 ms · 2회차 36 / 51 | **1 / 2 / 4 ms**(9회) · 2회차 1 / 2 / 3 | 35 ms · 2회차 29 | 끊김 0 · change 도착 +67 ms |

- **결론: 이 트리의 두 서버에서 QNAM은 프레임을 늦추지 않았다**(qt−raw ≤ 4 ms · median 1~2 ms) → **회피책(HTTP/2 비활성 ·
  raw socket)은 필요 없다.** 이유도 관측됐다: `http://`라 HTTP/2가 쓰이지 않고(Qt는 h2를 https ALPN이나
  `Http2CleartextAllowedAttribute`에서만 쓴다) 서버가 SSE를 압축하지 않아 자동 압축 해제 경로가 없으며, chunked 본문이
  `readyRead`로 증분 도착한다.
- Node 앞 회차의 첫 프레임 206/221 ms는 **raw도 같아서 Qt 무관**이다(재현 안 됨 — 이후 17~36 ms). Spring 첫 change의
  391 ms도 raw 387 ms와 같다(서버 첫 요청 워밍업).
- **미측정**: https(ALPN으로 HTTP/2가 켜질 수 있다) · 압축하는 프록시 경유 · 원격 호스트.

### 무잠금 3건의 처분 (net 포트 스펙 sse 갈래)

| 규칙 | 처분 |
|---|---|
| R3 change의 빈/파싱 불가 data → `{}` | **잠금** — `raisesOneSignalPerChangeWhateverTheKind`(빈 data · `not-json` · JSON 배열 → kind `""`) + Model `subscribeRunsTheChangeStream`(`{}` 전달) |
| R10 바이트 프레이밍 | **잠금** — `SseParserTest` 16케이스(sse.md 픽스처 그대로 · 전 분할점 · 1바이트 · CRLF/CR · UTF-8 분할) + 와이어 `assemblesAFrameSplitAcrossHttpChunks` |
| R11 SSE ≠ 세션 활동 | **행동으로 잠금** — `neverSendsAnythingButTheStreamRequest`(프레임·단절·재연결 내내 `GET /api/stream` 외 요청 0) · 유휴 타이머 코드 없음(리뷰 항목으로도 남긴다) |

### 변이 결과표 (2026-09-12 · 전건 기대 = 실제 · 원복은 소스 diff 0으로 판정)

| 변이 | 내용 | 결과(`build.bat`) |
|---|---|---|
| **M9-1** | data 줄이 오면 즉시 디스패치 | exit 1 · 5 red(파서 4 — 종결자 없음 · 반 프레임 · 여러 data 줄 · reset + 와이어 청크 분할 1) |
| **M9-2** | unauthorized 처리 삭제 | exit 1 · 4 red(`stopsForGoodOnTheUnauthorizedFrame` · `readsTheUnauthorizedFrameThatArrivesWithTheClose` = `transient/-1`, 즉 재연결 경로 · Model 2) |
| **M9-3** | 백오프 제거(즉시 재시도) | exit 1 · 2 red(와이어 간격 `46 47 47 47 46` ms — 늘지 않음 · 사다리 2단 47 ms) |
| **M9-4** | 열리기 전 401을 Transient로 | exit 1 · 3 red(`transient/-1` · 재연결 뒤의 401도 `transient` · Model 세션 종료 0) |
| **M9-5** | Content-Type 검사 삭제 | exit 1 · 5 red(5행 전부 — 포털 본문의 프레임이 디스패치돼 `unauthorized-frame`으로 닫힘) |
| **M9-6** | 파서를 모듈 전역(싱글턴)으로 | exit 1 · 1 red(반 프레임 교차 → 두 번째 스트림 kind `""`) |

### step10·11에 넘기는 사실

- **같은 사용자로 로그인하면 그 사용자의 기존 세션이 전부 무효화된다**(`src/services/sessionService.js` `createSession`).
  드라이버가 클라와 **같은 계정**으로 로그인하면 클라 세션이 죽고, 스트림은 열리기 전 401 → 세션 종료로 끝난다(이번 실측에서
  실제로 밟았다 — 스트림은 재연결하지 않았다). step11의 서버 측 사실은 클라(desk)와 **다른 계정**(reporter)으로 만든다.
- `HttpTransport::send()`는 로컬 이벤트 루프로 기다리므로 **그 사이 도착한 change가 재조회를 다시 부를 수 있다**(재진입).
  컨트롤러는 재조회 중 도착한 신호를 합쳐라.
- QNAM은 호스트당 HTTP/1.1 연결 6개 — 스트림은 연결 하나를 계속 쥔다(P4 1개 · P5 +1).
- 원장: 스트림은 **연결마다** `net-request{route:'stream'}` 1줄(재연결도 1줄) — step11 기대 집합의 `stream`.

## 로그인 화면 (2026-09-12 · step10)

네이티브 클라가 **처음으로 서버와 실제로 말하는 화면**이다. ADR-003 그대로 View ← Controller ← Model:

| 층 | 파일 | 하는 일 |
|---|---|---|
| View | `src/ui/loginscreen.*` | 로그인 카드(UI_GUIDE — 블루 라벨 · 명조 700 CTA · 오류 줄만 레드). 암호 필드는 **마스킹**, 제출 즉시 **비운다**(아이디는 재시도를 위해 남긴다) |
| View | `src/ui/mainwindow.*` | 콘텐츠 2페이지 — **로그인 페이지**(창은 언제나 로그아웃 상태로 열린다) · **목록 슬롯**(step10에서는 비어 있었다 — step11부터 `ListScreen`, 아래 「목록 화면」). **P5 갱신**: 콘텐츠 페이지는 **셋**이다 — 세 번째 = **편집 페이지**(`EditorWidget` · 상단 바에 그 페이지 전용 [저장][복구][닫기] + 안내 문장 · 아래 「에디터 — P5」) |
| Controller | `src/ui/logincontroller.*` | `LoginController(INewsModel&, Diag*)` — **위젯 타입 0**(소스 스캔으로 잠금). 결과는 `LoginAttempt`/`SessionCheck` 값 + `loginSucceeded`/`loginFailed` 신호 |
| 결선 | `src/shell/appshell.*` · `app/main.cpp` | 앱 창마다 Model 1개(`Options::modelFactory` — main.cpp는 창 전용 전송 = 창 전용 쿠키 자 위의 `HttpNewsModel`) + 컨트롤러 1개 |

### 실패 축 — `outcome`으로만 가른다

**컨트롤러는 `body.reason`을 읽지 않는다**(소스 스캔 `neverReadsTheReasonToken`으로 잠금). 로그인 429는 express-rate-limit의
text/html이라 Model body가 `{ok:false, reason:"invalid-response"}` — **깨진 프록시 페이지와 같은 body**다(step8 발견). reason으로
가르면 IP 제한이 「응답 깨짐」으로 보인다. `outcome`(전송 계층의 (라우트, 상태, 토큰) 판별)만이 둘을 가른다.

| outcome | 종류 | 문장의 요지(전부 서로 다름 — `givesEveryKindItsOwnSentence`) |
|---|---|---|
| `InvalidCredentials` (401) | InvalidCredentials | 아이디 또는 암호가 올바르지 않다 |
| `AccountLocked` (423) | AccountLocked | **이 계정**이 잠겼다 — 올바른 암호도 거부된다 · 잠시 후/관리자 |
| `RateLimited` (429) | RateLimited | **이 컴퓨터(IP)**의 시도가 너무 많다 — 계정과 관계없이 잠시 뒤 |
| `Forbidden` (403) | Refused | 서버가 이 계정의 로그인을 거부했다(사용 중지 등) |
| `NetworkError` | Unreachable | 서버에 연결하지 못했다 |
| `Timeout` | TimedOut | 제한 시간 안에 응답이 없다 |
| `InvalidResponse` | InvalidResponse | 기사 서버의 응답이 아니다(프록시·인증 페이지) |
| 그 밖(`Unauthenticated`·`ServerError`…) · 2xx인데 `ok:true` 아님 | Unexpected | 로그인하지 못했다(HTTP 상태) |

서버 정책 숫자(5회·15분·10회)는 문장에 넣지 않았다 — 서버가 소유하고 바뀔 수 있다. **423/429는 실기로 재현하지 않는다**
(`open_questions` (3) 확정 — 계정 잠금 5회/15분 · IP 10회/15분이 뒤 시나리오를 죽인다). 단위로만 잠갔고, 그 단위는 **와이어 모양
응답을 생산 코드(`modelResultFrom` ∘ `classifyResponse`)로 정규화**해 컨트롤러에 넣는다(`tests/loginwire.h`) — 가짜가
429의 `invalid-response` body를 흉내 내지 않고 **실제 정규화가 만든다**.

### 신원은 캐시하지 않는다 (decisions (7) · override L123-128)

- 로그인 응답의 `user`는 **읽지도 않는다.** 화면 전환의 첫 동작이 `GET /api/session`이고(`confirmSession()`), 거기서 얻은 것은
  **표시 라벨**(`유저아이디 · 부서 · (권한)` — UI_GUIDE 상단바)뿐이다. 역할 기반 진리표는 없다(P7).
- 서버가 로그인과 확인 사이에 계정을 바꾸면 라벨이 서버를 따른다 · 두 번 확인하면 두 번 묻는다(`confirmsTheIdentityWithTheServerNotTheLoginAnswer`).
- 로그인 결과에 sessionId 없음(step8) — 세션은 창 전송의 쿠키 자에만 있고 **디스크에 쓰지 않는다**(드라이버가 user-data에
  `config.json` 외 파일 0을 실측).

### 화면 전환 (합성 루트 = `AppShell`)

| 사건 | 전환 |
|---|---|
| `loginSucceeded` | `confirmSession()` → ok: 목록 슬롯 + 표시 라벨 / **확인 못 함**(401·무응답·비-JSON): 로그인 페이지 + 사유(**fail-closed** — 확인 안 된 신원으로 목록을 열지 않는다). **step11 갱신**: 이 확인은 이제 목록 진입(`ListController::enter()`)의 첫 동작이다 — 같은 구현 `checkSession()`, 요청 수 동일(session 1) |
| `loginFailed` | 로그인 페이지에 머묾 + 문장. 신원 확인 요청 **0** |
| 세션 종료(신원 확인 401 · 스트림의 `unauthorized` 프레임/열리기 전 401) | 로그인 페이지 + 「세션이 끝났습니다」. step9 `onSessionEnd`의 결선점은 `AppShell::sessionEndHandler()` — 순서는 `onStatus(false)` → 핸들러(`goesBackToLoginWhenTheStreamEndsTheSession`) · 셸이 사라진 뒤 불려도 무동작(`QPointer`). **step10 실기 경로에는 스트림이 없다** — step11의 `subscribe`가 이 핸들러를 넘긴다 |

**P5 갱신**: 목록 ↔ 편집 페이지 전환은 `AppShell`이 아니라 **`ui::WriterHost`** 몫이다 — 행 더블클릭 → 편집 페이지가 먼저 현재가
되고(목록 이탈 = 스트림 stop) 그 뒤 조회·잠금 · [닫기] → unlock → 목록 페이지(셸이 위 「목록 진입」을 그대로 다시 돈다) · 메인 창 닫힘 →
unlock(목록 재진입 없음). 아래 「에디터 — P5」 장의 「편집 페이지와 상태 기계」.

diag: 컨트롤러는 `login{status}`·`session{status}`만 쓴다(응답 없음 = `null` · 필드 화이트리스트는 step4 `contractedFields()`).
**`login` 줄이 먼저 디스크에 쓰이고 그 다음 신호가 나간다** — 그래서 성공 경로의 diag가 `login{200}` → `net-request{session}` 순이다.

### 자동화 훅 `--scenario login` — 사고 방지 장치이지 보안 경계가 아니다

- **누구나 환경변수를 켤 수 있다.** 이 가드가 막는 것은 **실수로** 자동 로그인 경로가 도는 것(바로가기의 잘못된 인자, 복사한 명령줄)이지
  의도적 사용이 아니다. 「가드가 있으니 안전하다」로 읽지 마라 — ADR-018 결정 ②·트레이드오프 ④가 같은 문장을 이미 적었다(step1).
- **fail-closed**: `--scenario`처럼 **보이는 것**(`--scenario=login` 포함)은 `CLIENT_SELFTEST`가 **정확히 `1`**이 아니면 `main()`의
  **맨 처음**에서 거부된다 — 잠금·폴더·diag·창·요청 전부 0, stderr에 고정 ASCII 문장, **exit 2**(`kScenarioRefusedExitCode` — 크래시·
  DLL 부재 `0xC0000135`·selftest 실패 1과 구분). 가드를 통과해도 이름 없음·모르는 이름·중복·`--selftest` 동반·자격 누락은 전부 거부다.
  거부 문장은 **인자도 자격도 되풀이하지 않는다**(인자가 잘못 입력된 암호일 수 있다 — `neverEchoesAnArgumentOrACredential`).
- 훅이 하는 일은 **컨트롤러의 `login()` 1회 호출**뿐이다(위젯을 누르지 않는다 — 훅 실행 뒤에도 입력 필드는 빈 채다). 전송은 실제 HTTP.
  그 뒤 전환은 버튼과 **같은 경로**(컨트롤러 신호)다. 앱 창이 없으면(서버 주소 미설정) 호출할 것이 없으므로 exit 3.
- 자격은 env `CLIENT_SCENARIO_USER`·`CLIENT_SCENARIO_PASSWORD`(이름은 `appidentity.h`)로만 받고 컨트롤러에 한 번 넘긴 뒤 **로컬 사본을
  지운다**(best-effort — **환경 블록에는 프로세스 수명 동안 남는다**. 그것은 하네스가 소유한다).
- **이월(P8)**: 프로덕션 빌드에서 훅 코드를 **컴파일 타임에 제거**(별도 빌드 구성/매크로)하는 것은 배포 형상 결정과 함께 가야 하므로
  P8로 넘긴다 — 그때까지 「env 하나로 켜지는 자동 로그인 경로가 배포물에 있다」가 사실이다. step12 `forward_notes`가 이 이월을 소유한다.
- 수동 실증(AC): `CLIENT_SELFTEST` 없이 `cmd /c client-qt\run.bat --scenario login`(자격은 줌) → **exit 2 · 121 ms** · stderr
  `news-client: --scenario is refused: CLIENT_SELFTEST=1 is not set (the scenario hook is a harness-only path)` · 실사용자
  `%APPDATA%\기사작성기-qt` 전후 부재 · 출력에 암호 0.

### 드라이버 `--scenario login` (`scripts/verify-qt-client.mjs`)

한 서버 인스턴스에서 로그인 시도는 **3회**(교차 1 · 성공 1 · 거부 1)뿐이다.

| 단계 | 내용 |
|---|---|
| G | `CLIENT_SELFTEST`만 뺀(자격은 준) 클라 → exit 2 · stderr에 가드 문장 · diag 파일·user-data 폴더 **미생성** · 출력에 암호 0. 설정 파일을 두지 않으므로 가드가 깨져도 이 단계에서 로그인은 일어날 수 없다(예산·세션 무소비) |
| X | **클라 기동 전에** 드라이버가 같은 계정(desk)으로 Node fetch 로그인 → 200 · `sessionId` · `sid` 쿠키 · 그 세션으로 `/api/session` 200 |
| L+ | `app-ready` → `config-loaded{true}` → `app-window{origin}` → `net-request{login,200}` → `login{200}` → `net-request{session,200}` → `session{200}` |
| X2 | 클라가 `session{200}`까지 간 뒤 드라이버의 X 세션 → **401** — 같은 계정의 새 로그인이 서버에서 기존 세션을 끊었다 = 클라 로그인이 **이 서버에 desk로** 닿았다(자기 신고가 아닌 서버 측 사실) |
| L- | 틀린 암호(실행마다 새 난수) **1회** → `login{401}` · `session` 0 · `list-loaded` 0 |

**교차 순서가 규칙이다**: 같은 계정 로그인은 그 계정의 기존 세션을 **전부** 끊는다(`src/services/sessionService.js` `createSession` ·
`server-spring` `SessionStore.createSession`). step10.md D.4 문구대로 클라 **뒤에** 드라이버가 desk로 로그인하면 **드라이버가 클라 세션을
죽인다**(step9 실측). 그래서 X를 클라 앞에 두었고, 역방향으로 클라가 드라이버 세션을 끊는 사실(X2)을 교차 증거로 쓴다.
두 실행 모두: 라우트 원장(계약 39 안 · 금지 2 0건 · `login`/`session` **정확 횟수** · **그 밖 라우트 0**) · 허용 이벤트 집합 ·
diag 전문·stdout·stderr **암호 0건**(원문 + JSON 이스케이프 형) · user-data에 `config.json` 외 파일 0 · 앱이 판정 시점까지 생존.

실측 diag 원문(spring · L+ · `--keep`으로 보존한 파일 그대로):

```
{"ts":"2026-09-11T18:24:00.684Z","event":"app-ready"}
{"ts":"2026-09-11T18:24:00.686Z","event":"config-loaded","hasServerUrl":true}
{"ts":"2026-09-11T18:24:01.372Z","event":"app-window","origin":"http://127.0.0.1:46822"}
{"ts":"2026-09-11T18:24:01.449Z","event":"net-request","method":"POST","ms":76,"route":"login","status":200}
{"ts":"2026-09-11T18:24:01.449Z","event":"login","status":200}
{"ts":"2026-09-11T18:24:01.455Z","event":"net-request","method":"GET","ms":4,"route":"session","status":200}
{"ts":"2026-09-11T18:24:01.455Z","event":"session","status":200}
```

L-는 앞 3줄 뒤 `{"event":"net-request","method":"POST","ms":125,"route":"login","status":401}` · `{"event":"login","status":401}`로 끝난다.

### 사각지대 (정직하게)

- **step10의 드라이버는 「네트워크 없는 페이지 전환」을 보지 못한다.** 실패 경로에서 신원 확인 없이 목록 슬롯만 보여 주는 변이(M10-2b)는
  QtTest 2건이 red지만 드라이버는 green이다 — 빈 목록 슬롯은 아무 요청도 diag도 남기지 않는다. step11이 목록 화면을 슬롯에 넣으면
  슬롯 표시 = `queryArticles`(`net-request{articles-list}`·`list-loaded`)가 되어 **드라이버의 `list-loaded 0` 단언이 그때 비공허해진다.**
  → **step11에서 닫혔다**(아래 「목록 화면」 변이표 M10-2b 재실증 — 목록 페이지는 어떤 경로로 현재가 되든 목록 진입을 거친다).
- 423/429 실기 미재현(위) · 스트림 결선은 단위만(위).

### 변이 결과표 (2026-09-12 · 전건 기대 = 실제 · 원복은 소스 diff 0으로 판정)

| 변이 | 내용 | 결과 |
|---|---|---|
| **M10-1** | 423 문장을 401 문장과 같게 | `build.bat` exit 1 · 2 red(`reportsTheAccountLockOn423` · `givesEveryKindItsOwnSentence`) |
| **M10-2** | 로그인 실패인데 전환 경로(`onLoginSucceeded`)로 | `build.bat` exit 1 · 2 red(AppShell) + **드라이버 `--scenario login` exit 1 · L- 3 red**(화면이 넘어가지 않았다 `session=1` · 허용 집합 밖 `session` · 원장 `session` 0 기대 1 실제) |
| **M10-2b** | 로그인 실패인데 목록 슬롯만 표시(신원 확인 없음) | `build.bat` exit 1 · 2 red(`loginPageShown()` false) · **드라이버 green**(위 사각지대) |
| **M10-3** | `CLIENT_SELFTEST` 가드 제거 | `build.bat` exit 1 · 34 red(가드 행 32 · 비반향 1 · env 1) + **드라이버 exit 1 · G 3 red**(exit 3 — 부팅해 설정 화면을 띄웠다 · stderr에 가드 문장 없음 · diag·user-data 생성) |
| **M10-4** | 429를 `reason`(`invalid-response`)으로 분기 | `build.bat` exit 1 · 4 red(429 문장 · 포털 vs 429 · AppShell 문장 · 소스 스캔) |
| **J10-1** | 판정부 `judgeLogin`의 거부 판정에서 `session 0` 조건 제거 | 자기검사 51/1 red(M10-2 모양 픽스처) → 드라이버는 시작 즉시 거부 · 원복 md5 동일 |

### step11에 넘기는 사실

- 목록 화면은 **`MainWindow`의 목록 슬롯**에 넣는다. 슬롯 진입은 이미 `confirmSession()` 뒤에만 일어난다 — 목록 조회는 그 뒤에 붙인다.
- `subscribe`에는 `AppShell::sessionEndHandler()`를 넘겨라(세션 종료 → 로그인 페이지 · 순서 `onStatus(false)` → 핸들러).
- 교차 축의 트리거 계정은 **desk가 아닌 계정**(reporter)으로 — X 순서 규칙과 같은 이유다.
- `--scenario list`는 `shell/scenario.cpp`의 이름 검사 한 줄과 거부 문장을 바꾸면 된다(가드는 그대로 맨 앞).

## 목록 화면 — P4 완료 게이트 (2026-09-12 · step11)

로드맵 P4의 완료 게이트 「로그인 → 목록 **SSE 실시간 갱신** 실기 + diag 이벤트로 자동 검증」을 닫는 step이다. ADR-003 그대로
View ← Controller ← Model:

| 층 | 파일 | 하는 일 |
|---|---|---|
| Controller | `src/ui/listcontroller.*` | `ListController(INewsModel&, Diag*)` — 위젯·전송·타이머 0(소스 스캔 `dependsOnNoWidgetAndNoTimer`). 진입 = `checkSession()`(GET /api/session) → `queryArticles(deskUnsent)` → `subscribe` |
| View | `src/ui/listscreen.*` | 11컬럼 표 · 상태 배지 · 행 hover 틴트 · 페이저 · 쿼리 오류 줄 · **읽기 전용** |
| View | `src/ui/mainwindow.*` | 창 껍데기 — 목록 페이지 = `ListScreen` · 상단바(48px) 우측 실시간 표시(`● 실시간`/`● 연결 끊김`, 목록 페이지에서만) · `listPageEntered/Left` 신호. **P5 갱신**: 편집 페이지(`EditorWidget`)와 그 페이지에서만 보이는 상단 바 영역(평문 안내 문장 · [저장][복구][닫기] — 메뉴 바 대신 · 메뉴·다이얼로그는 P6) · `editorSaveRequested`/`editorRecoverRequested`/`editorCloseRequested` 신호 |
| 결선 | `src/shell/appshell.*` | 로그인 성공 → 목록 진입 → **확인된 진입만** 목록 페이지를 띄운다 · 다른 경로로 목록 페이지가 현재가 되어도 같은 진입(웹 `ListPage` 마운트 동형) · 로그인 페이지로 가면 목록 이탈(스트림 닫기·행 삭제) |
| 인벤토리 | `src/ui/screens.*` | 화면 레지스트리 `{login, list, setup}` + 창 껍데기 `{MainWindow}`. **P5 갱신**: `{login, list, setup, editor}`(`editor` = `EditorWidget`) + 창 껍데기 `{MainWindow}` |

### 목록 규율 (코드가 강제하는 것)

- **메뉴는 `deskUnsent` 1개**(`{status:['RDS','DDH']}` — `web/src/controller/useViewController.js` 70~72) · 부서는 '전체'(키 없음).
  필터는 `HttpNewsModel::queryArticles` → step7 `buildQuery`를 지난다 — 와이어 `GET /api/articles?status=RDS&status=DDH`를 스텁 서버로
  잠갔다(`spellsTheFilterWithBuildQueryOnTheWire`). 서버측 페이징 파라미터는 만들지 않는다(계약에 없다).
- **`change` = kind 무관 전체 재조회**(override L80): `onStreamEvent(StreamEvent::Change)`는 **kind를 받지도 않는다** — 분기할 재료가
  없다. 소스에 `"kind"` 리터럴 0(잠금) · create·update·lock·status·derive·kind 없는 프레임이 각각 **정확히 1회** 같은 필터로 재조회.
- **재조회 유발자는 `change`와 사용자 액션뿐**: ready(첫 ready·재연결 ready)는 실시간 표시만 켠다. 타이머 0 — 2.6초(M11-1p 주기 2초 초과)
  경과에 호출 수 불변 + 컨트롤러의 `QTimer` 자식 0 + 소스 토큰 스캔. P4 목록에는 사용자 재조회 액션이 없다(메뉴·조회 버튼은 P7).
- **병합(step9 발견 반영)**: 전송의 `send()`는 로컬 이벤트 루프로 기다리므로 그 사이 change가 도착할 수 있다. 진행 중이면 **새 조회를
  시작하지 않고 dirty만 세우고**, 끝나면 후속 재조회 **1회**. 그 후속 도중 또 오면 1회 더 — **신호는 버리지 않는다**(버리면 목록이 낡는다) ·
  동시 조회는 최대 1(겹치면 늦은 옛 응답이 새 목록을 덮는다 — 웹은 seq 가드로 막는 문제). 잠금: 조회 중 change 3건 → 후속 정확히 1회 ·
  후속 중 change → 1회 더 · 최대 깊이 1 · 최종 행 수 = 전부 반영(`mergesChangesThatArriveDuringAQuery`·`neverDropsAChangeThatArrivesDuringAQuery`).
- **진입마다 신원 재확인**(decisions (7)) — `checkSession()`은 LoginController와 **같은 구현**이다(step10의 `confirmSession()`이 이제 그것을
  부른다). 표시 라벨만 받고 보관하지 않는다. **401**(확인·조회) / **`unauthorized` 프레임** → 스트림 영구 종료 + 행 삭제 + `sessionEnded`
  → 로그인 페이지. 그 밖 조회 실패(무응답·비-JSON·5xx)는 **행 유지 + 오류 줄**, `list-loaded`를 쓰지 않는다(쓸 수가 없다).
- **페이징 10은 클라 몫**(계약에 페이징·총수 없음 — baseline (F)) · 경계 0·9·10·11·23건 잠금 · 줄어든 목록은 페이지를 끌어내리고 늘어난
  목록은 페이지 유지(`useViewController.js` 160~163) · 페이지 이동은 조회가 아니다 · **createdAt 내림차순 안정 정렬** — 서버의 ORDER BY는
  계약에 없으므로 순서는 클라가 소유한다(올바른 서버에서는 무동작 · 같은 시각은 서버 순서 유지 · 시각 없음은 끝).
- diag: `session{status}`(확인) · `list-loaded{menu,count}`(count = 전체 행 수, 페이지 행 수가 아니다) — 제목·아이디 0(바이트 검사).
- 표시: 컬럼은 **`web/src/view/columnConfig.js`를 런타임에 읽어** 카탈로그 12종(키·라벨·순서 · `distributedAt`만 기본 숨김)을 대조한 뒤
  11종을 보인다(override L97·L100 · 토글은 P7) · 시간 `YYYY-MM-DD HH:mm` **고정**, 가운데 정렬(override L104 — 전역 설정은 P6) · 배지 색은
  **`web/src/view/statusBadge.js` 11종을 런타임에 읽어 대조**(UI_GUIDE 6종은 값으로도 잠금) · 표는 UI_GUIDE `.yh-table`(thead `#f5f5f5` ·
  th 하단 2px 블루 · td 1px `#ddd` · 행 hover 틴트 `rgba(10,77,166,0.08)`) · 우클릭·더블클릭·편집·선택·헤더 클릭 정렬 없음.
  **P5 갱신**: 행 **더블클릭**이 목록 화면의 **유일한 동작**이 됐다 — `ListScreen`은 신호 `articleOpenRequested(articleId)`로 그 행의
  기사 id만 이름 붙이고 Model에 닿지 않는다(조회·잠금·표시는 `ui::WriterHost`). 우클릭·선택·헤더 정렬은 여전히 없다(P7) —
  `ListScreenTest`의 `isReadOnly`는 `isReadOnlyButForTheOneEditingPath`로 의도적으로 갱신됐다.

### 「화면」의 정의와 인벤토리 잠금 (decisions (5))

- **화면 = 사용자에게 보이는 최상위 창, 또는 그 창의 주 내용 패널 하나.** `MainWindow`는 **창 껍데기**(로그인·목록 화면이 번갈아 앉는 틀)이지
  화면이 아니다. 그러므로 P4의 화면 id는 `login`(`LoginScreen`) · `list`(`ListScreen`) · `setup`(`SetupScreen`) **3개**다.
- 레지스트리: `ui::screenRegistry()` = `{login, list, setup}`(클래스 이름은 `staticMetaObject`로 컴파일 결박 — 없는 클래스는 빌드되지 않는다) ·
  `ui::windowShellClasses()` = `{MainWindow}`. 네 번째 화면을 **등록**하면 `registersExactlyTheThreeP4Screens`가 red.
- **P5 갱신(phase 78 step8)**: 레지스트리는 이제 **화면 4개** `{login, list, setup, editor}`다 — `editor` = `EditorWidget`(편집 페이지의 주 내용
  패널 · 래퍼 화면 없음). 테스트 이름이 `registersExactlyTheThreeP4Screens` → **`registersTheThreeP4ScreensAndTheP5Editor`**(기대 4)로 바뀌었고,
  **다섯 번째**를 등록하면 red다. 창 껍데기는 그대로 `{MainWindow}`이고 다이얼로그 0(`sourcesOpenNoDialogWindow`)도 그대로다 — P5의 파일>복구에
  확인창이 없는 이유다. 아래 변이표 M11-4의 함수 이름은 그 시점의 기록이라 고치지 않았다.
- **소스 스캔 교차(규칙과 한계 한 줄)**: `client-qt/src/**`·`client-qt/app/**`의 모든 `.h`/`.cpp`(빌드 포함 여부 무관)에서 주석을 걷어내고
  `class|struct X [final] : … {`의 기반이 Qt 위젯 이름 패턴(`Q…Widget|Window|Dialog|Frame|View|Area|Edit|Box|Label|Button|Bar|Splitter|Wizard|Page`)
  이거나 이미 찾은 위젯 클래스면(추이) 위젯 클래스로 세고, 그 집합이 **레지스트리 ∪ 창 껍데기와 정확히 같아야** green이다 — **한계**: 서브클래스
  없이 만든 창(`new QWidget` 최상위 표시 같은 동적 생성)·매크로/`#if 0`/별칭으로 만든 클래스·패턴 밖 Qt 기반 이름은 보지 못한다(다이얼로그 종류만은
  `QDialog`·`QMessageBox`·`QMainWindow` 등 이름 토큰이 주석 밖에 0개임을 따로 잠갔다 — `sourcesOpenNoDialogWindow`).
- 스캐너 자체는 알려진 입력으로 잠갔다(`scannerFindsWidgetClassesAndOnlyThose` — 추이·`final`·다중 기반·한정 이름·주석·URL 문자열·raw 문자열·
  비위젯 기반·전방 선언·`enum class`).

### 드라이버 `--scenario list` (완료 게이트 · `scripts/verify-qt-client.mjs`)

| 단계 | 내용 |
|---|---|
| R | 드라이버가 **reporter** 세션으로 로그인 → 사전 기사 **11건**(N0가 한 페이지를 넘게 — `list-loaded{count}`가 페이지 행 수가 아니라 전체 수임을 가른다) → 서버가 센 deskUnsent 수 **N0**(`GET /api/articles?status=RDS&status=DDH`) |
| C | 클라(`--scenario list` · **desk**) → `app-window` → `login{200}` → `session{200}` → `net-request{articles-list,200}` → `list-loaded{deskUnsent,N0}` → `net-request{stream,200}` → `sse-open` → `sse-ready` |
| T | **`sse-ready`를 본 뒤에만** reporter가 기사 1건 생성 → `sse-change`(≥1 · kind 무관) → `net-request{articles-list,200}` → `list-loaded{N0+1}` · 서버 수 N0+1 교차 |
| H | **관측 창 5초**(M11-1p 2초 주기의 2.5배) — 주기 재조회 앱은 이 사이 `articles-list`를 더 부른다 → 종료 → `judgeList` |

판정식은 **세 조건의 논리곱**(`scripts/lib/qtClientDiag.mjs` `judgeList` 10항목): **(i)** 트리거 시각 ≥ `sse-ready` ts · **(ii)** `sse-ready` 뒤
`sse-change` ≥1 → `articles-list` 200 → `list-loaded{N0+1}` · **(iii)** 시나리오 전 구간 `articles-list` **정확히 2**. 그 밖에 진입(N0 = 서버가 센
수) · login 1·session 1 · list-loaded 2 · 허용 집합(**`sse-unauthorized`·`sse-closed` 없음** = 클라 세션·스트림이 끝까지 살아 있다) · 원장(계약
39 안 · 금지 0 · 기대 4 포함 · 그 밖 0). 교차: 서버 수 N0 → N0+1 · diag·stdout·stderr에 **비밀번호·기사 제목 12·기사아이디 12 = 25종 0건** ·
user-data에 `config.json` 외 0.

- **계정 분리가 규칙이다**: 같은 계정 로그인은 그 계정의 기존 세션을 전부 끊는다(step9·10 실측). 드라이버가 desk로 로그인하면 클라의
  세션과 스트림이 401로 죽고 그것이 클라 버그처럼 보인다 — 그래서 트리거 주체는 reporter다.
- **(iii)이 결정적인 이유**: `POST /api/articles`는 `notifyChange('create')`를 정확히 1회 낸다 · P4 목록엔 액션이 없어 클라가 스스로
  change를 만들지 않는다 · 트리거는 진입 조회 뒤다 ⇒ 진입 1 + 신호 후 1 = 2. `sse.md`의 경고(정확 kind·개수 단언은 flake)는 kind와 프레임
  개수에 대한 것이고, 게이트는 kind를 단언하지 않고 **호출 횟수**를 센다.
- 로그인 시도는 서버 인스턴스당 list 2회(reporter·desk) · all 5회(login 3 + list 2) — IP 제한 10회/15분 안.
- **로그인 판정(step10)의 갱신**: 성공 경로가 이제 목록까지 이어진다 — L+ 시퀀스에 `articles-list` → `list-loaded` → `stream` → `sse-open` →
  `sse-ready`를 붙이고 원장을 `login 1 · session 1 · articles-list 1 · stream 1 · 그 밖 0`으로 · L-는 `session 0 · list-loaded 0 · articles-list 0`.

실측 diag 원문(exe · 1회차 — 제목·아이디 없음):

```
{"ts":"2026-09-11T19:28:12.570Z","event":"app-ready"}
{"ts":"2026-09-11T19:28:12.570Z","event":"config-loaded","hasServerUrl":true}
{"ts":"2026-09-11T19:28:13.267Z","event":"app-window","origin":"http://127.0.0.1:46429"}
{"ts":"2026-09-11T19:28:13.426Z","event":"net-request","method":"POST","ms":135,"route":"login","status":200}
{"ts":"2026-09-11T19:28:13.426Z","event":"login","status":200}
{"ts":"2026-09-11T19:28:13.426Z","event":"net-request","method":"GET","ms":3,"route":"session","status":200}
{"ts":"2026-09-11T19:28:13.426Z","event":"session","status":200}
{"ts":"2026-09-11T19:28:13.426Z","event":"net-request","method":"GET","ms":4,"route":"articles-list","status":200}
{"ts":"2026-09-11T19:28:13.426Z","event":"list-loaded","count":11,"menu":"deskUnsent"}
{"ts":"2026-09-11T19:28:13.442Z","event":"net-request","method":"GET","ms":6,"route":"stream","status":200}
{"ts":"2026-09-11T19:28:13.442Z","event":"sse-open"}
{"ts":"2026-09-11T19:28:13.442Z","event":"sse-ready"}
{"ts":"2026-09-11T19:28:13.590Z","event":"sse-change","kind":"create"}
{"ts":"2026-09-11T19:28:13.612Z","event":"net-request","method":"GET","ms":27,"route":"articles-list","status":200}
{"ts":"2026-09-11T19:28:13.612Z","event":"list-loaded","count":12,"menu":"deskUnsent"}
```

| 실행 | 결과 |
|---|---|
| `--scenario list --server exe` 1·2회차 | exit 0 · 판정 30 · 실패 0 · N0=11 → 12 · articles-list=2 · 트리거는 ready 뒤 118/43 ms · 재조회는 트리거 뒤 148 ms(1회차) |
| `--scenario list --server spring` 1·2회차 | exit 0 · 판정 30 · 실패 0 · N0=11 → 12 · articles-list=2 · 트리거는 ready 뒤 12/91 ms · 재조회는 트리거 뒤 141 ms(1회차) |
| `--scenario all` exe · spring | exit 0 · 관측 40(A 4 · B 4 · G 0 · L+ 12 · L- 5 · list 15) · 판정 83 · 실패 0 |

### 육안 확인 (P4의 유일한 육안 항목 · 2026-09-12)

`CLIENT_SELFTEST` **없이** `cmd /c client-qt\run.bat`으로 띄운 **실제로 보이는 앱**(훅 없음 · 임시 `CLIENT_USER_DATA` · 임시 `DATA_DIR`의 Node exe
서버 · 사전 기사 11건). 로그인은 창에 입력했다(전경 창이 news-client일 때만 키를 보내고, 한글 IME가 글자를 바꾸지 못하게 붙여넣기로).

- 로그인 카드 → **목록이 실제로 그려진다**: 상단바 우측 `desk · 편집부 · (D) ● 실시간`(빨간 점) · 「데스크 미송고」 · **11컬럼**(배부시간 없음) ·
  최신순 10행 · 시간 `YYYY-MM-DD HH:mm` 가운데 · 회색 RDS 배지 · 페이저 `이전(비활성) 1 / 2 · 총 11건 다음`.
- 다른 곳(Node fetch · reporter 세션)에서 기사를 만들자 **조작 없이 목록이 스스로 갱신됐다** — 새 기사가 맨 위, `총 12건`(diag `list-loaded` 11 → 12,
  트리거 뒤 211 ms · 같은 실행의 diag는 게이트와 같은 15줄).
- 시간 칸은 저장된 UTC 자릿수 그대로다(`listFormat.js`와 같은 규약 — 타임존 이동 없음 · 전역 형식 설정은 P6).
- 스크린샷은 리포 밖(오케스트레이터 스크래치패드 `s11-visual-0-login.png`·`s11-visual-1-list.png`·`s11-visual-2-updated.png`)에 두었다.

### 변이 결과표 (2026-09-12 · 전건 기대 = 실제 · 원복은 소스 diff 0으로 판정)

변이는 스크래치 도구가 정확한 한 곳 문자열 치환으로 심고 되돌렸다. 원복 증거는 매번 `git diff --stat -- client-qt/src client-qt/app
client-qt/tests` 무출력이다(재빌드한 exe는 md5가 매번 다르다).

| 변이 | 내용 | QtTest(`build.bat`) | 드라이버 |
|---|---|---|---|
| **M11-1** | change 수신 시 재조회하지 않음 | exit 1 · 10 red(신호당 1회 · kind 무관 · 병합 2 · 401 종료 · 조회 실패 · 페이지 클램프 · 재진입 · diag · AppShell 화면 갱신) | `--scenario list` exe **exit 1 · 6 red** — **(ii)**(`missing=net-request`) · **(iii)**(`articles-list=1`) · 관측 13 < 15 · list-loaded 1 · 원장 · T 대기 |
| **M11-1p** | SSE 무시 + **2초 주기 타이머** 재조회 | exit 1 · 12 red(M11-1의 10 + `hasNoPeriodicTimer` + 소스 스캔 `QTimer`) | exe **exit 1 · 3 red** — **(ii)는 green**(주기 조회가 N0+1을 가져왔다) · **(iii) `articles-list=4`** · list-loaded 4 · 원장. (ii)만 있었다면 통과했다 — (iii)이 있는 이유 그대로 |
| **M11-2** | 재조회는 하되 화면 갱신 없이 `list-loaded`만 | exit 1 · 2 red(`showsTheListAndRefreshesTheScreenOnAChange` · `leavesTheListWhenGoingBackToLogin`) | exe **exit 0 — 잡지 못한다**(diag는 픽셀을 보지 못한다 — QtTest와 육안 확인이 그 자리를 메운다) |
| **M11-3** | 필터를 `{status:['RDS']}`로 | exit 1 · 3 red(`queriesTheDeskUnsentFilter` · 와이어 `status=RDS&status=DDH` · AppShell 행 수) | exe **exit 0 — 잡지 못한다**(사전·트리거 기사가 전부 RDS다 — reporter는 DDH를 만들 수 없고 드라이버는 desk로 로그인하지 않는다) |
| **M11-4** | 화면을 하나 더 **등록**(`detail` → `ListScreen`) | exit 1 · 1 red(`registersExactlyTheThreeP4Screens` — Actual 4 / Expected 3) | — |
| **M11-5** | 화면 클래스를 하나 더 만들되 **미등록**(`class DetailScreen : public QWidget` — `listscreen.h`) | exit 1 · 1 red(`sourcesHoldNoUnregisteredWidgetClass` — 「widget classes nobody registered: DetailScreen」). 자기신고 레지스트리만 있었다면 green이었다 | — |
| **M10-2b 재실증** | 로그인 실패인데 목록 페이지를 표시(신원 확인 없이 — step10과 같은 한 줄) | exit 1 · 2 red(`staysOnTheLoginPageWhenLoginFails` · 훅 경로) | `--scenario login` exe **exit 1 · L- 3 red** — 화면이 넘어가지 않았다 `session=1` · 허용 집합 밖 `session` · 원장 `session` 0 기대 1 실제 → **step10 사각지대가 닫혔다** |

M10-2b의 드라이버 증거는 `articles-list`가 아니라 **목록 진입의 신원 확인 요청**이다 — 목록 페이지가 현재가 되면 진입이 먼저 신원을 묻고,
세션이 없으니 401로 **조회 전에** 로그인 페이지로 되돌린다(그래서 `articles-list`·`list-loaded`는 0으로 남는다 · L-는 셋 다 0을 단언한다).
판정부 쪽은 같은 모양들을 픽스처로 잠갔다(M11-1 · M11-1p · ready 재조회 · 낡은 수 · 트리거 선후 · 세션 종료 · 거부 경로의 `articles-list`) —
자기검사 52 → 65.

### 사각지대 (정직하게)

- **M11-2·M11-3은 드라이버가 잡지 못한다**(위 표) — 각각 QtTest가 잡는다.
- **폴링 배제는 관측 창(5초) 안의 주기에 대해서만 결정적이다.** 창보다 긴 주기의 폴링 앱이 우연히 트리거 직후 조회하고 창 안에서 다시
  조회하지 않으면 통과할 수 있다. M11-1p(2초 주기)는 결정적으로 red다.
- **놓친 신호는 다음 신호까지 목록을 낡게 둔다**: ready는 재조회하지 않으므로 진입 조회와 스트림 ready 사이, 그리고 일시 단절 동안의
  변경은 다음 change가 올 때까지 반영되지 않는다 — 웹 정본(ready → `setLive`만)과 같은 동작이고 게이트 (iii)의 전제다(P5·P7 재검토 후보).
- 423/429 실기 미재현(step10) · 목록의 우클릭·편집·상세·컬럼 설정·검색·6메뉴는 P7 · 날짜 전역 설정은 P6.

## 무엇이 P4가 아닌가

| 범위 밖 | 소유 phase |
|---|---|
| 에디터(텍스트 엔진·블록 모델·IME·undo·자동저장) | P5 |
| 임베드·맞춤법·찾기바꾸기·표·인쇄·다이얼로그 17종·환경설정 8탭·i18n | P6 |
| 조회 6메뉴·컬럼 설정·우클릭 14액션·상세보기 창·관리 4화면 | P7 |
| 한글 제품명 exe·아이콘·windeployqt·설치 패키징·Electron 은퇴 | P8 |

**서버·웹·Electron 클라·계약(`server/**`·`src/**`·`web/**`·`client/**`·`contract/**`·`docs/api-contract/**`)은 이
모듈이 한 줄도 고치지 않는다.** 계약은 동결(P1)이고 클라이언트는 그것만 믿는다.

## P4 마감 (2026-09-12 · step12)

### 마감 실측 — 연속 2회 (두 회차 수치 전건 동일 · flake 0)

같은 트리(`feat-77-qt-client-skeleton` · HEAD `8544a1b` · 트리 clean)에서 **전 커맨드를 연속 2회** 돌렸다.
시간은 프로세스 전체 소요(ms)이고, 괄호 안은 그 커맨드가 자기 입으로 보고한 수치다.

| # | 커맨드 | 회차 1 | 회차 2 |
|---|---|---|---|
| 1 | `cmd /c client-qt\build.bat` | exit 0 · 35,440 ms · `Totals: 305 passed, 0 failed (classes: 24)` · `BUILD OK` | exit 0 · 35,776 ms · **동일** |
| 2 | `verify-qt-client --scenario boot --server exe` | exit 0 · 4,231 ms · 관측 8(A 4 · B 4) · 판정 33 · 실패 0 | exit 0 · 4,330 ms · **동일** |
| 3 | `verify-qt-client --scenario login --server exe` | exit 0 · 5,499 ms · 관측 17(G 0 · L+ 12 · L- 5) · 판정 40 · 실패 0 | exit 0 · 5,504 ms · **동일** |
| 4 | `verify-qt-client --scenario list --server exe` | exit 0 · 7,891 ms · 관측 15 · 판정 30 · 실패 0 | exit 0 · 7,897 ms · **동일** |
| 5 | `verify-qt-client --scenario list --server spring` | exit 0 · 11,786 ms · 관측 15 · 판정 30 · 실패 0 | exit 0 · 12,006 ms · **동일** |
| 6 | `npm test` | exit 0 · 21,453 ms · tests **1349** · pass 1349 · fail 0 · skipped 0 · suites 59 | exit 0 · 21,466 ms · **동일** |
| 7 | `npm run lint` | exit 0 · 7,032 ms | exit 0 · 7,123 ms |
| 8 | `npm run build` | exit 0 · 3,336 ms · `built in 2.08s`(3파일) | exit 0 · 3,377 ms · `built in 2.01s` |
| 9 | `node scripts/spa-parity.mjs --java-home …` | exit 0 · 6,405 ms · 관측 **39** · diffs **0** · 허용 diff 528 | exit 0 · 6,174 ms · **동일** |
| 10 | `node scripts/spool-parity.mjs --java-home …` | exit 0 · 7,367 ms · 폴더 3 · 파일 11 · diffs **0** · 눈감은 자리 66/66(db=sqlite) | exit 0 · 7,595 ms · **동일** |
| 11 | `node scripts/spring-contract.mjs --parity --java-home …` | exit 0 · 55,755 ms · **313관측 diffs 0**(default 246 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) | exit 0 · 55,851 ms · **동일** |
| 12 | `git status --porcelain` | **무출력** | **무출력** |

- **자산 지문(두 회차 · 각 회차의 측정 전·후 전부 동일)**: 리포 `news.db` **606,208 B · md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` 무변**(읽기만 — DB로 열지 않았다) ·
  `uploads/` **32파일 6,068,792 B** · `client-qt/release/news-client.exe` **362,496 B**(재빌드해도 크기는 같다 — **md5는 빌드마다 다르므로 원복 판정은 언제나 소스 diff로** 한다).
- **`--java-home`이 필요한 이유**: 이 셸에는 `JAVA_HOME`이 없다. 9·10·11번은 `--java-home D:/agents/tools/jdk-25.0.4.1+1`(또는 `SPRING_JAVA_HOME`)이 없으면 **usage로 exit 1**이고, 그것은 회귀가 아니다.
- **미측정(정직하게)**: `server-spring`의 `./mvnw clean verify`와 `tools/news-migrator`의 `clean verify`는 **이 phase에서 한 번도 돌리지 않았다**. 이 phase는 Java를 한 줄도 고치지 않았고
  (`git diff -- server-spring tools` 무출력) spring 모드 하네스는 step0이 `-DskipTests package`로 만든 jar를 그대로 쓴다. **그러므로 「Java 테스트 1526/0」을 이 phase의 실측으로 인용하지 마라** — 그것은 phase 76의 값이다.

### 무엇이 기계로 판정되는가 (그리고 무엇이 아닌가)

**아래 표의 각 행은 실제로 도는 커맨드·테스트가 있다.** 대응이 없는 주장은 적지 않는다 — 있는 척하는 게이트가 가장 비싼 부채다.

| 축 | 판정자 | 기준값(2026-09-12) |
|---|---|---|
| Qt 모듈 전부(셸 순수 판정 · net · 컨트롤러 · 화면) | `cmd /c client-qt\build.bat`(빌드 + `tests/release/client-qt-tests.exe`) | **310 passed · 0 failed · 25 classes**(④⑤ 게이트 후 — 위 마감 실측표의 305/24는 `8544a1b` 시점의 역사값이다). **실행한 테스트 함수가 0이면 러너가 green을 거부**한다(exit 2) |
| 라우트 표 ↔ 동결 계약 39 · Model 35 · `x-edit-client` 3 · 금지 2 | 같은 커맨드 안의 `RouteContractTest` C-1~C-8(`docs/api-contract/endpoints.json`·`web/src/model/contract.js`를 **런타임에 읽는다**) | 표 37 + 금지 2 = 39 · `MODEL_KEYS` 35 개수·이름·순서 일치. **계약 파일이 없으면 skip이 아니라 FAIL 11** |
| diag JSONL 계약(허용 이벤트 21 · 금지 키 7 · URL 리댁션 · 정본 바이트 대조) | `DiagTest` | 정본 `client/diag.js` 출력과 **바이트 동일**(매 빌드 로그에 두 줄이 나란히 찍힌다) |
| SSE 프레임 파싱 · 종결 4사유 · 백오프 · 세션 종료 | `SseParserTest`·`ChangeStreamTest`(루프백 chunked 스텁) | 파서 16케이스 · 스트림 20케이스 |
| 화면이 3개뿐인가(범위 확장 감지) | `ScreenInventoryTest` — 레지스트리 + `client-qt/src/**`·`app/**` 소스 스캔 교차 | `{login, list, setup}` + 창 껍데기 `{MainWindow}`. 네 번째를 **등록해도**(M11-4) **등록하지 않아도**(M11-5) red |
| 부팅 2경로 · 단일 인스턴스 · 실사용자 폴더 무변 | `node scripts/verify-qt-client.mjs --scenario boot --server exe` | 관측 8 · 판정 33 · 실패 0 |
| 로그인 성공/거부 · 훅 가드 거부 · 비밀번호 유출 0 · 라우트 원장 | `… --scenario login --server exe` | 관측 17 · 판정 40 · 실패 0 |
| **P4 완료 게이트**(로그인 → 목록 → SSE 실시간 갱신) | `… --scenario list --server exe` **와** `--server spring` | 각각 관측 15 · 판정 30 · 실패 0 · N0 **11 → 12** · `articles-list` **정확히 2** |
| 판정부 자신의 비공허성 | 드라이버가 시작 시 `scripts/lib/qtClientDiag.self-test.mjs`를 돌린다(pass ≥ 1 · fail 0) + `npm test`의 `test/harness-vacuity-guards.test.js`가 고아 자기검사를 red로 만든다 | 자기검사 65 · 고아 0 |
| 기존 축(웹·서버·계약) 무회귀 | `npm test` · `npm run lint` · `npm run build` · `spa-parity` · `spool-parity` · `spring-contract --parity` | 위 실측표 6~11 |

**기계가 판정하지 않는 것 — 여기에 있는 항목을 「검증됐다」고 적지 마라.**

1. **화면 픽셀.** diag는 앱의 자기 신고이고 화면을 보지 못한다. 재조회는 하되 화면을 갱신하지 않는 변이(M11-2)에서 **드라이버는 green**이었다 — 그 자리는 `ListScreenTest`/`AppShellTest` 2건과 **육안 1항목**이 메운다.
2. **목록 필터의 내용.** 필터를 `{status:['RDS']}`로 좁히는 변이(M11-3)도 **드라이버 green**이다(사전·트리거 기사가 전부 RDS다). `ListControllerTest`와 와이어 테스트가 잡는다.
3. **요청 body shape의 전수 일치.** 라우트 표 대조가 보증하는 것은 「클라가 계약 밖 경로를 부르지 않는다」와 「부른 경로가 계약에 있다」까지다(step8 한계 문장 그대로). 본문 구성은 실기 200으로만 부분 확인된다.
4. **실서버 왕복은 Model 35 중 6개**(`login`·`restoreSession`·`logout`·`queryArticles`·`subscribe` + 선택 `getArticle`)까지다. 나머지 29개는 **스텁 서버 위 요청 조립만** 잠갔다.
5. **423(계정 잠금)·429(IP 제한)는 실기로 재현하지 않는다**(확정 결정 — 같은 인스턴스에서 재현하면 이후 시나리오의 로그인이 죽는다). 순수 매핑만 단위로 잠갔다.
6. **폴링 배제는 관측 창(5초) 안의 주기에 대해서만 결정적이다.** 2초 주기(M11-1p)는 결정적으로 red지만, 창보다 긴 주기는 통과할 수 있다.
7. **https·압축 프록시·원격 호스트의 SSE 지연**은 미측정이다(루프백 http에서 qt−raw median 1~2 ms).
8. **실서버 왕복 QtTest**(`LiveServerTest`·`LiveStreamTest`)는 env 게이트 뒤에 있어 `build.bat`에서 **돌지도, skip으로 세지도 않는다** — **`build.bat` green은 실서버 동작의 증거가 아니다**(실서버 축은 드라이버 세 시나리오가 소유한다).

### 육안 확인 체크리스트 (P4 — 자동 판정이 못 보는 축만)

**여기에는 자동 판정이 되는 항목을 넣지 않았다.** 자동으로 판정되는 축은 위 표의 커맨드가 소유한다 — 자동 커맨드가 있는 항목을 육안으로 내리면
그 축은 **다음 회차부터 아무도 안 본다**. 결과 칸에 `정상` / `제약 있음` / `미확인` 중 하나를 적는다.

준비(한 번): ① `cmd /c client-qt\build.bat`(exit 0) ② 시험용 서버를 **임시 `DATA_DIR`** 로 띄운다(리포 `news.db`를 열지 마라) ③ `cmd /c client-qt\run.bat`
— **`CLIENT_SELFTEST`도 `--scenario`도 주지 않는다**(자동화 훅이 아니라 사람이 쓰는 경로를 본다) ④ 주소 입력 화면에 서버 주소를 넣고 [연결 확인] → 저장 ⑤ `desk` 계정으로 로그인.

| # | 항목 | 절차 | 기대 결과(판정 문구) | 실패하면 어디를 보는가 | 결과 |
|---|---|---|---|---|---|
| 1 | 목록이 **실제로 그려지는가** | 로그인 직후 목록 화면을 본다 | 표에 **11컬럼**(배부시간 없음)이 보이고 행이 최신순으로 차 있다 · 페이저에 `1 / N · 총 M건` · 상태 배지가 색으로 보인다 | diag가 `list-loaded{count}`를 남겼는데 화면이 비었으면 **뷰 결선**이다(M11-2의 모양). `ListScreenTest`를 먼저 돌려라 | |
| 2 | SSE 갱신이 **눈에 보이는가** | 앱을 그대로 둔 채, **다른 계정**(예: `reporter`)으로 기사를 1건 만든다(웹·다른 클라·`curl` 무엇이든) | 아무것도 누르지 않았는데 **몇 백 ms 안에** 새 기사가 맨 위에 나타나고 `총 M+1건`이 된다 | 같은 계정으로 만들면 **클라 세션이 끊긴다**(같은 사용자 로그인이 기존 세션을 전부 무효화한다) — 계정을 먼저 확인하라. 그 다음 상단바의 실시간 표시 | |
| 3 | **한글 표시·폰트** | 목록·상단바·배지·페이저·로그인 화면의 한글을 읽는다 | 깨진 글자(`???`·두부)나 잘림이 없고, 시간이 `YYYY-MM-DD HH:mm`으로 보인다 | 배치 파일·소스는 전부 ASCII로 유지돼 있다(한글은 UTF-8 소스 리터럴과 `appidentity.h`의 universal character name) — 깨지면 **폰트**가 아니라 인코딩 경로를 의심하라 | |
| 4 | 상단바 **실시간 표시 점의 색** | 상단바 우측 `● 실시간`을 본다. 그 다음 서버를 잠깐 내려 `● 연결 끊김`도 본다 | **사람이 판정한다**: 현재 연결됨은 **빨간 점**이다(방송 「on-air」 관례). 두 상태를 나란히 보고 **빨강을 「오류」로 읽게 되는지** 판단해 적는다 | 자동 판정 불가 축이다(색은 코드에 상수로 있고 테스트는 「색이 있다」까지만 본다). 「오류로 읽힌다」는 답이면 **색 규약을 P6(테마·환경설정)로 올린다** — P4에서 고치지 않는다 | |

**왜 이 넷은 자동화할 수 없는가**: 1·2는 **화면에 픽셀이 그려졌는가**이고 diag·서버 측 사실 어느 쪽도 그것을 보지 못한다(위 「기계가 판정하지 않는 것」 1·2).
3은 글꼴 대체·자소 조합의 결과라 문자열 비교로는 드러나지 않는다. 4는 **판정 자체가 사람의 해석**이다.

**여기 없는 것(자동 커맨드가 판정한다 — 육안으로 내리지 마라)**: 부팅·단일 인스턴스(`--scenario boot`) · 로그인 성공/거부와 훅 가드(`--scenario login`) ·
SSE 실시간 갱신의 **기계 판정**(`--scenario list` — (i)(ii)(iii)) · 라우트 원장과 계약 대조(`build.bat`의 `RouteContractTest`) · 비밀번호·기사 제목·아이디 유출 0건(드라이버 매 실행).

### P5(에디터 코어)가 곧바로 쓸 것

정본은 `phases/77-qt-client-skeleton/index.json`의 **`forward_notes`**다. 코드에서 시작할 자리만 적는다.

- **의존 방향**: `src/ui`(View) ← `src/ui`(Controller) ← `src/net`(Model 인터페이스). **컨트롤러는 위젯 타입을 모른다**(소스 스캔으로 잠겨 있다) ·
  `src/shell`은 순수 판정 우선이고 파일시스템·OS는 주입 이음매(`ConfigFileSystem`·`ProbeRunner`·`Diag`) 뒤에 있다.
- **새 모듈 등록 2곳**: `common.pri`의 `CLIENT_SOURCES`/`CLIENT_HEADERS`(앱과 테스트가 같은 코드를 컴파일한다) · `tests/main.cpp`의 `runTestClass<…>()` 한 줄.
- **편집 표면 clientId 결선 지점**: 발급기와 보관소는 `src/net/editclientid.h`(`issueEditClientId()` · 복사·이동 **금지**인 `EditClientId`). P5는 **에디터 표면의 생성·소멸에 `EditClientId`의 수명을 붙인다** —
  프로세스당·세션당·창당이 아니다. 전달은 `HttpNewsModel`의 `editClientId` 인자 → `RequestSpec::editClientId`이고, 전송 계층은 **`routetable.cpp`의 `sendsEditClient` 3행에서만** 싣는다(그 밖에서는 값이 있어도 붙지 않는다).
  `lockerSessionId`·`lockerClientId`를 읽는 코드를 짜지 마라(어떤 응답에도 없다).
- **diag 이벤트를 늘리려면**: `shell::allowedDiagEvents()`(21) + 신설 이벤트면 `contractedFields()` + 위 처분 표 + `DiagTest` 케이스. 집합 밖 이름은 `log()`가 **거부**한다.
- **자동화 훅**: `CLIENT_SELFTEST=1` + `--scenario boot|login|list` + `CLIENT_SCENARIO_USER`/`_PASSWORD`. 드라이버는 `scripts/verify-qt-client.mjs`이고 **새 드라이버를 만들지 말고 시나리오를 덧붙인다**.
- **P5 착수 전제**: 실물 **MS-IME 육안 확인**(P0 스파이크의 잔여) · 에디터 요구사항을 `docs/news.md`로 읽을 때는 **`docs/news-md-overrides.md`를 함께** 볼 것(줄 번호가 부딪히면 대장이 이긴다).

### ④⑤ 게이트 후 보강 (2026-09-12)

**위 마감 실측표는 `8544a1b` 시점의 역사 기록이므로 고치지 않는다.** 그 뒤에 ④ 테스터가 붙인 게이트와 ⑤ 리뷰어가 낸 low를
어떻게 처분했는지가 여기다. 기준값이 바뀐 곳은 위 「무엇이 기계로 판정되는가」 표의 첫 행(305/24 → **310/25**) 하나다.

#### ④ 테스터 보강 — 주기 타이머 폐색 (커밋 `969e102`)

`tests/timerpolicytest.{h,cpp}` 신설(테스트 +2 · 클래스 24 → 25). 위 「기계가 판정하지 않는 것」 6번(**폴링 배제는 관측 창
5초 안의 주기에 대해서만 결정적**)의 사각을 **소스 스캔**으로 메운다: `client-qt/src/**`·`app/**`을 모듈 단위(헤더+cpp)로 모아
`setInterval(`·`startTimer(`·`setSingleShot(false)`·`QBasicTimer`·`timerEvent(`가 나오면 red이고, `QTimer` 객체를 선언하고
`setSingleShot(true)`를 부르지 않아도 red다. 비공허성은 `src/net/changestream`(SSE 재연결 타이머)이 실제로 잡히는 것으로 잠갔다.
**5초 창보다 긴 주기는 드라이버가 여전히 못 보지만, 소스에 그런 타이머를 둘 수가 없다** — 두 게이트가 같은 구멍을 양쪽에서 막는다.

#### ④⑤ findings 처분표

| # | 발견 | 처분 | 커밋 |
|---|---|---|---|
| ⑤ F1 [low] | `common.pri:31,58`이 테스트 더블 `src/net/fakenewsmodel.{h,cpp}`를 `CLIENT_SOURCES`/`CLIENT_HEADERS`에 두어 `app/app.pro` 경유로 **`news-client.exe`에 링크**했다(`src/**`·`app/**`의 참조는 0건) | **고침** — `tests/tests.pro`(테스트 타깃) 전용 SOURCES/HEADERS로 이동. 파일 위치는 `src/net/` 유지(=`net/fakenewsmodel.h` include 경로·기존 문서 표기 무변). 잠금 `FakeNewsModelTest::rule7_isNotLinkedIntoTheApp()` — qmake 리스트 파서로 `common.pri`·`app.pro`에 `fake` 0건 + `tests.pro`에는 있음(양쪽이 동시에 비면 공허해지지 않는다). **exe 362,496 → 357,376 B(-5,120)** | `a4d546f` |
| ⑤ F2 [low] | `src/shell/clientconfig.cpp:175-177`의 `shaped.x + shaped.width`가 int 덧셈인데 `wholeNumber()`(29-31행)가 int 전 범위를 허용 — 손편집 config에서 **부호있는 오버플로(UB)** | **고침** — 여덟 항 전부 `qint64`로 승격(창 쪽·작업영역 쪽 둘 다). 잠금 `ClientConfigTest::keepsBoundsArithmeticWithinRange()`(width/height INT_MAX · 오른쪽 끝이 INT_MAX를 넘는 모니터 · 반대 방향으로 INT_MIN 거부 · 파일에서 오는 경로) | `37c902e` |
| ⑤ F3 [low] | `src/ui/mainwindow.cpp:41-43`의 신원 표시 QLabel이 `Qt::AutoText` — 서버 유래 `department`/`userId`(`logincontroller.cpp:86-100`)에 `<b>`가 오면 **마크업으로 렌더**된다 | **고침** — `src/ui`의 QLabel **13개 전부** `setTextFormat(Qt::PlainText)`. 유일한 예외는 실시간 표시 `liveLabel`(마크업이 이 코드가 쓰는 색 상수다)이고 테스트가 그 예외를 명시적으로 단언한다. 잠금 `ListScreenTest::serverDerivedTextNeverRendersAsMarkup()` | `f815946` |
| ⑤ 이월 ① [low] | `scripts/verify-qt-client.mjs:73`의 `DEFAULT_QT_BIN`이 `client-qt/env.bat:6` Qt 경로의 **2차 사본**이다 | **이월(고치지 않음)** — `--qt-bin`/`QT_BIN_DIR` 우회가 있어 지금 막히지 않는다. 정본 1곳 통합은 **P8**(배포 형상)과 함께 | — |
| ⑤ 이월 ② [low] | `tests/main.cpp:110,169`의 「0 실행이면 green 거부」가 **선언 수**(`countTestFunctions`)로 판정한다(실행 수가 아니다) | **이월** — `build.bat`이 러너를 무인자로 부르므로 현재 영향 0. **인자 필터를 쓰게 되면 실행 수로 바꿔야 한다** | — |
| ④ [info] | 「diag에 세션 쿠키 0건」의 근거 | **사실 확인** — 문자열 검색이 아니라 **구조 보증**이다: 금지 키 7 + `net-request` 이벤트의 필드 화이트리스트 + `DiagTest` | — |
| ④ [info] | `fakenewsmodel.cpp`의 `lockerClientId` | **사실 확인** — 가짜 서버의 **내부 장부**이고 `withoutPrivate()`가 응답에서 제거한다(override L131 준수 · `FakeNewsModelTest::neverExposesTheLockHolder()`가 잠근다) | — |

**이름이 주어진 항목은 위 일곱이다.** ⑤가 approve와 함께 남긴 low의 수와 이 표의 줄 수가 어떻게 대응하는지는 처분 지시가
구분하지 않았으므로 여기서 추정하지 않는다 — 추정한 매핑은 다음 감사에서 사실과 구분되지 않는다.

**P5가 새 모듈을 등록할 때**: 위 「P5가 곧바로 쓸 것」의 「새 모듈 등록 2곳」은 **프로덕션 모듈**의 이야기다. **테스트 더블·스텁은
`common.pri`가 아니라 `tests/tests.pro`에 등록한다**(F1) — `common.pri`에 넣으면 배포물에 실리고 `rule7`이 red가 된다.

#### 최종 재실측 1회 (코드 마지막 커밋 `f815946` · 트리 clean)

| 커맨드 | 결과 |
|---|---|
| `cmd /c client-qt\build.bat` | exit 0 · `Totals: 310 passed, 0 failed (classes: 25)` · `BUILD OK` |
| `verify-qt-client --scenario boot --server exe` | exit 0 · 4,465 ms · 관측 8(A 4 · B 4) · 판정 33 · 실패 0 |
| `verify-qt-client --scenario login --server exe` | exit 0 · 5,257 ms · 관측 17(G 0 · L+ 12 · L- 5) · 판정 40 · 실패 0 |
| `verify-qt-client --scenario list --server exe` | exit 0 · 7,494 ms · 관측 15 · 판정 30 · 실패 0 |
| `verify-qt-client --scenario list --server spring` | exit 0 · 11,789 ms · 관측 15 · 판정 30 · 실패 0 |
| `cmd.exe /c "npm test"` | exit 0 · tests **1349** · pass 1349 · fail 0 · suites 59 |
| `client-qt/release/news-client.exe` | **357,376 B**(F1 전 362,496 B — 테스트 더블이 빠진 만큼 줄었다) |
| 리포 `news.db` | md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` **무변**(읽기만) |

**`npm test`는 반드시 `cmd.exe /c`로 감싼다**: Node ≥ 20은 `.cmd`를 직접 spawn하지 못해 예외 없이 `status=null`을 돌려주고,
그것이 「0 ms에 끝난 성공」으로 오독된다(마감 실측의 함정 ①). `status`가 **정수**인지 확인하라.

## 에디터 — P5 (phase 78 · 2026-11-01)

로드맵 P5(`docs/porting-plan-cpp-spring.md` **182행** — 텍스트 엔진·블록 모델·마커 계약·단축키 13종·IME·색상·undo·자동저장)의
산출물이다. 결정·이유·대가는 **`docs/ADR.md` ADR-019**가, step별 실측 전문(기대값 출처·red 실증·우회 변이표)은
**`phases/78-editor-core/index.json`의 `steps[].summary`**가 정본이다(**변이표는 그 summary에만 있다** — 이 장에는 소재만 적는다).
이 장은 코드에서 시작할 자리와 판정의 경계만 적는다.

### 두 층 — 이식층 `src/editor/`와 GUI·상태 기계 `src/ui/`

- **의존 방향**: `src/ui` View(`EditorWidget` · `MainWindow`의 편집 페이지) ← `src/ui` Controller(`EditController` — 위젯 타입 0 ·
  `INewsModel&`·`IDraftStore&`·주입 시계만) ← `src/net`(`INewsModel`). `src/editor`(이식층)는 위젯을 모르고, 위젯은 이식층을 **호출만** 한다.
- **웹 테스트가 명세서다**: 데이터 행은 웹 정본 모듈을 node 24로 실행해 만든 값을 그대로 붙였다(수기 전사 0 · 생성기는 각 step의
  스크래치패드 — 리포 밖). 9개 웹 스펙 파일의 it **180개**를 같은 순서로 옮겼고(아래 표의 「웹 it」 열) 나머지 행은 포트 잠금이다.
- 새 프로덕션 모듈은 지금까지와 같이 `common.pri`의 `CLIENT_SOURCES`/`CLIENT_HEADERS`에 모듈당 1줄, 테스트 클래스는 `tests/main.cpp`의
  `runTestClass<…>()` 한 줄, 테스트 더블은 `tests/tests.pro` 전용이다(위 「④⑤ 게이트 후 보강」 F1).

### 빌드에 편입된 에디터 모듈 (2026-11-01 · `common.pri` 등록 기준)

「QtTest」 열은 `함수 수 · 행 단위 PASS`(QtTest 자신의 클래스별 `Totals` — `initTestCase`·`cleanupTestCase` 포함 · 마감 실측 로그)다.

| 모듈 | 웹 정본 | Qt | QtTest | 웹 it | step |
|---|---|---|---|---|---|
| 줄 역할·색 4종·마커 줄 판정(`isEndLine`)·JS 공백 집합 | `editorColoring.js`(+ P0 스파이크 `spikes/p0-qt-editor/editorlogic.*`) | `src/editor/editorroles.{h,cpp}` | `EditorRolesTest` 4 · 33 / `EditorColoringTest` 11 · 124 | 10(it 8~10은 setter 없이 성립하는 절반) | 0 · 2 |
| 블록 모델(yh-editor v1 · 순서 보존 JSON) | `editorContent.js` | `src/editor/editorcontent.{h,cpp}` | `EditorContentTest` 25 · 69 | 22 | 1 |
| 「(끝)」 입력 게이트·개행·재정규화·경계 병합 게이트 | `editorNewline.js`(+ 웹 4곳의 인라인 재정규화) | `src/editor/editornewline.{h,cpp}` | `EditorNewlineTest` 60 · 147 | 55 | 3 |
| 캐럿(줄·오프셋 · `TextPoint`) | `editorCaret.js` | `src/editor/editorcaret.{h,cpp}` | `EditorCaretTest` 9 · 87 | 6 | 4 |
| 단어·문단 범위 | `editorRange.js` | `src/editor/editorrange.{h,cpp}` | `EditorRangeTest` 22 · 202 | 17 | 4 |
| 단축키 13종(`RESERVED_COMBOS`) · 키 인식 10 · 변환 | `editorShortcuts.js` + `editorGlyphKeymap.js`의 `RESERVED_COMBOS` + `editorFind.js`의 키 판정 1줄 | `src/editor/editorshortcuts.{h,cpp}` | `EditorShortcutsTest` 44 · 857 | 28 | 5 |
| 단어 지우기 | `editorEditOps.js`의 `deleteWordAt` | `src/editor/editoreditops.{h,cpp}` | `EditorEditOpsTest` 11 · 90 | 9(정렬 29 it는 P6) | 5 |
| undo/redo 스냅샷 스택 | `editorHistory.js` | `src/editor/editorhistory.{h,cpp}` | `EditorHistoryTest` 18 · 141 | 14 | 6 |
| 자동저장 초안(순수 · 매체·시각·scope 주입) | `editorDraft.js` | `src/editor/editordraft.{h,cpp}` | `EditorDraftTest` 28 · 123 | 19 | 7 |
| 초안 파일 저장소 `editor-drafts.json` | localStorage `yh.editorDrafts`의 값 | `src/editor/editordraftstore.{h,cpp}` | `EditorDraftStoreTest` 9 · 69 | — | 7 |
| 입력 라우팅(위젯의 GUI 비의존 절반 · Qt 키 → `KeyInput` · 단축키 판정 순서) | `WriterPage.jsx` `onKeyDown` 순서 | `src/editor/editorinput.{h,cpp}` | `EditorInputTest` 10 · 469 | —(순서 표 384행은 웹 정본 실행 생성) | 8 |
| 텍스트 엔진 위젯 | `Editor.jsx`(contentEditable) | `src/ui/editorwidget.{h,cpp}` — `QPlainTextEdit` + `QSyntaxHighlighter` | `EditorWidgetTest` 26 · 44(오프스크린 · 실제 이벤트 핸들러)(④ 보강 뒤 28 · 46 · ⑤ 후속 뒤 **33 · 51**) | — | 8 |
| 본문 제목·저장 직렬화 | `writerBody.js`(`bodyTitle`·`serializeBodyFromBlocks`) | `src/editor/writerbody.{h,cpp}` | `WriterBodyTest` 2 · 19 | — | 9 |
| 편집 상태 기계(표면 1개) | `useWriteController.js` 편집 탭 + `WriterPage.jsx` 본문 상태 + `lockMessages.js` | `src/ui/editcontroller.{h,cpp}` | `EditControllerTest` 34 · 63 | — | 9 |
| 편집 페이지 조립 | `WriterPage.jsx` | `src/ui/writerhost.{h,cpp}` + `mainwindow.*`(편집 페이지·상단 바) + `listscreen.*`(더블클릭) | `WriterHostTest` 9 · 11(+ `ListScreenTest`)(④ 보강 뒤 11 · 13 · ⑤ 후속 뒤 **13 · 15**) | — | 9 |
| 자동화 훅 `--scenario edit` | — | `src/ui/editscenario.{h,cpp}` + `app/main.cpp` | `EditScenarioTest` 10 · 21 | — | 9 |

합계: P5 신규 **17 클래스 · 332 함수**(+ 갱신된 `ListScreenTest` 1 → P4 마감 310/25에서 **643/42**) · P5 클래스의 행 단위 PASS 2,569(전체 3,359)(④ 보강 뒤 336 함수 · 647/42 · 행 2,573(전체 3,363) · ⑤ 후속 뒤 **343 함수 · 654/42 · 행 2,580(전체 3,370)**) ·
웹 it **180**(정적 집계 — ADR-019 ①·⑧). `writerBody.test.js`의 스펙은 step3 바이트 패리티 표(7행)와 step9 `WriterBodyTest`로 들어갔고 it 단위로 세지 않았다.

### 「(끝)」 마커 게이트 — 단일 지점 `src/editor/editornewline.h`

| 위젯의 쓰기 경로 | 거치는 게이트 |
|---|---|
| 타이핑 · IME 커밋 | `isInputBlocked`(삽입점 = 선택 시작) → Qt가 입력 → 편집 위치를 찾아 **재검증**(차단 위치 삽입·줄 경계 생성/삭제면 문서 원복 — 사전 게이트를 지운 변이 M3a도 이것이 막았다) |
| Enter(수식어 무관) · 붙여넣기(Ctrl+V · Shift+Insert · `paste()`) · 여러 줄 선택 위 입력 · 줄바꿈이 든 입력 · IME 치환 | `isInputBlocked` → `replaceRangeInBlocks`(마커 clamp) |
| 여러 줄 선택 삭제(BS · Del · Ctrl+X · Shift+Del · Ctrl+BS/Del · 선택 위 IME 조합 시작) | `replaceRangeInBlocks(…, "")` — `본문⏎(끝)`에서 `문⏎(끝`을 지우면 `본⏎(끝)`(웹 네이티브는 `본(끝)`) |
| 비어 있지 않은 줄의 BS(줄 시작)/Del(줄 끝)과 그 Ctrl 형 | `isLineMergeBlocked` → `joinTextLines`(**웹 결함 비승계** — 사전 결정 ①) |
| 빈 줄 BS/Del(수식어 무관) · Ctrl+D | `deleteLineAt`(마커 줄 삭제는 허용 — 지우면 입력 재개) |
| Alt+Y · Ctrl+Y | `insertEndMarker`(중복 판정 = substring `hasEndMarker`) · `insertContinueMarker`(재정규화 — `(끝)`은 마지막에 남는다) |
| 대소문자 변환 `transformCaretLine` — **P5 앱에는 진입점이 없다**(보기 메뉴 = P6 · 위젯 API와 QtTest만) | 줄 끝 `isInputBlocked` → `transformTextLine` |
| 그 밖(`QPlainTextEdit` API 직접 호출 · 보조기술 · 밖으로 끌어낸 텍스트) | 위젯 경로가 만들지 않은 변경으로 감지 → 블록에서 복원(fail-closed) |

- **한 줄 안의 삭제·이동·선택에는 게이트가 없다**(차단 대상이 아니다). 줄을 합치거나 여러 줄을 지울 때만 마커 줄이 다른 텍스트와 붙을 수 있다.
- **판정 기준은 둘이고 섞지 않는다**: 입력 게이트 = 마지막 `(끝)`의 `lastIndexOf` 시작 오프셋 「이상」(UTF-16 · substring — 웹 동형) /
  마커 줄 = `isEndLine`(JS `trim()` 공백 집합 — `QString::trimmed()`는 U+0085·U+FEFF에서 다르다). 위젯은 substring·trim으로 재판정하지 않는다.
- 저장 바이트 = `serialize(renormalizeEndMarker(blocks))` = 웹 `serializeBodyFromBlocks`(step3 바이트 표 17행 · 드라이버 S가 실서버에서 다시 대조).

### IME — 조합 중 무개입 (그리고 그것을 무엇이 판정하는가)

- 조합 중: 단축키 인식 0 · 재색칠 0 · 캐럿 이동 0 — 키는 Qt/IME에 그대로 간다. 차단 위치: `Qt::ImEnabled=false` + 조합 시작 거부.
  재색칠 트리거는 `shouldRecolor`의 `load`·`blur`·`compositionend`뿐이다. 읽기 전용 표면은 IME 커밋도 거부한다(step8이 적발한 Qt 동작).
- 키: `keyInputFromQt(key, modifiers, nativeScanCode)` — `text()`를 읽지 않는다(Ctrl 하에서 제어문자). 판정 순서 = 웹 `WriterPage.onKeyDown`
  (`SHORTCUT_ORDER` — 테스트가 `WriterPage.jsx`를 런타임에 읽어 대조). Ctrl+B · Ctrl+F · Alt+O · Alt+V는 **소비 + 신호만**(기능 P6) ·
  Ctrl+Z / Ctrl+Shift+Z는 상태 기계로 · 문서 자체 undo off · Alt+글자·Tab은 입력하지 않는다(AltGr = Ctrl+Alt는 입력).
- **QtTest가 판정하는 것은 논리 상태다**(합성 `QInputMethodEvent`·`QKeyEvent` → 문서·블록·논리 커서·서식 범위·신호). 실물 MS-IME의
  화면 거동은 아래 「P5 마감」의 육안 체크리스트가 판정하고, **그 체크리스트는 아직 수행되지 않았다.**

### 편집 페이지와 상태 기계 (`ui::WriterHost` · `ui::EditController`)

- **편집 페이지 = 메인 창의 세 번째 페이지**(`EditorWidget`). 그 페이지에서만 상단 바에 평문 안내 문장과 **[저장] [복구] [닫기]**가
  보인다(메뉴 바·다이얼로그 없음 — P6). **목록 화면의 유일한 동작은 행 더블클릭**이다(`articleOpenRequested(articleId)`).
- **흐름**: 더블클릭 → **편집 페이지가 먼저 현재**(목록 이탈 = 스트림 stop) → `articles-get` → `articles-lock('revise', 표면 id)` →
  편집(타이핑 · Ctrl+Z/Ctrl+Shift+Z · [복구]) → [저장] = `articles-update`(PUT · 편집 중일 때만) → [닫기] = `articles-unlock` → 목록 페이지
  (셸이 신원 확인 → 조회 → 스트림으로 재진입). 메인 창 닫힘 = unlock(동기 · 재진입 없음). 열면 편집기에 포커스를 준다.
  [저장]·[복구]는 편집 가능할 때만 켜진다. 같은 기사를 다시 열면 같은 표면(잠금 재요청 0), 표면이 열린 동안 다른 기사는 거절(한 번에 하나).
- **표면 = `EditClientId` 1개**: `EditController`의 `const net::EditClientId` 멤버다 — 표면과 함께 생기고 사라진다. lock·save·unlock 세 호출만
  Model의 clientId 인자로 넘기고, 전송이 `routetable.cpp`의 `sendsEditClient` 3행에서만 헤더로 싣는다(`src/net` 무수정). 필드·초안·안내 문장·
  로그·diag 어디에도 그 값은 없다.

| 상태 | 사건 | 다음 |
|---|---|---|
| Opening | get 401 | SessionEnded |
| Opening | get 실패 · 기사 없음 | LoadFailed(**잠금 요청 0** — 웹의 목록 행 폴백은 빈 본문 저장 경로라 이식하지 않았다) |
| Opening | get ok → lock `ok:true` | Editing |
| Opening | lock 401 `unauthenticated` | SessionEnded(그 뒤 요청 0 — unlock도 없다) |
| Opening | 그 밖의 lock 응답(401 `locked` · 403 · 404 · 네트워크 · 비JSON · 200 `ok:false`/`ok:'yes'`/`{}`) | LockRefused(읽기 전용 + `lockFailMessage`) |
| Editing | commit · undo · redo · 복구 · 자동저장 | Editing(서버 요청 0) |
| Editing | save ok / save 401 / save 그 밖 실패 | Editing +「저장되었습니다.」 / SessionEnded / Editing +「저장에 실패했습니다.」 |
| Editing | close | Closed + unlock 1회 |
| LockRefused · LoadFailed · SessionEnded | 모든 쓰기 / close | 거절(요청 0 · 초안 0) / Closed(unlock 0) |

- **안내 문장**(`src/ui/editcontroller.cpp` — 웹 `lockMessages.js`·`WriterPage.jsx` 문구): 잠금 실패 `편집중입니다.`(locked) ·
  `서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.`(network-error · invalid-response) ·
  `세션이 만료되었습니다. 다시 로그인한 뒤 편집해 주세요.` · `이 기사를 편집할 권한이 없습니다.` · `기사를 찾을 수 없습니다.` · 그 밖
  `편집 잠금을 얻지 못해 편집할 수 없습니다.`(+ ` (사유)`) / 저장 `저장되었습니다.` · `저장에 실패했습니다.` / 복구 `복구할 자동저장 내용이 없습니다.` ·
  `자동저장된 내용으로 복구했습니다. 되돌리기(Ctrl+Z)로 복구 전 본문으로 돌아갈 수 있습니다.` / 조회 실패 `기사를 불러오지 못했습니다…`.
- **undo**: 타이핑 커밋 = `serialize(renormalizeEndMarker(blocks()))`(coalesce 후보 · 재정규화로 블록이 바뀌면 `setBlocks`로 되민다) ·
  편집 op 커밋 = `serialize(blocks())` · coalesce = 타이핑 && 직전도 타이핑 && 500 ms 미만 · limit 100 · undo/redo 적용은 캡처하지 않는다 ·
  베이스라인 = 로드한 원문 그대로 · [복구] = coalesce 없는 한 단계.
- **자동저장**: 매 회 다시 무장하는 단발 타이머 · 편집 중 + 설정 on일 때만 · **운영 기본 off**(웹 기본값 — 켜는 UI는 P6) · 파일 =
  `editor-drafts.json`(config.json 옆 · 운영 `%APPDATA%\기사작성기-qt\` · 하네스 `CLIENT_USER_DATA`) · 필드 = `DRAFT_FIELDS` 14(웹
  `EDITABLE_FIELDS`) · 키 = articleId(P5에는 신규 기사가 없다) · scope = 프로세스당 `w-`+QUuid(`app/main.cpp`).

### 자동화 훅과 드라이버 `--scenario edit` (`scripts/verify-qt-client.mjs`)

훅: `CLIENT_SELFTEST=1` + `--scenario edit` + `CLIENT_SCENARIO_USER`/`_PASSWORD` + **`CLIENT_SCENARIO_ARTICLE`**(편집할 기사 id). `main.cpp`가
`edit`를 `list`로 바꿔 **무수정 셸 가드**에 넘기고(가드가 먼저), 가드를 지나도 기사 id가 없으면 exit 2다. 훅은 목록이 live가 된 뒤
컨트롤러·호스트만 부른다(위젯 무접촉) — 편집 = 첫 줄 끝 `isInputBlocked` → `insertTextIntoBlocks`(` [qt-edit]`) · 자동저장은 이 시나리오에서만
on · 1초.

| 단계 | 내용(2026-11-01 마감 실측값) |
|---|---|
| EG1 · EG2 | 거부 실기 — `CLIENT_SELFTEST` 없음 / `CLIENT_SCENARIO_ARTICLE` 없음 → 각각 부팅 전 exit 2 · diag·user-data 미생성 · 출력에 비밀번호 0 |
| R | 드라이버가 **reporter**로 yh-editor 본문 기사 1건을 만든다(서버 사실: 본문 그대로 · `lockYN=N`) · deskUnsent N0=1 · 기대 본문은 **웹 정본 모듈**(`editorContent`·`editorNewline`·`writerBody`)로 계산 |
| P | **기록 프록시** — 클라는 프록시 origin에 붙고, 프록시는 요청을 바꾸지 않고 서버로 넘기며(SSE는 그대로 흘린다) 요청마다 라우트 id·상태·`x-edit-client` 유무와 값을 적는다. **값은 판정·유출 검사에만 쓰고 어떤 출력에도 싣지 않는다** |
| C | 클라(desk) — 진입 → `sse-ready` → `sse-closed{stopped}`(목록 이탈) → `articles-get`·`articles-lock`·`articles-update`·`articles-unlock` 각 200 → 재진입(`session` → `articles-list` → `stream` → `sse-ready`) · 관측 24 |
| S | 서버 사실 — 저장 본문 = 기대 본문 **바이트 동일(174자)** · 제목 = 편집 뒤 첫 줄 · `lockYN=N` · `modifier=desk` |
| 판정 | `judgeEdit`(순서 · 편집 왕복은 목록 이탈 뒤·재진입 신원 확인 전 · login 1 · session 2 · articles-list = list-loaded ∈ [2, 2+sse-change] · sse-closed{stopped} 1 · 허용 11종 · 원장 정확 횟수) × `judgeEditWire`(계약 라우트 매칭 · **`x-edit-client`는 정확히 lock·update·unlock 3건** · 편집 3 라우트 각 1회 200 · **표면당 값 1개**(c-uuid v4) · 와이어 = diag 11건) · user-data = `config.json`·`editor-drafts.json`만(초안 = 이 기사 1건의 편집 뒤 필드 14 · 금지 키 0) · diag·stdout·stderr·초안 파일에 비밀번호·제목·본문·기사아이디·`EditClientId` 0 → **판정 43 · 실패 0**(exe·spring 각 2회) |

- **편집기 diag 이벤트를 신설하지 않은 이유**: 허용 집합 `shell::allowedDiagEvents()`(21종)가 `src/shell/`(phase 78 무접촉 경계) 안에 있어
  `editor-open`·`lock-acquired`·`editor-saved`를 만들려면 shell을 고쳐야 한다. 그래서 **`net-request` 원장 × 와이어 원장 × 서버 사실**의 교차로
  판정한다 — 와이어는 앱의 자기 신고가 아니라 프록시가 본 사실이다. 이벤트를 늘릴지는 아래 책임자 확인 대상 3번이다.
- **드라이버가 보지 못하는 것**: 표면이 하나뿐이라 `EditClientId` 프로세스 공유 변이(step9 M1(a))에서 드라이버는 **green**이었다 —
  QtTest(`EditControllerTest` + 스텁 서버 위 실제 `HttpNewsModel`/전송의 와이어 테스트 `tests/editwire.h` — 표면 2개 × 3건 = 6건 · GET 0 ·
  두 값 상이)가 유일한 방어선이다. 서버 요청을 만들지 않는 동작(undo · 복구 · 읽기 전용 거부 · 게이트 거부)도 드라이버 밖이다.
- 로그인 시도: edit 2회(reporter · desk) · `all` 7회 — IP 제한 10회/15분 안.

### 웹과 의도적으로 다른 동작 (divergence — 전부 의도)

| 자리 | Qt | 웹 | 근거 |
|---|---|---|---|
| 비어 있지 않은 줄의 BS/Del 경계 병합 | `isLineMergeBlocked` — 병합 결과가 마커 줄을 깨면 거부 | 브라우저 네이티브(가드 0 → `본문(끝)` 오염 송고 경로) | 사전 결정 ① · step3 — **웹 결함 비승계** |
| 여러 줄 선택 삭제 | `replaceRangeInBlocks(…, "")` → `본⏎(끝)` · 첫 마커 줄과 그 뒤는 지우지 못한다(한 줄 안 삭제·Ctrl+D로는 가능) | 네이티브 → `본(끝)` | step3 이월 (b) → step8 |
| 선택이 있을 때 BS/Del | 선택 삭제 | anchor 줄이 비면 그 줄 삭제 | step8 |
| 붙여넣기 | 한 줄도 `replaceRangeInBlocks` · 여러 줄 뒤 캐럿 = 붙인 텍스트 끝 | 네이티브(여러 줄 선택 위면 줄 접착) · 캐럿 = 마지막 붙인 줄 시작 | step8 |
| 대소문자 변환 | 줄 끝 `isInputBlocked` 게이트 | 게이트 없음 | step8 |
| 합쳐지는 두 줄 사이의 임베드 | 합친 줄 뒤에 보존 | — | step8 |
| Shift+Enter | Enter와 같다(Qt의 U+2028 줄바꿈 금지) | — | step8 |
| 조합 중 Shift+Enter · U+2028을 입력하는 키 | 거부 — 네이티브 편집이 넣은 U+2028은 줄바꿈처럼 원복(조합은 제자리에서 계속) | 조합 중 개입 없음(브라우저 기본) · 키 입력은 그대로 입력 | ⑤ 후속 F3 |
| 재정규화 되밀기 뒤 캐럿(「(끝)」 뒤 줄에서의 타이핑 편집) | 편집 지점 그대로 — 마커 줄만 끝으로 가고 캐럿은 자기 줄·열(마커 줄 위였으면 「(끝)」 기준 같은 자리) | remount 뒤 되밀기 전 줄 번호의 줄 시작(그 자리가 마커 줄일 수 있다) | ⑤ 후속 F2 |
| 블록이 담지 못하는 글자 | CR·U+2029·블록 안 LF → 공백, U+FDD0/1 → U+FFFD로 1:1 대체 표시(실제 텍스트는 블록) | pre-wrap 표시 | step8 |
| 잠금 실패 | 읽기 전용 표면 + 웹 문구 | 탭을 열지 않는다 | step9 (b) · 책임자 확인 4 |
| 본문 조회 실패 | 잠그지 않는다(LoadFailed) | 목록 행 폴백(빈 본문 저장 가능) | step9 (c) — fail-closed |
| 파일>복구 | 확인창 없이 undo 한 단계 + 안내 문장 | 확인창 | step9 (e) — P5 다이얼로그 0 |
| 작성자 신원 폴백 | 미이식(author 없는 기사는 `''`) | 로그인 사용자 이름 | step9 (f) — 신원 미보관 |
| 목록측 선(先)잠금(clientId 없음) | 미이식(표면당 잠금 1회) | 있음 | step9 (d) |
| 512단계 초과 중첩 JSON 본문 | 평문 취급 | 재귀 파싱 | step1 |
| 대소문자 Final_Sigma · Unicode 17.0 쌍 56개 | Qt 6.8.3 표(Unicode 16.0) | ICU 78.3(Unicode 17.0) | step5 — 행으로 잠금(Qt를 올리면 red) |
| 색 환경설정 setter(`setEditorColors`) | 미이식 — `COLORS` 상수 | 모듈 전역 가변 | step2 — P6 |
| 초안: 비객체 data · 문자열 아닌 필드 · `__proto__` · 부분 만료 · 배열/비 UTF-8 파일 | `editordraft.h`·`editordraftstore.h`에 기록 | 각 웹 동작 | step7 — 생산자가 만들지 않는 입력 |
| undo 「같은 객체」 판정 | 값 동등 | 참조 동일성 | step6 |

반대로 **Qt 기본 동작이 웹과 달라 웹에 맞춘 자리**도 있다: `QString::trimmed()` → `isEndLine`(JS trim) · `QChar::isSpace` → `isJsWhitespace` ·
`QString::toUpper/toLower`의 고아 서로게이트 U+FFFD 치환 → 보존 · 읽기 전용 `QPlainTextEdit`의 IME 커밋 입력 → 거부 · `QPlainTextEdit`의 Alt+글자 입력 → 거부.
P4의 divergence(재시작 = 재로그인 등 — 「P4 마감」 이전 장들)는 그대로다.

### 알려진 한계 (정직하게)

- **강제 해제·takeover를 표면이 감지하지 않는다**(P7) — 다른 사용자가 잠금을 가져가도 표면은 편집 가능한 채이고 **저장이 not-holder로 실패할 뿐**이다(save 403 → 편집 가능 유지 = 웹 동형 · 책임자 확인 5).
- **표면 한 번에 하나** · **신규 기사(POST)·송고/보류/KILL·매핑·메뉴 없음**(신규 기사·송고의 소유 phase는 미확정 — step9 (h)는 「P7 등」으로 적었다).
- **자동저장 기본 off** — 켜는 UI는 P6이고, 운영 빌드에서 자동저장/복구를 실기할 수단이 없다.
- **앱이 강제 종료되면 잠금은 서버의 30분 stale까지 남는다** · **표면이 열린 채 메인 창을 닫으면 unlock이 동기 요청**이라 서버가 응답하지 않을 때 닫힘이 최대 15초(전송 기한) 늦다 — 두 경로 모두 실기로 재현하지는 않았다.
- **임베드는 렌더 없이 운반된다**(P6) — Ctrl+D·빈 줄 삭제가 텍스트 줄의 동반 임베드를 함께 지우는 웹 규칙을 화면에서 볼 수 없다.
- 대소문자 변환은 위젯 API(`transformCaretLine`)만 있고 앱에 진입점이 없다(보기 메뉴 = P6) · Ctrl+B·Ctrl+F·Alt+O·Alt+V는 소비만 한다(기능 P6).
- 성능 축(긴 문서 스크롤·대량 본문·메모리·고DPI)은 측정하지 않았다.

### 책임자 확인 대상 — [추정]으로 굳힌 다섯 (step7·9)

| # | 현재 결정 | 대안 | 지금의 영향 | 근거 |
|---|---|---|---|---|
| 1 | 초안 scope = 프로세스당 `w-`+QUuid(웹의 브라우저 탭당 1개와 동형 · `app/main.cpp`) | scope 고정 또는 config 옆 영속(단일 인스턴스가 user-data 폴더 단위라 가능) | P5에는 신규 기사 표면이 없어 **미사용**(키 = articleId). 신규 탭이 생기면 재시작 뒤 이전 실행의 신규 탭 초안을 복구할 수 없다 | step7 ⑦(b) · step9 ⑧(1) |
| 2 | undo 베이스라인 = 로드한 원문 그대로(웹 동형 · 변이 M5가 잠금) | `serialize(deserialize(원문))` | 레거시 평문 등 비정규 원문이면 첫 편집이 별개 undo 단계가 된다 | step1 ⑦(a) · step6 ⑦(c) · step9 ⑧(2) |
| 3 | 편집기 diag 이벤트 0 | `editor-open`·`lock-acquired`·`editor-saved` 신설 | 서버 요청이 없는 동작은 QtTest만 본다 | shell 변경 동반 — step9 ③(a) |
| 4 | 잠금 실패 = 읽기 전용 + 안내 | 웹처럼 열지 않음 | 사용자가 본문을 읽을 수 있다(편집·저장 불가) | step9 ③(b) |
| 5 | save 403 not-holder → 편집 가능 유지(웹 동형) | 읽기 전용 전환 | 잠금을 잃은 뒤에도 입력은 되고 저장만 실패한다 | step9 ⑧(5) |

## P5 마감 (2026-11-01 · phase 78 step10)

### 마감 실측 — 연속 2회 (두 회차 수치 전건 동일 · flake 0)

같은 트리(`feat-78-editor-core` · HEAD `45b1890` · 트리 clean)에서 **전 커맨드를 연속 2회** 돌렸다(회차 1 13:40~13:44 · 회차 2 13:44~13:48 KST).
시간은 프로세스 전체 소요(ms)이고, 괄호 안은 그 커맨드가 자기 입으로 보고한 수치다. 빌드는 Git Bash에서
`MSYS_NO_PATHCONV=1 cmd.exe /c "client-qt\build.bat"`(PATH **뒤**에 `/c/Windows/System32`)로 부르고 매번 `Totals:` 줄로 실제 실행을 확인했다.

| # | 커맨드 | 회차 1 | 회차 2 |
|---|---|---|---|
| 1 | `cmd.exe /c "client-qt\build.bat"` | exit 0 · 40,138 ms · `Totals: 643 passed, 0 failed (classes: 42)`(④ 보강 뒤 **647**/0 · ⑤ 후속 뒤 **654**/0) · `BUILD OK` · `FAIL!` 0줄 | exit 0 · 40,289 ms · **동일**(클래스별 QtTest `Totals` 42줄도 동일) |
| 2 | `verify-qt-client --scenario boot --server exe` | exit 0 · 4,855 ms · 관측 8(A 4 · B 4) · 판정 33 · 실패 0 | exit 0 · 4,816 ms · **동일** |
| 3 | `… --scenario login --server exe` | exit 0 · 5,779 ms · 관측 17(G 0 · L+ 12 · L- 5) · 판정 40 · 실패 0 | exit 0 · 5,699 ms · **동일** |
| 4 | `… --scenario list --server exe` | exit 0 · 7,868 ms · 관측 15 · 판정 30 · 실패 0 | exit 0 · 7,984 ms · **동일** |
| 5 | `… --scenario edit --server exe` | exit 0 · 5,041 ms · 관측 24 · 판정 43 · 실패 0 | exit 0 · 5,062 ms · **동일** |
| 6 | `… --scenario boot --server spring --java-home …` | exit 0 · 8,639 ms · 관측 8 · 판정 33 · 실패 0 | exit 0 · 8,660 ms · **동일** |
| 7 | `… --scenario login --server spring --java-home …` | exit 0 · 9,982 ms · 관측 17 · 판정 40 · 실패 0 | exit 0 · 9,849 ms · **동일** |
| 8 | `… --scenario list --server spring --java-home …` | exit 0 · 12,160 ms · 관측 15 · 판정 30 · 실패 0 | exit 0 · 11,814 ms · **동일** |
| 9 | `… --scenario edit --server spring --java-home …` | exit 0 · 9,052 ms · 관측 24 · 판정 43 · 실패 0 | exit 0 · 9,123 ms · **동일** |
| 10 | `… --scenario all --server exe` | exit 0 · 20,763 ms · 관측 64(A 4 · B 4 · G 0 · L+ 12 · L- 5 · list 15 · edit 24) · 판정 116 · 실패 0 | exit 0 · 18,744 ms · **동일** |
| 11 | `npm test` | exit 0 · 22,000 ms · tests **1349** · pass 1349 · fail 0 · cancelled 0 · skipped 0 · todo 0 · suites 59 | exit 0 · 21,802 ms · **동일** |
| 12 | `npm run lint` | exit 0 · 7,508 ms | exit 0 · 7,510 ms |
| 13 | `npm run build` | exit 0 · 3,725 ms · `built in 2.08s` | exit 0 · 3,674 ms · `built in 2.04s` |
| 14 | `node scripts/spa-parity.mjs --java-home …` | exit 0 · 6,220 ms · 관측 **39** · diffs **0** · 허용 diff 528 | exit 0 · 6,099 ms · **동일** |
| 15 | `node scripts/spool-parity.mjs --java-home …` | exit 0 · 7,684 ms · 폴더 3 · 파일 11 · diffs **0** · 눈감은 자리 66/66(db=sqlite) | exit 0 · 7,597 ms · **동일** |
| 16 | `node scripts/spring-contract.mjs --parity --java-home …` | exit 0 · 55,698 ms · **313관측 diffs 0**(default 246 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) | exit 0 · 55,433 ms · **동일** |
| 17 | `git status --porcelain` | **무출력**(측정 전·중·후) | **무출력**(측정 전·중·후) |

- **판정부 자기검사**: 드라이버가 매 실행 시작 시 `scripts/lib/qtClientDiag.self-test.mjs`를 돌려 **77건 통과**(9 실행 × 2회차).
- **자산 지문(두 회차 · 각 회차의 측정 전·중·후 전부 동일)**: 리포 `news.db` **606,208 B · md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` 무변**(읽기만 — DB로 열지 않았다) ·
  `uploads/` **32파일 6,068,792 B** · `client-qt/release/news-client.exe` **538,624 B(⑤ 후속 F1~F5 재링크 뒤 539,136 B)**(P4 357,376 B). 소스가 무변이라 두 회차 모두 **재컴파일 0**이었다(`build.bat`은 qmake·nmake 무작업 + 러너 실행).
- **`--java-home D:/agents/tools/jdk-25.0.4.1+1`**: 이 셸에는 `JAVA_HOME`이 없다 — 없으면 6~9·14~16번은 usage로 **exit 1**이고 회귀가 아니다.
- **미측정(정직하게)**: `server-spring`의 `./mvnw clean verify` · `tools/news-migrator`의 `clean verify` · `npm run test:web`(vitest 전체)은 이 phase에서 돌리지 않았다.
  Java·web을 한 줄도 고치지 않았고(spring 모드는 2026-09-22 step0이 `-DskipTests package`로 만든 jar 그대로) 각 step이 이식에 필요한 웹 스펙만 vitest로 개별 확인했다(각 step 요약).
- **P4 마감 장의 표들은 2026-09-12 기준값의 역사 기록이라 고치지 않았다** — 현재 기준값은 이 장의 표다.

### 무엇이 기계로 판정되는가 (그리고 무엇이 아닌가)

| 축 | 판정자 | 기준값(2026-11-01) |
|---|---|---|
| 에디터 이식층이 웹 정본과 같은가 | `build.bat`의 Editor*Test 12 클래스 + `WriterBodyTest` — 기대값은 웹 정본을 node로 실행해 생성 | 웹 it 180 전환 + 포트 잠금 · 0 failed |
| 「(끝)」 게이트를 모든 쓰기 경로가 경유하는가 | `EditorWidgetTest`(오프스크린 · 위젯의 실제 이벤트 핸들러에 키·입력기·클립보드·포커스·마우스 이벤트) + `EditorInputTest` | 26 + 10 함수 · 경로마다 우회 변이 red 실증(step8)(④ 보강 뒤 28 + 10 · ⑤ 후속 뒤 **33 + 10**) |
| 조합 중 무개입(논리) | `EditorWidgetTest`(합성 `QInputMethodEvent`) | 조합 중 단축키·재색칠 0 · 차단 위치 조합 시작 거부 · 읽기 전용 IME 거부 |
| 편집 뒤 캐럿(Enter · 붙여넣기 · 여러 줄 선택 위 입력 · 줄 병합 · 재정규화 되밀기) — ⑤ 후속 | `EditorWidgetTest` 3 함수 + `WriterHostTest` 2 함수(되밀기 결선) | 수정 전 소스에서 전부 red · 대안 「공통 접두사 상한」 변이는 2함수 red |
| 상태 기계(전이 · fail-closed · 401 · coalesce · 복구 · 자동저장) | `EditControllerTest`(FakeNewsModel · 주입 시계) | 34 함수 |
| 표면당 `EditClientId` · `x-edit-client` 3라우트 | `EditControllerTest` + 와이어 테스트(`tests/editwire.h`) | 표면 2개 × 3건 = 6건 · GET 0 · 두 표면 값 상이 |
| 화면 4개 · 창 껍데기 1 · 다이얼로그 0 | `ScreenInventoryTest` | `{login, list, setup, editor}` + `{MainWindow}` |
| 반복 타이머 0(자동저장 = 단발 재무장) | `TimerPolicyTest` | 소스 스캔 |
| 편집 왕복 실기(get → lock → update → unlock · 저장 바이트 = 웹 정본) | `verify-qt-client --scenario edit` — `--server exe` **와** `--server spring` | 각 관측 24 · 판정 43 · 실패 0 · 174자 바이트 동일 · `x-edit-client` 3건 · 값 1 |
| P4 축 무회귀 | `--scenario boot` · `login` · `list`(exe · spring) | 33 / 40 / 30 |
| 판정부 비공허성 | 드라이버 시작 시 자기검사 + `npm test`의 `test/harness-vacuity-guards.test.js` | 자기검사 77 · 고아 0 |
| 기존 축(웹 · 서버 · 계약) | `npm test` · `lint` · `build` · `spa-parity` · `spool-parity` · `spring-contract --parity` | 위 실측표 11~16 |

**기계가 판정하지 않는 것 — 여기 있는 항목을 「검증됐다」고 적지 마라.**

1. **실물 MS-IME의 화면 거동**(캐럿 튐 · preedit 표시 · IME의 키 전달 · 조합 직후 재색칠 · `ImEnabled` 전환 · 조합 중 클릭). QtTest는 합성 이벤트의 논리 상태까지다.
2. **화면 픽셀.** 오프스크린 QtTest는 버튼 클릭·키 이벤트·논리 상태·서식 범위만 보았다(픽셀 0) — 역할 색이 보이는지, 안내 문장이 읽히는지는 육안이다.
3. **물리 키보드.** 키 매핑 표는 windows 플랫폼 플러그인에 프로브 자기 창으로 PostMessage한 실측이다 — 하드웨어 스캔코드·Dvorak/AZERTY 실기가 아니다.
4. **표면 둘 이상의 실기.** 드라이버는 표면 하나라 `EditClientId` 공유를 보지 못한다(step9 M1(a) 드라이버 green) — QtTest가 유일한 방어선이다.
5. **강제 해제·takeover·잠금 충돌 실기**(P7 — phase 78 open_questions (3) 확정).
6. **자동저장/복구의 운영 경로.** 운영 빌드에서 켤 수 없고, 하네스는 1초 자동저장 1회가 파일에 쓰였다는 사실만 본다.
7. **요청 body shape 전수**(P4 한계 그대로 — PUT dto는 `toSaveDto` 단위 테스트와 실서버 200 + 저장 바이트 대조로 부분 확인).
8. **성능**(긴 문서 · 대량 본문 · 고DPI).

### 육안 확인 체크리스트 (P5 — 로드맵 완료 게이트 (2) · 사람만 판정)

**이 표의 결과 칸은 전부 「미검증 — 사람 확인 필요」다.** 이 마감(step10)은 에이전트가 수행했고, 에이전트는 실물 MS-IME로 한글을 조합하며
화면을 볼 수 없다 — **수행하지 않은 항목을 「통과」로 적지 않았다.** 사람이 각 항목을 1회 수행하고 결과 칸을 `정상` / `제약 있음` / `미확인`
(또는 pass / fail)으로 **바꿔 적는다**. fail이면 fail로 적는다. **이 표가 채워지기 전까지 로드맵 P5 완료 게이트 (2)는 닫히지 않았다.**

출처: RUNBOOK §4 1~5 · step8 육안 미검증 10항목 · step9 육안 미검증 9항목(`phases/78-editor-core/index.json` 각 summary의 마지막 절)을 겹치는 것끼리 합쳐
**15항목**으로 만들었다(step9의 「픽셀 0」은 항목이 아니라 표 전체의 전제다 — 위 「기계가 판정하지 않는 것」 2).

준비(한 번): ① `cmd /c client-qt\build.bat`(exit 0) ② 시험용 서버를 **임시 `DATA_DIR`**로 띄운다(리포 `news.db`를 열지 마라 · `desk`·`reporter`
계정이 있어야 한다) ③ **reporter**로(웹 또는 `curl`) 시험 기사를 만든다 — (a) 제목·부제·본문·끝 `(끝)`이 있는 기사 (b) 줄 끝에 CR이 남는
본문(수집 기사, 또는 CRLF 줄바꿈 평문 본문) (c) 잠금 실패 확인용 기사 ④ `cmd /c client-qt\run.bat` — **`CLIENT_SELFTEST`도 `--scenario`도 주지 않는다**
⑤ 주소 입력 → [연결 확인] → 저장 → **desk**로 로그인 ⑥ Windows 입력기를 **Microsoft 한국어 IME**로 둔다.

| # | 항목(출처) | 절차 | 기대 결과(판정 문구) | 실패하면 어디를 보는가 | 결과 |
|---|---|---|---|---|---|
| 1 | 조합 중 캐럿 튐 0(RUNBOOK 1 · step8 1 · step9 1) | 기사 (a)를 더블클릭해 열고 제목 줄·부제 줄·본문 줄·`(끝)` 바로 앞 줄에서 한글 문장을 이어 친다(받침·겹받침·조합 중 Backspace 포함 · 3분) | 조합 중인 글자 자리에 캐럿이 머문다 — 줄 처음·끝으로 튀거나 앞 글자로 돌아가지 않는다 | QtTest의 「조합 중 캐럿 이동 0」은 논리 커서다. 화면만 튄다면 레이아웃·하이라이터 재실행(step8 실측: preedit도 `contentsChange`를 내고 하이라이터가 다시 돈다 — 색은 캐시) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 2 | preedit 표시와 역할 색(step8 2) | 1번을 하며 조합 중 글자를 본다 | 조합 중 글자가 캐럿 자리에 IME 표시(밑줄 등)로 보이고, 그 줄의 역할 색(제목 블루 `#0a4da6` · 부제 레드 `#c8102e` · 본문 `#1a1a1a` · `(끝)` 골드 `#d4af37`)이 유지된다 | 서식 병합은 레이아웃 서식으로만 확인했다(픽셀 아님) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 3 | 조합 중 단축키 미개입(RUNBOOK 2 · step8 3) | 조합 중(글자가 확정되기 전)에 Alt+Y · Ctrl+Y · Ctrl+D · Ctrl+Z를 하나씩 누른다 | 조합이 진행 중인 동안에는 `(끝)` 삽입·`(계속)` 삽입·줄 삭제·되돌리기가 일어나지 않는다. **MS-IME가 키를 넘기기 전에 조합을 먼저 확정했다면** 그 뒤의 단축키 동작은 정상이다 — 어느 쪽이었는지를 적는다 | 위젯은 preedit이 비었을 때만 키를 인식한다(decisions (4)). 확정 없이 단축키가 먹으면 결함 | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 4 | 확정 뒤에만 재색칠(RUNBOOK 3 · step8 4) | 빈 첫 줄에 제목을, 부제 구간(2~5번째 줄)에 글을 한글로 친 뒤 조합을 끝낸다(스페이스 · 다음 글자 · Enter) | 역할 색은 조합이 끝난 뒤에 바뀌고, 바뀌는 순간 캐럿·글자가 튀지 않는다 | 재색칠 트리거는 `compositionend`·`load`·`blur`뿐(`shouldRecolor`) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 5 | 차단 위치의 IME 정지와 재개(step8 5) | 한글 모드로 캐럿을 마지막 `(끝)` 위·뒤에 두고 친다 → 캐럿을 `(끝)` 앞으로 옮겨 다시 친다 | `(끝)` 위·뒤에서는 조합이 시작되지 않고 아무것도 입력되지 않는다 · 앞으로 옮기면 **한/영 상태를 유지한 채** 한글 조합이 재개된다 | 차단 구간에서 `Qt::ImEnabled=false`(스파이크 경로). 재개 뒤 영문으로 바뀌어 있으면 MS-IME 상태 복원 문제 | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 6 | 조합 중 마우스 클릭(step8 6) | 한 글자를 조합하는 도중에 다른 줄을 마우스로 클릭한다 | 조합 중이던 글자가 **원래 자리에 한 번** 확정되고(중복·유실 0) 캐럿이 클릭한 곳으로 간다 — 다르게 동작하면 그 동작을 그대로 적는다 | 오프스크린 QtTest는 preedit 폐기만 보았다(실기에서는 Qt가 플랫폼 commit을 보낸다) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 7 | `(끝)` 뒤 입력 차단 — 전 경로(RUNBOOK 4 · step8 7 · step9 8) | 캐럿을 마지막 `(끝)` 뒤에 두고 영문·한글 타이핑 · Enter · Ctrl+V(한 줄 · 여러 줄) · Shift+Insert · Insert(수정 모드) 후 타이핑 · Alt+Y · Ctrl+Y. 이어서 `본문` 줄 끝 Delete(다음 줄이 `(끝)`) · `(끝)` 줄 시작 Backspace · `본문`~`(끝)`에 걸친 여러 줄 선택 후 Delete. 마지막으로 Ctrl+D로 `(끝)` 줄을 지우고 다시 친다 | `(끝)` 뒤 쓰기는 **어느 경로로도** 본문을 바꾸지 않는다 · Alt+Y는 마커를 늘리지 않는다 · Ctrl+Y의 `(계속)`이 들어가도 `(끝)`은 마지막 줄로 남는다 · 줄 병합은 `본문(끝)`을 만들지 않는다 · 여러 줄 선택 삭제 뒤에도 마커 줄이 온전히 남는다 · **삭제·이동·선택은 막히지 않는다** · 마커를 지우면 입력이 재개된다 | 위젯 머리 주석의 경로 표(`src/ui/editorwidget.h`)와 위 「「(끝)」 마커 게이트」 표. 대소문자 변환은 P5 앱에 진입점이 없어 수행 대상이 아니다(보기 메뉴 = P6) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 8 | 물리 키보드 단축키(step8 8) | 실제 키보드(QWERTY)에서 한글 모드·영문 모드 각각 Alt+Y · Ctrl+Y · Ctrl+D · Ctrl+Z · Ctrl+Shift+Z · Insert. 가능하면 Dvorak·AZERTY 배열로 바꿔 Ctrl+물리 Y · Ctrl+물리 W를 누른다 | 한글 모드에서도 같은 키가 같은 동작을 한다(물리 키 = 스캔코드) · Dvorak의 Ctrl+물리 Y = 찾기(P6 — 화면에 아무 일도 없다) · AZERTY의 Ctrl+물리 W = 되돌리기 | 키 매핑 표는 PostMessage 실측이다(하드웨어 미검증) · `EditorShortcutsTest`의 레이아웃 교차 16행과 `EditorInputTest`의 판정 순서 표 | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 9 | CR 대체 공백 표시(step8 9) | 기사 (b)를 연다 | 각 줄이 한 줄로 보이고(줄이 둘로 쪼개지지 않는다) 줄 끝 CR 자리는 공백 1칸으로 보인다 | `displayLine` 대체 표시(실제 텍스트는 블록에 남는다) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 10 | undo/redo 체감(RUNBOOK 5 · step8 10 · step9 6) | 한 문장을 빠르게 친 뒤 Ctrl+Z, 다시 Ctrl+Shift+Z · 0.5초 넘게 쉬어 가며 친 뒤 Ctrl+Z 여러 번 · Ctrl+D 뒤 Ctrl+Z · Ctrl+Y가 redo가 아님을 확인 | 빠른 타이핑은 한 단계로, 쉬어 가며 친 것은 쉼마다 한 단계로 되돌아간다 · 되돌린 뒤 캐럿·색이 이상하지 않다 · Ctrl+Y는 `(계속)`을 넣는다 | coalesce 500 ms · limit 100 · 문서 자체 undo off(`EditControllerTest`·`EditorHistoryTest`) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 11 | 더블클릭 전환과 포커스(step9 2) | 목록에서 기사 (a) 행을 더블클릭한 뒤 클릭 없이 곧바로 타이핑한다 | 편집 페이지로 바뀌어 본문이 보이고, 입력이 편집기로 간다 | 호스트가 열 때 편집기에 포커스를 준다(화면으로 확인한 적 없음) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 12 | 상단 버튼과 안내 문장(step9 3) | 편집 중 [저장] → [복구](초안 없음)를 누르고 문장을 읽는다 | [저장] [복구] [닫기]가 보이고 `저장되었습니다.` · `복구할 자동저장 내용이 없습니다.`가 잘리지 않고 읽힌다 | 안내 문장은 평문(PlainText) 라벨이다 | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 13 | 잠금 실패 화면(step9 4) | **다른 계정**(편집 권한이 있는 계정)으로 웹·Electron 클라에서 기사 (c)를 먼저 열어 잠가 둔다 → Qt에서 (c)를 더블클릭한다 | 본문이 **읽기 전용**으로 보이고 `편집중입니다.`가 읽힌다 · 어떤 키·붙여넣기·IME로도 본문이 바뀌지 않는다 · [저장]·[복구]가 비활성이다 | **같은 계정으로 로그인하면 Qt 세션이 끊긴다**(같은 사용자 로그인은 그 사용자의 기존 세션을 전부 무효화한다) — 계정을 먼저 확인 | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 14 | 닫은 뒤 목록 재진입(step9 5) | 편집 중 [닫기] | 목록 페이지로 돌아오고 상단 바에 `● 실시간`이 다시 보인다 · 다른 계정이 만든 기사가 다시 실시간으로 나타난다 · 웹에서 그 기사가 잠겨 있지 않다 | 셸의 목록 진입(신원 확인 → 조회 → 스트림) | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) |
| 15 | 자동저장/복구 실기(RUNBOOK 5 · step9 7) | — | **P5 운영 빌드에서는 수행할 수 없다** — 자동저장 기본 off이고 켜는 UI(환경설정)는 P6다. 하네스가 보인 사실은 `--scenario edit`의 1초 자동저장 1회가 `CLIENT_USER_DATA`의 `editor-drafts.json`에 편집 뒤 필드로 쓰였다는 것뿐이다 | P6가 환경설정을 붙인 뒤 이 항목을 다시 연다 | 미검증 — 사람 확인 필요(실물 MS-IME, `client-qt\run.bat`) · P5 운영 빌드로는 수행 불가(켜는 UI = P6) |

**왜 이 열다섯은 자동화할 수 없는가**: 1~6은 실물 IME의 조합 이벤트 순서와 화면 레이아웃의 결과다(합성 `QInputMethodEvent`는 MS-IME가 실제로
보내는 순서·확정 시점을 재현하지 못한다). 7·9~14는 같은 동작이 **화면에서 어떻게 보이는가**이고(QtTest는 논리 상태·서식 범위까지 — 픽셀 0),
8은 물리 하드웨어, 15는 운영 빌드에 켤 수단이 없다.

**여기 없는 것(자동 커맨드가 판정한다 — 육안으로 내리지 마라)**: 마커 게이트의 논리 판정(`EditorNewlineTest`·`EditorWidgetTest`) · 저장 바이트 = 웹 정본
(`--scenario edit`의 S) · `x-edit-client` 3라우트·표면당 1개(`judgeEditWire` · 와이어 테스트) · 상태 전이·fail-closed(`EditControllerTest`) ·
화면 인벤토리(`ScreenInventoryTest`) · 비밀번호·제목·본문·기사아이디·`EditClientId` 유출 0건(드라이버 매 실행).

### P6(에디터 확장)가 곧바로 쓸 것

정본은 `phases/78-editor-core/index.json`의 **`forward_notes`**다. 코드에서 시작할 자리만 적는다.

- **정렬**(sortDocument/sortParagraph) → `editoreditops`에 · `sortParagraph`는 `paragraphBoundsAt`, 재정규화는 `renormalizeEndMarker`를 호출(재구현 금지).
- **찾기 엔진** → `isFindReplace` 옆 · 위젯은 이미 Ctrl+F를 소비하고 `shortcutTriggered(FindReplace)`만 낸다(Ctrl+B · Alt+O · Alt+V도 같다).
- **사용자 글리프 키맵** → `RESERVED_COMBOS`(정확히 13)를 읽고 웹 `isSwallowedByReservedHandlers`(느슨 변형)를 함께 이식 · 판정 순서상 자리는 `isRedo`와 `isDeleteLine` 사이.
- **맞춤법** → `insertEndMarker().spellcheck`가 트리거 · Qt 네이티브 맞춤법은 배선하지 않는다(override L174 · ADR-011).
- **색 환경설정** → `COLORS`는 기본값 상수로 두고 활성 색을 주입(모듈 전역 가변 금지 — 웹 `activeColors`가 테스트에 reset을 요구했던 이유).
- **자동저장 환경설정** → `AutosaveConfig`를 `WriterHost::Options`로 주입(지금은 웹 기본 off · 60초 · 1일) — 켜는 UI가 생기면 육안 15번을 수행한다.
- **대소문자 변환 메뉴** → `EditorWidget::transformCaretLine(fn)`(`toUpper`·`toLower`·`capitalizeFirst`·`toggleCase`) — 게이트가 내장돼 있다.
- **임베드 렌더** → `Block::embed`는 키 순서 그대로 운반되고 있다. 「텍스트 줄 1 = 문서 블록 1」을 깨면 「캐럿 = `TextPoint` 무변환」 전제가 깨진다 — 설계 결정이 먼저다.
- **상태표시줄**(`editorStats.paragraphIndex`) → `isParagraphBoundary`를 호출(정의 중복 금지).
- **다이얼로그를 처음 여는 phase**는 `sourcesOpenNoDialogWindow`와 화면 인벤토리 결정을 함께 연다(P5의 파일>복구에 확인창이 없는 이유).
- **Qt를 올리면** `EditorShortcutsTest`의 Unicode 17.0 행과 `currentUnicodeVersion() == Unicode_16_0` 단언이 red가 된다 — divergence가 사라진 것이니 헤더를 갱신하라.
- **diag 이벤트를 늘리려면** `shell::allowedDiagEvents()`(21) + `contractedFields()` + 처분 표 + `DiagTest` — shell 변경이다(책임자 확인 3).

### 무엇이 P5가 아닌가

| 범위 밖 | 소유 phase |
|---|---|
| 임베드 7종 렌더·삽입 · 맞춤법+하이라이트 · 찾기바꾸기 · 표 · 인쇄 · 다이얼로그 17종 · 환경설정 8탭(자동저장·색 포함) · 보기 메뉴(정렬·대소문자) · 상태표시줄 · 인코딩 표시 | P6 |
| 조회 6메뉴 · 컬럼 설정 · 우클릭 14액션 · 상세보기 창 · 관리 4화면 · 강제 해제·takeover 감지 · 잠금 충돌 실기 | P7 |
| 신규 기사(POST) · 송고/보류/KILL · 매핑 | 소유 phase 미확정(step9 (h)는 「P7 등」) |
| 한글 제품명 exe · 아이콘 · windeployqt · 설치 패키징 · 훅의 컴파일 타임 분리 · Electron 은퇴 | P8 |

**서버·웹·Electron 클라·계약·`client-qt/src/net`·`client-qt/src/shell`은 P5가 한 줄도 고치지 않았다**(phase 78 각 step의 무접촉 축 `git diff --stat` 무출력).
