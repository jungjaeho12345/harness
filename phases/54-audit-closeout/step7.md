# Step 7: view-controller-guards

## 목표

목록 화면 컨트롤러(`useViewController`)의 **가드 공백 2건**을 닫고, 그 과정에서 필요한 문구 매핑을 공용 모듈로 승격한다.

| # | 결함 | 지점 |
|---|---|---|
| A | 편집 진입이 **잠금 획득 실패를 `'locked'`일 때만 처리**하고 나머지 실패(네트워크·401·403·404·비JSON·예외)에서는 그대로 writer.do로 이동한다(fail-open). | `enterEditor` |
| B | 목록 재조회가 **in-flight/언마운트 가드 없이** 응답을 그대로 반영한다 — 늦게 도착한 이전 필터의 응답이 최신 목록을 덮어쓴다(out-of-order). 바로 아래 `queryUsers` effect는 `alive` 가드를 쓴다. | `refresh` |

동시에 phase 53이 `useWriteController`에 만든 **잠금 실패 사유→문구 매핑을 공용 모듈로 승격**해 두 컨트롤러가 같은 문구를 쓰게 한다.

> A는 phase 53이 "openArticle이 fail-closed가 되면 무결성 손상은 없고 안내 시점 지연만 남는다"며 넘긴 이관분이고, B는 2026-08-03 감사의 '중·저' 항목 중 phase 51~53 어디에도 채택·제외 기록이 없던 잔여분이다. 이 phase가 백로그 소진을 선언하므로 여기서 마감한다.
>
> **선행**: controller 패스의 첫 step. `web/src/controller/useWriteController.js`는 이 step → step8 순서로만 수정한다(동시 수정 금지).
> 수정 대상은 **`web/src/controller/lockMessages.js`(신규), `web/src/controller/useWriteController.js`, `web/src/controller/useViewController.js` + 각 테스트**다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md` — 프론트 MVC 의존 방향(`View ← Controller ← Model`). **컨트롤러는 view를 import하지 않는다** — 그래서 공용 문구 모듈을 `web/src/controller/` 아래에 둔다(뷰의 `mgmtMessages.js`와 대칭이지만 계층이 다르다).
- `web/src/controller/useWriteController.js`
  - `const LOCK_FAIL_MESSAGES = { locked: '편집중입니다.', 'network-error': …, 'invalid-response': …, unauthenticated: …, forbidden: …, 'not-found': … }`
  - `const LOCK_FAIL_DEFAULT = '편집 잠금을 얻지 못해 편집할 수 없습니다.';`
  - `function lockFailMessage(reason)` — 비문자열/빈 문자열이면 기본 문구, 미지의 문자열이면 `` `${LOCK_FAIL_DEFAULT} (${reason})` ``.
  - `openArticle` — `const lock = await Promise.resolve(model.lockArticle(articleId, action, clientId)).catch(() => null); if (!lock || lock.ok !== true) { globalThis.alert?.(lockFailMessage(lock && lock.reason)); return null; }`(phase 53 step5의 fail-closed 형태 — **이 동작은 그대로 유지**한다).
- `web/src/controller/useViewController.js`
  - `enterEditor(article, mode)` — `const lock = await Promise.resolve(model.lockArticle(article.articleId, lockAction)).catch(() => null);` → **`lock.ok === false && lock.reason === 'locked'`일 때만** `alert('편집중입니다.')` + `return null`. 그 외에는 `sessionStorage.setItem(PENDING_EDIT_KEY, …)` 후 `navigate('writer.do', { articleId })` ← 결함 A.
  - `editArticle`/`reviseArticle`/`mapArticle`이 전부 `enterEditor`를 재사용한다.
  - `const refresh = useCallback(async () => { const r = await model.queryArticles(filter); setItems((r && r.items) || []); return r; }, [model, filter]);` ← 결함 B. 호출자는 (1) `useEffect(() => { refresh(); }, [refresh])`(메뉴/부서 변경·진입), (2) SSE 구독 콜백 `model.subscribe(filter, () => { refresh(); }, setLive)`, (3) 화면(`ListPage`)의 수동 재조회다 — **반환값 `r`을 그대로 쓰는 호출자가 있으므로 반환 계약은 유지한다**.
  - 바로 아래 부서 드롭다운 effect가 `let alive = true; … if (!alive) return; … return () => { alive = false; };` 패턴을 쓴다(이 파일 안의 선례 — 같은 톤으로 맞춰라).
  - `filter`는 `useMemo(() => buildMenuFilter(menu, identity, departments), …)`이고 `refresh`의 의존성이다 → 메뉴를 빠르게 바꾸면 서로 다른 필터의 요청이 겹친다.
- `web/src/controller/useViewController.test.jsx` — 기존 관례: `setup({ articles })`가 `{ result, model, navigate }`를 주고, `vi.spyOn(model,'lockArticle').mockResolvedValue({ ok:false, reason:'locked' })` + `alertSpy` + `expect(navigate).not.toHaveBeenCalled()`로 단언한다. `editArticle`/`mapArticle`의 정상 이동 케이스도 여기 있다.
- `web/src/controller/useWriteController.test.jsx` — phase 53 step5가 추가한 잠금 실패 12건(사유별 문구·탭 미개방 단언). 문구 문자열이 계약으로 잠겨 있다.
- 참고(수정 금지): `src/services/articleService.js` `acquireEditLock` — `held = lockYN==='Y' && lockerClientId`이므로, 목록에서 clientId 없이 획득한 잠금(`lockerClientId: null`)은 writer가 자기 clientId로 다시 획득할 수 있다(현재 2단 잠금 흐름이 성립하는 이유).

## 배경 (자기완결) — 왜 결함인가

**B(out-of-order 재조회).** `refresh`는 `await` 뒤에 조건 없이 `setItems`를 부른다. 메뉴 전환(필터 A→B)이나 SSE 무효화가 겹치면 A의 응답이 B보다 늦게 도착해 **사용자가 방금 고른 메뉴와 다른 목록**이 화면에 남는다. 목록 행은 편집 진입·상태 전이·강제 해제의 출발점이라, 사용자는 "지금 보고 있는 목록"을 믿고 행을 조작한다. 언마운트 후 도착한 응답도 그대로 `setItems`를 호출해 React 경고를 남긴다. 같은 파일의 부서 드롭다운 effect는 이미 `alive` 가드를 쓰고 있어, 이 함수만 규율에서 빠져 있는 상태다.

**A(편집 진입 fail-open).** `enterEditor`는 목록의 **1차 관문**이다. 지금은 `'locked'`만 붙잡고, `network-error`·`invalid-response`·`unauthenticated`·`forbidden`·`not-found`·예외(`null`)에서는 **잠금을 못 얻었는데도** `pendingEdit`를 저장하고 writer.do로 이동한다. writer 쪽은 phase 53 step5로 fail-closed가 됐으므로 사용자는 결국 편집 탭을 못 열지만,

- 화면이 한 번 바뀐 뒤에야("writer.do로 이동 후") 실패를 알게 되고,
- 실패 사유가 목록에서는 아무 문구 없이 사라지며,
- 세션 만료(`unauthenticated`)처럼 "로그인부터 다시 하라"는 안내가 필요한 경우에도 그 정보가 유실된다.

또 두 컨트롤러가 같은 실패 토큰을 서로 다른 방식(한쪽은 6종 매핑, 한쪽은 `'locked'` 하드코딩)으로 다루고 있어, 새 토큰이 생기면 한쪽만 갱신되는 드리프트가 구조적으로 남는다.

## TDD — 테스트 먼저

**A. 공용 모듈 — 신규 `web/src/controller/lockMessages.test.js`(순수 모듈)**
1. 6개 토큰이 각각 기존 문구를 **바이트 그대로** 돌려준다(특히 `locked` → `'편집중입니다.'`).
2. 미지의 문자열 토큰 → `편집 잠금을 얻지 못해 편집할 수 없습니다. (<토큰>)` 형식.
3. `null`/`undefined`/`''`/숫자/객체 → 기본 문구만(결과에 `null`·`undefined`·`[object Object]` 없음).
4. 프로토타입 오염 방어: `'toString'` 같은 사유도 미지 토큰 형식으로 수렴한다.

**B. `useViewController.enterEditor` — `useViewController.test.jsx`**
5. 결함 재현(사유별 5~6건): `lockArticle`을 `{ ok:false, reason:'network-error' }` / `'unauthenticated'` / `'forbidden'` / `'not-found'` / `{ ok:'yes' }`(이상값) / `mockRejectedValue(new Error())`로 모킹하고 `editArticle`을 호출하면
   - 반환이 `null`,
   - `navigate`가 **호출되지 않고**,
   - `sessionStorage`에 `pendingEdit`가 **저장되지 않으며**,
   - `alert`가 1회, 문구에 `'null'`·`'undefined'`가 포함되지 않는다.
6. 회귀: `'locked'` 케이스는 기존 그대로 `'편집중입니다.'` **정확 일치**(기존 테스트 무수정 green).
7. 회귀: 정상(`ok:true`) 경로에서 `editArticle`·`reviseArticle`(portal 포함)·`mapArticle`이 `pendingEdit`를 저장하고 `navigate('writer.do', { articleId })`를 호출한다(기존 테스트 무수정 green).
8. 회귀: `sessionStorage.setItem`이 throw해도(용량/차단) 잠금이 성공했으면 이동은 계속된다(기존 동작 — try/catch 유지).
9. 회귀: `releaseLock`(강제 해제)·`loadDetail` 등 같은 훅의 다른 기능은 영향 없다.

**C. `useViewController.refresh` out-of-order — `useViewController.test.jsx`**
10. 결함 재현(결정적): `queryArticles`를 **지연 Promise**로 모킹해 두 번의 조회를 in-flight로 만들고(예: 메뉴 변경으로 filter를 바꿔 2회 발생), **먼저 보낸 요청을 나중에 resolve**한다(순서 뒤집기). 결과 `items`는 **마지막에 보낸 요청**의 응답이어야 한다(늦게 온 옛 응답이 덮어쓰지 않는다). 각 응답은 구분 가능한 `articleId`로 만든다.
11. 회귀: 단일 조회(정상 순서)에서는 오늘과 동일하게 `items`가 채워지고 `refresh()`의 **반환값이 응답 객체 그대로**다(호출자가 `r`을 소비한다).
12. 회귀: SSE 무효화 콜백으로 유발된 재조회도 정상 반영된다(기존 테스트 무수정 green).
13. 언마운트 가드: 조회가 in-flight인 상태에서 `unmount()` 후 응답이 도착해도 예외·경고 없이 무시된다.
14. 회귀: 메뉴 전환 시 `page`가 1로 리셋되는 기존 동작, 부서 드롭다운(`queryUsers`) effect의 `alive` 가드는 영향 없다.

**D. `useWriteController` 승격 회귀 — `useWriteController.test.jsx`**
15. 기존 잠금 실패 12건이 **무수정 green**이다(문구가 바이트 동일하게 이동했다는 증거). 새 케이스를 추가할 필요는 없다.

## 작업

1. 신규 `web/src/controller/lockMessages.js`(순수 모듈 — React·DOM·transport 비의존):
   ```js
   export const LOCK_FAIL_MESSAGES = Object.freeze({ /* 기존 6종을 바이트 그대로 */ });
   export const LOCK_FAIL_DEFAULT = '편집 잠금을 얻지 못해 편집할 수 없습니다.';
   export function lockFailMessage(reason) { /* 기존 판정 규칙 그대로 */ }
   ```
   - 문구·판정 규칙(비문자열 → 기본 문구, 미지 문자열 → `기본 (토큰)`)을 **한 글자도 바꾸지 마라**. 이동일 뿐이다.
   - 매핑 조회는 자기 소유 키만 본다(`Object.hasOwn`).
2. `web/src/controller/useWriteController.js`: 로컬 `LOCK_FAIL_MESSAGES`·`LOCK_FAIL_DEFAULT`·`lockFailMessage`를 삭제하고 새 모듈에서 import한다. `openArticle`의 로직·`takeoverMessage`·SSE 핸들러·`submit`은 **한 줄도 바꾸지 않는다**.
3. `web/src/controller/useViewController.js` `enterEditor`: 잠금 결과 판정을 fail-closed로 바꾼다.
   ```js
   const lock = await Promise.resolve(model.lockArticle(article.articleId, lockAction)).catch(() => null);
   if (!lock || lock.ok !== true) {
     globalThis.alert?.(lockFailMessage(lock && lock.reason));
     return null; // 이동하지 않는다 — pendingEdit도 저장하지 않는다.
   }
   ```
   - 성공 판정은 `ok === true`(truthy 금지 — 모델/서버 이상값에 조용히 이동하지 않는다).
   - `alert` 호출은 기존과 같이 `globalThis.alert?.(…)` 형태를 쓴다(테스트 환경 방어).
   - `PENDING_EDIT_KEY` 저장·`navigate` 호출·`lockAction` 결정(`portalRevise`/`revise`)·반환값 계약(`articleId` 또는 `null`)은 그대로 둔다.
   - 함수 주석의 "locked면 …" 설명을 새 규칙(사유 불문 fail-closed)에 맞게 갱신하되 전면 재작성하지 마라.
4. `web/src/controller/useViewController.js` `refresh`: 요청 순번 가드 + 언마운트 가드를 넣는다.
   ```js
   const refreshSeqRef = useRef(0);
   const mountedRef = useRef(true);
   useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

   const refresh = useCallback(async () => {
     const seq = (refreshSeqRef.current += 1);
     const r = await model.queryArticles(filter);
     if (!mountedRef.current || seq !== refreshSeqRef.current) return r; // 낡은 응답/언마운트 — 반영하지 않는다.
     setItems((r && r.items) || []);
     return r;
   }, [model, filter]);
   ```
   - **반환값 계약을 바꾸지 마라**: 폐기 경로에서도 응답 `r`을 그대로 돌려준다(호출자가 조회 결과를 소비한다 — 반영 여부와 반환은 별개다).
   - 의존성 배열 `[model, filter]`를 유지하라(ref는 의존성이 아니다). `useRef` import가 없으면 추가한다.
   - `queryUsers` effect의 `alive` 가드, SSE 구독 effect, `page` 클램프 effect는 손대지 마라.
   - 왜 seq(순번)인가: `alive` 플래그만으로는 "언마운트"는 막아도 "같은 컴포넌트 안에서 겹친 두 조회의 순서 역전"은 막지 못한다. 두 가드는 목적이 다르므로 둘 다 넣는다.
   - 요청 취소(AbortController)를 도입하지 마라 — 모델 계약(주입형)에 취소 개념이 없고 transport 계약 확장은 이 phase 범위 밖이다.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm run test:web  # 88 → 89 files(신규 lockMessages.test.js — step6이 88로 올린 뒤다), 실패 0
npm test          # 백엔드 무접촉 — 실패 0(개수는 step2 종료 시점과 동일)
```

`git diff --name-only`는 `web/src/controller/lockMessages.js`, `web/src/controller/lockMessages.test.js`, `web/src/controller/useWriteController.js`, `web/src/controller/useViewController.js`, `web/src/controller/useViewController.test.jsx` **5개**(+ 필요 시 `useWriteController.test.jsx`)여야 한다. `web/src/view/`·`src/`·`server/`·`docs/`가 있으면 범위를 넘은 것이다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `useWriteController.test.jsx`의 잠금 실패 12건이 **무수정 green**인지 확인한다(문구 이동이 무손실이라는 증거).
2. 변이 검증 4종(확인 후 원복):
   - `enterEditor`의 판정을 옛 `reason === 'locked'` 형태로 되돌리면 A의 결함 재현 케이스만 red.
   - 성공 판정을 truthy(`if (!lock || !lock.ok)`)로 바꾸면 `{ ok:'yes' }` 이상값 케이스만 red.
   - `refresh`의 seq 비교를 제거하면 out-of-order 케이스(10)만 red.
   - `mountedRef` 가드를 제거하면 언마운트 케이스(13)만 red.
3. 잔여 확인: `git grep -n "편집중입니다" -- web/src`로 프로덕션 코드에서 이 문구가 `lockMessages.js` **1곳**에만 남았는지 확인한다(테스트 단언은 남아도 정상).
4. 아키텍처 체크리스트:
   - 컨트롤러가 `web/src/view/**`를 import하지 않는가(의존 방향 유지)?
   - `lockMessages.js`가 React/DOM/transport 비의존 순수 모듈인가?
   - 서버 계약(잠금 API 호출 인자·헤더)이 그대로인가? 새 네트워크 호출·타이머가 없는가?
5. `phases/54-audit-closeout/index.json`의 step7을 `completed` + `summary`로 갱신한다. summary에 (a) 공용 모듈 경로와 export, (b) enterEditor의 새 판정(`ok === true`가 아니면 이동·pendingEdit 저장 없음), (c) `'편집중입니다.'` 문구 불변, (d) refresh 가드 2종(seq·mounted)과 반환값 계약 유지를 명시하라.

## 금지사항

- `'편집중입니다.'`를 포함한 기존 문구를 바꾸지 마라. 이유: 두 테스트가 문자열째 계약으로 잠그고 있고, 사용자에게 익숙한 문구를 바꿀 이유가 없다.
- 잠금 실패 시 자동 재시도하거나 잠금 없이 편집 화면을 열지 마라. 이유: 무잠금 편집 진입은 동시 편집·저장 거부·편집분 유실로 이어진다(phase 53이 writer 쪽에서 닫은 것과 같은 규율).
- `enterEditor`에서 잠금을 **해제**하지 마라(실패 경로에서 `unlockArticle` 호출 금지). 이유: 실패했다는 것은 내 잠금이 아니라는 뜻이며, 남의 잠금을 푸는 시도가 된다.
- `openArticle`(writer 진입)의 fail-closed 로직·`takeoverMessage`·SSE 잠금 핸들러를 손대지 마라. 이유: phase 53 step5의 검증 완료분이며, 이 step은 문구 위치 이동 + 목록 관문만 바꾼다.
- `lockMessages.js`를 `web/src/view/` 아래에 만들지 마라. 이유: 컨트롤러가 view를 import하면 의존 방향(View ← Controller ← Model)이 역전된다(phase 49가 `bodyTitle`에서 이미 정리한 규율).
- 뷰(`ListPage` 등)에 새 안내 배너·토스트를 만들지 마라. 이유: 안내 수단은 기존 `alert` 하나로 통일돼 있고, 새 UI 도입은 이 step의 범위가 아니다.
- `refresh`의 반환값을 폐기 경로에서 `null`/`undefined`로 바꾸지 마라. 이유: 호출자가 응답 객체를 소비한다 — "화면에 반영하지 않는다"와 "호출자에게 결과를 주지 않는다"는 별개이며, 후자는 조회 실패 표시 로직을 조용히 깨뜨린다.
- `refresh`에 요청 취소(AbortController)나 디바운스 타이머를 도입하지 마라. 이유: 모델 계약에 취소 개념이 없고(transport 확장 = 범위 밖), 타이머 도입은 ADR-008의 "앱 내 타이머 0건" 규율과 충돌한다.
- SSE 구독 effect의 의존성·`setLive` 처리·`page` 클램프 effect를 바꾸지 마라. 이유: 재구독이 늘면 무효화 신호가 유실되는 창이 생긴다(기존 주석이 근거를 남기고 있다).
- `docs/ADR.md`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라.
- 기존 테스트를 깨뜨리지 마라.
