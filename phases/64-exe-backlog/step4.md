# Step 4: tx-rollback

## 읽어야 할 파일

- `CLAUDE.md` — TDD·아키텍처·커밋 규칙(DB 비파괴)
- `docs/ADR.md` — **ADR-002**(node:sqlite + 직접 SQL)·**ADR-006**(controllers → services → models 계층 방향). 이 step은 ADR을 **수정하지 않는다**
- `phases/64-exe-backlog/index.json` — scope의 (C-1), decisions **(14)(16)(17)**
- `src/db/schema.js` — `backfillHistoryTitles` 150~202행 전체(특히 배치 트랜잭션 184~200행)와 실패 정책 주석 164~168행
- `src/models/articleModel.js` — `tx()` 32~43행, 소비처 `insert`/`update`(61~76행) 및 그 아래 다른 tx 사용처 전부(어떤 함수가 tx를 쓰는지 파악만 하고 고치지 마라)
- `test/schema.historyTitleBackfill.resilience.test.js` — 전체(배치 중간 실패 계약이 이미 여기 있다 — 새 케이스가 붙을 자리)
- `test/schema.historyTitleBackfill.test.js`·`test/articleModel.test.js` — 기존 계약 확인용

## 배경 (실코드 확인 결과)

두 곳에 동일한 패턴이 있다.

```js
} catch (e) {
  db.exec('ROLLBACK');   // ← 이 줄이 던지면
  throw e;               // ← 여기까지 오지 못한다
}
```

- `src/db/schema.js` 196~199행 (`backfillHistoryTitles`의 배치 트랜잭션)
- `src/models/articleModel.js` 39~42행 (`tx()` — Article+Contents 원자성)

SQLite는 일부 오류(`SQLITE_FULL`·`SQLITE_IOERR`·`SQLITE_BUSY` 계열)에서 트랜잭션을 **자동으로 롤백**한다. 그 상태에서 명시 `ROLLBACK`을 보내면 `cannot rollback - no transaction is active`가 던져지고, 그 예외가 원인 예외를 **교체**한다 — 운영자는 "디스크가 가득 찼다" 대신 "활성 트랜잭션이 없다"라는 무관한 메시지를 보게 된다. `backfillHistoryTitles`는 부팅 경로라 이 오보가 곧 "부팅이 왜 죽었는지 모름"이 된다.

성공 경로는 이 변경과 무관하며, 관측 가능한 변화는 **실패 시 던져지는 예외가 원인 예외 그 자체(identity 동일)** 라는 것 하나뿐이다.

## 작업

### A. 테스트 먼저 (red) — 두 파일 각각

**주입 가능한 가짜 db**로 잠근다(실제 DatabaseSync를 감싸 `exec('ROLLBACK')`만 던지게 한다). 두 함수 모두 `db.prepare`/`db.exec`만 쓰므로 프록시 객체로 충분하다.

1. `test/schema.historyTitleBackfill.resilience.test.js`에 추가:
   - 케이스 A: `deriveTitle`이 sentinel 예외를 던지고 `exec('ROLLBACK')`도 던지는 상황에서 `backfillHistoryTitles`가 **sentinel 예외 그 자체**를 던진다(`assert.strictEqual(caught, sentinel)`). 롤백 예외 메시지가 새어나오면 red.
   - 케이스 B: 그 상황에서도 `ROLLBACK` 시도가 **정확히 1회** 있었다(스파이 카운트) — 롤백을 조용히 건너뛰는 구현으로 도망가지 못하게 잠근다.
2. `test/articleModel.test.js`에 추가:
   - 케이스 C: `prepare`가 특정 INSERT에서 sentinel 예외를 던지고 `exec('ROLLBACK')`도 던지는 가짜 db로 `createArticleModel(fake).insert(...)`를 호출하면 **sentinel 예외 그 자체**가 던져진다.
   - 케이스 D(회귀): **정상 DatabaseSync**에서 트랜잭션 실패 시 롤백이 실제로 일어난다 — 실패 직전에 넣으려던 행이 남아 있지 않고, 이후 다른 `insert`가 정상 동작한다(열린 트랜잭션이 남지 않았다는 증거).

### B. 구현 — 두 파일 동일 패턴

```js
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* 원인 예외 보존 — 롤백 실패는 원인에 종속된 2차 증상이다 */ }
  throw e;
}
```

- 원인 예외는 **재포장·가공하지 않는다**(identity 그대로 전파 — `new Error(...)`로 감싸지 마라).
- 공통 유틸로 추출하지 마라(decisions (14)): `src/db`와 `src/models`는 다른 계층이고, `tx()`는 소비처가 많아 시그니처가 흔들리면 회귀 표면이 넓어진다.
- 로깅 주입을 새로 만들지 마라 — `src/db`·`src/models`는 서비스·로거를 import하지 않는 계층이다(ADR-006 방향).
- 두 파일 모두 **그 catch 블록 3줄 외에는 한 글자도 바꾸지 않는다**(주석 1줄 추가는 허용).

## Acceptance Criteria

```bash
node --test test/schema.historyTitleBackfill.resilience.test.js
node --test test/schema.historyTitleBackfill.test.js
node --test test/articleModel.test.js
node --test test/boot-history-backfill.test.js
npm test
npm run lint

# diff scope
git status --porcelain
```

이 step은 exe·빌드·서버를 실행하지 않는다(모든 테스트가 자기 `:memory:` DB를 만든다) — 리포 `news.db`에 접근하는 경로가 없다.

## 검증 절차

1. AC를 전부 실행한다. 새 케이스가 red → green 순서를 거쳤음을 요약에 남긴다.
2. **변이 검증 3종**(각각 red 확인 후 원복):
   - (a) `schema.js`의 try/catch 감싸기를 원래대로 되돌림 → 케이스 A red.
   - (b) `ROLLBACK` 호출 자체를 제거(에러만 다시 던짐) → 케이스 B red(그리고 기존 배치 원자성 케이스도 깨지는지 관찰 — 열린 트랜잭션이 남아 다음 `BEGIN`이 실패한다).
   - (c) `articleModel.tx()`에서 원인 예외를 `new Error(String(e))`로 재포장 → 케이스 C red(identity 단언이 잡는다).
3. 기존 계약 회귀 확인: `test/schema.historyTitleBackfill.resilience.test.js`의 기존 2케이스(배치 중간 실패 보존·배부 판정 무접점)와 `test/articleModel.test.js`의 기존 케이스가 **전부 green**인지 확인한다.
4. `git status --porcelain` 증분이 소유 파일(`src/db/schema.js`·`src/models/articleModel.js`·`test/schema.historyTitleBackfill.resilience.test.js`·`test/articleModel.test.js`·`phases/64-exe-backlog/index.json`)뿐인지 확인한다.
5. 아키텍처 체크리스트: DB 스키마·인덱스·컬럼 무변경 · `src/services/**`·`server/**`·`web/**`·`client/**`·`scripts/**`·`docs/**` 무수정 · 새 import(로거·서비스) 0 · 삭제/DROP/DELETE 0.
6. `phases/64-exe-backlog/index.json`의 step4 status를 갱신한다.

## 금지사항

- 성공 경로(BEGIN/COMMIT·배치 크기·커서 전진·UPDATE 술어)를 건드리지 마라. 이유: phase 58·59가 실측으로 확정한 백필 계약이며, 이번 변경은 실패 경로의 예외 보존 하나다.
- 원인 예외를 재포장하거나 메시지를 합성하지 마라. 이유: 상위 호출자와 테스트가 예외 identity·타입으로 판정한다(케이스 A/C가 그것을 잠근다).
- `ROLLBACK` 호출 자체를 제거하지 마라. 이유: 정상적인 실패(제약 위반 등)에서는 롤백이 반드시 일어나야 하고, 빼면 열린 트랜잭션이 남아 다음 `BEGIN`이 죽는다(케이스 B·D가 잠근다).
- 롤백 실패를 로그로 남기려고 `src/db`·`src/models`에 로거를 주입하지 마라. 이유: ADR-006 계층 방향 위반이며, 이 3줄짜리 수정을 인터페이스 변경으로 키운다.
- 두 곳을 공통 트랜잭션 유틸로 통합하지 마라. 이유: 계층이 다르고 `tx()`의 소비처가 많다 — "동작 무변경 보장"이 이 항목의 전제 조건이다(decisions (14)).
- DB 행을 삭제·재작성하는 코드를 추가하지 마라. 이유: DB 비파괴는 이 프로젝트의 절대 규칙이다.
