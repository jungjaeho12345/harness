# Step 3: row-copy-verify

마이그레이터의 본체 — **읽기 전용 소스에서 전 행을 복사**하고 **전 테이블 행 수·전 컬럼 값을 100% 대조**한다. 이 step이 로드맵 P2 완료 게이트(AC)의 절반을 충족한다.

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` · `step1.md` · `step2.md`와 두 step의 summary
- `docs/db-mysql-mapping.md` (step1 확정 매핑)
- `tools/news-migrator/` 전부 (step2 산출물 — CLI 계약 · baseline SQL · 정적 게이트)
- `src/db/schema.js`
- `docs/SCHEMA.md` (테이블·컬럼 의미 · 76행의 ReceiverConfig 삭제 예외)
- `server-spring/src/main/java/harness/news/model/ColumnValues.java`

## 배경 (동결된 사실)

1. **소스 실측(2026-09-01)**: 리포 `news.db` = **606,208 B · md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967`** · 7테이블 · **총 178행**(Article 77 · ArticleHistory 12 · Contents 77 · DistributionTarget **0** · Photo 1 · ReceiverConfig **0** · User 11). `typeof()`는 text/null/integer 3종뿐. `Article.markupVersion` 최대 165,802바이트. 빈 문자열과 NULL이 같은 컬럼에 공존한다.
2. **빈 테이블이 2개**(DistributionTarget · ReceiverConfig)라 「행 수 0도 대조 대상」이다 — 0행 테이블을 건너뛰면 대조가 조용히 공허해진다.
3. 원본 파일 **바이트 무변**이 완료 게이트다. SQLite JDBC는 파일이 없으면 **조용히 새로 만들고**, 쓰기 모드로 열면 `-wal`/`-shm`/`-journal` 부산물을 남긴다.

## 작업

### A. 읽기 전용 소스 접근 (TDD — 테스트 먼저)

- SQLite 소스는 **읽기 전용으로만** 연다. 최소 2겹으로 잠근다: ① JDBC URL 수준의 읽기 전용(`org.xerial:sqlite-jdbc`의 read-only 설정 — **실측으로 확인하라**: 잘못된 파라미터는 조용히 무시된다. 쓰기를 시도해 **실제로 실패하는지** 테스트로 단언한다) ② 실행 전후 **소스 파일의 크기·md5·mtime을 마이그레이터 자신이 측정해 비교**하고, 달라지면 **비정상 종료 + 진단**.
- 소스에 `-wal`/`-shm`/`-journal` 부산물이 생기지 않았음을 단언한다.
- 소스 파일이 없으면 **만들지 말고 실패**한다(경로 오타가 빈 DB를 만들고 「0행 이관 성공」으로 끝나는 사고를 막는다).

### B. 행 복사 (`migrate` verb)

- 순서: baseline(Flyway) 적용 → 테이블별 전 행 SELECT → 배치 INSERT.
- **fail-closed 선행 검사**: 대상 테이블에 이미 행이 있으면 **TRUNCATE/DELETE 하지 말고 중단**한다(멱등성을 삭제로 사는 것이 이 리포에서 가장 위험한 지름길이다). 재실행하려면 사람이 빈 대상 DB를 준비한다.
- **값 보존 규칙**(각각 테스트로 잠근다):
  - **NULL과 빈 문자열을 구별해 옮긴다**(`setString(null)` vs `setString("")`). 이 둘을 뭉개면 `embargoAt`(빈 문자열 52행 · NULL 10행 실측)의 엠바고 판정이 조용히 바뀐다.
  - 정수 컬럼(`ArticleHistory.id`·`targetId`, 각 테이블의 `id`)은 **정수로**, 나머지는 **문자열 그대로**. SQLite에서 읽은 값을 문자열화하는 위치를 하나로 모아라(두 벌이 되면 표현이 갈린다).
  - **id를 재발번하지 마라** — 소스의 `id` 값을 그대로 삽입한다(`ArticleHistory.id`는 이력 원장의 순서 키다). 삽입 후 `AUTO_INCREMENT` 다음 값이 `max(id)+1`인지 확인한다(안 그러면 이관 직후 첫 삽입이 PK 충돌로 죽는다).
  - 165,802바이트 본문이 잘리지 않고 들어간다(step1 측정 7·8의 결론을 그대로 쓴다).
- 트랜잭션 경계와 배치 크기를 정하고 근거를 주석에 남긴다. **부분 성공을 성공으로 보고하지 마라.**

### C. 대조 검증 (`verify` verb) — 이 phase의 핵심 산출물

- **테이블별 행 수** 비교(0행 테이블 포함 7/7).
- **전 컬럼 값** 비교: PK로 정렬해 행 단위로 맞추고, 컬럼마다 ① NULL 여부 ② 문자열 동일성(**바이트 단위** — collation에 기대지 말고 Java 쪽에서 비교하라. DB의 `=`로 비교하면 collation이 다른 두 값을 같다고 보고한다) ③ 정수 값 동일성.
- **결과 리포트**를 파일로 낸다(리포 밖 경로): 테이블별 행 수 · 비교한 컬럼 수 · 불일치 목록(불일치는 **컬럼·PK·양쪽 값의 길이**까지 — **값 자체를 로그에 쏟지 마라**, 본문·비밀번호 해시가 섞인다).
- 종료코드: 불일치 1건이라도 있으면 **0이 아니다**.
- `verify`는 **읽기만** 한다(A의 읽기 전용 규율을 소스·대상 양쪽에 적용).

### D. 실제 이관 리허설 — 리포 `news.db` → 전용 스테이징 DB

- 대상은 **운영 `news` DB가 아니라 step0 부트스트랩이 만든 스테이징 DB `news_stage`** 다(계정은 `news_migrator`). **여기서 대상을 새로 정하지 마라** — step0이 그 DB와 grant를 이미 만들어 두었고, 다른 대상을 고르면 root 재실행이 필요한 중도 blocked가 된다. `harness_ct_*`는 쓰지 않는다(하네스가 만들고 지우는 공간이라 리허설 산출물이 실행 도중 사라질 수 있다). **운영 컷오버는 step8 런북이 소유한다.**
- 소스는 **리포 `news.db` 원본**을 읽기 전용으로 연다(이것이 「원본 무변」 AC의 실증이다). 겁이 나면 사본으로 먼저 돌려 보되 **최종 측정은 원본으로** 한다.

## Acceptance Criteria

```bash
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
# 이관 리허설 (자격증명은 환경변수 · 비밀번호는 argv 금지)
md5sum news.db                      # 실행 전
java -jar tools/news-migrator/target/news-migrator-*.jar migrate --source news.db --target news_stage
java -jar tools/news-migrator/target/news-migrator-*.jar verify  --source news.db --target news_stage
md5sum news.db && ls -l news.db     # 실행 후 — 반드시 동일
ls news.db-wal news.db-shm news.db-journal 2>&1   # 전부 없어야 한다
# 무회귀
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
```

**종료 조건**
- `verify` **exit 0** · 리포트가 **7/7 테이블 · 총 178행 · 불일치 0**을 보고한다(행 수는 실측값이 정본이다 — 다르면 그 값을 적고 이유를 밝혀라).
- `news.db` md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` · **606,208 B 무변** · 부산물 파일 0개.
- `migrate`를 **빈 대상이 아닌 곳에 두 번째로** 돌리면 **중단(비-0 종료)** 한다.
- 마이그레이터 모듈 `clean verify` BUILD SUCCESS · Skipped 0. `server-spring` 무회귀. `--parity` diffs 0 · 관측 수 step0과 동일.
- **변이 전건 결과표 기록.** 미기록 시 미완.

## 검증 절차

**변이 검증(최소 8종 · 전건 결과표 필수)** — 심어 red를 보고 원복한다.

> **⚠ 변이를 어디서·어떤 자격으로 돌리는가(역할 분리 — 이걸 틀리면 결과표를 채울 수 없다).**
> M1·M2·M3·M5처럼 **대상 행을 변조·삭제해야 하는 변이**는 `news_stage`에서 할 수 없다 — `news_migrator`에는 `UPDATE`·`DELETE` 권한이 **없고**(step0 부트스트랩) 그것이 이 설계의 의도다.
> ⇒ **변이 실험은 `news_ct` 자격으로 `harness_ct_<16hex>` 임시 DB에서 수행한다**(그 계정은 그 접두사 안에서 ALL 권한이라 자유롭게 변조·원복·폐기할 수 있고, 실험이 끝나면 DB째로 지운다 — 원복 실수의 폭발 반경이 0이다).
> ⇒ **`news_stage`는 「최종 1회 실측」 전용**이다: 리포 `news.db`를 소스로 한 `migrate` + `verify`의 AC 측정에만 쓰고, **그 DB에 변이를 심지 마라**(심으면 되돌릴 권한이 없어 다시 채우지 못한다).
> 각 변이 항목에 **어느 DB·어느 자격으로 돌렸는지**를 결과표 열로 남겨라.

- M1: 한 컬럼의 값을 대상에서 1글자 바꾸면 `verify`가 red인가(**어느 컬럼·어느 테이블에서 재현했는지 적어라**).
- M2: NULL을 빈 문자열로 바꿔 넣으면 `verify`가 red인가. 반대 방향도.
- M3: 한 행을 통째로 빼면 행 수 대조가 red인가.
- M4: **0행 테이블 2개를 대조 대상에서 빼면** 어떤 단언이 red가 되는가(안 되면 대조가 공허하다).
- M5: 165,802바이트 본문을 1바이트 자르면 red인가.
- M6: 소스를 **쓰기 모드**로 열도록 바꾸면 읽기 전용 단언이 red인가. md5 가드가 red인가.
- M7: `migrate`가 대상 비어 있음 검사를 건너뛰게 하면 이중 실행이 PK 충돌/중복으로 어떻게 끝나는가(그리고 그것이 **성공으로 보고되지 않는지**).
- M8: 대조를 DB의 `=`(collation 의존)로 바꾸면 대소문자만 다른 값이 통과하는가 — **통과하면 그 설계는 채택하지 마라**.

green 즉시 커밋한다.

## 금지사항

- **소스 `news.db`를 쓰기 모드로 열지 마라.** 이유: 원본 바이트 무변이 완료 게이트이고, WAL 전환은 파일 자체를 변형해 되돌리기 어렵다(`NewsDataSource` javadoc이 같은 이유를 적는다).
- **대상 테이블을 비우지 마라(`TRUNCATE`·`DELETE`·`DROP` 전부).** 이유: 최상위 규칙이며 step2의 정적 게이트가 이미 red를 낸다.
- **불일치를 「무시 가능」으로 분류하지 마라.** 이유: AC가 100% 대조다. 정말 무시 가능하다면 그것은 **매핑 규칙의 결함**이고 step1 표를 고쳐야 한다.
- **불일치 로그에 값 원문을 쏟지 마라.** 이유: 본문·bcrypt 해시·수집 비밀이 로그로 샌다.
- **운영 `news` DB에 이 step에서 적재하지 마라.** 이유: 컷오버는 사람의 승인과 순서(백업·정지·검증)가 붙는 별개 절차다(step8).
