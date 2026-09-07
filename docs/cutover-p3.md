# 컷오버 P3 — 운영 전환 현장 조사표 · 사용자 실행 항목

> 이 문서는 **로드맵 P3(서버 전환 운영)** 의 운영측 정본이다. phase 76 step0 이 신설했고 step10 이 §1 이후의
> 런북 본문을 채운다. **DB 이관(P2) 절차의 정본은 `docs/ops-mysql.md` §11**이며 이 문서는 그것을 대체하지 않는다.
>
> **규율 — 에이전트는 운영 파일을 열지 않는다.** 운영 `news.db`·운영 배포 폴더·`root` 자격은 전부 사람의 소유다.
> SQLite 는 읽기만 해도 `-wal`/`-shm` 부산물을 만들 수 있고 마이그레이터는 부산물이 있으면 **시작 자체를 거부**한다.
> 그래서 아래 §0 의 값은 **사용자가 적는다**. 빈칸을 추측으로 채우지 않는다 — 운영 전환에서 틀린 가정은
> 컷오버 당일에만 드러나고, 그때는 되돌리는 것 말고 할 수 있는 게 없다.
>
> **비밀 값(비밀번호·토큰·세션 id)을 이 문서에 적지 마라.** 「어디에 있는가」만 적는다(`SecretHygieneTest` 가
> 리포 전역을 스캔하고, 무엇보다 리포는 공유된다).

## 0. 현장 조사표

표기 규약: **값** 열이 `미상` 이면 그 행은 아직 답이 없다는 뜻이고, **막는 step** 을 함께 적었다.
`에이전트 실측(개발 머신)` 은 **이 리포가 있는 개발 머신에서 잰 값**이지 운영 머신의 값이 아니다 — 둘을 섞어 읽지 마라.

### 0-1묶음. 운영 서버 배치

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| 서버 exe 절대 경로 | 컷오버는 **같은 host:port 인계**다. Spring 을 어디서 띄우고 무엇을 내릴지가 이 값에서 나온다 | 운영 머신에서 실행 중인 `기사작성기-server.exe` 의 경로(작업 관리자 → 자세히 → 이미지 경로) | **미상** — 막는 step: 7·10 | |
| 기동 방법(bat / NSSM 서비스 / 수동) | 정지·기동 절차와 환경변수 주입 지점이 갈린다. **NSSM 서비스는 bat 을 거치지 않으므로** 환경변수가 서비스 설정에 있다(`packaging/server/README-배포.md` §10) | 서비스 목록에 `기사작성기-server` 가 있는가 · 없으면 bat/exe 직접 실행 | **미상** — 막는 step: 10 | |
| `PORT` 실제 값 | 클라 config 가 origin 문자열을 저장하므로 **포트가 바뀌면 전 PC 재설정**이다(= 클라 변경 = 되돌림 속성 상실) | 기동 bat 의 `set PORT=` 줄 또는 서비스 환경변수 | **미상**(배포 템플릿 기본 `3001` — `packaging/server/기사작성기-server.bat` 25행) — 막는 step: 4·7·10 | |
| `HOST` 값(loopback / LAN) | LAN 개방이면 `COLLECTION_TOKEN` 이 사실상 필수이고 수집 라우트의 fail-closed 판정이 갈린다(양 서버 동형) | 같은 위치의 `set HOST=` 줄 유무 | **미상**(기본 `127.0.0.1`) — 막는 step: 6·10 | |
| 이 개발 머신의 3001 리스너 | 대조군 — 이 머신이 운영기가 아님을 확인한다 | `netstat -ano` 의 LISTENING 줄 | **0건**(3306·33060 만 LISTENING) — 에이전트 실측(개발 머신) 2026-09-05 | 에이전트 |

### 0-2묶음. 운영 데이터 정본

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| `DATA_DIR` 설정 여부·값 | 데이터 정본의 위치다. 규약은 **`DATA_DIR` 오버라이드 > `<exe 디렉토리>/data`** 이고 **리포 `news.db` 는 개발용**이다 | bat/서비스의 `set DATA_DIR=` 유무 | **미상** — 막는 step: 8·10 | |
| 운영 `news.db` 절대 경로 | 이관 소스이자 롤백 정본 | 위 값에서 도출(`<DATA_DIR>\news.db` 또는 `<exe 폴더>\data\news.db`) | **미상** — 막는 step: 8 | |
| 크기 · md5 | 사본 2벌의 동일성 판정 기준(런북 §11-1) | **서버를 내린 뒤** `certutil -hashfile <경로> MD5` (또는 Git Bash `md5sum`) | **미상** — 막는 step: 8 | |
| 7테이블 행 수 | 이관 후 `verify` 의 대조 기준. 규모가 이관 시간을 정한다(현재 가진 값은 **178행 ≈ 3초**뿐이다 — 75 forward_notes (5) ①) | **원본을 열지 않는다.** 사본을 리포 밖 경로에 두고 그 사본에서 잰다 | **미상** — 막는 step: 8 | |
| 리허설용 사본의 경로(리포 밖) | 에이전트가 만질 수 있는 유일한 데이터. **사용자가 지정한다** | 사용자가 사본을 뜨고 경로를 적는다(예: `D:/agents/rehearsal/news-YYYYMMDD.db`) | **미상** — 막는 step: 8 | |
| `uploads/` 파일 수 · 총 바이트 | 컷오버 후에도 **같은 `DATA_DIR` 을 Spring 에 준다**(open_questions (8)). 옮기면 기존 첨부·사진이 전부 404 | 사본 폴더에서 센다 | **미상** — 막는 step: 8·10 | |
| (대조군) 리포 `news.db` | 개발 기준선 · 무변 판정 대상 | `md5sum news.db` | **606,208 B · md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967`** — 에이전트 실측 2026-09-05 | 에이전트 |
| (대조군) 리포 `uploads/` | 〃 | `find uploads -type f` | **32파일 · 6,068,792 B** — 에이전트 실측 2026-09-05 | 에이전트 |

### 0-3묶음. `SPA_DIR`(화면 서빙 루트)

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| `SPA_DIR` 설정 여부·값 | Spring 도 **같은 폴더를 가리킨다**(open_questions (7) — jar 임베드 금지). 빈 값(`set SPA_DIR=`)은 **서빙 강제 비활성**이다 | bat/서비스의 `set SPA_DIR=` 유무 | **미상**(기본은 exe 옆 `web\`) — 막는 step: 10 | |
| 실제 `web\` 폴더 경로 · `index.html` 존재 | 판정 기준은 디렉토리가 아니라 **`<dir>/index.html` 파일 존재**다(Node `resolveSpaRoot`) | `dir <경로>\index.html` | **미상** — 막는 step: 10 | |
| 그 폴더가 리포 `web/dist` 와 같은 산출물인가 | 다르면 step3 의 바이트 대조가 **다른 파일을 비교**하게 된다 | 세 파일의 md5 를 리포 값과 대조 | **미상** — 막는 step: 3(대조 대상 선정)·10 | |
| (대조군) 리포 `web/dist` | 대조의 기준 산출물 | `find web/dist -type f` | **3파일 · 444,543 B**(`index.html` 413 · `assets/index-COYNfnZU.js` 415,058 · `assets/index-CXiUPvTY.css` 29,072) — 에이전트 실측 2026-09-05 | 에이전트 |
| (대조군) 개발 배포 폴더 | 배포 형태의 표본 | `dist/기사작성기-server/web/` | `index.html` **413 B** + `assets/` 존재 · bat 은 **리포 템플릿과 바이트 동일** — 에이전트 실측 2026-09-05 | 에이전트 |

### 0-4묶음. 배부

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| `DIST_SPOOL_DIR` 설정 여부·값 | **미설정 = 배부 전면 비활성**(양 서버 동형). 설정돼 있으면 Spring 에도 **같은 값**을 줘야 외부 전송기가 계속 같은 폴더를 걷는다 | bat/서비스의 `set DIST_SPOOL_DIR=` 유무 | **미상** — 막는 step: 10 | |
| 그 폴더의 현재 파일 수 | 컷오버 전후 **증가분**이 곧 배부 실적이다(step7 A-2 의 중복 배부 실측이 이 값으로 판정된다) | `dir <경로>` 파일 수 | **미상** — 막는 step: 10 | |
| 외부 전송기의 정체와 주기 | 앱은 **파일만 쓴다 — 발송은 외부 전송기 책임**이다. 그 전송기가 스풀을 **지우는지 옮기는지**가 step5 바이트 대조의 전제를 바꾼다 | 운영 담당자 확인 | **미상** — 막는 step: 5(대조 시점)·10 | |
| (대조군) 개발 배포 폴더 | 표본 | `dist/기사작성기-server/data/dist-spool` | **빈 폴더** · bat 41·38행이 주석 처리 상태 — 에이전트 실측 2026-09-05 | 에이전트 |

### 0-5묶음. 수집 — **open_questions (3) 의 판정 입력**

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| **`RCV_SPOOL_DIR` 설정 여부·값** | **Spring 에는 FTP watcher 가 없다**(`WatchService`·`RCV_SPOOL` 철자 0건 — 75 forward_notes (3)). 쓰고 있으면 앱 밖 스위퍼(step6)가 **컷오버의 필수 선행**이고, 안 쓰면 step6 은 '도구 + 미사용 확인 기록'으로 축소되고 컷오버 전제에서 빠진다 | bat/서비스의 `set RCV_SPOOL_DIR=` 유무 + 그 폴더에 파일이 실제로 떨어지는가 | **쓴다** — 사용자 답변(오케스트레이터 AskUserQuestion · 2026-09-05). 정확한 `RCV_SPOOL_DIR` 값·폴더는 운영기에서 읽는다(step7·10) | step6 **해제** — 컷오버의 **필수 선행**(같은 정지 창 안에 스위퍼 등록까지) |
| 외부 FTPd 존재·제품·계정 | 스위퍼가 붙을 지점(폴더)과 파일이 도착하는 형태를 정한다 | 운영 담당자 확인 | **미상** — 막는 step: 6 | |
| `COLLECTION_TOKEN` 설정 여부 | LAN 개방(`HOST` 설정) 시 미설정이면 수집 HTTP 2라우트가 **503 `collection-disabled`**다. 스위퍼는 그 HTTP 진입점을 쓴다 | bat/서비스의 `set COLLECTION_TOKEN=` 유무(**값은 적지 마라**) | **미상** — 막는 step: 6 | |
| 수집 pull 대상 등록 현황 | 수집이 실제로 돌고 있는지의 다른 축(`ReceiverConfig` 행) | 관리자 화면 → 수집 설정 목록의 건수 | **미상** — 막는 step: 6 | |
| (대조군) 개발 배포 폴더 | 표본 | `dist/기사작성기-server/data/rcv-spool` | **빈 폴더** · bat 41행 주석 처리 상태 — 에이전트 실측 2026-09-05 | 에이전트 |

### 0-6묶음. 운영 tick(배부 시점 실행)

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| 작업 스케줄러의 작업 이름 | 전환은 **추가가 아니라 교체**다. 이름을 모르면 옛 작업이 남아 두 번 돈다 | 운영 머신에서 `schtasks /query /fo list /v` | **미상** — 막는 step: 7·10 | |
| 주기 | 엠바고 지연의 상한이자 중복 배부 창의 크기 | 같은 출력의 트리거 | **미상** — 막는 step: 7 | |
| 호출 스크립트 경로·내용 | Spring 은 쿠키 우선 **헤더 폴백**이라 같은 스크립트가 그대로 통할 **가능성이 높지만 실측 전이다**(step7 이 잰다) | 스크립트 파일을 연다(`packaging/server/README-배포.md` 79~86행이 정본 예시) | **미상** — 막는 step: 7 | |
| Z 자격이 **어디에** 있는가 | 값이 아니라 **위치**만 적는다(자격 증명 관리자 / 환경변수 / 보호된 저장소) | 스크립트가 자격을 읽는 줄 | **미상** — 막는 step: 7 | |
| (대조군) 이 개발 머신의 작업 | 표본 | `schtasks /query /fo csv /nh` **239개 전수** 중 `tick|distribution` 이름 매치 | **0건** — 에이전트 실측(개발 머신) 2026-09-05 | 에이전트 |

### 0-7묶음. 클라이언트(Electron)

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| 설치된 PC 대수(대략) | 포트를 바꾸면 **전 PC 의 config 를 고쳐야 한다**. 그 비용의 크기가 open_questions (2) 의 판단 근거다 | 운영 담당자 확인 | **미상** — 막는 step: 10 | |
| `%APPDATA%\기사작성기\config.json` 의 `serverUrl` 형태 | 저장 shape 은 `{schemaVersion, serverUrl, bounds}` 이고 값은 **origin 문자열**이다(경로·쿼리는 버려진다) | 한 대에서 그 파일을 연다(**비밀 없음**) | **미상** — 막는 step: 10 | |
| 클라 exe 버전·배포일 | 컷오버 후 **클라 무변경**이 성립하는지의 전제 | 배포 폴더의 파일 날짜 | **미상** — 막는 step: 10 | |
| (대조군) 리포의 클라 exe | step4 실기 시나리오의 자산 | `dist/기사작성기/기사작성기.exe` | **225,866,240 B**(2026-08-18) · 서버 exe `dist/기사작성기-server/기사작성기-server.exe` **94,298,112 B** — 에이전트 실측 2026-09-05 | 에이전트 |

### 0-8묶음. MySQL

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| `news` DB 의 테이블 수 | 컷오버 대상은 **비어 있어야** `migrate` 가 돈다(런북 §11-0-6). 비어 있지 않으면 **exit 1** 이고 그것이 정지 창의 최빈 실패 분기다 | `%M% -u news_app -p -e "SELECT TABLE_SCHEMA, COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA IN ('news','news_stage') GROUP BY TABLE_SCHEMA"` | **`news` = 0개**(결과에 행 자체가 없다) · `news_stage` = **8개**(7테이블 + `flyway_schema_history`) — 에이전트 실측 2026-09-05(`news_app` 자격 · 읽기 전용) | 에이전트 |
| 세 계정 접속 가능 여부 | 컷오버 전제(런북 §11-2) | 계정별 `SELECT 1` | **3/3 접속** · `SELECT VERSION()` = **8.0.46** · 잔존 `harness_ct_*` **0개** — 에이전트 실측 2026-09-05 | 에이전트 |
| **`SHOW GRANTS FOR 'news_app'@'localhost'`** | §7 삭제 예외의 부착 여부 판정. **없으면 `DELETE /api/receiver-config/:id` 만 500 인데 하네스는 green 이다** | `%M% -u news_app -p -e "SHOW GRANTS"` | `USAGE ON *.*` + `SELECT,INSERT,UPDATE` on `news`.\* · `news_stage`.\* · `news_grant_probe`.\* + **`GRANT DELETE ON `news_grant_probe`.`receiverconfig`` 단 1줄**. ⇒ **`news`·`news_stage` 의 `ReceiverConfig` 삭제 예외는 미부착**(U1 미완) — 에이전트 실측 2026-09-05 | 에이전트 |
| `SHOW GRANTS FOR 'news_migrator'@'localhost'` | 마이그레이터가 **지울 수 없다**는 사실이 비파괴의 마지막 방어선이다 | `%M% -u news_migrator -p -e "SHOW GRANTS"` | `SELECT,INSERT,UPDATE,CREATE,REFERENCES,INDEX,ALTER` on `news`.\* · `news_stage`.\* — **`DELETE`·`DROP` 없음** — 에이전트 실측 2026-09-05 | 에이전트 |
| 3306 리스너 바인드 주소 | `docs/ops-mysql.md` §3 은 「이 인스턴스는 loopback 전용」이라 적고 TLS 를 쓰지 않는데, **실측 바인드는 `0.0.0.0`** 이다. 방화벽이 막고 있을 수는 있으나 **문서와 실측이 다르다는 사실 자체**를 운영자가 알아야 한다 | `netstat -ano` 의 `:3306` LISTENING 줄 | **`0.0.0.0:3306` · `[::]:3306` LISTENING** — 에이전트 실측(개발 머신) 2026-09-05 | 에이전트 |
| 운영 MySQL 이 **이 머신인가** | 개발 머신의 MySQL 을 운영으로 그대로 쓸 것인지, 별도 서버인지에 따라 URL·백업·정지 창이 전부 다르다 | 운영 담당자 확인 | **미상** — 막는 step: 8·10 | |

### 0-9묶음. 정지 창

| 항목 | 왜 필요한가 | 확인 방법 | 값 | 확인자 |
|---|---|---|---|---|
| 정지 가능 시간대·길이 | 컷오버는 **원자적**이다(내리고 → 올린다). 이관 + `verify` + 기동 + 육안 확인이 그 창 안에 들어가야 한다 | 운영 담당자 결정 | **미상** — 막는 step: 10 | |
| 롤백 판단 권한자 | 「되돌린다」를 누가 말하는가. 그 사람이 없으면 롤백은 실행되지 않는다 | 운영 담당자 결정 | **미상** — 막는 step: 10 | |
| 컷오버 예정일 | 백업·grant·비밀번호 교체의 마감 시점 | 운영 담당자 결정 | **미상** — 막는 step: 10 | |

## 0-1. 사용자 실행 항목 (root·운영 소유 — 에이전트가 할 수 없다)

**이 리포의 어떤 자동화도 `root` 비밀번호를 갖고 있지 않다(설계다).** 추측으로 root 비밀번호를 시도하지 마라 —
`max_connect_errors` 에 걸리면 이 호스트가 통째로 차단된다.

아래 명령의 `%M%` 은 `"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"` 다.
**PowerShell 은 `<` 리디렉션을 지원하지 않는다**(실측: ParserError) — 파일을 먹일 때는 반드시 `-e "source <파일>"` 형태를 쓴다.

### U1. `GRANT DELETE ON ReceiverConfig` 부착 (root)

- **왜 사람이 해야 하는가**: `GRANT` 는 root 권한이다. 그리고 **계약 하네스는 이 축을 구조적으로 볼 수 없다** —
  하네스는 `news_ct`(ALL 권한)의 임시 DB 에서 돌기 때문이다. 즉 **패리티 green 이 이 부재를 덮어 준다**.
- **정확한 명령** — 시나리오 두 갈래(75 forward_notes (7) 인용):
  - **(가) 컷오버 시점**(`migrate` 로 `news` 에 테이블이 생긴 **뒤**): `& %M% -u root -p -e "source D:/agents/harness/ops/mysql/bootstrap.local.sql"`
    — 전 문장이 멱등이고 `news` 가 채워져 있으므로 **`--force` 가 필요 없다**.
  - **(나) 지금**(`news` 가 비어 있어 첫 문장이 `ERROR 1146` 으로 배치를 멈춘다): 한 줄만 실행한다 —
    ``& %M% -u root -p -e "GRANT DELETE ON news_stage.ReceiverConfig TO 'news_app'@'localhost';"``
- **성공 판정**: `& %M% -u news_app -p -e "SHOW GRANTS"` 에 ``GRANT DELETE ON `news`.`receiverconfig` ``
  (또는 `news_stage` 판)이 보인다. 테이블 이름은 **소문자**로 붙는다(`lower_case_table_names=1`).
- **실패 시 분기**: 붙지 않은 채로 전환하면 **기동 성공 · 하네스 green · 수신설정 삭제만 500** 이다.
  행동 판정은 `news_app` 으로 `DELETE FROM ReceiverConfig WHERE id = -1` 을 던져 **`ERROR 1142` 이면 미부착**,
  `ERROR 1054`(열 이름) 이면 권한 검사를 통과한 것이다.
- **현재 상태(2026-09-05 실측)**: **`news`·`news_stage` 둘 다 미부착.**

### U2. 개발 비밀번호 3종 교체 (root)

- **왜 사람이 해야 하는가**: `ALTER USER`/`CREATE USER ... IDENTIFIED BY` 는 root 권한이고, 값은 이 리포의 누구도 알 필요가 없다.
- **정확한 명령**: `docs/ops-mysql.md` **§3-1** 절차(① `ops/mysql/bootstrap.local.sql` 의 `IDENTIFIED BY` 우변을
  **8자 이상**으로 고친다 → ② root 로 그 파일을 재실행 → ③ **그 다음에** 리포 밖 `D:/agents/secrets/news-mysql.env` 를 고친다).
  **순서를 뒤집지 마라** — env 를 먼저 고치면 그 사이의 모든 실행이 인증 실패로 죽는다.
- **성공 판정**: 세 계정 각각 `SELECT 1` 성공 + `--db mysql` 실행 시 **길이 경고 1줄이 사라진다**.
- **실패 시 분기**: 현재(4자)에서도 **하네스는 경고를 내며 정상 진행**한다(4자 미만이면 하드 거부). 즉 이 항목은
  컷오버를 막지 않는다 — 다만 짧은 값은 하네스 출력의 md5·임시 DB 이름에 **우연히 나타나 거짓 leak 실패**를 만든다.
- **현재 상태**: **세 비밀번호 모두 4자**(2026-09-04 실측 · 값은 어디에도 적지 않는다).

### U3. 운영 DB 백업 2벌 (운영)

- **왜 사람이 해야 하는가**: 운영 파일이고, 에이전트는 그 파일을 열지 않는다.
- **정확한 명령**(런북 §11-1): **서버를 내린 뒤** ① 타임스탬프 이름의 영구 보관본 ② `rollback-ready` 이름의
  즉시 되돌림본 — **복사만 한다. 옮기지도 이름을 바꾸지도 지우지도 않는다.**
- **성공 판정**: 원본과 사본 2벌의 **md5 세 값이 같다**(`certutil -hashfile <경로> MD5`).
- **실패 시 분기**: 사본이 하나라도 다르면 **컷오버를 시작하지 않는다**(복사 중 서버가 살아 있었다는 뜻이다).

### U4. 운영 프로세스 정지·기동 권한 (운영)

- **왜 사람이 해야 하는가**: 서비스 정지·기동은 운영 권한이고, **전환은 원자적**이어야 한다 — 같은 host:port 를
  두 프로세스가 잡을 수 없다는 성질이 동시 쓰기(=두 저장소 분기)를 구조적으로 막는다.
- **정확한 명령**: 콘솔 실행이면 `Ctrl+C`, NSSM 서비스면 `nssm stop <서비스명>` / `nssm start <서비스명>`.
- **성공 판정**: `netstat -ano | findstr :<PORT>` 에 LISTENING 이 **0건**.
- **실패 시 분기**: 정지가 안 되면 컷오버를 시작하지 않는다. **Spring 을 다른 포트로 함께 띄우지 마라** —
  **Spring 에는 ADR-012 단일 인스턴스 잠금이 없다**(Node 의 잠금은 포트가 아니라 `DATA_DIR` 범위였다).
  두 인스턴스가 같은 MySQL·같은 `uploads`·같은 `DIST_SPOOL_DIR` 에 붙으면 **tick 중복 배부**가 난다(step7 이 수량으로 잰다).

### U5. 작업 스케줄러 tick 작업 **교체** (운영)

- **왜 사람이 해야 하는가**: 스케줄러 등록은 운영 권한이고, **추가가 아니라 교체**여야 한다 —
  옛 작업이 남으면 같은 tick 이 두 번 돈다.
- **정확한 명령**: step7 이 검증한 스크립트로 기존 작업의 **동작(Action)만 교체**하거나, 기존 작업을 **비활성화한 뒤**
  새 작업을 등록한다(`schtasks /change /tn <이름> /disable` → `schtasks /create ...`). **삭제보다 비활성화가 먼저다**(되돌림).
- **성공 판정**: `schtasks /query /fo list /v /tn <이름>` 에서 **활성 작업이 정확히 하나**이고, 다음 실행 이후
  배부 스풀 파일 수가 **주기당 한 벌만** 는다.
- **실패 시 분기**: 두 벌이 늘면 옛 작업이 살아 있는 것이다 — 즉시 하나를 비활성화한다(파일은 지우지 않는다).

### U6. **부분 적재 상태의 복구 — root 전용 · 기본은 무삭제 경로다**

> **기본 경로는 (나) 빈 DB 를 새로 만들어 대상을 바꾸는 무삭제 경로다. (가) 비우기는 (나)가 불가능할 때의 예외다.**
> **아무것도 지우지 않는 길이 언제나 먼저다.**

- **왜 사람이 해야 하는가**: `news_migrator` 계정에는 **`DELETE` 도 `DROP` 도 없다**(설계다). 그리고
  **대상이 비어 있지 않은데 `migrate` 하면 exit 1** 이다 — 실측 문구는
  `대상이 비어 있지 않다 [User, Article, Contents, ArticleHistory, ReceiverConfig, Photo] — 비우고 다시 넣지 않는다.`
  이고 **아무것도 지우지 않으며 소스 md5 도 그대로**다(런북 §11-8). **이것이 정지 창의 최빈 실패 분기다** —
  1차 `migrate` 가 중간에 끊기면 그 다음 시도가 전부 exit 1 이다.
- **정확한 명령 — 두 갈래**:
  - **(나) 기본 · 무삭제**: root 가 빈 DB 를 새로 만든다 —
    `& %M% -u root -p -e "CREATE DATABASE news_cut2 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin; GRANT SELECT,INSERT,UPDATE,CREATE,ALTER,INDEX,REFERENCES ON news_cut2.* TO 'news_migrator'@'localhost'; GRANT SELECT,INSERT,UPDATE ON news_cut2.* TO 'news_app'@'localhost';"`
    → 그 뒤 `NEWS_MIGRATOR_URL`·`NEWS_DB_URL` 의 DB 이름만 그쪽으로 돌린다. **부분 적재분은 그대로 남는다**(증거 보존).
  - **(가) 예외 · 비우기**: `& %M% -u root -p -e "DROP DATABASE news; CREATE DATABASE news CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;"`
    후 `ops/mysql/bootstrap.local.sql` 재실행(grant 재부착). **PowerShell `<` 금지.**
- **(가)를 실행해도 되는 예외 조건 넷 — 하나라도 빠지면 하지 않는다**:
  1. 대상이 **컷오버 대상 DB** 일 것(운영 정본이 아니라 이관 목적지다).
  2. 컷오버 **이전** 소스 사본이 **최소 2벌** 확인될 것(U3 · md5 일치).
  3. **root 가 직접** 실행할 것(에이전트·자동화가 대신하지 않는다).
  4. **대상에 「컷오버 이후 생성된 행」이 0건임을 확인할 것.** 있으면 **`export` 로 새 사본을 뜬 뒤에만** 비울 수 있다.
     — ④ 가 없으면 구멍이 남는다: 조건 ②의 사본은 **컷오버 이전** 것이라 **컷오버 창 동안 MySQL 에만 쓰인 기록**을
     거르지 못한다. 그 상태로 재컷오버하며 대상을 비우면 그것은 **유일본 삭제**이고 CLAUDE.md CRITICAL 위반이다.
     확인 방법: `SELECT MAX(id) FROM Article` 등 이관 직후 캡처한 「다음 id」와 비교 · `export --target ... --out <리포 밖>` 는
     **덮어쓰지 않는다**(같은 경로 재실행은 exit 1).
- **CLAUDE.md 「DB 에 있는 내용은 절대 삭제하지 않는다」와의 관계**: 여기서 비우는 것은 **컷오버 대상의 부분 적재 잔재**이지
  뉴스 데이터가 아니다 — **정본은 그 시점에도 운영 `news.db`(사본 2벌 포함)에 그대로 있다.** 그 전제가 조건 ②·④ 다.
- **성공 판정**: 대상 7테이블 행 수 **0**
  (`SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA='<대상>'` 또는 테이블별 `COUNT(*)`).
- **실패 시 분기**: 판정이 0 이 아니면 `migrate` 를 다시 돌리지 마라(또 exit 1 이다) — (나) 경로로 대상을 바꾼다.

## 0-2. 미상 항목이 막는 것 · 사용자에게 물을 질문

**질문(한 문장씩).** 답을 받으면 이 문서의 해당 행에 **값과 출처(누가·언제)** 를 함께 적는다.

| # | 질문 | 답이 없으면 막히는 것 |
|---|---|---|
| Q1 | **운영 서버가 FTP 스풀 수집(`RCV_SPOOL_DIR`)을 실제로 쓰고 있습니까?** (bat/서비스에 그 값이 설정돼 있고 외부 FTPd 가 그 폴더에 파일을 떨어뜨립니까?) | **step1 결정 ④의 발효 조건** · **step6 의 성격**(컷오버 필수 선행인가, Node 은퇴 전제인가) · step10 런북의 순서 | **답: 쓴다** (사용자 답변(오케스트레이터 AskUserQuestion · 2026-09-05)) → 결정 ④ 발효 · step6 = 컷오버 필수 선행 |
| Q2 | 운영 서버 exe 의 절대 경로와 기동 방법(bat / NSSM 서비스 / 수동), 그리고 `PORT`·`HOST` 실제 값은 무엇입니까? | step7(tick 대상 URL) · step10(런북의 정지·기동 절차) |
| Q3 | 운영 `DATA_DIR` 과 `news.db` 의 절대 경로는 무엇이고, **리허설에 쓸 사본**을 리포 밖 어느 경로에 두시겠습니까? | step8(운영 적재 리허설 전체) |
| Q4 | 배부가 켜져 있습니까(`DIST_SPOOL_DIR` 값)? 스풀을 걷어 가는 외부 전송기는 무엇이고 주기는 얼마이며, **걷어 간 파일을 지웁니까 옮깁니까**? | step5(대조 시점 선택) · step10 |
| Q5 | 작업 스케줄러의 tick 작업 이름·주기·호출 스크립트 경로는 무엇입니까? (**자격 값은 적지 마시고 「어디에 있는가」만**) | step7(교체 대상 실물) · step10 |
| Q6 | 운영 MySQL 은 이 개발 머신의 인스턴스입니까, 별도 서버입니까? | step8 · step10(백업·정지 창) |
| Q7 | 컷오버에 쓸 수 있는 정지 창(시간대·길이)과 롤백 판단 권한자는 누구입니까? | step10(런북 §0 낭독·§10 분기) |
| Q8 | 클라이언트가 설치된 PC 는 대략 몇 대이며, 컷오버 후 **포트를 바꿀 계획이 있습니까**(기본 결정은 '같은 포트')? | step10(육안 체크리스트 개정판) |
| Q9 | U1(grant)·U2(비밀번호)·U3(백업)·U6(부분 적재 복구)을 **누가 언제** 실행합니까? | U1 은 컷오버 자체 · U6 는 **step8 재현**과 step10 §10 분기 |

**막힘 판정.** 위 중 **Q1 이 이 phase 의 유일한 blocked 유발 항목**이다 — step1 의 결정 ④(FTP 수집을 앱 밖 스위퍼로
받는다)와 step6 의 범위가 그 답에 달려 있고, 나머지 질문은 **step7 이후에야** 필요하다. 그래서 step2~step5 는
Q1 없이도 그대로 진행할 수 있다(전부 리포 안 자산으로 완결된다).

## 1. 전환 아키텍처 5결정 요약 (정본: `docs/ADR.md` **ADR-017**)

> 전문과 실측 좌표는 **[ADR-017](./ADR.md)** 에 있다(제목: 「서버 전환은 같은 host:port의 원자적 교체 —
> Spring 이 SPA 를 동일 출처로 서빙하고, Node 는 코드로 남아 롤백 레버와 패리티 대조군을 겸한다」).
> 이 표는 **운영자가 읽는 요약**이고, 값이 갈리면 언제나 ADR 본문이 정본이다.

| # | 결정 (한 줄) | 이 결정이 깨지면 무엇이 무너지는가 | 실행/실측 step |
|---|---|---|---|
| 1 | **SPA 를 Spring 이 동일 출처로 서빙한다** — 리소스 핸들러 · `SPA_DIR` 미설정이 기본(비활성) · 판정 기준은 `<dir>/index.html` **파일** · **파일시스템 경로**(jar 임베드 금지) · SPA 응답에만 CSP 7지시자를 **바이트 동일**하게 싣는다(HSTS 없음) | **화면이 없어진다.** Electron 클라는 화면을 갖고 있지 않고 서버에서 받아 온다(`client/main.js` 303행). 별도 출처로 옮기면 클라 config `serverUrl`·`ALLOWED_ORIGINS`·CSRF·프로덕션 쿠키가 **함께** 바뀌어 「클라 무변경」 되돌림 속성이 사라진다. 폴백 규칙을 잘못 넓히면 **미정의 `/api/*` 404 가 200 HTML 로 뒤집히고 계약은 그것을 영원히 못 본다** | **step2**(서빙) · **step3**(Node 대조) · step4(실기) |
| 2 | **전환은 원자적이다** — 같은 host:port 인계 · **병행 쓰기 금지**(읽기 전용 병행도 하지 않는다) · **이 전환은 ADR-012 의 잠금 보호를 잃는다**(Spring 에 대응물 0건) · `GET_LOCK` 은 넣지 않는다 | **두 저장소가 갈린다.** 포트를 바꾸면 전 PC 의 클라 config 를 고쳐야 한다. **다른 포트로 Spring 을 2개 띄우면** 같은 MySQL·같은 `uploads`·같은 `DIST_SPOOL_DIR` 에 둘이 붙고 tick 이 양쪽에서 돌아 **중복 배부**가 난다 — Node 에는 있던 `DATA_DIR` 범위 잠금이 없다. **자동 게이트가 없다. 이것을 막는 것은 절차뿐이다** | **step7**(중복 스풀 수량 실측) · step10(런북 §0·§10) · U4 |
| 3 | **Node 은퇴 = 운영 중단이지 코드 삭제가 아니다** — `server/**`·`src/**` 무수정·비삭제 | **되돌릴 수단과 판정 수단을 동시에 잃는다.** (i) 즉시 복귀 지점 (ii) `--parity` **313관측**의 대조군(비교 상대가 Node 리포트다) (iii) `test/**` **1328건**의 기반 | step10(삭제 전제 조건 목록) · P8 |
| 4 | **FTP 스풀 수집은 앱 밖 스위퍼가 받는다** — Spring 에 `WatchService` 를 넣지 않는다. **발효 시점은 조건절**(아래) | **수집이 조용히 멈춘다**(운영이 FTP 수집을 쓰는 경우). 반대로 Spring 안에 넣으면 「앱은 스스로 깨어나지 않는다」(ADR-008)가 무너지고 정적 게이트의 예외 0인 두 군을 열어야 한다 | **step6**(현재 `blocked` — Q1) · step10(런북 순서) |
| 5 | **`DATA_DIR` 은 컷오버 후에도 같은 값** — `<DATA_DIR>/uploads` 를 두 서버가 공유한다 | **롤백 후 기존 첨부·사진이 전부 404 가 된다**(DB 에는 파일명만 있다). 공유해도 **이름 충돌·덮어쓰기는 없다**(저장명 = 서버 발급 32-hex · 생성은 `wx`/`CREATE_NEW`) — 남는 위험은 **롤백 시 고아 파일**뿐이고 그것은 **지우지 않는다** | step8(적재 리허설) · step10(런북) |

**결정 4의 조건절 — 아직 발효 시점이 정해지지 않았다.** §0-5묶음 첫 행(`RCV_SPOOL_DIR` 설정 여부)이
**미상**이고 §0-2 **Q1** 이 그 질문이다. 답에 따라 갈린다:

| Q1 의 답 | 결정 4 의 위치 | 런북 영향 |
|---|---|---|
| **쓴다** | **컷오버의 필수 선행** — 같은 정지 창 안에서 스위퍼 등록까지 끝난다 | 정지 창 절차에 스위퍼 항목이 들어가고 U5 옆에 등록 항목이 하나 는다 |
| **안 쓴다** | **Node 은퇴의 전제**로 내려간다 — 도구는 만들되 검증 강도·문서 위치가 달라진다 | 컷오버 절차에서 빠지고 「Node 은퇴 전 확인」 절로 옮긴다 |

**운영자가 전환 전에 반드시 알고 있어야 할 것 둘**(런북 §0 낭독 대상 — 이 전환이 **잃는** 것이다):

1. **Spring 에는 단일 인스턴스 잠금이 없다.** 서로 다른 포트로 두 서버(또는 Spring 2개)를 동시에 띄우는
   구성을 **하지 마라.** 지키는 것은 사람이다(결정 2).
2. **Spring 의 `/api`·`/uploads` 응답에는 보안 헤더가 없다.** 이 phase 가 붙이는 것은 **SPA 문서·자산 응답의
   CSP 1종**뿐이고 나머지 10종(HSTS·nosniff·frame-options 등)과 `/api`·`/uploads` 의 CSP 는 **또 미룬다**
   (3연속 이월 — ADR-013 트레이드오프 → phase 74 → 이 phase). 동일 출처 loopback 배치라는 전제 위에서만
   허용되는 공백이다.

## 2. SPA 응답 바이트 패리티 하네스 (`scripts/spa-parity.mjs` — step3)

> **한 줄**: Node 서버와 Spring 서버를 **같은 `web/dist`** 로 나란히 띄우고 같은 요청 표(원문 요청줄 38건)를 보내 응답을
> 바이트로 대조한다. 계약 하네스(`--parity` 313관측)는 SPA 를 **구조적으로 보지 않으므로**(`SPA_DIR` 을 자식에게 넘기지
> 않는다 — §2-5 실측) 이 하네스가 **SPA 축의 유일한 기계 판정**이다. 판정부는 `scripts/lib/spaParity.mjs`(순수),
> 자기검사는 `scripts/lib/spaParity.self-test.mjs`(26항 — 시작 시 자동 실행, 빨간 채로는 서버를 띄우지 않는다).

### 2-1. 실행

```bash
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests   # jar 최신화(하네스는 빌드하지 않는다)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spa-parity.mjs                       # exit 0 · diffs 0
node --test scripts/lib/spaParity.self-test.mjs                                                       # 자기검사 단독
```

옵션: `--spa-dir <dir>`(기본 리포 `web/dist` — `<dir>/index.html` 필수) · `--out-dir <리포 밖>`(리포트 보존) · `--keep` · `--jar` · `--java-home` · `--timeout`.
요약 줄 형식: **`spa-parity A=node B=spring 관측 N · diffs F · 허용 diff A건 → ok|FAILED`** — 세 수치를 **항상** 낸다.
**기준값(2026-09-07 · HEAD 소스 · 연속 2회 동일 · 리포트 3파일 바이트 동일)**: **관측 38 · diffs 0 · 허용 diff 516건.**

절차(`spring-contract.mjs` 의 규율을 베꼈고 그 파일은 고치지 않았다): 자기검사 → 리포 밖 임시 루트 → 서버별 **별도** 임시
`DATA_DIR`(스키마·시드 = `src/db/**` · `uploads/<32hex>.png` 픽스처 1개 · mtime 고정) → 빈 포트 2개([15000,20000) 실제 listen)
→ `node server/index.js` + `java -jar` (env 는 OS 허용목록 + `DATA_DIR`·`PORT`·`HOST`·`SPA_DIR` 4키 · `.env` 미로드)
→ `/api/health` → **SPA 활성 확인**(`GET /` 가 200 + `index.html` 바이트 — 한쪽만 켜진 대조를 즉시 거부한다. 계획의 「기동 로그의 SPA 활성 1줄」은
쓸 수 없다: `serving SPA from …` 은 Node 에서는 콘솔 무출력 계약(README-배포 12절)이라, Spring 에서는 `LogService` 링 버퍼라 **둘 다 stdout 에 나오지 않는다** —
그래서 판정을 바이트로 했고 기동 로그는 진단용으로만 저장한다)
→ 요청 표 → 리포트 2벌(`node.json`·`spring.json`) + `diff.json` → 자식 종료(kill → 확인 → SIGKILL) → 임시 디렉토리 삭제.
실행 전후 리포 `news.db`·`uploads/`·`web/dist` 지문 무변을 단언한다.

### 2-2. 무엇을 보는가

- **요청 표 38건**(`REQUESTS` — 중복 name 은 즉시 실패, 30건 미만도 실패): `/` · `.do` 7경로 · `?query` · `HEAD` · 실제 자산 2종
  (`index.html` 에서 추출 — 해시 미하드코딩) · 없는 자산 · `/index.html` · `/assets`(디렉토리)·`/assets/` · `/api` 6종(200·401·401·404×3) ·
  `/uploads` 2종(404·**200** 픽스처) · `POST /list.do` · 경로 탈출 7종(`/../`·`%2f`·`%2e%2e`·이중 인코딩·**진짜 백슬래시**·`%5c`·`%00`) ·
  후행 슬래시 · dotfile 2종 · `;a=b` · `/List.do` · `/NUL`.
- **항목마다 비교하는 것**: `status` · `content-type` **원문** · `content-length` 유무 · 본문 **sha256** · 본문 길이 · `isIndex`(본문 = `index.html` 바이트) ·
  `leaks.packageJson`/`leaks.sqlite`(루트 밖 내용 노출 **불리언** — 본문 자체는 리포트에 싣지 않는다) ·
  **보안 헤더 12종 원문**(계획의 11종 + `x-xss-protection` — Node 실측으로 확정) · 캐시 4종(`accept-ranges`·`cache-control`·`etag`·`last-modified`).
- **판정 = (scope × 필드) 상수 `ALLOWED_DIFFS`** — 자기검사가 **집합**을 잠근다. 실패 diff 는 그 표에 없는 모든 차이다.

### 2-3. 허용 diff 목록 전문 (이 phase 가 알고도 남겨 둔 차이 — 런북 §0 낭독·§10 분기의 입력)

| scope | 허용 필드 | 현재 값(2026-09-07 실측) | 이유 | 대체 방어선 |
|---|---|---|---|---|
| `group:spa` | 보안 헤더 **10종**(CSP 제외) + 캐시 4종 | Node: COOP/CORP `same-origin` · OAC `?1` · Referrer `no-referrer` · nosniff · DNS-prefetch `off` · Download `noopen` · XFO `SAMEORIGIN` · XPCDP `none` · XSS `0` · `Cache-Control: public, max-age=0` · `ETag: W/"…"` — Spring: **전부 없음**(`Accept-Ranges`·`Last-Modified` 는 양쪽 동일) | helmet 등가 10종 3연속 이월(`excluded` (d) ②) · 캐시는 `/uploads` 선례대로 켜지 않음 | **CSP 는 이 경로군에서 실패 diff**(변이 N7) · 상태·content-type·sha256 실패 diff |
| `group:api` | CSP + 위 10종 + 캐시 4종 | Node 는 `/api` 응답에도 helmet 전부 + JSON `ETag` — Spring 없음 | 「Spring `/api` 응답에는 보안 헤더가 없다」(§1 낭독 2) | 39 라우트 shape 은 계약 313관측 |
| `group:uploads` | CSP + 위 10종 + 캐시 4종 | 〃(`/uploads/<hex>.png` 200 에서 실측) | 〃 | `UploadsStaticWireTest` + 상태·content-type·sha256 실패 diff · **변이 N9 가 이 행의 필요를 실증** |
| `status:404`(양쪽 404) | `bodySha256`·`bodyLength`·CSP | Node 404 = express finalhandler(`Cannot GET <경로>` 반향 · 147~163 B · **CSP `default-src 'none'`**) — Spring 404 = `HtmlErrors`(고정 136 B · SPA 경로의 404 는 helmet 값, `POST` 는 없음) | 본문은 계약이 아니다(`HtmlErrors` 의 입력 비반향 결정 · P1) · **발견**: Node 의 404/301 CSP 는 helmet 이 아니라 finalhandler 의 값이다 | 상태 404 · content-type 원문 `text/html; charset=utf-8` · `isIndex=false` 는 실패 diff(변이 N1·N2) |
| `class:malformed`(6건) | `status`·`contentType`·본문·`isIndex`·CSP | Tomcat 커넥터 **400**(435 B · `text/html;charset=utf-8`) — Express 는 fallthrough 로 **200 index.html** | 커넥터 완화(`allowEncodedSlash`·`allowBackslash`)는 보안 하향 — 맞추지 않는다 | **`leaks.*` 는 실패 diff**(양쪽 다 루트 밖 내용 0건 — 2-6 육안 확인) |
| `class:directory`(1건 `/assets`) | `status`·`contentType`·본문·`isIndex`·CSP | Node **301 → `/assets/`**(express.static `redirect:true`) — Spring **200 index.html** | 리소스 핸들러에 디렉토리 리다이렉트가 없다(추가는 새 표면) | `/assets/` 는 양쪽 200 index 로 strict · 디렉토리 목록은 양쪽 0 |

**늘리는 것은 결정이다** — 행을 더하려면 이 표와 `ALLOWED_DIFFS`·자기검사를 함께 고쳐라. 표에 없는 차이는 전부 실패 diff 다.

### 2-4. 이 하네스가 잡은 것 (Spring 을 고쳤다)

**SPA 200 응답의 `Content-Type` 이 전부 갈렸다** — Node(`send@0.19.2`+`mime@1.6.0`) `text/html; charset=UTF-8` · `text/css; charset=UTF-8` ·
`application/javascript; charset=UTF-8` 대 Spring `text/html` · `text/css` · **`text/javascript`**(charset 없음 · `.js` 는 기저 타입까지). step2 는 이것을
「기록만」으로 남겼으나 step3 계획은 content-type 을 **실패 diff** 로 못 박았고(허용에 넣으면 대조가 공허해진다 — 변이 N4), `RawContentType` seam 이 정확히
이 용도이므로 **Spring 을 고쳤다**: `SpaContentTypes`(Node `mime@1.6.0` 실측 확장자표 · 미지 확장자 = `application/octet-stream`) + `SpaResourceHandler` 의
응답 래퍼(프레임워크의 서블릿 API 지정을 seam 으로 되돌린다). 그 결과 `RawContentType.set` 호출 파일이 **넷**이 됐고
`SseHttpTest.exactlyFourFilesWriteTheContentTypeBytes` 가 집합을 잠근다. 잠금: `SpaContentTypesTest`(6) · `SpaServingWireTest.contentTypeLinesAreNodeOriginal` ·
`SpaRealDistWireTest.theRealAssetsCarryNodeOriginalContentTypes`. **Node 정본이 바뀌면**(express 5 = `send@1` 은 `text/javascript`) 이 하네스가 실패 diff 로 알린다.

### 2-5. 무엇을 보지 않는가

- **계약 하네스는 SPA 축을 구조적으로 보지 않는다 — 실측(§2-7 N1+N2)**: Accept 게이트와 `/api` 예약 접두사를 함께 지워 없는 자산·미정의 `/api` 경로가 SPA 200 으로
  뒤집힌 상태에서도 `node scripts/spring-contract.mjs --parity` 는 **313관측 diffs 0** 이다. 이 하네스가 그 축의 유일 방어선이다.
- 상태줄 **이유구**(Node `200 OK` · Spring `200 `) — 상태 정수만 비교한다(계약과 같다). `Vary`·`Access-Control-Allow-Credentials`(양쪽 동일) · `Date` · `Content-Language`(Tomcat 400 만) 는 관측하지 않는다.
- **조건부 요청(304)** · Range 요청 · 인증된 세션의 SPA 요청 · 실제 브라우저 렌더링(step4 실기 시나리오의 몫).
- `SPA_DIR` 이 리포 `web/dist` 와 **다른 산출물**인 배치(§0-3묶음 — 운영 `web\` 의 md5 를 먼저 대조하라. 다르면 이 하네스는 다른 파일을 비교한 것이다).
- 표에 없는 확장자의 Content-Type(`SpaContentTypes` 표는 `mime@1.6.0` 실측 27종 — `web/dist` 의 실물은 html·css·js 3종뿐이다).

### 2-6. 실패했을 때 리포트 읽는 법

1. 요약 줄의 **`diffs F`** 가 0 이 아니면 위쪽 `FAIL <항목> <필드>: A=<node> B=<spring>` 줄이 원인이다(`FAIL only-in-A/B` 는 한쪽 리포트에 항목이 없는 것 — 관측 수 자체가 줄었다).
2. `--out-dir` 을 주면 `node.json`·`spring.json`(항목별 레코드 — 본문 내용·절대경로·토큰 없음)·`diff.json`(`failures`/`allowed` 전문)·`*-boot.log`(기동 로그 — 경로는 `<tmp>`/`<repo>` 로 가림)가 남는다. 실패 시 임시 루트는 자동 보존된다(경로를 출력한다).
3. **`[spring] SPA 가 켜져 있지 않다`** 로 즉시 실패하면 대조 전 단계다 — `SPA_DIR`(`<dir>/index.html`)을 확인하라(변이 N6).
4. **허용 diff 건수가 516 에서 움직였다면** 그 자체가 신호다: 늘었으면 Node 가 새 헤더를 내기 시작했거나 Spring 이 무언가를 잃은 것이고, 줄었으면 Spring 이 새 헤더를 내기 시작한 것이다. `diff.json` 의 `allowed` 를 (scope, field) 로 묶어 어느 항목이 움직였는지 본다.
5. 판정부 자기검사가 red 면 `ALLOWED_DIFFS`·`OBSERVED_HEADERS`·요청 표 중 하나가 바뀐 것이다 — 하네스는 그 상태로 서버를 띄우지 않는다(변이 N4·N5·N8·N9).
6. `[spring] jar 에 IDE 가 컴파일한 클래스가 섞여 있다(Unresolved compilation problem)` 는 회귀가 아니라 **무효 jar** 다 — VS Code 의 java language server 가
   `target/classes` 에 JDT 산출물을 남기고 `package` 가 그것을 싣는다(2026-09-07 실측: `clean` 없는 `package` 는 매번, `clean package` 도 3회 중 1회꼴).
   `clean package` 로 다시 굽고, 필요하면 jar 안의 클래스에서 그 문구를 grep 해 확인한다.

### 2-7. 변이 결과표 (2026-09-07 · 전건 원복 후 md5 확인 — 기대≠실제는 굵게)

| # | 심은 것 | 기대 | 실제 | 원복 |
|---|---|---|---|---|
| N1+N2 | Spring `SpaFallbackRules`: `Accept` 게이트 제거 + 예약 접두사에서 `/api` 제거(한 빌드에 함께) | `asset-missing`·`/api` 미정의 3종에서 diff | **실패 diff 21건**(`asset-missing` 6필드 · `api-unknown`·`api-does-not-exist`·`api-upper` 각 5필드 — 전부 `404→200`·`isIndex false→true`) · **그 상태로 `spring-contract.mjs --parity` = 313관측 diffs 0**(246·55·4·5·3) ⇒ 계약은 SPA 축을 구조적으로 못 본다 | md5 `ad2e85bc…` 동일 |
| N3 | Spring 폴백이 `index.html`+1바이트를 돌려줌 — 1차: `ByteArrayResource` | 본문 sha256 diff | **1차는 500**(`lastModified()` 가 `FileNotFoundException` → `GlobalErrorHandler` JSON) → 99건. **2차(N3b · `lastModified` 위임)**: **실패 diff 48건 = 폴백 16항목 × (`bodySha256`·`bodyLength` 413→414·`isIndex`)** — `root`·`/index.html`·자산·`HEAD`(본문 없음)는 무변 | md5 `5c12d1b1…` 동일 |
| N4a | 대조기 `ALLOWED_DIFFS` 의 `group:spa` 에 CSP 추가 | CSP 부재가 조용히 통과 | **자기검사 red 3건 → 하네스가 기동 거부.** 잠금을 우회해 규칙만 바꾼 채 N7 리포트에 적용하면 **diffs 0 · 허용 537건** — 공허화 실증(N9 역방향과 동일) | md5 `bd1a1261…` 동일 |
| N4b | ① 대조기 `RECORD_FIELDS` 에서 `contentType` 제거 ② Spring 응답 래퍼 우회(charset 없는 컨테이너 값) | ①은 자기검사 red · ②는 content-type 실패 diff | ① **자기검사 red 3건 → 기동 거부** · ② **실패 diff 21건**(SPA 200 전건 `contentType`: `text/html; charset=UTF-8` 대 `text/html` 등) · ①+② 를 함께 심어 리포트에 적용하면 **diffs 0 · 허용 510건** — 공허화 실증 | md5 동일 |
| N5 | 요청 표에서 `do-list` 제거 | 관측 수 감소가 드러남 | **자기검사 red(`.do 7경로 중 list 가 없다`) → 기동 거부.** 필수가 아닌 `win-device-name` 을 빼면 **`관측 37 · diffs 0 · 허용 504건`** 으로 수치가 요약 줄에 드러난다 | md5 동일 |
| N6 | Spring 에만 `SPA_DIR` 미주입 | 대규모 diff | **SPA 활성 확인에서 즉시 실패**(`[spring] SPA 비활성(GET / = 404)` · 비교 전 단계 · exit 1). 그 확인을 빼면 **실패 diff 121건** | md5 동일 |
| N7 | Spring CSP 헤더 제거(step2 작업 D 되돌리기) | SPA 경로군 실패 diff | **실패 diff 21건 — SPA 200 응답 21건 전부 `headers.content-security-policy`(허용 diff 아님)** · 404·malformed·directory 항목은 규칙대로 허용 | md5 동일 |
| N8 | `SECURITY_HEADERS` 에서 `x-download-options` 삭제 | 자기검사 red | **자기검사 red 1건(집합 deep-equal) → 기동 거부** | md5 동일 |
| N9 | `ALLOWED_DIFFS` 에서 `group:uploads` 제거 | `/uploads` 항목 오탐 | **자기검사 red 2건 → 기동 거부.** 규칙만 바꿔 기준 리포트에 적용하면 **diffs 23**(`uploads-missing` 보안 헤더 10 · `uploads-existing` CSP+10+`cache-control`+`etag`) — 오탐 실증. **역방향**(`group:spa` 에 CSP 허용)은 N7 리포트를 diffs 0 으로 통과시킨다(N4a) | md5 동일 |

추가 실측: 자기 결정성 — HEAD 소스로 **연속 2회** `관측 38 · diffs 0 · 허용 diff 516건`, `node.json`·`spring.json`·`diff.json` **바이트 동일**. 두 자식 프로세스는 매 실행 `kill → 확인` 으로 종료를 확인하고 임시 루트를 지운다(성공 시 `정리: 자식 2 종료 확인 · 임시 디렉토리 삭제` 출력 · 실패 시 보존 경로 출력). 리포 `news.db` md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` 전 실행 무변.
