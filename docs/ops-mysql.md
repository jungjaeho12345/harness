# MySQL 운영 런북 (phase 75 / P2 DB 이관)

> 이 문서는 **사람이 손으로 하는 일**만 적는다. 자동화가 할 수 있는 일은 코드에 있다.
> 대상은 개발 머신의 단일 인스턴스 **MySQL 8.0.46**(`C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`)이다.

## 0. 왜 사람이 해야 하는가

`root` 비밀번호를 자동화가 알지 못한다. 그리고 알아서도 안 된다 — 이 리포의 어떤 에이전트도 root 로 접속하지 않는다.
그래서 **root 가 필요한 일은 이 문서의 §2 한 번(그리고 §7 한 번)뿐**이고, 그 뒤의 모든 작업은
최소 권한 계정 3종으로만 돈다.

추측으로 root 비밀번호를 시도하지 마라 — `max_connect_errors` 에 걸리면 이 호스트가 통째로 차단된다.

## 1. 계정·DB 지도

| 자격 | 용도 | 권한 | 붙는 DB |
|---|---|---|---|
| `news_app@localhost` | Spring 런타임 | `SELECT, INSERT, UPDATE` + **`ReceiverConfig` 테이블 단위 `DELETE` 1건** | `news` · `news_stage` (· 프로브) |
| `news_migrator@localhost` | 마이그레이터·Flyway 스키마 | `SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES` (**`DELETE`·`DROP` 없음**) | `news` · `news_stage` |
| `news_ct@localhost` | 계약 하네스·Java 테스트 | `ALL PRIVILEGES` | `harness_ct_%` **뿐** |

| DB | 무엇인가 |
|---|---|
| `news` | 운영 DB. 이 phase 는 **만들기만** 한다(실제 데이터 컷오버는 P3). |
| `news_stage` | 이관 리허설·왕복 대조 전용 스테이징(step3·step4 의 대상). |
| `harness_ct_<16진수 16자리>` | 계약 하네스가 패스마다 만들고 지우는 임시 DB. 뉴스 데이터가 들어가지 않는다. |
| `news_grant_probe` | **권한 판정 전용 껍데기**. `ReceiverConfig` 삭제 예외가 실제로 붙었는지, 나머지 테이블 삭제가 실제로 거부되는지를 같은 DB·같은 자격으로 확인하는 자리다. 뉴스 데이터가 절대 들어가지 않는다. |

## 2. 부트스트랩 실행 (root 1회)

**정본 파일을 직접 실행하지 마라.** 사본을 만들어 비밀번호를 채운 뒤 그 사본을 실행한다.

```powershell
# 1) 사본을 만든다 (ops/mysql/*.local.sql 은 .gitignore 가 막는다)
copy ops\mysql\bootstrap.sql ops\mysql\bootstrap.local.sql

# 2) 사본을 열어 __CHANGE_ME_APP__ / __CHANGE_ME_MIGRATOR__ / __CHANGE_ME_CT__ 세 곳을
#    각각 다른 비밀번호로 바꾼다. 값은 당신이 정한다 — 이 리포의 누구도 그 값을 알 필요가 없다.

# 3) 실행 (root 비밀번호는 프롬프트로 입력한다 — 아래 §5 참조)
#    ⚠ PowerShell 은 '<' 리디렉션을 지원하지 않는다(§11-4-b 실측: ParserError).
#      반드시 -e "source <파일>" 형태를 쓴다. 경로는 슬래시로 적어라(source 는 셸이 아니라
#      mysql 클라이언트가 해석하고, 현재 디렉토리 기준이다).
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p -e "source ops/mysql/bootstrap.local.sql"
```

cmd.exe 라면 `<` 가 동작하므로 아래도 같다(둘 중 하나만 쓰면 된다).

```bat
"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p < ops\mysql\bootstrap.local.sql
```

**예상되는 정상 결과 2가지 중 하나다.**

- (a) 아무 출력 없이 끝난다 → 전 구간 적용 완료.
- (b) 마지막에 `ERROR 1146 (42S02): Table 'news.receiverconfig' doesn't exist` 로 멈춘다 →
  **정상이다.** MySQL 은 테이블 단위 `GRANT` 를 대상 테이블이 있을 때만 받아 주는데, 지금은 스키마가
  비어 있다(테이블은 step3 의 마이그레이터가 만든다). `§1~§6` 은 이미 전부 적용된 상태이고,
  남은 `§7` 은 **§7 절차**대로 나중에 한 번 더 돌리면 된다.

> 실행 후 `bootstrap.local.sql` 을 지울지는 당신의 선택이다. 남겨 두어도 git 에는 들어가지 않는다.

## 3. 비밀 보관 — 리포 밖 env 파일

값은 **리포 밖 한 곳**에만 둔다.

```
D:/agents/secrets/news-mysql.env
```

이 파일을 아래 내용으로 만들고 `__CHANGE_ME_*` 자리에 §2 에서 정한 값을 넣는다.
(키 이름은 이 phase 전체가 쓰는 유일한 이름이다 — 다른 이름을 만들지 마라.)

```dotenv
# Spring 런타임 (news_app)
NEWS_DB_URL=jdbc:mysql://127.0.0.1:3306/news?useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=UTF-8
NEWS_DB_USERNAME=news_app
NEWS_DB_PASSWORD=__CHANGE_ME_APP__

# 마이그레이터 (news_migrator) — 대상 DB 는 실행 시 바꾼다(news_stage / news)
NEWS_MIGRATOR_URL=jdbc:mysql://127.0.0.1:3306/news_stage?useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=UTF-8
NEWS_MIGRATOR_USERNAME=news_migrator
NEWS_MIGRATOR_PASSWORD=__CHANGE_ME_MIGRATOR__

# 계약 하네스·Java 테스트 (news_ct) — DB 이름 없이 서버까지만 가리킨다(임시 DB 를 스스로 만든다)
NEWS_CT_MYSQL_URL=jdbc:mysql://127.0.0.1:3306/?useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=UTF-8
NEWS_CT_MYSQL_USERNAME=news_ct
NEWS_CT_MYSQL_PASSWORD=__CHANGE_ME_CT__
```

- `allowPublicKeyRetrieval=true` 가 필요한 이유: MySQL 8 기본 인증(`caching_sha2_password`)은 TLS 가
  없으면 서버 공개키를 받아 와야 한다. 이 인스턴스는 loopback 전용이라 TLS 를 쓰지 않는다.
- **URL 에 사용자·비밀번호를 넣지 마라**(`//user:pw@host` 형태 금지). 자격은 언제나 별도 키로 넘긴다 —
  `SecretHygieneTest` 가 그 형태를 리포 전역에서 금지한다.

### 비밀번호 최소 길이 — **8자** (규정)

세 비밀번호 모두 **8자 이상**으로 정하라. 하한이 둘인데, **서로 다른 것을 재고 처분도 다르다**
(`scripts/lib/mysqlHarness.mjs`).

| 길이 | 계약 하네스(`--db mysql`)의 처분 | 왜 |
|---|---|---|
| **4자 미만** | **즉시 거부**(아무것도 만들기 전에 멈춘다) | 그 길이는 자식 출력에서 **가릴 수 없다**. 가리지도 leak 보고도 하지 않는 상태 = **조용히 꺼진 보안 통제**다. 가릴 수 없는 비밀로는 돌지 않는다. |
| **4자 이상 8자 미만** | **경고 1줄 · 실행은 계속** | 가리기는 동작한다. 다만 짧은 값은 하네스 출력의 md5(32자 16진수)·임시 DB 이름(16자 16진수)에 **우연히** 나타나 **거짓 leak 실패**를 만든다. 하한을 하드 거부로 걸면 배포 하나가 이 리포의 모든 MySQL 게이트를 세우므로 거부하지 않는다. |
| **8자 이상** | 조용히 통과 | — |

> **현재 개발 환경의 세 비밀번호는 4자다**(2026-09-04 실측). 즉 지금 `--db mysql` 을 돌리면
> `⚠ NEWS_CT_MYSQL_PASSWORD 가 최소 길이(8자) 규정에 못 미친다` 경고가 stderr 로 한 줄 나오고
> **실행은 정상 진행된다**(313관측 diffs 0 그대로). 경고를 없애려면 아래 §3-1 로 교체하라.
> 경고에도 거부 메시지에도 **값은 물론 그 길이도 싣지 않는다.**

### 3-1. 비밀번호 교체 절차

세 계정 중 하나만 바꿔도 되고 셋 다 바꿔도 된다. **순서가 중요하다** — env 파일을 먼저 고치면 그
사이의 실행이 전부 인증 실패로 죽는다.

1. **`ops/mysql/bootstrap.local.sql` 을 연다**(§2 에서 만든 사본. git 이 막는 파일이다).
   `IDENTIFIED BY '...'` 우변 셋 중 바꿀 것을 **8자 이상**으로 고친다. 정본 템플릿
   (`ops/mysql/bootstrap.sql`)에는 **절대 실값을 넣지 마라** — `SecretHygieneTest` 가 red 를 낸다.
2. **root 로 적용한다.** `CREATE USER ... IDENTIFIED BY` 는 계정이 이미 있으면 비밀번호를 바꾸지
   않으므로(멱등 형태다) `ALTER USER` 를 직접 쓴다. **이 문장은 root 소유라 자동화가 대신할 수 없다.**

   ```powershell
   # 비밀번호를 인자로 넘기지 마라(§5) — 프롬프트로 입력한다.
   & $M -u root -p -e "ALTER USER 'news_ct'@'localhost' IDENTIFIED BY '<새 값>'; FLUSH PRIVILEGES;"
   ```

   > 위 한 줄에도 새 값이 argv 로 들어가므로 **셸 히스토리에 남는다.** 남기고 싶지 않으면 인자 없이
   > `& $M -u root -p` 로 붙어 대화형 프롬프트에서 같은 문장을 입력하라(§5 와 같은 이유다).
   > `bootstrap.local.sql` 전체를 다시 돌려도 되지만 **`ALTER USER` 를 그 파일에 넣어 두어야** 적용된다
   > — 지금의 `CREATE USER ... IF NOT EXISTS` 계열만으로는 기존 계정의 비밀번호가 바뀌지 않는다.

3. **`D:/agents/secrets/news-mysql.env` 의 해당 `*_PASSWORD` 를 같은 값으로 고친다.**
   (이 파일이 값의 유일한 출처다. 리포 안에는 어디에도 두지 마라 — §4.)
4. **확인**: `& $M -u news_ct -p -e "SELECT 1"` → `1`. 그 다음 `--db mysql` 실행에서 경고가 사라진다.

### 셸에 싣는 법

> ⚠ **`. 파일` 로 읽지 마라**(2026-09-03 실측 함정). URL 값에 `&` 가 들어 있어 셸이 그 지점에서 명령을
> 백그라운드로 끊는다 — 그 결과 `NEWS_*_URL` 세 개가 **조용히 빈 값**이 되고, 테스트는 "환경변수가
> 없다"로 죽는다(원인은 파일이 아니라 읽는 방법이다). 값을 따옴표로 감싸는 방법도 있지만, 사람이
> 편집하는 파일에 그 규율을 요구하는 대신 **읽는 쪽이 방어**한다. CRLF 파일의 끝 캐리지리턴도 함께 지운다.

```bash
# Git Bash — 값에 & ? ; 가 있어도, CRLF 파일이어도 안전하다
while IFS='=' read -r k v || [ -n "$k" ]; do
  case "$k" in ''|'#'*) continue;; esac
  export "$k=${v%$'\r'}"
done < /d/agents/secrets/news-mysql.env
```

```powershell
# PowerShell
Get-Content D:/agents/secrets/news-mysql.env |
  Where-Object { $_ -match '^\s*[^#].*=' } |
  ForEach-Object { $k,$v = $_ -split '=',2; [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process') }
```

> ⚠ **`mvnw verify` 와 계약 하네스에 `NEWS_DB_*` 를 그대로 실으면 안 된다**(2026-09-03 step5 실측).
> step5 부터 Spring 은 `DB_KIND`(기본 `sqlite`)와 `NEWS_DB_URL` 이 **서로 다른 저장소를 가리키면 기동을
> 거부**한다. 위 절차로 파일을 통째로 싣고 `mvnw verify` 를 돌리면 `DB_KIND` 없이 `NEWS_DB_URL`(MySQL)만
> 남아 **모든 `@SpringBootTest` 가 컨텍스트 기동 실패**로 red 다(실측: `DbBootGuardTest` 3 red +
> `DbPropertiesBindingTest` 1 red). 코드 회귀가 아니라 **설계된 거부**다.

### `mvnw verify` 를 돌리는 정확한 형태 (step6 이후)

step6 부터 스위트는 **두 자격**을 쓴다: `news_ct`(임시 DB 측정)와 **`news_app`**(최소 권한 구성 자체를
시험하는 스모크·권한 경계 — `news_stage` 대상). 그래서 `NEWS_DB_*` 의 **값**은 필요하지만 그 **이름**은
환경에 남아 있으면 안 된다(위 모순 거부). 이름만 옮겨 싣는다 — 비밀의 출처는 여전히 env 파일 하나다.

```bash
# 위 §3 로드 절차 다음에 이어서
export NEWS_APP_MYSQL_URL="$NEWS_DB_URL"
export NEWS_APP_MYSQL_USERNAME="$NEWS_DB_USERNAME"
export NEWS_APP_MYSQL_PASSWORD="$NEWS_DB_PASSWORD"
unset NEWS_DB_URL NEWS_DB_USERNAME NEWS_DB_PASSWORD

cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
```

빠진 키가 있으면 **skip 이 아니라 fail** 이고, 실패 메시지가 어느 키를 옮겨야 하는지 지목한다
(decisions (14) — 조용한 skip 은 이 phase 의 게이트를 전부 공허하게 만든다).

> ⚠ **이 스위트는 `news_stage` 에 행을 추가한다**(계정 3 · 기사 1 · 사진 1 · 수집 설정 1 정도, 실행마다).
> 지우지는 않는다. step3·step4 의 왕복 대조를 다시 돌리려면 `news_stage` 를 비우고 재적재해야 하고,
> 그것은 `news_migrator`·`news_app` 어느 자격으로도 할 수 없다(둘 다 `DELETE`·`DROP` 이 없다) — **사람의
> 일이다**(root).

## 4. 리포에 비밀을 남기지 않는 규칙 (기계가 지킨다)

`server-spring/src/test/java/harness/news/config/SecretHygieneTest.java` 가 리포 루트 전체를 훑어
아래 넷을 단언한다. `mvnw verify` 에서 돌고, 위반하면 커밋 전에 red 다.

1. 접속 URL 에 자격이 박힌 형태(`//사용자:비밀번호@호스트`)가 없다 — 따옴표로 끊어 쓴 형태까지 본다.
2. `NEWS_DB_PASSWORD` · `NEWS_MIGRATOR_PASSWORD` · `NEWS_CT_MYSQL_PASSWORD` 에 **값을 대입한 줄**이 없다
   (이름의 등장은 허용 — 문서·코드가 키를 언급할 수 있어야 한다).
3. `ops/mysql/bootstrap.sql` 의 `IDENTIFIED BY` 우변은 전부 `__CHANGE_ME` 플레이스홀더다.
4. `.gitignore` 가 `*.env` · `secrets/` · `ops/mysql/*.local.sql` 을 막는다.

스캐너가 건너뛰는 자리(위 3종)와 git 이 막는 자리는 **같은 목록**이다 — 어긋나면 그 틈이 유출 경로가 된다.

## 5. 비밀번호를 커맨드라인 인자로 넘기지 마라

`mysql -u news_app -p비밀번호` 형태를 쓰지 마라. 이유는 셋이다.

- **프로세스 목록에 그대로 보인다**(`tasklist`·`ps`·작업 관리자). 같은 머신의 다른 사용자·다른 프로세스가 읽는다.
- **셸 히스토리**에 남는다(PowerShell 은 `ConsoleHost_history.txt` 에 평문으로 적는다).
- CI·에이전트 로그에 argv 가 실려 리포트로 흘러들어 간다.

대신 둘 중 하나를 쓴다.

```powershell
# (a) 대화형 — 프롬프트로 입력한다
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u news_app -p

# (b) 비대화형 — 옵션 파일 (리포 밖, 권한을 좁혀 둔다)
#     D:/agents/secrets/news-app.cnf :
#         [client]
#         user=news_app
#         password=...
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" --defaults-extra-file=D:/agents/secrets/news-app.cnf
```

## 6. 부트스트랩 검증 (실행 직후 전부 돌린다)

아래는 **비밀번호를 인자로 넘기지 않는다** — `-p` 는 프롬프트를 띄운다.
`mysql` 을 `M` 으로 줄여 쓴다: `set M="C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"`

| # | 확인 | 커맨드 | 기대 |
|---|---|---|---|
| 1 | 세 계정 접속 | `%M% -u news_app -p -e "SELECT 1"` (migrator·ct 도 동일) | 각각 `1` |
| 2 | 하네스 와일드카드 CREATE | `%M% -u news_ct -p -e "CREATE DATABASE harness_ct_0123456789abcdef; DROP DATABASE harness_ct_0123456789abcdef;"` | 오류 없음 (**실측 대상** — 안 되면 임시 DB 풀 방식으로 설계 변경) |
| 3 | 하네스 경계 | `%M% -u news_ct -p -e "SELECT COUNT(*) FROM news.ReceiverConfig"` | `ERROR 1044/1142` (거부돼야 정상) |
| 4 | 삭제 예외 **허용** | `%M% -u news_app -p news_grant_probe -e "INSERT INTO ReceiverConfig () VALUES (); DELETE FROM ReceiverConfig;"` | 오류 없음 |
| 5 | 삭제 **거부** | `%M% -u news_app -p news_grant_probe -e "DELETE FROM Contents"` | `ERROR 1142 (42000): DELETE command denied` |
| 6 | 마이그레이터 스키마 권한 | `%M% -u news_migrator -p news_stage -e "CREATE TABLE zz_grant_probe(id INT); ALTER TABLE zz_grant_probe ADD COLUMN v INT; INSERT INTO zz_grant_probe VALUES (1,1); SELECT * FROM zz_grant_probe"` | 오류 없음 → `1 1` |
| 7 | 마이그레이터 삭제 금지 | `%M% -u news_migrator -p news_stage -e "DELETE FROM zz_grant_probe"` | `ERROR 1142` (거부돼야 정상) |
| 8 | **6·7 의 잔재 청소** (root) | `%M% -u root -p -e "DROP TABLE news_stage.zz_grant_probe"` | 오류 없음 |
| 9 | 재실행 멱등 | `%M% -u root -p -e "source ops/mysql/bootstrap.local.sql"` (한 번 더 · PowerShell 에서는 `<` 대신 이 형태다) | §2 와 같은 결과 — 새 오류 없음 |

> **8 을 건너뛰지 마라.** `news_migrator` 에게는 일부러 `DROP` 이 없으므로 6 이 만든 표를 스스로 치우지
> 못한다. 남겨 두면 step3 에서 Flyway 가 `news_stage` 를 "비어 있지 않은 스키마"로 보고 멈춘다.
> 지우는 대상은 방금 만든 빈 껍데기이고 뉴스 데이터가 아니다.

**4·5 가 이 검증의 핵심이다.** 같은 DB·같은 자격에서 한쪽은 성공하고 한쪽은 거부돼야 한다.
다른 DB 에서 거부를 확인하면 애초에 권한이 0 이라 아무것도 증명하지 못한다(공허한 green).

> **실행 기록(2026-09-03)**: 부트스트랩이 실행됐고 세 계정이 전부 붙는다. `news_ct` 는
> `harness_ct_<16hex>` DB 를 **스스로 만들고 지울 수 있다**(CREATE → CREATE TABLE → INSERT → SELECT →
> DROP DATABASE 왕복 성공) — open question (3) 이 이것으로 닫혔고 임시 DB 풀 방식은 필요 없다.
> `news_app` 의 실측 grant 는 `SELECT,INSERT,UPDATE` on `news`·`news_stage`·`news_grant_probe` 와
> **`DELETE ON news_grant_probe.receiverconfig`** 다(테이블 이름이 소문자로 붙는다 — `lower_case_table_names=1`).
> **§7 의 `news`·`news_stage` 삭제 예외는 아직 붙지 않았다** — 테이블이 없어 `ERROR 1146` 이고 그것이
> 예정된 동작이다. step3 이 Flyway 로 스키마를 세운 뒤 §7 을 실행해 붙인다.
> 세션 실측값 9종은 `docs/db-mysql-mapping.md` §2 에 표로 있다(`my.ini` 추론값과 전건 일치).

### 세션 실측 (설정 파일 읽기로 대신하지 마라)

`my.ini` 에 적힌 값과 세션에 실제 적용된 값은 다를 수 있다. **세션값이 정본이다.**

```sql
-- %M% -u news_ct -p 로 붙어서
SELECT VERSION();
SHOW VARIABLES LIKE 'lower_case_table_names';
SHOW VARIABLES LIKE 'sql_mode';
SHOW VARIABLES LIKE 'character_set_%';
SHOW VARIABLES LIKE 'collation_%';
SHOW VARIABLES LIKE 'max_allowed_packet';
SHOW VARIABLES LIKE 'wait_timeout';
SHOW VARIABLES LIKE 'innodb_lock_wait_timeout';
```

## 7. 삭제 예외를 실제 스키마에 붙이기 (§2 가 (b) 로 끝났을 때만)

step3 이 `news_stage` 에 스키마를 만든 **뒤에** 같은 파일을 한 번 더 돌린다. 전 문장이 멱등이라
`§1~§6` 은 조용히 지나간다.

> **⚠ 지금 실행할 때는 `--force` 를 붙여라 (2026-09-03 step3 실측).** `§7` 의 두 `GRANT` 는
> `news` → `news_stage` 순서인데, **`news` 는 아직 비어 있다**(step3 은 스테이징에만 적재했고 운영
> 적재는 P3 다). 그래서 첫 문장이 `ERROR 1146` 으로 죽고, `mysql` 클라이언트는 배치 모드에서 오류를
> 만나면 **거기서 멈추므로** 뒤의 `news_stage` 문장이 실행되지 않는다 — 아무것도 붙지 않은 채 끝난다.
> `--force` 는 오류를 건너뛰고 계속한다(멱등이라 안전하다). 한 줄만 실행해도 된다:
> ``GRANT DELETE ON `news_stage`.`ReceiverConfig` TO 'news_app'@'localhost';``

```powershell
# ⚠ '<' 를 쓰지 마라 — PowerShell 은 리디렉션을 지원하지 않는다(§11-4-b 실측: ParserError).
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p --force -e "source ops/mysql/bootstrap.local.sql"
```

```bat
REM cmd.exe 라면 이 형태도 같다.
"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p --force < ops\mysql\bootstrap.local.sql
```

> **이 절을 건너뛰거나 여기서 조용히 실패하면 무슨 일이 나는가.** grant 가 붙지 않고, 그 상태는
> **기동 성공 · 계약 하네스 green** 인 채로 `DELETE /api/receiver-config/:id` 하나만
> **500 `internal-error`** 가 된다(계약이 동결한 값은 `200 {"ok":true,"changes":1}` 다). 하네스가 이것을
> 못 보는 이유는 하네스가 `news_ct`(ALL 권한)로 돌기 때문이다 — **패리티 green 은 이 grant 의 부재를
> 덮어 준다.** 그래서 판정은 아래 `SHOW GRANTS` 로 **눈으로** 해야 한다. ParserError 로 멈춘 것을
> 「실행됐다」로 읽으면 정확히 그 상태에 도달한다(2026-09-03 에 부트스트랩이 한동안 실행되지 않은
> 원인이 이 형태였다).

**언제 필요한가**: step3 이 끝난 지금이다(`news_stage` 에 7테이블 + `flyway_schema_history` 가 있다 —
2026-09-03 실측). `news` 쪽 예외는 그 DB 에 스키마가 선 뒤(=step8 런북의 컷오버 리허설/P3) 같은 파일을
다시 돌리면 붙는다.

붙었는지 확인:

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u news_app -p -e "SHOW GRANTS"
```

`GRANT DELETE ON `news_stage`.`receiverconfig` TO ...` 줄이 보이면 완료다.

> **⚠ 이 grant 는 하드닝이 아니라 계약 필수 조건이다 (2026-09-04 step6 실측).** 없으면
> `DELETE /api/receiver-config/:id` 가 계약이 동결한 `200 {"ok":true,"changes":1}` 대신
> **500 `internal-error`** 를 낸다(권한 오류가 전역 핸들러로 새어 나온다 — `NewsAppMysqlWireTest` 가 그
> 응답을 실측해 고정한다). 그리고 **계약 하네스는 이 축을 보지 못한다** — 하네스는 `news_ct`(ALL 권한)로
> 돌기 때문이다. 즉 "패리티 green" 은 이 grant 의 부재를 덮어 준다. 운영 DB(`news`)로 컷오버할 때
> **같은 grant 를 반드시 함께 붙여라**(step8 런북 항목).
>
> 붙기 전에도 스위트는 red 가 되지 않는다: 판정이 "우리가 기대한 표와 같은가"가 아니라
> **"서버가 자기 `SHOW GRANTS` 표대로 실제로 막는가"** 이기 때문이다(`MinimumPrivilegeBoundaryTest`).
> 다만 그 상태에서는 **"삭제 성공" 절반이 실증되지 않은 채**이고, 그 사실은 step6 summary 에 적혀 있다.

## 8. collation — **확정됐다**(step1 실측, 2026-09-03)

```
CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin
```

부트스트랩이 만든 값 그대로이므로 **아무것도 고칠 필요가 없다.** 근거와 후보 3종의 전 축 비교는
`docs/db-mysql-mapping.md` §3 축 3·4·5 · §4 에 있다. 요약: `utf8mb4_0900_bin` 만이 `=`(보안 축)와
`ORDER BY` 에서 SQLite BINARY 와 **완전 일치**한다. `utf8mb4_bin` 은 PAD SPACE 라 후행 공백을 무시하고
(`'x' = 'x '` 가 참이다 — 인증 축 붕괴), `utf8mb4_0900_ai_ci` 는 대소문자·전각·자모를 무시한다.
대가는 `LIKE` 대소문자 divergence 이고 그것을 감수하기로 판정했다.

만약 뒤에 값을 바꿀 일이 생겨도 **root 재실행이 필요 없다**(`news_migrator` 가 ALTER 를 가진다):

```sql
ALTER DATABASE news       CHARACTER SET utf8mb4 COLLATE <확정값>;
ALTER DATABASE news_stage CHARACTER SET utf8mb4 COLLATE <확정값>;
```

DB 기본 collation 은 이후 `CREATE TABLE` 의 기본값일 뿐이고, 테이블·컬럼 collation 은 Flyway
마이그레이션이 명시적으로 정한다(스키마 정본은 `tools/news-migrator` 다).

## 9. 되돌리기 — Spring/MySQL 에서 Node/SQLite 로 (step4 초안 · step8 이 완성한다)

로드맵의 되돌림 지점이다: **P3 완료 전에 문제가 생기면 Node 서버로 즉시 복귀한다(클라이언트 무변경).**
그 복귀가 가능한 이유는 역방향 export 산출물이 **Node 서버가 실제로 여는 SQLite 파일**이기 때문이다.

> **원본 `news.db` 는 지우지 않는다.** 되돌릴 때 필요한 것은 "지금 MySQL 에 있는 내용"이고, 원본은
> 그것과 별개로 **비교 기준**으로 남는다. 이름을 바꿔 보관하라(`news.db.<날짜>.bak`) — 옮기지 말고 복사하라.

① **Spring 을 정지한다.** 요청을 받는 프로세스가 없어야 아래 스냅샷이 "그 순간의 전부"다.

② **지금의 MySQL 내용을 SQLite 파일로 내린다** — 리포 밖 경로에, 아직 없는 파일 이름으로.

```bash
java -jar tools/news-migrator/target/news-migrator.jar \
  export --target NEWS_MIGRATOR --out D:/agents/rollback/news-<날짜>.db
```

③ **왕복을 확인한다**(권장). 이관 직후라면 원본과 셀 하나까지 같아야 한다 — 다르면 종료코드 **4**다.

```bash
java -jar tools/news-migrator/target/news-migrator.jar \
  verify --source news.db --target-sqlite D:/agents/rollback/news-<날짜>.db
```

④ **그 파일을 Node 서버의 `DATA_DIR` 에 `news.db` 라는 이름으로 놓는다**(원본은 옆에 이름을 바꿔 보관).

⑤ **Node 를 기동한다.**

```bash
DATA_DIR=D:/agents/rollback-data PORT=3001 node server/index.js
```

⑥ **검증 3종 — 로그인 · 목록 · 상세 1건.**

```bash
curl -s -c cookies.txt -H "Content-Type: application/json" \
  -d '{"userId":"<계정>","password":"<비밀번호>"}' http://127.0.0.1:3001/api/login
curl -s -b cookies.txt http://127.0.0.1:3001/api/articles
curl -s -b cookies.txt http://127.0.0.1:3001/api/articles/<articleId>
```

**알아 둘 것 다섯**

1. **`export` 는 이미 있는 파일을 덮어쓰지 않는다**(종료코드 1). 되돌림 자산을 덮어쓰는 실수는 되돌릴 수
   없기 때문이다. 다시 내리려면 **새 이름**을 주어라.
2. **중간에 실패하면 만들다 만 파일이 남는다.** 이 도구에는 파일을 지우거나 옮기는 경로가 없다(정적
   게이트가 금지한다 — 그 금지가 원본 `news.db` 를 지키는 방어선이다). 사람이 치운 뒤 다시 돌려라.
3. **산출물은 리포 밖에 만들어라.** 리포 안에 두면 `.gitignore` 의 `news.db` 규칙과 엇갈려 실데이터가
   커밋될 수 있다.
4. **부팅이 스키마를 고치지 않는다.** 산출물의 스키마는 정본(`src/db/schema.js`)과 동형이라 Node 의
   `createSchema` 가 컬럼을 하나도 추가하지 않는다. 2026-09-03 실측 — 임시 `DATA_DIR` 에 놓고 서버를 띄운
   뒤 **파일 md5 가 그대로였다**(로그인 200 · 목록 77건 · 상세 200).
5. **되돌린 뒤에도 MySQL 은 그대로 둔다**(지우지 않는다). 원인 조사가 남아 있고, 무엇보다 이 리포의
   최상위 규칙이다.

> **이 절차는 2026-09-04(step8)에 스테이징 대상으로 실제로 1회 리허설했다** — 무엇을 보았는지는 §11-⑦과
> §12 결과표에 있다. ③의 왕복 대조에는 함정이 하나 있다(§11-⑦ 주석): **원본 `news.db` 와 대조하는 것은
> "이관 직후"에만 유효**하고, 그 뒤로 운영이 진행됐다면 원본과 다른 것이 정상이다. 그때의 무결성 판정은
> **산출물 ↔ 지금의 MySQL** 대조다(`verify --source <산출물> --target NEWS_MIGRATOR`).

## 10. 계약 하네스를 MySQL 로 돌리기 (step7)

`scripts/spring-contract.mjs` 에 `--db <sqlite|mysql>` 이 있다. **기본은 `sqlite` 라 기존 커맨드는 한 글자도
바뀌지 않는다.** `mysql` 이면 패스마다 임시 DB(`harness_ct_<16진수 16자리>`)를 만들어 시드를 마이그레이터로
적재하고 Spring 을 `DB_KIND=mysql` 로 그 DB 에 붙인다.

```bash
# 준비: jar 둘을 먼저 빌드한다(하네스는 스스로 빌드하지 않는다)
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests

# §3 절차로 NEWS_CT_MYSQL_* 만 셸에 싣고(NEWS_DB_* 는 싣지 마라 — 모순 거부에 걸린다)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --parity
```

**알아 둘 것 넷**

1. **자격은 `news_ct` 다**(`NEWS_CT_MYSQL_*`). `news_app` 을 쓰면 안 된다 — 그 계정은 `harness_ct_%` 에
   권한이 0이라 `SchemaGuard` 의 첫 조회에서 죽는다.
2. **⚠ 그래서 이 하네스는 `news_app` 의 최소 권한을 검증하지 않는다.** 특히 §7 의
   `GRANT DELETE ON <db>.ReceiverConfig` 가 없어도 **`--db mysql --parity` 는 green 이다**(2026-09-04 step7
   실측 — 313 관측 diffs 0). 운영 배포의 판정은 §7 의 `SHOW GRANTS` 로 따로 하라.
3. **환경변수가 없으면 즉시 실패한다**(sqlite 로 조용히 폴백하지 않는다). 폴백은 "green 인데 아무것도
   검증하지 않은" 상태를 만든다.
4. **임시 DB 는 성패와 무관하게 지워진다.** 정리에 실패하면 이름을 stderr 로 알리고 실행 자체가 실패한다 —
   그 이름으로 직접 지워라: `java -jar tools/news-migrator/target/news-migrator.jar ephemeral-drop --name <이름>`.
   실행 후 잔재 확인은 `SHOW DATABASES LIKE 'harness\_ct\_%';` 다.
5. **판정부 단위 테스트가 시작 시 자동으로 돈다**(2026-09-04 ⑤ [low] 2). `--db mysql` 은 자격을 읽기
   **전에** 아래를 자식으로 돌리고, red 면 DB 를 하나도 만들지 않은 채 멈춘다. 따로 돌려 볼 수도 있다
   (DB 도 자격도 필요 없다 · 약 0.1초):

   ```bash
   node --test scripts/lib/mysqlHarness.test.mjs
   ```

   이유: `package.json` 은 무수정 목록이고 `npm test` 는 `"test/**/*.test.js"` 만 훑는다. 그대로 두면
   **임시 DB 이름 규약 · URL 조립 · 비밀 길이 하한 · 비밀 가리기** — 틀리면 조용히 엉뚱한 DB 를 지우거나
   비밀을 흘리는 판정들이 **어떤 자동 게이트에도 없는** 상태가 된다.

## 11. 운영 컷오버 런북 (step8 — **절차 확정** · 실행은 P3)

> **이 phase 는 운영 데이터를 옮기지 않는다.** 컷오버는 정지 창·백업·사람의 승인이 붙는 별개 사건이다.
> 아래 명령은 **운영 대상(`news`)에 대한 3·4·4-b·5 를 빼고 전부 스테이징에서 실제로 돌려 본 것**이고,
> 무엇이 실행됐고 무엇이 미실행인지는 **§12 결과표**가 명령 단위로 밝힌다. 결과표에 없는 문장은
> "이렇게 될 것이다"가 아니라 **미실측**으로 읽어라.

### 0. 시작 전 체크리스트 (하나라도 비면 시작하지 마라)

| # | 확인 | 커맨드 | 기대 |
|---|---|---|---|
| 0-1 | jar 둘이 있다 | `ls server-spring/target/server-spring-0.0.1-SNAPSHOT.jar tools/news-migrator/target/news-migrator.jar` | 둘 다 존재(하네스·런북 모두 **스스로 빌드하지 않는다**) |
| 0-2 | 자격 3키가 셸에 있다 | §3 의 로드 절차 | `NEWS_MIGRATOR_*` 3키 (Spring 기동에는 `NEWS_DB_*` 3키) |
| 0-3 | 서버·클라이언트 판본 | `%M% --version` · `%M% -u news_app -p -e "SELECT VERSION()"` | 실측 2026-09-04: **둘 다 8.0.46** |
| 0-4 | **삭제 예외 grant** | `%M% -u news_app -p -e "SHOW GRANTS"` | ``GRANT DELETE ON `news`.`receiverconfig` `` 줄이 보인다 — **없으면 4-b 로 붙인다**(아래) |
| 0-5 | 한글 출력 | java 커맨드에 `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8` · Windows 콘솔은 `chcp 65001` | 실측: 옵션 없이는 마이그레이터의 한글 메시지가 **깨진다** |
| 0-6 | 대상이 비어 있다 | `%M% -u news_migrator -p -e "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='news'"` | **빈 결과**(2026-09-04 실측: `news` 는 테이블 0개다) |

> **0-4 를 건너뛰지 마라 — 이것이 이 런북에서 가장 조용한 실패다.** grant 가 없으면 서버는 정상 기동하고
> 계약 하네스도 **green** 인데(하네스는 `news_ct`=ALL 로 돈다) `DELETE /api/receiver-config/:id` 만
> **500 `internal-error`** 다. 2026-09-04 실측: `news_app` 으로 `news_stage.ReceiverConfig` 를 지우려 하면
> `ERROR 1142 (42000): DELETE command denied to user 'news_app'@'localhost' for table 'receiverconfig'` 이고,
> 예외가 붙어 있는 DB 에서는 같은 문장이 권한 검사를 **통과**한다(그쪽은 열 이름에서 걸린다 — `ERROR 1054`).
> 즉 1142 인지 아닌지가 곧 grant 유무의 판정이다.

### 1. 사전 — Node 정지 · 원본 사본 2벌

```bash
# ① Node 서버를 내린다(요청을 받는 프로세스가 없어야 이 스냅샷이 "그 순간의 전부"다)
# ② 사본 2벌: 하나는 타임스탬프 이름으로 영구 보관, 하나는 즉시 되돌림용
cp news.db  <리포 밖>/backup/news.db.$(date '+%Y%m%d-%H%M%S').bak
cp news.db  <리포 밖>/backup/news.db.rollback-ready
md5sum news.db <리포 밖>/backup/news.db.*        # 세 값이 같아야 한다
```

실측(2026-09-04): 606,208 B 사본 2벌에 **173 ms**, 세 파일 md5 전부 `7247e9e0dfe5cc8cd040ebb1dc9fb967`.
**원본 `news.db` 는 옮기지도 이름을 바꾸지도 지우지도 않는다 — 복사만 한다.**

### 2. 계정·부트스트랩 확인

```powershell
& $M -u news_app      -p -e "SELECT 1"      # 3계정 각각
& $M -u news_migrator -p -e "SHOW GRANTS"
& $M -u news_ct       -p -e "SHOW DATABASES"
```

실측(2026-09-04): 3/3 접속. `news_migrator` 는 `news`·`news_stage` 에 `SELECT,INSERT,UPDATE,CREATE,REFERENCES,INDEX,ALTER`
(**`DELETE`·`DROP` 없음**), `news_ct` 에게는 `news`·`news_stage` 가 **`SHOW DATABASES` 에 보이지도 않는다**.

### 3. 이관 — `migrate`

```bash
export NEWS_MIGRATOR_URL="${NEWS_MIGRATOR_URL/news_stage/news}"   # 대상 DB 를 운영으로 바꾼다(자격은 그대로)
java -Dstdout.encoding=UTF-8 -jar tools/news-migrator/target/news-migrator.jar \
  migrate --source news.db --target NEWS_MIGRATOR
```

- `--target` 은 **환경변수 키 집합 이름**이지 DB 이름이 아니다(DB 는 그 키 집합의 URL 이 정한다).
- **빈 대상이 전제다.** 아니면 **비우지 않고 멈춘다**(exit 1). 이것은 실패가 아니라 설계다 — 멱등성을 삭제로 사지 않는다.
- 출력의 테이블별 행 수와 `다음 id` 를 **캡처해 보관하라**(이관 직후 첫 삽입이 PK 충돌로 죽는지 여기서 갈린다).

### 4. 대조 — `verify`

```bash
java -Dstdout.encoding=UTF-8 -jar tools/news-migrator/target/news-migrator.jar \
  verify --source news.db --target NEWS_MIGRATOR
```

**exit 0 · "판정: 일치" · 불일치 0** 이어야 다음으로 간다. 행 수 표와 리포트 파일(OS 임시 디렉토리에 남는다)을
**전환 기록으로 보관**하라. exit **4** 는 "대조는 돌았고 데이터가 다르다"이고 exit **1** 은 "대조를 못 돌렸다"다 — 처방이 다르다(§11-8).

### 4-b. 삭제 예외 grant 를 `news` 에 붙인다 (root 1회 · **테이블이 생긴 지금에야 붙는다**)

MySQL 은 테이블 단위 `GRANT` 를 **대상 테이블이 있을 때만** 받는다. 그래서 §2 의 부트스트랩은 이 문장에서
`ERROR 1146` 으로 끝났고, 그것이 정상이었다. **3 이 끝난 지금 시나리오가 둘로 갈린다.**

| 시나리오 | 상태 | 실행할 것 |
|---|---|---|
| (가) **컷오버 시점**(`news` 에 테이블이 생겼다) | §7 의 두 `GRANT` 가 **둘 다 붙는다** | `& $M -u root -p -e "source <경로>/ops/mysql/bootstrap.local.sql"` — **`--force` 가 필요 없다** |
| (나) **지금(P2)** — `news` 는 비어 있고 `news_stage` 만 있다 | 첫 문장이 `ERROR 1146` 으로 죽고 배치가 **거기서 멈춘다**(뒤 문장이 실행되지 않는다) | `--force` 를 붙이거나 `news_stage` 한 줄만 실행한다 |

```powershell
# PowerShell 은 '<' 리디렉션을 지원하지 않는다(실측: "'<' 연산자는 나중에 사용하도록 예약되어 있습니다" ParserError).
# 반드시 -e "source <파일>" 형태를 쓴다(실측: 이 형태는 정상 동작한다).
& $M -u root -p -e "source D:/agents/harness/ops/mysql/bootstrap.local.sql"
```

확인: `& $M -u news_app -p -e "SHOW GRANTS"` 에 ``GRANT DELETE ON `news`.`receiverconfig` `` 줄이 보이면 완료다
(테이블 이름이 **소문자**로 붙는다 — `lower_case_table_names=1`).

### 5. Spring 기동 (`DB_KIND=mysql`)

```bash
DATA_DIR=<지금까지 쓰던 데이터 디렉토리> PORT=<포트> DB_KIND=mysql \
  java -jar server-spring/target/server-spring-0.0.1-SNAPSHOT.jar
curl -i http://127.0.0.1:<포트>/api/health      # 200 {"ok":true}
```

- **`DATA_DIR` 은 mysql 모드에서도 필수**이고 **같은 경로를 그대로 써야 한다** — `news.db` 를 열지 않을 뿐
  **업로드 원본(`<DATA_DIR>/uploads/`)은 여전히 거기서 서빙**된다. 옮기면 기존 첨부·사진이 전부 404 다.
- `NEWS_DB_URL` 이 `news` 를 가리키는지 확인하라. **`DB_KIND` 와 URL 이 모순이면 기동을 거부한다**(설계된 거부).
- 육안 확인 목록(사람이 브라우저에서): **로그인 → 목록 → 상세 → 편집 잠금 → 송고 → 이력 → 사진 검색 →
  수집 설정 생성·삭제**. 마지막 항목이 **0-4 grant 의 실사용 판정**이다(200 이어야 하고, 500 이면 grant 가 없는 것이다).

### 6. **이 시점부터 Node 서버를 쓰지 않는다**

> **경고 — 두 서버는 이제 서로 다른 저장소를 본다.** Node 는 SQLite `news.db`, Spring 은 MySQL `news` 다.
> 컷오버 뒤에 Node 서버를 한 번이라도 띄워 **쓰기**가 일어나면 두 저장소가 갈리고, 그 갈림은 **자동으로
> 합쳐지지 않는다**(어느 쪽이 정본인지 판정할 근거가 사라진다). 되돌릴 생각이면 **8 의 롤백 절차**로 가라 —
> Node 를 그냥 켜는 것은 롤백이 아니다.

### 7. 롤백 — Spring/MySQL → Node/SQLite (§9 의 절차 · **리허설 실측**)

절차 자체는 **§9** 가 소유한다. 2026-09-04 에 **스테이징 대상으로 1회 리허설**했고 본 것은 아래가 전부다.

| 단계 | 실행한 것 | 본 것 |
|---|---|---|
| ① Spring 정지 | (리허설에서는 기동 중이 아니었다) | — |
| ② `export` | `export --target NEWS_MIGRATOR --out <리포 밖>/rollback/news-20260904.db` | **exit 0 · 1,575 ms** · 7테이블 **239행**(User 37 · Article 84 · Contents 84 · ArticleHistory 19 · ReceiverConfig 7 · DistributionTarget 0 · Photo 8) · 산출물 **618,496 B · md5 `3021afa5d7cd8a61e43a268b7321dc82`** · 부산물 0개 |
| ②′ 같은 경로로 한 번 더 | 같은 커맨드 | **exit 1 · 201 ms** — `산출물이 이미 있다(덮어쓰지 않는다 — 되돌릴 수 없다)`. 되돌림 자산은 덮어쓰지 않는다 |
| ③ 무결성 대조 | `verify --source <산출물> --target NEWS_MIGRATOR` | **exit 0 · 1,490 ms** · **판정: 일치** · 239행 = 239행 · 7테이블 **불일치 0** · 제외 `flyway_schema_history` |
| ③′ 원본과의 대조 | `verify --source news.db --target-sqlite <산출물>` | **exit 4 · 1,170 ms** · 소스 178행 / 대상 239행 · **불일치 61** · 구조 문제 0 — **정상이다**(스테이징에 step6 스모크 행이 쌓여 있다). ⚠ 아래 주석 |
| ④ 배치 | 산출물을 임시 `DATA_DIR` 에 `news.db` 로 복사 | md5 그대로 |
| ⑤ Node 기동 | `DATA_DIR=<임시> PORT=3099 node server/index.js` | **부팅 761 ms · `GET /api/health` 200 `{"ok":true}`** |
| ⑥ 검증 | 로그인 → 목록 → 상세 → 사진 검색 | **로그인 200**(sessionId 64자) · **목록 200 · 84건** · **상세 200**(`AKR20260904489113853`) · **사진 검색 200** |
| ⑥′ 파일 무변 | 부팅·로그인·종료 후 md5 재측정 | **`3021afa5d7cd8a61e43a268b7321dc82` 동일** — Node 의 `createSchema` 가 컬럼을 하나도 더하지 않았고 부트 백필도 아무것도 쓰지 않았다 |
| ⑥″ 잔재 | 임시 `DATA_DIR` 내용 | `news.db` 외에 `instance-lock.db`(0 B)와 `instance-lock.db-journal`(512 B) — ADR-012 의 잠금 표식이고 데이터가 아니다 |

> **③ 와 ③′ 중 무엇이 무결성 판정인가.** 되돌릴 때 확인해야 하는 것은 "산출물이 **지금의 MySQL** 을 빠짐없이
> 담았는가"이므로 **③**(산출물 ↔ MySQL)이 판정이다. **③′(원본 `news.db` 와의 대조)는 "이관 직후"에만 0 이고**,
> 운영이 하루라도 진행됐다면 **다른 것이 정상**이다 — 그 자리에서 exit 4 를 롤백 실패로 읽으면 안 된다.
> §9 ③이 "이관 직후라면"이라고 적은 조건이 이것이고, 리허설이 그 조건을 실제로 벗어난 상태에서 재현됐다.

### 8. 실패 시나리오별 분기 (전부 **실측한 문구**다)

| 무슨 일이 났는가 | 어떻게 드러나는가(실측) | 안전한 다음 수 |
|---|---|---|
| **대상이 비어 있지 않은데 `migrate`** | **exit 1** · `대상이 비어 있지 않다 [User, Article, Contents, ArticleHistory, ReceiverConfig, Photo] — 비우고 다시 넣지 않는다.` **아무것도 지우지 않았고 소스 md5 도 그대로다** | 대상을 비우는 것은 **사람(root)의 일**이다(`news_migrator` 에는 `DELETE`·`DROP` 이 없다). 빈 DB 를 준비해 재실행 |
| **`verify` 불일치** | **exit 4** · `대조 불일치 N건 · 구조 문제 M건 — 리포트를 보세요.` 리포트에 테이블·PK·컬럼이 지목된다(값 원문은 싣지 않고 길이만) | **전환을 멈춘다.** Node 는 아직 정본이므로 그대로 되살리면 된다(6 을 시작하지 않았다면 아무 일도 없었다) |
| **`verify` 를 못 돌렸다** | **exit 1**(접속·파일 오류) | 데이터 판정이 아니다 — 자격·경로를 고쳐 다시 돌려라. **exit 4 와 섞지 마라** |
| **`DB_KIND` 누락/모순인 채 기동** | **exit 1** · `app.db.kind 와 app.db.url 이 서로 다른 저장소를 가리킵니다: kind=sqlite 인데 url 은 jdbc:mysql: 로 시작합니다` | 환경변수를 맞춘다. **URL 로 방언을 추론하지 않는 것이 설계다**(누락이 조용히 옛 파일로 되돌아가지 않게) |
| **적재 전/부분 적재 상태로 기동** | **exit 1** · `DB 스키마가 이 서버의 요구를 만족하지 않습니다 (jdbc:mysql:): 테이블 없음 = DistributionTarget / … / 테이블 없음 = ArticleHistory` — **가장 먼저 깨지는 것은 관측이 아니라 부팅이다** | 3 으로 돌아간다. ⚠ 이 메시지의 마지막 문장("Node 서버로 데이터 디렉토리를 준비한 뒤")은 **sqlite 시절의 처방**이다 — mysql 모드의 처방은 **`migrate`** 다 |
| **grant 누락** | 기동 성공 · 계약 하네스 **green** · 그러나 `DELETE /api/receiver-config/:id` 만 **500** | 0-4·4-b 로 붙인다. 감지는 `SHOW GRANTS` 또는 위 육안 확인 마지막 항목뿐이다 |
| **`export` 가 중간에 실패** | 만들다 만 파일이 **남는다**(이 도구에는 파일을 지우거나 옮기는 경로가 **없다** — 그 금지가 원본 `news.db` 를 지키는 방어선이다). 메시지가 남은 파일의 경로를 밝히고 멈춘다 | 사람이 그 파일을 치운 뒤 **새 이름**으로 재실행 |
| **임시 DB 잔재**(하네스 경로) | 실행이 실패하며 이름을 알린다 | `ephemeral-drop --name <이름>` · 확인은 `SHOW DATABASES LIKE 'harness\_ct\_%'` |

## 12. 명령별 실행 결과표 (step8 · 2026-09-04 실측)

**이 표에 없는 것은 미실측이다.** 「실행」 열이 `스테이징`인 줄은 대상만 `news_stage`/임시 파일로 바꿔 **같은 명령**을
돌린 것이고, `미실행`인 줄은 이 phase 의 범위 밖(P3)이라 돌리지 않은 것이다.

| # | 명령(런북 항목) | 실행 | 종료코드 · 관측값 | 실패 시 무엇이 일어났는가 |
|---|---|---|---|---|
| 1 | `cp news.db …` ×2 + `md5sum` (1) | **실행** | 173 ms · 사본 2벌 606,208 B · md5 3파일 전부 `7247e9e0…` | — |
| 2 | 세 계정 `SELECT 1` / `SHOW GRANTS` (0-3·2) | **실행** | 3/3 접속 · 클라이언트·서버 **8.0.46** · `news_ct` 에게 `news`·`news_stage` 는 보이지 않는다 | — |
| 3 | `SHOW GRANTS` 로 삭제 예외 확인 (0-4) | **실행** | **`news`·`news_stage` 에 `DELETE` 없음** · 있는 것은 `news_grant_probe.receiverconfig` 뿐 | 이 상태가 곧 "grant 누락" 시나리오다(아래 4) |
| 4 | `DELETE FROM ReceiverConfig WHERE id = -1` (0-4 행동 판정) | **실행**(`news_stage`·`news_app`) | **`ERROR 1142` denied** · 대조군(예외가 붙은 DB)은 권한 검사를 통과해 `ERROR 1054` · `Contents` 는 1142 · **행 수 불변(7)** | 어떤 행도 지워지지 않았다(권한 거부는 문장 실행 전이다) |
| 5 | `SELECT … information_schema.TABLES` (0-6) | **실행** | **`news` = 테이블 0개** · `news_stage` = 7테이블 + `flyway_schema_history` | — |
| 6 | `migrate --source news.db --target <운영>` (3) | **미실행 — P3 소유** | — | 운영 컷오버는 정지 창·백업·승인이 붙는 별개 사건이다(step8 금지사항) |
| 7 | `migrate` 를 **비어 있지 않은 대상**에 (3 의 fail-closed) | **스테이징** | **exit 1** · 1,720 ms · 점유 6테이블 지목 · `news.db` md5 **무변** | 비우지 않고 멈췄다. 대상에 아무 변화 없음 |
| 8 | `verify --source news.db --target <운영>` (4) | **미실행 — P3 소유**(대상이 없다) | — | — |
| 9 | `verify --source news.db --target <스테이징>` (4 의 불일치 분기) | **스테이징** | **exit 4** · 1,324 ms · 소스 178행 / 대상 239행 · **불일치 61 · 구조 문제 0** · 제외 `flyway_schema_history` | 스모크가 남긴 행이 테이블·PK 로 지목됐다(값 원문 없이). 소스 md5 무변 |
| 10 | `bootstrap.local.sql` 재실행 (4-b) | **미실행 — root 자격이 없다** | — | 이 리포의 어떤 자동화도 root 로 접속하지 않는다(§0). 시나리오 (가)/(나) 구분은 §11-4-b |
| 11 | PowerShell `<` 리디렉션 (4-b 형태) | **실행** | **ParserError** — `'<' 연산자는 나중에 사용하도록 예약되어 있습니다` | 부트스트랩이 한동안 실행되지 않은 원인이 이것이다 |
| 12 | `mysql -e "source <파일>"` (4-b 대체 형태) | **실행** | **exit 0** — 파일 안의 두 문장이 실행됐다 | 이 형태를 쓰면 PowerShell 에서도 돈다 |
| 13 | Spring `DB_KIND=mysql` 기동 + `/api/health` (5) | **스테이징**(`news_stage`·`news_app`) | 부팅 **4,239 ms** · **200 `{"ok":true}`** · 미인증 `GET /api/articles` **401** | — |
| 14 | 5 의 육안 확인 목록(로그인·목록·상세·잠금·송고) | **부분 미실행** | 이 축은 **step6 `NewsAppMysqlWireTest`**(같은 자격·같은 DB 로 전 경로 통과)와 **`--db mysql --parity` 313관측**이 덮는다 | 리허설로 `news_stage` 를 더 오염시키지 않기 위해 이 step 에서는 쓰기 경로를 돌리지 않았다 |
| 15 | `DB_KIND` 없이 기동 (8) | **실행** | **exit 1** · kind/url 모순 거부 메시지 | 기동 자체가 거부됐다(조용한 폴백 없음) |
| 16 | 빈 스키마(`news`)에 mysql 기동 (8) | **실행** | **exit 1** · `SchemaGuard` 가 **7테이블을 이름으로 지목** | `news` 에 아무것도 만들지 않았다(이 서버는 DDL 0) |
| 17 | `export --target <스테이징> --out <리포 밖>` (7-②) | **실행** | **exit 0** · 1,575 ms · 239행 · 618,496 B · md5 `3021afa5…` | — |
| 18 | 같은 경로로 `export` 재실행 (7-②′) | **실행** | **exit 1** · 201 ms · 덮어쓰기 거부 | 기존 산출물이 그대로 남았다 |
| 19 | `verify --source <산출물> --target <스테이징>` (7-③) | **실행** | **exit 0** · 1,490 ms · **일치** · 239=239 · 불일치 0 | — |
| 20 | `verify --source news.db --target-sqlite <산출물>` (7-③′) | **실행** | **exit 4** · 1,170 ms · 불일치 61 | 스테이징 드리프트를 정확히 반영한 값이다(롤백 실패가 아니다 — §11-7 주석) |
| 21 | 임시 `DATA_DIR` 배치 + Node 기동 (7-④⑤) | **실행** | 부팅 **761 ms** · `/api/health` **200** | — |
| 22 | 로그인·목록·상세·사진검색 (7-⑥) | **실행** | **200 / 200(84건) / 200 / 200** · sessionId 64자 | — |
| 23 | 부팅 전후 md5 (7-⑥′) | **실행** | **동일**(`3021afa5…`) | 스키마·백필이 파일을 한 바이트도 바꾸지 않았다 |
| 24 | `SHOW DATABASES LIKE 'harness\_ct\_%'` (8) | **실행** | **잔재 0개** | — |
| 25 | 한글 출력 인코딩 (0-5) | **실행** | 옵션 없이 **깨짐** · `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8` 로 **정상** | Windows 콘솔의 `chcp 65001` 은 이 환경에서 실행할 수 없어 **미실측** |

> **이 실측이 `news_stage` 를 바꾼 곳은 한 군데뿐이고, 그것은 런북 명령이 아니라 `mvnw verify` 다**(§3 의 경고와 같은 축).
> 위 명령들(대조·export·기동·권한 프로브)은 **행을 하나도 더하거나 지우지 않았다** — 권한 거부는 문장 실행 전이고 `migrate` 는
> 멈췄으며 `verify`·`export` 는 읽기다. 반면 AC 로 돌린 `server-spring` 의 `clean verify` 는 `NewsAppMysqlWireTest` 가
> **실행마다 9행을 추가**한다(계정 4 · 기사 1 · 본문 1 · 이력 1 · 수집 설정 1 · 사진 1). 이 step 에서 2회 돌렸으므로
> **239행 → 257행**(User 37→45 · Article 84→86 · Contents 84→86 · ArticleHistory 19→21 · ReceiverConfig 7→9 · Photo 8→10 ·
> DistributionTarget 0)이 됐고 **지운 행은 0** 이다. 되돌리려면 스테이징을 비우고 재적재해야 하는데 그 권한은 root 에만 있다
> (§3 의 같은 경고 · P3 항목). **운영 컷오버 전에는 대상이 비어 있어야 하므로**(§11-0-6) 이 사실이 컷오버를 막지는 않는다.

## 13. P3 컷오버 실행 체크리스트 (phase 76 정본화 · 실행은 P3 사람 몫)

> **이 절은 §11 명령 런북 위에 얹는 "실행 순서·게이트" 체크리스트다.** §11 은 각 명령이 무엇을 하고
> 무엇이 스테이징에서 실측됐는지를, §12 는 명령별 종료코드·관측값을 소유한다. 이 §13 은 **그 명령들을
> 컷오버 사건 하나로 엮는 순서**와, phase 76 이 새로 만든 도구·플래그를 그 순서에 배치한다. 명령 본문·
> 종료코드는 **§11/§12 를 링크로 재사용한다**(같은 절차를 두 번 적지 않는다 — 두 벌이 갈리면 운영자가
> 조용한 실패에 빠진다).
>
> **정직한 미실행 표시(§12 규약과 일관).** 운영 대상(`news`) 명령 — `migrate --target NEWS_MIGRATOR`
> (대상 URL 을 `news` 로) · 운영 `verify` · 운영 `SHOW GRANTS` 판정 · Spring 운영 기동 — 은 이 phase 에서
> **미실행이며 사람 몫(P3)** 이다(정지 창·백업·승인·root 가 붙는 별개 사건 · index.json decisions (1) ·
> excluded (a)(b)). §12 의 「실행」 열에서 `미실행 — P3 소유`로 표기된 줄이 이 항목들이다. 아래 체크리스트는
> 그 사건을 **사람이 따르는 절차**로만 정본화한다.

### 13-0. 선결 조건 게이트 (go/no-go — 하나라도 no 면 컷오버를 시작하지 않는다)

| # | 게이트 | 어떻게 판정하나 | go 기준 |
|---|---|---|---|
| G-1 | **[GRANT] 삭제 예외** | 아래 13-1 (§11-0-4 와 같은 취지) | grant 가 (재컷오버라) **이미 붙어 있거나**, **§13-3 step 4(§11-4-b)에서 붙인다고 운영자가 확인하고 root 가 대기 중**이다. 빈 대상 전제(G-3)에서는 테이블이 아직 없어 grant 가 이 시점 `SHOW GRANTS` 에 **안 보이는 게 정상**이므로 여기서 "지금 보인다"를 요구하지 않는다 — **하드 육안 판정(`SHOW GRANTS` 에 그 줄이 실제로 보임)은 테이블이 생긴 뒤 step 6** |
| G-2 | **[검증 게이트] 시나리오 하네스** | 아래 13-2 의 이중 대조 리허설 | 배부 스풀 **diff 0** (exit 0) |
| G-3 | **[대상 비어있음]** | §11-0-6 (`information_schema.TABLES`) | 운영 `news` 가 테이블 0 (또는 빈 스키마) |
| G-4 | **[백업]** | §11-1 (원본 `news.db` 사본 2벌 · md5 일치) | 세 파일 md5 동일 · 원본은 복사만(옮기지·이름바꾸지 않음) |
| G-5 | **[판본·자격]** | §11-0-1·0-2·0-3 | jar 둘 존재 · 자격 3키 로드 · 클라/서버 8.0.46 |

### 13-1. [GRANT] go/no-go 게이트 — 계약 필수 조건이며 하네스가 못 본다

> **이것이 이 컷오버에서 가장 조용한 실패다.** `GRANT DELETE ON news.ReceiverConfig TO 'news_app'@'localhost';`
> 는 **하드닝 옵션이 아니라 계약 필수 조건**이다(index.json decisions (2) · §7). 없으면 서버는 **정상 기동**
> 하고 계약 하네스도 **green** 인데 `DELETE /api/receiver-config/:id` **한 라우트만** 계약이 동결한
> `200 {"ok":true,"changes":1}` 대신 **500 `internal-error`** 를 낸다(권한 오류가 전역 핸들러로 샌다 · Node 는 200).

**왜 자동 게이트로 대체할 수 없나.** 계약 하네스와 `node scripts/operation-scenario.mjs --dual --db mysql`
(§13-2)은 **ephemeral `harness_ct_<16hex>` 에 `news_ct`(ALL 권한)** 로 돈다 — 이 축을 **구조적으로 못 본다**.
"패리티 green" 은 이 grant 의 부재를 **덮어 준다**. 따라서 판정은 **사람이 `SHOW GRANTS` 로 눈으로** 한다.

> **판정 시점에 주의하라 — G-1(선결 게이트)과 육안 판정을 헷갈리지 마라.** grant 는 `news`.`ReceiverConfig`
> **테이블에 걸리는데, 그 테이블은 `migrate`(§13-3 step 3) 전에는 없다** — 그래서 빈 대상 전제(G-3)에서
> **컷오버 시작 시점의 `SHOW GRANTS` 에 이 줄이 안 보이는 게 정상**이고, root 는 §13-3 step 4(§11-4-b)에서
> 테이블이 생긴 **뒤에야** 붙인다(§11-0-4 의 "없으면 4-b 로 붙인다"와 같은 취지). 그러므로 **선결 게이트 G-1 은
> "지금 보인다"를 요구하지 않는다**: grant 가 (재컷오버라) 이미 붙어 있거나, **step 4 에서 붙인다고 운영자가
> 확인하고 root 가 대기 중**이면 go 다. **하드 육안 판정 — 아래 `SHOW GRANTS` 에 그 줄이 실제로 보여야 한다 —
> 은 테이블이 생긴 뒤인 §13-3 step 6 에서** 한다(명령·기준은 그 step 이 이 절을 재사용한다).

```powershell
# (§13-3 step 6 · 테이블·grant 부착 뒤) 운영 자격(news_app)으로 붙어 자기 권한표를 본다 (비밀번호는 프롬프트 · §5)
& $M -u news_app -p -e "SHOW GRANTS"
```

- ``GRANT DELETE ON `news`.`receiverconfig` TO 'news_app'@'localhost'`` 줄이 보이면 **go**
  (테이블 이름이 소문자로 붙는다 — `lower_case_table_names=1`).
- 안 보이면 **멈춤**(테이블이 생긴 뒤인데도 안 보이면 step 4 로 되돌아가 부착). 붙이는 것은 **root 의 일이고
  이 phase 는 자동으로 붙이지 않는다**(excluded (b)). §11-4-b 처럼 `migrate` 로 `news` 에 테이블이 **생긴 뒤**
  root 로 §7 절차를 적용한다(멱등 재실행 또는 한 줄):
  ``GRANT DELETE ON `news`.`ReceiverConfig` TO 'news_app'@'localhost';`` → `FLUSH PRIVILEGES;`

**부재 시 증상(육안 확인 마지막 항목과 같은 축)**: §11-5 의 브라우저 육안 목록에서 **수집 설정 삭제**가
`500` 이면 grant 가 없는 것이다(생성=200 인데 삭제만 500). 자동 방어선은 이 축을 스테이징에서 이렇게 실증한다:
`NewsAppMysqlWireTest`(같은 자격·같은 DB 로 `DELETE` 응답을 실측해 고정) · `MinimumPrivilegeBoundaryTest`
(판정이 "우리가 기대한 표와 같은가"가 아니라 **"서버가 자기 `SHOW GRANTS` 표대로 실제로 막는가"** 다 —
그래서 grant 가 없어도 red 가 아니라, "삭제 성공" 절반이 실증되지 않은 채로 통과한다). 즉 **운영 판정은
`SHOW GRANTS` 육안뿐**이다.

### 13-2. [검증 게이트] 시나리오 하네스로 컷오버 리허설

정지 창에 들어가기 전에, **배부 스풀 직렬화 파리티**를 먼저 통과시킨다. 이 게이트는 "작성→송고→배부→수집"
전체 루프를 두 서버(Node/SQLite · Spring/MySQL)에서 **동일 seed 행**으로 구동하고, `POST /api/distribution/tick`
1회로만 쓴 배부 스풀 파일을 **정규화 후 바이트 대조**한다(diff 0).

```bash
# ephemeral MySQL 대조 게이트 (phase 76 step2 산출물 · harness_ct_<16hex> 사용 · 운영 news 무접촉)
node scripts/operation-scenario.mjs --dual --db mysql
```

- 이 하네스는 **아키텍처의 「외부 cron / 운영 tick pull」 역할을 하는 외부 트리거**다(ADR-008 · decisions (4)) —
  앱 안에 타이머·egress·재시도·큐를 만들지 않고 `POST /api/distribution/tick`(body 무시)을 HTTP 로 부를 뿐이다.
- 단일 대상 전체 루프(`node scripts/operation-scenario.mjs --server node`)는 이미 컨테이너에서 돈다(step1);
  **이중 바이트 대조 diff 0** 이 컷오버 리허설의 판정이다.
- **한계(정직히)**: 이 게이트는 `news_ct`=ALL 로 돌아 **13-1 의 GRANT 축을 못 본다** — 그래서 G-1 이 별도 게이트다.

### 13-3. 정지 창 순서 (§11 을 참조 · 명령 본문은 중복하지 않는다)

아래는 순서만 정한다. 각 단계의 명령·종료코드·실측값은 괄호의 §11 항목이 소유한다.

1. **Node 정지 + 원본 사본 2벌** — §11-1 (원본 `news.db` 는 **복사만**).
2. **`migrate`** — §11-3 (빈 대상 전제 · 대상 URL 을 `news` 로).
3. **`verify`** — §11-4 (**exit 0 · 판정 일치 · 불일치 0** 이어야 다음으로).
4. **GRANT 부착 + `SHOW GRANTS` 확인** — §11-4-b · §13-1 (테이블이 생긴 지금에야 붙는다 · root 1회).
5. **Spring `DB_KIND=mysql` 기동** — §11-5 (`DATA_DIR` 는 같은 경로 유지 — uploads 서빙).
6. **GRANT 하드 육안 판정(G-1 확정) + 육안 확인** — 테이블이 생긴 지금에야 §13-1 의 `SHOW GRANTS` 로
   ``GRANT DELETE ON `news`.`receiverconfig` …`` 줄이 **실제로 보이는지** 눈으로 확정한다(안 보이면 **멈춤** — step 4 로
   되돌아가 부착). 이어 §11-5 목록을 확인한다. **마지막 항목=수집 설정 생성·삭제**가 곧 **GRANT 실사용 판정**(삭제 200 이어야 함).
7. **클라이언트 재지정** — §13-4.
8. **운영 cron(tick) 전환** — §13-5.
9. **Node 은퇴 표시** — §13-6.

### 13-4. 클라이언트 재지정 절차 (P3 "clients at Spring" · 세 경로)

컷오버 후 클라이언트가 Spring 을 보게 하는 정본 경로는 셋이다(index.json decisions (6) · ADR-011 승계 —
`NEWS_SERVER_URL` 은 **저장된 serverUrl 이 없을 때만** 적용되고 기존 `normalizeServerUrl`·health 프로브·
fail-safe 를 그대로 경유한다 · 원격 페이지에 Node 권한을 주지 않는다).

| 경로 | 무엇을 하나 | 되돌림(원복) |
|---|---|---|
| **(a) 동일 host:port 교체** — **강권장** | Spring 이 Node 가 쓰던 **같은 주소를 승계**한다(Node 정지 후 그 포트로 기동). **클라이언트 무변경** — 저장된 serverUrl 이 그대로 유효하다. | 그 주소에 다시 Node 를 올린다(§13-7 롤백). 클라 무변경. |
| **(b) 배포/설정으로 일부 클라만** | 병행 창에서 일부 클라를 Spring 으로: **설정 화면에서 serverUrl 변경** 하거나, 저장값이 없는 배포에 **`NEWS_SERVER_URL`**(step4)을 주입해 부팅 기본 서버 URL 을 Spring 오리진으로 준다. `NEWS_SERVER_URL` 은 `config.json` 에 자동 저장되지 않아 매 부팅 재계산된다. | 설정 화면에서 serverUrl 을 원복하거나 `NEWS_SERVER_URL` 을 제거/원복한다(저장된 serverUrl 이 있으면 env 는 무시되므로, 저장값을 지우거나 원 주소로 되돌린다). |
| **(c) 브라우저 SPA** | Spring 오리진으로 접속한다(정적 자산·API 를 Spring 이 같은 오리진에서 서빙). | 이전 오리진(Node)으로 접속한다. |

### 13-5. 운영 cron(tick) 전환 (ADR-008 — 외부 pull · 중복 방지)

배부는 **앱 안의 타이머가 아니라 외부 cron 이 Z 세션으로 `POST /api/distribution/tick` 을 pull** 해서 일으킨다
(ADR-008 · body 무시). 컷오버는 그 **cron 의 대상 URL 을 Node→Spring 으로 재지정**하는 절차일 뿐이다 —
**앱에 `@Scheduled`·타이머·egress·재시도·큐를 넣지 않는다**(넣는 순간 ADR-008 위반).

- **규율(중복 배부 방지)**: 병행 운영 창에서 **두 서버가 동시에 tick pull 되지 않게** cron 을 **한쪽만** 겨누게 한다.
  둘 다 tick 을 받으면 각자 자기 저장소에 스풀을 써서 **같은 기사가 두 번 배부**된다(두 저장소가 갈린다 · §11-6).
- **전환 순서**: cron 을 **잠시 멈춤 → 대상 URL 을 Spring 으로 교체 → 재개**. (동일 host:port 교체(13-4-a)라면
  cron 의 URL 도 바뀌지 않아 재지정이 불필요하다 — 대상이 그대로 Spring 이 승계한 주소다.)
- **되돌림**: cron 대상 URL 을 Node 로 원복(또는 승계 주소 그대로 두고 Node 를 그 주소로 롤백 · §13-7).

### 13-6. Node 은퇴 표시 (sqlite 분기는 유지 — 롤백 레버)

컷오버 확정 후에도 **sqlite 분기·`node:sqlite`·`TempNewsDb` 계열은 제거하지 않는다**(index.json excluded (c) ·
decisions (5) — 제거는 롤백 능력과 무회귀 판정을 함께 잃는다 · 제거 판단은 P3 후속).

- 컷오버 뒤 Node 를 **다시 띄울 일이 있으면** `NODE_SERVER_DEPRECATED=1` 로 기동해 **은퇴 예고 배너**를 남긴다
  (step5 · opt-in · 기본 off · HTTP 응답·헤더·상태 무변경).

  ```bash
  NODE_SERVER_DEPRECATED=1 DATA_DIR=<경로> PORT=<포트> node server/index.js
  ```

- **⚠ 이 배너는 터미널/콘솔 stdout 에 찍히지 않는다.** `logService.warn` 을 통해 **앱 로그 스트림 / 인메모리
  링 버퍼(ADR-007 로그 SSE)** 로 흐른다 — 운영자는 **콘솔이 아니라 앱 로그 스트림(관리자 로그 뷰/매일 다이제스트)**
  에서 이 배너를 확인한다. 터미널을 쳐다보며 배너를 기다리지 마라(거기엔 안 나온다).
- **경고 재인용(§11-6)**: 컷오버 뒤 Node 에 **쓰기**가 한 번이라도 일어나면 두 저장소(SQLite `news.db` /
  MySQL `news`)가 **갈리고 자동으로 합쳐지지 않는다**. 되돌릴 생각이면 §13-7 롤백으로 가라 — Node 를 그냥
  켜는 것은 롤백이 아니다.

### 13-7. 롤백 포인터

문제가 생기면 **§9(되돌리기 절차)** 와 **§11-7(스테이징 리허설 실측)** 으로 간다 —
export → verify(**산출물 ↔ 지금의 MySQL** 이 무결성 판정 · exit 0) → 임시 `DATA_DIR` 배치 → Node 기동.
동일 host:port 교체(13-4-a)였다면 **클라이언트 무변경**으로 복귀한다.

- **되돌린 뒤에도 MySQL `news` 도 원본 `news.db` 도 지우지 않는다**(이 리포 최상위 규칙 · 원인 조사·비교 기준).
- ③ 왕복 대조 함정(§11-7 주석): 원본 `news.db` 와의 대조는 "이관 직후"에만 0 이고, 운영이 진행됐다면
  **다른 것이 정상**이다 — 그때 판정은 **산출물 ↔ MySQL** 대조다(exit 4 를 롤백 실패로 읽지 마라).
