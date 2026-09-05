# Step 0: baseline-and-field-survey

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — 특히 `baseline`(실측 A~H)·`decisions` (10)(11)·`open_questions` (3)
- `phases/75-mysql-migration/index.json` — `forward_notes` (1)(5)(6)(7)(8)(11)(12)
- `docs/ops-mysql.md` — §0(왜 사람이 해야 하는가) · §1(계정·DB 지도) · §3(비밀 보관) · §7(삭제 예외 grant) · §11(컷오버 런북) · §12(명령별 실행 결과표)
- `docs/porting-plan-cpp-spring.md` — §7 로드맵 표의 **P3 행(180행)** 과 **되돌림 지점(187행)** · §8 검증 전략 · §10 열린 질문 2
- `packaging/README-배포-통합.md` · `packaging/server/README-배포.md` · `packaging/server/기사작성기-server.bat` · `packaging/체크리스트-육안확인.md`
- `server/index.js` 174~250행(SPA 규칙 3함수)·1219~1238행(정적/폴백 마운트)·1335~1355행(부팅 로그)·1360~1389행(배부 스풀 로그 + FTP watcher 배선)
- `client/lib/serverUrl.js` · `client/lib/clientConfig.js` · `client/main.js` 165~200행·295~310행
- `server-spring/README.md` — 「빌드·테스트·실행」·「설정 키 ↔ 환경변수」·「아직 검증되지 않은 것」

## 배경

이 phase는 **운영 전환**이라 기준선이 리포 안에만 있지 않다. 리포 밖(운영 머신의 배포 폴더·스케줄러·MySQL 계정)에 있는 사실 중 **에이전트가 볼 수 없는 것**이 있고, 그것을 모른 채 세운 절차는 컷오버 당일에 무너진다. 그래서 이 step은 두 가지를 한다: **① 리포 안 기준선을 자기 손으로 다시 재고 ② 리포 밖 사실을 조사표로 만들어 사용자에게 묻는다.**

index.json의 baseline ①~⑤ 수치는 **인계값이지 이 계획서의 실측이 아니다.** 그대로 믿지 말고 재라. 어긋나면 "인계값 X / 실측 Y"로 둘 다 적어라 — 인계값에 맞춰 실측을 반올림하지 마라.

## 작업

### A. 리포 안 기준선 재측정 (9 커맨드)

전부 **리포 루트 cwd**, `JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1"`.

1. `git log --oneline -1` 과 `git status --porcelain` — base가 `048654f`인지, 워킹 트리에 **다른 세션 산출물 4종**(` M docs/UI_GUIDE.md` · ` M .claude/skills/...SKILL.md` · `?? system-diagram-fixed.html` · `?? system-diagram-fixed.svg`)만 있는지. 이 목록을 **step0 시작 스냅샷**으로 파일에 저장하라(뒤 step들이 증분 판정에 쓴다).
2. `cd server-spring && ./mvnw -B clean verify` → `Tests run:` 줄 원문 기록. **출력에 `Tests run:` 이 없으면 그 실행은 무효다.**
3. `cd tools/news-migrator && ./mvnw -B clean verify` → 같은 규칙.
4. `node scripts/spring-contract.mjs --parity` (sqlite 축)
5. `node scripts/spring-contract.mjs --db mysql --parity` (MySQL 축 — `docs/ops-mysql.md` §3 절차로 **필요한 키만** 셸에 실어라. env 파일을 통째로 실으면 kind/URL 모순으로 기동을 거부한다)
6. `node scripts/spring-contract.mjs --db mysql --require-full-coverage`
7. `node scripts/contract-inventory-check.mjs --require-spec-paths`
8. `npm test`
9. `npm run lint && npm run build`

그리고 **자산 지문**: 리포 `news.db` 크기·md5 · `uploads/` 파일 수·총 바이트 · `web/dist` 총 바이트와 파일 목록 · 두 jar 크기 · `dist/` 하위 exe 2종의 존재와 경로.

> `mvnw verify`와 계약 하네스를 **동시에 돌리지 마라**(둘 다 MySQL·포트를 잡는다). 순차로.

### B. 운영 현장 조사표 작성 — `docs/cutover-p3.md` §0 신설

새 문서 `docs/cutover-p3.md`를 만들고 **§0 현장 조사표**를 채운다. 각 행은 `항목 / 왜 필요한가 / 확인 방법 / 값 / 확인자`다. 최소 항목:

1. **운영 서버 배치**: 서버 exe의 절대 경로 · 기동 방법(bat / NSSM 서비스 / 수동) · `PORT` 실제 값 · `HOST` 값(loopback인가 LAN인가).
2. **운영 데이터 정본**: `DATA_DIR` 설정 여부와 값 · 실제 `news.db` 절대 경로 · **크기 · md5 · 7테이블 행 수** · `uploads/` 파일 수와 총 바이트. (**에이전트가 열지 마라** — 사용자가 값을 적는다. decisions (10).)
3. **`SPA_DIR`**: 설정 여부 · 실제 `web/` 폴더 경로 · `index.html` 존재 여부 · 그 폴더가 리포 `web/dist`와 같은 산출물인가.
4. **배부**: `DIST_SPOOL_DIR` 설정 여부와 값 · 그 폴더의 현재 파일 수 · **외부 전송기가 무엇이고 어떤 주기로 스풀을 걷어 가는가**.
5. **수집**: `RCV_SPOOL_DIR` 설정 여부와 값(**open_questions (3)의 판정 입력**) · 외부 FTPd 존재 여부 · `COLLECTION_TOKEN` 설정 여부 · 수집 pull 대상 등록 현황.
6. **운영 tick**: Windows 작업 스케줄러에 등록된 작업 이름 · 주기 · 호출 스크립트의 경로와 내용(자격이 어디에 있는가 — **비밀 값 자체는 조사표에 적지 마라**, '어디에 있는가'만 적는다).
7. **클라이언트**: 설치된 PC 대수(대략) · `%APPDATA%\기사작성기\config.json`의 `serverUrl` 값 형태 · 클라 exe 버전/배포일.
8. **MySQL**: `news` DB의 현재 테이블 수(75 마감 시점 **0개**) · 세 계정 접속 가능 여부 · **`SHOW GRANTS FOR 'news_app'@'localhost'`** 원문(§7 grant 부착 여부 판정).
9. **정지 창**: 컷오버에 쓸 수 있는 정지 가능 시간대와 길이 · 롤백 판단 권한자.

조사로 **알 수 없는 항목은 '미상'으로 남기고 그것이 어느 step을 막는지 적는다**(빈칸을 추측으로 채우지 마라).

### C. 사용자 실행 항목 목록 — `docs/cutover-p3.md` §0-1

decisions (11)의 넷을 포함해, **에이전트가 할 수 없는 일**을 한 곳에 모은다. 각 항목은 `왜 사람이 해야 하는가 / 정확한 명령 / 성공 판정 방법 / 실패 시 분기`를 갖는다. 최소:

- `GRANT DELETE ON news.ReceiverConfig TO 'news_app'@'localhost';` (그리고 `news_stage`도 — 75 forward_notes (7)의 (가)/(나) 두 갈래를 그대로 인용하되 **PowerShell `<` 금지**를 명시)
- 개발 비밀번호 3종(4자 hex) 교체 — `docs/ops-mysql.md` §3-1
- 운영 DB 백업 2벌(영구 보관용 + 즉시 되돌림용)
- 운영 프로세스 정지·기동 권한
- 작업 스케줄러의 tick 작업 재등록/교체(step7이 내용을 준다)
- **[② 검토 반영 · 필수] 부분 적재 상태의 복구(대상 DB 비우기) — root 전용.** 근거: `docs/ops-mysql.md` **§11-8 표**가 실측 문구로 못 박았다 — **대상이 비어 있지 않은데 `migrate`하면 exit 1**(`대상이 비어 있지 않다 [User, Article, …] — 비우고 다시 넣지 않는다.`)이고 **아무것도 지우지 않으며 소스 md5도 그대로**다. 그리고 **`news_migrator` 계정에는 `DELETE`도 `DROP`도 없다** — 비우는 것은 **사람(root)의 일**이다. 이것은 **정지 창의 최빈 실패 분기**다(1차 `migrate`가 중간에 끊기면 그 다음 시도가 전부 exit 1이다). 항목에 담을 것: **정확한 명령**(root로 대상 스키마를 비우거나 빈 DB를 새로 만들어 `NEWS_MIGRATOR_URL`을 그쪽으로 돌리는 두 갈래 · PowerShell `<` 금지) · **판정**(대상 7테이블 행 수 0) · **CLAUDE.md 「DB에 있는 내용은 절대 삭제하지 않는다」와의 관계**: 여기서 비우는 것은 **컷오버 대상의 부분 적재 잔재**이지 뉴스 데이터가 아니다 — **정본은 그 시점에도 운영 `news.db`(사본 2벌 포함)에 그대로 있다**. 그 예외 조건 **넷**을 **명문으로** 적고, **하나라도 빠지면 하지 않는다**: ① 대상이 **컷오버 대상 DB**일 것 ② 컷오버 **이전** 소스 사본이 최소 2벌 확인될 것 ③ **root가 직접** 실행할 것 ④ **[② 재검토 반영 · 유일본 방어] 대상에 「컷오버 이후 생성된 행」이 0건임을 확인할 것 — 있으면 `export`로 새 사본을 뜬 뒤에만 비울 수 있다.** ④가 없으면 구멍이 남는다: 런북 §9-9의 롤백에서 `export`는 "필요 시"이고, 조건 ②의 사본은 **컷오버 이전** 것이라 **컷오버 창 동안 MySQL에만 쓰인 기록**을 거르지 못한다 — 그 상태로 재컷오버하며 "대상을 비우면" 그것은 **유일본 삭제**이고 CLAUDE.md CRITICAL 위반이다. **그리고 §0-1 본문에 「기본 경로는 (나) 빈 DB를 새로 만들어 대상을 바꾸는 무삭제 경로다. (가) 비우기는 (나)가 불가능할 때의 예외다」를 굵게 적어라** — 아무것도 지우지 않는 길이 언제나 먼저다. **이 항목이 미정이면 step8(리허설 재현)과 step10(런북 §10 분기)이 막힌다** — 그 사실을 §0-2에 적어라.

### D. blocked 절차

조사표의 **미상 항목이 뒤 step을 막는 경우**의 처리: (1) 그 step 파일의 「막힌 조건」에 정확히 무엇이 필요한지 적고 (2) `phases/76-spring-cutover/index.json`의 그 step `status`를 `blocked`로 두며 (3) 사용자에게 물을 질문을 **한 문장씩** 정리해 `docs/cutover-p3.md` §0-2에 남긴다. **추측으로 진행하지 마라** — 이 phase는 운영 전환이라 틀린 가정의 비용이 다른 phase와 다르다.

## Acceptance Criteria

```bash
# 1) 기준선 9커맨드가 전부 성공하고 수치가 기록됐다
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity
node scripts/spring-contract.mjs --db mysql --require-full-coverage
node scripts/contract-inventory-check.mjs --require-spec-paths
npm test
npm run lint && npm run build

# 2) 리포 자산 무변
md5sum news.db          # 606,208 B / 7247e9e0dfe5cc8cd040ebb1dc9fb967

# 3) 무접촉 경로가 0줄
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json docs/news.md spikes
```

- 위 3번 `git diff --stat`이 **무출력**이어야 한다.
- 이 step이 만드는 파일은 `docs/cutover-p3.md` **하나**다(+ `phases/76-spring-cutover/**`).
- `docs/cutover-p3.md` §0 조사표의 9묶음이 **전부 존재**하고, 각 행이 값 또는 '미상 + 막는 step'을 갖는다.
- **변이 전건 결과표**: 이 step은 게이트를 만들지 않으므로 변이 대상이 없다. 그 사실을 "변이 0건 — 이 step은 게이트를 만들지 않는다"로 **명시 기록**한다(빈칸으로 두지 마라).

## 검증 절차

1. 기준선 9커맨드를 **연속 2회** 돌려 수치가 같은지 본다(flake 판정). 다르면 두 회차를 모두 기록한다.
2. `--db mysql` 실행 후 `SHOW DATABASES`로 **잔존 `harness_ct_*`가 0개**인지 확인한다(하네스가 스스로 지우지만, 그 확인이 사람 몫이라는 것이 75 forward_notes (9) ②의 교훈이다).
3. `news.db`의 md5를 **하네스 실행 전후 각각** 재서 무변을 확인한다.
4. 조사표를 사용자에게 제시하고 미상 항목의 답을 받는다. 받은 값은 **출처(누가·언제)** 와 함께 적는다.

## 되돌림 절차

이 step은 리포에 문서 1개와 `phases/**`만 추가한다. 되돌림은 `git rm docs/cutover-p3.md` 수준이고 **운영에는 아무 변화가 없다**. 단, 조사 과정에서 운영 머신의 어떤 파일도 열거나 복사하지 않았음을 확인하라(열었다면 `-wal`/`-shm` 부산물이 생기지 않았는지 사용자에게 확인 요청).

## 금지사항

- **운영 `news.db`를 열지 마라.** 이유: SQLite는 읽기만 해도 `-wal`/`-shm`을 만들 수 있고, 마이그레이터는 부산물이 있으면 시작 자체를 거부한다(75 forward_notes (2) ②). 값은 사용자가 적는다.
- **root 명령을 대신 실행하지 마라.** 이유: 이 리포의 어떤 자동화도 root 비밀번호를 갖고 있지 않다(설계다 — ADR-016 ⑦·decisions (11)).
- **인계 수치를 실측으로 위장하지 마라.** 이유: 75가 인계한 1472/107/313은 이 트리에서 재측정되지 않은 값이고, 다르면 그 차이 자체가 첫 발견이다.
- **조사표의 빈칸을 추측으로 채우지 마라.** 이유: 운영 전환에서 틀린 가정은 컷오버 당일에만 드러나고 그때는 되돌리는 것 말고 할 수 있는 게 없다.
- **비밀 값(비밀번호·토큰·세션)을 조사표·커밋·로그에 적지 마라.** 이유: `SecretHygieneTest`가 리포 전역을 스캔하고, 무엇보다 리포는 공유된다.
- **`git add -A` 금지.** 이유: 워킹 트리에 다른 세션 산출물 4종이 상주한다.
- **`--parity` 결과를 `| tail`로 가리지 마라.** 이유: 종료코드가 가려져 실패가 성공으로 보인다.
