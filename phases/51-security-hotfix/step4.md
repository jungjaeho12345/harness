# Step 4: sse-token-query

## 목표

**SSE 구독 URL에 붙는 평문 세션 토큰(`?session=<토큰>`)을 없앤다 — 서버는 이미 그 값을 읽지 않으므로 인증에는 아무 쓸모가 없고, 프록시·서버 액세스 로그·브라우저 히스토리에 유효 토큰만 남긴다.**

`web/src/model/httpModel.js`의 `subscribe`(L293~295)는

```js
const url = `${base}/api/stream${buildQuery({ session: readSessionId() })}`;
const source = new EventSource(url, { withCredentials: true });
```

로 매 구독마다 세션 토큰을 쿼리스트링에 싣는다. 그러나 서버의 `GET /api/stream`(server/index.js L775~794)은 `readSessionToken(req)`(쿠키 → `x-session-id` 헤더)만 보고 **쿼리는 폐기됐다**(L349·L777 주석, `test/sse-api`/`test/sse-auth.test.js` L111~117이 "?session= 만 실은 요청은 401"을 잠그고 있다). 즉 **인증 효과 0 + 토큰 노출 100**이다. 같은 파일의 `subscribeLogs`(L320~335)는 이미 쿠키 전용으로 정리돼 있으니 그 형태에 맞춘다.

이 step은 **web 프론트 1파일 + 그 테스트 1파일 + ADR 문장 1줄**만 바꾼다. 백엔드 코드·계약(`MODEL_KEYS`)·`fakeModel` 무접촉.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-005**(SSE 무효화 스트림). 마지막 트레이드오프 문장이 "`EventSource`가 커스텀 헤더를 못 보내 이 라우트만 `?session=` 쿼리 인증 폴백을 둔다"로 **현행과 어긋나 있다**(서버는 이미 폐기). **ADR-007**은 로그 스트림에서 "쿼리스트링에 토큰을 싣지 않는다(평문 토큰 URL 누출 표면 금지, 기존 `?session=` 폴백은 이미 제거됨)"고 명시한다 — 이 step은 그 규율을 무효화 스트림에도 맞춘다.
- `docs/ARCHITECTURE.md` — 프론트엔드 MVC(Model 계약 뒤에 transport 격리) 절.
- `web/src/model/httpModel.js`
  - `readSessionId()`(L51~58) — REST 헤더 폴백에 계속 쓰인다. **삭제 금지**.
  - `buildQuery()`(L70~79) — 일반 필터 쿼리에 계속 쓰인다. **삭제 금지**.
  - `request()`(L88~118) — `x-session-id` 헤더 + `credentials:'include'`. **수정 금지**.
  - `login()` 위 주석(L122~124) — "이후 요청에 x-session-id 헤더/`?session=` 쿼리로 병행 첨부한다"는 서술이 **거짓이 된다** → 현행화 대상.
  - `subscribe(filter, onChange, onStatus)`(L286~313) ← **수정 대상**(주석 L287~292 포함).
  - `subscribeLogs(onLog, onStatus)`(L320~335) — **참고 형태**(쿠키 전용, 수정 금지).
- `server/index.js` L348~355(`/api/session` 쿼리 폴백 제거 주석), L775~794(`/api/stream` — 쿠키·헤더만 판독). **백엔드는 이 step에서 수정하지 않는다**(읽기만).
- `web/src/model/httpModel.test.js`
  - L395~415 — `subscribe`의 URL 단언 2건. **L404~413의 "keeps the ?session= query fallback" 테스트가 이 step의 갱신 대상**이다.
  - L560~575 — `subscribeLogs`의 "never appends a ?session= query" 테스트. **새 단언이 따라야 할 본보기**다(가짜 `EventSource` 설치 방식 포함).
- `web/src/model/contract.js` — `MODEL_KEYS`에 `subscribe`가 있다(시그니처·반환 shape `{ connected, unsubscribe }` 불변이어야 한다).
- `test/sse-auth.test.js` L96~120 — 서버측 계약(헤더 통과 / `?session=` 만 실으면 401). **수정 금지**, 현행 확인용.

## 배경 (자기완결)

- `EventSource`는 커스텀 헤더를 보낼 수 없다. 그래서 SSE 인증 수단은 **HttpOnly 세션 쿠키(`sid`) + `withCredentials: true`** 뿐이다. 서버는 CORS allowlist에 `credentials:true`를 켜 두었다(server/index.js L220~227).
- 기본 배치는 **동일 출처**다(`base` 기본값 `''`, dev는 Vite 프록시 `/api` → API 서버). 동일 출처면 `SameSite=Lax` 쿠키가 SSE에도 first-party로 실린다(httpModel.js L81~83 주석).
- 따라서 쿼리 폴백을 지워도 표준 배치에서는 잃는 게 없다. **cross-origin으로 띄운 dev 구성**에서는 SSE 인증이 불가능해지는데, 이는 로그 스트림(ADR-007)이 이미 받아들인 트레이드오프이며 대안은 동일 출처(프록시) 구성이다. 이 사실을 주석에 남겨 다음 사람이 쿼리 폴백을 되살리지 않게 한다.

## 작업

### 1) `subscribe`에서 쿼리 제거

```js
const source = new EventSource(`${base}/api/stream`, { withCredentials: true });
```

- `ready`/`change`/`error` 리스너, `onChange(signal, filter)` 호출 형태, 반환 `{ connected, unsubscribe }`는 **전부 불변**이다(계약).
- `filter`는 지금처럼 서버로 보내지 않고 콜백에 그대로 넘긴다(ADR-005 — 서버는 무효화 신호만 보내고 클라이언트가 자기 필터로 재조회).

### 2) 주석 현행화(거짓 서술 제거)

- `subscribe` 위 주석: "dev cross-origin에서는 `?session=` 쿼리 폴백" 서술을 삭제하고 → **인증은 HttpOnly 쿠키(withCredentials)뿐이며, 서버는 `?session=` 쿼리를 읽지 않는다(폐기됨). 평문 토큰을 URL에 싣지 않는다(프록시·액세스 로그 누출 표면). cross-origin 구성에서는 SSE 인증이 불가하므로 동일 출처(Vite 프록시) 배치를 쓴다 — `subscribeLogs`와 같은 규율.**
- `login` 위 주석(L122~124): "`?session=` 쿼리로 병행 첨부" 부분을 제거하고 **REST는 `x-session-id` 헤더 폴백만** 이라고 정정한다.

### 3) ADR-005 트레이드오프 문장 현행화(1줄)

`docs/ADR.md`의 ADR-005 마지막 문장에서 "`?session=` 쿼리 인증 폴백을 둔다"를 **현행 사실**(쿠키 `withCredentials` 전용, 쿼리 폴백은 제거됨 — ADR-007과 같은 규율)로 정정한다.
- **결정 자체(SSE 채택·무효화 신호 원칙)는 바꾸지 마라.** 트레이드오프 서술 한 문장만 사실에 맞춘다.
- ADR 번호 신설·삭제 금지.

## TDD — 테스트 먼저

`web/src/model/httpModel.test.js`(Vitest)에서:

1. **핵심 갱신**: L404~413의 "subscribe keeps the `?session=` query fallback when a token is stored" 테스트를 **"subscribe never appends a `?session=` query even when a token is stored"** 로 바꾼다 — `sessionStorage`에 토큰을 넣은 상태에서 `subscribe(...)` 호출 후 `instances[0].url`이 `` `${BASE}/api/stream` `` 과 정확히 같고 `'session='`을 포함하지 않는다. (`subscribeLogs` 케이스 L564~575와 같은 형태로 맞춘다.)
2. 토큰이 없을 때도 URL에 쿼리가 붙지 않는다(기존 L395~402 케이스 유지).
3. `withCredentials: true`가 여전히 전달된다(쿠키 인증이 유일한 수단이 됐으므로 반드시 잠근다).
4. 계약 회귀: `ready`→`onStatus(true)`, `change` 이벤트 → `onChange(signal, filter)` 인자 그대로, `error`→`onStatus(false)`, `unsubscribe()`가 `close()`를 부른다 — 기존 케이스 green.
5. REST 회귀: `request` 경로가 여전히 `x-session-id` 헤더를 싣고 `credentials:'include'`로 호출한다(기존 케이스 green — `readSessionId` 삭제 금지의 근거).

1은 **구현 전 red**(현재 구현이 쿼리를 붙이므로)를 확인하고 green으로 만든다.

## Acceptance Criteria

```bash
npm run test:web         # 87 files / 2006(±갱신분) 통과, fail 0
npm run lint
npm run build
# 세션 토큰 쿼리 조립 0건 — 아래 grep의 허용 출력은 정확히 이것뿐이다(그 외 라인이 있으면 실패):
#   web/src/model/httpModel.js:321 — subscribeLogs의 "?session= 폴백을 두지 않는다" 설명 주석(코드 아님)
#   web/src/model/httpModel.test.js — not.toContain('session=') 단언 라인들
# ⇒ subscribe 본문(`${base}/api/stream` 조립부)과 login 주석에는 남아 있으면 안 된다.
grep -rn "session=" web/src --include=*.js --include=*.jsx
git diff --name-only     # web/src/model/httpModel.js, web/src/model/httpModel.test.js, docs/ADR.md 3개뿐 — server/·src/·test/ 0건
```

## 검증 절차

1. 위 AC 커맨드 실행 — web 스위트 **fail 0**, 테스트 수가 기준선(2006)보다 줄지 않는다(단언 교체이므로 동수 또는 증가).
2. 백엔드 무접촉 확인: `npm test`(backend 636/636 green)를 한 번 돌려 회귀가 없음을 확인한다.
3. 변이 검증: `subscribe`에 쿼리를 되살리면 (1)이 red가 되는가?
4. 아키텍처 체크리스트:
   - Model 계약(`MODEL_KEYS`)·`fakeModel`·컨트롤러/뷰가 무변경인가(`git diff --name-only`)?
   - `readSessionId`/`buildQuery`가 남아 있고 REST 경로가 그대로인가?
   - 서버 라우트를 고치지 않았는가(이 step은 프론트 전용)?
5. `phases/51-security-hotfix/index.json`의 step4 상태·summary를 갱신한다.

## 금지사항

- 서버(`server/index.js`)에 `?session=` 쿼리 인증을 되살리지 마라. 이유: URL 평문 토큰은 프록시/액세스 로그/리퍼러로 새는 표면이며, ADR-007이 이미 제거를 확정했다.
- `readSessionId()`/`buildQuery()`/`request()`의 `x-session-id` 헤더 첨부를 삭제하지 마라. 이유: REST 호출의 dev cross-origin 폴백이 여기에 의존한다(SSE와 달리 헤더를 보낼 수 있다) — 지우면 개발 환경 전체가 401이 된다.
- `subscribe`의 시그니처·반환 shape(`{ connected, unsubscribe }`)·이벤트 이름(`ready`/`change`)을 바꾸지 마라. 이유: `MODEL_KEYS` 계약과 컨트롤러(`useViewController` 등)·`fakeModel`이 그대로 묶여 있다.
- SSE로 행 데이터를 받도록 바꾸거나 `filter`를 서버로 보내지 마라. 이유: ADR-005 — 서버는 무효화 신호만 보내고 클라이언트가 재조회한다(역할별 데이터 노출 회피).
- 토큰을 `EventSource` URL 대신 다른 URL 요소(경로 세그먼트·해시 등)에 담지 마라. 이유: 같은 누출 표면을 이름만 바꾼 것이다.
- ADR-005의 **결정** 문장이나 다른 ADR을 손대지 마라. 이유: 이 step이 고치는 것은 현행과 어긋난 트레이드오프 서술 한 문장뿐이다.
- 백엔드 파일·`web/src/test/fakeModel.js`를 수정하지 마라(기준선: backend 636/636, web 2006/2006, lint·build clean).
