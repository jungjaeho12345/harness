# Step 1: lockout-model

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ADR.md` — ADR-002(직접 SQL, 비즈니스 규칙 없음은 model 밖), ADR-006(controllers → services → models → db 계층 분리)
- `/docs/ARCHITECTURE.md` — 백엔드 MVC 계층 분리, "models/ 데이터 접근 — 직접 SQL"
- `/docs/SCHEMA.md` — User Table 명세
- `src/models/userModel.js` — 현재 userModel(`COLUMNS` 화이트리스트 + `findById`/`query`/`insert`/`update`)
- `src/db/schema.js` — step 0에서 추가된 User 컬럼(`failedLoginCount`, `lockedUntil`, `lastFailedLoginAt`)
- `test/userModel.test.js` — 기존 userModel 테스트(in-memory DatabaseSync로 검증하는 패턴 참고)

이전 step에서 추가된 컬럼명을 schema.js에서 확인한 뒤 작업하라. step 0 summary에 컬럼명·정의가 기록되어 있다.

## 작업

userModel이 잠금 추적 컬럼을 읽고 쓸 수 있게 한다. **model 계층은 데이터 접근만 — 잠금 판정(임계치·해제 시각 비교) 같은 비즈니스 규칙은 넣지 않는다**(그건 step 2 service 책임). TDD: 실패 테스트 먼저.

1. `src/models/userModel.js`:
   - `COLUMNS` 화이트리스트에 step 0에서 추가한 3개 컬럼(`failedLoginCount`, `lockedUntil`, `lastFailedLoginAt`)을 **추가**한다. 이렇게 해야 `update`/`query`가 이 컬럼들을 다룰 수 있다.
   - `findById`는 `SELECT *`이므로 이미 새 컬럼을 반환한다 — 별도 변경 불필요(확인만).
   - 잠금 카운터 갱신은 기존 `update(userId, fields)`로 충분하다. **별도 전용 메서드를 만들지 말고** 기존 `update`가 새 컬럼을 패치할 수 있는지만 보장한다(화이트리스트에 들어가면 자동 동작).
2. `test/userModel.test.js`에 테스트를 보강한다(in-memory `DatabaseSync(':memory:')` + `createSchema`):
   - `update(userId, { failedLoginCount: '3', lockedUntil: '2026-06-16T...Z', lastFailedLoginAt: '...' })`가 해당 컬럼만 갱신하고 `findById`로 그 값이 그대로 읽히는지.
   - `query({ ... })`가 기존처럼 raw row(비밀번호 포함)를 반환하고 새 컬럼도 포함하는지(정제는 service 책임이므로 model은 raw 반환 유지).
   - 새 컬럼을 패치해도 기존 컬럼(name/role 등)이 보존되는지.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - userModel이 여전히 "직접 SQL, 비즈니스 규칙 없음"을 지키는가(잠금 임계치/시각 비교 로직이 없는가)?
   - `COLUMNS` 화이트리스트 방식(임의 컬럼명 주입 차단)을 유지하는가?
   - 삭제 함수를 추가하지 않았는가(DB 비파괴 — 비활성화는 active='N')?
3. 결과에 따라 `phases/1-security/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 `COLUMNS`에 추가된 컬럼·`update`로 잠금 필드 패치 가능함을 기록(step 2가 이 update를 호출한다).
   - 실패/blocked → 절차 동일.

## 금지사항

- 잠금 판정 로직(실패 횟수 임계치 비교, lockedUntil과 현재 시각 비교)을 userModel에 넣지 마라. 이유: ADR-006 — 그건 service 계층(step 2) 책임이고, model은 데이터 접근만.
- `findById`/`query`에서 비밀번호를 제거하지 마라. 이유: model은 raw row를 반환하고 정제는 service가 한다(기존 계약). 기존 테스트가 이를 검증한다.
- `delete`/`remove` 메서드를 추가하지 마라. 이유: DB 비파괴 — 사용자 비활성화는 active 업데이트로 한다.
- 기존 테스트를 깨뜨리지 마라.
