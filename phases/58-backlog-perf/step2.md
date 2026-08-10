# Step 2: history-title-service

## 목표

`src/services/articleService.js`에서 이력 제목의 **기록 경로**와 **조회 경로**를 새 컬럼으로 옮긴다.

- 기록: 편집 스냅샷을 이력에 남길 때 `historyMeta.snapshotTitle(markupVersion)`으로 파생한 제목을 함께 저장한다.
- 조회: `queryHistory`가 step0의 **단일 조회 `querySnapshotTitlesByArticle`** 만 읽는다(그 조회가 레거시 행에만 본문을 실어 준다 — 서비스에 2차 blob 조회 경로를 만들지 않는다).

이 파일 1개(+테스트)만 다룬다. HTTP 응답 shape은 **불변**이다.

## 읽어야 할 파일

- `src/services/articleService.js` — 특히 `record(rec)`(113~128행: 이력 insert 단일 관문, 실패를 삼키고 `onHistoryError`로 표면화), `update(articleId, fields)`(147~159행: `record({ eventType:'edit', markupVersion: fields.markupVersion })` — **이 서비스에서 스냅샷을 남기는 유일한 지점**), `queryHistory(articleId, { sendOnly })`(327~355행: 스냅샷 조회 가드 → v1Body 예외 → `decorateHistoryRows` → sendOnly 필터).
- `src/services/historyMeta.js`(step1 완료본) — `snapshotTitle(markupVersion)` export와 `decorateHistoryRows`의 새 입력 계약(`{ id, snapshotTitle? , markupVersion? }`).
- `src/models/articleHistoryModel.js`(step0 완료본) — `insert`의 present-only 컬럼 목록, `querySnapshotTitlesByArticle(articleId) → [{ id, snapshotTitle, markupVersion }]`(신규 행: 제목 + `markupVersion: null` / 레거시 행: `snapshotTitle: null` + 본문), `querySnapshotsByArticle(articleId) → [{ id, markupVersion }]`(이 step 이후 `src` 소비자가 없어지지만 **제거하지 않는다**).
- `test/articleHistoryService.test.js` 전체 — 특히 298~505행(phase 56 파생 케이스 묶음). 아래 3개 케이스의 현재 의미를 반드시 확인하라:
  - 373행 `querySnapshotsByArticle가 없는 부분 스텁이어도 throw 없이 배열을 반환한다(title은 빈 값)`
  - 405행 `querySnapshotsByArticle가 throw해도 이력보기는 죽지 않는다(제목만 빈 값·버전/상태 정확)` ← **이 step이 의미를 이전(갱신)해야 하는 유일한 기존 케이스**
  - 471행 `기사 본문 조회는 스냅샷 0건일 때만 — getById 0회`
- `test/server.test.js` 313~419행(`/history` 응답 계약 3케이스 — 파생 필드·blob 누출 스캔·sendOnly 일치). **무수정 green이어야 한다.**
- `phases/58-backlog-perf/index.json`의 `decisions` (3)·(4)·(5)·(6).

## 배경 (자기완결)

`queryHistory`는 이력보기 1회마다 그 기사의 편집 스냅샷 본문 전량을 읽어 첫 줄만 쓴다(150편집·30KB 기사 실측 29ms/4.5MB, `node:sqlite` 동기 → 이벤트 루프 정지). step0이 저장 자리를, step1이 파생 코어의 입력 계약을 만들었다. 이 step이 실제로 비용을 없앤다.

### 기록 경로

`record(rec)`가 이 서비스의 **모든** 이력 insert가 지나는 단일 관문이다. 여기서 `rec.markupVersion`이 비어 있지 않은 문자열일 때만 `snapshotTitle`을 함께 넘긴다(상태 전이 행은 `markupVersion`이 없으므로 자동으로 NULL). 파생은 기존 `try` 블록 **안에서** 수행해, 어떤 이유로든 실패해도 편집 자체를 깨뜨리지 않고 `onHistoryError`로 표면화되게 한다(현행 격리 정책 유지).

**빈 문자열 주의(필수)**: 파생 결과가 `''`(첫 줄이 공백뿐인 본문)여도 **그대로 저장**한다. `derived || undefined`·`derived || null` 같은 관용 구현은 그 행을 컬럼 NULL로 만들어 **영구 레거시로 오판**하게 하고(이후 이력보기마다 그 행의 본문을 다시 읽는다), 이 phase의 목적을 조용히 갉아먹는다. 스냅샷이 없는 행과 "제목이 빈 스냅샷"은 다른 것이다.

### 조회 경로

```
snapshots = querySnapshotTitlesByArticle(articleId)   // 가드 호출(미구현·throw → [])
decorated = decorateHistoryRows(rows, snapshots, { v1Body })
```

- 조회는 **이 한 번뿐**이다. 항목별 폴백(제목 없으면 그 행의 본문에서 파생)은 step0의 SQL(`CASE`)과 step1의 파생 코어가 이미 처리한다 — 서비스에 분기를 만들지 마라.
- **2차 폴백 금지**: 이 조회가 throw하거나 모델이 부분 스텁이면 제목만 빈 값으로 두고 끝낸다. `querySnapshotsByArticle`로 재시도하지 마라 — 장애 시에 하필 최악 비용(본문 전량 읽기)이 되살아나는 경로를 만들지 않는다(폴백은 1단계뿐).
- **가드 스타일은 현행 그대로**다: `typeof historyModel.X === 'function'` 확인 + `try/catch`로 `[]` 폴백(부분 스텁·조회 실패에도 이력보기는 죽지 않는다).
- v1Body 예외 조건은 **의미를 그대로 유지**한다: 이력 행이 1건 이상이고 스냅샷 항목이 0건일 때만 `articleModel.getById`로 현재 본문을 읽는다(스냅샷 존재 여부의 판단 소스가 blob 조회에서 이 조회로 바뀔 뿐이다).

### 기존 테스트 1건의 의미 이전

405행 케이스는 "제목의 출처가 blob 조회였을 때" 세운 방어 계약이다. 새 설계에서 제목 출처는 컬럼이므로, 실제 모델로 기록한 기사에서는 blob 조회가 throw해도 **제목이 그대로 나온다**(엄격히 개선). 따라서:

- 그 케이스를 **개선 계약으로 갱신**한다: `querySnapshotsByArticle`가 throw해도 `title`·`version`·`status`가 전부 정확하다(blob 조회에 더는 의존하지 않는다).
- **방어 계약 자체는 새 출처로 이전**한다: `querySnapshotTitlesByArticle`가 throw하면 제목만 빈 값이고 버전·상태는 정확하다(신규 케이스).
- 테스트 주석에 "축소가 아니라 등가 이전 + 개선"임을 남긴다.

## TDD — 테스트 먼저

`test/articleHistoryService.test.js`에 케이스를 추가한다(위에 명시한 405행 1건만 갱신, 나머지 기존 케이스는 수정 금지).

1. **기록**: 본문 편집(`update`) 후 직접 SQL(`SELECT snapshotTitle FROM ArticleHistory ...`)로 그 edit 행의 `snapshotTitle`이 저장된 본문의 첫 줄과 같다.
2. **기록 범위**: 메타 전용 편집(`markupVersion` 미포함)과 상태 전이(`applyAction`) 행의 `snapshotTitle`은 `null`이다.
2-1. **빈 제목 잠금(필수)**: 첫 줄이 공백뿐인 본문으로 `update` → 직접 SQL로 그 행의 `snapshotTitle`이 **`null`이 아니라 `''`** 이고, 그 기사의 `queryHistory`에서 그 행의 `title`이 `''`이며 **본문 폴백이 쓰이지 않는다**(모델 조회 결과의 그 항목 `markupVersion`이 `null`, `querySnapshotsByArticle` 호출 0회).
3. **핵심 성능 잠금**: 신규 기록만 있는 기사에서 `queryHistory` 1회 → 모델 래핑 스파이로 `querySnapshotTitlesByArticle` **1회** · `querySnapshotsByArticle` **0회**, 그 조회가 돌려준 항목의 `markupVersion`이 **전부 `null`**(본문이 JS 경계를 넘지 않는다), 제목은 정확하다.
4. **레거시 폴백**: 직접 SQL로 `markupVersion`만 있고 `snapshotTitle`이 NULL인 edit 행을 삽입한 뒤 `queryHistory` → 그 행의 제목이 본문 첫 줄에서 파생된다(여기서도 `querySnapshotsByArticle` 호출은 **0회**다 — 폴백 본문은 단일 조회가 실어 준다).
4-1. 레거시 폴백 본문이 **평문 레거시**(JSON 아님)여도 첫 줄이 제목이고, JSON 접두어(`{"format"...`)가 제목으로 노출되지 않는다(blob 절단 방식 회귀 봉쇄).
5. **혼재**: 레거시 1건 + 신규 1건인 기사에서 두 행 모두 정확한 제목·버전을 받고, 조회 결과에서 **레거시 행에만** `markupVersion`이 실린다(신규 행은 `null`).
6. **방어 이전**: `querySnapshotTitlesByArticle`가 throw하는 조립 → 제목만 `''`, 버전·상태는 정확하고 **`querySnapshotsByArticle`로 재시도하지 않는다**(호출 0회 — 2차 폴백 금지 잠금. 405행 케이스를 본뜬 신규 케이스).
7. **부분 스텁**: 두 조회 함수가 모두 없는 스텁 모델(373행 케이스)에서 throw 없이 `title: ''`·정확한 버전 — **무수정 green**.
8. **기존 405행 케이스 갱신**: `querySnapshotsByArticle`만 throw → 제목이 **유지**된다(신규 기록 경로의 기사이므로 blob이 필요 없다).
9. **절단 규칙**: 200자 초과 제목을 가진 본문을 저장하면 컬럼 값이 `MAX_HISTORY_TITLE_LEN`으로 절단되어 있고 조회 결과도 같다.
10. **응답 shape 불변**: `queryHistory` 반환 행의 키 집합에 `snapshotTitle`·`markupVersion`이 없고, 기존 키(`id`·`articleId`·`eventType`·`action`·`fromStatus`·`toStatus`·`actorUserId`·`createdAt`·`hasSnapshot` + `title`·`version`·`status`)가 전부 있다(494행 케이스와 동형 + 신규 단언).
11. **v1Body 예외 무회귀**: 445·460·471행 케이스가 무수정 green(편집 0회 송고 기사의 v1 제목, 편집 발생 시 v1 구간 제목이 다시 비는 규칙, `getById` 0회 조건).

## 작업

`src/services/articleService.js`만 수정한다.

- import에 `snapshotTitle`을 추가한다(`decorateHistoryRows`와 같은 모듈 — 새 모듈을 만들지 마라).
- `record(rec)`: 스냅샷이 있는 기록에만 파생 제목을 실어 insert한다.

```js
// 편집 스냅샷을 남길 때 표시용 제목을 함께 저장한다(파생 규칙 단일 출처 = historyMeta.snapshotTitle).
// 목적: 이력 조회가 본문을 읽지 않게 하는 것. 스냅샷 없는 행(상태 전이 등)은 컬럼을 싣지 않는다(NULL 유지).
// 파생 결과가 ''여도 그대로 저장한다 — NULL로 바꾸면(|| undefined 류) 그 행이 영구 레거시로 오판되어
// 이력보기마다 본문을 다시 읽는다("스냅샷 없음"과 "제목이 빈 스냅샷"은 다르다).
```

- `queryHistory(articleId, { sendOnly })`: 위 "조회 경로"대로 **조회 1개**로 줄인다(기존 `querySnapshotsByArticle` 호출 제거). `decorateHistoryRows`·`sendOnly` 필터·반환 계약은 무수정이다.
- 새 함수를 export하지 마라(서비스 공개 API 목록 불변). 다른 함수(`update`의 DB 쓰기, `applyAction`, `syncEmbargoStatus`, `getHistorySnapshot`)의 동작을 바꾸지 마라.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step1 종료 시점 개수 + 신규 케이스(12건 이상)
npm run lint      # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `src/services/articleService.js`, `test/articleHistoryService.test.js` **2개**(+ 진행 기록 `phases/58-backlog-perf/index.json`)뿐.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `test/server.test.js`의 `/history` 3케이스(313~419행)와 `test/controllers.test.js`·`test/articleService.test.js`·`test/deriveArticle.test.js`가 **무수정 green**인지 확인하라 — HTTP 응답 shape 불변의 증거다.
2. 변이 검증 4종(확인 후 원복):
   - `record()`의 파생 저장을 제거하면 케이스 1·3이 red.
   - `record()`에서 파생 결과에 `|| undefined`를 붙이면 케이스 2-1이 red(빈 제목의 영구 레거시 오판).
   - 조회를 예전처럼 `querySnapshotsByArticle`로 되돌리면 케이스 3·4가 red.
   - 단일 조회 실패 시 `querySnapshotsByArticle`로 2차 폴백을 넣으면 케이스 6이 red.
3. 실측 확인(코드 변경 없음, 결과만 summary에 기록): 편집 스냅샷이 많은 기사(예: 50편집)를 시드해 `queryHistory` 1회에서 모델이 돌려준 항목 중 `markupVersion`이 non-null인 개수를 센다 — 신규 기록만 있으면 **0**, 레거시가 섞이면 **레거시 행 수와 정확히 같아야** 한다.
4. 아키텍처 체크리스트:
   - 서비스가 HTTP·세션을 모르는가(ADR-006)? 의존성은 여전히 주입인가?
   - 제목 파생 규칙이 이 파일에 복제되지 않았는가(`historyMeta.snapshotTitle` 호출만)?
   - 이력 기록 실패가 편집/전이를 깨뜨리지 않는 격리(try/catch + `onHistoryError`)가 유지되는가?
   - `queryHistory`가 여전히 blob을 응답에 싣지 않는가?
5. `phases/58-backlog-perf/index.json`의 step2를 `completed` + `summary`로 갱신한다(기록 지점·조회 1개로 축소·빈 제목 저장 규칙·갱신한 기존 케이스 1건과 그 사유·본문 전송 건수 실측(신규/혼재)·변이 결과 명시).

## 금지사항

- 레거시 행을 새 컬럼으로 채우는 `UPDATE`(지연 백필·조회 시 write-back 포함)를 넣지 마라. 이유: 이력은 append-only 감사 원장이고 조회 경로는 읽기 전용 계약이다. 백필이 필요하다는 판단이 서면 별도 phase의 명시적 결정으로 하라(전례: `schema.js`의 `backfillEmptyDepartments` — 그것도 별도 결정이었다).
- 파생 결과 `''`를 `null`/`undefined`로 바꿔 저장하지 마라. 이유: 그 행이 영구 레거시가 되어 이력보기마다 본문을 다시 읽는다 — 케이스 2-1이 잠근다.
- `''`를 레거시로 취급해 본문 폴백을 유발하지 마라. 이유: 첫 줄이 공백인 정상 스냅샷마다 본문 읽기가 되살아나 이 phase의 목적이 무력화된다.
- 단일 조회 실패 시 `querySnapshotsByArticle`로 2차 폴백하지 마라. 이유: 장애 상황에서 하필 최악 비용(본문 전량 읽기)이 되살아난다 — 폴백은 1단계(제목만 빈 값)뿐이다.
- 응답 행에 `snapshotTitle`을 실어 프론트가 그걸 쓰게 하지 마라. 이유: `/history` 응답 shape은 이 phase에서 불변이며(계약 3면 동기화가 필요해진다), 표시 값의 단일 출처는 이미 `title`이다.
- `querySnapshotsByArticle`나 `queryByArticle`을 모델에서 제거·변경하지 마라(전자는 이 step 이후 `src` 소비자가 사라지지만 그대로 둔다). 이유: 모델 표면 정리는 이 phase 4건 밖의 별도 백로그이고, 후자는 배부 판정이 공유하는 계약이다(step0이 잠갔다). 소비자 소멸 사실은 index.json summary에 백로그로 기록하라.
- 기존 케이스를 "새 구현에 맞춰" 대량 수정하지 마라. 이유: 이 step에서 의미가 바뀌는 케이스는 405행 1건뿐이며(그것도 개선 방향), 그 외 red는 회귀 신호다.
- 스냅샷 조회 실패 시 예외를 승격시키지 마라. 이유: 이력보기가 통째로 500이 된다 — 현행 계약은 "제목만 비고 목록은 산다"이다.
- `src/services/historyMeta.js`·`src/models/**`·`src/db/schema.js`를 수정하지 마라. 이유: step0·step1이 단독 소유한 파일이다 — 필요가 생기면 계획 이탈이므로 orchestrator에 보고하라.
- `docs/**`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
