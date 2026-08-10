# Step 5: list-range-requery

## 목표

기사 조회페이지의 **'배부시간 조회'** 클릭이 이전 filter 클로저로 조회를 1건 더 날리는 문제를 없앤다.

`web/src/view/ListPage.jsx`의 `applyDistributedRange`만 고친다. 컨트롤러(`useViewController.js`)는 **무수정**이다.

## 읽어야 할 파일

- `web/src/view/ListPage.jsx` — 78~83행(`fromInput`/`toInput` 로컬 state와 "반영은 클릭 시에만" 규율), 185~191행(`applyDistributedRange`), 231~250행(조회조건 바 마크업: 라벨 `배부시간 시작`/`배부시간 종료`, 버튼 `배부시간 조회`), 226~228행(부서 바의 `조회` 버튼 = `refresh()` 직접 호출 — **이 트리거는 그대로 둔다**).
- `web/src/controller/useViewController.js` — 92~106행(원시값 상태 2개 + `setDistributedRange` + `filter` useMemo), 108~128행(`refreshSeqRef` seq 가드, `refresh` useCallback의 `[model, filter]` 의존성, `useEffect(() => { refresh(); }, [refresh])`), 141~147행(SSE 구독 effect의 `[model, filter, refresh]` 의존성). **읽기 전용.**
- `web/src/view/listFormat.js` 71~78행 `rangeInstant(value, edge)` — 형식 불일치·비문자열이면 `undefined`, 그 외 `:00.000Z`/`:59.999Z` 합성.
- `web/src/view/ListPage.test.jsx` 753~871행(phase 57 조회조건 케이스 묶음) — 특히 **L849 `값이 같아도 조회를 다시 누르면 재조회가 일어난다(refresh 동반 호출)`**(유지해야 하는 계약)와 L777(타이핑만으로는 재조회 없음), L788·L801·L816·L831(필터 합성·해제 경로), L862(메뉴 전환 시 입력값 유지).
- `web/src/controller/useViewController.test.jsx` 580~676행 — 특히 **L623 `같은 값으로 다시 호출해도 추가 재조회·재구독이 없다(원시값 상태)`**(컨트롤러에 nonce를 심는 변형을 금지하는 케이스).
- `web/src/test/fakeModel.js` 330~338행 `subscribe` — 등록만 하고 조회를 유발하지 않는다(호출 수 단언이 결정적인 근거).

## 배경 (자기완결)

현재 코드:

```jsx
const applyDistributedRange = () => {
  setDistributedRange(rangeInstant(fromInput, 'from'), rangeInstant(toInput, 'to'));
  refresh();   // ← 이 시점의 refresh는 '이전' filter 클로저다
};
```

`setDistributedRange`는 다음 렌더에서야 `filter`를 바꾸므로, 같은 렌더의 `refresh()`는 **범위가 빠진 이전 필터**로 서버를 한 번 친다. 그 다음 렌더에서 `filter` 변경 → `useEffect([refresh])`가 새 필터로 또 조회한다. 즉 값이 바뀐 클릭마다 조회 2건이다. 정확성은 컨트롤러의 seq 가드가 지켜주지만(늦게 온 옛 응답은 버려진다), 구 응답이 먼저 도착하면 한 프레임 동안 범위 미적용 목록이 보이고 서버 조회 1건이 순수 낭비다.

확정 해법(View 국소):

```jsx
// 직전에 '적용한' ISO 범위. 값이 실제로 바뀌면 filter 변경 → 기존 재조회 effect가 조회를 수행하므로
// 여기서 refresh()를 부르면 이전 filter 클로저로 조회가 1건 더 나간다(중복 요청).
// 값이 그대로면 effect가 돌지 않으므로 그때만 명시 재조회한다('조회' 버튼의 재조회 보장 계약).
const appliedRangeRef = useRef({ from: undefined, to: undefined });
```

- `rangeInstant`가 돌려주는 값(문자열 또는 `undefined`)을 그대로 비교 대상으로 쓴다. 별도 정규화를 만들지 마라(컨트롤러의 빈 문자열→`undefined` 정규화와 `rangeInstant`의 `undefined` 반환이 이미 같은 결론을 낸다).
- 비교는 `from`·`to` **둘 다** 본다(한쪽만 비교하면 to만 바뀐 클릭이 잘못 분기된다).
- 값이 바뀌었으면 `setDistributedRange(...)`만 호출한다(재조회는 effect). 같으면 `setDistributedRange(...)` 호출 여부와 무관하게 `refresh()`를 호출한다(같은 값 재설정은 컨트롤러 원시값 상태라 리렌더/재구독을 유발하지 않는다 — `useViewController.test.jsx` L623이 잠근 성질이다).
- 부서 바의 `조회` 버튼(`onClick={() => refresh()}`)과 메뉴 전환·부서 변경 트리거는 **건드리지 마라**.

## TDD — 테스트 먼저

`web/src/view/ListPage.test.jsx` 753~871행 묶음에 케이스를 **추가**한다(기존 케이스 수정 금지).

1. **중복 제거(핵심)**: 입력을 채우고 '배부시간 조회'를 1회 클릭 → 조회가 정착한 뒤(예: `waitFor` + 짧은 settle) `queryArticles` 스파이에서
   - 범위 키가 **없는** 필터(`{ status:['RDS','DDH'] }`)로의 호출이 **0건**이고,
   - 새 필터(`distributedAtFrom`/`To` 포함)로의 호출이 1건이며,
   - 스파이 설치 이후 **총 호출 수가 1건**이다.
2. **to만 변경**: 시작은 그대로 두고 종료만 바꿔 클릭해도 1건이고 인자에 새 `distributedAtTo`가 실린다(양쪽 비교 잠금).
3. **해제 경로**: 값이 실린 상태에서 입력을 비우고 클릭 → 두 키가 빠진 필터로 1건(이전 필터로의 중복 없음).
4. **동일값 재조회 보장**: 같은 값으로 다시 클릭하면 재조회가 1건 일어난다(L849 케이스와 같은 의미 — 신규 케이스는 '정확히 1건'까지 단언).
5. **연속 변경**: 서로 다른 값으로 2회 클릭 → 각 클릭당 1건, 마지막 호출 인자가 최신 범위다.
6. **메뉴 전환 회귀**: 범위를 적용한 뒤 메뉴를 바꾸면 새 메뉴 필터 + 범위가 실린 조회가 일어나고(컨트롤러 유지 계약), 그 뒤 같은 값으로 클릭하면 다시 1건이다.
7. 기존 케이스(L777·L788·L801·L816·L831·L849·L862)와 컬럼 관련 케이스가 **무수정 green**.

## 작업

`web/src/view/ListPage.jsx`만 수정한다.

- `useRef`를 import 목록에 추가(이미 있으면 그대로).
- `applyDistributedRange`를 위 배경의 규칙대로 재작성하고, 주석에 "왜 값이 바뀔 때 `refresh()`를 부르지 않는가"(이전 filter 클로저 중복 요청)와 "왜 같은 값일 때는 부르는가"(조회 버튼의 재조회 보장)를 각각 한 줄로 남긴다.
- 79~81행의 기존 주석 중 사실과 어긋나게 되는 문장("값이 바뀌지 않았을 때도 사용자가 기대하는 재조회가 일어나게 refresh()를 동반한다" 계열)을 새 동작에 맞게 고쳐라.
- 마크업(라벨 텍스트·`data-testid`·버튼 접근 이름)·컬럼 렌더·다른 핸들러는 무수정이다.

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — 기준선 2361(90 files) + 신규 케이스(6건 이상)
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `web/src/view/ListPage.jsx`, `web/src/view/ListPage.test.jsx` **2개**(+ 진행 기록 `phases/58-backlog-perf/index.json`)뿐.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `web/src/controller/useViewController.test.jsx`가 **무수정 green**인지 확인하라(컨트롤러 계약 불변의 증거다).
2. 변이 검증 3종(확인 후 원복):
   - 값 변경 분기에서도 `refresh()`를 부르게 되돌리면 케이스 1이 red(총 2건 + 이전 필터 호출 1건).
   - 비교를 `from`만으로 좁히면 케이스 2가 red.
   - 값이 같을 때 `refresh()`를 생략하면 케이스 4와 기존 L849가 red.
3. 안정성 확인: `ListPage.test.jsx`를 단독으로 2회 연속 실행해 동일 결과인지 본다(비동기 조회 단언이 들어간 케이스라 flake 여부를 확인한다).
4. 아키텍처 체크리스트:
   - View가 여전히 컨트롤러 훅 경유로만 데이터를 만지는가(직접 fetch·모델 호출 0, ADR-003)?
   - 컨트롤러 파일이 무수정인가?
   - `ref`에 담긴 것이 "이 View가 마지막으로 적용한 입력값"뿐인가(서버 상태 캐시가 아니다)?
5. `phases/58-backlog-perf/index.json`의 step5를 `completed` + `summary`로 갱신한다(분기 규칙·유지한 계약(L849·L623)·조회 횟수 before/after·변이 결과 명시).

## 금지사항

- `useViewController.js`에 nonce/카운터 state를 추가하지 마라. 이유: `refresh` 의존성에 넣으면 `filter` 정체성 변화로 **SSE 재구독이 매 조회마다** 발생하고, 별도 effect로 빼면 값이 바뀐 클릭에서 두 effect가 모두 돌아 지금과 같은 2회 조회가 된다. `useViewController.test.jsx` L623이 `setDistributedRange` 자체에 nonce를 심는 변형도 막고 있다.
- 값이 같을 때의 재조회를 없애지 마라. 이유: '조회' 버튼은 사용자가 최신 목록을 강제로 당기는 수단이며 L849가 그 계약을 잠그고 있다.
- 입력 `onChange`에서 컨트롤러 상태를 갱신하지 마라(타이핑마다 반영). 이유: 필터 정체성이 매 글자마다 바뀌어 재조회·SSE 재구독이 폭주한다(L777이 잠근다).
- `setTimeout`·디바운스·폴링을 도입하지 마라. 이유: 화면에 타이머 기반 재조회를 들이는 순간 SSE 무효화 모델(ADR-005)과 이중 트리거가 되고, 테스트 결정성이 깨진다.
- `rangeInstant` 대신 화면에서 ISO 문자열을 직접 조립하지 마라. 이유: 값 변환의 단일 출처가 `listFormat`이며 경계값(`:59.999Z`) 규약이 두 곳으로 갈라진다.
- 다른 조회 트리거(부서 바 `조회` 버튼·메뉴 전환·부서 변경·SSE 무효화)의 동작을 바꾸지 마라. 이유: 이 step의 범위는 배부시간 조회 클릭 1개다.
- `web/src/model/**`·`src/**`(백엔드)를 수정하지 마라. 이유: 서버 계약은 이 항목과 무관하다.
- `docs/**`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
