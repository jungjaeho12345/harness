# Step 2: mgmt-reason-message

## 목표

관리 3화면(배부 대상 / 수신 설정 / 사용자)에 **똑같이 복제된 실패 사유 문구 매핑을 공용 모듈로 승격**하고, **비문자열 사유가 화면에 새는 결함**을 막는다.

현재 세 파일이 각자 `REASON_MESSAGE` 객체와 `reasonMessage()` 함수를 들고 있다(phase 49 step8이 "동형·비공유"로 만든 상태).

| 파일 | 정의 위치 | 화면별 고유 항목 |
|---|---|---|
| `web/src/view/DistMgmtPage.jsx` | L14~32 | `forbidden`(배부 대상 문구) + 도메인 토큰 6종(`not-found`·`invalid-name`·`invalid-kind`·`invalid-spool-dir`·`duplicate-spool-dir`·`invalid-active`) |
| `web/src/view/RcvMgmtPage.jsx` | L14~25 | `forbidden`(수신 설정 문구) |
| `web/src/view/UserMgmtPage.jsx` | L12~24 | `forbidden`(사용자 관리 문구) |

공통 4종(`unauthenticated`·`internal-error`·`network-error`·`invalid-response`)은 **세 파일 모두 바이트 동일**이다.

결함: 호출부가 전부 `reasonMessage(r && r.reason)` 형태라, 응답이 `null`이거나 `reason` 필드가 없으면 사용자에게 **"요청을 처리하지 못했습니다 (null)."** / **"(undefined)."** 가 그대로 노출된다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-003**(프론트 MVC: View는 순수, Model은 주입형 계약), ADR-004(인가는 서버 — 화면 문구는 안내일 뿐).
- `docs/ARCHITECTURE.md` — 프론트엔드 MVC(L34): `View ← Controller ← Model`. 이 step은 **View 계층 안에서만** 움직인다(컨트롤러·모델 무접촉).
- `docs/UI_GUIDE.md` — 화면 문구/에러 표시 관례.
- `web/src/view/DistMgmtPage.jsx` — L14~32 매핑·함수, 호출부 **L47**(진입 조회 실패) / **L70**(생성·수정 실패) / **L76**(비활성 실패). 에러 영역은 `data-testid="dist-error"` + `role="alert"`.
- `web/src/view/RcvMgmtPage.jsx` — L14~25, 호출부 **L38 / L49 / L54**. 에러 영역 `rcv-error`.
- `web/src/view/UserMgmtPage.jsx` — L12~24, 호출부 **L38 / L69**. 에러 영역 `user-error`. 파일 상단 CRITICAL: **비밀번호는 어떤 응답에도 없고 화면에 절대 렌더하지 않는다** — 이 불변식을 깨지 마라.
- `web/src/view/RcvMgmtPage.test.jsx` — **L126~130**: 미지의 문자열 사유(`'weird-reason'`)가 `요청을 처리하지 못했습니다 (weird-reason).`으로 표시되는 것을 단언한다(**이 형식은 유지 대상**).
- `web/src/view/UserMgmtPage.test.jsx` — L131 동일 단언.
- `web/src/view/DistMgmtPage.test.jsx` — 사유 loop 테스트(공통 3종 확장분 포함).
- 참고: `web/src/model/httpModel.js` — phase 49 step7이 `request()`를 "절대 reject하지 않고 `{ ok:false, reason:'network-error'|'invalid-response' }`로 정규화"한 계약. 화면 문구는 이 토큰들을 소비한다.

## 배경 (자기완결)

세 화면의 실패 표시는 phase 49 step8에서 도입됐고, 그때는 "각 화면 안에서 자기 문구를 갖는다"로 의도적으로 복제했다. 이제 화면이 3개로 늘고 공통 토큰이 4종으로 고정되면서, 새 공통 토큰이 생기면 세 곳을 동시에 고쳐야 하는 형태가 됐다(누락 시 한 화면만 원시 토큰을 노출).

비문자열 폴백이 필요한 이유: 호출부는 `refresh()`/`createX()`가 `null`이나 `undefined`를 돌려줄 수 있는 방어적 형태(`!r || r.ok !== true`)로 쓰여 있다. 그 경로에서 `reason`은 `null`/`undefined`가 되고, 현재 구현은 그것을 문자열 템플릿에 그대로 넣는다. 사용자에게 `(null)`은 의미가 없고, 운영 관점에서도 오해를 부른다.

## TDD — 테스트 먼저

1. 신규 `web/src/view/mgmtMessages.test.js`(순수 모듈 테스트, DOM 불필요):
   - 공통 토큰 4종이 각각 정해진 문구를 돌려준다.
   - `extra`로 넘긴 항목이 공통 항목을 **덮어쓴다**(화면별 `forbidden` 문구).
   - `extra`에만 있는 도메인 토큰도 매핑된다.
   - 미지의 **문자열** 토큰은 `요청을 처리하지 못했습니다 (<토큰>).` 형식을 유지한다(기존 테스트와 동일 형식).
   - `null` / `undefined` / `''` / 숫자 / 객체 → **토큰 없는 일반 문구**를 돌려주고, 결과 문자열에 `null`·`undefined`·`[object Object]`가 포함되지 않는다.
2. 3화면 각각의 테스트 파일에 **비문자열 사유 회귀** 1건씩:
   - 기존 모킹 패턴(`vi.spyOn(model, '<메서드>').mockResolvedValue(...)`)으로 `reason` 없는 실패 응답(`{ ok:false }`) 또는 `null` 응답을 만들고,
   - 에러 영역(`dist-error`/`rcv-error`/`user-error`)에 일반 문구가 뜨며 `'(null)'`·`'(undefined)'` 문자열이 **없음**을 단언한다.
3. 기존 테스트(문구 단언 전부)는 **수정하지 않는다**. 문구가 바이트 동일하게 유지된다는 증거다.

## 작업

1. 신규 `web/src/view/mgmtMessages.js` — 관리 화면 공용 사유 문구 모듈(순수, React·transport 비의존).

   ```js
   export const COMMON_REASON_MESSAGE = Object.freeze({ /* unauthenticated · internal-error · network-error · invalid-response */ });
   export const GENERIC_FAILURE_MESSAGE = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
   export function createReasonMessage(extra = {}) { /* returns (reason) => string */ }
   ```

   판정 순서(이 순서를 지켜라):
   1. `typeof reason === 'string' && reason !== ''`이 아니면 → `GENERIC_FAILURE_MESSAGE`.
   2. `extra[reason]`이 있으면 그 문구(화면별 문구 우선).
   3. 없으면 `COMMON_REASON_MESSAGE[reason]`.
   4. 그것도 없으면 `` `요청을 처리하지 못했습니다 (${reason}).` ``.

   - 공통 4종의 문구는 **현재 세 파일에 있는 문자열을 바이트 그대로** 옮긴다(새로 쓰지 마라).
   - 프로토타입 오염 주의: 매핑 조회는 자기 소유 키만 보게 하라(`Object.hasOwn` 또는 `Object.create(null)`/`Object.freeze`된 리터럴 + `hasOwn`). `'toString'` 같은 사유가 와도 함수 문자열이 화면에 뜨면 안 된다.

2. 세 화면 각각:
   - 로컬 `REASON_MESSAGE` 객체와 `reasonMessage` 함수를 삭제한다.
   - 모듈 스코프에 `const reasonMessage = createReasonMessage({ forbidden: '<그 화면의 기존 문구>', ...(dist는 도메인 토큰 6종) });`을 둔다(컴포넌트 안에서 매 렌더 생성 금지).
   - 호출부(`setError(reasonMessage(r && r.reason))`)는 **그대로** 둔다 — 시그니처가 같다.
   - 파일 상단 주석에서 "동형·비공유"를 설명하던 문장만 공용 모듈 사용으로 갱신한다(주석 전면 재작성 금지).

3. 성공/실패 시의 상태 처리(실패 시 폼·편집 상태 유지, 성공 시에만 `reset()`/`setError('')`, 진입 `useEffect`의 `alive` 가드, 쓰기 핸들러가 내부 재조회 결과를 관찰하지 않는 규칙)는 **한 줄도 바꾸지 마라** — phase 49 step8이 회귀 테스트로 잠근 동작이다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web    # 87 files → 88 files(신규 테스트 파일 1개), 2006 + 신규 케이스, 실패 0
npm test            # 백엔드 무접촉 — 실패 0(개수는 step0·1 종료 시점과 동일)
```

`git diff --name-only`에 `src/`·`server/`·`test/`·`docs/`가 없어야 한다(web 파일만: 뷰 3 + 신규 모듈 1 + 테스트 4).

## 검증 절차

1. 위 AC 커맨드를 실행한다. 기존 문구 단언(각 화면 `forbidden`·공통 토큰·`weird-reason` 형식)이 **무수정 green**인지 확인한다.
2. 문구 동일성 확인: `git diff`에서 공통 4종 문자열이 삭제만 되고(3화면) 신규 모듈에 **동일 문자열**로 나타나는지 눈으로 대조한다.
3. 변이 검증: `createReasonMessage`의 1번 판정(비문자열 게이트)을 제거하면 3화면의 새 회귀 테스트가 red가 되는지 확인한다.
4. 잔여 복제 확인: `git grep -n "요청을 처리하지 못했습니다" -- web/src` 결과에서 **프로덕션 코드는 `mgmtMessages.js` 1파일뿐**이어야 한다(테스트는 단언이므로 남아도 정상).
5. 아키텍처 체크리스트:
   - View → View import만 있는가(뷰가 컨트롤러/모델을 새로 import하지 않았는가)?
   - `mgmtMessages.js`가 React/DOM/transport 비의존 순수 모듈인가?
   - `UserMgmtPage`가 비밀번호를 렌더하지 않는가(기존 단언 유지)?
6. `phases/50-hygiene-cleanup/index.json`의 step2를 `completed` + `summary`로 갱신한다.

## 금지사항

- 화면별 `forbidden` 문구를 하나로 통일하지 마라. 이유: 세 화면이 서로 다른 관리 대상을 안내하는 문구이며, 통일하면 사용자가 어떤 권한이 부족한지 알 수 없다(기존 테스트도 각 문구를 단언한다).
- 공통 4종의 문자열을 다듬거나 표현을 고치지 마라. 이유: 승격은 위치 이동일 뿐이며, 문구가 바뀌면 이번 리팩터가 안전했는지 테스트로 증명할 수 없다.
- 미지의 **문자열** 토큰을 일반 문구로 삼키지 마라. 이유: `(<토큰>)` 표시는 운영자가 새 서버 사유를 발견하는 유일한 단서다 — 이번에 바뀌는 것은 **비문자열** 경로뿐이다.
- 컨트롤러(`useDistMgmtController`/`useRcvMgmtController`/`useUserMgmtController`)나 `httpModel`을 수정하지 마라. 이유: 사유 토큰 생산은 서버·모델의 책임이고 이 step은 표시 계층만 정리한다.
- 에러 영역의 `data-testid`/`role="alert"`/배치를 바꾸지 마라. 이유: phase 49 step8이 잠근 접근성·테스트 계약이다.
- 실패 시 폼 초기화·성공 시에만 클리어하는 규칙을 손대지 마라. 이유: "성공한 내부 재조회가 쓰기 실패 메시지를 지우는" 회귀를 막는 장치다(타이밍 회귀 가드 3건이 이를 단언한다).
- `.claude/skills/claude-code-review-harness/SKILL.md`를 읽거나 수정하거나 커밋에 포함하지 마라. 이유: 사용자가 편집 중인 파일이다.
