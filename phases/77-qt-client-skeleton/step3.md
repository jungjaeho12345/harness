# Step 3: shell-config-store

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `decisions` (1)(6)(11)(12)
- `docs/ADR.md` **ADR-018** · **ADR-011**
- **정본 소스(읽기 전용)**: `client/lib/clientConfig.js` **전문** — `CONFIG_FILENAME`·`CONFIG_SCHEMA_VERSION`·`configPath`·`parseConfig`(화이트리스트)·`sanitizeBoundsShape`·원자적 쓰기(tmp→rename)
- **정본 소스(읽기 전용)**: `client/lib/windowPolicy.js` — 창 2종 분리 · 기본/최소 **창** 크기 상수(1440×900 / 1024×720). **`workArea` 교차 판정과 bounds 검증은 이 파일이 아니라 위 `clientConfig.js`(31-39·73-83)에 있다**(포트 스펙 실측 2026-09-10).
- **명세서(읽기 전용)**: `test/client-shell-core.test.js`(config·bounds 케이스)
- `phases/77-qt-client-skeleton/step2.md`와 그 산출물(`client-qt/src/shell/`의 `normalizeServerUrl` — config 파싱이 그것을 쓴다)

## 배경

설정 파일은 **신뢰 경계 밖**이다. 정본이 그것을 세 규칙으로 다룬다.

1. **shape은 화이트리스트 하나뿐** — `{ schemaVersion, serverUrl, bounds:{width,height,x,y,maximized} }`. 그 밖의 키는 파일에 있어도 **결과에 없다**.
2. **어떤 입력에도 throw하지 않는다** — 설정이 깨졌다고 앱이 못 뜨면 사용자에게 복구 수단이 없다(주소 재입력 화면으로 가야 한다).
3. **세션ID·비밀번호·쿠키·토큰을 담는 필드를 만들지 않는다**(파일 머리 CRITICAL). `decisions` (6)이 그 규율 위에 서 있다 — **세션 쿠키를 여기 저장하려는 유혹이 이 step에서 처음 발생한다. 하지 마라.**

쓰기는 **tmp → rename**(원자적)이다. 이유: 쓰는 도중 전원이 나가면 config가 반쯤 쓰인 채 남아 다음 부팅이 깨진다.

**이 phase의 폴더는 Electron과 다르다**: `%APPDATA%\기사작성기-qt\config.json`(`decisions` (11) — 두 클라가 P8까지 공존하므로 같은 파일을 번갈아 덮어쓰면 `serverUrl`·`bounds`가 서로 지워진다). 스키마·파일명·규율은 **동일**하다. 하네스는 `CLIENT_USER_DATA` env로 임시 폴더를 주입한다(같은 env 이름 승계).

## 작업

**테스트 먼저.** `test/client-shell-core.test.js`의 config·bounds 케이스를 입출력 표로 추출해 QtTest로 옮기고 구현한다.

`client-qt/src/shell/`에 두 모듈:

```cpp
// 1) 파싱·직렬화 — 순수. 파일시스템 접근 없음.
struct Bounds { int width, height, x, y; bool maximized; bool valid; };
struct ClientConfig { int schemaVersion; QString serverUrl; /*빈 문자열=없음*/ Bounds bounds; };
ClientConfig parseConfig(const QByteArray& rawJson);   // 어떤 입력에도 예외를 던지지 않는다
QByteArray   serializeConfig(const ClientConfig&);     // 화이트리스트 키만

// 2) 저장소 — 파일시스템 경계. 경로 해석 + 원자적 쓰기.
QString configDir();                                   // CLIENT_USER_DATA 우선, 없으면 %APPDATA%\기사작성기-qt
bool    saveConfigAtomically(const QString& dir, const ClientConfig&, QString* err);
```

규율:

- `serverUrl`은 **step2의 `normalizeServerUrl`을 통과한 origin만** 저장한다(정본과 동형 — 파일에 이상한 값이 있으면 버린다).
- `bounds`는 정수 5키 + **최소 크기**(정본 값: width ≥ 800 · height ≥ 600) 검증. **모니터 배치(workArea) 교차 판정은 별도 함수**로 두고(정본이 파싱 시점에는 모니터 구성을 모른다는 이유로 분리했다) 화면 복원 시 step5가 쓴다.
- **원자적 쓰기**: 같은 디렉토리에 임시 파일로 쓰고 `rename`으로 갈아끼운다(다른 볼륨의 임시 폴더를 쓰면 rename이 원자적이지 않다).
- 디렉토리가 없으면 만든다. 실패는 **예외가 아니라 결과값**으로 돌려준다(앱이 죽지 않는다).
- **`CLIENT_USER_DATA`가 있으면 그 경로를 절대 경로로 해석해 쓴다** — 하네스가 실사용자 폴더를 건드리지 않는 유일한 수단이다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
```
- exit 0 · 테스트 총계가 step2 대비 증가 · 실패 0.
- **원자적 쓰기 실증 테스트가 있어야 한다**: 저장 후 디렉토리에 **임시 파일이 남지 않고** `config.json`만 있으며, 기존 파일이 있을 때 덮어쓰기가 성공한다. 쓰기 실패(존재하지 않는 드라이브 등)에서 **예외가 아니라 실패 결과**가 나온다.
- **화이트리스트 실증 테스트**: `{"serverUrl":"http://h:3001","sessionId":"abc","cookie":"x","bounds":{...},"junk":1}`을 파싱하면 결과에 `sessionId`·`cookie`·`junk`가 **없다**.

```
npm test
npm run lint
git status --porcelain
```
- 무회귀 · `client/**`·`test/**` diff 0.

## 검증 절차

1. **TDD red 실증** 후 구현.
2. **변이 2종**:
   - M3-1 화이트리스트를 「모든 키 통과」로 바꾼다 → 위 화이트리스트 테스트가 red인가? 원복.
   - M3-2 원자적 쓰기를 **직접 쓰기**(임시 파일 없이 덮어쓰기)로 바꾼다 → 임시 파일 부재만 검사하는 테스트는 **여전히 green일 수 있다**. 그렇다면 테스트가 약한 것이다 — **쓰기 경로가 tmp→rename임을 관측하는 방법**(예: 주입 가능한 파일시스템 인터페이스로 호출 순서를 단언)으로 바꾸고 다시 실증하라. 원복.
3. 실사용자 폴더 안전: 테스트가 **어떤 경우에도 `%APPDATA%\기사작성기`(Electron)·`%APPDATA%\기사작성기-qt`(실사용자)에 쓰지 않는지** 확인한다 — 테스트는 임시 디렉토리만 쓴다. 실행 전후로 두 폴더의 존재·`config.json` 크기/시각을 비교해 무변을 요약에 적는다.

## 되돌림

이 step이 추가한 소스·테스트 파일과 `common.pri` 항목만 제거한다.

## 금지사항

- **세션·쿠키·비밀번호·토큰을 config에 저장하지 마라.** 이유: 파일은 신뢰 경계 밖이고, 정본이 그 필드를 만들지 않기로 못 박았다(`decisions` (6)).
- **파싱에서 예외를 던지지 마라.** 이유: 깨진 설정으로 앱이 못 뜨면 사용자에게 복구 경로가 없다.
- **Electron 클라와 같은 폴더를 쓰지 마라.** 이유: 두 앱이 P8까지 공존하며 원자적 쓰기로 서로의 `serverUrl`·`bounds`를 지운다(`decisions` (11)).
- **테스트에서 실사용자 `%APPDATA%`에 쓰지 마라.** 이유: 검증이 실환경을 오염시키면 이후 판정의 기준점이 사라진다(`verify-client.mjs`가 그 스냅샷을 단언하는 이유와 같다).
- **범위를 넓히지 마라**(창 생성·bounds 복원 실행·diag). 이유: step5의 것이다.
