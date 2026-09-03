# Step 2: nondestructive-gate

`scripts/db-migrate/**` 전체에 파괴 SQL과 쓰기 열기(read-write open)가 없음을 정적으로 잠그는 게이트 테스트를 만들고 `npm test`에 편입한다. porting-plan §8의 '삭제 쿼리 0 정적 검사(마이그레이터 코드에 DELETE/DROP 부재를 텍스트 잠금)'를 이 step이 구현한다.

## 읽어야 할 파일

**계획 문서**
- `phases/75-p2-migration-foundation/index.json` — `decisions` (2)·`scope`(무접촉 목록).
- `phases/75-p2-migration-foundation/step1.md` — 읽기 전용 open 규율(`{readOnly:true}`).

**직전 step 산출물(스캔 대상)**
- `scripts/db-migrate/schema-spec.mjs`(step0) · `scripts/db-migrate/canonical.mjs`·`scripts/db-migrate/inventory.mjs`(step1). **이 디렉토리 전체가 게이트의 스캔 루트다.**

**정본(무수정 — 읽기만)**
- `docs/ADR.md` — **ADR-013 ②**(DDL 0 · 정적 스캔이 CREATE/ALTER/DROP/DELETE 0건을 잠근다는 선례) · CLAUDE.md 최상위 규칙.

**형식 참조**
- `test/contract-inventory-gate.test.js` — '게이트가 실제로 돌고 판정한다'만 얇게 보는 테스트 패턴(규칙은 스캔이 소유 · 테스트는 실행·판정만). 이 step도 그 얇은 형태를 따른다.

## 배경 (동결된 사실)

1. **정적 게이트는 스캔할 코드가 있어야 비공허하다**(order (b)). step1이 첫 데이터 접근 도구(`inventory.mjs`)를 만들었으므로 이제 게이트를 세운다 — 이후 step3(export)·step4(verify)의 신규 도구는 이 게이트가 자동으로 보호한다.
2. **금지 토큰**: 대소문자 무시로 `DROP` · `DELETE` · `TRUNCATE` · `ALTER` · `CREATE` · `INSERT` · `UPDATE` · `REPLACE`. 이들은 SQL 문에서의 파괴/쓰기다. **주의(구체적)**: 정규 스키마 명세 파생을 위해 step0의 `schema-spec.mjs`는 `createSchema`를 **import해서 호출**할 뿐 자기 소스에 `CREATE` 문자열을 담지 않는다 — 만약 스캔이 함수명·주석의 부분일치(예: 주석의 'update')로 오탐하면, 스캔을 'SQL 문자열 리터럴 안의 토큰'으로 좁히거나 허용 리스트(주석/식별자)를 명시하되 **그 좁힘이 실제 파괴 SQL을 놓치지 않음을 M2-x 변이로 반드시 실증**하라(느슨하게 만들어 통과시키는 것이 가장 위험한 실패다). **이 phase 자체 도구가 담는 구체적 오탐 원천 3종을 미리 못 박는다**: `createHash(`(토큰 `CREATE` — canonical.mjs·inventory.mjs) · `String.prototype.replace(` 또는 `.replace(`(토큰 `REPLACE` — 문자열 처리) · 주석에 든 'update'/'insert' 같은 단어(토큰 `UPDATE`/`INSERT`). **권장 좁힘**: 금지 토큰 검사를 **SQL 문자열 리터럴 안**(= `db.exec(...)`·`db.prepare(...)`의 문자열 인자)으로 한정하면 이 3종 오탐이 전부 사라진다 — 그리고 그 좁힘이 실제 파괴 SQL을 여전히 잡는다는 것은 **M2-1(`db.exec('DELETE FROM ...')`)·M2-3(`DROP TABLE`)이 이미 실증**한다(그 둘이 red로 남는 한 좁힘은 안전하다).
3. **읽기 전용 open 규율**: `scripts/db-migrate/**`가 `new DatabaseSync(...)`를 부를 때 소스 경로에 대해서는 `{ readOnly: true }`여야 한다. export의 출력 파일 쓰기는 SQLite가 아니라 파일시스템(JSONL)이므로 이 규율의 대상이 아니다 — 게이트는 'DatabaseSync가 readOnly 없이 열리는 자리'를 잡되, 그런 자리가 필요하면(없어야 한다) 명시적으로 표시하게 한다. **이 규율은 소스 파일 경로 open에만 적용된다** — `:memory:`(그리고 파일이 아닌 다른 open)는 **면제**다. 근거: step0의 `schema-spec.mjs`는 `:memory:`를 **읽기-쓰기로 열어야** `createSchema`의 CREATE/ALTER를 실행할 수 있다(그 in-memory DB는 소스가 아니라 구조 파생용 일회성이다). 따라서 게이트는 open 인자가 파일 경로일 때만 `{readOnly:true}`를 요구하고, `:memory:` 리터럴 open은 통과시킨다.
4. **테스트 자신은 스캔 대상이 아니다** — 스캔 루트는 `scripts/db-migrate/`다. 테스트가 금지 토큰을 문자열로 담는 것은 허용된다(그 문자열이 게이트의 탐지 입력이다).

## 작업

### A — 정적 게이트 테스트 (`test/dbmigrate-nondestructive-gate.test.js`)

TDD: 먼저 이 게이트가 **파괴 SQL을 심으면 red**가 되도록 쓰고(그 시점엔 심은 상태라 red), 심은 것을 빼면 green이 되게 한다.

시그니처 수준:
- `scripts/db-migrate/` 아래 `*.mjs`를 전부 읽어 금지 토큰(배경 (2))을 검사하고, 하나라도 발견하면 **어느 파일·어느 줄**인지와 함께 실패한다.
- `DatabaseSync(` 호출 중 소스 open이 `{ readOnly: true }`를 동반하지 않는 자리를 검사한다(배경 (3)).
- 판정 규칙은 이 테스트가 소유한다(별도 스크립트로 빼도 되지만, 새 의존성/복제 없이 얇게). 어휘를 상수 배열로 두어 다음 사람이 확장할 수 있게 한다.

### B — 비공허성 자가 증명

- 테스트 안에 '알려진 파괴 문자열을 담은 임시 문자열을 스캐너에 직접 먹여 탐지됨을 단언'하는 단위 케이스를 둔다(파일을 실제로 오염시키지 않고 스캐너 함수의 탐지력을 잠근다). 이것이 없으면 게이트가 "0건이라 green"인지 "탐지 못 해서 green"인지 구분되지 않는다.

## Acceptance Criteria

```bash
# 1) 게이트 포함 전체 테스트 green
npm test

# 2) 게이트가 스캔 루트의 모든 도구를 실제로 읽는지(스모크) — 파일 수가 0이면 공허
node -e "import('node:fs').then(fs=>console.log(fs.readdirSync('scripts/db-migrate').filter(f=>f.endsWith('.mjs'))))"

# 3) 린트
npm run lint

# 4) 무접촉 경로
git diff --stat -- src server server-spring contract docs/api-contract docs/SCHEMA.md docs/news.md web client package.json

# 5) 이전 step 산출물 무회귀
node scripts/db-migrate/schema-spec.mjs --check ; echo "exit=$?"
```

**종료 조건 — 변이 결과표를 summary에 기록한다.**

## 검증 절차 (변이)

각 변이는 심고 → `npm test` red 확인 → 원복 후 무변 확인.

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M2-1 | `inventory.mjs`에 `db.exec('DELETE FROM Contents')` 한 줄(도달 불가라도) | 게이트 red — 파일·줄 지목 |
| M2-2 | `inventory.mjs`의 소스 open에서 `{ readOnly: true }` 제거 | 게이트 red — 읽기 전용 규율 |
| M2-2b | (변이 없이) `schema-spec.mjs`의 `:memory:` 읽기-쓰기 open이 그대로 있는 상태 | 게이트 **green** — `:memory:` 면제가 소스-open red(M2-2)와 공존함을 실증(면제가 게이트를 조용히 무력화하지 않는다). 면제를 파일 경로로 넓히면 M2-2가 green으로 무너지는지도 함께 확인 |
| M2-3 | 새 파일 `scripts/db-migrate/scratch.mjs`에 `DROP TABLE User` | 게이트 red — 스캔이 디렉토리 전체를 본다(신규 파일도) |
| M2-4 | 스캐너 어휘 배열에서 `DELETE` 제거(게이트 약화) | **B의 자가 증명 케이스가 red** — 게이트를 느슨하게 만들면 그 사실이 잡힌다(가장 중요한 변이) |

## 금지사항

- **게이트를 '주석/식별자 오탐 회피'라는 이유로 실제 파괴 SQL까지 놓치게 좁히지 마라.** 이유: 느슨한 게이트는 없는 게이트보다 나쁘다(다음 사람이 방어가 있다고 믿는다). 좁힘은 반드시 M2-1·M2-3로 여전히 red임을 실증한 뒤에만.
- **스캔 루트를 `scripts/db-migrate/` 밖으로 넓히지 마라.** 이유: `server/**`·`src/**`는 Node 서버 정본이고 DELETE/DROP을 정당하게 가진다(예: `DELETE /api/receiver-config/:id`) — 무접촉 목록이다.
- **새 의존성으로 SQL 파서를 도입하지 마라.** 이유: baseline(의존성 0). 텍스트 스캔으로 충분하고, 정본 게이트(`contract-inventory-check.mjs`)도 텍스트 스캔이다.
- **이 게이트를 `npm test` 밖에 두지 마라.** 이유: 자동 실행되지 않는 게이트는 드리프트를 막지 못한다(`contract-inventory-gate.test.js`가 이 문제를 이미 겪었다 — 그 주석 참조).
