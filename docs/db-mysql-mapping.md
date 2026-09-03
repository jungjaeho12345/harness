# SQLite → MySQL 8.0 매핑표 (phase 75 step1 실측)

> 이 문서는 **추측이 아니라 측정**이다. 모든 값은 2026-09-03 에 이 머신의 **MySQL 8.0.46** 과
> **sqlite-jdbc 3.47.2.0** 에서 같은 입력을 나란히 돌려 얻었다. 측정은 전부 JUnit 테스트로 굳어 있고
> (`server-spring/src/test/java/harness/news/db/dialect/`) 값이 달라지면 그 테스트가 red 다 —
> **문서는 회귀를 잡지 못하므로 문서만 고치지 마라.**

## 0. 한 줄 결론

| 항목 | 결정 | 근거 |
|---|---|---|
| 문자셋 | `utf8mb4` | 서버 기본과 같다(세션 실측) |
| collation | **`utf8mb4_0900_bin`** | `=`(보안 축)·`ORDER BY` 가 SQLite BINARY 와 **완전 일치**하는 유일한 후보 |
| 텍스트 컬럼 | `LONGTEXT` | `markupVersion` 최대 165,802 B · 29컬럼 `VARCHAR(768)` 은 행 크기 상한 초과 |
| 텍스트 PK 3종 | `VARCHAR(768)` | `LONGTEXT` 는 PK 불가(1170) · `VARCHAR(769)` PK 는 키 상한 초과(1071) |
| `INTEGER PRIMARY KEY` | `BIGINT AUTO_INCREMENT` | id 재사용 없음·롤백 간격은 divergence 로 기록 |
| 날짜·시각 | **승격하지 않는다**(`LONGTEXT`) | 정본이 ISO 문자열을 TEXT 에 넣는다 — 승격하면 포맷·타임존이 왕복에서 갈린다 |
| 보조 인덱스·FK | **만들지 않는다** | 정본이 PK 자동 인덱스만 쓴다(`src/db/schema.js` 3행) |
| 접속 파라미터 | 필수 없음(선택) | 파라미터 0개로도 붙는다 — 아래 §5 |
| 포기한 축 | **`LIKE` 대소문자** | 세 축을 동시에 만족하는 collation 이 **없다** — 아래 §4 |

## 1. 측정 환경 — 어느 DB·어느 자격에서 쟀는가

| 측정 | 대상 DB | 자격 | 변조 |
|---|---|---|---|
| 축 1~12 전부(JUnit) | `harness_ct_<16hex>` (실행마다 새로 만들고 **DB째 폐기**) | `news_ct` | 있음(폭발 반경 0) |
| 세션 설정 실측(`SHOW VARIABLES`) | 임시 DB 세션 | `news_ct` | 없음 |
| 예약어 목록 | `INFORMATION_SCHEMA.KEYWORDS` | `news_ct` | 없음 |
| SQLite 대조 | OS 임시 디렉토리의 새 `.db` 파일 | (파일) | 있음 |

- **리포 `news.db` 는 열지 않았다**(프로브는 자기 픽스처만 쓴다 — 원본 바이트 무변이 이 phase 의 완료 게이트다).
- **`news_stage` 는 건드리지 않았다**(최종 1회 실측 전용 · 변이 금지).
- 임시 DB 이름은 `^harness_ct_[0-9a-f]{16}$` 만 허용하고, 그 정규식 밖의 이름은 **드롭 시도조차 하지 않는다**
  (`EphemeralMysqlDb.dropDatabase`). 2차 방어선은 `news_ct` 의 grant 경계다.

## 2. 서버 세션 실측 (step0 D-3 · 이 문서의 전제)

| 변수 | 값 |
|---|---|
| `VERSION()` | `8.0.46` |
| `lower_case_table_names` | `1` |
| `sql_mode` | `ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION` |
| `character_set_server` | `utf8mb4` |
| `collation_server` / `collation_database` / `default_collation_for_utf8mb4` | `utf8mb4_0900_ai_ci` |
| `max_allowed_packet` | `67108864` (64 MiB) |
| `wait_timeout` / `interactive_timeout` | `28800` (8시간) |
| `innodb_lock_wait_timeout` | `50` |
| `innodb_page_size` | `16384` |
| `autocommit` | `ON` |
| `have_ssl` / `have_openssl` | `YES` |

`my.ini` 파일 읽기로 **추론**했던 값과 전건 일치한다 — 이제 세션 실측이 정본이다.

## 3. 12축 실측 결과

### 축 1 — 바인딩 표현 (`ValueSemanticsProbeTest.axis1_*`)

텍스트 컬럼에 숫자·불리언을 바인딩했을 때 저장되는 문자열. **divergence 0.**

| 입력 | SQLite | MySQL |
|---|---|---|
| `int 0` | `0` | `0` |
| `int 2` / `long 2` | `2` | `2` |
| `double 0.0` | `0.0` | `0.0` |
| `double 2.0` | `2.0` | `2.0` |
| `double 2.5` | `2.5` | `2.5` |
| `boolean true` / `false` | `1` / `0` | `1` / `0` |
| `String "2.0"` | `2.0` | `2.0` |

Node `node:sqlite` 가 `2.0` 을 `"2.0"` 으로 저장한다는 74 이월 실측이 MySQL 에서도 그대로다.

### 축 2 — 빈 문자열 vs NULL (`ValueSemanticsProbeTest.axis2_*`)

**divergence 0.** 왕복 보존 · `IS NULL` · `= ''` · `COALESCE` 넷 다 같다. 소스에서 두 값이 같은 컬럼에
공존하므로(`Contents.embargoAt` = 빈 문자열 52 + NULL 10) 이 축이 갈리면 이관 대조가 통째로 무너진다.

### 축 3 — `=` 비교 (**보안 축**) (`CollationSemanticsProbeTest.axis3_*`)

저장값과 질의값이 **같다고 판정되는가**. `true` 가 곧 "다른 값이 같아진다"는 뜻이다.

| 쌍 | SQLite BINARY | `utf8mb4_bin` | `utf8mb4_0900_bin` | `utf8mb4_0900_ai_ci` |
|---|---|---|---|---|
| `abc` vs `ABC` | false | false | **false** | **true** |
| `x` vs `x ` (후행 공백) | false | **true** | **false** | false |
| `x` vs ` x` (선행 공백) | false | false | **false** | false |
| `A` vs `Ａ`(U+FF21) | false | false | **false** | **true** |
| `가`(U+AC00) vs `가`(U+1100 U+1161) | false | false | **false** | **true** |
| `abc` vs `abc` | true | true | **true** | true |

⇒ **SQLite BINARY 와 완전히 일치하는 후보는 `utf8mb4_0900_bin` 하나뿐이다**(기계 단언).
`utf8mb4_bin` 은 PAD SPACE 라 후행 공백을 무시하고, `utf8mb4_0900_ai_ci` 는 대소문자·전각·자모를 무시한다.
둘 다 `WHERE userId = ?` 에서 **다른 계정으로 로그인**되는 경로를 연다.

> **주의(coercibility)**: `collation_connection` 은 `utf8mb4_0900_ai_ci` 다(§5). 그런데도 위 결과가
> 컬럼마다 갈렸다 — **컬럼 collation 이 리터럴/바인딩보다 우선**하기 때문이다. 이 리포의 비교는 전부
> "컬럼 vs 바인딩"이므로 컬럼 collation 이 지배한다. `connectionCollation` 을 URL 에 넣을 필요가 없다.

### 축 4 — `LIKE` (**포기한 축**) (`CollationSemanticsProbeTest.axis4_*`)

| 항목 | SQLite | `utf8mb4_bin` | `utf8mb4_0900_bin` | `utf8mb4_0900_ai_ci` |
|---|---|---|---|---|
| `'ABC' LIKE 'abc'` | **true**(ASCII 무시) | false | **false** | true |

**세 축(`=` · `ORDER BY` · `LIKE`)을 동시에 만족하는 collation 은 존재하지 않는다.** `LIKE` 를 맞추려면
`ai_ci` 여야 하는데 그것은 `=` 를 무너뜨린다. **판정: `=`(보안)와 `ORDER BY` 를 우선하고 `LIKE`
대소문자를 포기한다.** 피해가 비대칭이기 때문이다 — `=` 가 무너지면 인증이 뚫리고, `LIKE` 가 갈리면
검색 결과가 좁아질 뿐이다. `server/**` 를 고쳐 맞추지 않는다(open question (2) 의 기본 결정).

와일드카드·NULL 축은 **양쪽이 같다**(divergence 0):

| 질의어 | 결과(양쪽 동일) |
|---|---|
| `a%b` | `a%b` · `axb` · `axxb` — **질의어의 `%` 가 와일드카드로 동작한다**(이 리포는 ESCAPE 를 붙이지 않는다) |
| `a_b` | `a%b` · `axb` |
| `%%` | NULL 이 아닌 전 행 |
| `%나%` | `가나다` (한글도 동형) |
| NULL 컬럼 | 어떤 패턴에도 매칭되지 않는다 |

### 축 5 — `ORDER BY` (`CollationSemanticsProbeTest.axis5_*`)

한글 24 + 영숫자 12 + ISO 시각 4 = **40개 표본**을 정렬해 리스트로 비교했다.

| collation | SQLite BINARY 순서와 |
|---|---|
| SQLite | (기준) — UTF-8 **바이트** 순서와 정확히 일치함을 별도로 단언 |
| `utf8mb4_bin` | **일치** |
| `utf8mb4_0900_bin` | **일치** |
| `utf8mb4_0900_ai_ci` | **불일치** |

`ai_ci` 가 갈리는 지점(M3 변이에서 실측):
- ASCII 대소문자: BINARY 는 `AB, Apple, Banana, Zebra, ab, apple, banana, zebra`(대문자 전부가 먼저),
  `ai_ci` 는 `ab, AB, apple, Apple, banana, Banana, zebra, Zebra`(사전순 혼합).
- 구두점 위치: `_x` 가 BINARY 에서는 `Zebra` 뒤, `ai_ci` 에서는 **맨 앞**이다.
- **한글 24개의 상대 순서는 두 순서가 같다** — 한글이 문제가 아니라 ASCII 대소문자·구두점이 문제다.

**동일 키 tie 의 반환 순서는 양쪽 다 비보장**이다(둘 다 tie-break 를 약속하지 않는다). 그 사실 자체를
테스트로 남겼고, 소스 데이터에는 tie 가 없다(`Contents.createdAt` 77/77 상이).

### 축 6 — id 생성 (`IdentityAndSizeProbeTest.axis6_*`)

| 시나리오 | SQLite `INTEGER PRIMARY KEY` | MySQL `BIGINT AUTO_INCREMENT` |
|---|---|---|
| 연속 삽입 3건 | `1,2,3` | `1,2,3` |
| 생성 키 반환(`getGeneratedKeys`) | `4` | `4` |
| **최댓값 행 삭제 후 재삽입** | `1,2,3,4` (**id 재사용**) | `1,2,3,5` (**재사용 없음**) |
| **롤백 후 재삽입** | `1,2` (간격 없음) | `1,3` (**간격 1**) · 카운터 = `4` |

⇒ **divergence 2건이고 둘 다 실제로 도달 가능하다.** 이 리포에서 행 삭제가 허용된 유일한 자리가
`ReceiverConfigRepository.remove`(153행)의 `DELETE FROM ReceiverConfig` 이고, 계약은 그 응답을
`200 {ok:true, changes:1}` 로 동결하되 **id 원값을 리포트에 싣지 않는다** — 계약이 못 보는 축이다.

### 축 7 — 대용량 텍스트 (`IdentityAndSizeProbeTest.axis7_*`)

165,802바이트(= 소스 `Article.markupVersion` 최대치) 왕복:

| 타입 | 결과 |
|---|---|
| SQLite `VARCHAR` | 저장·왕복·`LIKE` 전부 성공 |
| MySQL `LONGTEXT` | 저장·왕복·`LIKE` 전부 성공 (`LENGTH` = 165,802) |
| MySQL `VARCHAR(768)` | **1406 거부** |
| MySQL 29컬럼 `VARCHAR(768)`(Contents 전 컬럼) | **1118 — 행 크기 상한(65,535) 초과** |
| MySQL `LONGTEXT` PK | **1170 — 길이 없는 BLOB/TEXT 는 키가 될 수 없다** |
| MySQL `VARCHAR(769)` PK | **1071 — 키 상한 3072바이트 초과**(768 이 상한인 근거) |
| MySQL `LONGTEXT DEFAULT 'Y'` | **1101 — BLOB/TEXT 는 리터럴 DEFAULT 를 못 가진다** |
| MySQL `LONGTEXT DEFAULT ('Y')` | 성공(8.0.13+ 식 DEFAULT) |

`max_allowed_packet` = 67,108,864 이라 이 크기는 여유롭게 들어간다(테스트가 부등식을 단언한다).

> **[step2 에서 닫힘] 결정: 식 DEFAULT 로 옮긴다.** 정본이 선언하는 `DEFAULT 'Y'`(`User.active`·
> `ReceiverConfig.active`·`DistributionTarget.active`)·`DEFAULT 'N'`(`Contents.lockYN`)·`DEFAULT '0'`
> (`User.failedLoginCount`) **5건 전부**를 `DEFAULT ('Y')` 형태로 기반선에 싣는다. 리터럴 DEFAULT 가
> 물리적으로 불가능하다는 것이 위 실측이고, **버리는 선택지는 실측으로 탈락했다**: 이 리포의 삽입문은
> 전부 **동적 컬럼 목록**을 만들어(`UserRepository` 104행 · `ReceiverConfigRepository` 126행 …) 값이 없는
> 컬럼이 문장에서 빠진다. 정본에서 `'Y'` 로 채워지는 그 자리가 MySQL 에서만 `NULL` 이 되면 **이관이 동작을
> 바꾼다**. 방어선은 정적 대조 하나와 행동 측정 하나다 — `BaselineMatchesCanonicalSchemaTest`(정본의
> DEFAULT 5건이 식 형태로 그대로 옮겨졌는가) · `FlywayBaselineOnMysqlTest`(값 없이 삽입한 컬럼이 두
> 엔진에서 같은 값인가 — `active='Y'` · `failedLoginCount='0'` · `lockYN='N'` 실측 일치).

### 축 8 — 길이 초과 = **수락 vs 거부** (`IdentityAndSizeProbeTest.axis8_*`)

| 입력 | SQLite `VARCHAR(768)` | MySQL `VARCHAR(768)` |
|---|---|---|
| 769자 | **수락**(저장 길이 769 — 자르지 않는다) | **1406 거부 · 행 0건**(조용한 절단이 아니다) |
| 768자 | 수락 | 수락 |

**조용한 절단이 아니라는 것이 이 매핑을 채택할 수 있는 조건**이었고, 실측이 그것을 확인했다.

**도달 경로 조사**: `VARCHAR(768)` 로 매핑되는 컬럼은 텍스트 PK 3종뿐이다.

| PK | 값의 출처 | 사용자 입력 도달 |
|---|---|---|
| `Article.articleId` | 서버 발급(`ArticleWriteService` 96행 `generateArticleId` — 클라이언트 값은 언제나 무시) | **없음** |
| `Contents.articleId` | 위와 같은 값 | **없음** |
| `User.userId` | **관리자 생성 API 의 요청 본문** (`UserService.create`) | **있다** |

`UserService.create` 는 **입력 검증이 없다**(클래스 주석이 "결함 후보 #2의 의도적 재현"으로 명시).
⇒ 769자 `userId` 로 사용자를 만들면 **Node 200 / Spring 500** 이다.

**판정: 길이를 늘려 회피하지 않는다.** 768 이 utf8mb4 단일 컬럼 인덱스 상한(3072바이트)이라 **769 로
늘리면 스키마 자체가 만들어지지 않는다**(1071 — 위 축 7). 남은 선택지는 애플리케이션 입력 검증인데,
그것은 **Node 의 응답도 바꾸는 동작 변경**이라 이 phase 의 범위(이관이 동작을 바꾸지 않는다) 밖이다.
⇒ **divergence 로 기록하고 해소는 P3 로 넘긴다.** 방어선은 위 테스트다.

### 축 9 — `length()` (`ValueSemanticsProbeTest.axis9_*`)

| 입력 | SQLite `length()` | MySQL `LENGTH()` | MySQL `CHAR_LENGTH()` |
|---|---|---|---|
| `가나다` | **3**(문자) | **9**(바이트) | 3 |

**값은 갈리지만 술어는 갈리지 않는다.** 이 리포가 `length()` 를 쓰는 유일한 자리는
`ArticleHistoryRepository` 198행의 `length(markupVersion) > 0` 이고, `> 0` 은 "비어 있지 않은가"이므로
양쪽이 **같은 행 집합**을 준다(NULL·빈 문자열·ASCII·한글 4행으로 실측). 방언 수정이 필요 없다.

### 축 10 — 식별자 대소문자 (`CatalogSemanticsProbeTest.axis10_*`)

`lower_case_table_names = 1` 이므로:

- **테이블 이름은 소문자로 저장된다.** `CREATE TABLE ReceiverConfig` → 카탈로그에는 `receiverconfig`.
  7테이블 전부 확인했다(`articlehistory`·`distributiontarget`·`user`·…). step0 의 grant 실측이 이미
  그것을 보여 줬다 — `DELETE ON news_grant_probe.receiverconfig` 로 붙었다.
- `DatabaseMetaData.getTables` 도 소문자를 돌려준다. 패턴은 대소문자 무시로 매칭된다
  (`"ReceiverConfig"` 로 찾아도 `receiverconfig` 가 나온다).
- **컬럼 이름은 원래 표기가 보존된다**(`userId`·`lockYN`·`markupVersion` 그대로).
  ⇒ **응답 키 집합(= 계약)은 이관으로 바뀌지 않는다.**
- `SchemaGuard` 의 `toLowerCase` 비교는 MySQL 에서도 성립한다 — step5 가 `pragma_table_info` 를
  `DatabaseMetaData` 로 바꿔도 판정이 달라지지 않는다.

### 축 11 — 접속·트랜잭션·**단일 연결의 노후화** (`ConnectionSemanticsProbeTest`)

접속 파라미터: §5. 트랜잭션:

| 항목 | SQLite | MySQL |
|---|---|---|
| 기본 autocommit | ON | ON |
| 트랜잭션 안의 자기 변경 가시성 | 보인다 | 보인다 |
| 롤백 | 되돌린다 | 되돌린다(단 AUTO_INCREMENT 는 되돌지 않는다 — 축 6) |
| `innodb_lock_wait_timeout` | (없음) | `50` |

**노후화(SQLite 에 없던 축)**: 서버는 `wait_timeout`(28,800초) 동안 유휴한 연결을 죽인다. 이 서버는
`NewsDataSource.MAX_POOL_SIZE = 1`(decisions (10) — 유지)이라 **그 하나가 죽으면 다음 요청이 실패**할
수 있다. 8시간을 기다릴 수 없으므로 **세션 `wait_timeout` 을 2초로 줄여 축소 재현**했다:

- 서버가 실제로 유휴 연결을 죽인다 → 확인.
- 그런데도 **풀 크기 1 에서 다음 요청이 성공한다** — Hikari 가 빌려 줄 때 살아 있는지 확인하고 죽었으면
  새로 연다. 실측 확인.
- Hikari 기본 `maxLifetime` = **1,800,000ms(30분)** < `wait_timeout` **28,800,000ms(8시간)** —
  물리 연결은 서버가 죽이기 한참 전에 스스로 교체된다. 부등식을 테스트가 단언한다.

⇒ **명시 설정을 추가하지 않는다**(설정하지 않는 것도 결정이다). 기본값이 이미 안전 쪽에 있고, 값을 박으면
그 값의 근거를 계속 관리해야 한다. 부등식이 깨지면 위 테스트가 red 다.

> **미측정**: 실제 8시간 유휴 후의 첫 요청은 재지 않았다(시간). 축소 재현이 같은 메커니즘을 실증한다.

### 축 12 — 예약어 충돌 (`CatalogSemanticsProbeTest.axis12_*`)

`SELECT WORD FROM INFORMATION_SCHEMA.KEYWORDS WHERE RESERVED = 1` → **262개**(이 서버가 정본이다).
`RequiredSchema.TABLES` 의 **7테이블 이름 + 전 컬럼 이름 68개**와의 **교집합 = 0건**.

정적 대조에 더해 **무인용 SQL 이 실제로 파싱되는지**까지 확인했다 — 7테이블을 결정된 타입 매핑으로 만들고
백틱 없이 전 컬럼을 `SELECT ... FROM <table> WHERE <pk> = ? ORDER BY <pk>` 로 조회해 전부 성공했다.

⇒ **`decisions (16)`(리포지토리 SQL 무수정)의 전제가 실측으로 확인됐다.** 컬럼이 추가되거나 MySQL 이
업그레이드돼 예약어가 늘면 이 테스트가 red 로 알린다.

## 4. collation 결정 — 무엇을 얻고 무엇을 포기했는가

```
채택: CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin   (DB 기본 · 전 텍스트 컬럼)
```

| 축 | 결과 | 방어선 |
|---|---|---|
| `=` (보안) | **SQLite 와 완전 일치** | `CollationSemanticsProbeTest.axis3_*` |
| `ORDER BY` | **SQLite 와 완전 일치** | `CollationSemanticsProbeTest.axis5_*` |
| `LIKE` 대소문자 | **포기 — divergence** | `CollationSemanticsProbeTest.axis4_likeCaseSensitivityIsTheSacrificedAxis` |

탈락 이유: `utf8mb4_bin` 은 **PAD SPACE**(후행 공백 무시 → 인증 축 붕괴), `utf8mb4_0900_ai_ci` 는
**대소문자·전각·자모 무시**(같은 이유).

## 5. 접속 URL 파라미터 — 확정 집합

**필수 파라미터는 없다.** 아래 넷이 전부 접속에 성공했다(실측):

| 질의 문자열 | 결과 |
|---|---|
| (없음) | ok — Connector/J 9 기본 `sslMode=PREFERRED` 가 TLS 를 협상한다(`have_ssl=YES`) |
| `?useSSL=false&allowPublicKeyRetrieval=true` | ok — 평문 경로 |
| `?sslMode=DISABLED&allowPublicKeyRetrieval=true` | ok — 위와 같은 뜻의 현행 표기 |
| `?characterEncoding=UTF-8` | ok |

- `allowPublicKeyRetrieval=true` 는 **평문(`useSSL=false`)과 짝**이다. `caching_sha2_password` 의 최초
  인증이 TLS 없이 이뤄질 때만 필요하다 — 독립한 필수 항목이 아니다.
- `characterEncoding=UTF-8` 없이도 **한글이 온전히 왕복**한다(서버 기본이 `utf8mb4`).
- 세션 문자셋 실측: `character_set_client` = `utf8mb4` · `character_set_connection` = `utf8mb4` ·
  `character_set_results` = **NULL** · `collation_connection` = `utf8mb4_0900_ai_ci`.
  (컬럼 collation 이 우선하므로 비교 의미론에 영향이 없다 — §3 축 3의 주의.)
- **URL 에 사용자·비밀번호를 넣지 않는다.** 자격은 언제나 별도 키로 넘긴다(`SecretHygieneTest`).

⇒ **권장 확정 집합**: `useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=UTF-8`
(loopback 전용 개발 인스턴스에서 TLS 핸드셰이크를 매번 하지 않기 위한 선택이고, **필수가 아니라
선택임을 명시한다**). 운영에서 TLS 를 쓰기로 하면 앞의 둘을 지우면 된다.

## 6. 컬럼별 타입 매핑표 (7테이블 · 68 식별자)

규칙은 넷뿐이다.

1. **텍스트 PK** → `VARCHAR(768) NOT NULL PRIMARY KEY`
2. **`INTEGER PRIMARY KEY`** → `BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY`
3. **`targetId INTEGER`** → `BIGINT`
4. **그 밖의 모든 텍스트** → `LONGTEXT`

공통: `ENGINE=InnoDB` · `CHARACTER SET utf8mb4` · `COLLATE utf8mb4_0900_bin` · **보조 인덱스·FK 없음**.

| 테이블 | 컬럼 | SQLite(정본) | MySQL |
|---|---|---|---|
| `User` | `userId` | `TEXT PRIMARY KEY` | `VARCHAR(768) NOT NULL PRIMARY KEY` |
| `User` | `name` `password` `role` `department` `departmentCode` `active` `failedLoginCount` `lockedUntil` `lastFailedLoginAt` | `TEXT` | `LONGTEXT` |
| `Article` | `articleId` | `VARCHAR PRIMARY KEY` | `VARCHAR(768) NOT NULL PRIMARY KEY` |
| `Article` | `title` `content` `markupVersion` `modifier` | `VARCHAR` | `LONGTEXT` |
| `Contents` | `articleId` | `VARCHAR PRIMARY KEY` | `VARCHAR(768) NOT NULL PRIMARY KEY` |
| `Contents` | 나머지 28컬럼(`title` … `referenceFile`) | `VARCHAR` | `LONGTEXT` |
| `ArticleHistory` | `id` | `INTEGER PRIMARY KEY` | `BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| `ArticleHistory` | `targetId` | `INTEGER` | `BIGINT` |
| `ArticleHistory` | `articleId` `eventType` `action` `fromStatus` `toStatus` `actorUserId` `createdAt` `markupVersion` `snapshotTitle` `reason` | `VARCHAR` | `LONGTEXT` |
| `ReceiverConfig` | `id` | `INTEGER PRIMARY KEY` | `BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| `ReceiverConfig` | `sourceId` `type` `name` `host` `port` `username` `password` `apiEndpoint` `apiKey` `active` `createdAt` | `VARCHAR` | `LONGTEXT` |
| `DistributionTarget` | `id` | `INTEGER PRIMARY KEY` | `BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| `DistributionTarget` | `name` `kind` `spoolDir` `active` `createdAt` `updatedAt` | `VARCHAR` | `LONGTEXT` |
| `Photo` | `id` | `INTEGER PRIMARY KEY` | `BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| `Photo` | `src` `caption` `sourceArticleId` `registeredBy` `createdAt` | `VARCHAR` | `LONGTEXT` |

이 매핑으로 **7테이블 전부가 실제로 생성되고 무인용 SQL 로 조회된다**는 것을 테스트가 매번 확인한다
(`CatalogSemanticsProbeTest`). 즉 이 표는 "적어 놓은 계획"이 아니라 **실행되는 코드**다.

**[step2] 이 표는 이제 파일 하나로 실체화됐다** — `tools/news-migrator/src/main/resources/db/migration/
V1__baseline.sql` 이 MySQL 측 스키마의 정본이고(ADR-016 ③), 위 프로브도 **그 파일을 읽어** 스키마를
세운다(스키마가 두 벌이면 반드시 갈린다). 기반선과 `src/db/schema.js` 의 컬럼 이름·선언 순서·타입·
기본값 대조는 `BaselineMatchesCanonicalSchemaTest` 가 규칙으로 계산해서 한다(사람 눈 대조 금지).

`DEFAULT` 절은 **식 형태로 옮겼다**(`DEFAULT ('Y')` — 위 축 7 의 결정 상자를 보라). `LONGTEXT` 는 리터럴
DEFAULT 를 못 가지지만(1101) 8.0.13+ 의 식 DEFAULT 는 가능하고, 버리면 동적 컬럼 목록 삽입에서
정본과 값이 갈린다.

## 7. 잔여 divergence 목록 — 각 축의 **유일 방어선**

| # | divergence | 계약이 보는가 | 유일 방어선(파일·메서드) |
|---|---|---|---|
| 1 | `LIKE` 대소문자 — SQLite 무시 / MySQL 구분 | **못 본다**(`photos-search` 는 소문자 랜덤 토큰만 쓴다) | `CollationSemanticsProbeTest.axis4_likeCaseSensitivityIsTheSacrificedAxis` |
| 2 | 삭제된 id 재사용 — SQLite 재사용 / InnoDB 미재사용 | **못 본다**(`receiver-config` 케이스는 id 원값을 안 싣는다) | `IdentityAndSizeProbeTest.axis6_sqliteReusesDeletedIdsAndInnodbDoesNot` |
| 3 | 롤백 후 id 간격 — SQLite 없음 / InnoDB 있음 | 못 본다 | `IdentityAndSizeProbeTest.axis6_rollbackLeavesAGapInInnodbButNotInSqlite` |
| 4 | 769자 PK — Node 200 수락 / Spring 500 거부(1406) | 못 본다(케이스가 없다) | `IdentityAndSizeProbeTest.axis8_overlongPrimaryKeysAreAcceptedBySqliteAndRejectedByMysql` |
| 5 | `length()` 값 — 문자 수 / 바이트 수 (**술어는 동형**) | 못 본다 | `ValueSemanticsProbeTest.axis9_*` |
| 6 | 성능(보조 인덱스 0 유지) | 못 본다 | (미측정 — P3) |

**정렬**은 divergence 가 아니다(채택 collation 이 SQLite 와 일치한다). 참고로 정렬 축에서 계약이
실제로 보는 자리가 정확히 하나 있다 — `contract/cases/default/media-upload.contract.js` 342행이
`photos-search` 의 반환 순서를 `assert.deepEqual` 로 직접 단언한다(`PhotoRepository` 의 `ORDER BY id DESC`
는 이중 방어다). 나머지 테이블의 정렬은 `idsOf().sort()` 에 씻겨 계약이 보지 못한다.

## 8. 미측정 항목 (정직하게 남긴다)

| 항목 | 이유 | 어디서 채울 것인가 |
|---|---|---|
| 실제 8시간 유휴 후의 첫 요청 | 시간 | 축소 재현(2초)으로 같은 메커니즘 실증 — P3 운영 관찰 |
| 보조 인덱스 없는 상태의 성능 차이 | 이 phase 는 동형 유지가 원칙 | P3 (excluded (d)) |
| 다중 커넥션 동시성·락 경합 | 풀 크기 1 유지 결정 | P3 (excluded (c)) |
| `news` 운영 DB 에서의 실측 | 이 phase 는 임시 DB 와 `news_stage` 만 만진다 | P3 컷오버 |

## 9. 이 문서를 지키는 테스트

| 파일 | 축 | 테스트 수 |
|---|---|---|
| `db/dialect/MysqlConfiguredGuardTest.java` | fail-closed 가드 · 세션 설정 | 3 |
| `db/dialect/EphemeralMysqlDbTest.java` | 임시 DB 삭제 경계 · URL 조립 | 4 |
| `db/dialect/ValueSemanticsProbeTest.java` | 1 · 2 · 9 | 3 |
| `db/dialect/CollationSemanticsProbeTest.java` | 3 · 4 · 5 | 5 |
| `db/dialect/IdentityAndSizeProbeTest.java` | 6 · 7 · 8 | 5 |
| `db/dialect/CatalogSemanticsProbeTest.java` | 10 · 12 · **기반선 단일 출처(step2)** | **4** |
| `db/dialect/ConnectionSemanticsProbeTest.java` | 11 | 4 |
| **합계** | | **28** |

**[step2] 마이그레이터 모듈 쪽 방어선**(`tools/news-migrator` — 별도 Maven 프로젝트라 위 스위트와 함께
돌지 않는다. `cd tools/news-migrator && ./mvnw -B clean verify`):

| 파일 | 무엇을 지키는가 | 테스트 수 |
|---|---|---|
| `MigratorHasNoDestructiveSqlTest.java` | 파괴 경로 정적 게이트(**SQL 군 + API 군**)·예외 1파일 | 13 |
| `BaselineMatchesCanonicalSchemaTest.java` | 기반선 ↔ `src/db/schema.js` 기계 대조 | 6 |
| `FlywayBaselineOnMysqlTest.java` | 실제 적용·멱등·**`clean()` 거부**·DEFAULT 동작·인덱스 0 | 7 |
| `EphemeralDatabaseTest.java` | 임시 DB 이름 규약·왕복·보호 대상 거부 | 6 |
| `MigratorCliContractTest.java` | CLI 계약(커맨드·옵션·종료코드·자격 argv 금지) | 10 |
| `TargetCredentialsTest.java` | 환경변수 전용 자격·비밀 미노출 | 7 |
| **합계** | | **49** |

`MysqlConfiguredGuardTest` 는 환경변수가 없으면 **skip 이 아니라 fail** 한다(decisions (14)) —
조용한 skip 은 이 phase 의 모든 게이트를 공허하게 만든다. 대가는 이 모듈의 `mvnw verify` 가 MySQL
서버를 요구하게 되는 것이고, 그 트레이드오프는 ADR-016(step2)이 기록한다.
