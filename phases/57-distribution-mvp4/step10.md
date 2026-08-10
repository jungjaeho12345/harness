# Step 10: list-filter-controller

## 목표

기사 목록 컨트롤러(`web/src/controller/useViewController.js`)가 **배부시간 범위 조회조건**을 필터에 실을 수 있게 한다.

- `buildMenuFilter(menu, identity, departments, range)` — 선택적 4번째 인자로 범위를 병합(순수 함수 유지).
- 훅에 `distributedRange` 상태 + `setDistributedRange(from, to)` 노출.

Controller 계층 1파일만 다룬다. 조회조건 폼(View)은 step11이다.

## 읽어야 할 파일

- `docs/news.md` **12행** — "기사를 조회하는 함수에서는 배부시간을 조건으로 기사를 조회할 수 있다". **읽기 전용(무접촉, 사용자 소유 미커밋 파일)**.
- `docs/ADR.md` **ADR-003**(Model 계약 경유)·**ADR-005**(SSE 무효화 신호 → 자기 필터로 재조회). **읽기 전용**.
- `web/src/controller/useViewController.js` 전체(254줄) — 특히
  - L27~66 `buildMenuFilter`(메뉴별 status/부서 필터를 만드는 **순수 함수**, export되어 테스트가 직접 호출한다).
  - L82~85 `filter` useMemo와 그 의존성(`menu`, `identity`, `departments`).
  - L87~107 재조회 가드(seq·mounted)와 `useEffect(() => { refresh(); }, [refresh])`.
  - L120~126 SSE 구독이 `filter` 정체성에 묶여 있다는 점(**필터 객체가 새로 만들어질 때마다 재구독**된다).
- `web/src/controller/useViewController.test.jsx` — `buildMenuFilter` 직접 호출 케이스와 훅 렌더 케이스 스타일.
- `server/index.js` L215~227 `FILTER_KEYS` — `distributedAtFrom`·`distributedAtTo`가 **이미 화이트리스트에 있다**(서버 무변경).
- `src/models/articleModel.js` L73~140 — `distributedAtFrom/To`가 사전식 비교로 적용된다(서버 무변경).
- `web/src/view/listFormat.js`(step9) — `rangeInstant(value, edge)`. **이 step에서는 쓰지 않는다**(입력 폼 값 변환은 View 책임) — 컨트롤러는 이미 ISO인 값을 받는다.

## 배경 (자기완결)

백엔드는 이미 준비돼 있다. 이 step은 **클라이언트 필터 조립**만 연다.

```js
buildMenuFilter('deptSend', identity, ['사회부'], { from: '2026-08-01T00:00:00.000Z', to: undefined })
// → { status:['DPS'], departments:['사회부'], distributedAtFrom:'2026-08-01T00:00:00.000Z' }
```

**주의(무한 재조회 함정)**: `filter`는 `useMemo`로 만들어지고 SSE 구독(`useEffect [model, filter, refresh]`)이 그 정체성에 묶여 있다. 범위 상태를 **객체로 들고 매번 새 객체를 만들면** 렌더마다 재구독·재조회가 발생한다. 범위는 **원시값 2개(from/to 문자열)** 로 저장하고 `filter` useMemo 안에서 조립하라(의존성도 원시값 2개).

## TDD — 테스트 먼저

`web/src/controller/useViewController.test.jsx`에 케이스를 **추가**한다(기존 케이스 수정 금지 — 기존 `buildMenuFilter` 3인자 호출은 무수정 green이어야 한다).

### buildMenuFilter (순수)

1. 4번째 인자 미전달 시 결과가 기존과 **완전히 동일**하다(전 메뉴 6종에 대해 기존 기대값과 `deepEqual`).
2. `{ from }`만 주면 `distributedAtFrom`만 들어가고 `distributedAtTo`는 **키 자체가 없다**(undefined 키를 만들지 않는다 — httpModel 쿼리 직렬화에 `undefined` 값이 섞이면 `?distributedAtTo=undefined`가 될 수 있다).
3. `{ to }`만 주면 대칭으로 동작한다.
4. 둘 다 주면 둘 다 들어간다.
5. `{}`·`null`·`undefined`·비객체를 주면 기존과 동일한 결과다(방어).
6. 빈 문자열은 조건에서 제외된다.
7. 메뉴별 기존 조건(status/excludeStatus/departments/author)과 **함께** 실린다(예: `personal` + 범위).
8. 순수성: 인자를 변형하지 않는다(입력 range 객체 `deepEqual` 유지).

### 훅

9. 초기 `distributedRange`는 `{ from: undefined, to: undefined }`(또는 빈 값)이고 첫 조회 필터에 배부시간 키가 없다.
10. `setDistributedRange(from, to)` 후 `model.queryArticles`가 **범위가 실린 필터**로 재조회된다(스파이 인자 확인).
11. 같은 값으로 다시 `setDistributedRange`를 호출해도 추가 재조회·재구독이 발생하지 않는다(원시값 상태 — 스파이 호출 수 고정).
12. 메뉴를 바꿔도 범위 조건은 유지된다(또는 초기화된다 — **택일해 케이스로 고정**하라. 권장: 유지. 부서 선택은 `selectMenu`에서 초기화되지만 시간 범위는 사용자가 명시 입력한 조회조건이라 유지가 자연스럽다).
13. `setDistributedRange(undefined, undefined)`로 조건을 지우면 필터에서 키가 빠진 채 재조회된다(해제 경로 존재).
14. 회귀: 기존 API(`menu`/`selectMenu`/`departments`/`setDepartments`/`refresh`/`pageItems` 등)가 그대로 있고 기존 케이스가 전부 green이다.

## 작업

`web/src/controller/useViewController.js`만 수정한다.

1. `buildMenuFilter`에 선택적 4번째 인자를 추가한다(기존 3인자 호출 무영향).

```js
// range(선택): { from, to } — 배부시간 범위 조회조건(news.md 12행). 값이 있는 쪽만 실린다.
// 서버 파라미터 이름(distributedAtFrom/To)은 server/index.js FILTER_KEYS와 1:1이다(이미 존재 — 서버 무변경).
export function buildMenuFilter(menu, identity, departments, range) {}
```

2. 훅에 원시값 상태 2개와 setter를 둔다.

```js
const [distributedAtFrom, setDistributedAtFrom] = useState(undefined);
const [distributedAtTo, setDistributedAtTo] = useState(undefined);
const setDistributedRange = useCallback((from, to) => { /* 두 원시값 세팅 */ }, []);
const filter = useMemo(
  () => buildMenuFilter(menu, identity, departments, { from: distributedAtFrom, to: distributedAtTo }),
  [menu, identity, departments, distributedAtFrom, distributedAtTo],
);
```

3. 반환 객체에 `distributedRange`(표시용 `{ from, to }`)와 `setDistributedRange`를 추가한다. 기존 반환 키는 전부 유지한다.
4. 빈 문자열은 `undefined`로 정규화해 저장한다(빈 조건이 필터에 실리지 않게).
5. 필터 조립 규칙(키 이름·값 형식)을 뷰가 알 필요 없게 한다 — 뷰는 ISO 문자열 2개만 넘긴다.

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — step9 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `web/src/controller/useViewController.js`, `web/src/controller/useViewController.test.jsx` **2개뿐**.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 3종(확인 후 원복):
   - 값이 없어도 키를 넣게 바꾸면(`distributedAtTo: undefined`) 케이스 2가 red.
   - 범위 상태를 객체 하나(`useState({})`)로 바꾸고 setter가 항상 새 객체를 만들게 하면 케이스 11이 red.
   - `filter` useMemo 의존성에서 범위 원시값을 빼면 케이스 10이 red.
3. 아키텍처 체크리스트:
   - `buildMenuFilter`가 여전히 순수한가(시계·전역 상태 없음)?
   - 컨트롤러가 `fetch`·URL을 모르는가(ADR-003)?
   - SSE 구독이 렌더마다 재생성되지 않는가?
4. `phases/57-distribution-mvp4/index.json`의 step10을 `completed` + `summary`로 갱신한다. summary에 `buildMenuFilter` 4번째 인자 계약·훅 반환 추가 키·메뉴 전환 시 범위 유지/초기화 택일 결과를 명시하라.

## 금지사항

- 범위 상태를 객체로 들고 setter에서 매번 새 객체를 만들지 마라. 이유: `filter` useMemo → `refresh`/SSE 구독 effect가 그 정체성에 묶여 있어 렌더마다 재조회·재구독이 발생한다(성능·SSE 리스너 누수).
- 값이 없는 조건의 키를 `undefined`로라도 넣지 마라. 이유: 쿼리 직렬화에서 `?distributedAtTo=undefined` 같은 쓰레기 값이 서버 필터로 들어간다(사전식 비교라 조용히 결과가 0건이 된다).
- 컨트롤러에서 입력 폼 값(`datetime-local`)을 ISO로 변환하지 마라. 이유: 변환 규약은 순수 뷰 모듈 `listFormat.rangeInstant`(step9)가 단일 출처다 — 두 곳에 두면 규약이 갈라진다.
- 서버 필터 파라미터를 새로 만들거나 이름을 바꾸지 마라(`distributedAtFrom`/`distributedAtTo` 고정). 이유: `server/index.js`의 `FILTER_KEYS` 화이트리스트에 없는 키는 조용히 버려진다.
- 메뉴별 기존 필터 규칙(status/excludeStatus/departments/author)을 건드리지 마라. 이유: news.md 4+2 메뉴 스펙과 직결되며 기존 테스트가 전부 잠그고 있다.
- 자동 폴링·주기 재조회를 추가하지 마라. 이유: 실시간 갱신은 SSE 무효화 신호가 단일 경로다(ADR-005)·앱 내 타이머 금지(ADR-008).
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
