# Step 6: history-modal

## 목표

`web/src/view/ListPage.jsx`의 **이력보기/송고이력보기 모달을 카탈로그 기반으로 결선**한다.

1. 기본 5열(수정시간/제목/수정자/상태/버전)로 렌더한다 — 현재의 4열 하드코딩(시각/종류/전이/작성자)을 대체한다.
2. **이력 모달 안에서 우클릭하면 '이력 목록설정' 모달**이 열려 컬럼을 추가/제거할 수 있고, 설정은 **이력 종류별로 즉시 영속**된다.

`docs/news.md` 114~115행 스펙의 마지막 결선 step이다. 순수 모듈(step4)·fake 계약(step5)·서버 파생(step0~3)은 이미 있다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/news.md` 114~115행(스펙 원문), 103행(목록 페이지 헤더 우클릭 컬럼 설정 선례), 111행(빈 필드 `'—'`). **읽기 전용(수정·스테이징 절대 금지)**.
- `docs/ARCHITECTURE.md` — 프론트 MVC(View ← Controller ← Model), 모든 데이터는 컨트롤러 경유.
- `docs/ADR.md` ADR-003. **읽기 전용(무접촉)**.
- `web/src/view/historyColumns.js`(step4 산출물) — `HISTORY_COLUMNS`(17개, 각 원소 `{ key, label, group }`, `group`은 `'history'`|`'article'`), `HISTORY_EMPTY`, `defaultHistoryColumnConfig`, `loadHistoryColumnConfig(kind)`, `saveHistoryColumnConfig(kind, config)`, `toggleHistoryColumn(config, key)`, `visibleHistoryColumns(config)`, **`historyCellText(key, row, article)`**(기사 그룹 key는 세 번째 인자에서 읽는다).
- `web/src/view/ListPage.jsx`
  - L62~68 state 선언부: `ctx` / `colConfig` / `showColModal` / `historyModal` / `translateModal`.
  - L78~83 `showHistory(article, title, sendOnly)` — `loadHistory(article, { sendOnly })` 결과를 `setHistoryModal({ title, items: rows })`.
  - L101~102 컨텍스트 메뉴 분기: `case 'history': showHistory(article, '이력보기', false)` / `case 'sendHistory': showHistory(article, '송고이력보기', true)`.
  - L122~132 `toggleCol`/`changeGap` — **토글 시 state 갱신 + 즉시 저장** 패턴(이력 설정도 같은 패턴을 따른다).
  - L190~195 목록 테이블 헤더의 `onContextMenu={(e) => { e.preventDefault(); setShowColModal(true); }}` — 목록 페이지 컬럼 설정 진입 선례.
  - L230~256 컬럼 설정 모달 마크업(백드롭 + `role="dialog"` + `aria-label` + `stopPropagation` + 체크박스 목록 + 닫기 버튼).
  - **L258~289 이력 모달 — 이번 step의 교체 대상**(시각/종류/전이/작성자 4열 `<thead>`와 `historyModal.items.map` 본문).
- `web/src/view/ListPage.test.jsx`
  - L9~18 `setup(seed, identity)` 헬퍼, L20~23 `rds(n)`, L25 `bodyRows(c)`, L28~30 `beforeEach(localStorage.clear)` / `afterEach(setDateFormat(DEFAULT_DATE_FORMAT))`.
  - **L333~384 기존 이력 테스트 3건** — 단언이 (a) `'2026-06-14 03:09'`(createdAt) · (b) `'김기자'`(actorUserId) · (c) `'이력이 없습니다'` · (d) `queryHistory` spy 인자뿐이다. 기본 5열에 `createdAt`·`actorUserId`가 남으므로 **무수정 green이어야 한다** — 깨진다면 기본 컬럼 매핑이나 모달 구조가 잘못된 것이다(단언을 완화해 맞추지 마라).
  - L470~475 "헤더 우클릭 시 컬럼 설정 모달이 열린다" — **목록 페이지 설정 모달의 `aria-label`은 `'컬럼 설정'`**이다(이력 설정 모달과 이름이 겹치면 안 된다).
  - L162 `await screen.findByTestId('status-badge')` — **단수 조회**다. 이력 모달에서 상태 배지 마크업을 쓰면 배지가 여러 개가 되어 이 계열 조회가 깨질 수 있다(아래 작업 5 참조).
- `web/src/view/statusBadge.js` — 참고용(이 step에서 import하지 않는다).
- `web/src/styles/yonhap.css` L822~840 `.yh-modal__backdrop`(z-index 60) / `.yh-modal`(`min-width:20rem; max-width:90vw`) — 중첩 모달 배치와 넓은 표의 오버플로를 판단하는 기준.

## 배경 (자기완결) — 결선 설계

- **우클릭 진입점은 이력 모달 콘텐츠 영역(`.yh-modal` 컨테이너) 전체**에 둔다. 목록 페이지는 `<thead>`에 달지만, 이력 모달은 **이력이 0건이면 헤더 자체가 렌더되지 않아** 헤더에만 달면 설정을 열 수 없다(모든 컬럼을 꺼도 마찬가지). 컨테이너에 달면 두 막다른 상황에서도 복구 가능하다.
- **설정 모달은 이력 모달의 형제로, 그리고 JSX에서 이력 모달 "뒤(아래)"에 배치**한다(이력 모달 `<div>`의 자식이 아님).
  - 형제여야 하는 이유: 설정 모달 백드롭 클릭이 이력 모달 백드롭으로 **버블링되지 않아** 설정만 닫힌다. 자식으로 넣으면 설정 모달 안의 우클릭이 이력 모달의 `onContextMenu`로 버블링돼 설정 모달이 다시 열리는 잡음도 생긴다.
  - 뒤에 와야 하는 이유: `.yh-modal__backdrop`은 `z-index: 60` **단일 값**이라 형제끼리는 **DOM에서 뒤쪽이 위에 그려진다**. 앞에 두면 설정 모달이 이력 모달 백드롭 아래로 깔려 클릭이 막힌다. **CSS로 z-index를 새로 만들지 말고 DOM 순서로 해결한다.**
- 기사 그룹 컬럼(작성자·부서·작성시간·송고시간)의 값은 **우클릭한 목록 행 객체**에서 온다 — `showHistory(article, …)`가 이미 그 객체를 인자로 받으므로 `historyModal` state에 `article`을 함께 담기만 하면 되고 **추가 조회는 0건**이다.
- **상태 컬럼은 배지가 아니라 텍스트**로 낸다. 배지를 쓰면 (a) 목록 테이블의 `data-testid="status-badge"` 단수 조회와 충돌할 수 있고, (b) 이력 행의 상태는 서버가 파생한 문자열이라 배지 색 규칙(UI_GUIDE 토큰)의 대상이 아니다.
- 컬럼 설정은 **이력 종류(`'history'` | `'sendHistory'`)별**로 저장한다 — 송고이력보기는 전부 status/send 행이라 켜고 싶은 컬럼이 다르다.

## TDD — 테스트 먼저

`web/src/view/ListPage.test.jsx`에 케이스를 **추가**한다. 기존 이력 테스트 3건(L333~384)은 **수정하지 마라**(회귀 canary로 남긴다).

**단언 스코프 규칙(필수)**: 이력 모달이 열린 뒤의 헤더·셀 단언은 반드시 `within(await screen.findByRole('dialog', { name: '이력보기' }))`로 **모달 안으로 스코프**하라. 모달이 열린 상태에서 파일 상단의 `bodyRows(container)` 헬퍼(`container.querySelectorAll('tbody tr')`)를 쓰지 마라 — 목록 테이블의 `tbody`와 모달 테이블의 `tbody`가 섞여 개수·텍스트 단언이 조용히 잘못된 대상을 검사한다. 헤더도 마찬가지로 모달 스코프 안에서 `getAllByRole('columnheader')`로 읽어라.

시드 예시(서버가 주는 shape 그대로):
```js
histories: { AKR9: [
  { id: 3, articleId:'AKR9', eventType:'status', action:'send', fromStatus:'RDS', toStatus:'DPS',
    actorUserId:'김기자', createdAt:'2026-06-14T03:09:06Z', hasSnapshot:0,
    title:'헤드라인', version:2, status:'DPS' },
  { id: 2, articleId:'AKR9', eventType:'edit', action:null, actorUserId:'이기자',
    createdAt:'2026-06-14T02:00:00Z', hasSnapshot:1, title:'헤드라인', version:2, status:'RDS' },
] }
```

1. **기본 5열 헤더**: 이력보기를 열면 모달 헤더가 정확히 `['수정시간','제목','수정자','상태','버전']`(순서 포함)이다.
2. **기본 5열 값**: 첫 행에 `'2026-06-14 03:09'`, `'헤드라인'`, `'김기자'`, `'DPS'`, `'v2'`가 보인다.
3. **빈 값 표기**: `title:''`·`version` 없음인 행은 해당 셀이 `'—'`다.
4. **우클릭 → 이력 목록설정 열림**: 이력 모달 안에서 `fireEvent.contextMenu`하면 `role="dialog"` `name: '이력 목록설정'`이 나타나고, **이력 모달은 그대로 열려 있다**.
5. **이력 0건에서도 진입 가능**: 이력이 없는 기사에서 열어 `'이력이 없습니다'`가 보이는 상태에서도 우클릭으로 설정 모달이 열린다.
6. **컬럼 추가**: 설정에서 `'종류'`(eventType)를 체크하면 모달 헤더에 `'종류'`가 추가되고 셀에 `'status'`/`'edit'`가 보인다.
7. **컬럼 제거**: 기본 컬럼 `'버전'`을 해제하면 헤더에서 사라진다.
8. **영속(같은 종류)**: 컬럼을 바꾸고 모달을 닫았다가 **다시 이력보기를 열면** 그 설정이 유지된다(`localStorage` 경유).
9. **종류별 분리**: 이력보기에서 켠 컬럼이 **송고이력보기**에는 적용되지 않는다(송고이력보기는 기본 5열).
10. **목록 페이지 컬럼 설정과 격리**: 이력 설정을 바꿔도 목록 테이블의 헤더(기사아이디·제목 …)는 그대로이고, 헤더 우클릭으로 열리는 `'컬럼 설정'` 모달의 체크 상태도 영향받지 않는다.
11. **설정 모달 닫기 격리**: 설정 모달의 백드롭(또는 닫기 버튼)을 누르면 **설정 모달만** 닫히고 이력 모달은 남는다.
12. **이력 모달 닫기**: 이력 모달을 닫으면 설정 모달도 함께 사라진다(설정 모달을 열어 둔 채 이력 모달을 닫는 시나리오 — 고아 모달 금지).
13. **모든 컬럼 해제**: 전부 해제하면 표 대신 안내 문구가 보이고, 그 상태에서도 우클릭으로 설정을 다시 열 수 있다(막다른 골목 없음).
14. **송고이력보기 회귀**: `sendOnly: true`로 조회하는 기존 동작이 유지된다(기존 케이스 green + 새 모달에서도 제목/버전이 렌더된다).
15. **기사 그룹 컬럼**: 목록 시드 기사에 `author:'kim', department:'정치', createdAt, sentAt`를 넣고 설정에서 `'작성자'`·`'작성시간'`을 켜면, 모달의 모든 이력 행에 그 값이 표시된다. 그리고 이 과정에서 `model.queryArticles`/`getArticle` 등 **추가 조회가 발생하지 않는다**(spy 호출 횟수 불변 — 목록 행 객체 재사용).
16. **중첩 표시 순서(DOM)**: 설정 모달이 열렸을 때, 문서 순서상 설정 모달 백드롭이 이력 모달 백드롭보다 **뒤**에 있다(같은 z-index에서 위에 그려진다). `container.querySelectorAll('.yh-modal__backdrop')`의 마지막 원소가 설정 다이얼로그를 포함하는지로 단언하라.

## 작업

`web/src/view/ListPage.jsx`만 수정한다(테스트 파일 제외).

1. `historyColumns.js`에서 필요한 export를 import한다. **`formatDateTime` 직접 호출은 이력 모달에서 제거**하고 `historyCellText`로 일원화하라(현재 L277의 `formatDateTime(h.createdAt)`). 그 결과 **L17의 `import { formatDateTime } from './listFormat.js';`도 함께 제거**한다(사용처가 사라진다 — 남기면 lint의 미사용 import에 걸린다). **L10의 `formatCell, setDateFormat` import는 그대로 유지**한다(목록 테이블 경로에서 계속 쓴다).
2. `showHistory(article, title, sendOnly)`가 **이력 종류와 기사 행**을 함께 담게 한다: `setHistoryModal({ title, kind, article, items })`(`kind`는 `'history'` | `'sendHistory'`, `article`은 우클릭한 목록 행 객체 그대로). 컨텍스트 메뉴 분기(L101~102)에서 kind를 넘겨라. 기존 `title` 문자열('이력보기'/'송고이력보기')과 `aria-label`은 **그대로 유지**한다(기존 테스트가 이 이름으로 다이얼로그를 찾는다).
3. state 2개를 추가한다: 이력 컬럼 설정(`loadHistoryColumnConfig(kind)`로 모달을 **열 때** 세팅) + 설정 모달 열림 여부. 토글 핸들러는 `toggleHistoryColumn` → state 갱신 → `saveHistoryColumnConfig(kind, next)`(목록 페이지 `toggleCol`과 동일한 즉시 저장 패턴).
4. 이력 모달 본문을 `visibleHistoryColumns(config)` 기반으로 렌더한다 — `<th>`는 `col.label`, `<td>`는 `historyCellText(col.key, row, historyModal.article)`. 행 `key`는 기존처럼 `h.id ?? i`.
5. **상태 컬럼에 배지 마크업(`data-testid="status-badge"`)을 쓰지 마라** — 텍스트만 낸다(배경 참조).
6. 이력 모달 컨테이너에 `onContextMenu={(e) => { e.preventDefault(); setShowHistoryColModal(true); }}`를 단다. 이력이 0건인 경로에서도 동작해야 하므로 표가 아니라 **컨테이너**에 단다.
7. 이력 목록설정 모달을 **이력 모달의 형제로, JSX에서 이력 모달 바로 뒤에** 렌더한다: 백드롭 + `role="dialog"` + `aria-label="이력 목록설정"` + 내부 `onClick` `stopPropagation` + `HISTORY_COLUMNS` 체크박스 목록 + 닫기 버튼(목록 페이지 컬럼 설정 모달 마크업을 본뜨되 **간격(gap) 입력은 넣지 마라**). 체크박스는 `col.group`으로 묶어 표시해도 좋다(라벨 텍스트는 유지 — 테스트가 라벨로 찾는다).
8. 이력 모달을 닫는 모든 경로(백드롭 클릭·닫기 버튼)에서 설정 모달 열림 state도 `false`로 되돌려라.
9. 표시할 컬럼이 0개면 표 대신 안내 문구를 렌더한다(예: `'표시할 컬럼이 없습니다 — 우클릭 목록설정에서 선택하세요.'`). 문구는 재량이되 테스트와 일치시켜라.
10. **CSS는 변경하지 않는다** — 기존 `.yh-modal`/`.yh-modal__backdrop`/`.yh-table` 클래스를 재사용하고, 중첩 모달의 표시 순서는 **DOM 순서로만** 해결한다(z-index 신설 금지). 컬럼을 많이 켰을 때의 가로 넘침 다듬기는 이번 범위 밖이다(필요하면 후속 phase).

제약:
- 이력 데이터는 계속 `loadHistory`(컨트롤러) → `model.queryHistory` 경유다 — **직접 `fetch`·`model` 직접 호출 금지**(ADR-003).
- 제목·버전·상태를 **뷰에서 계산하지 마라**(서버 파생 값을 표시만 한다).
- in-app 모달이므로 React 자동 이스케이프에 의존한다 — `dangerouslySetInnerHTML`·`window.open`·`document.write`를 쓰지 마라.

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — step5 종료 시점 개수 + 이번 신규 케이스
npm run lint      # 통과
npm run build     # 통과
npm test          # 백엔드 무접촉 — 실패 0
```

**diff scope**: step을 시작하기 전에 `git status --porcelain`을 찍어 스냅샷으로 남겨라. 종료 시점의 `git status --porcelain`이 그 스냅샷과 **다른 부분**은 `web/src/view/ListPage.jsx`, `web/src/view/ListPage.test.jsx` **2개뿐**이어야 한다(작업 10에 따라 CSS는 무변경 — 절대 목록 비교 금지, 트리에 사용자 소유 미커밋 파일이 이미 있다).

## 검증 절차

1. 위 AC 커맨드를 실행한다. **기존 이력 테스트 3건(L333~384)이 무수정 green**인지 명시적으로 확인한다.
2. 변이 검증 5종(확인 후 원복):
   - 기본 컬럼에서 `title`을 빼면 케이스 1·2만 red.
   - `onContextMenu`를 표(`<table>`)로 옮기면 케이스 5·13이 red(0건/0컬럼 진입 불가).
   - 설정 모달을 이력 모달의 **자식**으로 옮기면 케이스 11이 red(백드롭 버블링으로 이력 모달까지 닫힘).
   - 설정 모달 JSX를 이력 모달 **앞**으로 옮기면 케이스 16이 red(DOM 순서 규칙).
   - `saveHistoryColumnConfig` 호출을 지우면 케이스 8만 red(영속).
3. 회귀 눈검사(둘 다):
   - 목록 테이블 헤더 우클릭 → `'컬럼 설정'` 모달이 여전히 열리고, 이력 설정과 서로 간섭하지 않는다(케이스 10).
   - **중첩 표시**: 이력 모달을 연 뒤 우클릭으로 설정 모달을 열었을 때, 설정 모달이 이력 모달 **위에** 보이고 체크박스가 실제로 클릭 가능한지 확인한다(z-index 60 동률에서 DOM 뒤쪽이 위 — 앞에 두면 백드롭에 덮여 조작이 막힌다).
4. 아키텍처 체크리스트:
   - View 계층만 수정했는가(controller/model/backend 무접촉)?
   - 이력 데이터가 `loadHistory` 경유이고 직접 `fetch`가 없는가(ADR-003)?
   - 뷰에서 제목/버전/상태를 계산하지 않는가(서버 파생 표시 전용)?
   - 새 타이머·네트워크 호출·DB 접근이 없는가(ADR-008)?
5. `phases/56-history-view-columns/index.json`의 step6을 `completed` + `summary`로 갱신한다. summary에 (a) 모달 state shape(`{ title, kind, article, items }`)과 설정 로드 시점, (b) 우클릭 진입점 위치와 그 이유, (c) 설정 모달의 `aria-label`·형제 렌더·DOM 순서(이력 모달 뒤) 결정, (d) 기사 그룹 컬럼이 추가 조회 없이 목록 행에서 온다는 사실, (e) CSS 무변경을 명시하라.
6. phase 종료 step이므로, 전체 AC(`npm test` · `npm run test:web` · `npm run lint` · `npm run build`)를 **연속 2회** 돌려 flake가 없는지 확인한다.

## 금지사항

- 기존 이력 테스트 3건의 단언을 완화하거나 삭제하지 마라. 이유: 그 3건은 "기본 컬럼에 수정시간·수정자가 남아 있다 / 빈 이력 안내 / sendOnly 조회"라는 계약의 canary다 — 깨졌다면 구현이 틀린 것이지 테스트가 낡은 게 아니다.
- 이력 모달의 `aria-label`(`'이력보기'`/`'송고이력보기'`)을 바꾸지 마라. 이유: 기존 테스트와 접근성 이름 계약이 그것에 묶여 있다.
- 이력 설정 모달의 `aria-label`을 `'컬럼 설정'`으로 하지 마라. 이유: 목록 페이지 설정 모달과 이름이 겹쳐 `getByRole('dialog', { name: '컬럼 설정' })`가 모호해지고 기존 테스트가 깨진다.
- 설정 모달을 이력 모달의 자식으로 렌더하지 마라. 이유: 백드롭 클릭이 부모 백드롭으로 버블링돼 이력 모달까지 닫히고, 설정 모달 안 우클릭이 부모 `onContextMenu`를 다시 발화시킨다.
- 설정 모달 JSX를 이력 모달보다 **앞에** 두지 마라. 이유: `.yh-modal__backdrop`의 z-index가 60 단일 값이라 형제 중 DOM 앞쪽이 아래로 깔린다 — 설정 모달이 이력 모달 백드롭에 덮여 체크박스를 누를 수 없다.
- 중첩 표시를 위해 CSS(z-index·새 클래스)를 추가하지 마라. 이유: DOM 순서만으로 해결되며, 새 z-index 층은 컨텍스트 메뉴·다른 모달과의 우선순위 규칙을 흐린다.
- 기사 그룹 컬럼 값을 위해 새 조회(`loadDetail`·`model.getArticle`)를 붙이지 마라. 이유: `showHistory(article, …)`가 이미 목록 행 객체를 받는다 — 조회를 붙이면 모달 오픈마다 왕복이 늘고 View가 transport에 가까워진다.
- 상태 컬럼에 `data-testid="status-badge"` 배지를 쓰지 마라. 이유: 목록 테이블 배지를 단수로 찾는 기존 조회(`findByTestId`)가 다중 매치로 깨질 수 있고, 이력 행의 상태는 배지 색 규칙의 대상이 아니다.
- 뷰에서 `markupVersion`을 파싱해 제목을 만들지 마라. 이유: 목록 응답에 blob이 없고(step2·5), 파생 규칙의 단일 출처는 백엔드다 — 프론트에 두 번째 규칙이 생기면 값이 갈라진다.
- 컬럼 간격(gap)·정렬·페이징·CSV 내보내기 같은 스펙 밖 기능을 추가하지 마라. 이유: 스펙은 "기본 5열 + 추가/제거"까지다.
- `web/src/view/historyView.js`·`columnConfig.js`·`useViewController.js`·`server/**`·`src/**`를 수정하지 마라. 이유: 각각 레거시 미사용 파일 / 목록 페이지 소유 / 컨트롤러 계약 유지 / 다른 step의 소유다.
- 모달이 열린 상태에서 `bodyRows(container)` 같은 전역 `tbody` 헬퍼로 단언하지 마라. 이유: 목록 테이블과 모달 테이블의 `tbody`가 섞여 잘못된 대상을 검사하고도 green이 난다 — `within(dialog)`로 스코프하라.
- `docs/news.md`·`docs/ADR.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라. 이유: 이번 phase 무접촉 대상이며, `docs/news.md`는 사용자 소유의 미커밋 편집분(이 phase의 입력 스펙)이다.
- `git add -A`/`git add .`로 스테이징하지 마라 — 반드시 이번 step이 만진 파일만 명시 경로로 `git add` 하라. 이유: 작업 트리에 사용자 소유 미커밋 파일(`docs/news.md` 등)이 이미 있어, 통짜 add는 그것들을 커밋에 끌어들인다.
- 미커밋 사용자 파일(`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)을 `git restore`/`git checkout --`/`git stash`/`git clean`으로 되돌리거나 치우지 마라. 이유: 이 phase의 유일한 스펙 원문이 소실된다.
