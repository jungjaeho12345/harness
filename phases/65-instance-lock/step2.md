# Step 2: boot-db-close

## 읽어야 할 파일

- `CLAUDE.md` — TDD·커밋 규칙
- `phases/65-instance-lock/index.json` — scope (B-3), decisions **(14)(15)(16)(17)**
- `phases/64-exe-backlog/index.json` — decisions **(14)**(C-1: ROLLBACK 원인 예외 identity 보존 — 이 step이 따라 쓰는 규율)과 step4 요약
- `server/index.js` 1255~1262행 — `openBootDatabase` 전체(phase 64 step5 신설)
- `src/db/connection.js` — `applyConnectionPragmas`가 던지는 두 경로(입력 가드 `TypeError` / read-back 불일치 `Error`)
- `test/boot-db-open.test.js` — 이 step이 케이스를 추가할 파일. 특히 **40~63행 텍스트 잠금**(`new DatabaseSync(` 출현 정확히 1건 + 그 1건이 `openBootDatabase` 본문 안)
- `src/models/articleModel.js`의 `tx()` catch — phase 64가 넣은 "정리 호출을 try/catch로 감싸 원인 예외를 보존한다" 패턴의 실물

## 배경 (실코드 + 계획 단계 실측)

- 현행 `openBootDatabase`는 `new DatabaseSync(dbFile)` → `applyConnectionPragmas(db, pragmaOptions)` → `return db`다. pragma 적용이 던지면 **열린 DB 핸들이 그대로 누수**된다. 현 소비자(bootstrap)는 그 예외로 즉사하므로 실피해는 없지만, phase 65가 부트 경로에 새 소비자(잠금)를 붙이는 지금 정리해 둔다.
- **실측(Windows)**: SQLite 파일에 열린 핸들이 남아 있으면 그 파일의 `unlink`가 `EBUSY`, 상위 폴더 `rmSync`가 `EPERM`으로 실패한다. 연결을 닫으면 즉시 삭제된다 → **"핸들이 닫혔는가"를 파일 삭제 성공 여부로 관측할 수 있다.**
- phase 64 C-1이 확립한 규율: 정리(cleanup) 호출이 던져도 **원인 예외를 대체하지 않는다**(원인 예외를 재포장 없이 그대로 다시 던진다).

## 작업

### A. 테스트 먼저 (red)

`test/boot-db-open.test.js`에 케이스를 추가하고 **수정 전에 red를 확인한다**.

- 케이스: `fs.mkdtempSync` 임시 폴더의 파일 경로로 `openBootDatabase(file, { busyTimeoutMs: -1 })`를 호출한다 → `TypeError`가 던져지고, **그 직후 `fs.unlinkSync(file)`가 성공한다**(핸들이 닫혔다는 증거).
- 보조 단언: 던져진 예외가 `TypeError`이고 메시지에 `busyTimeoutMs`가 있다(정리 실패가 원인 예외를 대체하지 않았다는 증거).
- **red가 재현되지 않으면**(수정 전에도 `unlinkSync`가 성공하면) 그 케이스는 이 환경에서 아무것도 잠그지 못하는 것이다 — 케이스를 남기지 말고 **삭제한 뒤 그 사실(관측값 포함)을 요약에 기록**하라. 추측으로 green 케이스를 남기지 마라.
- 임시 폴더는 `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`로 정리하고, 정리 실패로 테스트를 red로 만들지 마라.

### B. `server/index.js` `openBootDatabase` 본문 (3줄)

```js
export function openBootDatabase(dbFile, pragmaOptions = {}) {
  const db = new DatabaseSync(dbFile);
  try {
    applyConnectionPragmas(db, pragmaOptions);
  } catch (err) {
    try { db.close(); } catch { /* 닫기 실패는 삼킨다 — 원인 예외를 대체하지 않는다 */ }
    throw err; // 원인 예외 identity 보존 (phase 64 C-1과 같은 규율)
  }
  return db;
}
```

- 성공 경로는 **한 글자도 바뀌지 않는다**(반환값·순서 동일).
- `new DatabaseSync(` 출현은 여전히 **이 함수 본문 1건**이어야 한다(텍스트 잠금).
- 로거·주입 seam·재시도를 추가하지 마라(이 함수는 무의존 관문이다).

## Acceptance Criteria

```bash
node --test test/boot-db-open.test.js
node --test test/db-connection.test.js test/instance-lock.test.js test/instance-lock-boot.test.js
node --test test/sea-import-meta-lock.test.js
npm test
npm run lint
git status --porcelain
```

## 검증 절차

1. AC를 전부 실행한다. 새 케이스의 red → green 순서(또는 red 미재현으로 케이스를 폐기한 사실)를 요약에 남긴다.
2. **변이 검증 3종**(각각 red 확인 후 원복):
   - (a) `try/catch`를 원복(닫기 없이 그대로 throw) → 새 케이스 red.
   - (b) `catch`에서 `throw new Error(...)`로 재포장 → `TypeError` 단언 red.
   - (c) `catch`에서 `throw err`를 빼고 삼킴 → `assert.throws` 케이스 red.
3. 기존 3케이스(기본 5000 / `pragmaOptions` 전달 / `TypeError` 전파)와 텍스트 잠금이 그대로 green인지 확인한다.
4. `git status --porcelain` 증분이 소유 파일(`server/index.js`·`test/boot-db-open.test.js`·`phases/65-instance-lock/index.json`)뿐인지 **시작 시점 스냅샷 대비**로 확인한다.
5. 아키텍처 체크리스트: 라우트·미들웨어·`createApp`·`bootstrap` 본문 무수정 · 스키마 무변경 · `src/**`·`web/**`·`client/**`·`scripts/**`·`docs/**` 무수정 · dependencies 불변 · DB 행 생성·삭제 0.
6. `phases/65-instance-lock/index.json`의 step2 status를 갱신한다.

## 금지사항

- `bootstrap()` 본문을 만지지 마라(step1 소유, 이미 완료된 결선이다). 이유: 같은 파일의 다른 함수를 두 step이 각자 소유하는 경계가 이 phase의 실패 격리 전제다.
- `openBootDatabase`에 로거·주입 seam·재시도·기본값 보정을 추가하지 마라. 이유: 이 함수는 "열기 + 연결 설정"의 무의존 단일 관문이며, 소비자가 부트 1곳뿐이라는 사실이 phase 64의 영향 범위 근거다.
- 원인 예외를 재포장하지 마라(`new Error(...)`·메시지 합성 금지). 이유: 호출부와 로그가 보는 예외의 identity·타입이 바뀌면 실패 원인 추적이 한 단계 멀어진다(phase 64 C-1이 같은 이유로 확정한 규율이다).
- 닫기 실패를 로그로 남기려고 logService를 import하지 마라. 이유: `server/index.js`의 이 함수는 logService 생성 **이전**에 호출되고, DB 계층 무의존 규율을 깬다.
- 리포 루트 `news.db`를 여는 테스트를 만들지 마라(`:memory:` 또는 `mkdtemp` 임시 파일만). 이유: 실데이터 오염은 되돌릴 수 없다.
