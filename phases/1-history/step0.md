# Step 0: history-schema

이력 인프라의 토대 — 신규 `ArticleHistory` 테이블을 기존 `src/db/schema.js`에 **additive(비파괴)** 로 추가한다. 이 step은 DB 스키마 한 레이어만 다룬다.

## 읽어야 할 파일

- `/docs/SCHEMA.md` — DB 스키마 명세서(이 step의 1차 기준). 타입 컨벤션(User=TEXT, 나머지=VARCHAR), PK 자동 인덱스만·보조 인덱스/FK 없음, 비파괴 멱등 마이그레이션 규칙. `ReceiverConfig`의 `id INTEGER PRIMARY KEY`(ROWID alias 자동증가) 패턴 참고.
- `/src/db/schema.js` — 기존 `SCHEMA` 단일 정의 객체와 `createSchema(db)`의 멱등 마이그레이션 패턴(`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 기반 누락 컬럼만 `ALTER ADD COLUMN`). **이 패턴을 그대로 따른다.**
- `/docs/ADR.md` — ADR-002(node:sqlite 직접 SQL), 비파괴 원칙.
- `/CLAUDE.md` — DB 비파괴 CRITICAL 규칙.
- `phases/0-mvp/step1.md` — 기존 db-foundation step의 테스트 작성 방식(`new DatabaseSync(':memory:')` 격리, 멱등성·컬럼 존재 검증).

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

1. `src/db/schema.js`의 `SCHEMA` 객체에 `ArticleHistory` 테이블 정의를 **추가만** 한다(기존 4개 테이블 정의는 한 글자도 바꾸지 않는다). 컬럼 정의:
   - `['id', 'INTEGER PRIMARY KEY']` — ROWID alias 자동증가(ReceiverConfig와 동일 패턴).
   - `['articleId', 'VARCHAR']` — 대상 기사아이디(FK는 선언하지 않는다, 정합성은 앱이 유지).
   - `['eventType', 'VARCHAR']` — 이벤트 종류. 값 도메인: `'create'`, `'edit'`, `'send'`, `'hold'`, `'kill'`, `'approveDelete'`. (변경 이력 = 전체, 송고 이력 = `eventType='send'` 필터.)
   - `['actorUserId', 'VARCHAR']` — 행위자 유저아이디(없으면 NULL).
   - `['actorRole', 'VARCHAR']` — 행위 시점 권한 R/D/Z(없으면 NULL).
   - `['fromStatus', 'VARCHAR']` — 전이 전 status(상태전이 이벤트만, 그 외 NULL).
   - `['toStatus', 'VARCHAR']` — 전이 후 status(상태전이 이벤트만, 그 외 NULL).
   - `['title', 'VARCHAR']` — 이벤트 시점 기사 제목 스냅샷(목록 표시용, 없으면 NULL).
   - `['createdAt', 'VARCHAR']` — 이벤트 발생 시각(ISO-8601 UTC 문자열).
2. `createSchema(db)` 함수 본문은 **수정하지 않는다** — 기존 루프가 `SCHEMA`의 모든 테이블을 순회하므로 `ArticleHistory`도 자동으로 `CREATE TABLE IF NOT EXISTS` + 멱등 ALTER 대상이 된다. (함수 변경이 필요하다고 판단되면 그건 설계 이탈이다 — 정의 추가만으로 충분한지 먼저 확인하라.)
3. 테스트(`test/schema.test.js`에 케이스 추가 또는 기존 파일 확장):
   - `ArticleHistory` 테이블과 위 9개 컬럼이 모두 생성되는지(`PRAGMA table_info`).
   - `createSchema(db)`를 2회 호출해도 안전한지(멱등성, throw 없음).
   - 기존 4개 테이블(User/Article/Contents/ReceiverConfig)이 그대로 유지되는지(회귀 방지).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC를 실행한다. 기존 402개 테스트 + 신규 테스트가 모두 통과해야 한다.
2. 체크리스트: `ArticleHistory`만 추가했는가? 기존 4개 테이블 정의는 무변경인가? `INTEGER PRIMARY KEY`(ROWID alias) PK인가? 보조 인덱스/FK/DROP/DELETE가 없는가? 타입은 VARCHAR(id 제외)인가?
3. `phases/1-history/index.json`의 step 0을 업데이트(completed + summary: 추가한 테이블·컬럼 목록). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 기존 4개 테이블의 컬럼 정의를 수정/삭제하지 마라. 이유: DB 비파괴 원칙 + 회귀. 이 step은 additive 추가만이다.
- `DROP TABLE`/`DELETE FROM`/데이터 삭제 마이그레이션을 작성하지 마라. 이유: CLAUDE.md/ADR-002 DB 비파괴(절대 규칙).
- FK 제약·보조 인덱스를 선언하지 마라. 이유: SCHEMA.md — PK 자동 인덱스만, 정합성은 앱이 유지.
- 모델/서비스/HTTP/프론트 코드를 만들지 마라. 이유: 다음 step들의 scope. 이 step은 스키마 한 레이어만이다.
