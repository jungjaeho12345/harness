# Step 1: history-model

## 목표

`src/models/articleHistoryModel.js`에 **스냅샷 본문만 뽑는 조회 메서드를 additive로 추가**한다. 제목 파생(step2 서비스)이 이력 행마다 `markupVersion`을 필요로 하는데, 기존 `queryByArticle`은 의도적으로 blob을 빼고 `hasSnapshot`만 준다 — 그 계약을 **바꾸지 않고** 별도 메서드로 얻는다.

이 step은 모델 계층 한 파일만 다룬다. 서비스 결선·응답 shape 변경은 step2 소관이다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md` — 백엔드 계층(모델 = 직접 SQL, 비즈니스 규칙 없음), DB 비파괴.
- `docs/ADR.md` ADR-002(`node:sqlite` 직접 SQL, ORM 없음)·ADR-006. **읽기 전용(무접촉)**.
- `src/models/articleHistoryModel.js` — 전체(46줄). 특히
  - L26~34 `queryByArticle(articleId)`: `SELECT id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, CASE WHEN markupVersion IS NOT NULL AND markupVersion != '' THEN 1 ELSE 0 END AS hasSnapshot … ORDER BY id DESC`. 주석에 "본문 스냅샷은 SELECT하지 않고 존재 여부만 파생한다 — /history는 경량 목록"이라고 못 박혀 있다.
  - L36~43 `querySnapshotById(articleId, id)`: **반드시 `articleId`로 스코프**해 타 기사 스냅샷 유출을 막는 선례.
  - L45 `return { insert, queryByArticle, querySnapshotById };`
- `test/articleHistoryModel.test.js` — 특히 L74~91 "queryByArticle는 markupVersion 대신 hasSnapshot 플래그만 반환한다(목록 경량)"와 L111~115 "행 삭제 함수를 노출하지 않는다(DB 비파괴)". **이 두 테스트는 무수정으로 green이어야 한다.**
- 참고(수정 금지, 왜 `queryByArticle`을 안 건드리는지의 근거):
  - `src/services/articleService.js` L235 `distributedKinds(historyModel.queryByArticle(articleId))`, L267 `const history = historyModel ? historyModel.queryByArticle(articleId) : []` — 엠바고 배부 판정 입력.
  - `src/services/distributionTickService.js` L73~74 `cycleDistributedKinds({ status, historyRows: historyModel.queryByArticle(articleId) })` — tick 멱등 판정 입력(ADR-008). 여기에 본문 blob 로딩을 끼워 넣으면 안 된다.

## 배경 (자기완결)

`queryByArticle`은 **이력보기 목록 + 배부 멱등 판정** 두 소비처가 공유하는 hot path다. 여기에 `markupVersion`을 추가하면 (1) 기존 모델 테스트의 명시 계약이 깨지고, (2) tick이 기사마다 모든 편집 본문을 메모리로 읽는다. 그래서 **스냅샷 보유 행만, 필요한 두 컬럼만** 따로 읽는 메서드를 추가한다(additive — 기존 호출부 무영향).

## TDD — 테스트 먼저

`test/articleHistoryModel.test.js`에 케이스를 **추가**한다(기존 케이스 수정 금지). 기존 `setup()` 헬퍼를 그대로 쓴다.

1. `querySnapshotsByArticle(articleId)`가 **스냅샷 보유 행만** 반환한다: edit(스냅샷 있음) 2건 + status(스냅샷 없음) 1건을 넣으면 결과 길이는 2이고, 각 원소는 `{ id, markupVersion }`이며 `markupVersion` 문자열이 그대로다.
2. `markupVersion`이 빈 문자열(`''`)인 행은 제외된다(`hasSnapshot` 판정 기준과 동일 — `IS NOT NULL AND != ''`).
3. 다른 기사(`AKR2`)의 스냅샷은 섞이지 않는다.
4. 이력이 없거나 스냅샷이 하나도 없으면 **빈 배열**을 반환한다(throw·`undefined` 금지).
5. 반환 순서는 `id DESC`로 결정적이다(같은 입력에 항상 같은 순서).
6. 회귀: `queryByArticle`은 여전히 `markupVersion`을 싣지 않고 `hasSnapshot`만 준다(기존 L74~91 케이스가 무수정 green이어야 한다 — 새 케이스로 중복 단언하지 말고 기존 케이스 통과로 확인).
7. 회귀: 모델에 삭제 함수가 없다(기존 케이스 green 유지).

## 작업

`src/models/articleHistoryModel.js`에 함수 1개를 추가하고 반환 객체에 노출한다.

```js
// 스냅샷 보유 이력의 본문만 별도 조회 — 이력 목록의 '제목' 파생(서비스)용.
// queryByArticle은 경량 계약(blob 미포함)을 유지해야 하고, 그 결과는 배부 멱등 판정도 공유하므로
// blob 로딩을 그 경로에 끼워 넣지 않는다.
function querySnapshotsByArticle(articleId) {} // → [{ id, markupVersion }] (id DESC)
```

규칙:
1. SQL은 `SELECT id, markupVersion FROM ArticleHistory WHERE articleId = ? AND markupVersion IS NOT NULL AND markupVersion != '' ORDER BY id DESC` 형태로, **파라미터 바인딩(`?`)만** 쓴다(문자열 결합 금지 — SQL 인젝션 표면).
2. `queryByArticle`·`querySnapshotById`·`insert`의 SQL·시그니처·주석 의도를 **변경하지 마라**.
3. 비즈니스 규칙(제목 파싱·필터·버전 계산)을 모델에 넣지 마라 — 모델은 직접 SQL만(ADR-006).
4. 반환 객체에 `querySnapshotsByArticle`를 추가하되 기존 키 3개는 그대로 둔다.
5. 새 파일 상단 주석 규칙을 유지한다(왜 별도 조회인지 한 줄 근거).

## Acceptance Criteria

```bash
npm test          # 실패 0 — step0 종료 시점 개수 + 이번 신규 케이스
npm run lint      # 통과
```

**diff scope**: step을 시작하기 전에 `git status --porcelain`을 찍어 스냅샷으로 남겨라. 종료 시점의 `git status --porcelain`이 그 스냅샷과 **다른 부분**은 `src/models/articleHistoryModel.js`, `test/articleHistoryModel.test.js` **2개뿐**이어야 한다(절대 목록 비교 금지 — 트리에 사용자 소유 미커밋 파일이 이미 있다).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 2종(확인 후 원복):
   - `WHERE`에서 `AND markupVersion IS NOT NULL AND markupVersion != ''`를 지우면 케이스 1·2가 red.
   - `AND articleId = ?`를 지우면 케이스 3이 red.
3. 아키텍처 체크리스트:
   - 모델에 도메인 분기(제목/버전/필터)가 없는가?
   - 행 삭제(DELETE/UPDATE) SQL이 추가되지 않았는가(DB 비파괴 — 이 파일은 SELECT/INSERT만)?
   - `src/services/**`·`server/**`·`web/**`를 건드리지 않았는가?
4. `phases/56-history-view-columns/index.json`의 step1을 `completed` + `summary`로 갱신한다. summary에 새 메서드의 시그니처·반환 shape·필터 조건·정렬을 명시하라.

## 금지사항

- `queryByArticle`의 SELECT에 `markupVersion`을 추가하지 마라. 이유: 모델 테스트가 못 박은 경량 계약이 깨지고, 같은 함수를 쓰는 tick 멱등 판정(ADR-008)·엠바고 배부 판정이 기사마다 모든 편집 본문을 메모리로 읽게 된다.
- 새 인덱스·새 테이블·`ALTER`를 추가하지 마라. 이유: 이 phase는 스키마 변경 0이고(SCHEMA.md "인덱스는 PK 자동 인덱스만"), 성능 문제는 관측되지 않았다.
- `DELETE`/`UPDATE` 문을 이 파일에 넣지 마라. 이유: ArticleHistory는 append-only이며 DB 비파괴 원칙의 핵심 대상이다.
- 제목을 SQL에서 파싱하려 하지 마라(`substr`/`json_extract` 등). 이유: 본문은 블록 JSON과 레거시 평문이 섞여 있어 SQL 파싱이 취약하고, 파싱 규칙은 프론트 `bodyTitle`과 동형이어야 하므로 순수 JS 모듈(step0)이 단일 출처다.
- `docs/news.md`·`docs/ADR.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 이번 phase 무접촉 대상이며, `docs/news.md`는 사용자 소유의 미커밋 편집분(이 phase의 입력 스펙)이다.
- `git add -A`/`git add .`로 스테이징하지 마라 — 반드시 이번 step이 만진 파일만 명시 경로로 `git add` 하라. 이유: 작업 트리에 사용자 소유 미커밋 파일(`docs/news.md` 등)이 이미 있어, 통짜 add는 그것들을 커밋에 끌어들인다.
- 미커밋 사용자 파일(`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)을 `git restore`/`git checkout --`/`git stash`/`git clean`으로 되돌리거나 치우지 마라. 이유: 이 phase의 유일한 스펙 원문이 소실된다.
