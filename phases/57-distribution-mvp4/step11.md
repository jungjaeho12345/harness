# Step 11: list-filter-view

## 목표

기사 목록 화면(`web/src/view/ListPage.jsx`)에 두 가지를 결선한다.

1. **조회조건 — 배부시간 범위**(시작/종료 입력 + 조회 버튼, 전 메뉴 공통).
2. `distributedAt` 셀을 시간 컬럼으로 렌더(컬럼 설정에서 켰을 때).

View 계층 1파일만 다룬다.

## 읽어야 할 파일

- `docs/news.md` **12행**(배부시간 조회조건)·**78~100행**(기사 조회페이지 — 메뉴·부서 셀렉터·조회 버튼·컬럼). **읽기 전용(무접촉, 사용자 소유 미커밋 파일)**.
- `docs/UI_GUIDE.md` — `yh-` 클래스 규약.
- `web/src/view/ListPage.jsx` 전체(423줄) — 특히
  - L54~85 훅 사용부와 `cols = visibleColumns(colConfig)`.
  - L161~174 `renderCell`(status 배지 + `createdAt`/`editedAt`/`sentAt`의 `yh-col--time` 분기).
  - L176~215 `showDeptSelector`와 부서 바(`yh-dept-bar`) + 기존 '조회' 버튼(`refresh()`).
  - L217~238 목록 테이블(헤더 우클릭 → 컬럼 설정 모달).
- `web/src/controller/useViewController.js`(step10 결과) — `distributedRange`, `setDistributedRange(from, to)`, `refresh`.
- `web/src/view/listFormat.js`(step9 결과) — `formatCell`(distributedAt 포함), `rangeInstant(value, edge)`.
- `web/src/view/columnConfig.js`(step9 결과) — `distributedAt` 카탈로그 항목(기본 숨김).
- `web/src/view/ListPage.test.jsx` — 특히 헤더 정확 일치 케이스(케이스10, L607~627)와 컬럼 설정 모달 조작 패턴. **기존 케이스는 무수정 green이어야 한다.**

## 배경 (자기완결)

- 부서 셀렉터는 5개 메뉴에만 보이지만(`showDeptSelector`), **배부시간 조회조건은 전 메뉴 공통**으로 노출한다(개인별 수정 포함 — news.md 12행은 메뉴를 한정하지 않는다).
- 입력은 `datetime-local` 2개다. 입력값은 **로컬 state**로만 두고, **'조회' 버튼을 눌렀을 때만** 컨트롤러에 반영한다(타이핑마다 재조회·SSE 재구독이 일어나면 안 된다).
- 값 변환은 `rangeInstant(value, 'from'|'to')`가 단일 출처다 — 화면에서 문자열을 직접 이어 붙이지 마라.
- 조회 버튼은 `setDistributedRange(...)` 후 `refresh()`도 함께 부른다(값이 바뀌지 않았을 때도 사용자가 기대하는 재조회가 일어나게).
- 조건 해제(초기화) 경로를 반드시 둔다 — 입력을 비우고 조회하면 `undefined`가 전달돼 조건이 빠진다.

## TDD — 테스트 먼저

`web/src/view/ListPage.test.jsx`에 케이스를 **추가**한다(기존 케이스 수정 금지).

1. 조회조건 바가 전 메뉴에서 보인다(부서 셀렉터가 없는 `personal` 메뉴 포함) — 라벨 '배부시간 시작'/'배부시간 종료'(정확한 문구는 구현 재량이되 `getByLabelText`로 접근 가능해야 한다)와 조회 버튼이 있다.
2. 입력만 하고 조회를 누르지 않으면 `model.queryArticles` 호출 수가 늘지 않는다(타이핑마다 재조회 금지).
3. 시작만 입력하고 조회 → `queryArticles`가 `distributedAtFrom`만 실린 필터로 호출된다(값은 `rangeInstant('…','from')` 결과와 일치, `distributedAtTo` 키 없음).
4. 시작+종료 입력하고 조회 → 두 키가 모두 실리고 `to`는 `:59.999Z`로 끝난다.
5. 입력을 비우고 다시 조회 → 두 키가 모두 빠진 필터로 재조회된다(해제 경로).
6. 조회 버튼을 다시 눌러도(값 동일) 재조회가 일어난다(`refresh()` 동반 호출).
7. 메뉴를 바꿔도 입력값이 화면에 유지된다(step10에서 '유지'로 고정한 계약과 일치 — step10이 '초기화'를 택했다면 그에 맞춰 케이스를 반대로 고정하라).
8. 컬럼 설정 모달에 '배부시간' 체크박스가 있고 **기본 해제** 상태다.
9. 체크하면 목록 헤더에 '배부시간'이 `송고시간` 바로 뒤에 나타난다.
10. 배부시간 셀 값이 날짜형식으로 포맷되고 `yh-col--time` 클래스가 붙는다(다른 시간 컬럼과 동형). 값이 없으면 빈 셀이다.
11. 회귀: 기본 상태의 목록 헤더는 기존 11개 그대로다(기존 케이스10과 중복이지만, 이 step의 변경 후에도 유지됨을 명시적으로 잠근다).
12. 회귀: 부서 셀렉터·기존 조회 버튼·우클릭 컨텍스트 메뉴·이력 모달 케이스가 전부 green이다(무수정).

## 작업

`web/src/view/ListPage.jsx`만 수정한다.

1. 컨트롤러에서 `distributedRange`·`setDistributedRange`를 받는다.
2. 조회조건 바를 메뉴바 아래(부서 바와 별도 행)에 추가한다. 기존 `yh-` 클래스를 재사용하고 새 CSS는 도입하지 않는다(불가피하면 인라인 style — 기존 파일 선례).

```jsx
{/* 조회조건 — 배부시간 범위(news.md 12행). 입력은 로컬 state, 반영은 '조회' 클릭 시에만
    (타이핑마다 필터가 바뀌면 재조회·SSE 재구독이 폭주한다). 값 변환은 listFormat.rangeInstant 단일 출처. */}
```

3. 로컬 state 2개(`fromInput`, `toInput`)를 두고, 조회 클릭 핸들러에서:

```js
setDistributedRange(rangeInstant(fromInput, 'from'), rangeInstant(toInput, 'to'));
refresh();
```

4. `renderCell`의 시간 분기에 `'distributedAt'`을 추가한다(`yh-col--time` 유지).
5. 초기 입력값은 `distributedRange`에서 파생하지 않아도 된다(로컬 state가 진실 — 단, 화면 유지 케이스 7이 통과해야 한다. 컴포넌트가 언마운트되지 않는 메뉴 전환에서는 로컬 state가 그대로 살아 있다).
6. 접근성: 각 input에 `<label htmlFor>`를 붙여 `getByLabelText`로 접근 가능하게 한다(기존 폼 선례).

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — step10 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
npm run build     # 통과
npm test          # 실패 0 (백엔드 무영향)
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `web/src/view/ListPage.jsx`, `web/src/view/ListPage.test.jsx` **2개뿐**(CSS·컨트롤러 무변경).

## 검증 절차

1. 위 AC 커맨드를 **연속 2회** 실행해 개수가 같은지 확인하라(비동기 flake 방지).
2. 변이 검증 3종(확인 후 원복):
   - 입력 `onChange`에서 곧바로 `setDistributedRange`를 부르게 바꾸면 케이스 2가 red.
   - 조회 핸들러에서 `refresh()`를 빼면 케이스 6이 red.
   - `renderCell`의 시간 분기에서 `distributedAt`을 빼면 케이스 10이 red.
3. 아키텍처 체크리스트:
   - View가 `fetch`·필터 키 이름 조립을 하지 않는가(키 이름은 컨트롤러 소유)?
   - 값 변환이 `rangeInstant` 한 곳에서만 일어나는가?
   - 새 CSS 파일·클래스를 만들지 않았는가?
4. `phases/57-distribution-mvp4/index.json`의 step11을 `completed` + `summary`로 갱신한다. summary에 조회조건 바의 위치·라벨·적용 시점(조회 클릭)·해제 경로·`distributedAt` 셀 렌더 규칙을 명시하라.

## 금지사항

- 입력 변경마다 컨트롤러 상태를 갱신하지 마라. 이유: `filter` 정체성이 바뀔 때마다 목록 재조회 + SSE 재구독이 일어난다(타이핑 중 수십 회).
- 화면에서 ISO 문자열을 직접 이어 붙이거나 `new Date(...)`로 변환하지 마라. 이유: 표시 규약(타임존 변환 없음)과 어긋나면 "보이는 시간으로 검색했는데 결과가 없다"가 된다 — 변환 규약은 `rangeInstant`가 단일 출처다.
- `distributedAt` 컬럼을 기본 표시로 바꾸지 마라(여기서 `colConfig`를 강제 조작하는 것 포함). 이유: news.md 100행 기본 컬럼 스펙과 헤더 계약 테스트가 깨진다.
- 조회조건에 '배부 실패만 보기' 같은 서버 미지원 조건을 추가하지 마라. 이유: 서버 필터 화이트리스트에 없는 키는 조용히 버려져 사용자가 잘못된 결과를 신뢰하게 된다.
- 자동 새로고침·폴링을 추가하지 마라. 이유: 실시간 갱신은 SSE 무효화 신호가 단일 경로다(ADR-005)·앱 내 타이머 금지(ADR-008).
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
