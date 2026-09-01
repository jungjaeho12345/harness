# Step 9: closeout

마감 실측을 **연속 2회** 뜨고, 이 phase가 심은 게이트들의 **비공허성을 교차 변이로 재확인**하고, 다음 단계(P3)에 넘길 `forward_notes`를 쓴다. **새 기능을 만들지 않는다.**

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` 전문 + step0~step8의 summary 전부
- `phases/74-spring-sse/index.json`의 `forward_notes`(형식·정직성의 기준선 — 특히 (5) divergence 전수 · (6)(6b) 미검증 공백 · (7) 누적 이월 · (8) P2 인계)
- `docs/ADR.md` ADR-016 · `docs/db-mysql-mapping.md` · `docs/ops-mysql.md`
- `docs/porting-plan-cpp-spring.md` §7 P2·P3 행

## 배경 (동결된 사실)

1. **이 phase의 기준선(2026-09-02 `feat-75-mysql-migration` @ `9df5381`에서 직접 재측정)**: Java `clean verify` **Tests run 1366 / Failures 0 / Errors 0 / Skipped 0** BUILD SUCCESS(4:43) · jar 35,800,437 B · `--parity` exit 0 profiles=5 **313관측 diffs 0**(default 246 cases=209 covered=32/39 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) · 리포 `news.db` 606,208 B md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967`.
2. **마감 판정 규약**: 감소 0 · skip 0 · flake는 **재실행 2회 연속 green**으로 판정 · 미검증은 정직하게 기록.
3. **게이트 통과는 허가가 아니다**: 이 리포의 정적 스캔은 71a 12/12 · 72 11/11 · 73 8/10 · 74 2건이 **전부 green인 채로 뚫렸다**. 마감에서 변이를 심어 red를 본 것만 「지켜지고 있다」고 적어라.

## 작업

### A. 마감 실측 — **연속 2회 동일**해야 한다

아래를 두 번 돌려 수치가 같은지 확인하고, 두 회차의 수치를 **둘 다** 기록한다.

```bash
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --dual-run
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --parity
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --dual-run
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --require-full-coverage
node scripts/contract-inventory-check.mjs --require-spec-paths
npm test && npm run lint && npm run build
md5sum news.db && ls -l news.db
java -jar tools/news-migrator/target/news-migrator-*.jar verify --source news.db --target <staging>
```

기록할 항목: Java 두 모듈의 `Tests run`·skip 0 · jar 크기 · 각 하네스 실행의 관측 수·diffs·프로파일별 내역 · 합산 커버리지 · `npm test` 수 · 인벤토리 routes/spec-paths · **`news.db` md5·크기** · `uploads/` 항목 수·바이트 · **이관 대조 표(7테이블 · 178행 · 불일치 0)** · **잔존 `harness_ct_*` DB 0개**.

### B. 교차 변이 재확인 (게이트가 살아 있는지)

각 변이를 심어 **red를 확인하고 원복**한다. 결과표(변이 → 기대 → 실제)를 기록한다. **최소 8종**:
1. 마이그레이터 main에 `DELETE FROM Contents`(원문) → red.
2. 같은 것을 **문자열을 끊어 쓴 형태**로 → red(원문만 보는 정규식은 놓친다).
3. `ephemeral-drop`의 이름 가드를 넓혀 `news`를 넘김 → 거부(하네스·마이그레이터 양쪽).
4. `verify`의 컬럼 비교를 DB `=`(collation 의존)로 교체 → 대소문자만 다른 값이 통과하는가.
5. `NewsDataSource` 밖에 `jdbc:sqlite` 철자 → 방언 단일 지점 스캔 red.
6. MySQL collation을 `utf8mb4_0900_ai_ci`로 → 정렬/LIKE 차등 테스트 중 몇 개가 red인가(개수·이름).
7. `--db mysql`에서 `DB_KIND` 주입을 빼 Spring이 sqlite로 뜨게 함 → **무엇이 잡는가**(step7 M1의 재확인 — 잡는 것이 없으면 그 사실이 forward_notes의 1급 항목이다).
8. `MysqlConfiguredGuardTest`의 fail-closed를 skip으로 바꿈 → 전체 스위트가 MySQL 없이 green이 되는가(= 게이트 공허화 경로가 열려 있는가).
9. (있다면) `Adr008DisciplineTest`·`NoSchemaSqlInMainSourcesTest`가 **0줄 변경**임을 `git diff`로 재확인.

### C. `forward_notes` 작성 — P3에 넘긴다

74의 형식을 승계한다. 최소 다음을 담는다:
1. **마감 실측 전문**(A의 전 수치 · 연속 2회 · 툴체인 표기).
2. **P2 완료 게이트 대비 판정**: 전 테이블 행 수·전 컬럼 값 대조 100%(수치) · 원본 파일 무변(md5) · 역방향 export 경로 확보(왕복 대조 결과) — **각각을 어떤 커맨드가 증명했는지** 함께.
3. **divergence 전수**(고치지 않고 기록): step1·step6이 「완전 일치 불가」로 판정한 축 전부 + 각 축의 **유일 방어선(파일·메서드)**. 74의 누적 이월 목록(경로 정규화 · 본문 크기 상한 · 304/ETag · 부트 백필 미이식 · FTP 스풀 수집 · 다중 인스턴스 tick · `HttpRequest.timeout` · `Date.parse` · `2.0` 표기 · Node 주석의 ADR 오인용)을 **승계해 다시 적는다**(새 결함으로 보고하지 마라).
4. **미검증(정직한 공백)**: 최소 — 실운영 규모 데이터에서의 이관 시간 · 동시 접속 다수에서의 InnoDB 잠금 동작 · 커넥션 풀 1의 성능 상한 · 보조 인덱스 0의 조회 성능 · 문자셋 경계값(4바이트 이모지·서로게이트) · MySQL 백업/복제 운영 · `helmet` 등가 보안 헤더 11종(P3 소유, 여전히 공백).
5. **P3 인계**: ① 운영 컷오버 실행(정지 창·백업·승인) ② Node 서버 은퇴 시점과 `sqlite-jdbc`·sqlite 분기 제거 판단 ③ 커넥션 풀 확대 여부(ADR 필요) ④ 보안 헤더 ⑤ `DistributionTargetService.checkName`의 `String.trim()`(74가 넘긴 항목 — 여전히 유효한가 확인) ⑥ 두 저장소 병존 기간의 쓰기 정본 규율.
6. **환경 함정 승계**: VS Code App Modernization의 `git stash -u` 사고(green 즉시 커밋) · `git add -A` 금지 · `core.autocrlf` · `mvnw verify`와 하네스 동시 실행 금지 · `clean` 없는 `test-compile` · Bash 인라인 한글 exit 127 · MySQL `max_connect_errors=100`.

### D. `index.json` 마감

- 모든 step `status`를 확인하고, `baseline`이 실측과 다르면 실측으로 정정한다.
- `phases/index.json`(top-level)의 `75-mysql-migration` 항목 `note`에 마감 요약을 적는다(형식은 73·74 항목을 따른다). **`status` 전환과 타임스탬프는 실행 엔진이 기록한다 — 직접 넣지 마라.**

## Acceptance Criteria

```bash
# A의 커맨드 전부를 연속 2회
# 그리고 무접촉 최종 확인
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json docs/news.md spikes news.db
git diff --stat -- server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java server-spring/src/test/java/harness/news/service/Adr008DisciplineTest.java
git status --porcelain
```

**종료 조건**
- A의 전 커맨드가 **2회 연속 동일 수치로 통과**하고 그 수치가 기록됐다(감소 0 · skip 0).
- **mysql `--parity`·`--dual-run` 313관측 diffs 0** · 합산 커버리지 **39/39**.
- 이관 대조 **7테이블 · 178행 · 불일치 0** · 원본 `news.db` md5 무변 · 잔존 `harness_ct_*` 0개.
- 무접촉 목록 diff 0 · `NoSchemaSqlInMainSourcesTest`·`Adr008DisciplineTest` **0줄**.
- **B의 변이 결과표 전건 기록** · **C의 `forward_notes` 6항 작성 완료**. 미기록 시 미완.
- `git status --porcelain`에 의도하지 않은 파일이 없다(`.vscode/` 등).

## 검증 절차

1. `mvnw verify`와 하네스를 **동시에 돌리지 마라**. 순차로.
2. 수치가 두 회차에서 다르면 flake다 — 원인을 적고, 판정은 **2회 연속 green**을 다시 시도해 확정한다.
3. 변이는 **하나씩** 심고 원복 후 다음 것을 심는다(동시에 심으면 어느 게이트가 잡았는지 알 수 없다).
4. green 즉시 커밋한다.

## 금지사항

- **새 기능·새 리팩터를 넣지 마라.** 이유: 마감 측정의 기준선이 흔들린다.
- **미검증을 검증된 것처럼 적지 마라.** 이유: forward_notes는 다음 phase가 그대로 신뢰하는 문서다 — 74의 「계약이 잡는다」 거짓 주장이 ②에서 revise로 잡힌 전례가 있다.
- **수치를 계획서에서 베껴 적지 마라.** 이유: 마감 실측은 그 시점의 트리에서 나와야 한다.
- **PR 생성·머지를 하지 마라.** 이유: 공유 `feat-0-mvp`로의 머지는 사용자 명시 승인이 필요하고 오케스트레이터의 판단 영역이다.
