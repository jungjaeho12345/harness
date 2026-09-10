# Step 2: shell-serverurl

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `baseline`(A) · `decisions` (1)(12)
- `docs/ADR.md` **ADR-018**(step1 신설) · **ADR-011**(Electron 접속형 셸 — 무엇이 계약이고 무엇이 브라우저 개념인가)
- **정본 소스(읽기 전용 · 고치지 마라)**: `client/lib/serverUrl.js` **전문(약 100행)** — `normalizeServerUrl` · `healthUrl` · `appUrl` · `isSameOrigin` · `resolveFinalOrigin` · `interpretHealthResponse`
- **명세서(읽기 전용)**: `test/client-shell-core.test.js` · `test/client-probe-origin.test.js` — **이 두 파일의 케이스가 이식의 합격 기준이다**
- `docs/porting-plan-cpp-spring.md` §6.2 **150행**(이식 필수: 서버 주소 프로브 — `/api/health` 본문 `{ok:true}` 판정 + 리다이렉트 최종 origin 승격 + fail-safe)
- `client-qt/README.md` · `client-qt/common.pri`(step0 산출물 — 소스 추가 방법)

## 배경

Electron 셸의 **서버 주소 정책**은 순수 판정 모듈 하나에 모여 있다. 네트워크 호출은 그 모듈에 없다 — **판정만** 한다. Qt 이식도 같은 성질을 유지해야 단위 테스트가 가능하다(프로브 실행은 step5·step7의 몫).

정본이 강제하는 규칙(전부 `client/lib/serverUrl.js`에 근거가 적혀 있다):

- **문자열 자르기·정규식으로 origin을 조립하지 마라** — 포트 생략·IPv6·유니코드 호스트에서 조용히 틀린 origin이 나오고, 그 값이 이후 정책의 입력이 된다.
- 스킴 보정: 운영자는 `192.168.0.10:3001`처럼 친다. `localhost:3001`은 문법상 스킴처럼 보이지만 **콜론 뒤가 포트 숫자면 host:port로 해석**한다.
- 거부 사유 5종: `empty` · `unsupported-scheme` · `invalid` · `credentials`(`user:pass@` — 자격증명이 설정 파일에 남는 표면 차단) · `no-host`.
- 결과는 **origin만**(경로·쿼리·해시 버림).
- `interpretHealthResponse`: status 없음 → `unreachable` · 200 아님 → `http-status` · **본문이 `{ok:true}` JSON일 때만 성공** · 그 외 `not-article-server`(임의의 웹 서버·사내 프록시·캡티브 포털도 200을 준다).
- `resolveFinalOrigin` **fail-safe**: 최종 URL이 없거나·문자열이 아니거나·파싱 불가·http/https 밖·자격증명 포함·**https 입력의 http 하향**이면 **요청 origin 유지**. 상향(http→https)은 승격한다.

**Qt 함정(반드시 확인하고 처리하라)**: `QUrl`은 WHATWG `URL`과 파싱 규칙이 다르다 — 특히 `QUrl("localhost:3001")`은 스킴 `localhost`로 읽힐 수 있고, `QUrl::authority()`/`host()`의 빈 값 처리, 대소문자 정규화, 기본 포트 생략(`http://host:80` → `http://host`) 규칙이 다르다. **명세 테스트의 케이스가 정답이다** — `QUrl` 동작을 그대로 믿지 말고 케이스로 확인해 필요한 보정을 넣어라.

## 작업

**테스트 먼저.** `test/client-shell-core.test.js`·`test/client-probe-origin.test.js`에서 이 모듈에 해당하는 케이스를 **입출력 표로 추출**해 `client-qt/tests/`의 테스트 클래스로 옮긴 뒤(QtTest의 `_data()` 데이터 주도 테스트가 적합), 구현을 붙여 green으로 만든다.

`client-qt/src/shell/`에 순수 모듈을 만든다(시그니처는 예시 — 이름·형태는 재량이되 **의미는 정본과 동일해야 한다**):

```cpp
struct NormalizedUrl { bool ok; QString origin; QString reason; };
NormalizedUrl normalizeServerUrl(const QString& input);

QString healthUrl(const QString& origin);   // origin + "/api/health"
QString appUrl(const QString& origin);      // 네이티브에는 화면 로드가 없다 — 아래 주의 참조
bool     isSameOrigin(const QString& url, const QString& origin);

struct FinalOrigin { QString origin; bool changed; };
FinalOrigin resolveFinalOrigin(const QString& requestedOrigin, const QString& responseUrl);

struct HealthVerdict { bool ok; QString reason; };            // reason: unreachable|http-status|not-article-server
HealthVerdict interpretHealthResponse(int status, const QByteArray& body); // status<0 = 네트워크 실패
```

- **`appUrl`은 이식하지 마라(또는 이식하되 쓰지 마라)**: Electron 셸은 `${origin}/`을 `loadURL`해 **서버가 서빙하는 SPA**를 띄웠다(ADR-017 ①). 네이티브 클라는 자기 화면을 갖고 있으므로 그 개념이 **소멸**한다. 남길지 여부를 정하고 그 이유를 README에 한 줄로 적어라.
- **`isSameOrigin`은 남긴다**: 외부 링크를 기본 브라우저로 여는 정책(§6.2 154행)의 판정에 쓰인다.
- 이 모듈은 **네트워크·파일시스템·전역 상태에 접근하지 않는다**(단위 테스트 가능성의 근거).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
```
- exit 0 · 테스트 총계가 step0 대비 **증가**하고 실패 0.
- 이 step이 추가한 케이스 수를 요약에 적는다(정본 테스트에서 추출한 케이스 대비 **몇 건을 옮겼고 몇 건을 옮기지 않았는지** — 옮기지 않았다면 이유를 적는다. 「전부 옮겼다」를 근거 없이 적지 마라).

```
npm test
npm run lint
git status --porcelain
```
- 무회귀 · `client/**`·`test/**` **diff 0**(정본은 읽기만 했다).

## 검증 절차

1. **TDD red 실증**: 케이스를 먼저 넣고 빌드가 **실패**하는 것을 본 뒤 구현한다. 최소 1건의 red 로그를 요약에 남긴다.
2. **변이 2종**:
   - M2-1 `interpretHealthResponse`에서 **본문 검사만 제거**(200이면 무조건 ok) → 해당 케이스가 red인가? 원복.
   - M2-2 `resolveFinalOrigin`의 **https→http 하향 차단**을 제거 → red인가? 원복.
   - 두 변이가 red를 못 내면 **케이스가 부족한 것**이다 — 케이스를 추가하고 다시 실증한다.
3. **경계 케이스 직접 확인**(정본 테스트에 있는지 확인하고 없으면 추가): `localhost:3001` · `192.168.0.10:3001` · `https://h/` 입력에 `http://h/` 응답 · `user:pass@host` · `ftp://host` · 빈 문자열 · 공백만 · IPv6(`[::1]:3001`).

## 되돌림

`client-qt/src/shell/`의 이 모듈 파일과 대응 테스트, `common.pri`의 소스 목록 항목만 지우면 step1 상태다.

## 금지사항

- **`client/lib/serverUrl.js`·`test/**`를 고치지 마라.** 이유: 정본이자 명세서이고, 고치면 이식의 합격 기준 자체가 흔들린다(무접촉 경로).
- **문자열 조작으로 origin을 만들지 마라.** 이유: 정본 머리의 CRITICAL — 포트 생략·IPv6·유니코드 호스트에서 조용히 틀린 값이 나오고 그것이 정책 입력이 된다.
- **네트워크 호출을 이 모듈에 넣지 마라.** 이유: 판정과 실행이 섞이면 단위 테스트가 불가능해지고, 정본이 그 분리를 명시적으로 유지했다.
- **`QUrl`의 기본 동작을 검증 없이 신뢰하지 마라.** 이유: WHATWG URL과 파싱이 달라 `localhost:3001` 같은 실사용 입력에서 갈린다.
- **범위를 넓히지 마라**(config 저장·diag·프로브 실행). 이유: 각각 step3·step4·step5의 것이고, 섞으면 실패 원인 격리가 안 된다.
