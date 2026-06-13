# Step 2: data-models

## 읽어야 할 파일

- `/docs/SCHEMA.md` — 테이블/컬럼, Contents↔Article 1:1, 트랜잭션 규칙
- `/docs/ARCHITECTURE.md` — `src/models/`는 직접 SQL 데이터 접근 계층(ORM 없음)
- `/docs/ADR.md` — ADR-002
- `src/db/schema.js`, `src/db/articleId.js` (step1 산출물)

## 작업

데이터 접근 계층을 직접 SQL로 구현한다(비즈니스 규칙 없음 — 순수 CRUD/조회). TDD.

1. `src/models/userModel.js` — `export function createUserModel(db)` 반환 객체:
   - `findById(userId)`, `query(filters)`(부서 등 AND 필터, 비밀번호 포함 raw row 반환은 서비스가 정제), `insert(user)`, `update(userId, fields)`. **삭제 함수 없음**(비활성은 active='N' 업데이트).
2. `src/models/articleModel.js` — `export function createArticleModel(db)`:
   - `getById(articleId)`(Contents+Article 조인 또는 각각 조회), `insert({article, contents})`(Article+Contents를 **하나의 트랜잭션**으로), `update(articleId, {article?, contents?})`(부분 업데이트, 트랜잭션), `query(filters)`(작성/배부/송고 시간, 작성자, 송고자, articleId, status, **부서 다중 선택**, **특정 status 제외** 지원), `searchByText(q)`(제목/본문), 잠금 컬럼 업데이트 헬퍼(`setLock`, `clearLock`).
3. `src/models/receiverConfigModel.js` — `export function createReceiverConfigModel(db)`:
   - `query(filters)`, `insert(entry)`, `remove(id)`(**설정 행만 삭제 — 이미 수집된 Article/Contents는 절대 건드리지 않는다**).
4. 테스트: in-memory DatabaseSync + createSchema. 트랜잭션 원자성, 부서 다중/상태 제외 필터, 검색, 잠금 컬럼 갱신, receiverConfig CRUD를 검증.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. AC 실행.
2. 체크리스트: Article+Contents 동시 변경이 트랜잭션인가? query가 부서 다중/상태 제외를 지원하는가? receiverConfig.remove가 설정 행만 지우는가? 직접 SQL인가(ORM 미사용)?
3. step 2 업데이트(completed + summary: 각 model의 export 함수와 메서드 목록).

## 금지사항

- Article/Contents 행을 삭제하는 코드를 만들지 마라. 이유: DB 비파괴 원칙. (receiverConfig **설정** 행 삭제만 허용)
- 생애주기/권한/HTTP 로직을 모델에 넣지 마라. 이유: 모델은 데이터 접근만. 규칙은 서비스(step3~)의 scope.
- ORM/쿼리빌더를 도입하지 마라. 이유: ADR-002 직접 SQL.
- 기존 테스트를 깨뜨리지 마라.
