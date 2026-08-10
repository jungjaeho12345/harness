# Step 9: list-column-catalog

## 목표

기사 목록(list.do)의 **순수 뷰 모듈** 2개를 배부시간 지원에 맞춰 확장한다.

1. `web/src/view/columnConfig.js` — `distributedAt`(배부시간) 컬럼을 카탈로그에 추가하되 **기본 숨김**으로 둔다(`defaultVisible` 플래그 도입).
2. `web/src/view/listFormat.js` — `distributedAt` 셀의 날짜 포맷 + 조회조건 입력값(`datetime-local`) → ISO 범위 값 합성 헬퍼.

순수 모듈만 다룬다(React·DOM 비의존). ListPage 결선은 step11이다.

## 읽어야 할 파일

- `docs/news.md` **100행** — "4개 메뉴 모두 기사 목록의 컬럼은 기사아이디, 제목, 작성자, 수정자, 작성시간, 수정시간, 기사상태, LockYN만 표현한다"(기본 컬럼 스펙 — 그래서 신규 컬럼은 기본 숨김이다). **읽기 전용(무접촉, 사용자 소유 미커밋 파일)**.
- `docs/news.md` **12행** — "기사를 조회하는 함수에서는 배부시간을 조건으로 기사를 조회할 수 있다"(조회조건의 스펙 근거).
- `docs/SCHEMA.md` L45~49 — `distributedAt`은 ISO-8601 UTC 문자열이고 배부 실행마다 최신으로 갱신된다.
- `web/src/view/columnConfig.js` 전체(72줄) — `COLUMNS`, `defaultColumnConfig`(현재 전 컬럼 true), `loadColumnConfig`(저장값을 기본값 위에 병합 — 새 컬럼은 기본값을 따른다), `toggleColumn`, `visibleColumns`.
- `web/src/view/columnConfig.test.js` 전체(51줄) — 특히 L10~15(컬럼 key 목록 정확 일치)와 L17~22("default config shows every column"). **두 케이스는 이번 변경으로 갱신 대상이다.**
- `web/src/view/listFormat.js` 전체(60줄) — `applyDateFormat`(정규식으로 ISO 자릿수를 추출해 토큰 치환, **타임존 변환 없음**), `formatDateTime`, `formatCell`(시간 컬럼만 포맷), `KST_OFFSET_MS`/`kstIsoString`(다른 용도 — 여기서 쓰지 않는다).
- `web/src/view/listFormat.test.js` — 순수 포맷 테스트 스타일.
- `web/src/view/historyColumns.js` L37~46 — **기본 표시 키 목록으로 기본값을 갈라 두는 선례**(`DEFAULT_VISIBLE_KEYS`). 같은 문제를 이미 푼 방식이니 참고하되, 목록 페이지는 "신규 1개만 숨김"이므로 컬럼 자체에 플래그를 두는 방식이 더 작다.

## 배경 (자기완결)

**왜 기본 숨김인가**: `defaultColumnConfig`가 전 컬럼을 `true`로 만들기 때문에 카탈로그에 그냥 추가하면 모든 메뉴의 목록에 새 컬럼이 즉시 나타난다. news.md 100행의 기본 컬럼 스펙과 어긋나고, `ListPage.test.jsx`의 헤더 정확 일치 단언(케이스10)이 깨진다. 사용자는 헤더 우클릭 '컬럼 설정'에서 켠다.

**시각 표기 규약(중요)**: 이 앱은 저장된 ISO-8601 문자열의 자릿수를 **타임존 변환 없이** 그대로 표시한다(`applyDateFormat`의 정규식 추출). 따라서 조회조건 입력값도 같은 규약으로 합성해야 화면에 보이는 값과 필터 결과가 일치한다.

```
from: 'YYYY-MM-DDTHH:mm' → 'YYYY-MM-DDTHH:mm:00.000Z'
to  : 'YYYY-MM-DDTHH:mm' → 'YYYY-MM-DDTHH:mm:59.999Z'   // 선택한 분의 끝까지 포함
```

서버는 이 문자열을 사전식 비교(`>=` / `<=`)로 쓴다(`articleModel.query` L122~136) — 변환·파싱을 서버에 요구하지 않는다.

## TDD — 테스트 먼저

### `web/src/view/columnConfig.test.js`

1. `COLUMNS`의 key 목록에 `distributedAt`이 `sentAt` **바로 뒤**에 있다(기존 L10~15 단언 갱신 — 시간 컬럼 묶음 유지).
2. `distributedAt`의 label은 `'배부시간'`이다.
3. `defaultColumnConfig()`에서 `visible.distributedAt === false`이고 **나머지 전 컬럼은 true**다(기존 L17~22 단언 갱신 — "신규 1개만 기본 숨김"으로 의미를 좁힌다).
4. `visibleColumns(defaultColumnConfig())`에 `distributedAt`이 없다.
5. `toggleColumn(cfg, 'distributedAt')`으로 켜면 `visibleColumns` 결과에 **카탈로그 정의 순서 위치**(sentAt 뒤)로 들어간다.
6. 영속 회귀: `distributedAt` 키가 없는 **기존 저장값**을 로드하면 `distributedAt`은 기본값(false)이 되고 다른 컬럼 설정은 보존된다(`loadColumnConfig` 병합).
7. 켠 상태를 저장하고 다시 로드하면 유지된다(저장값이 기본값을 이긴다).
8. 다른 메뉴의 설정에는 영향이 없다(기존 케이스 green 유지).

### `web/src/view/listFormat.test.js`

9. `formatCell('distributedAt', '2026-08-06T09:30:00.000Z')`가 현재 날짜형식으로 포맷된다(`createdAt`과 동일 결과).
10. `formatCell('distributedAt', null/undefined/'')` → `''`(기존 시간 컬럼과 동형).
11. `rangeInstant('2026-08-06T09:30', 'from')` → `'2026-08-06T09:30:00.000Z'`.
12. `rangeInstant('2026-08-06T09:30', 'to')` → `'2026-08-06T09:30:59.999Z'`.
13. `rangeInstant('', 'from')`·`rangeInstant(undefined,'to')`·비문자열 → `undefined`(조건 미포함을 뜻한다 — 빈 문자열이나 `null`이 아니라 `undefined`여야 필터에서 빠진다).
14. 초까지 들어온 값(`'2026-08-06T09:30:15'`)도 분 단위로 정규화하거나 그대로 유효한 ISO로 만든다 — 어느 쪽이든 **결과가 유효한 ISO-8601 UTC 문자열**이고 `to`가 `from`보다 크거나 같은 순서 규약을 유지한다(구현 재량, 케이스로 고정하라).
15. 잘못된 형식(`'2026-13-99'`·`'abc'`)은 `undefined`를 돌려준다(서버에 쓰레기 필터를 보내지 않는다).
16. 순수성: 같은 입력에 항상 같은 출력이고 `Date`·시계에 의존하지 않는다(모듈 스코프 날짜형식 설정과 무관 — `setDateFormat` 변경 후에도 결과 동일).

## 작업

### `web/src/view/columnConfig.js`

```js
// 배부시간은 news.md 100행 기본 컬럼 스펙 밖이라 기본 숨김이다 — 컬럼 설정에서 켠다.
{ key: 'distributedAt', label: '배부시간', defaultVisible: false },
```

`defaultColumnConfig`는 플래그를 존중하도록 한 줄만 바꾼다.

```js
for (const c of COLUMNS) visible[c.key] = c.defaultVisible !== false; // 미지정은 표시(기존 동작 보존)
```

`loadColumnConfig`/`saveColumnConfig`/`toggleColumn`/`setGap`/`visibleColumns`는 변경 금지.

### `web/src/view/listFormat.js`

1. `formatCell`의 시간 컬럼 목록에 `'distributedAt'`을 추가한다.
2. 범위 입력 합성 헬퍼를 추가한다.

```js
// 조회조건(datetime-local 'YYYY-MM-DDTHH:mm') → 서버 필터용 ISO-8601 UTC 문자열.
// 표시 규약과 동형이다: 저장 문자열의 자릿수를 그대로 쓰고 타임존 변환을 하지 않는다
// (applyDateFormat과 같은 규약 — 여기서만 KST 변환을 하면 화면 값과 필터 결과가 어긋난다).
// 값이 없거나 형식이 아니면 undefined(=조건 미포함).
export function rangeInstant(value, edge) {} // edge: 'from' | 'to'
```

규칙:

1. `Date` 객체·`Date.parse`로 타임존 변환을 하지 마라(정규식 검증 + 문자열 합성).
2. `edge`가 `'from'`/`'to'` 외의 값이면 `undefined`를 돌려준다(안전 기본값).
3. 순수 유지 — 모듈 스코프 상태(`currentFormat`)에 의존하지 않는다.

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — step8 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `web/src/view/columnConfig.js`, `web/src/view/listFormat.js`, `web/src/view/columnConfig.test.js`, `web/src/view/listFormat.test.js` **4개뿐**.

> `web/src/view/ListPage.test.jsx`의 헤더 정확 일치 케이스(케이스10)는 **기본 숨김이므로 무수정 green**이어야 한다. red가 나면 기본값 플래그가 반영되지 않은 것이다 — ListPage.test.jsx를 고치지 말고 구현을 고쳐라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 3종(확인 후 원복):
   - `defaultVisible: false`를 지우면 케이스 3·4가 red이고 `ListPage.test.jsx` 케이스10도 red가 되는지 확인하라(기본 숨김이 실제로 회귀를 막고 있다는 증거).
   - `defaultColumnConfig`의 플래그 판정을 `!!c.defaultVisible`로 바꾸면 케이스 3(나머지 전부 true)이 red.
   - `rangeInstant`의 `to` 접미사를 `:00.000Z`로 바꾸면 케이스 12가 red.
3. 아키텍처 체크리스트:
   - 두 모듈이 React·DOM·transport에 의존하지 않는가?
   - 시계(`new Date()`)를 새로 도입하지 않았는가?
   - 저장 키(`yh.columnConfig`)와 저장 shape가 그대로인가(기존 사용자 설정 호환)?
4. `phases/57-distribution-mvp4/index.json`의 step9를 `completed` + `summary`로 갱신한다. summary에 컬럼 위치·라벨·기본값 플래그 도입·`rangeInstant` 시그니처와 접미사 규칙·갱신한 기존 단언 2건을 명시하라.

## 금지사항

- `distributedAt`을 기본 표시로 두지 마라. 이유: news.md 100행 기본 컬럼 스펙과 어긋나고 목록 헤더 계약 테스트가 깨진다(사용자가 컬럼 설정에서 켠다).
- 저장 키·저장 shape(`{ [menu]: { visible, gap } }`)를 바꾸지 마라. 이유: 사용자의 기존 localStorage 설정이 통째로 무시된다.
- `rangeInstant`에서 KST 오프셋(`KST_OFFSET_MS`)을 적용하지 마라. 이유: 목록 표시(`applyDateFormat`)는 ISO 자릿수를 그대로 보여준다 — 입력만 9시간 이동하면 "화면에 보이는 시간으로 검색했는데 안 나온다"가 된다.
- 서버 필터 파라미터 이름(`distributedAtFrom`/`distributedAtTo`)을 이 모듈에서 만들지 마라. 이유: 필터 조립은 컨트롤러(step10) 책임이고, 순수 포맷 모듈은 값 변환만 한다.
- `formatCell`의 기존 컬럼 처리·`applyDateFormat`의 토큰 규칙을 바꾸지 마라. 이유: 9종 날짜형식 계약과 전 화면 표시가 묶여 있다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
