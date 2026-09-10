# client-qt — Qt 네이티브 클라이언트 (로드맵 P4 · phase 77)

`docs/porting-plan-cpp-spring.md` §7 **P4 「C++ 클라 골격」** 의 산출물이다. Electron 셸 + 웹 SPA(`client/` + `web/`)를
대체할 네이티브 클라이언트를 여기에 세운다. **P4까지는 Electron 클라가 상시 대체재**이므로(로드맵 187행) 이 모듈이
동작하지 않아도 운영은 영향을 받지 않는다.

## 빌드 · 실행

```
cmd /c client-qt\build.bat        빌드(app + tests) 후 테스트 실행 — 실패하면 비-0 종료
cmd /c client-qt\run.bat          앱 실행(인자는 그대로 전달)
cmd /c client-qt\run.bat --selftest   창 없이 Qt 런타임 확인만 하고 0으로 종료
```

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
src/shell/      프로브 판정 · config · diag · 창 정책            (step2~5)
src/net/        라우트 표 · 전송 · Model 인터페이스 · SSE        (step7~9)
src/ui/         로그인 · 목록 · 서버 주소 설정                   (step10~11)
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
- **리다이렉트 최종 URL 관측 가능성은 미검증이다.** 정본조차 Electron 실왕복으로 검증한 적이 없다(phase 66 step4
  기록). Qt에서 `QNetworkReply::redirected`가 진짜 최종 URL을 주는지는 전송 계층 step이 **자기 손으로 실측**해야
  하고, 그 전에는 `resolveFinalOrigin`의 입력을 신뢰한다고 주장하면 안 된다.

## 무엇이 P4가 아닌가

| 범위 밖 | 소유 phase |
|---|---|
| 에디터(텍스트 엔진·블록 모델·IME·undo·자동저장) | P5 |
| 임베드·맞춤법·찾기바꾸기·표·인쇄·다이얼로그 17종·환경설정 8탭·i18n | P6 |
| 조회 6메뉴·컬럼 설정·우클릭 14액션·상세보기 창·관리 4화면 | P7 |
| 한글 제품명 exe·아이콘·windeployqt·설치 패키징·Electron 은퇴 | P8 |

**서버·웹·Electron 클라·계약(`server/**`·`src/**`·`web/**`·`client/**`·`contract/**`·`docs/api-contract/**`)은 이
모듈이 한 줄도 고치지 않는다.** 계약은 동결(P1)이고 클라이언트는 그것만 믿는다.
