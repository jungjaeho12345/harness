# news-migrator

`news.db`(SQLite) → **MySQL 8.0** 이관 도구. C++/Spring 포팅 로드맵 **P2 "DB 이관"**의 산출물이고
**MySQL 스키마의 정본**(Flyway 기반선)을 이 모듈이 소유한다(ADR-016 ③).

- 리포 루트의 다른 모듈과 **분리된 독립 Maven 프로젝트**다(`server-spring`을 멀티모듈 reactor로 바꾸지 않는다 —
  `scripts/spring-contract.mjs`가 `server-spring/target/*.jar` 경로에 의존하므로 reactor 전환은 계약 하네스를 깬다).
- Java **25** · Flyway **11.0.0** · Connector/J **9.1.0** · sqlite-jdbc **3.47.2.0** · 산출물은
  shade 실행 jar **`target/news-migrator.jar`**(고정 이름).
  ⚠ shade는 `target/original-news-migrator.jar`도 함께 남긴다 — **디렉토리 스캔으로 jar를 고르지 마라**(후보가 늘 2개다).

운영 절차(부트스트랩·자격 보관·컷오버·롤백)는 **`docs/ops-mysql.md`**가 소유하고,
타입·collation 매핑과 잔여 divergence는 **`docs/db-mysql-mapping.md`**가 소유한다. 이 문서는 **도구의 계약**만 적는다.

## CLI

```
news-migrator <command> [options]

  migrate          --source <sqlite-file> --target <env-key-set>
  verify           --source <sqlite-file> --target <env-key-set>
  verify           --source <sqlite-file> --target-sqlite <sqlite-file>
  export           --target <env-key-set> --out <sqlite-file>
  ephemeral-create --name <harness_ct_…> [--target <env-key-set>]
  ephemeral-drop   --name <harness_ct_…> [--target <env-key-set>]
  help
```

| 커맨드 | 하는 일 | 비고 |
|---|---|---|
| `migrate` | 소스의 **전 행**을 대상 MySQL로 옮긴다(삽입만). | **대상이 비어 있어야 한다** — 아니면 비우지 않고 멈춘다. 7테이블 **한 트랜잭션**이라 부분 성공이 커밋되지 않는다. 끝에 자동 증가 카운터가 `max(id)+1`인지 확인한다. |
| `verify` | 소스와 대상을 **전 컬럼·전 셀** 대조한다. | 대상은 MySQL(`--target`) 또는 SQLite 파일(`--target-sqlite`) 하나만 받는다. 리포트는 **OS 임시 디렉토리**에 남는다(리포 안을 가리킬 수 없다). |
| `export` | MySQL의 현재 내용을 **SQLite `.db`** 로 내린다(역방향 · 롤백 자산). | **이미 있는 파일은 덮어쓰지 않는다.** 산출물 스키마는 `src/db/schema.js`(SQLite 정본)와 동형이라 **Node 서버가 그대로 연다**. |
| `ephemeral-create` / `ephemeral-drop` | 계약 하네스용 임시 DB를 만들고 버린다. | 이름이 **`^harness_ct_[0-9a-f]{16}$`** 가 아니면 **접속하기 전에** 거부한다. |

### 자격은 argv로 흐르지 않는다

`--target`은 **환경변수 키 집합 이름**이다(URL도 값도 아니다). 키 집합 `X`는 `X_URL` · `X_USERNAME` · `X_PASSWORD` 셋을 뜻한다.

| 키 집합 | 쓰는 곳 |
|---|---|
| `NEWS_MIGRATOR` | 사람이 도는 이관·대조·export(대상 DB는 URL이 정한다 — `news_stage` / `news`) |
| `NEWS_CT_MYSQL` | 계약 하네스의 임시 DB 생성·삭제(URL이 **서버까지만** 가리킨다) |
| `NEWS_CT_PASS` | 그 패스의 임시 DB를 가리키는 적재 대상(같은 이름이 호출마다 다른 DB를 뜻하지 않도록 이름을 나눴다) |

`--password` · `--user` · `--url` 류 옵션은 **형태 단계에서 거부**한다(프로세스 목록은 같은 머신의 누구나 읽는다).
값을 셸에 싣는 절차는 `docs/ops-mysql.md` §3이다.

### 종료코드

| 코드 | 뜻 | 런북의 처방 |
|---|---|---|
| `0` | 성공 | — |
| `1` | 실행 실패(접속·적용 중 오류 · 대상이 비어 있지 않음 · 산출물이 이미 있음) | 메시지가 지목한 전제를 갖추고 재실행 |
| `2` | 사용법 오류(모르는 커맨드·빠진 옵션·규약 밖 이름·자격을 인자로 준 경우) | 커맨드를 고친다 |
| `3` | 미구현 커맨드(**예약** — 지금 이 코드를 내는 커맨드는 없다) | 골격이 성공을 흉내 내지 않게 하는 자리 |
| `4` | 대조는 끝까지 돌았고 **불일치를 찾았다** | **`1`과 다르다** — "데이터가 다르다"와 "확인하지 못했다"는 처방이 다르다 |

## 비파괴 규율 (CLAUDE.md CRITICAL)

1. **소스는 읽기 전용이다.** 드라이버 설정(`SQLiteConfig.setReadOnly(true)`)과 **결과**(열기 전후 크기·md5 지문 대조) 두 겹으로 지킨다 —
   설정은 조용히 무시될 수 있으므로 바이트를 잰다. 부산물(`-wal`/`-shm`/`-journal`)이 이미 있으면 **시작 자체를 거부**한다.
2. **삭제 SQL이 0이다.** `DELETE`·`DROP`·`TRUNCATE`·`RENAME TABLE`·`DROP USER`를 main 소스에서 정적으로 금지한다.
3. **SQL 밖 파괴 API도 금지한다.** 이 모듈은 Flyway와 `java.nio.file`을 직접 쓰므로 SQL 텍스트만 보는 게이트는
   `flyway.clean()`(스키마 전 객체 DROP)과 `Files.delete/deleteIfExists/move`(원본 파일 자체를 지우거나 옮긴다)를 **한 글자도 못 본다**.
   그래서 게이트가 **3군**이다: ① 파괴적 SQL(예외 0) ② `DROP DATABASE`(예외 **1파일** — `EphemeralDatabase.java`) ③ SQL 밖 파괴 API(예외 0).
   맨이름·메서드 참조·끊어 쓴 문자열까지 본다.
4. **`cleanDisabled(true)`는 별개 방어선**이다(정적 스캔과 무관하게 런타임 `clean()`이 예외로 죽는다).
5. **파일을 지우지 못하므로 설계가 다르다**: 임시 파일에 쓰고 옮기기·실패 시 치우기·덮어쓰기 전에 지우기가 **전부 불가능**하다.
   그래서 export는 **최종 경로에 직접 쓰고**, 이미 있으면 접속 전에 멈추며, 중간에 실패하면 **남은 파일의 경로를 밝히고 멈춘다**(사람이 치운 뒤 재실행).
6. **서버 권한이 1차 방어선이다.** `news_migrator` 계정에는 `DELETE`도 `DROP`도 없다 — 코드에 파괴 경로가 심어져도 **서버가 거부한다**.

## 빌드 · 실행

```bash
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
java -jar tools/news-migrator/target/news-migrator.jar help
```

- **`mvnw verify`는 MySQL 서버를 요구한다**(fail-closed — 설정이 없으면 skip이 아니라 **fail**이다. ADR-016 ⑧).
  `NEWS_CT_MYSQL_*` 3키를 셸에 싣고 돌려라(`docs/ops-mysql.md` §3).
- **한글 출력이 깨지면** `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8`을 붙여라(2026-09-04 실측 — Git Bash 기본 출력이 깨졌고
  이 두 옵션으로 정상 출력됐다). Windows 콘솔은 `chcp 65001`도 함께 쓴다.
- 실행 결과 판정에 **`Tests run:`이 없으면 그 실행은 무효**다 — `mvnw.cmd`를 `cmd`로 부르면 maven이 실행조차 되지 않고 exit 1이 나서
  "전건 red"로 오독된다(step2 실측).

## 검증된 것 · 검증되지 않은 것

**검증된 것**(전부 이 리포에서 실제로 잰 값이다)

- 리포 `news.db` → `news_stage` 이관 후 **7테이블 178행 · 81컬럼 · 2,878셀 대조 불일치 0**이고 **원본은 바이트 무변**이다(step3).
- 왕복(`news.db` → MySQL → `export.db`) 대조 **불일치 0**, 산출물로 **Node 서버가 실제로 뜬다**(로그인 200 · 목록 · 상세 · 부팅 전후 md5 동일 — step4·step8).
- 매 계약 패리티 실행이 이 jar를 **도그푸딩**한다(패스마다 임시 DB 생성 → 적재 → Spring 기동). MySQL 축 **313관측 diffs 0**(step7).
- 컬럼은 **위치가 아니라 이름**으로 옮긴다(실기 `news.db`의 컬럼 순서가 정본 선언 순서와 다르다 — `ALTER ADD COLUMN` 이력 때문이다).
- 값 비교는 DB의 `=`가 아니라 **Java UTF-8 바이트**이고 행 짝짓기는 정렬이 아니라 **PK 색인**이다(둘 다 collation 의존을 없앤다).
- `flyway_schema_history`는 **명시적 제외**이고(상수 1곳이 소유) **그 밖의 예상 밖 테이블은 구조 문제로 red**다.

**검증되지 않은 것**(정직하게 남긴다)

- **운영 `news` DB로의 실제 이관** — 이 phase는 `news_stage`와 임시 DB만 만졌다. 컷오버는 P3다(`docs/ops-mysql.md` §11).
- **대용량·장시간 이관의 성능**(178행 기준의 값만 있다) · 보조 인덱스 0 상태의 조회 성능.
- **동시 접근 중의 이관**(정지 창을 전제로 한다 — 런북 §11이 Node 정지를 첫 항목으로 두는 이유다).
- 이관 중 **네트워크 단절·서버 재시작**에서의 복구 행동(트랜잭션 롤백에 기대며 그 경로를 인위적으로 끊어 보지는 않았다).
