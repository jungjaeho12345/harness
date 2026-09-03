# P2 DB 이관 계획서 (엔진 중립 검증 토대)

> 이 문서는 phase 75(`75-p2-migration-foundation`)의 산출이다. C++/Spring 포팅 로드맵
> (`docs/porting-plan-cpp-spring.md` §7)의 **P2 'DB 이관'** 첫 슬라이스 — **대상 DB 엔진
> 결정과 무관한, DB 비파괴 이관 검증 토대**를 기록한다.
>
> **엔진은 아직 정해지지 않았다.** porting-plan §3-② 권장안은 MariaDB이나 §10 #1이 이를
> **미결(open question)**로 명시한다. 이 계획서는 그 결정을 내리지 않는다 — 권장안이 있으나
> 미결임을 정확히 인용하고, 결정은 phase index.json의 `open_questions (1)`로 남긴다.
> 결정 주체는 오케스트레이터/사용자다.

## 1. 이 phase가 만든 것 — 5개 오프라인 Node 도구

전부 `scripts/db-migrate/` 아래의 순수 추가 도구다. 새 npm 의존성 0(`node:sqlite`·`node:crypto`·
`node:test`·`node:fs`만). 크로스플랫폼 · 오프라인 · 결정적. JDK·Spring·계약 하네스가 필요 없다.

| 도구 | 파일 | 역할 | 입력 → 출력 |
|---|---|---|---|
| ① 정규 스키마 명세 | `schema-spec.mjs` + `docs/db-migration/schema-canonical.json` | **구조**(7 테이블·컬럼 순서·PK·타입군·기본값)를 `src/db/schema.js`의 `createSchema`가 만드는 **실제 스키마에서 파생**(산문 정본 파싱 0) | in-memory `createSchema` + `PRAGMA table_info` → `schema-canonical.json`. `--check`로 재생성이 커밋본과 byte-identical인지 잠근다(스키마 드리프트 감시). |
| ② 값 정규화 단일 출처 | `canonical.mjs` | 같은 논리 값이 소스 SQLite에서든 미래 대상 엔진에서든 **같은 정규형**이 되게 하는 순수 함수(`canonicalizeValue`·`rowChecksum`). NULL≠'' 전용 토큰 · integer는 BigInt 경유 십진 정수 문자열 · text는 원문 바이트 무변조 | `(typeClass, value)` → 정규형 문자열 / `(columnsInOrder, row)` → SHA-256 행 체크섬 |
| ③ 읽기 전용 소스 인벤토리 | `inventory.mjs` | 소스를 `{ readOnly: true }`로 열어 테이블별 `{ rowCount, aggregateDigest }`(+detailed면 PK→행체크섬 맵) 매니페스트 산출. **P2 '전 행 대조'의 오라클** | `<sourcePath>` → 결정적 매니페스트 JSON(경로·타임스탬프 없음) |
| ④ 엔진 중립 export | `export.mjs` | 소스 → 테이블당 1개 JSONL(값은 정규형 · 행 순서 PK 오름차순)로 **새 출력 디렉토리에만** 쓴다. §7의 '역방향(참조용) export 경로'. 라운드트립으로 inventory 매니페스트와 aggregateDigest 동일함을 잠근다 | `<sourcePath> <outDir>` → `<Table>.jsonl` × 7 |
| ⑤ 매니페스트 대조 검증 | `verify.mjs` | 두 매니페스트(소스·대상)를 받아 테이블 집합·rowCount·aggregateDigest를 대조. 불일치면 **exit 1** + 어느 테이블·어느 PK가 갈렸는지 지목. **P2 실행 phase의 운영 게이트가 이 exit 코드를 쓴다** | `<manifestA.json> <manifestB.json>` 또는 `--sources <a> <b>` |

여기에 **삭제 쿼리 0 정적 게이트**(`test/dbmigrate-nondestructive-gate.test.js`)가 `scripts/db-migrate/**`
전체에 파괴 SQL 토큰(DROP/DELETE/UPDATE/INSERT/ALTER/CREATE/REPLACE/TRUNCATE)이 문자열 리터럴로
없음과, 소스 open이 `{ readOnly: true }` 없이 열리지 않음(`:memory:` 리터럴만 면제)을 잠근다.
`npm test`에 자동 편입되어 이 디렉토리의 신규 도구를 자동으로 보호한다.

### 도구 상호관계 (데이터 흐름)

```
src/db/schema.js (createSchema — 스키마 단일 진실)
        │  (PRAGMA로 파생, 무수정)
        ▼
  ① schema-spec.mjs ──► schema-canonical.json (구조 계약: 테이블·컬럼순서·PK·typeClass)
        │                         │
        │  (테이블·컬럼·PK·typeClass 제공, 재선언 0)
        ▼                         ▼
  ② canonical.mjs ◄──────── ③ inventory.mjs ──► 소스 매니페스트
  (값 정규화 단일       │            │
   출처 — 세 도구가     │            └──(같은 정규형·같은 PK순서)──┐
   모두 import)         │                                          │
        └──► ④ export.mjs ──► JSONL (+ manifestFromExport로 라운드트립 매니페스트)
                                          │
                    (소스 매니페스트 · 대상 매니페스트)
                                          ▼
                              ⑤ verify.mjs ──► ok / exit 1 + 갈린 PK
```

핵심: **값 정규화는 canonical.mjs 한 곳뿐**이다(inventory·export·verify가 전부 import — 복제 0).
세 도구가 다른 정규형을 내면 오라클이 조용히 갈리므로, 단일 출처가 크로스엔진 패리티의 전제다.

## 2. §7 P2 완료 게이트 매핑

porting-plan §7 P2 완료 게이트: **'전 테이블 행 수·전 컬럼 값 대조 100% + 원본 파일 무변 +
역방향(참조용 export) 경로 확보'**. 각 항목이 어느 도구로 판정되는지:

| P2 완료 게이트 항목 | 판정 도구 | 방식 |
|---|---|---|
| 전 테이블 **행 수** 대조 100% | ③ inventory + ⑤ verify | 테이블별 `rowCount` 대조(COUNT(*)와 순회 수 교차검증 후 산출) |
| 전 컬럼 **값** 대조 100% | ②③⑤ (canonical→inventory→verify) | 컬럼 순서 정규형 행 체크섬을 PK 오름차순으로 접은 `aggregateDigest` 대조(순서 비의존). 갈리면 어긋난 PK 지목 |
| **원본 파일 무변** | 읽기 전용 규율 + 삭제 쿼리 0 정적 게이트 | 모든 소스 open은 `{ readOnly: true }` · 도구 테스트가 실행 전후 md5 무변 단언(런타임) · 정적 게이트가 파괴 SQL 0건 잠금(정적). 이관 후에도 원본 보존(§4-1) |
| **역방향(참조용 export) 경로** 확보 | ④ export | 소스 → 엔진 중립 JSONL. 라운드트립으로 값·순서 무손실 잠금 |
| (구조 축 — 컬럼·타입·PK) | ① schema-spec | `schema-canonical.json` `--check`로 스키마 드리프트 감시(값 오라클이 못 보는 축) |

**'구조 + 값' 전수 대조 = ①(schema-spec)과 ⑤(verify)를 함께 돌리는 것**이다. verify는 값만,
schema-spec은 구조만 본다(§4 정직한 공백 참조).

## 3. 엔진 결정 후 남는 작업 (이 phase가 하지 않은 것)

phase index.json `excluded (a)(b)(c)`이며 전부 **엔진 결정(open_questions (1)) 종속**이다.
그 결정 전까지는 착수할 수 없다(미결 기술 결정을 추측으로 박으면 기획 규율 위반).

- **(a) 엔진별 대상 매니페스트 생산기 + 적재기**: 선택된 엔진(MariaDB/PostgreSQL/SQLite)에
  실제로 **쓰는** 마이그레이터와, 그 대상에서 inventory 동형 매니페스트를 뽑는 생산기.
  verify는 이미 '주어진 대상 매니페스트를 대조'까지 완성돼 있으므로, 이 작업은 verify에
  먹일 대상 매니페스트를 만드는 절반이다.
- **(b) Flyway/Liquibase 기반선**: 엔진 결정 + 스키마 소유권 이양 결정 종속. ADR-013 ②가
  현재 Spring DDL 0을 잠그고 있고 그 해제는 별도 결정(ADR-016 참조)이다.
- **(c) 스키마 소유권의 Node→Spring 이양 실행**: ADR-016이 '판정 기준'만 정하고 이양 자체는
  P2 컷오버 phase가 한다.

**착수 조건**: `open_questions (1)`(대상 DB 엔진) 해소. 그 전까지 위 3건은 후속 phase(75b/76) 소유다.

## 4. 정직한 공백 (오라클이 못 보는 축)

이관 검증이 **무엇을 보증하지 않는지**를 명시한다(open_questions (3) · 74 forward_notes (8)).

- **verify(값)가 못 보는 구조 축**: 컬럼 타입 affinity · 자동 증가 시퀀스의 다음 값 · 인덱스
  유무 · 트리거 · 뷰. verify는 논리 값(rowCount·aggregateDigest)만 본다. 구조 축의 일부(컬럼·
  타입·PK·기본값)는 ① schema-spec의 `schema-canonical.json`이 보고, **트리거·뷰는 현행 스키마에
  없으므로 어느 도구도 보지 않는다(정직한 공백)**. 대상 엔진에서 트리거/뷰가 생기면 그때 별도
  구조 대조가 필요하다.
- **schema-spec(구조)이 못 보는 값 축**: 행 데이터 자체. 구조가 같아도 값이 다르면 verify가 잡는다.
  → **'구조 + 값' 전수 대조는 두 도구를 함께 돌려야 성립한다**(§2 마지막 줄).
- **두 서버 동시 오픈 미검증**: 74 forward_notes (8)④ — Node 서버와 Spring 서버가 같은
  `news.db`를 동시에 여는 상황은 전혀 검증되지 않았다(ADR-013 트레이드오프 · 하네스는 프로파일마다
  DB를 분리한다). P2 실행 시 이관 창(migration window) 동안의 쓰기 격리 절차가 필요하다.
- **`DistributionTargetService.checkName`의 `String.trim()` 드리프트**: 74 forward_notes (8)③ —
  Spring 측 이름 검사가 원문을 trim한다. 값 정규화(canonical.mjs)는 text를 **트림하지 않으므로**,
  이관 검증은 저장된 원문 바이트를 그대로 대조한다(정본 정렬은 P2 실행 시 별도 판단 대상 —
  이관 오라클이 trim 차이를 흡수하지 않는다는 점을 기록해 둔다).
- **계약이 못 보는 축의 이관 검증 소유권**: 74 forward_notes (8)① — 계약 스위트가 관측하지 못하는
  축(키 설정 경로·시간축·동시성)은 이관 대조에서도 값 오라클 밖이다. 그 축의 이관 후 정합은
  Java/Node 단위 테스트가 소유하며, 이관 검증은 저장된 값의 동일성만 보증한다.
- **대용량 성능 미측정**: excluded (f) — 스트리밍 임계·배치 크기는 정확성 뒤의 문제다. 실제
  `news.db` 크기가 확인되는 P2 실행 phase가 대용량 실측을 소유한다.

## 5. 실제 news.db 실행 절차 초안

**중요 — 리포에 `news.db`가 없다.** tracked `.db` 0건 · 리포 루트에 파일 없음 · `data/` 폴더 없음.
`news.db`는 서버 기동 시 `server/index.js`가 `DATA_DIR`에 만드는 **운영 파일**이며 커밋되지 않는다.
그래서 이 phase의 모든 도구 테스트는 `createSchema`로 만든 임시 SQLite에 결정적 픽스처를 넣어
소스로 삼는다(오프라인·재현 가능). **실제 news.db에 대한 실행은 이 phase가 수행하지 않았다** —
그것은 P2 실행 phase(엔진 결정 후)가 운영 게이트로 수행한다.

운영 절차 초안(엔진 결정 후):

```bash
# 0) 이관 창 진입 — 소스에 대한 쓰기를 멈춘다(두 서버 동시 오픈 격리 · §4).
#    원본 news.db는 이관 후에도 보존한다(§4-1 · CLAUDE.md 최상위 규칙: 삭제 금지).

# 1) 소스 인벤토리(읽기 전용) — 전 행 대조의 소스측 오라클.
node scripts/db-migrate/inventory.mjs "$DATA_DIR/news.db" --detailed --out source.manifest.json

# 2) 역방향(참조용) export — 엔진 중립 JSONL 참조본 확보.
node scripts/db-migrate/export.mjs "$DATA_DIR/news.db" ./neutral-export

# 3) (엔진 결정 후 · excluded (a)) 대상 엔진에 적재 + 대상 매니페스트 생산.
#    → 대상 inventory 동형 매니페스트 target.manifest.json 산출.

# 4) 대조 게이트 — 전 테이블 행 수·전 컬럼 값 100% 일치 판정.
node scripts/db-migrate/verify.mjs source.manifest.json target.manifest.json ; echo "exit=$?"
#    exit 0 이어야 이관 성공. exit 1이면 어느 테이블·어느 PK가 갈렸는지 출력된다.

# 5) 구조 대조 — 값 오라클이 못 보는 구조 축(§4)을 schema-canonical로 확인.
node scripts/db-migrate/schema-spec.mjs --check ; echo "exit=$?"

# 6) 원본 무변 확인 — 이관 전후 news.db md5 동일(읽기 전용 규율의 운영측 재확인).
#    원본은 절대 삭제하지 않고 보존한다(§4-1).
```

스키마 소유권 이양(Node→Spring)은 ADR-016의 판정 기준(대조 게이트가 대상 엔진에서 100% green)을
충족한 뒤 P2 컷오버 phase가 실행한다 — 이 계획서 범위 밖이다.
