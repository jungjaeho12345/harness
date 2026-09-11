# Step 9: net-sse

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `decisions` (8)(12) · `open_questions` (2) · `excluded` (c)(i)
- `docs/ADR.md` **ADR-018** · **ADR-005**(SSE 단방향 무효화 스트림) · **ADR-007**(로그 스트림은 Z 전용 예외 — P4는 연결하지 않는다)
- **와이어 계약 정본(읽기 전용)**: `docs/api-contract/sse.md` **전문** — **12~18행 열리기 전 거부**(401/403 JSON) · **20~30행 헤더 3종**(「클라이언트 판정에 쓰이므로 이식 시 생략하지 마라」) · 프레임 문법(`event:`/`data:` + **빈 줄 종결자** · LF) · `id:`·`retry:` 미사용 · 어휘 4종(`ready`·`change{kind}`·`log`·`unauthorized`) · **`unauthorized` 1프레임 후 서버가 연결을 닫는다** · `change` 발생 라우트 표 · replay/비연장 peek · **86~90행 판정 시 주의**(정확 kind·개수 단언은 flake · **동시 연결 2개가 정상**)
- **계약 인벤토리(읽기 전용)**: `docs/api-contract/endpoints.json`의 `stream` 행(`expect: ["success","unauthenticated"]` — 열리기 전 401이 **별도 결과**로 열거된다)
- `docs/news-md-overrides.md` **L80**(단일 무효화 신호 + 전체 재조회 · unauthorized면 재연결 영구 중단) · **L127**(SSE push는 세션을 연장하지 않는다 — 클라는 실제 사용자 요청으로 만료 시점을 안다)
- **정본 구현(읽기 전용)**: `web/src/model/httpModel.js` **313~337행**(`subscribe()` — 호출마다 **독립 EventSource** · `unauthorized` → `close()` · error는 재연결 보존 · **327~329행** 무한 재시도 경고 주석 · 열리기 전 비-200 처리 코드는 **0줄** — 브라우저가 대신한다) · `web/src/controller/useViewController.js` **143~147행**(kind를 무시하고 `refresh()`)
- `phases/77-qt-client-skeleton/step7.md` 산출물(`HttpTransport`) · `step8.md` 산출물(라우트 표의 `stream` 행)

## 배경

SSE는 **행 데이터가 없는 무효화 신호**다. 클라가 할 일은 「신호를 받으면 자기 필터로 **전체 재조회**」뿐이다. kind별 부분 갱신을 만들면 오버엔지니어링이자 서버 계약과 불일치다(override L80).

**두 가지가 이 step의 진짜 난이도다.**

1. **프레임 파싱의 정확성** — 종결자는 **빈 줄**(`\n\n`)이고 줄바꿈은 LF다. 청크 경계는 프레임 경계와 무관하므로 파서는 **증분 상태 기계**여야 한다(한 read에 프레임 반 개, 또는 세 개 반이 올 수 있다).
2. **재연결 규율** — `unauthorized`를 받으면 **영구 중단**한다. 이것을 빠뜨리면 세션이 죽은 뒤 클라가 무한 재연결로 서버를 두드린다(정본이 명시적으로 막은 실패 모드).

**Qt 함정**(`open_questions` (2)): `QNetworkAccessManager`가 응답을 버퍼링하거나 HTTP/2·자동 압축 해제를 켜면 프레임이 늦게 도착한다. **파서(순수)와 전송(실기)을 분리**해 파서는 바이트 픽스처로 잠그고, 전송 지연이 관측되면 그 사실과 회피책을 요약에 적어라 — **관측 없이 「된다」고 적지 마라.**

## 작업

**테스트 먼저.** `docs/api-contract/sse.md`의 바이트 예시를 그대로 픽스처로 만든다.

### A. 순수 파서

```cpp
struct SseEvent { QString name; QByteArray data; };
class SseParser {
public:
  QVector<SseEvent> feed(const QByteArray& chunk);  // 증분 · 미완성 프레임은 내부 보관
  void reset();
};
```

케이스(최소):

- 정상 프레임 1개 · 연속 3개 · **청크 경계가 프레임 중간**을 자르는 경우(1바이트씩 흘려 넣어도 같은 결과가 나와야 한다).
- **종결자 빈 줄이 없으면 이벤트를 내보내지 않는다**(정본의 CRITICAL — 브라우저 EventSource가 디스패치하지 않는 그 규칙).
- `event:`가 없는 프레임 · 빈 `data:` · 알 수 없는 이벤트 이름(무시하되 파서가 죽지 않는다).
- CRLF가 섞여 들어오는 경우의 처분을 **결정하고 테스트로 고정**한다(계약은 LF다 — 관대하게 받을지 거부할지 정하고 근거를 적어라).

### B. 스트림 클라이언트

```cpp
class ChangeStream {          // GET /api/stream — 인스턴스마다 독립 연결(싱글턴 금지)
public:
  void start();               // 쿠키 자 공유(step7의 전송 계층 세션과 같은 세션)
  void stop();
  // 신호: readyReceived() · changed(QString kind) · unauthorized() · disconnected(CloseReason)
};
enum class CloseReason { PreOpenRejected, UnauthorizedFrame, Transient, Stopped };
//   PreOpenRejected   : 스트림 열기 전 비-200 또는 비-SSE Content-Type  → 종결(재연결 없음)
//   UnauthorizedFrame : 열린 뒤 `unauthorized` 프레임                    → 종결(재연결 없음)
//   Transient         : 열린 뒤 네트워크 단절·타임아웃·EOF              → 백오프 재연결
//   Stopped           : 호출자가 stop()                                  → 종결
```

**종결 경로는 셋이고 재연결 경로는 하나다 — 이 구분이 이 step의 핵심이다**(② 2차 패치 · net 포트 스펙 크로스체크 [0] 누락 (1)·(2)·(3) 반영). 하나의 범용 `disconnected` 신호에 셋을 뭉개면 「열리기 전 401」이 「일시 단절」과 같은 통에 떨어져 **영구 401 엔드포인트를 백오프로 무한히 두드린다** — 정본이 열린 뒤 `unauthorized`에 대해 막은 실패 모드(`web/src/model/httpModel.js` 327~329행 주석 「무한 재시도가 서버 요청 로그(링 버퍼)를 채운다」)의 **열리기 전 판**이다.

규율:

- `ready` 수신 시 `sse-ready` diag.
- `change` 수신 시 `sse-change{kind}` diag를 남기고 **kind를 무시한 전체 재조회 신호**를 상위에 올린다(부분 갱신 만들지 마라).
- **`unauthorized` 수신 → 연결을 닫고 재연결을 영구 중단**하며 `sse-unauthorized` diag + 상위에 「세션 종료」를 알린다(step10이 로그인 화면으로 되돌린다).
- **[규칙 1 · 열리기 전 거부는 독립 종결 경로다]** `GET /api/stream`의 **초기 응답이 200이 아니면 스트림이 열리지 않은 것**이고 **재연결하지 않는다**(`CloseReason::PreOpenRejected`). 계약이 이 경로를 **별도 결과로 열거**한다: `docs/api-contract/sse.md` **12~18행**(「인증/인가 실패는 스트림을 열기 전 일반 JSON으로 끝난다 · 미인증 → 401 `{"ok":false,"reason":"unauthenticated"}`」) · `docs/api-contract/endpoints.json` `stream` 행(`expect: ["success","unauthenticated"]` · notes 「미인증은 스트림을 열기 전 401 JSON」). 브라우저 EventSource는 초기 응답이 200이 아니면 연결을 **실패로 닫고 재연결을 예약하지 않는다**(WHATWG 규약 — 그래서 `httpModel.js` 313~337행에 이 경로의 코드가 **0줄**이고 웹 테스트도 없다. 브라우저가 보이지 않게 해 주던 일을 Qt는 직접 해야 한다). **401이면 상위에 「세션 종료」**(로그인 화면), 그 밖의 비-200이면 「실시간 끊김」 상태만 표시하고 자동 재연결하지 않는다.
- **[규칙 2 · 응답 헤더가 판정 신호다]** 200이어도 **`Content-Type`이 `text/event-stream`으로 시작하지 않으면 SSE가 아니다** — 프레임 파싱을 시작하지 말고 `PreOpenRejected`로 종결한다. 근거: `docs/api-contract/sse.md` **20~30행**의 헤더 3종(`Content-Type: text/event-stream; charset=utf-8` · `Cache-Control: no-cache` · `Connection: keep-alive`)과 그 문서의 명시 지시 「**클라이언트 판정에 쓰이므로 이식 시 생략하지 마라**」. 판정에 쓰는 것은 **상태 200 + Content-Type 접두**이고, `Cache-Control`·`Connection`은 관측해 diag 없이 무시해도 된다(요약에 처분을 적어라). 캡티브 포털·프록시가 200 HTML을 줄 때 파서가 그것을 먹지 않게 하는 장치다.
- **[규칙 3 · 동시 연결 여러 개가 정상이다]** `docs/api-contract/sse.md` **90행**: 「클라이언트는 동시 SSE 연결 2개(writer + list)를 여는 것이 정상 사용 패턴이다 — 서버는 구독자 수 제한이 없다」. 정본 `subscribe()`(`httpModel.js` 313행)는 호출마다 **독립 EventSource**를 만든다. ⇒ `ChangeStream`은 **인스턴스마다 독립 연결·독립 파서·독립 재연결 상태**를 갖고, 모듈 수준 전역·싱글턴(「그 스트림」)을 두지 마라. P4는 목록 1개만 열지만 **P5가 편집 화면 스트림을 더한다** — 지금 싱글턴으로 만들면 P5에서 구조를 뜯는다.
- **[CloseReason 어휘를 diag에도 쓴다]** `sse-closed{reason}`의 `reason`은 위 4값(`pre-open-rejected`·`unauthorized-frame`·`transient`·`stopped`)만 쓰고, `pre-open-rejected`에는 `status`(숫자)를 함께 싣는다.
- 일시적 오류(`Transient` — 열린 뒤 연결 끊김·타임아웃·EOF)만 **백오프 재연결**(예: 1s → 2s → 4s, 상한 30s). 무한 즉시 재시도 금지. (참고: 브라우저 EventSource의 기본 재시도는 서버가 `retry:`를 보내지 않으므로 대략 **상수 간격**이다 — 지수 백오프는 정본 대비 **완화 방향의 divergence**이며 그렇게 기록한다.)
- **`/api/logs/stream`은 연결하지 않는다**(Z 전용 · P7).
- **세션 연장 착각 금지**(override L127): SSE 수신은 세션을 연장하지 않는다. 스트림이 살아 있다고 클라가 「세션이 살아 있다」고 판단하는 로직을 만들지 마라.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
```
- exit 0 · 테스트 총계 증가 · 실패 0 · 위 A의 케이스가 전부 존재.
- **재연결 규율 테스트(종결 3 · 재연결 1을 각각 별도 케이스로)**:
  - 열린 뒤 `unauthorized` 프레임 → 재연결 **0회** · `CloseReason::UnauthorizedFrame`.
  - **열리기 전 401 JSON**(`{"ok":false,"reason":"unauthenticated"}`) → 재연결 **0회** · `PreOpenRejected(401)` · 상위에 「세션 종료」.
  - **열리기 전 비-401 비-200**(예: 503) → 재연결 **0회** · `PreOpenRejected(503)` · 「세션 종료」는 **올리지 않는다**.
  - **200 + `Content-Type: text/html`** → 프레임을 **하나도 디스패치하지 않고** `PreOpenRejected`로 종결.
  - 열린 뒤 일반 단절 → **백오프로 재시도**(간격이 늘어남을 단언).
- **동시 연결 테스트**: `ChangeStream` 인스턴스 2개가 같은 세션으로 동시에 열려 **각자** 프레임을 받고, 하나를 `stop()`해도 다른 하나는 계속 받는다.

```
node scripts/verify-qt-client.mjs --scenario boot --server exe
node scripts/verify-qt-client.mjs --scenario boot --server spring
npm test
npm run lint
git status --porcelain
```
- 무회귀 · 무접촉 경로 diff 0.

## 검증 절차

1. **TDD red 실증** 후 구현.
2. **실기 1회 확인(수동 · 앱을 띄운다면 반드시 `cmd /c client-qt\run.bat`으로 — 직접 exe 실행은 Qt DLL 부재로 즉사한다)**: step6 드라이버가 띄운 서버에 로그인해 쿠키를 얻은 뒤 `GET /api/stream`을 붙여 `ready` 프레임이 **실제로 도착하는지**, 그리고 다른 세션으로 기사 1건을 만들면 `change`가 도착하는지 본다. **도착 지연(ms)을 재서 요약에 적어라** — `open_questions` (2)가 요구하는 실측이다. 자동 판정은 step11이 붙인다.
3. **변이 6종**:
   - M9-1 종결자 판정을 「한 줄만 오면 즉시 디스패치」로 바꾼다 → 청크 경계 케이스가 red인가? 원복.
   - M9-2 `unauthorized` 처리를 지운다(일반 단절과 동일 취급) → 재연결 0회 테스트가 red인가? 원복.
   - M9-3 백오프를 제거해 즉시 재시도로 바꾼다 → 재시도 간격을 검사하는 테스트가 있는가? 없으면 추가하고 실증. 원복.
   - **M9-4** 열리기 전 401을 `Transient`로 분류한다(백오프 재연결) → 「열리기 전 401 → 재연결 0회」 케이스가 red인가? 원복.
   - **M9-5** Content-Type 검사를 지운다 → 「200 + text/html → 디스패치 0」 케이스가 red인가? 원복.
   - **M9-6** 파서/연결 상태를 모듈 전역(싱글턴)으로 옮긴다 → 동시 연결 테스트가 red인가? 원복.
4. **미검증 항목을 적어라**: replay·`seq` 중복 필터는 로그 스트림 전용이므로 P4에서 다루지 않는다.

## 되돌림

이 step의 소스·테스트·`common.pri` 항목 제거.

## 금지사항

- **kind별 부분 갱신을 만들지 마라.** 이유: 서버는 행 데이터를 주지 않는다 — 부분 갱신은 계약과 불일치이자 오버엔지니어링이다(override L80).
- **`unauthorized`에서 재연결하지 마라.** 이유: 세션이 죽은 클라가 서버를 무한히 두드린다(정본이 명시적으로 막은 실패 모드).
- **열리기 전 비-200을 일시 오류로 취급하지 마라.** 이유: 브라우저는 그 경우 재연결하지 않는다 — 백오프로 붙이면 영구 401 엔드포인트를 무한히 두드리는 같은 실패 모드가 열리기 전 판으로 재현된다.
- **`ChangeStream`을 싱글턴으로 만들지 마라.** 이유: 동시 연결 2개(writer + list)가 정상 패턴이고(`sse.md` 90행) P5가 두 번째 스트림을 더한다.
- **`/api/logs/stream`을 연결하지 마라.** 이유: Z 전용 관리 기능이고 P7의 것이다.
- **SSE 수신을 세션 활동으로 취급하지 마라.** 이유: 서버는 push 시점에 **비연장 peek**으로 재검증한다(override L127) — 클라가 반대로 믿으면 만료 처리 UX가 어긋난다.
- **파서에 네트워크를 섞지 마라.** 이유: 바이트 픽스처로 잠글 수 없게 되고, Qt 전송 특성 때문에 파서 버그가 가려진다.
