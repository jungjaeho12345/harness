# Step 0: account-lockout-schema

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/SCHEMA.md` — User 테이블 명세, 멱등 마이그레이션 원칙(컬럼 추가만, 행 삭제 금지)
- `/docs/ADR.md` — ADR-002(node:sqlite 직접 SQL, additive ALTER만), ADR-004(신뢰 경계 = 서버)
- `/docs/ARCHITECTURE.md` — "보안 경계", DB 비파괴 원칙
- `src/db/schema.js` — 기존 멱등 스키마 정의(SCHEMA 객체 + createSchema). **이 패턴을 그대로 따른다.**
- `test/schema.test.js` — 기존 스키마 테스트 패턴(in-memory DatabaseSync 주입)

이전 단계가 없으므로 위 파일들로 현재 스키마 구조와 멱등 마이그레이션 방식을 파악한 뒤 작업하라.

## 작업

계정 잠금(account lockout)을 위해 `User` 테이블에 로그인 실패 누적 상태를 담을 컬럼을 **additive 멱등 마이그레이션**으로 추가한다. TDD — 테스트 먼저.

1. `src/db/schema.js`의 `SCHEMA.User` 배열에 아래 3개 컬럼을 추가한다. 타입은 User 테이블 관례대로 `TEXT`로 한다(SCHEMA.md: User는 TEXT). 카운트/타임스탬프도 문자열로 저장한다(기존 시간 컬럼이 ISO-8601 문자열인 것과 정합).
   - `failedLoginCount` — `TEXT DEFAULT '0'` (연속 로그인 실패 횟수, 문자열 정수)
   - `lockedUntil` — `TEXT` (계정 잠금 해제 시각, ISO-8601 UTC 문자열. 비어 있으면 잠기지 않음)
   - `lastFailedLoginAt` — `TEXT` (마지막 실패 시각, ISO-8601 UTC 문자열)

2. 컬럼 추가는 `createSchema`의 기존 additive ALTER 루프가 자동 처리한다 — `createSchema` 함수 본문을 새로 작성하지 마라. `SCHEMA` 정의에 컬럼만 더하면 된다.

3. `src/models/userModel.js`의 `COLUMNS` 화이트리스트에 위 3개 컬럼을 추가해 `insert`/`update`/`query`가 이 컬럼을 읽고 쓸 수 있게 한다. **단 이 컬럼들은 비밀번호처럼 응답에 노출 금지 대상은 아니지만, userService.SAFE_FIELDS에는 넣지 마라**(잠금 상태는 로그인 핸들러 내부에서만 쓰고 일반 사용자 목록 응답으로 새어 나가면 안 됨 — 다음 step에서 사용).

4. 테스트(`test/schema.test.js` 보강 또는 신규 `test/schema.lockout.test.js`):
   - 빈 in-memory DB에 `createSchema`를 호출하면 User 테이블에 `failedLoginCount`/`lockedUntil`/`lastFailedLoginAt` 컬럼이 생긴다.
   - **멱등성**: 기존 User 컬럼만 있는 (구버전) 테이블을 만든 뒤 `createSchema`를 호출하면, 기존 행 데이터가 보존된 채 새 3개 컬럼만 ADD COLUMN 된다(행 수·기존 값 불변).
   - `createSchema`를 두 번 연속 호출해도 에러가 없다(IF NOT EXISTS / 이미 있는 컬럼 skip).
   - `failedLoginCount`의 기본값이 `'0'`이다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `createSchema` 함수 로직을 바꾸지 않고 `SCHEMA` 선언만 확장했는가?
   - 추가가 전부 `ALTER TABLE ... ADD COLUMN`(additive)인가? DROP/DELETE/재생성이 없는가?
   - 멱등성 테스트가 기존 행 보존을 검증하는가?
3. 결과에 따라 `phases/1-security-hardening/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 추가한 컬럼명 3개와 타입, userModel.COLUMNS 변경 사실을 기록.
   - 실패 3회 → `"status": "error"` + `error_message`.

## 금지사항

- `createSchema`의 ALTER 루프를 우회해 `CREATE TABLE`을 재실행하거나 기존 테이블을 DROP하지 마라. 이유: DB 비파괴 원칙(SCHEMA.md, ADR-002) — 프로덕션 news.db의 기존 사용자 행이 사라진다.
- 새 컬럼을 `userService.SAFE_FIELDS`에 추가하지 마라. 이유: 잠금 상태(실패 횟수/잠금시각)는 `/api/users` 목록 응답으로 노출되면 안 되는 내부 보안 상태다.
- 비밀번호 컬럼 처리 방식을 바꾸지 마라. 이유: 이 step의 범위는 잠금 컬럼 추가뿐이다.
- 기존 테스트를 깨뜨리지 마라.
