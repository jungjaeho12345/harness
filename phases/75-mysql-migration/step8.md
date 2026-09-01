# Step 8: cutover-runbook

**운영 이관 절차와 롤백 절차**를 사람이 따라갈 수 있는 형태로 완성하고, 문서 정본(`SCHEMA.md`·`ARCHITECTURE.md`·`README`·ADR-016)을 실측에 맞춘다. **이 step은 운영 데이터를 실제로 옮기지 않는다** — 컷오버 실행은 사람의 승인·백업·정지 창이 붙는 별개 사건이며 P3 소유다.

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` · step0~step7의 summary 전부
- `docs/ops-mysql.md`(step0·step4가 만든 런북) · `docs/db-mysql-mapping.md`(step1)
- `docs/SCHEMA.md` 전문(102행) · `docs/ARCHITECTURE.md`(특히 9~48행 디렉토리 구조 · 54~83행 데이터 흐름) · `docs/ADR.md` ADR-016
- `server-spring/README.md`
- `docs/porting-plan-cpp-spring.md` §7(P2·P3 행 · **되돌림 지점**) · §8
- `tools/news-migrator/README`가 있으면 그것도

## 배경 (동결된 사실)

1. 로드맵의 되돌림 지점: **「P3 완료 전 문제 시 Node 서버로 즉시 복귀(클라 무변경)」**. 그 복귀가 성립하려면 ① 원본 `news.db`가 보존돼 있고 ② MySQL의 현재 상태를 `.db`로 내릴 수 있어야 한다(step4의 `export`).
2. 이 phase 이후 정상 상태는 **Node=SQLite / Spring=MySQL 병존**이다. 두 서버가 **서로 다른 데이터**를 갖게 되는 것이 새 위험이며, 전환기 규율(어느 쪽이 쓰기 정본인가)을 사람이 지켜야 한다.
3. `docs/SCHEMA.md`의 정본성: 테이블·컬럼 의미의 단일 출처다. **컬럼 의미를 바꾸지 말고**, MySQL 매핑을 **추가**하라.
4. ADR은 소급 수정하지 않는다 — ADR-016에 **마감 실측 문단을 덧붙이는 것**은 ADR-013이 phase마다 해 온 방식이며 허용된다.

## 작업

### A. 컷오버 런북 — `docs/ops-mysql.md` 완성

순서를 **명령 단위**로 적는다(사람이 그대로 복사해 실행할 수 있어야 한다):
1. **사전**: Node 서버 정지 · `news.db` **사본 2벌**(하나는 타임스탬프 이름으로 보관) · md5 기록.
2. `ops/mysql/bootstrap.sql` 실행 여부 확인 · 세 계정 접속 확인.
3. `migrate --source <news.db> --target news` (빈 대상이 전제 — 아니면 중단된다).
4. `verify --source <news.db> --target news` → **불일치 0 · 행 수 표**를 캡처해 보관.
5. Spring을 `DB_KIND=mysql`로 기동 · `GET /api/health` 확인 · 로그인·목록·상세·잠금·송고 육안 확인 목록.
6. **이 시점부터 Node 서버를 쓰지 않는다**(쓰면 두 저장소가 갈린다 — 그 사실을 굵게 적어라).
7. **롤백**: Spring 정지 → `export --target news --out <새 파일>` → 그 파일을 Node `DATA_DIR`에 배치 → Node 기동 → 검증. **원본 `news.db`는 절대 지우지 않는다.**
8. 실패 시나리오별 분기(마이그레이션 중단 · verify 불일치 · 기동 실패 · 부분 적재)와 각각의 안전한 다음 수.

### B. 문서 정본 갱신 (**전부 additive**)

- `docs/SCHEMA.md`: 「MySQL 매핑」 절을 **추가**한다 — 테이블/컬럼별 타입·collation·`AUTO_INCREMENT`·보조 인덱스 0 유지·**SQLite와 다른 축**(id 재사용·LIKE 대소문자·정렬 등 step1·step6이 확정한 목록). 기존 컬럼 설명은 고치지 마라.
- `docs/ARCHITECTURE.md`: 디렉토리 구조에 `tools/news-migrator/`를 추가하고, 데이터 흐름에 「Node=SQLite / Spring=MySQL 병존」을 한 줄로 명시한다.
- `server-spring/README.md`: `DB_KIND`·`NEWS_DB_*` 대응표(step6에서 이미 추가했다면 확인만) · **MySQL이 없으면 `mvnw verify`가 실패한다는 사실**과 그 이유.
- `tools/news-migrator/README.md`(신규): CLI 5 verb · 환경변수 · 종료코드 · **비파괴 규율**(읽기 전용 소스 · 삭제 SQL 0 · 예외 1파일) · 검증된 것과 검증되지 않은 것.
- ADR-016에 **마감 실측 문단**을 덧붙인다: 이관 행 수·대조 결과·MySQL 패리티 관측 수·Java 테스트 수·잔여 divergence 개수.

### C. 「계약이 못 보는 축」 인계 목록 확정

74 forward_notes (8) ①이 P2에 넘긴 숙제다. 이 phase가 확정한 목록을 **한 곳에**(ADR-016 트레이드오프 또는 `docs/db-mysql-mapping.md`) 모으고, 각 축마다 **파일·메서드 이름으로 유일 방어선**을 적는다. 최소한 이 축들이 포함돼야 한다: 정렬 순서 · LIKE 대소문자 · id 재사용 · 바인딩 표현(`2.0`) · NULL vs 빈 문자열 · 잠금/트랜잭션 · `length()` 의미 · 74가 남긴 SSE 계열 축(신호 유실·seq 역전·비연장 peek).

## Acceptance Criteria

```bash
# 문서 변경이 순수 추가인지 (삭제 행 수를 세어 기록)
git diff -U0 -- docs/SCHEMA.md docs/ARCHITECTURE.md docs/ADR.md | grep -c '^-[^-]'
# 무회귀 전건
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --parity
md5sum news.db
```

**종료 조건**
- 런북의 **롤백 절차를 실제로 1회 리허설**했다(스테이징 DB → export → 임시 `DATA_DIR` → Node 기동 → 로그인·목록 확인). 자동 판정이 불가한 항목은 **육안 확인 결과를 그대로** 적는다(「했다」가 아니라 무엇을 보았는지).
- `docs/ADR.md` 삭제 행 **0**. `docs/SCHEMA.md`·`docs/ARCHITECTURE.md`는 additive(삭제 행 수를 기록하고, 0이 아니면 그 줄이 무엇이고 왜 필요한지 밝힌다).
- 무회귀 전건 통과: Java `clean verify` Skipped 0 · sqlite `--parity` 313관측 diffs 0 · **mysql `--parity` 313관측 diffs 0**.
- C의 인계 목록이 축마다 **파일·메서드 이름**을 갖고 있다(「테스트가 있다」 같은 서술 금지).
- `news.db` md5 무변.

## 검증 절차

1. 런북을 **다른 사람이 읽는다고 가정하고** 한 줄씩 따라 실행해 본다(스테이징 대상으로). 실행 불가능한 줄·전제가 빠진 줄은 고친다.
2. 롤백 리허설에서 Node 서버는 **임시 `DATA_DIR`의 사본**으로만 띄운다 — 리포 `news.db`·`server/**`·`src/**`를 건드리지 마라.
3. 문서 변경은 `git diff -U0`의 삭제 행 수로 additive를 판정한다(`git show HEAD:<file>` 접두사 비교는 `core.autocrlf=true` 때문에 항상 실패한다 — 74 forward_notes (10) ③).
4. green 즉시 커밋한다.

## 금지사항

- **운영 `news` DB에 실제 컷오버를 실행하지 마라.** 이유: 정지 창·백업·사람의 승인이 붙는 사건이고, 이 phase의 AC는 「경로 확보」이지 「전환 완료」가 아니다(전환은 P3).
- **원본 `news.db`를 옮기거나 이름을 바꾸거나 지우지 마라.** 이유: 그것이 롤백의 마지막 보루다.
- **기존 문서의 문장을 삭제·재작성하지 마라.** 이유: 이 리포의 문서는 시점별 결정·실측의 누적이고, 소급 수정은 이력을 오염시킨다(ADR-014의 규율을 문서 전반에 적용한다).
- **「검증했다」를 근거 없이 적지 마라.** 이유: 이 phase 전체가 「실측 아니면 미검증으로 적는다」 규율 위에 서 있다.
