# Step 3: article-status-read

## 목표

`src/models/articleModel.js`에 **status 한 컬럼만 읽는 경량 조회** `getStatusById(articleId)`를 additive로 신설한다.

배부 실패 목록(step4)이 status 한 필드를 위해 `getById`(Article 전체 + Contents 전체 2쿼리, `markupVersion` blob 포함)를 부르는 N+1을 없애기 위한 사전 작업이다. 모델 1파일만 다룬다.

## 읽어야 할 파일

- `src/models/articleModel.js` 전체(163줄) — `getById`(47~52행: `SELECT * FROM Article` + `SELECT * FROM Contents`), `query`(화이트리스트 필터 + 파라미터 바인딩 규율), `CONTENTS_COLS`, 그리고 "행 삭제 코드는 두지 않는다" 규율.
- `test/articleModel.test.js` — 시드 방식(`insert({ article, contents })`)과 단언 스타일.
- `src/services/distributionRetryService.js` 90~100행 `tickView(articleId)` — 이 함수가 `articleModel.getById(articleId)`에서 `row.contents.status` **하나만** 쓴다(step4가 여기를 고친다. 이 step에서는 읽기만 하라).
- `docs/SCHEMA.md` Contents 절(45~50행) — `status`의 값 집합(RDS·DPS·RRH·RRK·DDH·DDK·DPD·EPS·EEK·EEH·DES).

## 배경 (자기완결)

`distributionRetryService.list()`는 미해소 실패 목록의 distinct 기사마다 `articleModel.getById`를 호출한다. 그 반환값에서 실제로 쓰는 값은 `row.contents.status` 하나뿐인데, `getById`는 `SELECT *`로 **본문 blob(`Article.markupVersion`)까지** 통째로 읽는다. 실패가 여러 기사에 걸치면 조회당 blob 수 MB가 무의미하게 읽힌다.

계약(확정):

```js
// status 한 컬럼만 읽는 경량 조회 — 상태 판정만 필요한 경로(배부 실패 목록 등)가 본문 blob을 읽지 않게 한다.
// 반환: 기사 status 문자열 / 컬럼이 NULL이면 null / Contents 행이 없으면 undefined.
function getStatusById(articleId)
```

- `getById`의 동작·반환 shape은 **불변**이다(잠금 판정·재전송 페이로드 등 다수 경로가 의존한다).
- 이 함수는 Contents만 본다. Article 테이블을 건드리지 마라.
- 비즈니스 규칙(상태 allowlist 판정 등)을 모델에 넣지 마라 — 서비스 책임이다.

## TDD — 테스트 먼저

`test/articleModel.test.js`에 케이스를 **추가**한다(기존 케이스 수정 금지).

1. 시드한 기사의 `getStatusById(articleId)`가 그 기사의 `status` 문자열을 돌려준다.
2. 없는 `articleId`면 `undefined`다.
3. `status`가 NULL인 행(Contents는 있고 status 미지정)에서는 `null`이다(2번과 구분된다).
4. `update(articleId, { contents: { status: 'DPS' } })` 후 값이 즉시 반영된다(캐시 없음).
5. **경량 잠금**: `db.prepare`를 래핑해 `getStatusById` 실행 중 준비된 SQL 문자열을 수집하고, 그 SQL이 `Contents`에서 `status`만 선택하며 `SELECT *`·`Article`·`markupVersion`을 포함하지 않음을 단언한다(정규식 매칭 + 미포함 단언).
6. 회귀: `getById`가 여전히 `{ article, contents }`를 돌려주고 `contents`에 전 컬럼이 있다.

## 작업

`src/models/articleModel.js`만 수정한다.

- `getStatusById(articleId)`를 추가하고 반환 객체(`return { getById, insert, ... }`)에 싣는다. 파라미터 바인딩(`?`)을 쓰고 문자열 결합으로 SQL을 만들지 마라.
- 함수 위에 위 계약 주석(반환 3분기 + 목적)을 남긴다.
- 기존 함수는 전부 무수정이다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step2 종료 시점 개수 + 신규 케이스(6건 이상)
npm run lint      # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `src/models/articleModel.js`, `test/articleModel.test.js` **2개**(+ 진행 기록 `phases/58-backlog-perf/index.json`)뿐.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `test/editLock.test.js`·`test/articleService.test.js`·`test/distributionRetryService.test.js`·`test/distributionTickService.test.js`가 **무수정 green**인지 확인하라.
2. 변이 검증 2종(확인 후 원복):
   - `getStatusById`를 `getById(articleId)?.contents?.status` 위임으로 바꾸면 케이스 5가 red.
   - 없는 기사에서 `null`을 돌려주게 바꾸면 케이스 2가 red(부재와 NULL 구분이 계약이다).
3. 아키텍처 체크리스트:
   - 모델에 비즈니스 규칙이 없는가(SQL과 매핑뿐)?
   - 행 삭제/변경 코드가 새로 생기지 않았는가?
   - 파라미터 바인딩을 썼는가(문자열 결합 SQL 0)?
4. `phases/58-backlog-perf/index.json`의 step3을 `completed` + `summary`로 갱신한다(반환 3분기 계약·SQL 잠금 방식·테스트 증가분·변이 결과 명시).

## 금지사항

- `getById`의 SELECT나 반환 shape을 바꾸지 마라(예: `markupVersion` 제외 최적화). 이유: 재전송 페이로드·편집 진입·잠금 판정이 전부 그 shape에 의존한다 — 이 phase의 범위 밖 회귀다.
- `getStatusById`를 `getById` 위에 얹어 구현하지 마라. 이유: blob 읽기를 없애는 것이 이 함수의 유일한 존재 이유다(케이스 5가 잠근다).
- status 유효값 검사·정규화(대문자화·trim·allowlist 필터)를 모델에 넣지 마라. 이유: 도메인 규칙은 서비스(`embargoPolicy`) 단일 출처이며, 모델의 관용은 조용한 오판정을 만든다.
- 다른 경량 조회(`getTitleById` 등)를 "겸사겸사" 추가하지 마라. 이유: 소비자 없는 API는 죽은 코드이며, 이 phase는 확정 백로그 4건만 처리한다.
- `src/services/**`를 수정하지 마라. 이유: `distributionRetryService.js`는 step4가 단독 소유한다.
- `docs/**`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
