# Step 8: production-load-rehearsal

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — `decisions` (10)(11) · `excluded` (a) · `open_questions` (6)
- `phases/75-mysql-migration/index.json` — `forward_notes` **(2)(5)(6)(7)(8)(11)(12) 전부**
- `docs/ops-mysql.md` — **§7**(삭제 예외 grant) · **§9**(되돌리기) · **§11 컷오버 런북 전문**(0 체크리스트 → 1 사전 → 2 계정 → 3 migrate → 4 verify → 4-b grant → 5 Spring 기동 → 6 Node 중단 → 7 롤백 → 8 실패 분기 8종) · **§12 명령별 실행 결과표 25행**
- `docs/db-mysql-mapping.md` — **§7 잔여 divergence 8건** · **§7-1 방어선 색인 16행** · §8 미측정
- `tools/news-migrator/README.md` — CLI 6커맨드 · 종료코드 5종 · 비파괴 규율 6항 · 검증된 것/되지 않은 것
- `server-spring/src/main/java/harness/news/db/SchemaGuard.java`(부팅 검증 · **mysql 모드의 오류 문구** — 75 forward_notes (6) ⑩)
- `docs/cutover-p3.md` §0 조사표 **2번**(운영 데이터 정본)·**8번**(MySQL 현황·`SHOW GRANTS`)
- `server/index.js` 226~250행(`resolveRuntimePaths` — `DATA_DIR` 규약)

## 배경

75는 **절차·리허설·롤백 경로**까지 만들고 **운영 데이터의 실제 이관은 P3에 넘겼다**. 운영 `news` DB는 2026-09-04 시점 **테이블 0개**다. 이 step은 그 이관을 **실행 가능한 형태**로 만들되, **실행 자체는 사용자 실행 항목**으로 분리한다(excluded (a)).

핵심 사실 셋:

1. **소스는 리포 `news.db`가 아니다.** EXE 배치 규약은 `DATA_DIR` > `<exe 디렉토리>/data`이고 리포 `news.db`는 개발용이다(decisions (10)). 어느 파일이 운영 정본인지는 step0 조사표 2번이 답한다. **에이전트는 운영 파일을 열지 않는다** — 리허설은 사용자가 만든 **사본**(리포 밖)으로만 한다.
2. **`GRANT DELETE ON news.ReceiverConfig`가 아직 없다**(75 forward_notes (7)). 없으면 `DELETE /api/receiver-config/:id`가 Node 200 / Spring **500**인데 **`--db mysql --parity`는 green**이다(하네스는 `news_ct`=ALL로 돈다). 이 축의 방어선은 계약이 아니라 **부트스트랩 grant + `NewsAppMysqlWireTest` + `MinimumPrivilegeBoundaryTest` + 런북의 `SHOW GRANTS` 육안 확인** 넷이다.
3. **`news_stage`는 드리프트했다**(스모크로 275행+ · 삭제 0). `verify --target news_stage`가 **exit 4인 것이 정상**이다. 재현은 **임시 DB**(`harness_ct_<16hex>`)로 한다.

## 작업

### A. 운영 사본으로 리허설

사용자가 제공한 **운영 `news.db` 사본**(리포 밖 · 읽기 전용 취급)에 대해 75의 경로를 그대로 돈다:

1. **부산물 확인**: `-wal`/`-shm`/`-journal`이 있으면 마이그레이터가 **시작 자체를 거부**한다. 그 경우 사용자에게 "서버를 정상 종료한 뒤 다시 사본을 뜨라"고 요청한다(부산물을 지우지 마라).
2. `migrate --source <사본> --target <임시 DB 키집합>` → 행 수 출력.
3. `verify --source <사본> --target <임시 DB>` → **전 테이블·전 컬럼 불일치 0 · 구조 문제 0**.
4. `export --target <임시 DB> --out <리포 밖 .db>` → `verify --source <산출물> --target <임시 DB>` **불일치 0**.
5. **그 export 산출물로 Node 서버를 실제로 띄운다**(75 step8 리허설과 같은 형태: 부팅 → 로그인 → 목록 → 상세 → 부팅 전후 md5 동일). 이것이 **롤백 자산이 진짜인지**의 판정이다.
6. **소스 사본의 크기·md5가 전 과정 전후로 무변**임을 도구 출력과 바깥 `md5sum` 양쪽으로 확인.

**측정 기록(필수)**: 행 수(테이블별) · 컬럼 수 · 셀 수 · **소요 시간**(75 forward_notes (5) ①이 '178행 기준 약 3초'뿐이라고 남긴 공백을 여기서 메운다 — 운영 규모의 실측이 정지 창 길이를 정한다) · export 파일 크기 · Node 부팅 시간.

### B. 운영 규모에서 새로 드러나는 것

운영 데이터는 리포 표본(178행)과 다르다. **최소 다음을 실측**하고, 문제가 있으면 **컷오버 전에 알아야 한다**:

- **769자 초과 텍스트 PK**가 실제로 있는가(`User.userId`·`Article.articleId`·`Contents.articleId`). 있으면 **이관 자체가 1406으로 실패**한다 — step9와 함께 처분을 정해야 한다.
- `markupVersion` 최대 **바이트** 길이(글자 아니다) — `max_allowed_packet`(67,108,864) 대비.
- 4바이트 이모지·서로게이트 쌍(75 forward_notes (5) ⑤의 공백).
- NULL과 빈 문자열이 섞인 컬럼의 분포.
- 정본에 없는 테이블·컬럼(수기 `ALTER` 흔적).

### C. `SchemaGuard`의 mysql 처방 문구 수정

75 forward_notes (6) ⑩: `테이블 없음 = …` 뒤에 **sqlite 시절 처방**(「Node 서버로 데이터 디렉토리를 준비한 뒤 다시 실행하세요」)이 붙는다. mysql 모드의 올바른 처방은 **`migrate`** 다. **문구만** 고친다(계약 관측·판정 로직은 건드리지 않는다). 방언별로 다른 문구가 나가는지 테스트로 잠근다.

### D. grant 부착 절차 (사용자 실행 항목)

`docs/cutover-p3.md` §0-1에 다음을 **정확한 명령**으로 등록한다(75 forward_notes (7)의 두 갈래를 인용):

- **(가) 컷오버 시점**: `migrate`로 `news`에 테이블이 생긴 **뒤** root로 `ops/mysql/bootstrap.local.sql`을 통째로 재실행(전 문장 멱등).
- **(나) 지금**: `mysql -u root -p -e "GRANT DELETE ON news_stage.ReceiverConfig TO 'news_app'@'localhost';"`
- **판정**: `SHOW GRANTS`에 `` GRANT DELETE ON `news_stage`.`receiverconfig` `` 가 보이는가.
- **⚠ PowerShell은 `<` 리디렉션 불가** — `mysql -e "source d:/…/파일.sql"` 형태.

**[② 검토 반영] D-2. 부분 적재 복구 절차 — 정지 창의 최빈 분기다.** `docs/ops-mysql.md` **§11-8 표** 실측: **대상이 비어 있지 않은데 `migrate`하면 exit 1**이고 도구는 **아무것도 지우지 않는다**(`news_migrator`에 `DELETE`·`DROP`이 없으므로 지울 수도 없다). 즉 1차 `migrate`가 중간에 끊기면 **그 뒤 모든 재시도가 exit 1**이고, 진행하려면 **root가 대상을 비워야** 한다. 이 step은 그 절차를 **실행 가능한 형태**로 만들어 `docs/cutover-p3.md` §0-1(사용자 실행 항목)과 §7에 싣는다:

- **두 갈래**를 모두 제시하되 **(나)가 기본이다** — **(나) 빈 DB를 새로 만들어 `NEWS_MIGRATOR_URL`을 그쪽으로 돌리기**(**아무것도 지우지 않는 경로** · 런북의 기본 분기로 굵게 적어라) · **(가) 대상 스키마 비우기**(root · 정확한 명령 · 실행 후 7테이블 행 수 0 확인 — **(나)가 불가능할 때의 예외**).
- **CLAUDE.md 「DB에 있는 내용은 절대 삭제하지 않는다」와의 관계를 명문화하라**: 여기서 비우는 대상은 **컷오버 대상 DB의 부분 적재 잔재**이고 **뉴스 데이터의 정본은 그 시점에도 운영 `news.db`와 사본 2벌에 그대로 있다**. 예외 성립 조건 **넷**을 적고 **하나라도 빠지면 하지 않는다**: ① 대상이 컷오버 대상 DB일 것 ② 컷오버 **이전** 소스 사본이 최소 2벌 확인될 것 ③ root가 직접 실행할 것 ④ **[② 재검토 반영] 대상에 「컷오버 이후 생성된 행」이 0건일 것 — 있으면 `export`로 새 사본을 뜬 뒤에만 비울 수 있다.** ④의 근거: 런북 §9-9의 롤백에서 `export`는 **"필요 시"** 라 생략될 수 있고, 조건 ②의 사본은 **컷오버 이전** 것이라 **컷오버 창 동안 MySQL에만 쓰인 기록**을 거르지 못한다 — 그 상태에서 비우면 **유일본 삭제**다. **판정 방법도 함께 적어라**(예: 대상 7테이블 행 수 vs 소스 사본의 행 수 대조 · `Contents.createdAt`/`sentAt` 최댓값이 컷오버 시각 이후인지 — **어느 방법을 쓰든 판정 커맨드를 명시**하고, 판정이 애매하면 **무조건 `export`부터** 한다). 조건 없이 "비우면 된다"고 적으면 그 문장이 다음에 운영 DB에 적용된다.
- **리허설에서 이 분기를 실제로 재현하라**: 임시 DB에 `migrate`를 한 번 돌린 뒤 **같은 대상에 다시** 돌려 exit 1과 그 문구를 눈으로 확인하고, (나) 경로로 복구되는 것을 실측한다.

### E. 문서

`docs/cutover-p3.md` §7: 운영 적재 절차(사전 백업 2벌 → 정지 → 사본 → migrate → verify → grant → 기동) · **리허설 실측표**(A·B의 수치) · 실패 분기(§11-8의 8종을 P3 문맥으로 다시 씀) · 정지 창 길이의 근거(측정한 소요 시간 × 안전 계수).

## Acceptance Criteria

```bash
# 1) 리허설 (임시 DB · 운영 사본) — 각 단계의 종료코드와 수치를 기록
java -jar tools/news-migrator/target/news-migrator.jar migrate --source <사본> --target <임시키집합>
java -jar tools/news-migrator/target/news-migrator.jar verify  --source <사본> --target <임시키집합>
java -jar tools/news-migrator/target/news-migrator.jar export  --target <임시키집합> --out <리포밖.db>
java -jar tools/news-migrator/target/news-migrator.jar verify  --source <리포밖.db> --target <임시키집합>

# 2) 롤백 자산 실증 — export 산출물로 Node가 실제로 뜬다
DATA_DIR=<리포밖 임시> PORT=<빈포트> node server/index.js    # 부팅 → 로그인 → 목록 (자동 판정)

# 3) SchemaGuard 문구 — 방언별 처방이 다른지 테스트로 잠김
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify

# 4) 무회귀
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity
node scripts/spa-parity.mjs && node scripts/spool-parity.mjs

# 5) 무접촉 · 임시 DB 정리
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json tools/news-migrator/src/test   # 무출력
```

- 1번의 두 `verify`가 **불일치 0 · 구조 문제 0**, `migrate` 뒤 **소스 사본 md5 무변**.
- 5번에 **`tools/news-migrator/src/test`가 포함**된다 — **비파괴 게이트 4군을 완화하지 마라**.
- 실행 후 잔존 `harness_ct_*` **0개**(`SHOW DATABASES`로 확인 — 하네스가 지우지만 사람이 본다).
- **변이 전건 결과표(필수)** — 최소 5종:
  - **T1** 대조기의 제외 목록에 정본 테이블 1개를 추가 → 기대: 그 테이블 불일치가 조용히 통과(대조 공허화 실증) · 원복.
  - **T2** 소스 사본에 `-wal` 파일을 만들어 두고 `migrate` → 기대: **시작 거부**(부산물 가드).
  - **T3** `SchemaGuard`의 mysql 처방 문구를 sqlite 문구로 되돌림 → 기대: 새 테스트 red.
  - **T4** 769자 텍스트 PK 행을 사본에 넣고 `migrate` → 기대: **1406 실패**(그리고 도구가 그 실패를 **어떤 종료코드·문구**로 내는지 기록 — 운영자가 그 문구로 진단한다).
  - **T5** grant 없는 상태에서 Spring `DELETE /api/receiver-config/:id` → 기대: **500**(그리고 같은 시점 `--db mysql --parity`는 **green** — 이 대비를 실측으로 다시 못 박아라).
  - **T6** **[② 검토 반영]** 이미 적재된 임시 DB에 `migrate` 재실행 → 기대: **exit 1 + 「대상이 비어 있지 않다 …」 문구 + 소스 md5 무변 + 대상 무변**. 그리고 (나) 경로(빈 DB 새로 만들기)로 복구되는 것까지 실측해 표에 적는다.
  - 각 변이에 기대/실제/원복 확인.

## 검증 절차

1. 리허설은 **임시 DB**에서만 한다(`news`·`news_stage`를 대상으로 하지 마라 — 전자는 컷오버 대상이라 비어 있어야 하고, 후자는 이미 드리프트했다).
2. 각 명령의 종료코드를 **`| tail` 없이** 확인한다.
3. 소요 시간은 **2회 재서** 평균이 아니라 **두 값을 모두** 적는다.
4. 자바 실행 시 한글 출력이 깨지면 `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8`.
5. `set -a; . <env파일>`을 쓰지 마라(URL의 `&`에서 깨진다) — `docs/ops-mysql.md` §3의 한 줄씩 읽는 형태.

## 되돌림 절차

- 리포 되돌림: `SchemaGuard` 문구 1곳과 문서 추가분. 임시 DB는 도구가 지운다(장부 확인).
- **운영 되돌림**: 이 step은 운영 DB를 만지지 않는다. 실제 적재 후의 롤백은 `docs/ops-mysql.md` §9·§11-7과 step10 런북이 소유한다 — **핵심은 export 산출물(SQLite `.db`)로 Node가 뜬다는 것**이고, 그 사실을 이 step이 실증한다.
- 리허설 산출물(사본·export·임시 DB)은 **리포 밖**에 있으므로 삭제해도 리포에 흔적이 없다. 단 **운영 사본은 사용자 자산**이다 — 지우기 전에 물어라.

## 금지사항

- **운영 `news.db` 원본을 열지 마라.** 이유: SQLite는 읽기만 해도 `-wal`/`-shm`을 만들 수 있고, 그러면 다음 사본이 오염된다. 사본만 만진다.
- **`news`·`news_stage`를 리허설 대상으로 쓰지 마라.** 이유: `news`는 컷오버 대상이라 비어 있어야 하고(런북 §11-0-6), `news_stage`는 드리프트했다.
- **어떤 행도 지우지 마라 — `news_stage`를 '깨끗하게' 만들려 하지 마라.** 이유: CLAUDE.md 최상위 규칙이고, 재적재 권한은 root뿐이다. 임시 DB로 재현하라(75 forward_notes (8)).
- **마이그레이터의 비파괴 게이트 4군을 완화하지 마라.** 이유: `flyway.clean()`·`Files.deleteIfExists(source)`처럼 **SQL이 한 글자도 없는 파괴 경로**를 그 게이트만 잡는다(75 forward_notes (9)).
- **root 명령을 대신 실행하지 마라.** 이유: 자격이 없고, 그것이 설계다.
- **실제 컷오버를 실행하지 마라.** 이유: 정지 창·백업·승인이 붙는 사건이다(excluded (a)). 이 step은 리허설과 절차까지다.
- **`SchemaGuard`의 판정 로직·계약 관측을 건드리지 마라.** 이유: 문구만 고치는 작업이다(런북 §11-8이 그 자리에서 처방을 준다).
