# Step 7: distmgmt-controller

## 목표

`web/src/controller/useDistMgmtController.js`에 배부 실패 목록·재전송·수동 tick 실행을 **additive**로 추가한다. 기존 배부 대상 CRUD API(`targets`/`refresh`/`createTarget`/`updateTarget`/`deactivateTarget`)는 그대로 둔다.

Controller 계층만 다룬다 — 화면(DistMgmtPage)은 step8 소관이다.

## 읽어야 할 파일

- `docs/ADR.md` **ADR-003**(View ← Controller ← Model, transport 직접 호출 금지)·**ADR-004**(프론트 가드는 UX, 실제 인가는 서버). **읽기 전용(무접촉)**.
- `web/src/controller/useDistMgmtController.js` 전체(40줄) — 기존 5개 API와 "쓰기 후 직접 재조회"(SSE 신호 없음) 규율, "서버 응답 `{ ok, reason }`을 가공하지 않고 그대로 반환" 규율.
- `web/src/controller/useDistMgmtController.test.jsx` — `renderHook` + `AppContext` + `createFakeModel` 하네스.
- `web/src/controller/useRcvMgmtController.js` — 같은 계열 관리 화면 컨트롤러(비교용).
- `web/src/test/fakeModel.js`(step6 결과) — `queryDistributionFailures`/`retryDistribution`/`runDistributionTick`와 seed 키.
- 참고: `web/src/controller/useViewController.js` L87~104 — 겹친 비동기 조회의 순서 역전·언마운트 setState 가드 패턴(필요하면 같은 방식으로 방어).

## 배경 (자기완결)

배부 대상 변경과 마찬가지로 **실패 목록에도 SSE 무효화 신호가 없다** — 쓰기(재전송·tick) 후에는 컨트롤러가 직접 재조회해야 화면이 갱신된다.

추가 API:

```js
failures                                  // 미해소 실패 항목 배열(초기 [])
refreshFailures()                         // model.queryDistributionFailures() → 상태 갱신 후 응답 원본 반환
retryTarget(articleId, targetId)          // model.retryDistribution(...) → 성공/실패 무관하게 목록 재조회 후 응답 원본 반환
runTick()                                 // model.runDistributionTick()    → 실행 후 목록 재조회 후 응답 원본 반환
```

`runTick`이 실패 목록을 재조회하는 이유: tick이 새 실패를 만들었을 수 있다.

## TDD — 테스트 먼저

`web/src/controller/useDistMgmtController.test.jsx`에 케이스를 **추가**한다(기존 케이스 수정 금지).

1. 초기 `failures`는 `[]`이고, `refreshFailures()`가 seed 항목을 로드한다.
2. `refreshFailures()`는 서버 응답 객체를 **그대로** 반환한다(`{ ok:true, items }` — 가공·필터 금지).
3. 조회 실패(`{ ok:false, reason:'forbidden' }`)면 `failures`는 `[]`로 두고 응답을 그대로 반환한다(throw 금지).
4. `retryTarget(articleId, targetId)`가 `model.retryDistribution`을 **인자 그대로** 호출한다(스파이).
5. `retryTarget` 성공 후 `failures`에서 그 항목이 사라진다(내부 재조회 1회 — 스파이로 `queryDistributionFailures` 호출 확인).
6. `retryTarget` 실패(`no-failure`)여도 재조회가 일어나고 응답이 그대로 반환된다(실패를 삼키지 않는다).
7. `runTick()`이 `model.runDistributionTick`을 인자 없이 호출하고, 실행 후 실패 목록을 재조회한다.
8. `runTick()`은 tick 응답 객체를 그대로 반환한다(`{ ok, scanned, distributed, failed, invalid }` — 요약 문구 생성 금지, 그건 View 책임).
9. 반환 API에 기존 5개 키가 그대로 있고 새 키 4개가 추가된다(회귀 잠금).
10. 각 콜백은 `useCallback`으로 안정적이다 — 같은 model이면 재렌더 후에도 함수 정체성이 유지된다(무한 effect 루프 방지).

## 작업

`web/src/controller/useDistMgmtController.js`만 수정한다.

```js
const [failures, setFailures] = useState([]);

const refreshFailures = useCallback(async () => { /* model.queryDistributionFailures() */ }, [model]);
const retryTarget = useCallback(async (articleId, targetId) => { /* retry → refreshFailures */ }, [model, refreshFailures]);
// 실행 트리거는 사용자의 명시 조작뿐이다 — 여기에 setInterval/자동 폴링을 두지 마라(ADR-008 (3)).
const runTick = useCallback(async () => { /* tick → refreshFailures */ }, [model, refreshFailures]);
```

규칙:

1. 서버 응답을 가공하지 마라 — 상태에는 `items`만 담고, 반환은 원본 객체 그대로다.
2. `items`가 없으면 `[]`로 폴백한다(`(r && r.items) || []` — 기존 `refresh`와 동형).
3. 사용자 문구·요약 문자열을 컨트롤러에서 만들지 마라(View 책임).
4. 자동 조회(`useEffect`로 mount 시 실패 목록 로드)를 **컨트롤러에 넣지 마라** — 기존 `refresh`도 화면(DistMgmtPage)이 effect로 부른다. 진입 조회 정책은 View가 갖는다.
5. 기존 5개 API·주석·`targets` 상태는 변경 금지.
6. 새 주석에 "실패 목록에도 SSE 신호가 없다 — 쓰기 후 직접 재조회"를 남긴다.

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — step6 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `web/src/controller/useDistMgmtController.js`, `web/src/controller/useDistMgmtController.test.jsx` **2개뿐**.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 3종(확인 후 원복):
   - `retryTarget`에서 재조회를 빼면 케이스 5가 red.
   - `refreshFailures`가 `items`만 반환하게 바꾸면 케이스 2가 red.
   - `runTick`이 성공(`ok:true`)일 때만 재조회하게 바꾸면 케이스 7의 실패 시나리오 확장 케이스가 red(케이스 7에 실패 tick 변형을 포함시켜라).
3. 아키텍처 체크리스트:
   - `fetch`/URL 문자열이 컨트롤러에 없는가(ADR-003)?
   - 타이머·폴링이 없는가(ADR-008)?
   - 사용자 문구가 컨트롤러에 없는가?
4. `phases/57-distribution-mvp4/index.json`의 step7을 `completed` + `summary`로 갱신한다. summary에 추가 API 4개의 시그니처·반환 규약·재조회 시점을 명시하라.

## 금지사항

- `setInterval`/`setTimeout` 폴링으로 실패 목록이나 tick을 자동 실행하지 마라. 이유: ADR-008 (3)은 앱 내 주기 실행을 금지한다 — 다중 탭/인스턴스에서 중복 배부와 중복 tick이 생긴다.
- 컨트롤러에서 사유 토큰을 한글 문구로 바꾸지 마라. 이유: 표시 정책은 View(`mgmtMessages.createReasonMessage`)의 단일 책임이다.
- 실패 응답을 삼키고 `[]`만 세팅한 채 `undefined`를 반환하지 마라. 이유: 화면이 조회 실패를 "실패 0건"으로 표시해 미발송이 무음으로 사라진다.
- 기존 `refresh`(배부 대상)와 `refreshFailures`를 하나로 합치지 마라. 이유: 호출 시점·실패 표시 정책이 다르고, 한쪽 실패가 다른 쪽 표시를 덮는 회귀가 생긴다(기존 파일의 명시 규율).
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
