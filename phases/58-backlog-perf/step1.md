# Step 1: history-title-core

## 목표

순수 파생 코어 `src/services/historyMeta.js`가 **저장된 파생 제목**(step0의 `snapshotTitle` 컬럼)을 1차 출처로 쓰고, 값이 없는 레거시 행에서만 기존 본문(blob) 파생으로 폴백하도록 `decorateHistoryRows`의 입력 계약을 확장한다.

이 파일 1개만 다룬다(DB·HTTP·서비스 결선 없음).

## 읽어야 할 파일

- `src/services/historyMeta.js` 전체(87줄) — `MAX_HISTORY_TITLE_LEN`, `snapshotTitle(markupVersion)`의 파생 규칙(텍스트 블록만·첫 줄·trim·200자 절단·깨진 JSON은 평문 취급), `decorateHistoryRows(rows, snapshots, { v1Body })`의 버전/상태 승계 알고리즘과 반환 계약(입력과 같은 길이·같은 순서, `markupVersion` 미포함).
- `test/historyMeta.test.js` 전체 — `row(id, over)` 헬퍼, `markup(...blocks)` 헬퍼, 기존 단언 스타일. **기존 케이스는 전부 무수정 green이어야 한다.**
- `src/models/articleHistoryModel.js`의 `querySnapshotTitlesByArticle`(step0 신설) — 이 함수가 돌려주는 `[{ id, snapshotTitle, markupVersion }]`이 새 입력 형태다. **신규 행**은 `snapshotTitle: <제목>` + `markupVersion: null`, **레거시 행**은 `snapshotTitle: null` + `markupVersion: <본문>`이다(행 단위 폴백이 SQL에서 이미 끝나 있다).
- `phases/58-backlog-perf/index.json`의 `decisions` (3)·(4)·(5).

## 배경 (자기완결)

`decorateHistoryRows(rows, snapshots, { v1Body })`의 두 번째 인자는 지금 `[{ id, markupVersion }]` 고정이고, 내부에서 `snapshotTitle(markupVersion)`으로 제목을 파생한다. step0 이후에는 대부분의 행이 **이미 파생된 제목 문자열**을 갖고 있고 본문은 아예 실려 오지 않으므로(신규 행은 `markupVersion: null`), 이 모듈은 두 형태를 모두 받을 수 있어야 한다 — 같은 배열 안에 신규 항목과 레거시 항목이 섞여 온다.

확장 규칙(확정):

- 항목의 `snapshotTitle`이 **문자열이면 그 값을 그대로** 제목으로 쓴다. **재파생 금지** — 저장값은 이미 `snapshotTitle()`의 출력이고, 평문 제목에 그 함수를 다시 적용하면 `'[1,2]'`처럼 JSON으로 파싱되는 제목이 `''`로 파괴된다.
- `''`(빈 문자열)도 유효한 저장값이다(첫 줄이 공백뿐인 스냅샷). 폴백하지 마라.
- `snapshotTitle`이 없거나 `null`/`undefined`/비문자열이면 **레거시**로 보고 같은 항목의 `markupVersion`으로 기존 파생을 수행한다. `markupVersion`도 없으면 `''`.
- 두 필드가 함께 오면 `snapshotTitle`이 이긴다.

반환 계약은 **불변**이다: 입력과 같은 길이·같은 순서, 각 원소는 입력 행 얕은 복사 + `{ title, version, status }`, 그리고 출력 행에는 `markupVersion`도 `snapshotTitle`도 **싣지 않는다**(응답 shape 불변 — 후자는 방어적 제거다. 현재 `queryByArticle`은 그 키를 주지 않는다).

버전 증가·상태 승계·v1Body 예외(`anySnapshot`이 false일 때만 `v1Body`로 v1 구간 제목 파생) 알고리즘은 **한 줄도 바꾸지 마라**.

## TDD — 테스트 먼저

`test/historyMeta.test.js`에 케이스를 **추가**한다(기존 케이스 수정 금지).

1. `snapshots = [{ id: 1, snapshotTitle: '저장된 제목' }]` + `hasSnapshot: 1`인 행 → 그 행의 `title`이 `'저장된 제목'`.
2. `{ id: 1, snapshotTitle: '' }` → `title`은 `''`이고, 같은 항목에 `markupVersion`(제목이 있는 본문)이 함께 있어도 `''`다(폴백하지 않는다).
3. `{ id: 1, snapshotTitle: null, markupVersion: markup(textBlock('레거시 제목'), ...) }` → `title`이 `'레거시 제목'`(레거시 폴백).
4. `{ id: 1, markupVersion: ... }`(키 자체가 없음) → 기존과 동일하게 본문에서 파생(기존 계약 회귀).
5. **재파생 금지 잠금**: `{ id: 1, snapshotTitle: '[1,2]' }` → `title`이 `'[1,2]'` 그대로다(`snapshotTitle()`을 다시 적용하면 `''`가 된다).
6. `snapshotTitle`이 비문자열(숫자·객체·배열)이면 무시하고 `markupVersion` 폴백, 그것도 없으면 `''`(throw 금지).
7. 레거시 행과 신규 행이 섞인 입력에서 각 행이 자기 출처로 정확한 제목을 받는다(버전 증가·상태 승계도 그대로).
8. 출력 행에 `markupVersion`도 `snapshotTitle`도 없다 — 입력 `rows`의 원소가 그 두 키를 갖고 있어도 제거된다.
9. `v1Body` 예외 무회귀: 스냅샷 0건이면 `v1Body`에서 v1 제목을 파생하고, 스냅샷이 1건이라도 있으면 무시한다(기존 케이스와 동형으로 신규 입력 형태에서도 확인).

## 작업

`src/services/historyMeta.js`만 수정한다.

- `snapshots` 파라미터의 항목 계약을 `{ id, snapshotTitle? , markupVersion? }`로 넓힌다. 내부 맵을 값 하나(`markupVersion`) 대신 항목 객체 또는 파생된 제목 문자열로 들고 가도 좋다 — 구현 방식은 재량이되, 아래 규칙은 반드시 지킨다.

```js
// 제목 결정 규칙(단일 지점): 저장된 파생 제목이 문자열이면 그대로 쓰고(재파생 금지 — 평문 제목에
// snapshotTitle()을 다시 적용하면 JSON처럼 보이는 제목이 파괴된다), 그렇지 않을 때만 markupVersion에서 파생한다.
// 규칙 드리프트(의도된 대가): 아래 파생 규칙을 바꿔도 이미 저장된 행은 옛 규칙의 값을 유지한다
// (재파생·백필이 없다) — 규칙을 바꾸면 같은 목록 안에서 행마다 다른 규칙의 제목이 보일 수 있다.
```

- 주석(파일 상단 모듈 설명 + `decorateHistoryRows` 위 계약 주석)을 새 입력 형태에 맞게 갱신한다. "ArticleHistory에는 제목 저장 컬럼이 없다"는 현재 상단 주석은 **사실이 아니게 되므로 반드시 고쳐라**. 위 "규칙 드리프트" 한 줄도 `snapshotTitle()` 함수 위에 남긴다(같은 문장이 `docs/SCHEMA.md`에도 들어간다 — step0).
- `snapshotTitle(markupVersion)` 함수 자체의 파생 규칙(블록 필터·첫 줄·trim·200자 절단)은 무수정이다. export도 유지한다(step2가 기록 시점에 이 함수를 호출한다).
- 출력에서 `delete out.markupVersion`에 더해 `snapshotTitle` 키도 제거한다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step0 종료 시점 개수 + 신규 케이스(9건 이상)
npm run lint      # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `src/services/historyMeta.js`, `test/historyMeta.test.js` **2개**(+ 진행 기록 `phases/58-backlog-perf/index.json`)뿐.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `test/articleHistoryService.test.js`·`test/server.test.js`가 **무수정 green**인지 확인하라(서비스는 아직 `[{ id, markupVersion }]`을 넘기고 있으므로 하위 호환이 유지되어야 한다 — 이것이 이 step의 하위 호환 증거다).
2. 변이 검증 3종(확인 후 원복):
   - 문자열 판정(`typeof === 'string'`)을 truthy 판정으로 바꾸면 케이스 2가 red.
   - 저장된 제목에 `snapshotTitle()`을 재적용하면 케이스 5가 red.
   - 레거시 폴백 분기를 제거하면 케이스 3·4와 기존 케이스가 red.
3. 아키텍처 체크리스트:
   - 모듈이 여전히 순수한가(DB·HTTP·`Date`·랜덤·전역 비의존, import 0)?
   - 입력 배열을 변형하지 않는가(`rows`·`snapshots` 불변)?
   - 반환 순서·길이·`{ title, version, status }` 키 계약이 그대로인가?
4. `phases/58-backlog-perf/index.json`의 step1을 `completed` + `summary`로 갱신한다(제목 결정 규칙·재파생 금지 근거·출력 제거 키·테스트 증가분·변이 결과 명시).

## 금지사항

- 저장된 제목에 `snapshotTitle()`이나 `slice`/`trim` 같은 정규화를 다시 적용하지 마라. 이유: 저장값은 이미 그 규칙의 출력이며, 재적용은 JSON으로 파싱되는 제목(`'[1,2]'`·`'{"blocks":[]}'`)을 빈 문자열로 파괴한다.
- `''`를 "값 없음"으로 취급해 폴백하지 마라. 이유: 첫 줄이 공백인 스냅샷의 정당한 제목이 blob 재파싱을 유발해 이 phase의 목적(blob 읽기 제거)이 무력화된다.
- 버전 증가 규칙(`hasSnapshot` 플래그 기준)·상태 승계/역승계·`v1Body` 예외를 건드리지 마라. 이유: phase 56이 그 알고리즘을 케이스로 잠갔고, 이번 변경은 제목 **출처**만 바꾸는 것이다.
- 이 모듈에서 DB를 조회하거나 모델을 import하지 마라. 이유: 순수 코어 계약(테스트 결정성)이 깨진다 — 조회는 step2(서비스) 책임이다.
- `src/services/articleService.js`를 수정하지 마라. 이유: 그 파일은 step2가 단독 소유한다(같은 파일을 두 step이 만지면 diff scope 판정이 무너진다).
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`·`docs/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
