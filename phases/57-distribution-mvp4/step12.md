# Step 12: history-distribute-labels

## 목표

이력보기/송고이력보기 모달(phase 56)에서 **배부 계열 이력 행을 사람이 읽을 수 있게** 만든다.

`web/src/view/historyColumns.js`의 `historyCellText`에서 `종류`(eventType)와 `동작`(action) 셀의 배부 어휘에 한글 라벨을 씌운다.

순수 뷰 모듈 1파일만 다룬다.

## 읽어야 할 파일

- `docs/news.md` **114~115행**(이력보기 컬럼 스펙 — phase 56의 근거). **읽기 전용(무접촉, 사용자 소유 미커밋 파일)**.
- `web/src/view/historyColumns.js` 전체(120줄) — `HISTORY_COLUMNS` 카탈로그, `HISTORY_EMPTY`(`'—'`), `text(v)` 헬퍼, `historyCellText(key, row, article)`의 switch 구조와 "이력 그룹 key는 row만, 기사 그룹 key는 article만 읽는다" 규율.
- `web/src/view/historyColumns.test.js` — 특히 `historyCellText('eventType', ROW)`가 `'status'` 원값을 그대로 돌려주는 케이스(L204~205). **이 케이스는 무수정 green이어야 한다.**
- `web/src/view/DistMgmtPage.jsx` L12~13 `KIND_LABEL` — "미지의 값은 원문 그대로 보여준다(서버가 진실이고, 화면이 값을 숨기지 않는다)" 선례.
- `src/services/distributionService.js` L156 — `record({ eventType:'distribute', action: kind })`(kind는 `'press'|'nonpress'`).
- `src/services/distributionFailureLog.js`(step1) — `'distribute-failed'`·`'distribute-retry'` 어휘.
- `web/src/view/ListPage.jsx` L300~316 — 이력 모달이 `historyCellText(c.key, h, historyModal.article)`로 셀을 렌더하는 지점(**이 파일은 이 step에서 수정하지 않는다**).

## 배경 (자기완결)

MVP-4 이후 이력 모달에는 `distribute`(kind 단위 배부) 외에 `distribute-failed`(수신처 단위 실패)·`distribute-retry`(수신처 단위 재전송)가 나타난다. 원시 토큰 그대로는 기자·데스크가 읽을 수 없다.

**라벨 범위(확정)**: 배부 계열 어휘만 한글화한다.

| 셀 | 원값 | 표시 |
| --- | --- | --- |
| 종류(eventType) | `distribute` | 배부 |
| 종류(eventType) | `distribute-failed` | 배부실패 |
| 종류(eventType) | `distribute-retry` | 배부재전송 |
| 동작(action) | `press` (배부 계열 행에서) | 언론사 |
| 동작(action) | `nonpress` (배부 계열 행에서) | 비언론사 |

`status`·`edit`·`send`·`hold`·`kill` 등 기존 어휘는 **원값 그대로** 둔다(기존 테스트 회귀 0, 전체 어휘 한글화는 별도 백로그). 미지의 값도 원값 그대로다(DistMgmtPage `KIND_LABEL` 선례).

**동작 라벨은 행 인지(row-aware)로 적용한다**: `action` 셀은 그 행의 `eventType`이 배부 계열일 때만 kind 라벨을 씌운다. 이유: 다른 이벤트가 나중에 같은 문자열을 쓰면 오역이 된다(정확도 우선).

`targetId`·`reason`은 이 모달에 **표시하지 않는다** — 일반 이력 조회 계약(`queryByArticle`)에 그 컬럼이 실리지 않기 때문이다(step0 결정). 수신처·사유는 Z 전용 배부 대상 관리페이지에서 본다.

## TDD — 테스트 먼저

`web/src/view/historyColumns.test.js`에 케이스를 **추가**한다(기존 케이스 수정 금지).

1. `historyCellText('eventType', { eventType:'distribute' })` → `'배부'`.
2. `historyCellText('eventType', { eventType:'distribute-failed' })` → `'배부실패'`.
3. `historyCellText('eventType', { eventType:'distribute-retry' })` → `'배부재전송'`.
4. `historyCellText('eventType', { eventType:'status' })` → `'status'`(원값 유지 — 기존 케이스와 동형).
5. 미지의 eventType(`'wire'`)은 원값 그대로다.
6. `historyCellText('action', { eventType:'distribute', action:'press' })` → `'언론사'`, `nonpress` → `'비언론사'`.
7. `historyCellText('action', { eventType:'distribute-failed', action:'press' })` → `'언론사'`(실패·재전송 행도 동일).
8. **행 인지 잠금**: `historyCellText('action', { eventType:'status', action:'press' })` → `'press'`(원값 — 배부 계열이 아닐 때는 라벨을 씌우지 않는다).
9. `historyCellText('action', { eventType:'status', action:'send' })` → `'send'`(기존 동작 회귀).
10. 빈 값(`action: null`·`''`)은 배부 계열 행에서도 `HISTORY_EMPTY`(`'—'`)다.
11. `row`가 `undefined`여도 throw하지 않는다(기존 방어 유지).
12. 다른 컬럼(`status`·`transition`·`createdAt`·`version`·기사 그룹)의 동작은 변하지 않는다(기존 케이스 green).

## 작업

`web/src/view/historyColumns.js`만 수정한다.

```js
// 배부 계열 이력 어휘의 표시 라벨(phase 57 MVP-4). 그 외 어휘(status·edit·send…)와 미지의 값은
// 원값을 그대로 보여준다 — 서버가 진실이고 화면이 값을 숨기지 않는다(DistMgmtPage KIND_LABEL 선례).
const DISTRIBUTE_EVENT_LABEL = { distribute: '배부', 'distribute-failed': '배부실패', 'distribute-retry': '배부재전송' };
const DISTRIBUTE_KIND_LABEL = { press: '언론사', nonpress: '비언론사' };
```

규칙:

1. `historyCellText`의 `case 'eventType'`·`case 'action'`만 바꾼다(다른 case·`text()` 헬퍼·카탈로그·영속 함수는 변경 금지).
2. 라벨 조회는 `Object.hasOwn`(또는 `??` 폴백)으로 하되, 프로토타입 체인 키(`toString` 등)가 라벨로 새지 않게 한다(`mgmtMessages`의 규율과 동형).
3. 빈 값 처리는 기존 `text()`를 그대로 통과시킨다(`'—'` 표기 유지).
4. `action` 라벨은 `r.eventType`이 `DISTRIBUTE_EVENT_LABEL`의 키일 때만 적용한다.
5. 카탈로그(`HISTORY_COLUMNS`)에 `targetId`·`reason` 컬럼을 **추가하지 마라**(서버 응답에 없다).

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — step11 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `web/src/view/historyColumns.js`, `web/src/view/historyColumns.test.js` **2개뿐**.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `web/src/view/ListPage.test.jsx`가 **무수정 green**인지 확인하라(이력 모달 기존 케이스는 status/edit 행만 쓴다).
2. 변이 검증 3종(확인 후 원복):
   - `action` 라벨의 eventType 조건을 제거하면 케이스 8이 red.
   - 라벨 미등록 값에 `HISTORY_EMPTY`를 돌려주게 바꾸면 케이스 5가 red.
   - `DISTRIBUTE_EVENT_LABEL`에 `status: '상태변경'`을 추가하면 케이스 4와 기존 케이스가 red(범위 이탈 감지).
3. 아키텍처 체크리스트:
   - 모듈이 여전히 순수한가(React·DOM·transport 비의존)?
   - 이력 그룹 key는 `row`만, 기사 그룹 key는 `article`만 읽는 규율이 유지되는가?
   - 저장 키·카탈로그·기본 표시 5열이 그대로인가?
4. `phases/57-distribution-mvp4/index.json`의 step12를 `completed` + `summary`로 갱신한다. summary에 라벨 맵 2종·행 인지 규칙·원값 유지 범위를 명시하라.
5. 코드 변경은 이 step이 마지막이다 — `npm test` · `npm run test:web` · `npm run lint` · `npm run build` 4종을 모두 실행하고 기준선 대비 증가분을 index.json summary에 기록하라. **phase 마감(문서 반영 + 최종 점검)은 step13이 수행한다.**

## 금지사항

- `status`·`edit`·`send` 등 배부 밖 어휘를 한글화하지 마라. 이유: 이번 phase 범위 밖이고, 기존 이력 테스트·다른 화면(historyView)과의 표기 정합을 별도로 검토해야 한다.
- 미지의 토큰을 `'—'`나 빈 문자열로 바꾸지 마라. 이유: 서버가 새 어휘를 추가했을 때 운영자가 그것을 발견할 단서가 사라진다(mgmtMessages의 "미지 토큰 노출" 규율과 동형).
- `targetId`·`reason`을 이력 모달에 표시하려고 서버 이력 계약(`queryByArticle`)을 넓히지 마라. 이유: 그 응답은 전 사용자에게 열려 있다 — 노출면 확대는 step0에서 명시적으로 거부한 설계다.
- 이력 행을 화면에서 필터링(배부 실패 행 숨김 등)하지 마라. 이유: 이력은 감사 원장이고, 화면이 행을 숨기면 무발송 사실이 사라진다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
