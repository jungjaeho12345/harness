# Step 1: db-foundation

## 읽어야 할 파일

- `/docs/SCHEMA.md` — **DB 스키마 명세서 (이 step의 1차 기준)**. User/Article/Contents 3개 테이블, PK, 컬럼, 타입, 비파괴 멱등 마이그레이션 규칙.
- `/docs/ARCHITECTURE.md` — `src/db/` 위치
- `/docs/ADR.md` — ADR-002(node:sqlite, 직접 SQL), 비파괴 원칙
- `/CLAUDE.md` — DB 비파괴 CRITICAL 규칙
- `phases/0-mvp/step0.md` 산출물 — `package.json`의 test 명령과 node:sqlite 플래그

## 작업

`node:sqlite`(`DatabaseSync`)로 스키마 생성과 기사 아이디 생성을 구현한다. TDD: 테스트를 먼저 작성하라.

1. `src/db/schema.js`:
   - `export function createSchema(db)` — `CREATE TABLE IF NOT EXISTS`로 3개 테이블 생성.
     - **User**: `userId` TEXT PK, `name`, `password`(bcrypt 해시), `role`(R/D/Z), `department`, `departmentCode`, `active` TEXT default `'Y'`. (User는 TEXT)
     - **Article**: `articleId` VARCHAR PK, `title`, `content`, `markupVersion`, `modifier`. (Article/Contents는 VARCHAR)
     - **Contents**: `articleId` VARCHAR PK, `title`, `content`, `author`, `modifier`, `sender`, `department`, `departmentCode`, `createdAt`, `editedAt`, `sentAt`, `distributedAt`, `embargoAt`, `secondEmbargoAt`, `status`, `lockYN` default `'N'`, `lockerUserId`, `lockerSessionId`, `lockedAt`, `coAuthor`, `region`, `attribute`, `keyword`, `internalComment`, `externalComment`, `attachmentFile`, `referenceFile`.
   - 멱등 마이그레이션: 누락 컬럼은 `ALTER TABLE ... ADD COLUMN`으로만 추가. **절대 DROP/DELETE 하지 않는다.**
   - PK 자동 인덱스만 사용. 보조 인덱스/FK 제약 선언 금지(정합성은 애플리케이션이 유지).
2. `src/db/articleId.js`:
   - `export function generateArticleId(db)` — `'AKR' + YYYYMMDD + 9자리 난수`. 생성값이 Article/Contents에 이미 있으면 난수를 다시 생성(중복 회피).
3. 테스트(`test/schema.test.js`, `test/articleId.test.js`): `new DatabaseSync(':memory:')`로 격리. createSchema 멱등성(2회 호출 안전), 컬럼 존재, articleId 포맷/유일성 검증.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC를 실행한다.
2. 체크리스트: schema.md의 테이블/컬럼/타입을 정확히 반영했는가? 멱등 마이그레이션만 사용했는가? DROP/DELETE/보조 인덱스/FK가 없는가?
3. `phases/0-mvp/index.json`의 step 1 업데이트(completed + summary: 생성한 파일과 createSchema/generateArticleId 시그니처). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- `DROP TABLE`, `DELETE FROM`, 데이터 삭제 마이그레이션을 작성하지 마라. 이유: CLAUDE.md/ADR-002 DB 비파괴 원칙(절대 규칙).
- FK 제약이나 보조 인덱스를 선언하지 마라. 이유: schema.md — PK 자동 인덱스만, 정합성은 앱이 유지.
- 모델/서비스/HTTP 로직을 만들지 마라. 이유: 다음 step들의 scope.
- 기존 테스트를 깨뜨리지 마라.
