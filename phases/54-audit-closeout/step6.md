# Step 6: mgmt-pages

## 목표

관리 3화면(배부 대상 `distMgmt.do` / 수신 설정 `rcvMgmt.do` / 사용자 `userMgmt.do`)에서 **두 가지**를 처리한다.

1. **위생**: 세 파일에 그대로 복제된 실패 사유 문구 매핑(`REASON_MESSAGE` + `reasonMessage`)을 공용 모듈로 승격하고, **비문자열 사유가 화면에 새는 결함**(`요청을 처리하지 못했습니다 (null).` / `(undefined).`)을 막는다.
2. **결함**: 폼 제출에 **in-flight 가드가 없어 더블클릭이 요청을 2회 보내고 중복 행이 생기는 문제**를 막는다(감사 A-6은 수신 설정 생성에서 재현됐고, 나머지 두 화면도 코드가 동형이다).

> **작업 순서를 반드시 지켜라**: (1) 공용 모듈 승격(동작 불변) → `npm run test:web` green 확인 → (2) 중복 제출 가드(동작 변경). 리팩터와 동작 변경이 섞이면 어느 쪽이 회귀를 냈는지 가릴 수 없다.
>
> **선행**: 관리화면 패스. step0~5와 파일 중복 없음. 수정 대상은 **`web/src/view/mgmtMessages.js`(신규) + 3개 페이지 + 각 테스트**다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md` — 프론트 MVC(`View ← Controller ← Model`). 이 step은 **View 계층 안에서만** 움직인다.
- `docs/UI_GUIDE.md` — 버튼(`.yh-btn`)·카드·입력 토큰. `web/src/styles/yonhap.css`에 `.yh-btn:disabled` 규칙이 이미 있다(새 CSS 불필요).
- `web/src/view/DistMgmtPage.jsx` — `REASON_MESSAGE`(공통 4종 + 도메인 6종 `not-found`·`invalid-name`·`invalid-kind`·`invalid-spool-dir`·`duplicate-spool-dir`·`invalid-active` + 화면별 `forbidden`), `reasonMessage`, 진입 `useEffect`(alive 가드), `onSubmit`(생성/수정 겸용 — `editingId`), `onDeactivate`. 에러 영역 `data-testid="dist-error"` + `role="alert"`.
- `web/src/view/RcvMgmtPage.jsx` — 같은 구조(공통 4종 + 화면별 `forbidden`), `onCreate`, `onDelete`. 에러 영역 `rcv-error`.
- `web/src/view/UserMgmtPage.jsx` — 같은 구조, `onSubmit`(생성/수정 겸용 — `editing`), `startEdit`/`reset`. 에러 영역 `user-error`. **파일 상단 CRITICAL: 비밀번호는 어떤 응답에도 없고 화면에 절대 렌더하지 않는다** — 이 불변식을 깨지 마라.
- 공통 4종(`unauthenticated`·`internal-error`·`network-error`·`invalid-response`)의 문구는 **세 파일이 바이트 동일**이다.
- `web/src/view/DistMgmtPage.test.jsx`, `web/src/view/RcvMgmtPage.test.jsx`, `web/src/view/UserMgmtPage.test.jsx` — 기존 관례: `vi.spyOn(model, '<메서드>').mockResolvedValue(...)`, 에러 영역 `data-testid` 조회, 미지의 문자열 사유(`'weird-reason'`)가 `요청을 처리하지 못했습니다 (weird-reason).`으로 표시된다는 단언(**이 형식은 유지 대상**).
- `web/src/model/httpModel.js` — `request()`가 절대 reject하지 않고 `{ ok:false, reason:'network-error'|'invalid-response' }`로 정규화하는 계약(화면 문구는 이 토큰을 소비한다).
- `src/services/receiverConfigService.js` — `create`는 Z 게이트 통과 후 `receiverConfigModel.insert(entry)`를 그대로 실행한다(**유일성 검사 없음** — 그래서 두 번 보내면 두 행이 생긴다). 이 step은 서버를 고치지 않는다(이유는 금지사항 참조).

## 배경 (자기완결)

**(1) 문구 복제·비문자열 사유.** 세 화면의 실패 표시는 phase 49에서 "각 화면이 자기 문구를 갖는다"로 의도적으로 복제됐다. 화면이 셋이 되고 공통 토큰이 4종으로 고정되면서, 새 공통 토큰이 생기면 세 곳을 동시에 고쳐야 하고 누락되면 한 화면만 원시 토큰을 노출한다. 또한 호출부가 전부 `reasonMessage(r && r.reason)` 형태라 응답이 `null`이거나 `reason`이 없으면 `(null)`·`(undefined)`가 사용자 문구로 노출된다.

**(2) 중복 제출.** 세 화면의 제출 핸들러는 `async` 함수이고 요청이 도는 동안 버튼이 그대로 살아 있다. 더블클릭하면 같은 폼 값으로 두 번 POST가 나가고, 서버에는 유일성 검사가 없어 **중복 행**이 만들어진다. 그 뒤 목록에는 구분되지 않는 두 행이 남고(비파괴 원칙상 임의 삭제도 못 한다) 수집 설정이라면 같은 소스가 두 번 처리될 수 있다.

## TDD — 테스트 먼저

**A. 공용 문구 모듈 — 신규 `web/src/view/mgmtMessages.test.js`(순수 모듈, DOM 불필요)**
1. 공통 토큰 4종이 각각 정해진 문구를 돌려준다(문자열은 현재 파일들에서 **바이트 그대로** 옮긴 값).
2. `extra`로 넘긴 항목이 공통 항목을 **덮어쓴다**(화면별 `forbidden` 문구).
3. `extra`에만 있는 도메인 토큰(`invalid-spool-dir` 등)도 매핑된다.
4. 미지의 **문자열** 토큰은 `요청을 처리하지 못했습니다 (<토큰>).` 형식을 유지한다.
5. `null` / `undefined` / `''` / 숫자 / 객체 / 배열 → **토큰 없는 일반 문구**를 돌려주고, 결과에 `null`·`undefined`·`[object Object]`가 포함되지 않는다.
6. 프로토타입 오염 방어: `'toString'`·`'constructor'` 같은 사유가 와도 함수 문자열이 아니라 미지 토큰 형식이 나온다.

**B. 화면별 회귀 + 결함(각 페이지 테스트에 1~2건씩)**
7. 비문자열 사유 회귀: 쓰기/조회를 `{ ok:false }`(reason 없음) 또는 `null`로 모킹하면 에러 영역에 일반 문구가 뜨고 `'(null)'`·`'(undefined)'` 문자열이 **없다**.
8. 기존 문구 단언(각 화면 `forbidden`·공통 토큰·`weird-reason` 형식)은 **무수정 green**이어야 한다.

**C. 중복 제출 가드(각 페이지 1~2건씩)**
9. 결함 재현: 생성 요청을 **지연 Promise**(`new Promise((res) => { resolve = res; })`)로 모킹하고 제출 버튼을 **연속 2회** 클릭하면 모델 호출이 **1회**뿐이다. resolve 후 폼이 초기화되는 기존 성공 동작은 그대로다.
10. 제출 중 버튼이 `disabled`이고, 완료 후 다시 활성화된다(성공·실패 양쪽).
11. 실패 후 재제출 가능: 첫 제출이 실패로 끝난 뒤 다시 제출하면 모델이 **다시 호출**된다(가드가 영구 잠금이 아니라는 증거). 실패 시 입력값 유지·에러 문구 표시도 그대로.
12. 회귀: 삭제/비활성 버튼(`onDelete`/`onDeactivate`)과 수정 진입(`startEdit`)의 기존 동작은 변하지 않는다.

기존 테스트는 수정하지 않는다.

## 작업

### (1) 공용 문구 모듈 — 동작 불변

신규 `web/src/view/mgmtMessages.js`(순수 모듈, React·transport 비의존):

```js
export const COMMON_REASON_MESSAGE = Object.freeze({ /* unauthenticated · internal-error · network-error · invalid-response */ });
export const GENERIC_FAILURE_MESSAGE = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
export function createReasonMessage(extra = {}) { /* returns (reason) => string */ }
```

판정 순서(이 순서를 지켜라):
1. `typeof reason === 'string' && reason !== ''`이 아니면 → `GENERIC_FAILURE_MESSAGE`.
2. `extra`의 **자기 소유 키**에 있으면 그 문구(화면별 우선).
3. 없으면 `COMMON_REASON_MESSAGE`의 자기 소유 키.
4. 그것도 없으면 `` `요청을 처리하지 못했습니다 (${reason}).` ``.

- 공통 4종 문구는 현재 세 파일의 문자열을 **바이트 그대로** 옮긴다(새로 쓰지 마라).
- 조회는 `Object.hasOwn`(또는 `Object.create(null)` 맵)으로 자기 소유 키만 본다 — 프로토타입 체인 조회 금지.

세 화면 각각:
- 로컬 `REASON_MESSAGE`·`reasonMessage`를 삭제하고, **모듈 스코프**에 `const reasonMessage = createReasonMessage({ forbidden: '<그 화면의 기존 문구>', ...(dist는 도메인 6종) });`을 둔다(컴포넌트 안에서 매 렌더 생성 금지).
- 호출부 `setError(reasonMessage(r && r.reason))`는 **그대로** 둔다(시그니처 동일).
- 파일 상단 주석에서 "동형·비공유"를 설명하던 문장만 공용 모듈 사용으로 갱신한다(주석 전면 재작성 금지).

여기까지 하고 **`npm run test:web`을 돌려 green을 확인**한 뒤 (2)로 넘어간다.

### (2) 중복 제출 가드 — 동작 변경

세 화면에 동일 패턴으로 넣는다.

- `const [submitting, setSubmitting] = useState(false);`
- 제출 핸들러 진입부: `if (submitting) return;` → `setSubmitting(true);` → `try { …기존 로직… } finally { setSubmitting(false); }`.
  - `e.preventDefault()`는 지금 위치 그대로 가장 먼저 호출한다.
  - 성공 시 `reset()`/`setForm(BLANK)`·`setError('')`, 실패 시 입력값 유지 + 문구 표시 — **기존 분기를 바꾸지 마라**.
- 제출 버튼에 `disabled={submitting}`을 추가한다(새 CSS 없이 `.yh-btn:disabled`가 적용된다). 버튼 라벨·`type="submit"`·`data-testid`는 바꾸지 않는다.
- 가드 범위는 **제출(생성/수정) 핸들러**뿐이다. 삭제(`onDelete`)·비활성(`onDeactivate`)·조회(`refresh`)에는 넣지 않는다(이 step의 결함이 아니고, 재조회 흐름과 얽혀 회귀 표면이 커진다).
- 로컬 캐시·낙관적 업데이트·요청 중복 제거(dedupe key) 같은 장치를 새로 만들지 마라 — 상태 하나(`submitting`)로 끝낸다.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm run test:web  # 87 files → 88 files(신규 mgmtMessages.test.js), 실패 0
npm test          # 백엔드 무접촉 — 실패 0(개수는 step2 종료 시점과 동일)
```

`git diff --name-only`에 `src/`·`server/`·`test/`·`docs/`가 없어야 한다(web 파일만: 신규 모듈 1 + 신규 테스트 1 + 뷰 3 + 뷰 테스트 3).

## 검증 절차

1. (1)까지 마친 시점에 `npm run test:web`을 한 번 돌려 **문구 관련 기존 단언이 전부 green**임을 확인한다(리팩터가 안전했다는 증거). 그 다음 (2)를 적용하고 전체 AC를 다시 돌린다.
2. 문구 동일성 확인: `git diff`에서 공통 4종 문자열이 3화면에서 삭제되고 신규 모듈에 **같은 문자열**로 나타나는지 눈으로 대조한다.
3. 변이 검증 3종(확인 후 원복):
   - `createReasonMessage`의 비문자열 게이트를 제거하면 3화면의 비문자열 회귀 케이스만 red.
   - `if (submitting) return;`을 지우면 더블클릭 케이스(9)만 red.
   - `finally { setSubmitting(false); }`를 지우면 "실패 후 재제출 가능"(11)이 red.
4. 잔여 복제 확인: `git grep -n "요청을 처리하지 못했습니다" -- web/src` 결과에서 **프로덕션 코드는 `mgmtMessages.js` 1파일뿐**이어야 한다(테스트의 단언 문자열은 남아도 정상).
5. 아키텍처 체크리스트:
   - View → View import만 있는가(뷰가 컨트롤러/모델을 새로 import하지 않았는가)?
   - `mgmtMessages.js`가 React/DOM/transport 비의존 순수 모듈인가?
   - `UserMgmtPage`가 비밀번호를 렌더하지 않는가(기존 단언 유지)?
   - 새 CSS 클래스·새 전역 상태·새 네트워크 호출이 없는가?
6. `phases/54-audit-closeout/index.json`의 step6을 `completed` + `summary`로 갱신한다. summary에 (a) 공용 모듈 API와 판정 순서, (b) 가드를 적용한 핸들러 목록(제출만), (c) 서버 유일성 검사는 도입하지 않았다는 사실을 명시하라.

## 금지사항

- 서버(`src/services/receiverConfigService.js` 등)에 중복(sourceId) 거부 규칙을 추가하지 마라. 이유: rcv.md·SCHEMA.md에 유일성 규칙이 없어 오늘 성공하던 요청을 실패로 바꾸는 스펙 변경이고, 이미 저장된 중복 행 처리 방침(DB 비파괴라 삭제 불가)까지 사용자 확정이 필요하다.
- 실패한 제출을 자동으로 재시도하지 마라. 이유: 중복 생성을 막으려는 step에서 자동 재시도는 정확히 반대 방향이다.
- 삭제/비활성/조회에 in-flight 가드를 확대하지 마라. 이유: 이 step의 결함이 아니며, 쓰기 후 내부 재조회 흐름과 얽혀 "성공한 재조회가 실패 메시지를 지우는" 기존 회귀 가드를 흔든다.
- 실패 시 폼 초기화·성공 시에만 클리어하는 규칙을 손대지 마라. 이유: phase 49가 타이밍 회귀 테스트로 잠근 동작이다.
- 진입 `useEffect`의 `alive` 가드나 "쓰기 핸들러가 내부 재조회 결과를 관찰하지 않는다"는 규칙을 바꾸지 마라. 이유: 같은 회귀 가드에 속한다.
- 화면별 `forbidden` 문구를 하나로 통일하지 마라. 이유: 세 화면이 서로 다른 관리 대상을 안내하며, 통일하면 사용자가 어떤 권한이 부족한지 알 수 없다(기존 테스트도 각 문구를 단언한다).
- 미지의 **문자열** 토큰을 일반 문구로 삼키지 마라. 이유: `(<토큰>)` 표시는 운영자가 새 서버 사유를 발견하는 유일한 단서다 — 이번에 바뀌는 것은 **비문자열** 경로뿐이다.
- 에러 영역의 `data-testid`/`role="alert"`/배치, 폼의 `data-testid`를 바꾸지 마라. 이유: 접근성·테스트 계약이다.
- 컨트롤러(`useDistMgmtController`/`useRcvMgmtController`/`useUserMgmtController`)나 `httpModel`을 수정하지 마라. 이유: 사유 토큰 생산은 서버·모델 책임이고 이 step은 표시·입력 계층만 다룬다.
- `docs/ADR.md`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라.
- 기존 테스트를 깨뜨리지 마라.
