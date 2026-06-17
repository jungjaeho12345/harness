# Step 1: history-model

이력 데이터 접근 계층 — `ArticleHistory` 행을 기록(insert)/조회하는 모델을 신설한다. 이 step은 모델 한 레이어만 다룬다. **HTTP/서비스 로직·이벤트 결선은 하지 않는다.**

## 읽어야 할 파일

- `/src/models/articleModel.js` — 기존 모델 패턴(직접 SQL, ORM 없음, 비즈니스 규칙 없음). `tx(db, fn)` 트랜잭션 헬퍼, `insertInto`/컬럼 화이트리스트, 행 삭제 코드 없음 규칙. **새 모델도 같은 스타일을 따른다.**
- `/src/db/schema.js` — step 0에서 추가된 `ArticleHistory` 테이블 컬럼(`id`, `articleId`, `eventType`, `actorUserId`, `actorRole`, `fromStatus`, `toStatus`, `title`, `createdAt`).
- `/docs/SCHEMA.md` — 시간 컬럼은 ISO-8601 UTC 문자열, 보조 인덱스/FK 없음.
- `/docs/ADR.md` — ADR-002(직접 SQL), ADR-006(모델은 데이터 접근만, 비즈니스 로직 없음).
- `phases/1-history/step0.md` — 추가된 테이블 스키마.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

1. `src/models/articleHistoryModel.js` 신설 — `export function createArticleHistoryModel(db)`. 다음 시그니처를 노출한다(구현은 재량, 단 직접 SQL·화이트리스트 컬럼만):
   - `record(entry)` — 한 이력 행을 INSERT. `entry`는 `{ articleId, eventType, actorUserId?, actorRole?, fromStatus?, toStatus?, title?, createdAt }`. `id`는 자동증가이므로 넣지 않는다. 제공되지 않은 선택 컬럼은 INSERT 대상에서 빼거나 NULL로 둔다(`articleModel.insertInto`의 "present 컬럼만" 방식 참고). 반환은 삽입된 rowid 또는 changes(재량, 테스트로 고정).
   - `recordWithDb(dbHandle, entry)` — **같은 db 핸들로 INSERT만 수행하고 자체 트랜잭션을 열지 않는다.** 이유: step 2에서 기사 저장 트랜잭션 안에서 호출해 원자성을 보장하기 위함(BEGIN/COMMIT 중첩 방지). `record`는 내부적으로 `recordWithDb(db, entry)`를 호출해 구현해도 된다. (트랜잭션을 직접 쓰는지/안 쓰는지의 경계를 테스트로 명시하라.)
   - `findByArticleId(articleId)` — 해당 기사의 모든 이력 행을 `createdAt` **오름차순(과거→현재)** 으로 반환(배열, 없으면 `[]`).
   - `findSendByArticleId(articleId)` — `eventType = 'send'` 인 이력만 `createdAt` 오름차순으로 반환(배열, 없으면 `[]`).
2. 테스트(`test/articleHistoryModel.test.js`): `new DatabaseSync(':memory:')` + `createSchema(db)`로 격리. 검증 항목:
   - `record`로 넣은 행이 `findByArticleId`로 조회되고 컬럼 값이 보존된다.
   - 여러 이벤트 기록 후 `findByArticleId`가 `createdAt` 오름차순 정렬을 보장한다.
   - `findSendByArticleId`가 `eventType='send'`만 돌려준다(`edit`/`hold` 등은 제외).
   - 존재하지 않는 articleId면 `[]`.
   - `recordWithDb(db, entry)`가 외부에서 연 트랜잭션(`db.exec('BEGIN'); ...; db.exec('COMMIT')`) 안에서 호출돼도 동작하고, 롤백 시 행이 남지 않는다(원자성 계약).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 실행 — 기존 테스트 무회귀 + 신규 통과.
2. 체크리스트: 직접 SQL·화이트리스트 컬럼만 쓰는가? 비즈니스 로직(이벤트 종류 결정·권한 판정)을 모델에 넣지 않았는가? `recordWithDb`가 자체 트랜잭션을 열지 않는가? 행 삭제 코드가 없는가?
3. `phases/1-history/index.json`의 step 1 업데이트(completed + summary: 파일·시그니처). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 비즈니스 로직(어떤 이벤트를 남길지, 권한 판정, 생애주기 해석)을 모델에 넣지 마라. 이유: ADR-006 — 모델은 데이터 접근만. 결정은 step 2 서비스의 책임.
- `recordWithDb`에서 BEGIN/COMMIT을 열지 마라. 이유: step 2에서 기사 저장 트랜잭션 안에서 호출 → 중첩 트랜잭션은 SQLite에서 에러난다. 원자성 보장이 깨진다.
- 행 삭제(DELETE)·UPDATE 메서드를 만들지 마라. 이유: 이력은 append-only이며 DB 비파괴 원칙.
- HTTP/서비스/컨트롤러/프론트 코드를 건드리지 마라. 이유: 다음 step들의 scope.
