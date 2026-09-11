# Step 4: shell-diag

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `baseline`(B)(C) · `decisions` (2)(4)(12)
- `docs/ADR.md` **ADR-018**(자동 검증 결정) · **ADR-007**(로그 마스킹 규율의 정신)
- **정본 소스(읽기 전용)**: `client/diag.js` **전문(약 60행)** — `FORBIDDEN_KEYS` 7종 · `redactUrl` · `redactDiagEvent` · `formatDiagLine` · `createDiag`(파일 경로 없으면 완전 no-op)
- **정본 소스(읽기 전용)**: `client/main.js` — `diag.log(...)` **19개 호출 지점**(이벤트 이름과 payload 필드를 여기서 확인한다)
- **판정자(읽기 전용)**: `scripts/verify-client.mjs` **94~126행**(`readDiag`·`findSequence`·`waitForSequence` — 이 형식을 읽는 쪽의 계약)
- `docs/porting-plan-cpp-spring.md` §6.2 **152행**("diag JSONL: 이벤트 이름·필드·금지 키 7종 유지 → 검증 자동화 재사용, 렌더러 계열 4이벤트만 재매핑")
- `phases/77-qt-client-skeleton/step0.md`~`step3.md` 산출물(`client-qt/src/shell/`)

## 배경

**이것이 이 phase의 검증 척추다.** 네이티브 클라에는 CDP가 없으므로, 「앱이 무엇을 했는가」를 말해 주는 유일한 기계 판독 경로가 diag JSONL이다(그 위에 서버 측 사실이 교차 조건으로 얹힌다 — `decisions` (2)).

정본이 강제하는 형식은 **한 줄 = 한 JSON 객체**이고 필드는 `{ts:ISO8601, event:<이름>, ...평문 필드}`다. 규율:

- **금지 키 7종**(`body`·`sessionId`·`cookie`·`cookies`·`password`·`token`·`headers`)은 **버린다**.
- 값은 **string·number·boolean·null만** 통과한다(객체·배열은 버린다 — 직렬화 보장).
- 키 이름에 `url`이 들어가면 **origin+pathname까지만** 남긴다(쿼리·해시 제거 — 기사아이디·토큰 표면 차단). `file:` 스킴은 스킴+파일명만.
- **`CLIENT_DIAG_FILE`이 없으면 완전 no-op** — 파일을 만들지도, 쓰지도 않는다.
- 기록 실패(디스크 풀·권한)는 **삼킨다** — 진단이 앱을 죽이면 본말전도다.

## 작업

**테스트 먼저.** 아래 규칙 각각에 대한 케이스를 QtTest로 먼저 쓰고 구현한다.

### A. `client-qt/src/shell/`의 diag 모듈

```cpp
class Diag {
public:
  static Diag* create(const QString& filePath);  // 빈 경로면 no-op 인스턴스
  void log(const QString& event, const QVariantMap& payload);
};
QString formatDiagLine(const QString& event, const QVariantMap& payload, qint64 epochMs); // 순수 — 테스트 대상
```

- 출력은 **UTF-8**이고 줄바꿈은 **`\n` 하나**(CRLF 금지 — 판정자가 줄 단위로 파싱한다).
- `ts`는 ISO-8601(정본은 `new Date(now).toISOString()` = 밀리초 + `Z`).
- **키 순서**: 정본은 `ts` → `event` → 나머지다. 판정자는 JSON 파서를 쓰므로 순서 의존은 아니지만 **같은 순서로 맞춰라**(사람이 두 로그를 나란히 놓고 읽는다).
- 파일 append는 **동기**로 하고 실패를 삼킨다. 프로세스가 죽어도 이미 쓴 줄은 남아야 한다(버퍼링으로 마지막 이벤트를 잃지 마라 — 판정자가 마지막 이벤트를 기다린다).

### B. 이벤트 처분 표를 확정하고 잠근다

`client/main.js`의 19개 호출 지점을 네 갈래로 처분하고, **최종 표를 `client-qt/README.md`에 적고 테스트로 잠근다**(허용 이벤트 이름 집합을 상수로 두고, 그 집합 밖 이름으로 `log()`를 부르면 테스트가 red).

제안(구현자가 확정한다 — 바꾸면 근거를 README에 적어라):

| 갈래 | 이벤트 |
|---|---|
| **승계**(이름·의미 그대로) | `app-ready` · `config-loaded` · `config-saved` · `probe` · `second-instance` · `setup-shown` · `restart-required` · `window-open`(외부 링크를 기본 브라우저로) |
| **재매핑**(렌더러 개념 → 네이티브 화면) | `app-window`(메인 창 표시) · `local-window`(설정/오류 화면) · `did-finish-load` → 화면 준비 완료 · `load-failed` → 서버 도달 실패 |
| **소멸**(대응물 없음) | `secure-origin-switch` · `navigation` · `ipc` · `render-process-gone` · `unresponsive` · `did-navigate` |
| **신설**(P4 게이트가 요구) | `net-request{route,method,status,ms}` · `login{status}` · `session{status}` · `sse-open` · `sse-ready` · `sse-change{kind}` · `sse-unauthorized` · `sse-closed{reason}` · `list-loaded{menu,count}` |

**소멸시킨 이벤트를 흉내 내지 마라** — 네이티브에 없는 개념을 남기면 판정자가 거짓 신호를 읽는다.

### C. 유출 방지 규율 확장 (P4가 새로 여는 표면)

- **`net-request.route`에는 라우트 id 또는 경로 템플릿만 적는다**(`articles-get` 또는 `/api/articles/:id`). **구체 기사아이디가 들어간 경로를 적지 마라** — 정본이 쿼리를 지운 이유와 같은 축이다.
- **기사 제목·본문·사용자 이름을 어떤 이벤트에도 적지 마라.** 목록은 **건수(count)** 만 적는다.
- `login`/`session` 이벤트에는 **HTTP status만** 적는다(비밀번호·세션 토큰·role 금지 — role은 금지 키가 아니지만 여기 적을 이유가 없다).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
```
- exit 0 · 테스트 총계 증가 · 실패 0. 아래가 테스트로 존재해야 한다:
  - 금지 키 7종 전건이 **버려진다**(7 케이스).
  - 객체·배열 값이 버려진다 · `undefined`/`null` 처리가 정본과 같다.
  - `...url` 키가 origin+pathname으로 잘린다(쿼리·해시 제거) · `file:` 스킴은 파일명만 · `about:blank`는 그대로.
  - `CLIENT_DIAG_FILE` 미설정이면 **파일이 생기지 않는다**.
  - 허용 이벤트 이름 집합 밖 이름은 red.
  - 출력 줄이 **유효한 JSON 1줄**이고 `\n`으로 끝난다(CRLF 아님).

```
node --input-type=module -e "import('./client/diag.js').then(({formatDiagLine})=>console.log(formatDiagLine('probe',{ok:true,url:'http://h:3001/api/health?x=1'},0)))"
```
- **정본 출력과 C++ 출력을 눈으로 나란히 비교**하고 그 결과(같음/다름과 차이 내역)를 요약에 적는다. `client/diag.js`는 **ESM**이라 기본 `node -e`(CJS 문맥)에서는 `await`/`import` 문법이 막힌다 — 위처럼 `--input-type=module`을 쓰거나, 작은 임시 스크립트를 **리포 밖**(스크래치패드)에 만들어 실행하라(리포에 파일을 남기지 마라).

```
npm test
npm run lint
git status --porcelain
```
- 무회귀 · `client/**` diff 0.

## 검증 절차

1. **TDD red 실증** 후 구현.
2. **변이 2종**:
   - M4-1 금지 키 필터를 제거 → 7 케이스가 red인가? 원복.
   - M4-2 URL 리댁션을 제거(쿼리 포함 전체 기록) → red인가? 원복.
3. **형식 상호운용 실증**: C++가 쓴 diag 파일을 **`scripts/verify-client.mjs`의 판정 로직과 같은 방식**으로 읽을 수 있는지 확인한다 — 즉 `node -e`로 파일을 줄 단위 `JSON.parse` 해 전 줄이 파싱되고 `event` 필드가 있는지 본다(이 확인은 step6 드라이버가 자동화한다).

## 되돌림

이 step의 소스·테스트와 `common.pri` 항목 제거.

## 금지사항

- **`client/diag.js`를 고치지 마라.** 이유: Electron 클라의 살아 있는 계약이고 `verify-client.mjs`가 그것을 판정한다(무접촉).
- **금지 키·리댁션 규칙을 완화하지 마라.** 이유: 이 파일은 개발자·CI가 보는 로그이고, 완화하면 세션 토큰·기사 본문이 로그로 샌다(정본 머리 CRITICAL).
- **비동기 버퍼링으로 마지막 이벤트를 잃지 마라.** 이유: 판정자는 시퀀스의 **마지막 이벤트**를 기다리다 타임아웃한다 — 앱은 정상인데 게이트가 실패한다.
- **없는 이벤트를 미리 만들지 마라**(예: 에디터·목록 우클릭 계열). 이유: 허용 집합이 곧 P4의 경계이고, 늘리면 범위가 조용히 넓어진다.
- **범위를 넓히지 마라**(창 생성·네트워크). 이유: step5·step7의 것이다.
