# Step 4: history-columns

## 목표

이력보기 모달의 **컬럼 카탈로그 + 표시/숨김 영속 + 셀 텍스트 변환**을 담는 순수 뷰 모듈 `web/src/view/historyColumns.js`를 신설한다. React·DOM·`model`/`fetch` 비의존이며, 저장소는 `localStorage`뿐이다. ListPage 결선은 step6 소관이다.

스펙(`docs/news.md` 114~115행): "이력보기를 누르면 **수정시간/제목/수정자/상태/버전**을 기본값으로 보여주고, 우클릭하여 **목록설정**에서 다른 기사의 메타데이터들을 **추가 및 제거**할 수 있다."

## 읽어야 할 파일

- `docs/news.md` 114~115행(스펙 원문) + 103행(목록 페이지의 "헤더 우클릭 컬럼 설정, 설정은 메뉴별로 저장") + 111행("빈 필드는 '—'로 표시"). **읽기 전용(수정·스테이징 절대 금지)**.
- `docs/ARCHITECTURE.md` — 프론트엔드 MVC(View는 순수 함수/컴포넌트), 클라이언트 로컬 상태.
- `docs/ADR.md` ADR-003. **읽기 전용(무접촉)**.
- `web/src/view/columnConfig.js` — **이 모듈이 따라야 할 선례 전체**(73줄): `COLUMNS` freeze 카탈로그, `defaultColumnConfig()`, `readAll()`의 graceful `try/catch`, 메뉴별 `loadColumnConfig`/`saveColumnConfig`(저장값을 기본값 **위에** 병합), `toggleColumn`, `visibleColumns`(정의 순서 유지), `STORAGE_KEY = 'yh.columnConfig'`.
- `web/src/view/columnConfig.test.js` — 테스트 스타일(`beforeEach(() => localStorage.clear())`).
- `web/src/view/listFormat.js` — `formatDateTime(iso)`(module-level 현재 날짜형식 적용), `DATE_FORMATS`/`DEFAULT_DATE_FORMAT`/`setDateFormat`. 시간 컬럼은 이 함수를 재사용한다.
- `web/src/view/ListPage.jsx` L258~289 — **현재 이력 모달의 4열**(시각=`formatDateTime(h.createdAt)` / 종류=`h.eventType ?? h.action` / 전이=`from→to` / 작성자=`h.actorUserId`). 이 4열이 카탈로그에서 **하나도 사라지지 않아야** 한다(기본 표시 여부만 바뀐다).
- `web/src/view/historyView.js` — 예전 "새 창 HTML 렌더" 유틸. **현재 모달 경로에서 쓰이지 않는 레거시**다(참조는 자기 테스트뿐). `EMPTY_FIELD = '—'` 표기 관례만 참고하고 **파일은 건드리지 마라**.
- `web/src/view/statusBadge.js` — 상태 코드 목록(RDS/DPS/RRH/DDH/EEH/RRK/DDK/EEK/DPD/EPS/DES)을 확인용으로만 읽어라(이 모듈에서 배지를 쓰지 않는 이유는 step6 참조).
- 이력 행 shape(step2 이후 서버가 주는 것):
  `{ id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot, title, version, status }`
  - `eventType`: `'edit'` | `'status'` | `'distribute'`
  - `action`: `'send'`/`'hold'`/`'kill'`/`'approveDelete'`/`'embargo'`(status) · `'press'`/`'nonpress'`(distribute) · `null`(edit)
  - `title`/`status`: 값이 없으면 `''`, `version`: 1-base 정수, `hasSnapshot`: 1/0

## 배경 (자기완결) — 카탈로그 결정

스펙의 "다른 **기사의 메타데이터**들"은 두 갈래를 모두 포함한다고 해석한다(오케스트레이터 확정 — index.json `decisions` 참조).

- **이력 그룹**: 이력 행이 갖고 있거나 서버가 파생해 주는 필드(종류·동작·전이·상태·버전 …).
- **기사 그룹**: 우클릭한 **그 기사**의 메타데이터 소수(작성자·부서·작성시간·송고시간). 값은 모든 이력 행에서 동일하게 반복 표시된다 — 그래도 "이 이력이 어느 기사의 것인가"를 한눈에 보게 하는 실사용 가치가 있고, **추가 조회는 0건**이다: `ListPage.showHistory(article, …)`가 이미 목록 행 전체를 인자로 들고 있어서 그 객체를 모달 state에 함께 담기만 하면 된다(step6).

실코드에 없는 필드는 발명하지 않는다 — 레거시 `historyView.js`가 참조하는 `actorRole`은 `ArticleHistory`에 컬럼 자체가 없어 항상 빈 값이므로 **카탈로그에 넣지 않는다**. 기사아이디는 이력 행에도 `articleId`로 들어 있고 값이 동일하므로 **이력 그룹의 `articleId` 하나로만** 둔다(기사 그룹에 중복 추가 금지).

기본 표시 5열은 스펙 고정이고 순서도 스펙 순서를 따른다. 나머지는 기본 숨김이며 사용자가 목록설정에서 켠다.

| key | label | group | 기본 | 값 |
|---|---|---|---|---|
| `createdAt` | 수정시간 | history | 표시 | `formatDateTime(row.createdAt)` |
| `title` | 제목 | history | 표시 | `row.title`(서버 파생) |
| `actorUserId` | 수정자 | history | 표시 | 그대로 |
| `status` | 상태 | history | 표시 | `row.status`(서버 파생 — 그 시점 기사 상태) |
| `version` | 버전 | history | 표시 | `v{n}` |
| `eventType` | 종류 | history | 숨김 | 원값(`edit`/`status`/`distribute`) |
| `action` | 동작 | history | 숨김 | 원값 |
| `transition` | 전이 | history | 숨김 | `from→to`(현재 모달의 전이 열 보존) |
| `fromStatus` | 이전상태 | history | 숨김 | 그대로 |
| `toStatus` | 이후상태 | history | 숨김 | 그대로 |
| `articleId` | 기사아이디 | history | 숨김 | 그대로 |
| `id` | 이력번호 | history | 숨김 | 그대로 |
| `hasSnapshot` | 본문스냅샷 | history | 숨김 | `Y`/`N` |
| `articleAuthor` | 작성자 | article | 숨김 | `article.author` |
| `articleDepartment` | 부서 | article | 숨김 | `article.department` |
| `articleCreatedAt` | 작성시간 | article | 숨김 | `formatDateTime(article.createdAt)` |
| `articleSentAt` | 송고시간 | article | 숨김 | `formatDateTime(article.sentAt)` |

기사 그룹의 key에 `article` 접두어를 붙이는 이유: 이력 행의 `createdAt`(이벤트 시각 = 수정시간)과 기사의 `createdAt`(작성시간)이 **같은 이름 다른 의미**라서 접두어 없이는 충돌한다.

값이 비면 `'—'`로 표시한다(news.md 111행 관례). 설정 스코프는 **이력 종류**(`'history'` = 이력보기 / `'sendHistory'` = 송고이력보기)다 — 두 화면은 성격이 달라(송고이력은 전부 status/send 행) 원하는 컬럼이 다르고, 목록 페이지가 "메뉴별로 저장"하는 선례와 동형이다.

## TDD — 테스트 먼저

`web/src/view/historyColumns.test.js`를 신설한다(Vitest). `beforeEach(() => localStorage.clear())`, 날짜형식을 만지는 케이스는 `afterEach(() => setDateFormat(DEFAULT_DATE_FORMAT))`로 복원하라(ListPage.test.jsx의 누수 방지 관례).

1. `HISTORY_COLUMNS`가 위 17개 key를 **표 순서 그대로** 담고, 각 원소가 `{ key, label, group }`이며 frozen이다(`Object.isFrozen`). `group`은 `'history'` 13개 + `'article'` 4개다.
2. `defaultHistoryColumnConfig()`의 표시 컬럼이 **정확히** `['createdAt','title','actorUserId','status','version']`(순서 포함)이고 나머지는 false다.
3. 저장 없이 `loadHistoryColumnConfig('history')` → 기본값.
4. `saveHistoryColumnConfig('history', cfg)` 후 다시 로드하면 그 설정이 복원된다.
5. **종류별 스코프**: `'history'`에 저장해도 `'sendHistory'`는 기본값이다(그 반대도).
6. **키 격리**: 저장 후 `localStorage.getItem('yh.columnConfig')`(목록 페이지 설정)가 오염되지 않는다 — 사전에 `'yh.columnConfig'`에 값을 심어두고 그대로인지 확인하라.
7. 저장값 병합: 저장된 `visible`에 없는(=나중에 카탈로그에 추가된) 키는 **기본값**을 따른다(기본 숨김 컬럼은 숨김 유지).
8. 손상된 저장값(`'{{{'`, 배열, 문자열, `null`)에서 throw 없이 기본값을 반환한다.
9. `localStorage.setItem`이 throw해도(quota/접근 불가) `saveHistoryColumnConfig`가 예외 없이 설정 객체를 반환한다(graceful no-op — `abbrevStore.test.js` 선례).
10. `toggleHistoryColumn(cfg, 'eventType')`이 **새 객체**를 반환하고 원본을 변형하지 않는다.
11. `visibleHistoryColumns(cfg)`가 카탈로그 정의 순서를 유지하고, 모두 끄면 빈 배열을 반환한다(throw 금지).
12. `historyCellText(key, row, article)`:
    - `createdAt` → `'2026-06-14T03:09:06Z'`가 현재 날짜형식으로(`'2026-06-14 03:09'`) 나오고, 값이 없으면 `'—'`.
    - `version: 3` → `'v3'`, `version` 없음 → `'—'`.
    - `hasSnapshot: 1` → `'Y'`, `0`/없음 → `'N'`.
    - `transition` → `'RDS→DPS'`, 한쪽만 있으면 있는 쪽만 보이고(`'RDS→'` 같은 형태 대신 규칙을 테스트로 고정하라), 둘 다 없으면 `'—'`.
    - `title: ''` → `'—'`, `title: '헤드라인'` → `'헤드라인'`.
    - 알 수 없는 key → `'—'`(throw 금지).
12-1. **기사 그룹 셀**: `article = { author:'kim', department:'정치', createdAt:'2026-06-14T01:00:00Z', sentAt:'2026-06-14T03:09:06Z' }`일 때 `articleAuthor`→`'kim'`, `articleDepartment`→`'정치'`, `articleCreatedAt`→`'2026-06-14 01:00'`, `articleSentAt`→`'2026-06-14 03:09'`.
12-2. **기사 미주입/필드 없음**: 세 번째 인자가 `undefined`이거나 해당 필드가 비면 기사 그룹 셀은 `'—'`이고 throw하지 않는다.
12-3. **키 충돌 없음**: 같은 `row`·`article`에서 `createdAt`(수정시간)과 `articleCreatedAt`(작성시간)이 **서로 다른 값**을 낸다(이력 행 시각 vs 기사 작성 시각).
13. **순수성**: `historyCellText`는 입력 행·기사 객체를 변형하지 않고, 같은 입력에 같은 출력을 낸다.

## 작업

`web/src/view/historyColumns.js`를 신설한다. 시그니처만 고정하고 구현은 재량이다.

```js
export const HISTORY_COLUMNS = Object.freeze([ /* { key, label, group } … 위 표 순서 */ ]);
export const HISTORY_EMPTY = '—';

export function defaultHistoryColumnConfig() {}                 // { visible: { key: bool } }
export function loadHistoryColumnConfig(kind) {}                // kind: 'history' | 'sendHistory'
export function saveHistoryColumnConfig(kind, config) {}        // 저장 후 config 반환
export function toggleHistoryColumn(config, key) {}             // 새 객체
export function visibleHistoryColumns(config) {}                // HISTORY_COLUMNS 순서 유지
export function historyCellText(key, row, article) {}           // 표시 문자열(빈 값은 HISTORY_EMPTY)
```

규칙:
1. `STORAGE_KEY`는 `'yh.historyColumnConfig'` — 목록 페이지의 `'yh.columnConfig'`와 **분리**한다(컬럼 집합도 스코프 의미도 다르다).
2. 저장 shape은 `{ [kind]: { visible: { … } } }`. `columnConfig.js`의 `readAll()` graceful 패턴(`try/catch` → `{}`)과 병합 규칙(`{ ...base.visible, ...saved.visible }`)을 그대로 따른다.
3. **컬럼 간격(gap)은 넣지 마라** — 스펙에 없다(목록 페이지에만 있는 기능).
4. `historyCellText`는 시간 포맷을 직접 구현하지 말고 `listFormat.formatDateTime`을 재사용한다(날짜형식 환경설정이 이력 모달에도 일관되게 적용된다). 세 번째 인자 `article`은 **선택**이며, `group === 'article'`인 key에서만 읽는다(이력 그룹 key는 `row`만 본다 — 두 소스가 섞이면 값 출처를 추적할 수 없다).
5. React/DOM/`document`/`window.open`/`fetch`/`model`을 import하지 마라. `globalThis.localStorage?.` 접근만 허용(선례와 동일).
6. 파일 상단에 이 모듈의 역할·스코프(이력 종류별 영속)·스펙 근거(news.md 114~115행)를 주석으로 남겨라.

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — 기준선 89 files / 2218 + 이번 신규 파일·케이스
npm run lint      # 통과
npm run build     # 통과
npm test          # 백엔드 무접촉 — 실패 0(step3 종료 시점과 동일)
```

**diff scope**: step을 시작하기 전에 `git status --porcelain`을 찍어 스냅샷으로 남겨라. 종료 시점의 `git status --porcelain`이 그 스냅샷과 **다른 부분**은 `web/src/view/historyColumns.js`, `web/src/view/historyColumns.test.js` **2개뿐**이어야 한다(절대 목록 비교 금지 — 트리에 사용자 소유 미커밋 파일이 이미 있다).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 4종(확인 후 원복):
   - 기본 `visible`에서 `version`을 빼면 케이스 2만 red(스펙 5열이 테스트로 잠겼는지).
   - `STORAGE_KEY`를 `'yh.columnConfig'`로 바꾸면 케이스 6이 red(키 격리).
   - `loadHistoryColumnConfig`에서 kind 스코프를 제거하면 케이스 5가 red.
   - 기사 그룹 셀이 `row`를 읽도록 바꾸면 케이스 12-1·12-3이 red(값 출처 분리).
3. 아키텍처 체크리스트:
   - 모듈이 React/DOM/transport에 의존하지 않는가(순수 뷰 로직 — ADR-003)?
   - `columnConfig.js`·`historyView.js`·`ListPage.jsx`를 건드리지 않았는가(결선은 step6)?
   - 서버 상태를 만들지 않았는가(설정은 클라이언트 로컬 전용)?
4. `phases/56-history-view-columns/index.json`의 step4를 `completed` + `summary`로 갱신한다. summary에 (a) 카탈로그 17개 key/label/group과 기본 표시 5개, (b) 저장 키·스코프·병합 규칙, (c) `historyCellText(key, row, article)` 계약과 특수 표기(`v{n}`·`Y/N`·`→`·`—`), (d) 기사 그룹 key 접두어 규칙을 명시하라.

## 금지사항

- `columnConfig.js`(목록 페이지 설정)를 재사용하거나 수정하지 마라. 이유: 컬럼 집합이 완전히 다르고 스코프 키(메뉴 vs 이력 종류)도 다르다 — 합치면 한쪽 카탈로그 변경이 다른 화면의 저장값을 오염시킨다.
- 카탈로그에 **어느 쪽 소스에도 없는** 필드를 넣지 마라(`actorRole` 등). 이유: `ArticleHistory`에도 목록 행에도 값이 없어 항상 `'—'`만 나오는 죽은 컬럼이 된다.
- 기사 그룹을 위해 새 조회(`model.getArticle`·`loadDetail` 등)를 도입하지 마라. 이유: 우클릭한 목록 행 객체가 이미 그 값을 갖고 있다 — 조회를 붙이면 모달 오픈마다 왕복이 늘고 View가 transport에 가까워진다.
- 기사 그룹 key에서 `article` 접두어를 빼지 마라. 이유: `createdAt`(이력 이벤트 시각)과 기사 작성시간이 같은 이름으로 충돌해 설정 저장값과 셀 값이 서로 다른 의미로 섞인다.
- 현재 모달의 4열(시각·종류·전이·작성자) 중 어느 것도 카탈로그에서 빼지 마라. 이유: 오늘 보이던 정보가 설정으로도 복구 불가능해지면 기능 회귀다.
- 컬럼 간격(gap)·정렬·페이징 같은 스펙 밖 기능을 추가하지 마라. 이유: 이 phase 범위는 "기본 5열 + 추가/제거"다 — 표면이 늘면 검증 범위와 회귀 위험만 커진다.
- `web/src/view/historyView.js`를 수정·삭제하지 마라. 이유: 현재 모달 경로가 쓰지 않는 레거시라 이번 변경과 무관하며, 손대면 무관한 테스트 회귀 표면만 생긴다(정리는 별도 phase 소관).
- 설정을 서버에 저장하지 마라(새 API·모델 호출 금지). 이유: 컬럼 표시 여부는 UI 환경설정이며 기존 선례(columnConfig·editorPrefs)가 전부 localStorage다.
- `docs/news.md`·`docs/ADR.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 이번 phase 무접촉 대상이며, `docs/news.md`는 사용자 소유의 미커밋 편집분(이 phase의 입력 스펙)이다.
- `git add -A`/`git add .`로 스테이징하지 마라 — 반드시 이번 step이 만진 파일만 명시 경로로 `git add` 하라. 이유: 작업 트리에 사용자 소유 미커밋 파일(`docs/news.md` 등)이 이미 있어, 통짜 add는 그것들을 커밋에 끌어들인다.
- 미커밋 사용자 파일(`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)을 `git restore`/`git checkout --`/`git stash`/`git clean`으로 되돌리거나 치우지 마라. 이유: 이 phase의 유일한 스펙 원문이 소실된다.
