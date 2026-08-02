# Step 7: http-error-normalize

## 목표

**Model 호출이 reject되면 화면이 아무 신호도 못 받는 문제**를 Model 계층 한 곳에서 막는다.

`httpModel.request()`는 `fetch(...)`와 `res.json()`을 그대로 노출한다. 그래서 (a) 서버 다운·프록시 끊김·CORS 실패로 `fetch`가 reject되거나 (b) 응답이 JSON이 아닐 때(프록시 HTML 오류 페이지·빈 본문) **Promise가 reject**된다. 화면(관리 화면 3종 등)은 `{ ok, reason }`만 다루도록 짜여 있어 reject는 어디서도 처리되지 않고 **unhandled rejection + 무반응 UI**가 된다.

수정: `request()`는 **절대 reject하지 않는다.** 실패를 서버 실패 응답과 같은 shape(`{ ok:false, reason }`)으로 정규화해 돌려준다. 그러면 기존 화면 코드(`if (r && r.ok) ... else 메시지`)가 **수정 없이** 실패를 인지한다.

이 step은 **`web/src/model/httpModel.js` 한 모듈만** 수정한다(+ 그 테스트). 뷰/컨트롤러/백엔드 무접촉 — 화면 메시지 표시는 다음 step이다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`(프론트 MVC — Model이 transport 격리), `docs/ADR.md` **ADR-003**(주입형 Model 계약이 유일한 seam)·**ADR-005**(SSE는 EventSource).
- `web/src/model/httpModel.js` — **전체**. 핵심:
  - **`request(path, { method, body, query, clientId })`(L80~96)** ← **유일한 수정 대상**. `const res = await fetch(...)` → `return res.json();`
  - 모든 REST 메서드(login/logout/restoreSession/queryUsers/…/uploadFile/lockArticle/…)가 `request`를 지난다 — 여기 한 곳만 고치면 전 계약이 덮인다.
  - `login`(L~100)은 `if (r && r.ok && r.sessionId) writeSessionId(r.sessionId)`, `logout`은 성공 여부와 무관하게 `writeSessionId(null)`.
  - `subscribe`/`subscribeLogs`(L273·L302)는 `EventSource`라 `request`를 지나지 않는다 — **건드리지 마라**.
  - `uploadFile`(L206~219)은 `FileReader` Promise를 먼저 await한다 — 그 reject는 `request` 밖이다(범위 밖, 아래 금지사항 참조).
- `web/src/model/contract.js` — `MODEL_KEYS`(계약 키 목록). **이 step에서 키를 추가/삭제하지 마라**(응답 shape만 정규화한다).
- `web/src/model/httpModel.test.js` — **전체**. `jsonResponse(body)` 헬퍼(`{ ok:true, status:200, json: async () => body }`)와 `globalThis.fetch` 목 패턴이 이미 있다. 이 step의 테스트가 들어갈 파일이다.
- `server/index.js` — 전역 에러 핸들러(L838~841)가 500에도 `{ ok:false, reason:'internal-error' }` **JSON**을 준다. 즉 서버가 살아 있으면 항상 JSON이다 — 이 step이 덮는 것은 **서버에 닿지 못했거나 서버 밖(프록시/게이트웨이)에서 깨진 경우**다.
- 참고(수정 금지, 회귀 확인용): `web/src/controller/useWriteController.js`의 `.catch(() => null)`/`try{...}catch{}` 폴백들(L226~229, L239, L260~263, L313, L336) — reject가 사라지면 이 catch들은 실행되지 않고 대신 `{ok:false}` 값이 흐른다. **동작 결과가 같은지** 확인해야 한다(예: L240은 `lock.reason === 'locked'`만 특별 처리하므로 `network-error`는 기존 `null`과 동일 경로).

## 배경 (자기완결)

관리 화면 3종(distMgmt/rcvMgmt/userMgmt)은 컨트롤러가 `const r = await model.xxx(); ... return r;` 형태로 응답을 그대로 넘기고, 뷰가 `r.ok`로 분기한다. 서버가 `{ ok:false, reason }`을 주면 (dist 화면은) 메시지를 띄운다. 그러나 서버에 **닿지 못하면** 그 경로 자체가 실행되지 않는다 — 사용자는 "눌렀는데 아무 일도 안 일어남"을 본다.

정규화 토큰은 서버 사유와 **충돌하지 않는 새 값** 2개만 쓴다:

| 상황 | 반환 |
|---|---|
| `fetch` 자체가 reject(네트워크 단절·CORS·DNS) | `{ ok:false, reason:'network-error' }` |
| 응답을 JSON으로 파싱 실패(HTML 오류 페이지·빈 본문) | `{ ok:false, reason:'invalid-response' }` |
| 그 외(2xx·4xx·5xx JSON 응답) | 서버 본문 그대로(**기존 동작 불변**) |

## TDD — 테스트 먼저

`web/src/model/httpModel.test.js`에 red→green으로 추가한다(`fetchMock`으로 실패를 주입).

1. **네트워크 실패**: `fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))` → `await model.queryDistributionTargets()`가 **reject하지 않고** `{ ok:false, reason:'network-error' }`로 resolve.
2. **비JSON 응답**: `fetchMock.mockResolvedValueOnce({ ok:false, status:502, json: async () => { throw new SyntaxError('Unexpected token <'); } })` → `{ ok:false, reason:'invalid-response' }`.
3. **정상 실패 응답 불변(회귀)**: 403 + `{ ok:false, reason:'forbidden' }` JSON → **그대로** 반환(정규화가 덮어쓰지 않는다).
4. **성공 응답 불변(회귀)**: 200 + `{ ok:true, items:[...] }` → 그대로.
5. **세션 부작용 없음**: `login`이 네트워크 실패로 정규화될 때 `sessionStorage`에 세션이 기록되지 않는다(`readSessionId()`가 그대로 null).
6. **요청 조립 불변**: 실패 케이스에서도 `fetch`가 기존과 동일한 인자(경로·method·headers·`credentials:'include'`)로 호출됐는지 기존 단언 스타일로 확인.
7. 기존 httpModel 테스트 전량 green(경로·쿼리 직렬화·헤더·업로드 파일명 등).

## 작업

`request(path, opts)` 내부만 바꾼다.

```js
async function request(path, { method = 'GET', body, query, clientId } = {}) {
  ... // headers/init 조립은 그대로

  let res;
  try {
    res = await fetch(`${base}${path}${buildQuery(query)}`, init);
  } catch {
    // 서버에 닿지 못함(네트워크 단절·CORS·DNS). 호출자는 { ok, reason }만 다루므로 서버 실패와 같은 shape으로 정규화한다.
    return { ok: false, reason: 'network-error' };
  }
  try {
    return await res.json();
  } catch {
    // 서버 밖(프록시/게이트웨이)에서 깨진 비JSON 응답 — 본문을 신뢰할 수 없다.
    return { ok: false, reason: 'invalid-response' };
  }
}
```

제약:

- **응답 본문을 재해석하지 마라.** JSON 파싱이 성공하면 상태코드와 무관하게 그대로 반환한다(서버가 `{ok:false,reason}`을 이미 준다).
- 정규화 객체에 `status`·`url`·에러 메시지·스택을 담지 마라(에러 원문 유출·불필요한 shape 확장 금지). **`{ ok:false, reason }` 두 키만.**
- `request`의 시그니처·헤더 조립(`x-session-id`, `x-edit-client`, `Content-Type`)·`credentials:'include'`는 **불변**.
- 모듈 상단 주석에 "`request`는 reject하지 않는다 — 모든 실패는 `{ ok:false, reason }`으로 정규화된다"를 한 줄 계약으로 남겨라(호출자가 의존할 계약이다).
- 필요하면 두 토큰을 모듈 상수(`const NETWORK_ERROR = 'network-error'` 등)로 두되 **export하지 마라**(뷰는 문자열 리터럴로 매핑한다 — 계약 표면 최소화).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web        # 87 files, 실패 0 (기준선 1944 pass + 신규 케이스)
npm test                # 620/620 green — 백엔드 무접촉 증명(step0 이후 기준선)
```

`git diff --name-only`는 `web/src/model/httpModel.js` + `web/src/model/httpModel.test.js` **2개**여야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. **web 전량 green**이어야 한다 — 특히 `useWriteController.test.jsx`·`WriterPage.test.jsx`·`ListPage.test.jsx`처럼 `.catch()` 폴백에 의존하던 경로에 회귀가 없는지 본다.
2. 변이 검증: 정규화를 제거(`return res.json()`로 복귀)하면 새 테스트 1·2가 red(unhandled rejection)가 되는지 확인한다.
3. 아키텍처 체크리스트:
   - transport 코드가 여전히 `httpModel.js` 안에만 있는가(뷰/컨트롤러에 fetch 미유입)?
   - `MODEL_KEYS`(contract.js)가 변경되지 않았는가?
   - `subscribe`/`subscribeLogs`(EventSource)가 무접촉인가?
4. `phases/49-mini-backlog-cleanup/index.json`의 step7을 갱신한다(`completed` + `summary` 등). `summary`에 **정규화 토큰 2개(`network-error`·`invalid-response`)**를 반드시 남겨라(다음 step이 그 문자열을 매핑한다).

## 금지사항

- 상태코드를 보고 사유를 지어내지 마라(예: 401 → `'unauthenticated'` 재작성). 이유: 서버가 이미 정확한 사유를 JSON으로 준다 — 클라이언트가 덧씌우면 두 출처가 갈라지고, 신뢰 경계(서버)가 흐려진다.
- 재시도(retry)·지수 백오프·타임아웃 타이머를 추가하지 마라. 이유: 범위는 "실패를 알리는 것"이다. 자동 재시도는 중복 쓰기(POST/PUT) 위험이 있고 ADR 철학(최소 구현)에 어긋난다.
- `alert`/`console.error`/토스트 등 UI 부작용을 Model에 넣지 마라. 이유: Model은 transport 계층이다 — 사용자 피드백은 View 책임이다(다음 step).
- `uploadFile`의 `FileReader` reject를 이 step에서 잡지 마라. 이유: 그건 파일 읽기 실패(로컬)로 `request` 밖의 별개 실패 모드다 — 함께 건드리면 이 step의 회귀 원인 격리가 불가능해진다.
- `subscribe`/`subscribeLogs`(EventSource)에 손대지 마라. 이유: SSE는 표준 자동 재연결을 쓰며(ADR-005) 실패 모델이 다르다.
- 뷰/컨트롤러 파일을 수정하지 마라. 이유: 이 step은 Model 한 계층만 바꿔 회귀 원인을 좁힌다(화면 메시지는 step8).
- 기존 테스트를 깨뜨리지 마라(기준: web 87 files / 1944 pass 이상, lint·build clean, 백엔드 620/620 green 유지).
