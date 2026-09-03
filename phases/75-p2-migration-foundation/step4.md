# Step 4: verify-and-handoff

두 매니페스트를 대조해 '전 행 대조 100%'를 기계 판정하는 검증 하네스(`verify.mjs`)를 만들고, P2 이관 계획서와 ADR-016을 신설해 엔진 결정 유보를 명문화한다. 이 step으로 P2 검증 토대가 완결되고, 엔진 결정 후 착수할 실행 phase에 필요한 문서가 갖춰진다.

## 읽어야 할 파일

**계획 문서**
- `phases/75-p2-migration-foundation/index.json` — `scope`·`decisions` (1)(5)(7)·`excluded`·`open_questions` (1)(2)(3)·`forward_notes`(비어 있음 — 이 step 완료 시 채운다).
- 이전 step 전부(step0~step3) — verify가 쓰는 도구들.

**직전 step 산출물**
- `scripts/db-migrate/inventory.mjs`·`canonical.mjs`(step1) · `scripts/db-migrate/schema-spec.mjs`(step0) · `scripts/db-migrate/export.mjs`(step3).

**정본(무수정 — 읽기만)**
- `docs/porting-plan-cpp-spring.md` — **§3-②**(DB 권장안 MariaDB — 미결) · **§7 P2 행**(완료 게이트) · **§8**(검증 전략 — 척추) · **§10 #1**(엔진 미결) · §4-1(DB 비파괴 불변식).
- `docs/ADR.md` — **ADR-013 ②**('스키마 소유자는 P2까지 Node' · DDL 0) · **ADR-014·ADR-015**(순수 추가 ADR의 형식·문체 선례) · CLAUDE.md 최상위 규칙.
- 74 `phases/74-spring-sse/index.json` `forward_notes` **(8) P2 인계** — ① 계약 미관측 축 ③ `DistributionTargetService.checkName`의 `String.trim()` ④ 두 서버가 같은 news.db 동시 오픈 ⑤ 스키마 소유권 이양 시점.

## 배경 (동결된 사실)

1. **§7 P2 완료 게이트**: '전 테이블 행 수·전 컬럼 값 대조 100% + 원본 파일 무변 + 역방향(참조용 export) 경로 확보'. 이 phase가 그 판정 도구를 다 만들었고(inventory=행수·체크섬 · export=역방향 · verify=대조) 원본 무변은 읽기 전용 규율 + step2 게이트가 지킨다. **verify가 마지막 조각(대조)이다.**
2. **verify는 엔진 중립이다** — 두 매니페스트(소스 것 · 대상 것)를 받아 대조할 뿐, 어느 엔진에서 왔는지 모른다. 대상 매니페스트를 **생산하는** 엔진별 도구는 excluded (a)이며 엔진 결정(open_questions (1)) 후 후속 phase가 만든다. 이 분리가 이 phase를 엔진 결정과 독립시킨다.
3. **verify가 보는 것(값)과 schema-spec이 보는 것(구조)의 경계**(open_questions (3)): verify는 rowCount·aggregateDigest(=값)만 본다. 구조(컬럼·타입·PK·인덱스)는 schema-canonical 명세가 본다. 두 도구를 함께 돌려야 '구조 + 값' 전수 대조다. 문서가 이 경계를 명시한다.
4. **ADR-016은 순수 추가**(decisions (7)) — `docs/ADR.md`의 한 자리(파일 끝 또는 ADR-015 뒤)에만 붙이고 기존 ADR 본문은 무수정. core.autocrlf 때문에 `git show HEAD:docs/ADR.md` 접두사 비교는 실패하므로 `git diff -U0 -- docs/ADR.md`의 **삭제 행 수 0**으로 순수 추가를 판정한다(74가 쓴 방법).

## 작업

### A — 검증 하네스 (`scripts/db-migrate/verify.mjs`)

```js
// 두 매니페스트를 대조한다. 반환: { ok, tables: [{ name, rowCountMatch, digestMatch, mismatchedPks? }], summary }
// - 테이블 집합 대조(한쪽에만 있는 테이블 = 불일치)
// - 테이블별 rowCount 대조
// - 테이블별 aggregateDigest 대조; 다르고 양쪽이 detailed면 어긋난 PK 목록 산출
export function verifyManifests(sourceManifest, targetManifest): object

// 편의: 두 소스 경로(또는 export 디렉토리)에서 매니페스트를 만들어 대조.
export function verifySources(a, b, { detailed = true } = {}): object
```

- CLI: `node scripts/db-migrate/verify.mjs <manifestA.json> <manifestB.json>` 또는 `--sources <a> <b>`. **일치면 exit 0, 불일치면 exit 1 + 어느 테이블·어느 PK가 갈렸는지 출력**(P2 실행 phase의 운영 게이트가 이 exit 코드를 쓴다). 인자 파싱 직접.
- **읽기만** — 매니페스트 JSON 읽기, 소스 SQLite는 `{readOnly:true}`. 아무것도 쓰지 않는다.

### B — 테스트 (먼저 작성한다 — TDD)

`test/dbmigrate-verify.test.js`. red 확인 후 구현.

최소 항목:
1. 같은 소스에서 낸 두 매니페스트: `ok:true` · exit 0.
2. 한 테이블에서 한 행의 한 컬럼 값이 다른 두 소스: `ok:false` · 그 테이블 `digestMatch:false` · `mismatchedPks`에 정확히 그 PK.
3. rowCount가 다른 경우(한쪽에 행 추가): `rowCountMatch:false`.
4. 테이블 하나가 없는 매니페스트: 테이블 집합 불일치로 `ok:false`.
5. **순서 비의존**: INSERT 순서만 다른 두 소스는 `ok:true`(step1 aggregateDigest 성질의 통합 실증).
6. **export ↔ inventory 교차**: `export.mjs`로 만든 매니페스트와 `inventory.mjs`로 만든 매니페스트가 `ok:true`(도구 간 정합).
7. CLI가 불일치에 exit 1, 일치에 exit 0(운영 게이트 계약).

### C — P2 이관 계획서 (`docs/db-migration/P2-migration-plan.md`)

내용(문서 — 코드 아님):
- **이 phase가 만든 것**: 5개 도구의 역할·입출력·상호관계(schema-spec → inventory → export → verify · canonical 단일 출처 · nondestructive 게이트).
- **P2 완료 게이트(§7) 매핑**: 각 게이트 항목이 어느 도구로 판정되는지 표.
- **엔진 결정 후 남는 작업**(excluded (a)(b)(c)): 엔진별 대상 매니페스트 생산기·적재기·Flyway 기반선·스키마 소유권 이양 — 착수 조건은 open_questions (1) 해소.
- **정직한 공백**(open_questions (3) · 74 forward_notes (8)): verify가 못 보는 구조 축, schema-spec이 못 보는 값 축, 두 서버 동시 오픈 미검증, `DistributionTargetService.checkName` trim 드리프트(P2 실행 시 정본 정렬 대상), 계약이 못 보는 축 목록의 이관 검증 소유권.
- **실제 news.db 실행 절차 초안**: DATA_DIR의 운영 파일을 읽기 전용으로 inventory → export → (엔진 결정 후) 대상 적재 → 대상 inventory → verify exit 0. 원본은 이관 후에도 보존(§4-1).

### D — ADR-016 신설 (`docs/ADR.md` 순수 추가)

decisions (7)의 내용을 ADR-014·ADR-015 문체(결정/이유/트레이드오프)로 기록:
- **결정**: P2 DB 이관은 읽기 전용 소스 + 신규 대상 쓰기 · 원본 보존 · 엔진 중립 체크섬 오라클로 전 행 대조 · additive만(대상에서도 DROP/DELETE 마이그레이션 금지) · **스키마 소유자는 P2 컷오버까지 Node**(ADR-013 ② 승계)이며 이양 판정 기준 기본안은 '대조 게이트가 대상 엔진에서 100% green'(open_questions (2)). **엔진 선택(§3-②)은 이 ADR이 결정하지 않고 미결로 명시 인용**한다.
- **이유**: DB 비파괴는 5개 문서 중복 명문화된 최상위 규칙 · 엔진 중립 오라클이라야 어느 엔진을 골라도 판정 도구를 재사용 · 명세를 코드에서 파생해야 산문 드리프트가 스키마로 새지 않는다.
- **트레이드오프**: 엔진 결정 전이라 실제 마이그레이터가 없어 대조는 '대상 매니페스트가 주어지면'까지만 검증된다 · 체크섬 오라클은 값만 보고 구조는 schema-spec이 따로 본다 · 실제 대용량 news.db 실행 성능은 미측정.

### E — 완료 인계 (index.json `forward_notes` 채우기)

이 step 완료 시 `phases/75-p2-migration-foundation/index.json`의 `forward_notes`(현재 `[]`)에 실측·인계를 채운다: 도구 5종 최종 실측(테스트 수·실행 예) · 엔진 결정이 여전히 블록하는 목록 · verify/schema-spec 경계 · 실제 news.db 미실행(리포에 없음) · 다음 phase 최우선 입력.

- **오직 `forward_notes`만 append한다.** `status`·`summary`·`completed_at`·기타 타임스탬프 등 오케스트레이터/execute.py가 자동 기록하는 필드는 **손대지 마라**(수동으로 채우면 실행 엔진의 기록과 충돌한다).

## Acceptance Criteria

```bash
# 1) 전체 테스트 green (5개 도구 + 게이트 전건)
npm test

# 2) verify CLI 게이트 계약: 같은 소스 exit 0
#    (테스트가 임시 소스로 이 경로를 이미 덮지만, 스모크로 확인)
#    일치 케이스 exit 0 / 불일치 케이스 exit 1 을 테스트가 단언한다

# 3) 린트
npm run lint

# 4) ADR-016 순수 추가 — 삭제 행 0
git diff -U0 -- docs/ADR.md | grep -c '^-[^-]' ; echo "삭제행수 위 값(0이어야 함)"

# 5) 무접촉 경로 — 정본 0줄
git diff --stat -- src server server-spring contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs scripts/spring-contract.mjs docs/SCHEMA.md docs/news.md docs/porting-plan-cpp-spring.md web client package.json

# 6) 이전 step 산출물 무회귀
node scripts/db-migrate/schema-spec.mjs --check ; echo "exit=$?"
```

**종료 조건 — 변이 결과표 + 5개 도구 최종 실측을 summary에 기록하고 index.json forward_notes를 채운다.**

## 검증 절차 (변이)

| 변이 | 심는 곳 | 기대 |
|---|---|---|
| M4-1 | verify가 aggregateDigest를 비교하지 않고 rowCount만 | 항목 2 red(값이 달라도 통과 = 거짓 green) |
| M4-2 | 불일치에도 exit 0 반환 | 항목 7 red(운영 게이트 무력화) |
| M4-3 | 테이블 집합 대조 제거 | 항목 4 red(테이블 누락을 못 봄) |
| M4-4 | `docs/ADR.md`에서 기존 ADR-015 한 줄 삭제 | AC 4 red(순수 추가 위반 — 기존 본문 무수정 규율) |

## 금지사항

- **엔진별 적재기·Flyway·소유권 이양 실행을 만들지 마라.** 이유: excluded (a)(b)(c) · open_questions (1) 미결. verify는 '주어진 대상 매니페스트를 대조'까지다.
- **불일치를 exit 0으로 접지 마라.** 이유: P2 실행 phase의 운영 게이트가 이 exit 코드로 이관 성공을 판정한다(M4-2가 실증).
- **`docs/ADR.md`의 기존 ADR 본문을 고치지 마라.** 이유: ADR은 시점 기록이고 소급 수정은 이력을 오염시킨다(순수 추가만 — AC 4로 잠금).
- **`docs/porting-plan-cpp-spring.md`·`docs/SCHEMA.md`·`docs/news.md`를 고치지 마라.** 이유: 정본 무접촉. 이 phase는 새 문서(`docs/db-migration/**`)와 ADR 추가만.
- **P2 계획서에 '엔진을 MariaDB로 정했다'고 쓰지 마라.** 이유: §10 #1은 미결이다. 계획서는 '권장안이 있으나 미결'로 정확히 인용하고 결정은 open_questions로 남긴다.
