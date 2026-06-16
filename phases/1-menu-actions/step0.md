# Step 0: history-schema

우클릭 메뉴의 **이력보기/송고이력보기**가 동작하려면 기사 편집·송고 이력을 저장할 곳이 있어야 한다. 이 step은 **DB 스키마 레이어만** 다룬다 — 이력을 적재할 additive 테이블 `ArticleHistory`를 추가한다. 서비스/HTTP/프론트는 이후 step 소관이다.

**핵심 설계 전제(반드시 지켜라):** 기존 기사에는 과거 이력이 없다. 이력 기록은 **지금부터 시작**한다. 이 점을 스키마에 반영해 nullable 컬럼으로 두고, 기존 행을 백필하지 않는다.

## 읽어야 할 파일

먼저 아래를 읽고 DB 비파괴·멱등 마이그레이션 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-002(node:sqlite 직접 SQL, `CREATE TABLE IF NOT EXISTS`/additive `ALTER`만, 행 삭제·DROP 금지), 철학 섹션(DB 데이터 절대 삭제 금지).
- `/docs/SCHEMA.md` — 테이블 정의 방식, PK 자동 인덱스만(보조 인덱스/FK 미선언), 시간 컬럼은 ISO-8601 UTC 문자열, "스키마 변경은 컬럼 추가(멱등) 방식으로만".
- `/docs/ARCHITECTURE.md` — `src/db/` 위치, 보안 경계 섹션의 DB 비파괴 원칙.
- `/docs/news.md` — 85행(우클릭 메뉴에 이력보기/송고이력보기), 88행(현재 비활성), 221~228행(기사 DB 명세 — 멱등 마이그레이션).
- 현재 구현: `src/db/schema.js` (단일 `SCHEMA` 정의 객체 + `createSchema(db)`: `CREATE TABLE IF NOT EXISTS` 후 `PRAGMA table_info` 기반 누락 컬럼만 `ALTER ADD COLUMN`).
- 테스트 패턴: `test/schema.test.js` (멱등성·컬럼 존재·additive 마이그레이션·인덱스/FK 부재 검증 패턴).

이전 코드의 `SCHEMA` 정의 형식([컬럼명, 정의] 순서 목록, 첫 컬럼=PK)을 그대로 따른다.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

`test/schema.test.js`(또는 신규 `test/articleHistory.schema.test.js`, node --test)에 다음을 검증하는 테스트를 추가하라. 먼저 실패를 확인한 뒤 구현한다:

1. `createSchema(db)` 호출 후 `ArticleHistory` 테이블이 존재한다(`PRAGMA table_info(ArticleHistory)` 비어 있지 않음).
2. 정의된 컬럼이 모두 존재한다(아래 컬럼 목록).
3. `createSchema`를 2회 호출해도 오류 없이 멱등이다.
4. `ArticleHistory`에 보조 인덱스/FK가 없다(PK 자동 인덱스만 — `PRAGMA index_list`로 명시 인덱스 부재 확인, 기존 테스트의 인덱스 검사 패턴 재사용).
5. (비파괴 회귀) 기존 User/Article/Contents/ReceiverConfig 테이블·컬럼이 그대로 유지된다(기존 테스트가 이미 커버하면 추가 불필요).

### 구현: `src/db/schema.js`의 `SCHEMA`에 `ArticleHistory` 항목 추가

`SCHEMA` 객체에 아래 정의를 additive하게 추가하라. **컬럼 정의 형식은 기존과 동일**(첫 컬럼이 PK, Article/Contents와 동일하게 VARCHAR, 단 정수 PK는 `INTEGER PRIMARY KEY`).

`ArticleHistory` 컬럼(순서·의미):

- `id` — `INTEGER PRIMARY KEY` (SQLite ROWID alias, 자동 증가). `ReceiverConfig`의 `id`와 동일한 패턴.
- `articleId` — `VARCHAR` (어느 기사의 이력인지. FK 선언하지 않음 — 정합성은 애플리케이션이 유지).
- `eventType` — `VARCHAR` (이력 종류. 값은 `'edit'`(편집 저장)·`'status'`(생애주기 전이 — 송고/보류/KILL/삭제승인). 이력보기는 전체, 송고이력보기는 `eventType='status'` 중 송고만 필터한다 — 필터 로직은 step1 서비스 소관이며 여기선 컬럼만 둔다).
- `action` — `VARCHAR` (status 이벤트의 액션: `send`/`hold`/`kill`/`approveDelete`. edit 이벤트는 null).
- `fromStatus` — `VARCHAR` (전이 전 상태값. nullable).
- `toStatus` — `VARCHAR` (전이 후 상태값. nullable).
- `actorUserId` — `VARCHAR` (이력을 만든 사용자. 서버 세션에서 도출된 값이 기록된다 — step1/step2).
- `createdAt` — `VARCHAR` (이력 발생 시각, ISO-8601 UTC 문자열).

**스키마 컬럼만 추가한다. 이 step에서 모델/서비스/HTTP/프론트 코드는 작성하지 마라.**

## Acceptance Criteria

```bash
npm run lint     # ESLint 통과
npm run build    # 프론트 빌드 에러 없음(이 step은 프론트 무변경이지만 회귀 확인)
npm test         # 백엔드 node --test 전부 통과(기존 + 신규 스키마 테스트)
```

기존 백엔드/프론트 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - `src/db/schema.js`만 변경했는가? (스키마 레이어 단일 관심사)
   - `CREATE TABLE IF NOT EXISTS` + additive `ALTER ADD COLUMN`만 사용했는가? `DROP`/`DELETE`/보조 인덱스/FK가 없는가? (ADR-002, CLAUDE.md CRITICAL)
   - `createSchema` 2회 호출이 멱등인가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(ArticleHistory 컬럼 목록 포함)"`
   - 수정 3회 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 중단

## 금지사항

- 기존 행을 백필하거나 `UPDATE`/`DELETE` 하지 마라. 이유: 기존 기사에는 과거 이력이 없다는 것이 설계 전제다 — 이력은 지금부터 기록한다(news.md/CLAUDE.md DB 비파괴).
- 보조 인덱스나 FK 제약을 선언하지 마라. 이유: SCHEMA.md가 PK 자동 인덱스만 허용하고 정합성은 애플리케이션이 유지한다(ADR-002).
- 모델/서비스/컨트롤러/HTTP/프론트 코드를 이 step에서 작성하지 마라. 이유: 스키마와 다른 레이어를 섞으면 실패 격리가 불가능해진다(step1 이후 소관).
- `markupVersion` 본문 스냅샷 컬럼을 `ArticleHistory`에 넣지 마라. 이유: 이번 phase의 이력보기는 "언제 누가 무슨 전이/편집을 했는가"의 이벤트 로그다. 본문 버전 스냅샷은 범위 밖이며 DB 용량·비파괴 정책을 복잡하게 만든다(필요 시 후속 phase).
- 기존 테스트를 깨뜨리지 마라.
