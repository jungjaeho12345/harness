# Step 0: lockout-schema

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/SCHEMA.md` — DB 스키마 명세(특히 "스키마 변경은 기존 데이터를 삭제하지 않고 컬럼을 추가하는 방식(멱등 마이그레이션)으로만" 규칙, User Table 명세)
- `/docs/ADR.md` — ADR-002(node:sqlite 직접 SQL, 비파괴·멱등 마이그레이션)
- `/docs/PRD.md` — "MVP 제외 사항"의 계정 잠금 후속 과제
- `CLAUDE.md` — DB 비파괴 CRITICAL 규칙
- `src/db/schema.js` — 현재 스키마 정의(`SCHEMA` 객체 + `createSchema(db)` 멱등 마이그레이션 루프)
- `test/schema.test.js` — 기존 스키마 테스트(테스트 작성 패턴 참고)

기존 코드를 꼼꼼히 읽고, 멱등 마이그레이션이 어떻게 동작하는지(`CREATE TABLE IF NOT EXISTS` + 누락 컬럼만 `ALTER ADD COLUMN`) 이해한 뒤 작업하라.

## 작업

계정 잠금(account lockout) 추적을 위한 컬럼을 User 테이블에 **additive only**로 추가한다. TDD: 실패 테스트 먼저 → 통과 구현.

1. `src/db/schema.js`의 `SCHEMA.User` 배열에 아래 3개 컬럼을 **추가**한다(기존 컬럼은 순서·정의 그대로 보존). User 테이블 타입 규칙은 TEXT다(SCHEMA.md):
   - `['failedLoginCount', "TEXT DEFAULT '0'"]` — 누적 로그인 실패 횟수(문자열 카운터).
   - `['lockedUntil', 'TEXT']` — 잠금 해제 시각(ISO-8601 UTC 문자열). null/빈 값이면 잠겨있지 않음.
   - `['lastFailedLoginAt', 'TEXT']` — 마지막 실패 시각(ISO-8601 UTC 문자열, 진단/감사용).
2. 컬럼 의미는 schema.js 상단 주석 또는 컬럼 근처에 간단히 남긴다(다음 step에서 model/service가 읽는다).
3. `test/schema.test.js`에 테스트를 보강한다:
   - 새 User 테이블에 위 3개 컬럼이 존재한다(`PRAGMA table_info(User)`로 확인).
   - **멱등성 회귀 테스트**: 위 3개 컬럼 중 일부가 없는 "구버전" User 테이블(예: 기존 7개 컬럼만으로 `CREATE TABLE`)을 만든 뒤 `createSchema(db)`를 호출하면, 기존 행이 보존된 채 누락 컬럼만 ADD 되는지 검증한다. (기존 행 1건을 미리 insert → createSchema 후에도 그 행이 그대로 SELECT 되는지 확인.)

`failedLoginCount`/`lockedUntil`의 **읽기·증가·리셋 로직은 이 step에서 구현하지 않는다**(step 1 model, step 2 service 책임). 이 step은 컬럼 존재만 보장한다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 변경이 `CREATE TABLE IF NOT EXISTS` + additive `ALTER ADD COLUMN` 패턴만 사용하는가(DROP/DELETE 없음)?
   - SCHEMA.md User 타입 규칙(TEXT)을 따르는가?
   - 기존 User 컬럼 순서·정의를 보존했는가?
3. 결과에 따라 `phases/1-security/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 추가한 3개 컬럼명·정의와 의미를 한 줄로 기록(다음 step이 컬럼명을 참조한다).
   - 수정 3회 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"`.

## 금지사항

- 기존 컬럼을 삭제하거나 정의를 변경하지 마라. 이유: DB 비파괴(CLAUDE.md·ADR-002) — 운영 news.db의 기존 데이터를 망가뜨린다.
- `DROP TABLE`/`DELETE`/테이블 재생성을 하지 마라. 이유: 비파괴 멱등 마이그레이션만 허용.
- 보조 인덱스나 FK 제약을 추가하지 마라. 이유: SCHEMA.md — PK 자동 인덱스만 사용, 정합성은 애플리케이션이 유지.
- 잠금 판정/카운터 증감 로직을 schema.js에 넣지 마라. 이유: schema는 db 계층이고 잠금 로직은 model/service 책임(ADR-006 계층 분리).
- 기존 테스트를 깨뜨리지 마라.
