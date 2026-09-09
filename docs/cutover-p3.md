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
- **성공 판정**: `& %M% -u news_app -p -e "SHOW GRANTS"` 에 ``GRANT DELETE ON `news`.`receiverconfig` TO `news_app`@`localhost` ``
  (또는 `news_stage` 판)이 **한 줄로** 보인다. 테이블 이름은 **소문자**로 붙는다(`lower_case_table_names=1`) —
  `GRANT SELECT, INSERT, UPDATE ON \`news\`.*` 줄과 **다른 줄**이다(그 줄에 `DELETE` 가 끼는 것이 아니다).
- **실패 시 분기**: 붙지 않은 채로 전환하면 **기동 성공 · 하네스 green · 수신설정 삭제만 500** 이다.
  행동 판정은 `news_app` 으로 `DELETE FROM ReceiverConfig WHERE id = -1` 을 던져 **`ERROR 1142` 이면 미부착**,
  `ERROR 1054`(열 이름) 이면 권한 검사를 통과한 것이다(`id = -1` 이라 **어느 쪽이든 지워지는 행은 없다**).
- **현재 상태(2026-09-09 재확인 · 읽기 전용)**: **`news`·`news_stage` 둘 다 미부착**이고 `news_app` 의
  `SHOW GRANTS` 에 있는 `DELETE` 는 ``GRANT DELETE ON `news_grant_probe`.`receiverconfig` `` **1줄뿐**이다.
  그 상태에서 **삭제 라우트가 500** 이라는 사실은 §7-6 **T5** 가 실측으로 못 박았다(관측 DB `news_stage` ·
  자격 `news_app` · 같은 시점 `--db mysql --parity` 는 **green** — 하네스는 `news_ct`(ALL)로 돈다).

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

### U5. 작업 스케줄러 tick 작업 **교체** (운영) — 근거·실측은 §6

- **왜 사람이 해야 하는가**: 스케줄러 등록은 운영 권한이고, **추가가 아니라 교체**여야 한다 —
  옛 작업이 남으면 같은 tick 이 두 번 돈다. 그리고 §0-6 의 작업 이름·주기·스크립트 경로·자격 위치가 **전부 미상**이라 에이전트가 대신 고를 수 없다.
- **먼저 읽을 것**: 운영 머신에서 `schtasks /Query /FO LIST /V` 로 기존 tick 작업의 **이름·트리거 주기·실행 계정·동작(Action)** 을 읽어 §0-6 에 적는다(값이 아니라 위치만).
  **주기가 90초 미만이면 그대로 옮기지 마라** — 새 스크립트는 호출마다 로그인하고 로그인 한도가 15분/10회라 90초 미만 주기는 15분 안 11번째부터 429 로 멈춘다(§6-4 산술표 · 권장 5분).
- **정확한 명령**(step7 이 검증한 `packaging/server/tick-distribution-spring.ps1` — README-배포 §6-1):
  1. 실행 계정의 환경변수에 자격을 둔다: `setx NEWS_TICK_USER <Z계정ID>` · `setx NEWS_TICK_PASSWORD <비밀번호>` · (포트가 3001 이 아니면) `setx NEWS_TICK_BASE http://127.0.0.1:<PORT>` —
     **그 계정으로 로그인한 세션에서** 실행한다(사용자 변수). bat·ps1·작업 인자에 값을 두지 않는다.
  2. 기존 작업 비활성화: `schtasks /Change /TN "<기존 작업명>" /DISABLE` (**삭제가 아니다** — 되돌림 레버).
  3. 새 작업 등록: `schtasks /Create /TN "기사작성기-distribution-tick" /SC MINUTE /MO 5 /TR "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <배포폴더>\tick-distribution-spring.ps1 -LogFile <배포폴더>\data\tick.log" /RU <실행 계정> /F`
     → 작업 속성에서 "이미 실행 중이면 새 인스턴스를 시작하지 않음" 을 켠다.
  4. 즉시 1회 실행해 본다: `schtasks /Run /TN "기사작성기-distribution-tick"` → `tick.log` 마지막 줄이 `tick ok distributed=<n> …` 이고 마지막 실행 결과가 `0`.
- **성공 판정**: (a) `schtasks /Query /FO LIST /V` 에 **활성 tick 작업이 정확히 하나**(옛 것은 `Disabled`) (b) `tick.log` 에 주기마다 한 줄 · 마지막 실행 결과 `0`
  (c) 다음 주기 이후 `DIST_SPOOL_DIR` 파일 수가 **주기당 한 벌만** 는다.
- **실패 시 분기**: 두 벌이 늘면 옛 작업이 살아 있는 것이다 — 즉시 하나를 비활성화한다(파일은 지우지 않는다). 마지막 실행 결과가 `3` 이면 자격/한도(429 면 주기를 늘린다) ·
  `4` 면 비-Z 자격이거나 `DIST_SPOOL_DIR` 미설정(503) · `5` 면 서버 미기동/포트 · `6` 이 반복되면 이전 실행이 안 끝난 것(§6-6 6). 롤백은 2↔3 을 역순으로(Spring용 `/DISABLE` → 옛 작업 `/ENABLE`).

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
- **성공 판정**: 대상 7테이블 행 수 **0**. 판정은 **반드시 `COUNT(*)`** 로 한다:
  `& %M% -u news_migrator -p -D <대상> -e "SELECT 'User', COUNT(*) FROM User UNION ALL SELECT 'Article', COUNT(*) FROM Article UNION ALL SELECT 'Contents', COUNT(*) FROM Contents UNION ALL SELECT 'ArticleHistory', COUNT(*) FROM ArticleHistory UNION ALL SELECT 'ReceiverConfig', COUNT(*) FROM ReceiverConfig UNION ALL SELECT 'DistributionTarget', COUNT(*) FROM DistributionTarget UNION ALL SELECT 'Photo', COUNT(*) FROM Photo"`
  - **⚠ `information_schema.TABLES.TABLE_ROWS` 를 판정에 쓰지 마라 — 추정치라 거짓말한다(2026-09-09 실측).**
    768자 PK 로 이관이 롤백된 직후의 대상에서 `TABLE_ROWS` 는 `user = 11` 로 보였고 같은 순간
    `SELECT COUNT(*) FROM User` 는 **0** 이었다(§7-6 T4). 그 표를 믿으면 **비어 있는 대상을 「부분 적재」로 오진**하고,
    반대 방향의 오진(차 있는 대상을 비었다고 읽는 것)은 더 위험하다.
- **실패 시 분기**: 판정이 0 이 아니면 `migrate` 를 다시 돌리지 마라(또 exit 1 이다) — (나) 경로로 대상을 바꾼다.
- **실측(§7-6 T6 · 2026-09-09)**: 적재된 대상에 두 번째 `migrate` → **exit 1** ·
  `대상이 비어 있지 않다 [User, Article, Contents, ArticleHistory, Photo] — 비우고 다시 넣지 않는다.` ·
  **소스 md5 무변 · 대상 행 수 전건 동일**(그 뒤 `verify` 가 여전히 **exit 0 일치**). 이어서 **(나) 빈 DB 를
  새로 만드는 경로로 복구**가 실측으로 돌았다(`migrate` exit 0 · 178행 · `verify` 일치) — **부분 적재 DB 는
  그대로 남는다**(증거 보존). 즉 **아무것도 지우지 않고 컷오버를 이어 갈 수 있다.**

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

## 3. 실기 통합 시나리오의 Spring 모드 (`scripts/verify-integration.mjs --server spring` — step4)

> **한 줄**: phase 63 의 실기 스모크(서버 exe + **Electron 클라 exe** 를 함께 띄워 CDP 로 로그인→SSE→작성→팝업→송고를 판정)를
> **서버 자식을 만드는 자리 하나만** 분기해 Spring 에 겨눈다(decisions (9) — 739줄 정본을 복제하지 않는다 · `export` 0 유지).
> "Electron 클라가 Spring 에 붙는다" 가 사람 눈이 아니라 **exit code** 로 판정되고, step2 의 SPA 서빙이 **실제 Chromium** 에서
> 동작하는지(자산 로딩·history 라우팅·SSE)가 여기서 처음 실증된다. 순수 판정부는 `scripts/lib/integrationMode.mjs`
> (인자 허용값 · env 허용목록 조립 · 스풀 파일명 판정 — `node --test scripts/lib/integrationMode.test.mjs` 9항).

### 3-1. 실행 (두 모드)

```bash
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests   # jar 최신화(하네스는 빌드하지 않는다)
node scripts/verify-integration.mjs --scenario loopback                                               # exe 모드(기본) — 기존과 동일
node scripts/verify-integration.mjs --server exe --scenario loopback                                  # 같은 것(명시)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/verify-integration.mjs --server spring --scenario loopback
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/verify-integration.mjs --server spring --scenario lan
node --test scripts/lib/integrationMode.test.mjs                                                       # 순수 판정부 단독
```

옵션(spring 전용 — exe 모드에 오면 조용한 무시가 아니라 die): `--jar <path>`(기본 `server-spring/target/server-spring-0.0.1-SNAPSHOT.jar` · 없으면
빌드 커맨드를 안내하고 죽는다) · `--java-home <path>`(기본 `SPRING_JAVA_HOME` → `JAVA_HOME` · 시스템 java 폴백 없음) · `--spa-dir <dir>`(기본 리포 `web/dist` ·
`<dir>/index.html` 필수). 공통 옵션(`--scenario`·`--cdp-port`·`--show`·`--keep`·`--timeout`)은 그대로다. `--server` 허용값 밖은 즉시 `die()`(변이 P4).

**spring 모드에서 다른 것은 정확히 이것뿐이다**: 서버 자식 = `<JDK>/bin/java -jar <jar>`(cwd 임시) · env = **OS 허용목록**(win32 10키 — `spring-contract.mjs`
`javaChildEnv` 동형) **+ 5키**(`DATA_DIR`(임시 시드 = `src/db/**` · sqlite 기본) · `PORT` · `HOST` · `SPA_DIR` · `DIST_SPOOL_DIR`(임시)) — **`APP_ENV` 는 어떤 경로로도
실리지 않는다** · 헬스 판정은 기존 `healthOk`(200 + 본문 `{ok:true}` — 클라 `probeOrigin` 과 같은 판정) · 종료는 기존 `killChild` · 데이터 안전 스냅샷 4종
(리포 `news.db`·`uploads/`·`%APPDATA%\기사작성기`·`dist/*/data`)은 시나리오 공통이라 **spring 모드에도 그대로 돈다**. 방화벽 안내(`netsh … program=`)만
`java.exe` 를 가리킨다(실제 listen 하는 실행 파일이 그것이다).

**기준값(2026-09-07 · HEAD)**: spring loopback **연속 2회 exit 0**(Spring 기동 5613ms / 5309ms · 30초 한도 안 · 전체 25.6s / 36.6s) · exe 인자 없음·명시 **exit 0**
(기동 1961ms / 392ms) · **lan 양 모드 exit 0**(§3-5) · `--server foo` **exit 1** · 리포 `news.db` md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` 전 실행 무변 · 실행 후 java 프로세스 0.

### 3-2. 무엇을 자동 판정하는가 (두 모드 공통)

기존 판정 전부(diag 시퀀스 `app-ready→config-loaded→app-window→did-navigate 200→did-finish-load` · `secure-origin-switch` 양성/음성 · `isSecureContext` ·
클립보드 표면 · desk 로그인 · 목록 `실시간`(SSE) · 작성 → 행 등장(SSE) · 상세보기 팝업 720×800 · `window-open allow` · 송고 `DPS` → 행 소멸(SSE)) **+ 이 step 이 더한 2단계**:

- **배부 대상 생성(Z, press)** — 시드에는 활성 `DistributionTarget` 이 없다(`src/db/seed.js` 는 users 뿐). 송고 전에 **Node 측 fetch 로 Z 로그인** →
  `POST /api/distribution-targets {name, kind:'press', spoolDir:'vi-<scenario>-<ts>'}`(계약 정본 `contract/cases/default/distribution-targets.contract.js`) → `{ok,id}`.
  렌더러 세션(desk)과 무관하다. 세션 토큰은 로그·notes 에 남지 않는다.
- **배부 스풀 관측 1단계** — 송고 뒤 `<DIST_SPOOL_DIR>/<spoolDir>/<articleId>_<YYYYMMDDTHHMMSSmmmZ>.json` **1건 이상**(재귀 탐색 · 파일명 정확 일치 ·
  `.<name>.tmp` 임시 파일 불인정). `DIST_SPOOL_DIR` 미주입 · 대상 없음 · 0건은 **skip 이 아니라 실패**다(변이 P2). 바이트 대조는 step5 가 한다.
  실측: 두 모드 모두 송고 응답 직후 1건(관측 2~4ms — 송고 훅이 응답 전에 스풀을 쓴다).

### 3-3. 무엇을 못 보는가 (정직한 공백)

- **스풀 파일의 내용**(step5 소유) · **클립보드 실왕복**(비표시 창은 `Document is not focused` → `unverified` · `--show` 소유) · 팝업 크기는 비표시 스로틀로 `unverified` 가 남을 수 있다(§5 사전 승인).
- **MySQL 축** — `--db mysql` 을 **추가하지 않았다**(§3-6). 이 시나리오의 Spring 은 언제나 `DB_KIND=sqlite`(임시 `news.db`)다.
- **수집**(HTTP 수집 라우트 · FTP 스위퍼 — step6) · **엠바고 tick 배부**(step7) · 브라우저(비-Electron) 접속 · 운영 `web\` 산출물이 리포 `web/dist` 와 같은가(§0-3묶음 md5 대조가 먼저다).
- **`APP_ENV=production` 함정은 이 시나리오가 구조적으로 못 본다 — 실측(§3-7 P5)**: Chromium 은 `http://127.0.0.1` 을 potentially-trustworthy 로 취급해 **`Secure` 쿠키를 받아들이고**,
  lan 시나리오의 Electron 도 `secure-origin-switch` 로 같은 취급을 만든다. 그래서 production 쿠키(`Secure; SameSite=None`)로도 로그인·SSE 가 **통과**한다.
  브라우저 + LAN 평문 HTTP 에서만 죽는 결함이며, 방어선은 **허용목록 env 조립 하나**다(우회하면 이 시나리오는 알리지 않는다 — 쿠키 속성으로만 보인다).
- 방화벽 **exit 2** 의 실제 모습(이 머신은 두 모드 모두 차단이 없었다 — §3-5).

### 3-4. 실패했을 때 진단 순서

1. **`Spring 실행 jar가 없다`** / 기동 실패 stderr 에 `Unresolved compilation problem`·`cannot access` — 회귀가 아니라 **무효 jar**(IDE 의 `target/` 오염 · §2-6 6항) → `clean package`.
2. **health ok 인데 `diag … did-navigate 200` 이 `missing=did-navigate` 로 실패하고 이어서 `CDP page 타깃을 찾지 못했다`** — `GET /` 가 404 = **`SPA_DIR` 미주입 또는 `<dir>/index.html` 부재**(변이 P1 의 정확한 모습).
   서버는 죽지 않는다(설계 — README「SPA 동일 출처 서빙」). `--spa-dir` 과 `npm run build` 를 확인하라.
3. **`서버가 기동하지 않았다(loopback health 실패)`** 30초 — 포트 충돌(로그의 `ports server=`) · JDK 홈(`--java-home`) · `DATA_DIR` 시드 실패. 30초를 넘기면 **그것이 발견이다**(한도를 올리지 마라 — 실측 4.3~5.6s).
4. **`배부 대상 생성(Z, press)` 실패** — Z 로그인(`admin`) 또는 라우트 인가 회귀. **`배부 스풀 파일 … 0건`** — `DIST_SPOOL_DIR` 미주입(Spring 은 미설정이면 송고 훅 자체가 결선되지 않고
   송고는 `DPS` 로 **정상 응답**한다 — 변이 P2c) 또는 대상이 비활성. 관측은 `--timeout` 까지 기다린 뒤 실패한다(기본 45s).
5. **로그인은 되는데 SSE `실시간` 이 안 온다** — 이 시나리오에서는 `APP_ENV` 가 원인일 수 없다(§3-3). 세션 쿠키 경로·CSRF 출처 판정(`server.forward-headers-strategy=none`)을 보라.
6. diag JSONL(실패 시 notes 에 전부 첨부)에서 셸 부팅 시퀀스가 **어디서 끊겼는지** 읽는다 — `local-window` 가 `did-navigate` 뒤에 오면 클라가 오류 화면으로 떨어진 것이다.

### 3-5. `--scenario lan` 3분법 실측 (2026-09-07 · 이 머신 `10.10.91.90`)

| 모드 | exit | 관측 |
|---|---|---|
| exe | **0** | loopback health 283ms · LAN origin health ok · `secure-origin-switch{origin:http://10.10.91.90:<port>}` 존재 · 스풀 1건 |
| spring | **0** | loopback health 4891ms · LAN origin health ok · 같은 switch 이벤트 · 스풀 1건 |

3분법(skip=0 / 제품 실패=1 / **환경 차단=2**)의 코드 경로는 두 모드가 **공통**이다(loopback 프로브 성공 + 같은 포트 LAN origin 도달 불가 → `blocked`). spring 모드에서 달라지는 것은
netsh 안내의 `program=` 이 `java.exe` 라는 것뿐이다. **이 머신에서는 두 모드 모두 방화벽 차단이 없어 exit 2 를 실제로 관측하지 못했다** — 차단이 나는 머신에서는 안내대로 허용 후 재실행이 답이며 제품 결함이 아니다.

### 3-6. `--db mysql` 을 추가하지 않은 이유 (결정)

이 step 의 판정 대상은 **클라 ↔ 서버 결합**(SPA 서빙 · 쿠키/SSE · 팝업 · 송고 훅)이고 저장소 방언은 그 판정에 영향을 주는 축이 아니다. MySQL 축은 이미 `scripts/spring-contract.mjs --db mysql --parity`
(313관측 diffs 0)가 **같은 sqlite 시드를 마이그레이터로 적재해** 39 라우트를 대조하고 있고, 여기에 더하면 마이그레이터 자식 호출 · `harness_ct_<16hex>` 드롭 장부 · `news_ct` 자격 파일 수명 관리가
**서버 기동부 분기 하나** 라는 이 step 의 경계를 넘는다(decisions (9)). 필요해지면 `spring-contract.mjs` 의 `runSpringPass` 1-b 절차를 그대로 옮기되, 이 step 은 그 결정을 **하지 않았다** 고 적는다.

### 3-7. 변이 결과표 (2026-09-07 · 전건 원복 후 `scripts/verify-integration.mjs` md5 `f941650c…` 확인 — 기대≠실제는 굵게)

| # | 심은 것 | 기대 | 실제 | 원복 |
|---|---|---|---|---|
| P1 | spring 자식 env 에서 `SPA_DIR` 제거(조립 뒤 delete — 서버는 뜬다) | spring 모드 실패(클라가 화면을 못 받는다) | **exit 1** — health ok 4884ms → `diag … did-navigate 200` **missing=did-navigate**(이벤트 순서 `did-navigate, local-window, …` = 404 뒤 오류 창) → `CDP page 타깃을 찾지 못했다` · 전체 96.6s(타임아웃 누적) | md5 동일 |
| P2a | exe 경로에서 `DIST_SPOOL_DIR` 주입 줄 제거 | 배부 관측 명시 실패 | **exit 1** — 다른 판정 전부 ok · `FAIL 배부 스풀 파일 … 스풀 파일 0건(디렉토리 내 파일 0건)`(45s 대기 후) | md5 동일 |
| P2c | spring 자식 env 에서 `DIST_SPOOL_DIR` 제거(조립 뒤 delete) | 배부 관측 명시 실패 | **exit 1** — 송고는 `DPS` **정상 응답**(Spring 은 미설정이면 훅 미결선) · `FAIL … 0건`(45s) | md5 동일 |
| P2b | `springServerEnv({spoolDir: undefined})` | 조립 거부 | 단위 테스트가 잠근다(`DIST_SPOOL_DIR` 지목 throw) · 본체는 `spring 서버 env 조립 실패` 로 기동 전 실패 | — |
| P3 | `healthOk` 를 상태코드만 보게(`if (res.status === 200) return true`) | 잘못된 서버에도 붙는다 | 스크립트의 실제 `healthOk` 원문을 가짜 서버 4종에 적용: **원본** = `200 {}` false · `200 {"ok":false}` false · `200 text/html`(캡티브 포털) false · `{"ok":true}` true — **변이** = **4종 전부 true**(빈 JSON·`ok:false`·HTML 포털에 붙는다). 클라 `interpretHealthResponse` 와 같은 판정이어야 하는 이유 실증 | md5 동일 |
| P4 | `--server foo` | 즉시 die | **exit 1** `--server 값이 유효하지 않다(exe|spring): "foo"` · `--server`(값 없음) · `--server exe --jar x` · `--server spring --server-exe x` 도 각각 die | 코드 무변 |
| P5 | spring env 를 `{ ...process.env, ...허용목록 }` 로 + 부모 셸 `APP_ENV=production` | 결정성 훼손 관측(로그인/SSE 실패) | **exit 0 — 통과했다(기대≠실제).** 로그인 ok · SSE `실시간` 273ms. 원인 실측(쿠키 프로브): 변이 자식 env **118키 · `APP_ENV=production` 도달** · `Set-Cookie: …; HttpOnly; **Secure; SameSite=None**` — 허용목록 자식 env **12키 · APP_ENV 없음** · `…; HttpOnly; SameSite=Lax`. 서버는 production 으로 갔는데 **Chromium 이 `http://127.0.0.1` 에서 Secure 쿠키를 받아들여** 시나리오가 통과한다 ⇒ 이 함정은 **이 시나리오가 못 본다**(§3-3). 대조군(원본 + 부모 `APP_ENV=production`)도 exit 0 — exit code 로는 둘을 가를 수 없고 쿠키 속성으로만 갈린다 | md5 동일 |

추가 실측: 실행 후 `java.exe` 0 · 이 step 의 실행이 남긴 임시 디렉토리 0(`%TEMP%` 의 `verify-integ-*` 3개는 07:42/07:47 타 세션 산출물 — 이 스크립트는 자기가 만든 경로 밖을 지우지 않으므로 남겨 둔다) ·
`test/verify-integration-portrange.test.js`(텍스트 잠금) 6/6 green — 숫자 `pickFreePort(` 호출은 여전히 2건이다.

## 4. 배부 스풀 산출물 바이트 대조 하네스 (`scripts/spool-parity.mjs` — step5 · 로드맵 P3 완료 게이트 ②)

> **한 줄**: Node 서버와 Spring 서버를 **각각의** 임시 `DATA_DIR`·`DIST_SPOOL_DIR` 로 나란히 띄우고 같은 시나리오 5축을 기사 1건씩 순차 재생한 뒤,
> 두 스풀 루트의 파일을 (수신처 폴더 집합 · 폴더별 파일 수 · **정규화 후 전 바이트**)로 대조한다. 이 바이트를 보는 자리는 여기뿐이다 — 계약 스위트는
> 응답에 스풀 경로가 **없음**을 단언하고(`distribution-tick.contract.js` `assertNoSpoolPath` 4단언), `--parity` 는 HTTP 만 보며, Java `SpoolWriterTest` 는
> **자기 기대값**과의 대조다(§4-7 추가 실측이 그것을 수치로 확정한다). 판정부는 `scripts/lib/spoolParity.mjs`(순수), 자기검사는
> `scripts/lib/spoolParity.self-test.mjs`(17항 — 시작 시 자동 실행 · 빨간 채로는 서버를 띄우지 않는다).

### 4-1. 실행

```bash
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q clean package -DskipTests   # jar 최신화(하네스는 빌드하지 않는다)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spool-parity.mjs                          # sqlite 축 · exit 0 · diffs 0
# §3 절차로 NEWS_CT_MYSQL_* 3키만 셸에 실은 뒤(NEWS_DB_* 금지)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spool-parity.mjs --db mysql               # Spring=MySQL 축(75 경로 그대로)
node --test scripts/lib/spoolParity.self-test.mjs                                                          # 자기검사 단독(21)
```

옵션: `--db <sqlite|mysql>` · `--keep`(스풀 파일까지 보존 — 첫 실행은 이것으로 파일 하나를 눈으로 봐라) · `--out-dir <리포 밖 — win32 는 대소문자 무시로 판정>` · `--jar` · `--java-home` · `--timeout`.
요약 줄 형식: **`spool-parity A=node B=spring 폴더 F · 파일 N · diffs D · 눈감은 자리 A=x B=y db=<kind> → ok|FAILED`** — 판정은 **종합 하나**(대조 결과 + 자식 잔존 · 리포 `news.db` 변동 · 비밀 누출 · 드롭 실패까지 합산).
스풀 수집 **전**에 실패하면(기동·재생 실패) 수치가 없다: `spool-parity 비교 불가(스풀 수집 전 실패 — 수치 없음) db=<kind> → FAILED`. `diff.json` 의 `summary` 는 대조 판정만 담는다(`formatSummary`).
**기준값(2026-09-07 · HEAD 소스 · sqlite 연속 2회 동일 · mysql 1회)**: **폴더 3 · 파일 11 · diffs 0 · 눈감은 자리 66/66** (양 축 동일).

절차(`spa-parity.mjs`·`spring-contract.mjs` 의 규율을 베꼈고 그 파일들은 고치지 않았다): 자기검사 → 리포 밖 임시 루트 → 서버별 임시 `DATA_DIR`
시드(`src/db/**`) + 서버별 `spool/` → [mysql: `ephemeral-create` → `migrate --source <seed> --target NEWS_CT_PASS` → Spring `DB_KIND=mysql` ·
적재 후 임시 `news.db` md5 무변 단언 · finally `ephemeral-drop`] → 빈 포트 2개 → `node server/index.js` + `java -jar`(env = OS 허용목록 +
`DATA_DIR`·`PORT`·`HOST`·`DIST_SPOOL_DIR` 4키 · **`SPA_DIR` 미주입**) → `/api/health` → 시나리오 재생(D·Z 로그인은 `SAMPLE_USERS`) → 스풀 수집 →
시나리오 자기 점검(폴더별 기대 파일 수 `{sp-press:5, sp-nonpress:4, sp-retry:2}`) → 실패 원장 투영 대조 → 순수 판정부 → 자식 종료 → 정리.

### 4-2. 시나리오 5축 (`buildScenarioPlan` — 입력은 한 번 만들어 두 서버에 **같은 값**으로 재생한다)

| 순번 | 축 | 무엇을 | 기대 |
|---|---|---|---|
| ga | (가) 엠바고 없음 | D 작성·송고 | 즉시 press+nonpress → `DPS` · `sp-press`·`sp-nonpress` 1건씩 |
| na | (나) 2차 엠바고만(30분 전) | 송고 → `DES` 응답 → press 즉시 → `EPS` → Z tick | tick `kinds=[nonpress]`·`DPS` · `sp-press`(송고 시)·`sp-nonpress`(tick 시) |
| da | (다) 1차 엠바고(1시간 전) | 송고 → `DES`(즉시 배부 없음) → Z tick | tick `kinds=[press]`·`DPS` · `sp-press` 1건 |
| ra | (라) 재전송 | `<spool>/sp-retry` 자리에 **일반 파일**을 놓고 press 수신처 `sp-retry` 생성 → 송고 → 양쪽 `spool-write-failed` → `GET /api/distribution/failures` → 파일 제거 → `POST /api/distribution/retry {historyId}` | 원장 1건(사유·kind·targetKind·targetActive·kindDistributed·targetName·키 집합)이 **두 서버에서 같은 모양** · 재전송 후 원장 해소 · `sp-retry` 1건 |
| ma | (마) 이스케이프 축 | 제목·keyword·externalComment 에 **제어문자 9자 전부**(0x0B·0x0E·0x0F·0x1A~0x1F) + 한글·이모지(서로게이트 쌍)·따옴표·개행·탭·백슬래시·`U+2028`·DEL·`<>&/` · **비어 있지 않은 `internalComment`** · 본문에도 같은 표본 | 송고 전 `GET /api/articles/:id` 로 **저장 왕복 동일** 단언(갈리면 스풀 대조 전에 그것이 발견) · 3폴더 1건씩 |

기사 id 는 서버가 만들어 양쪽이 다르므로 **짝짓기는 정렬이 아니라 (수신처 폴더, 시나리오 순번)** 이다 — 재생기가 순번→articleId 표를 양쪽 각각 만들고,
표에 없는 articleId 의 파일은 실패다(Q8 의 방어선). Node 는 송고 응답 **뒤에** 스풀을 쓰므로(fire-and-forget) 되읽기 폴링(`distributedAt` 확정)으로 흡수한다.

### 4-3. 무엇을 눈감고 대신 무엇을 단언하는가 (decisions (8) · `PLACEHOLDER_KEYS` 한 곳)

계획은 자리표시자 **3종**(`distributedAt` · 파일명 stamp · `articleId`)이었다. **그 3종만으로 1회 실측하자 11쌍 전부가 `createdAt` 자리에서 갈렸다**
(첫 차이 자리 `createdAt` 11/11 · `createdAt`·`sentAt` 두 값을 지우면 전부 동일 — `articleService` 가 서버 시각을 stamp 하는 컬럼이라 두 서버의
시계가 다르다). 그래서 **`createdAt`·`sentAt` 을 더해 4종**이 됐고(+ 파일명 2자리 = 파일당 6자리 · 11파일 = **66**), 늘린 대가로 **눈감는 대신 단언**한다:

| 눈감는 자리 | 대신 단언하는 것(양쪽 각각 · `normalizeFile`) |
|---|---|
| `distributedAt` | ① ISO-8601 밀리초 UTC(`YYYY-MM-DDTHH:MM:SS.sssZ`) ② **파일명 stamp == `distributedAt` 에서 `[-:.]` 제거값**(같은 `stamp` 에서 나왔다) |
| 파일명 stamp | ②와 같다 · 파일명 형태 `<articleId>_<8자리>T<9자리>Z.json`(`.tmp` 잔존은 실패) |
| `articleId` | ④ 파일명 articleId == 페이로드 articleId · 시나리오 순번 표에 있는 값 |
| `createdAt` · `sentAt` (추가) | ① 같은 형식 · ③ **단조성 `createdAt ≤ sentAt ≤ distributedAt`**(같은 ms 허용 — 송고와 배부가 한 ms 안에 끝나는 서버가 있다. tick·재전송 파일은 `sentAt < distributedAt` 이 뚜렷하다) |

치환은 **최상위 키의 문자열 값만** 바꾼다(전용 JSON 스캐너 — 제목 안에 `"distributedAt":"…"` 같은 글자가 있어도 손대지 않는다 · 자기검사가 그 경우를 박아 둔다).
눈감기 **전**에 ⑤ **raw 표기**도 단언한다(2026-09-08 리뷰 후속): 치환할 raw 슬라이스가 `JSON.stringify(파싱 값)` 과 **바이트 동일**해야 한다 — 값(ISO·articleId)이 ASCII 라
역슬래시-u0041(= `A`) 류 이스케이프 변형은 파싱 값이 같아 ①~④를 다 통과하지만 산출물 바이트는 다르므로, 이 단언이 없으면 자리표시자 자리가 그 차이를 삼킨다(자기검사가 u0032=`2`·u002d=`-`·u0054=`T` 변형을 박아 둔다).
그 밖의 키(`title`·`markupVersion`·`embargoAt`·`secondEmbargoAt`·`status`·`keyword`·`author` …)는 **클라가 준 값이거나 양쪽이 같아야 하는 값**이라 자리표시자 금지 —
자기검사가 **집합**(순서까지)을 잠그고 그 7키가 목록에 없음을 함께 단언한다. 자리표시자를 늘리는 것은 결정이다(Q6 가 그 대가를 실증한다).

### 4-4. 육안 확인 (2026-09-07 · `--keep` 첫 실행 · (마) `sp-press` 파일 · 양쪽 **757 B**)

키 순서 13개 양쪽 동일: `articleId,title,author,department,departmentCode,category,keyword,externalComment,createdAt,sentAt,status,markupVersion,distributedAt`
(값이 NULL 인 `coAuthor`·`region`·`attribute`·`attachmentFile`·`referenceFile`·`embargoAt`·`secondEmbargoAt` 는 **키 자체가 없다** — pick 의미론).
제목 원문: `"ESC:\u001b VT:\u000b US:\u001f 한글 😀 \"따옴표\" \\백슬래시 \n개행 \t탭 <>&/ 줄분리:<U+2028 raw> DEL:<0x7F raw> 끝"` — 한글·이모지·`U+2028`·DEL 은 **raw**,
따옴표·백슬래시·개행·탭은 짧은 이스케이프, 9자 제어문자는 **소문자** `\u00xx`(Node `JSON.stringify` = Spring `LowercaseHexEscapes`). `markupVersion` 은 JSON-in-JSON 이라
같은 표본이 `\\u001b`·`\\\"` 로 한 번 더 이스케이프된다. `internalComment` 는 어느 쪽에도 없다. 실패 원장 투영도 양쪽 동일(`spool-write-failed`·press·`retry-target`·10키).

### 4-5. 무엇을 보지 않는가

- **외부 전송기가 파일을 집어가는 경로·발송 결과** — 이 리포 밖이다(ADR-008). 원자 게시의 원자성 자체(단위 테스트가 호출 **순서**만 잠근다).
- **표본에 없는 값** — 예: `title` 폴백(`Contents.title` NULL 이고 `Article.title` 만 있는 행)·`attachmentFile` 등 파일 참조·`coAuthor` 가 있는 기사(na 만) ·
  `embargoAt`/`secondEmbargoAt` 가 **둘 다** 있는 기사 · 미래 엠바고. 필요하면 `buildScenarioPlan` 에 순번을 **추가**하고 `expectedFolderCounts`·자기검사를 함께 고쳐라.
- 두 서버가 **다른 기사**를 다르게 저장하는 경우(저장 왕복 단언은 (마) 4필드뿐이다).
- 시각 값 자체의 동등성(눈감는다 — 위 표의 형식·정합·단조성만).

### 4-6. 실패했을 때 읽는 법

1. **`FAIL [node|spring] <폴더>/<파일>: …`** 가 먼저 나오면 정합 위반이다(형식·stamp 정합·단조성·자리표시자 raw 표기·순번 표 밖 articleId(own property 만 조회)·`.tmp` 잔존) — 바이트 비교 **전**이라 `파일 0` 으로 요약된다.
2. **`파일 수가 다르다`·`스풀 파일 수가 시나리오 기대와 다르다`** — 구현 차이보다 **시나리오를 먼저 의심**하라(대상 활성·엠바고 판정·tick 순서 · 재생 로그의 `[label] <순번> … → ok` 줄 어디서 끊겼는지).
3. **`DIFF <폴더>/<순번>#<n> bytes@<offset> (len A= B=): A="…" B="…"`** + `keys A/B`·`only-in-A/B` — 첫 차이 바이트 주변 64자와 키 집합 차이를 보여 준다. 길이가 같고 offset 이 2 면 키 순서다(Q2).
4. `--keep`/`--out-dir` 로 남는 것: `node.json`·`spring.json`(폴더·파일명·순번·바이트 수·sha256 — 본문 없음)·`diff.json`·`*-boot.log`(경로는 `<tmp>`/`<repo>` 로 가림) · `--keep` 이면 스풀 파일 원본까지.
5. 자기검사 red 면 자리표시자 집합·정합 단언·시나리오 표본 중 하나가 바뀐 것이다 — 하네스는 그 상태로 서버를 띄우지 않는다(Q6·Q7).
6. `Spring 실행 jar가 없다`·`Unresolved compilation problem` — 무효 jar(§2-6 6항). **이 step 실측**: `clean package` 조차 IDE 언어 서버가 `target/classes` 를 건드리는 순간
   `class file for List not found` 로 테스트 컴파일이 죽는다(7회 중 1회) — 재빌드 1회로 해소되고 회귀가 아니다.
7. `--db mysql` 에서 `NEWS_CT_MYSQL_PASSWORD 가 최소 길이 … 못 미친다` 경고는 실행을 막지 않는다(§3 · 사용자 실행 항목 U2).

### 4-7. 변이 결과표 (2026-09-07 · Java 변이는 심기 → `clean package` → 대조 → `git checkout` 원복 → pristine 사본과 `cmp` 동일 → 마지막에 재빌드 · 기대≠실제는 굵게)

| # | 심은 것 | 기대 | 실제 | 원복 |
|---|---|---|---|---|
| Q1 | Java `CONTENTS_FIELDS` 에서 `keyword` 제거 | 그 키가 있는 파일에서 diff | **diffs 8/11**(ga 2·ra 3·ma 3 — `keyword` 없는 na·da 는 0) · `only-in-A=[keyword]` · 길이 401→381 | cmp 동일 |
| Q2 | Java `payload()` 에서 `markupVersion` 루프를 앞으로 | 전 파일 diff | **diffs 11/11** · 전건 `bytes@2` · **길이 동일**(401/401 …) — 순서만 바뀐 산출물은 길이·의미로는 안 보인다 | cmp 동일 |
| Q3 | Java `MAPPER` 에서 `LowercaseHexEscapes` 제거 | (마) 파일에서만 diff | **diffs 3/11** — (마) 3파일 `\u001B`↔`\u001b`(길이 710 동일). **함정 확인**: 이 표본이 없었다면 0 = 무해 | cmp 동일 |
| Q4 | Java pick 의미론 뒤집기(null 이어도 키 유지) | 전 파일 diff | **diffs 11/11** · `"coAuthor":null,"category":null…` 이 끼어 길이 336→505 등 | cmp 동일 |
| Q5 | Java allowlist 에 `internalComment` 추가(보안 축) | 그 값이 있는 파일에서 diff | **diffs 5/11**(ga 2·ma 3) · `only-in-B=[internalComment]` · **새 키 증가를 잡는다**(집합 비교가 아니라 바이트 비교라 allowlist/blacklist 구분이 필요 없다). 표본이 비어 있었다면 0 | cmp 동일 |
| Q6 | 대조기 `PLACEHOLDER_KEYS` 에 `title` 추가 | 자기검사 red · 우회하면 제목 차이가 조용히 통과 | (a) **자기검사 red → 하네스 기동 거부**(집합 단언 + 「제목 안 글자 무접촉」·「6/6 tally」·「\uAC00 표본이 title 에 있음」 ·「자리표시자 밖 키의 값 차이」 **4곳**이 더 red = 5건(원문의 "3곳"은 오기 — 2026-09-08 리뷰 후속 정정) — 게이트를 우회하려면 자기검사 **9곳** 을 고쳐야 했다. 2026-09-08 재측정: 「formatCounts 6/6」이 더해져 red **6건**). (b) 우회한 채 **제목만 바꾼 Spring 변이**(`title + " "` · 정상 대조기로는 diffs 11/11)를 돌리면 **diffs 0 · exit 0 = 공허화 실증** — 남는 흔적은 `눈감은 자리 66→77` 뿐 | 판정부 `git checkout` |
| Q7 | Java 파일명 stamp = `distributedAt`+1ms(페이로드는 그대로) + 대조기 정합 단언 제거 | 정상 대조기는 정합 실패 · 단언 없으면 통과 | (a) 정상 대조기: **`FAIL [spring] … 파일명 stamp(…164Z)가 distributedAt(…162Z)와 정합하지 않는다` ×11**(node 0) · 바이트 비교 전 중단. (b) 단언 제거 → 자기검사 red → 기동 거부. (c) 자기검사도 우회 → **diffs 0 · FAIL 0 · exit 0 = 2겹째가 하중을 진다** | cmp 동일 · 판정부 checkout |
| Q8 | 드라이버에서 Spring 스풀 루트 = Node 스풀 루트 | 즉시 실패 | (a) 조립 가드가 **기동 전** 거부(`두 서버의 DIST_SPOOL_DIR 이 같다 — 짝짓기가 붕괴한다(조립 거부)` · exit 1). (b) 가드를 지우면 Spring 재생이 (라)에서 **`EISDIR`**(Node 가 이미 만든 `sp-retry` 디렉토리 자리에 차단 파일을 쓰려다) 로 죽어 `비교 불가` exit 1 — 판정부의 「순번 표 밖 articleId」 검사까지 가지도 않는다(그 검사는 자기검사가 잠근다) | 드라이버 checkout |

**추가 실측 — Q1·Q2·Q5 를 한 jar 에 함께 심은 채**: `spool-parity.mjs` **diffs 11/11**(exit 1) · `spring-contract.mjs --parity` **313관측 diffs 0**(246·55·4·5·3 — exit 0) ·
`npm test` **1328 중 1326**(2 fail 은 아래 §4-8 의 `bad port` 플레이크 — Java 변이와 무관 · 같은 트리에서 재실행 **1328/1328**) · Java `SpoolWriterTest` 단독 **23 중 6 red**(`thePayloadIsTheAllowlistInTheAssemblyOrder`·`internalCommentAndLockColumnsNeverLeaveTheServer`·
`thePayloadIsByteIdenticalToTheNodeWriter` 등 — **기대≠실제**: 계획은 "backend 테스트도 못 본다"였지만 Java 자기 기대값 테스트는 잡는다).
⇒ 확정 문장은 이렇게 좁아진다: **계약(`--parity`)은 스풀 바이트를 구조적으로 못 본다(313 diffs 0 그대로)** · Node `npm test` 는 Java 를 볼 수 없다(구조) ·
Java `SpoolWriterTest` 는 **자기 기대값** 위반은 잡지만 **Node 산출물과 대조한 적이 없다** — Node `spoolWriter.js` 가 바뀌면 그 테스트도 계약도 green 인 채 두 산출물이 갈리고,
그것을 보는 자리는 `spool-parity.mjs` 뿐이다.

**3종만 눈감았을 때(계획 원안)**: 11쌍 전부 diff · 첫 차이 자리 `createdAt` 11/11 · `createdAt`·`sentAt` 을 지우면 전부 동일 — §4-3 의 근거.
**자기 결정성**: sqlite 연속 2회 요약 줄 동일(`폴더 3 · 파일 11 · diffs 0 · 66/66`) · mysql 축 동일 수치(`harness_ct_ca8e89aaa1c14814` 적재 3.1s → 드롭 · 실행 후 `harness_ct_*` 잔존 0).
실행 전후 리포 `news.db` md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` 무변 · 자식 프로세스·임시 디렉토리 잔존 0(실패 실행은 진단용으로 보존 — 변이 실험 뒤 직접 지웠다).

### 4-8. 이 step 이 잡은 환경 함정 — `npm test` 의 `fetch failed: bad port` (회귀가 아니다)

변이 실험 중 `npm test` 가 세 번 연속 **서로 다른** 통합 케이스에서 1~3건씩 죽었다(`spa-serving` B7/B8 · `editLock` · `session-revalidation` 회귀 7 · `sse-reauth` 회귀 6/9 — 전부
`TypeError: fetch failed / cause: Error: bad port`). 원인: 이 머신의 Windows 는 ephemeral 포트를 **순차**로 내주고(실측 `6819,6820,…`), 하네스 실행이 수천 개 포트를 소비해 카운터가
fetch 표준의 **차단 포트 묶음**(`6000` · `6566` · `6665~6669` · `6697` · `10080`)을 지나던 중이었다 — `listen(0)` 으로 뜬 테스트 서버가 그 포트를 받으면 undici `fetch` 가 **접속 전에** 거부한다.
카운터를 10080 뒤로 보내고(3,208 포트 소진 · `6834 → 10100`) 재실행하니 **1328/1328**. 처방: 재실행(카운터가 지나간다) 또는 위 소진 — **코드를 고칠 일이 아니다.** 하네스 4종의 포트
구간([15000,20000)·[45000,49152)·[20000,35000))은 차단 목록 밖이라 이 함정을 맞지 않는다.

### 4-9. 리뷰 후속 (2026-09-08 · 읽기 전용 리뷰 발견 11건 → fix 커밋 1개 · 자기검사 **17 → 21** · 게이트 재실행 없음 — `server-spring/**`·`contract/**`·`server/**`·`src/**`·`test/**` 무접촉)

| # | 발견(미검증 주장) | 코드로 확인 → 처리 | 실측 |
|---|---|---|---|
| 1 | `assertOutsideRepo` 가 win32 에서 대소문자 구분 — `d:\agents\harness\…` 소문자 드라이브가 `startsWith` 를 통과 | **사실**(`path.resolve` 는 드라이브 문자 대소문자를 보존) → 순수 `pathIsInside`(win32 대소문자·구분자 무시 · posix 구분) + `--out-dir` 가드를 mkdtemp **앞**으로(거부 경로에 `spool-parity-*` 잔존 0) | 수정 전 재현 `lowerGuardHits=false` → 수정 후 `--out-dir d:\agents\harness\tmp-reports` **exit 1** · 리포 안 생성 0 · 임시 디렉토리 잔존 0 |
| 2 | finally 에서 기동 로그 쓰기·kill 이 드롭보다 앞이고 미격리 → throw 시 `harness_ct_*` 잔존·md5 단언 누락 | **사실** → 순서 5-a 자식 종료 → 5-b md5 단언·드롭 → 5-c 로그 기록 · 항목마다 try/catch(실패는 failures) · 드롭은 자식을 죽인 **뒤**(연결을 쥔 채 DROP 하지 않는다) | 5-a·5-c 에 throw 를 심고 `--db mysql` → **드롭 실행**(`harness_ct_31c9…`) · `FAIL … planted-5a`·`planted-5c`×2 · exit 1 · `harness_ct_*` 0 · 원복 md5 동일 |
| 3 | spawn 자식에 `'error'` 리스너 없음(ENOENT/EACCES → uncaught → finally 미실행) | **사실** → 서버 2·마이그레이터 spawn 에 리스너: failures 기록 + `spawnError` 로 죽은 것으로 판정(`childDead`) · `spring-contract.mjs` 도 리스너가 **없어** 베낄 "동형"이 없었다(그 파일은 무수정) | 정적 — javaBin·jar 는 존재 검사를 지나므로 남는 경로는 EACCES 류뿐(재현 안 함) |
| 4 | SIGINT 경로가 임시 DB 를 드롭하지 않음 | **사실** → 자식 SIGKILL 뒤 마이그레이터 `ephemeral-drop` 을 **spawnSync**(60s) — 성패만 stderr | Spring 기동 중 **실제 CTRL_C**(`GenerateConsoleCtrlEvent` — win32 는 `process.kill(pid,'SIGINT')` 로는 핸들러가 안 돌고, "Ctrl+C 무시" 플래그가 자식에 상속되므로 launcher 가 켜서 띄워야 한다) → `warn 중단 — 임시 MySQL DB 드롭 완료: harness_ct_f30c…` · 0.7s 후 종료 · `harness_ct_*` 0 · java 0 |
| 5·9 | (마) 저장 왕복 단언이 코드에선 송고 **뒤** · 문서·summary 는 "송고 전" | **사실** → 코드를 송고 **전**으로(문서 문구 유지 = 코드) | sqlite·mysql 양 축 **3 · 11 · 0 · 66/66** 그대로 |
| 6 | 순번 표가 plain object — `constructor`·`toString` articleId 가 상속 함수로 잡혀 "표 밖" 실패를 우회 | **사실**(파일명 문법이 그 이름을 허용) → `lookupStep`(own property + 문자열만) · `stepsByArticle` 은 null-proto | 자기검사 red(`constructor`·`toString`·`hasOwnProperty`·`__proto__`) → green |
| 7 | 자리표시자 raw 표기 미단언(역슬래시-u0041 류 변형이 눈감김) | **사실** → ⑤ raw == `JSON.stringify(값)` 단언(§4-3) | 자기검사 red(u0032·u002d·u0054 변형 3건 + 비교 경로) → green |
| 8 | 제어문자 9자 중 1자만 자기검사가 잠금 | **사실** → 9자 **전부** 집합 단언 | 계획에서 U+000E 제거 → red(`0x0E 가 없다`) → 원복 green |
| 10 | 요약 줄 판정 2개 · 비교 불가 경로의 수치 부재 미명시 | **사실** → `formatCounts` + 종합 판정 **하나**(§4-1 = 코드) | `… 눈감은 자리 A=66 B=66 db=mysql → ok` |
| 11 | Q6 행 "3곳이 더 red" | **사실**(4곳 = 5건) → §4-7 정정 · 재측정 6건 | `title` 추가 → red 6(1·4·9·11·12·19) · 원복 동일 |

## 5. FTP 수집의 앱 밖 대체 경로 (`tools/collection-sweeper/` — step6 · 로드맵 P3 산출물 (마))

> **한 줄**: Spring 에는 Node 의 FTP 스풀 watcher(`server/ftpWatcher.js` · `fs.watch(recursive)`)가 **없다**(`WatchService`·`RCV_SPOOL` 철자 0건 — ADR-008
> "앱은 스스로 깨어나지 않는다"). 그 자리를 **앱 밖 스위퍼** `tools/collection-sweeper/sweeper.js` 가 맡는다: `<RCV_SPOOL_DIR>/<sourceId>/<file>` 을
> **1회** 훑어 각 파일을 동결된 HTTP 진입점 `POST /api/collection/receive` `{sourceId, payload:<파일 내용 그대로>}` 로 넣는다 — watcher 가 부르던
> `controllers.collection.receive(sourceId, payload)` 와 **같은 서비스 진입점**이고, 배부 tick(외부 cron pull)과 정확히 대칭이다. `server-spring/src/main` 은
> **0줄** 바뀌었다(이 step 의 핵심 AC · `Adr008DisciplineTest` 의 '주기 실행'·'비동기·재시도' 예외 0 그대로).
>
> **분기 기록(step6.md 필수)**: §0-5묶음 첫 행 = **「쓴다」**(사용자 답변 · 2026-09-05 · §0-2 Q1). 따라서 **이 step 은 컷오버의 필수 선행이다** —
> Spring 기동과 **같은 정지 창 안에서** 스위퍼 등록까지 끝나야 하고(step10 런북 순서), 「Node 은퇴 전제」로 내려가는 분기는 택하지 않았다.
> 정확한 `RCV_SPOOL_DIR` 값·유입 주기·외부 FTPd 주체는 아직 **미상**이며 운영기에서 읽는다(step7·step10 사용자 항목) — 이 step 은 그 값 없이 구현·검증했다
> (스위퍼는 폴더 경로를 인자로 받고, 검증은 전부 리포 밖 임시 폴더에서 했다).

### 5-1. 실행

```bash
# 스위퍼 본체 — 토큰은 환경변수 COLLECTION_TOKEN 으로만(서버와 같은 값 · argv 에 토큰 모양이 오면 exit 2)
COLLECTION_TOKEN=<서버와 같은 값> node tools/collection-sweeper/sweeper.js --spool <RCV_SPOOL_DIR> --base http://127.0.0.1:3001 --once \
    [--move-to <처리완료 폴더 — 스풀 밖>] [--dry-run] [--ledger <파일>] [--stabilize-ms 1000] [--timeout 15000] [--report <리포 밖 JSON>]
node --test tools/collection-sweeper/sweeper.test.js                                                     # 순수 판정부 + 파일 루프(sweepOnce 주입) + 소스 정적 스캔(28)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node tools/collection-sweeper/roundtrip.js             # Node vs Spring 왕복 대조 · exit 0
node tools/collection-sweeper/roundtrip.js --overlap                                                       # Node watcher + 스위퍼 같은 스풀 — 중복 실측
```

**종료코드 규약** — `0` 전건 성공 **또는 처리 0건** · `1` `rejected`(4xx 사유 토큰 — 최종 · 재시도 안 함) 또는 `failed`(401·503·5xx·네트워크 — **다음 실행이 재시도**)가
1건 이상 · `2` 설정·환경 오류(인자·스풀 없음·서버 미도달·장부 못 씀·argv 토큰 · **파일을 건드리지 않았다**). 스케줄러는 `1`·`2` 를 경보 조건으로 건다.
**파일별 결과** = `ingested` / `rejected` / `failed` / `skipped`(장부에 있음) / `deferred`(크기·mtime 이 아직 변한다 — 다음 실행에) / `dry-run` / `ignored`(최상위 = sourceId 없음).
**장부** = `<spool>/.collection-sweeper-ledger.jsonl`(기본 · append 전용 JSON Lines · 키 = `상대경로#sha256`) — 스풀 **최상위**라 1세그먼트 = watcher·스위퍼 모두 무시하는 자리다.
`--ledger` 로 옮길 수 있되 **전송 전 preflight** 로 쓸 수 있는지 보고, 못 쓰면 한 건도 보내지 않는다(장부 없는 기사 = 다음 실행의 중복).
**`--move-to`** 는 성공(ingested)한 파일만 `<dir>/<sourceId>/<file>` 로 **이동**(덮어쓰기 없음 · 같은 이름이면 `.<ms>.dup` 접미사 · 다른 드라이브면 복사 후 지문 일치 확인 뒤 원본 정리)
하고, **스풀 안은 거부**한다 — 스풀 안으로 옮기면 `<spool>/<done>/<sourceId>/<file>` 이 2세그먼트 이상이라 다음 스캔(과 롤백 시 Node watcher)이 **다시 수집**한다.
장부는 `--move-to` 와 무관하게 **항상** 쓴다(이동 실패·장부 어느 한쪽이 무너져도 멱등이 남는다). **스위퍼는 파일을 지우지 않는다.**

### 5-2. 무엇이 갈리는가 (divergence — 더 나은 쪽이라도 적는다)

| 축 | Node watcher (`server/ftpWatcher.js` 48줄 · 무수정) | 스위퍼 (`tools/collection-sweeper/`) | 실측 |
|---|---|---|---|
| 깨어남 | `fs.watch(dir,{recursive:true})` 이벤트 — 파일이 떨어지면 **즉시** | **외부 스케줄러가 정한 주기**(1회 실행 = 1회 스캔 · 자체 루프·타이머·감시 0 — 정적 스캔 15패턴) | 수집 지연 = 스케줄 주기(권장 1분) |
| sourceId 도출 | `split(/[/\\]/).filter(Boolean)` · 2세그먼트 미만 무시 · `parts[0]` | **동형**(`lib.js deriveSourceId` · 단위 R1·R2) | 왕복 `nested/04-deep.txt` → `rt-src-a` 양쪽 동일 · 최상위 `10-toplevel.txt` 양쪽 `ignored` |
| 부분 파일 방어 | **없다** — 이벤트마다 곧바로 `readFile` | 크기·mtime 이 `--stabilize-ms`(기본 1000) 간격의 **연속 2회 관측에서 동일**할 때만 읽는다(아니면 `deferred`) | `--overlap`: 한 번의 `writeFileSync` 에 watcher 가 **3건** 등록(rename+change 다중 이벤트 · 이번엔 셋 다 전문이었지만 빈 제목이 나올 수 있는 구조) |
| 중복 판정 | **없다** — 이벤트 수만큼 `receive` 호출. 수집 서비스도 중복 판정이 없다(`unregistered`·`inactive` 뿐 — Node·Spring 동일) | 장부(`상대경로#sha256`) — 같은 파일 재실행은 `skipped` · 같은 이름에 다른 내용은 새 파일 | 왕복 pass2 `ingested 0/0` · 01-plain 기사 **1건** 유지 · R3(장부 제거)로 **2건** 실측(§5-7) |
| 파일 처분 | 아무것도 안 함(FTPd·운영이 치운다) | **삭제 금지** — 장부 + 선택 `--move-to` 이동 | 왕복 검증 절차 3: pass1·pass2 후 픽스처 10파일 전부 제자리 |
| 실패 격리 | 파일 단위 `catch` → `onError` 로그 · watcher 는 산다 | 파일 단위 `catch` → `failed` · 다음 파일 계속 · 장부 못 쓰면 **exit 2 로 멈춤**(환경 실패는 격리 대상이 아니다) | R4b(첫 실패 중단) 왕복 red(§5-7) |
| 로그 | `collection ftp received sourceId=…` / `warn … reason=…` · payload 0 | stdout `[sweep] <rel> sourceId=… → ingested articleId=…` · stderr `rejected/failed reason=…` · payload·토큰 0 · `--report` JSON 도 동일 | 왕복이 출력·장부·리포트에서 토큰 부재 단언 |
| 무효화 신호 | watcher 가 `notifyChange('create')` | HTTP 경로라 `CollectionController` 가 `ChangeBus.CREATE` 발행(Node 라우트 1090행 동형) — **동일** | — |
| **거대 파일** | HTTP 를 거치지 않아 **상한 없음** | Spring `JsonHttp.readBody` **상한 없음 → 200** · **Node HTTP 는 전역 `express.json()` 100kb → 413 → 전역 핸들러 500 `internal-error`** | 왕복 `07-huge-150k.txt`: node `failed:internal-error@500` / spring `ingested@200` — **허용 divergence 1건**(관측되지 않으면 실패) |
| 런타임 | 서버 exe 안(SEA · Node 내장) | **Node 런타임이 필요하다**(≥ 24 · `node:sqlite` 불필요 · 의존성 0 — `tools/collection-sweeper/` 두 파일 `sweeper.js`·`lib.js` 만 복사) | 운영기에 Node 가 없으면 설치 항목이 하나 는다(§5-3) |

거대 파일 행의 뜻: 스위퍼→**Spring** 은 watcher→Node 와 **같은 쪽**(상한 없음)이고, 갈리는 것은 대조군 스위퍼→Node 뿐이다. 이 100kb 경계는 `JsonHttp` javadoc 이 이미 "어떤 계약도 관측하지 않아
조용히 갈린다"고 적어 둔 기존 divergence 이며, 이번 왕복이 그것을 **수치로** 처음 봤다. 운영에서 스위퍼는 Spring 만 향한다 — Node 를 향해 돌리지 마라(그건 watcher 가 하는 일이다).

### 5-3. 설치·등록 (작업 스케줄러) — step10 런북이 이 절을 인용한다

1. 운영기에 Node 런타임(v24 권장)이 있는지 확인. 없으면 설치한다(**서버 exe 는 Node 를 내장하지만 그것을 스위퍼가 빌릴 수는 없다**).
2. `tools/collection-sweeper/sweeper.js`·`lib.js` 두 파일을 운영 폴더(예: `D:\기사작성기-server\tools\collection-sweeper\`)에 복사한다. 리포 전체는 필요 없다.
3. `COLLECTION_TOKEN` 은 **작업의 실행 계정 환경변수(사용자 변수) 또는 서비스 환경**에 둔다 — bat·ps1·작업 인자에 평문으로 두지 마라(argv 는 프로세스 목록·스케줄러 이력에 남는다.
   스위퍼는 argv 에 토큰 모양이 오면 **실행을 거부**한다). 값은 Spring 의 `COLLECTION_TOKEN` 과 같아야 한다(다르면 전건 `failed:unauthenticated` · exit 1).
4. 래퍼 `collection-sweep.cmd`(토큰 없음):
   ```bat
   @echo off
   node "D:\기사작성기-server\tools\collection-sweeper\sweeper.js" --spool "<RCV_SPOOL_DIR>" --base http://127.0.0.1:3001 --once ^
        --move-to "D:\기사작성기-server\data\rcv-done" --report "%TEMP%\collection-sweep-last.json"
   exit /b %ERRORLEVEL%
   ```
5. 등록(1분 주기 · 실행 계정 = 3 의 환경변수를 가진 계정):
   ```bat
   schtasks /Create /TN "기사작성기-collection-sweep" /SC MINUTE /MO 1 /TR "D:\기사작성기-server\collection-sweep.cmd" /RU <계정> /F
   ```
   같은 스풀에 이 작업을 **하나만** 둔다(두 개면 장부 append 경합 — 파일 하나가 두 번 들어갈 수 있다). 스케줄러의 "이미 실행 중이면 새 인스턴스를 시작하지 않음" 을 켠다.
6. 첫 실행은 `--dry-run` 으로 — 후보 수·`ignored` 수·`deferred` 수를 보고 폴더 레이아웃(`<spool>/<sourceId>/<file>`)이 `docs/RCV.md` 와 맞는지 확인한다.
7. 관측: 종료코드 `1`·`2` 를 경보로, `--report` JSON 의 `counts` 를 대시보드로. 장부는 지우지 않는다(지우면 스풀에 남은 파일이 전부 다시 들어간다 — `--move-to` 를 쓰면 이 위험이 사라진다).

### 5-4. 운영으로 넘어가는 책임

Node 시절 앱 안에 있던 「깨어남·중복 방지 없음·실패 로그」가 전부 **운영 루틴**으로 나온다: **주기**(스케줄러) · **멱등**(장부/이동 — 장부 파일과 `--move-to` 폴더의 보존) ·
**실패 감시**(exit 1/2 경보 · `failed` 는 자동 재시도되지만 `rejected` 는 장부에 최종으로 남아 **다시 시도되지 않는다** — 미등록 sourceId 를 뒤늦게 등록해도 그 파일은 장부 줄을 지우거나 파일을
새 이름으로 다시 놓아야 들어간다) · **감시**(스케줄러 이력). 배부 tick 을 운영이 소유하는 것과 같은 규율이다(ADR-008 (3)).

### 5-5. 롤백 순서 — **스위퍼를 먼저 끈다**

**Node 로 되돌리면 `RCV_SPOOL_DIR` 이 설정된 Node 가 watcher 를 되살린다. 그 상태에서 스위퍼 작업이 살아 있으면 같은 파일이 두 번 들어간다 — 반드시 `schtasks /Change /TN "기사작성기-collection-sweep" /DISABLE`
(또는 `/Delete`)로 스위퍼를 먼저 끄고, 그 다음에 Node 를 올려라.** 반대로 컷오버 때는 Node 를 내린 **뒤** 스위퍼를 켠다. 이 순서를 어기면 어떻게 되는지 잰 것이 아래다.

**실측(`roundtrip.js --overlap` · 2026-09-08 · Node 를 `RCV_SPOOL_DIR=<임시 스풀>` 로 띄우고 같은 스풀에 스위퍼)**: 파일 **1개**(`rt-src-a/overlap.txt`) → Node watcher **3건**
(Windows `fs.watch` 가 rename+change 이벤트를 셋 내고 watcher 는 중복 판정이 없다 — 셋 다 제목 일치 · 빈 제목 0) + 스위퍼 **1건** = **자동기사 4건**. 즉 겹치는 순간 최소 2배이고, Node watcher 는 혼자서도
파일당 여러 건을 만든다(이것이 Node 시절부터 있던 성질이며 스위퍼는 그것을 고치지 않는다 — 고칠 자리는 `server/**` 이고 이 phase 는 그것을 만지지 않는다).

### 5-6. 왕복 대조 (`roundtrip.js` · 2026-09-08 · Node·Spring 각각 임시 `DATA_DIR`·같은 시드·같은 난수 토큰 · loopback · 수신 설정 `rt-src-a`(Y)·`rt-src-inactive`(N) 을 Z 세션으로 등록)

| 파일 | node | spring | 투영(title·attribute·status·format·version·blocks) 동일 | 판정 |
|---|---|---|---|---|
| `rt-src-a/01-plain.txt` (첫 줄 제목 · 2줄 본문) | `ingested@200` | `ingested@200` | yes | same |
| `rt-src-a/02-object.json` (JSON **텍스트** — 문자열 payload 는 판독하지 않는다 · 첫 줄이 통째로 제목) | `ingested@200` | `ingested@200` | yes | same |
| `rt-src-a/03-empty.txt` (0 B → 빈 제목 · 블록 `['']`) | `ingested@200` | `ingested@200` | yes | same |
| `rt-src-a/nested/04-deep.txt` (중첩 → sourceId `rt-src-a`) | `ingested@200` | `ingested@200` | yes | same |
| `rt-src-a/05-crlf.txt` (선행 빈 줄 2 · CRLF · 제목 양끝 공백) | `ingested@200` | `ingested@200` | yes | same |
| `rt-src-a/06-unicode.txt` (한글·이모지·탭·백슬래시·ESC·VT·U+2028·`<>&`·DEL·따옴표) | `ingested@200` | `ingested@200` | yes | same |
| `rt-src-a/07-huge-150k.txt` (150 KiB) | **`failed:internal-error@500`** | **`ingested@200`** | no | **expected-divergence**(§5-2) |
| `rt-src-inactive/08-inactive.txt` | `rejected:inactive@403` | `rejected:inactive@403` | yes | same |
| `rt-unregistered/09-unregistered.txt` | `rejected:unregistered@403` | `rejected:unregistered@403` | yes | same |
| `10-toplevel.txt` (최상위) | `ignored` | `ignored` | — | same |

수치: **파일 9 · diffs 0 · 허용 divergence 1 · pass1 exit 1/1**(거부 2건이 의도된 픽스처) · **pass2 `skipped` node 8 / spring 9 · ingested 0/0 · 기사 6/7 불변 · 01-plain 기사 1건** · `--dry-run` 전송 0·장부 없음 ·
`--move-to` 스풀 안 거부(exit 2)·이동 후 스풀에 없음·`done/rt-src-a/m1.txt`·재실행 ingested 0 · argv `--token` exit 2 + 출력·장부에 값 0 · 장부를 디렉토리로 주면 exit 2 + 전송 0 · 픽스처 10파일 미삭제 ·
실행 전후 리포 `news.db` 무변 · 자식 잔존 0 · 임시 디렉토리 삭제. 요약 줄: `collection-sweeper roundtrip A=node B=spring 파일 9 · diffs 0 · 허용 divergence 1 · pass2 ingested node=0 spring=0 · 기사 node=6 spring=7 → ok`.
**Node 대상 pass2 가 exit 1 인 이유**는 `07-huge` 가 `failed`(재시도 대상)라 매 실행 다시 실패하기 때문이다 — 이것이 "failed 는 재시도" 규약의 실물이다.

### 5-7. 변이 결과표 (2026-09-08 · 러너가 심기 → `node --test` → 왕복 → `git checkout --` 원복 → `git diff --stat` 0줄 확인 · 기대≠실제는 굵게)

두 번 쟀다: **1차**(`f73bb60` — 루프가 `sweeper.js` 안에 있던 판)와 **2차**(`c926d63` — 루프를 `lib.js sweepOnce` 로 뽑고 단위 6건을 더한 최종 판). 1차에서 **R4a 가 green 으로 남은 것**이 2차의 이유다.
왕복 하네스는 자기검사가 빨간 채로는 서버를 띄우지 않으므로, 단위가 red 인 변이의 "왕복" 칸은 **기동 거부**다(방어선이 앞에서 닫혔다는 뜻이며 관측 부재가 아니다).

| 변이 | 심은 것 | 기대 | 실제 (1차 · 2차) | 원복 |
|---|---|---|---|---|
| **R1** 백슬래시 구분자 제거 | `lib.js` `split(/[/\\]/)` → `split('/')` | 단위 red(Windows 경로) | 단위 **red 4**(`deriveSourceId` 백슬래시 · `splitSegments` · `planScan` `b\sub\y` · `ledgerKey` 정규화) → 왕복 기동 거부. 왕복만으로는 못 본다(`listFiles` 가 `/` 로 조립한다) — 단위가 유일 방어선 | `git checkout` · diff 0 |
| **R2** 2세그먼트 미만 무시 제거 | `parts.length < 2` → `< 1` | 최상위 파일이 sourceId 없이 전송돼 실패/오동작 | 단위 **red 2**(`deriveSourceId` null · `planScan`) → 왕복 기동 거부. **런타임 실측(자기검사를 거치지 않는 단독 측정 스크립트 · Node 임시 서버)**: `toplevel.txt` 가 `sourceId=toplevel.txt` 로 전송돼 **403 `unregistered` → rejected → 장부에 최종 등재(재시도 없음) · exit 1**. 기준선(무변이)은 `ignored 1 · ingested 1 · exit 0` | diff 0 |
| **R3** 멱등 장부 제거 | `const prior = done.get(key)` → `undefined`(1차) / `deps.ledgerHas(key)` → `null`(2차) | 재실행이 같은 파일을 다시 넣는다 — **기사 2건인지 실측** | **1차 왕복 red**: pass2 `ingested` node 6 / spring 7 → 기사 **6→12 · 7→14** · **`01-plain` 기사 2건**(양쪽) · `FAIL pass2 skipped 0 ≠ 8/9`. **수집 서비스는 중복을 막지 않는다 — 같은 파일 2회 = 기사 2건**(Node·Spring 동일 · 예상대로). 2차: 단위 `sweepOnce` skipped 케이스 red 1 → 왕복 기동 거부 | diff 0 |
| **R4a** 예외 격리 제거(첫 예외에서 중단) | `catch` 에서 무조건 `throw err` | 뒤 파일이 처리되지 않는 테스트 red | **1차: 단위 green · 왕복 green — 못 잡았다**(왕복 픽스처 9건 중 예외를 던지는 것이 없다 — 거부·실패는 전부 HTTP 값이다). → 2차: 루프를 주입형 `sweepOnce` 로 뽑고 "첫 파일 읽기 예외 → 둘째 처리" 단위를 추가 → **red 1**(`sweepOnce — 첫 파일 읽기가 예외를 던져도 둘째 파일은 처리된다`) | diff 0 |
| **R4b** 거부/실패에서 중단 | `classifyResponse` 뒤 `if (outcome !== 'ingested') break` | 뒤 파일 미처리 red | 1차 왕복 **red**(절대 기대치: `pass1 결과 node 6 / spring 8 ≠ 후보 9 — 뒤 파일이 처리되지 않았다`. 대조만으로는 못 봤을 변이 — 두 서버가 같은 방향으로 틀린다). 2차: 단위 `sweepOnce — 거부/실패여도 다음 파일` red 1 | diff 0 |
| **R5** 토큰을 argv 로 | 가드 `findTokenLikeArgv` 호출 제거 + `--token` 플래그 수용 + env 대신 argv 값 사용(4곳) | 비밀 위생 게이트/리뷰가 잡는가 | **리포 게이트는 못 잡는다 — 공백**: `SecretHygieneTest` 는 Java 전용, `scripts/**` 는 eslint ignore, `tools/**` 를 훑는 정적 게이트가 없다. 자체 가드가 잡는다: 단위 `정적 스캔 — 토큰을 argv 에서 읽지 않고 env 이름 한 곳에서만` **red 1**(`findTokenLikeArgv(` 배선 단언) → 왕복 기동 거부(무변이 왕복은 `--token <값>` → exit 2 + 출력·장부에 값 0 을 매번 단언한다) | diff 0 |
| **R6a** `setInterval` 상주 루프 | 파일 끝에 `setInterval(() => {}, 60000)` | 정적 스캔 red | **red 1** `sweeper.js:285 'setInterval'` → 왕복 기동 거부(스캔이 앞에서 닫는다) | diff 0 |
| **R6b** 상수 조립 우회 | `globalThis['setInt' + 'erval'](...)` | 스캔이 이름을 못 보면 통과할 것 | **red 1** — `'dynamic global lookup'`(`globalThis[`) 패턴이 통로를 막는다 | diff 0 |
| **R6c** 동적 import 우회 | `await import('node:' + 'tim' + 'ers/promises')` | 이름이 쪼개져 통과할 것 | **red 1** — `'dynamic import'`(`import(`) 패턴(1차의 `'timers/promises'` 리터럴은 `'timers module'` 이 먼저 잡았다) | diff 0 |
| **R6d** 별칭 대입 | `const every = setInterval;` (호출 없음) | `\(` 을 요구하는 스캔이면 통과할 것 | **red 1** — 낱말 단위(`\bsetInterval\b`) 스캔 | diff 0 |

읽는 법: 이 step 의 방어선은 **단위(순수 판정부 + 정적 스캔) → 왕복(절대 기대치 + 대조 + 허용 divergence 비공허성) → 런타임 단독 측정** 세 겹이고, 앞 겹이 닫히면 뒤 겹은 돌지 않는다. **R4a 1차 green** 은 "왕복이 잡는다"는
가정이 픽스처의 한계로 거짓이었다는 실측이고, 그래서 격리 규칙을 **단위가 소유**하도록 구조를 바꿨다(decisions (12)·(13)). 리포 차원의 R5 공백(`tools/**` 비밀 위생 게이트 없음)은 남는다 — 스위퍼 자체 가드 + 왕복 단언으로 닫았고, 리포 전역 게이트는 이 step 범위 밖이다.

### 5-8. 이 step 이 잡은 함정·발견 (전부 실측)

1. **`process.exit()` + 살아 있는 fetch 소켓 = Windows libuv 단언 크래시**(`src\win\async.c:94 !(handle->flags & UV_HANDLE_CLOSING)` · exit `0xC0000409`). 왕복 첫 실행에서 스위퍼 자식이 두 번 죽었다(판정은 옳았고
   종료 직전에 죽었다). 처방: 요청에 `connection: close` + `process.exitCode` 자연 종료(`process.exit` 0건). 스위퍼는 타이머·감시가 없으니 자연 종료가 곧 즉시 종료다.
2. **`fs.watch(recursive)` 에 8.3 짧은 경로를 주면 Node 서버가 통째로 죽는다**(`src\win\fs-event.c:72 !_wcsnicmp(filename, dir, dirlen)`). `os.tmpdir()` 이 `JUNGJA~1` 형태를 준 첫 `--overlap` 실행에서 실측 —
   하네스는 `fs.realpathSync.native` 로 풀었다. **운영 함정**: 롤백 시 `RCV_SPOOL_DIR` 을 짧은 경로(`%TEMP%` 파생·`PROGRA~1` 등)로 주면 Node 가 기동 직후 죽는다. 런북 롤백 절에 넣어라(step10).
3. **Node watcher 는 파일 1개에 3건**을 만든다(§5-5) — Node 시절부터의 성질. 스위퍼는 장부로 자기 쪽 중복만 막는다.
4. Node HTTP `/api/collection/receive` 의 100kb 상한(§5-2) — Spring 은 없다. 운영 스위퍼는 Spring 만 향한다.
5. `tools/**/*.mjs` 는 eslint 가 node 전역 없이 훑어 `no-undef` 21건이 난다(`scripts/**` 는 ignore · `**/*.js` 만 node 전역). 그래서 이 도구는 `.js`(package `type: module`)다 — `eslint.config.js`·`package.json` 무수정.

### 5-9. 무엇을 보지 않는가

- 실제 외부 FTPd 와 그 쓰기 방식(임시 이름 → rename 인지, 제자리 쓰기인지) — 안정화 간격(기본 1초)의 적정치는 운영 유입을 보고 정한다(step7·10).
- LAN 바인딩 + 토큰 미설정의 503 `collection-disabled` 는 계약 `failclosed` 프로파일이 소유한다(무접촉). 스위퍼는 그것을 `failed:collection-disabled` 로 분류하고 재시도한다.
- Spring 의 MySQL 축은 이 왕복이 띄우지 않는다(sqlite) — 수집 라우트 자체는 `--db mysql --parity` 313관측이 본다. 스위퍼는 서버 저장소를 모른다.
- 여러 스위퍼 인스턴스의 장부 append 경합 — 작업은 하나만(§5-3 5).

## 6. 운영 tick 의 Spring 전환 (`scripts/tick-cutover-probe.mjs` · `packaging/server/tick-distribution-spring.ps1` — step7 · 로드맵 P3 완료 게이트 ③)

> **한 줄**: 엠바고 시점 배부는 앱 안에 타이머가 없다(ADR-008 (3)). 외부 스케줄러가 `POST /api/login`(Z) 으로 세션을 얻어
> `POST /api/distribution/tick` 을 `x-session-id` 헤더로 부른다. Spring 은 쿠키 우선·**헤더 폴백**(`SessionTokens`)이고 `Origin`·`Referer`
> 가 **둘 다 없는** 서버-서버 요청을 통과시키므로(ADR-009 관용 · `CsrfOriginFilter` 72~80행) **README-배포 §6 의 Node 스크립트 형태가 그대로 통한다** —
> `scripts/tick-cutover-probe.mjs` 가 임시 Node·Spring 을 나란히 띄워 실측했다(왕복 **17행 · Node=Spring · diffs 0**).
>
> **이 절은 U5(작업 스케줄러 tick 교체)의 근거다. 전환은 작업의 _교체_ 이지 추가가 아니다** — 두 작업이 동시에 살아 있으면 같은 tick 이 두 번 돈다.
> `server-spring/src/main` 은 **0줄** 바뀌었다(ADR-008 '주기 실행'·'락' 예외 0 그대로 · `RoutePolicy`·계약 무접촉).

### 6-1. 실행

```bash
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/tick-cutover-probe.mjs                 # A(왕복 표 17행) + S6(Node 2개) · Spring 은 sqlite
SPRING_JAVA_HOME=... node scripts/tick-cutover-probe.mjs --db mysql [--rounds 5]                        # + A-2(Spring 2개 · 같은 임시 MySQL DB) — NEWS_CT_MYSQL_* 3키
node --test scripts/lib/tickCutover.self-test.mjs                                                       # 순수 판정부 + ps1 정적 검사 **22건**(프로브가 시작 시 스스로 돌린다 · 09-08 판 16건 → 리뷰 후속 §6-11)
```

임시 인스턴스 5~6개(Node 2 + 무스풀 Node · Spring 1~2 + 무스풀 Spring)를 리포 밖 임시 `DATA_DIR`·`DIST_SPOOL_DIR` 로 띄우고, 끝나면 자식 종료 → `harness_ct_*` 드롭 →
임시 디렉토리 삭제 · 리포 `news.db`/`uploads` 무변 단언. 로그인 수는 인스턴스당 세어 두었다(왕복 대상 7 · 무스풀 대상 11 — 11번째 429 실측이 목적). 리포트(`tables.md`·`report.json`·기동 로그)는
`--out-dir`(리포 밖) 또는 실패 시 보존되는 임시 루트에 남고, 세션 토큰·비밀번호·MySQL 자격·스풀 절대경로는 어디에도 쓰지 않는다.

### 6-2. 왕복 실측표 (2026-09-08 · 09-09 재실행 동일 · `--db mysql` · 전 행 = 기대치 대조 **그리고** Node=Spring · 하나라도 다르면 red)

| 축 | 기대(=Node=Spring 실측) |
|---|---|
| `POST /api/login`(Z) — 응답 본문 `sessionId` 필드(README 의 `$login.sessionId`) | `200 sessionId=string` |
| `POST /api/distribution/tick` + `x-session-id` 헤더(쿠키 없음) | `200 ok=true` |
| 응답 shape(6키 · `distributed` 원소 3키 · press/DPS) | `keys=at,distributed,failed,invalid,ok,scanned item=articleId,kinds,status kinds=press status=DPS` |
| 응답에 스풀 경로 비노출(`spoolDir` 키·슬러그·`.json`·경로 구분자) | `leaks=0` |
| 같은 tick 2회 — **스풀 파일 수로** 멱등(기사 1건) | `tick1=distributed tick2=not-distributed files=1/1` |
| `Origin`·`Referer` 없이 통과(ADR-009) · 대조: 타 출처 `Origin` | `none=200 evil=403:forbidden-origin` |
| 비-Z 세션(R·D) → 403 | `R=403:forbidden D=403:forbidden` |
| 무세션 → 401 | `401:unauthenticated` |
| `DIST_SPOOL_DIR` 미설정 인스턴스 → 503 | `503:spool-disabled` |
| 같은 IP 연속 로그인 — 몇 번째가 429 인가(한도 10) | `429@11` |
| `ps1` 정상(도래 기사 1건 · 출력 위생) | `exit=0 distributed=1 files=1 leaks=0` |
| 같은 `ps1` 재실행 — 재배부 0 · 파일 수 유지 | `exit=0 distributed=0 files=1 leaks=0` |
| `ps1` 자격 오류 | `exit=3 stage=login` |
| `ps1` 비-Z 자격(tick 403) | `exit=4 stage=tick status=403` |
| `ps1` 환경변수 없음 | `exit=2 stage=config` |
| `ps1` 락 점유 중(이중 실행 방지) | `exit=6` |
| `ps1` 서버 미도달 | `exit=5 stage=network` |

**Node 와 다른 행은 하나도 없었다** — 운영 스크립트는 `$base` 만 바꾸면 Spring 에 붙는다. 「타 출처 Origin 403」 대조 행은 「무출처 통과」가 게이트 부재 때문이 아님을 보인다(비공허성).

### 6-3. Spring 용 스크립트 (`packaging/server/tick-distribution-spring.ps1` — README §6 의 Node 예시를 **삭제하지 않고 나란히** 둔다 · 롤백 시 Node용이 필요하다)

- **자격은 스크립트·인자에 평문으로 두지 않는다.** 작업 실행 계정의 **환경변수** `NEWS_TICK_USER` / `NEWS_TICK_PASSWORD` 에서만 읽는다. 선택 근거(스크립트 머리말에도 있다):
  (a) 사용자 환경변수는 그 계정으로만 읽히고 **argv·스케줄러 이력·프로세스 목록에 남지 않는다** (b) Windows 자격 증명 관리자는 PowerShell 5.1 에 표준 cmdlet 이 없어 모듈 의존이 생긴다
  (c) 리포 밖 파일은 ACL 을 하나 더 관리해야 하고 백업본에 딸려 나간다. 세 후보 중 관리 표면이 가장 작은 (a). 대상 주소는 `NEWS_TICK_BASE`(없으면 `http://127.0.0.1:3001`) 또는 `-BaseUrl`.
- **종료코드**: `0` 성공 · `2` 설정(환경변수 없음) · `3` 로그인 실패(401/423/429) · `4` tick 비-200(403/503) · `5` 네트워크 · `6` 이중 실행(락 점유 — 스킵이지만 비0 으로 보인다).
  작업 스케줄러의 "마지막 실행 결과" 가 이 값이다 — **`0` 이 아니면 경보를 건다.**
- **로그**: 한 줄 — 시각(UTC)·결과·`distributed`/`scanned`/`failed`/`invalid` 건수·실패 단계·사유 토큰. **세션 토큰·자격·스풀 경로는 한 글자도 쓰지 않는다**(tick 응답에 경로가 없는 것이
  계약인데 로그가 밖에서 그 계약을 깨면 안 된다). 프로브가 ps1 출력 7종에서 비밀번호·세션 토큰·스풀 경로·`sessionId`·`.json`·경로 구분자 부재를 실측한다(`leaks=0`). `-LogFile` 로 같은 줄을 append.
- **이중 실행 방지**: 락 파일(`%TEMP%\tick-distribution-spring.lock`)을 `FileShare None` 으로 독점 열어 둔다 — 프로세스가 죽으면 OS 가 푼다(잔류 없음 · PID 파일 아님 · ADR-012 와 같은 원리).
  열기는 **1초 안에 5회만** 재시도한다(백신·인덱서의 순간 점유로 거짓 6 을 내지 않기 위해 — 상주 루프가 아니다. 정적 검사가 초 단위 대기·`while($true)`·타이머를 막는다). **앱 안에 락·타이머를 만들지 않는다.**
  스케줄러 쪽에서도 "이미 실행 중이면 새 인스턴스를 시작하지 않음" 을 켜라(두 겹).
- **세션 재사용 없음**: 호출마다 로그인한다. 세션(1시간 슬라이딩)을 파일에 저장해 재사용하면 로그인 한도 문제는 사라지지만 **그 파일이 Z 토큰 유출 표면**이 된다 — 택하지 않았다.
  대가는 §6-4 의 주기 하한이다.
- **인코딩**: 파일은 **UTF-8 BOM** 이다 — Windows PowerShell 5.1 은 BOM 없는 한글 스크립트를 ANSI 로 읽어 문자열이 깨진다(자기검사가 BOM 을 단언한다).
- **이 스크립트는 Windows PowerShell 5.1 전용이며 `pwsh`(PowerShell 7)로 등록하면 오류 처리 분기가 달라진다** — 비-2xx 를 잡는 `catch [System.Net.WebException]` 이 7 에서는
  `HttpResponseException` 이라 걸리지 않는다(작업 등록은 `powershell.exe` 로 · README schtasks 예시와 §0-1 U5 도 그 판이다). 7 로 옮기려면 catch 절을 함께 고치고 왕복 표를 다시 재라.
- **로그 쓰기 실패는 종료코드를 바꾸지 않는다**: `$ErrorActionPreference='Stop'` 아래에서 `Add-Content` 가 던지면 `Finish` 의 락 해제·`exit` 에 도달하지 못했다(리뷰 후속 §6-11 (2)).
  이제 로그는 `try/catch` 안이고 실패하면 stderr 에 `tick WARN stage=log reason=log-write-failed` 한 줄만 남긴다 — **스케줄러가 보는 값은 언제나 문서화된 종료코드**다.

### 6-4. 레이트리밋 산술 (로그인 **10회 / 15분** 고정 창 · `LoginRateLimit.java` = `server/index.js` 609~614 · 클라이언트(IP)별 · 실측 `429@11`)

호출마다 로그인하므로 **주기 = 로그인 간격**이다. 15분(900초) 고정 창에 들어가는 로그인 수 = `ceil(900 ÷ 주기초)`. 창 안 **11번째**가 429(양 서버 실측). §0-6 의 실제 주기는 **미상**이므로 주기를 매개변수로 적는다:

| 주기 | 15분 창 안 로그인 수 | 한도 10 대비 |
|---|---|---|
| 30초 | 30 | **초과 → 11번째부터 429**(tick 은 exit 3 으로 멈춘다) |
| 60초 | 15 | **초과** |
| 89초 | 11 | **초과**(임계 바로 아래) |
| **90초** | **10** | **통과 — 임계 주기** |
| 120초 | 8 | 통과 |
| **300초(권장)** | 3 | 통과 |
| 600초 | 2 | 통과 |
| 900초 | 1 | 통과 |

**임계 주기 = 900 ÷ 10 = 90초.** 주기가 90초보다 짧으면 tick 이 스스로 한도를 먹어 429 로 멈춘다. **주기는 90초 이상, 권장 5분**(엠바고 지연 상한 = 주기). 두 가지 주의:
(1) 한도는 **IP 별**이라 서버 PC 에서 브라우저로 로그인하는 관리자(같은 127.0.0.1)가 tick 과 버킷을 **공유**한다 — 실패 로그인·잠금(423)도 센다. (2) 주기를 90초 아래로 줄여야 하면 세션 재사용을 검토하되
§6-3 의 토큰 유출 트레이드오프를 감수해야 한다 — 이 스크립트는 재사용하지 않는 쪽을 택했다.

### 6-5. **A-2. 다중 인스턴스 — 이 전환이 잃는 것을 수량으로 잰다** (2026-09-08 · `--db mysql --rounds 5` · 임시 DB `harness_ct_*` finally 드롭 · 임시 스풀)

**Spring 에는 ADR-012 단일 인스턴스 잠금이 없다**(main 소스 철자 0건 — ADR-017 결정 2 · open_questions (9) `GET_LOCK` 은 넣지 않는다). 그 공백의 크기를 「그럴 것이다」가 아니라 **숫자로** 쟀다:
Spring 2개(**다른 포트 · 같은 MySQL 임시 DB · 같은 `DIST_SPOOL_DIR` · 같은 `DATA_DIR`**)와 Node 2개(같은 `DATA_DIR` · 다른 포트)를 띄워 스풀 파일 수를 **파일시스템에서 셌다**(응답 신뢰 금지).

| 축 | Node (같은 `DATA_DIR` · 다른 포트) | Spring (같은 MySQL · 같은 `DIST_SPOOL_DIR` · 같은 `DATA_DIR` · 다른 포트) |
|---|---|---|
| **2번째 인스턴스 기동** | **`exit 1` — 506·600ms(2회) · ADR-012 잠금 안내(stderr) · 첫 인스턴스 health 유지** | **health-ok — 둘 다 뜬다**(2회 동일) |
| 교차 세션(A 에서 로그인한 토큰으로 B 에 tick) | (2번째가 뜨지 않아 성립 불가) | **`401 unauthenticated`** · B 자기 세션은 `200` |
| **순차** tick(A 먼저 끝난 뒤 B) | (성립 불가) | A `distributed` · B `not-distributed` · **파일 1 → 1** |
| **동시** tick(A·B 동시 발화 · 5회) | (성립 불가) | **중복 회차 5/5 · 기사당 파일 최대 2** — 매 회차 A·B **둘 다** `distributed`(회차:파일수 1:2 2:2 3:2 4:2 5:2) |

**실측이 확정한 사실 셋**:
1. **Node 는 같은 `DATA_DIR` 로 두 번째가 뜨지 못한다**(`exit 1`). **Spring 은 둘 다 뜬다.** 이 **비대칭이 이 전환이 잃는 보호**이고(S6 대조 실험), 막는 자동 게이트는 없다.
2. **세션은 프로세스 로컬이다** — 한 인스턴스의 토큰은 다른 인스턴스에서 401 이다(`SessionStore` in-process · 단일 세션 정책). **그래서 로드밸런서·이중화 구성은 불가능하다**(같은 사용자가 요청마다 다른 서버에 떨어지면 로그인이 갈린다).
3. **이력 기준 멱등은 직렬 tick 은 막지만 동시 tick 은 못 막는다.** 멱등의 근거인 배부 이력이 스풀 쓰기 **뒤**에 남고, 프로세스 내 single-flight(`DistributionTickService.running`)는 프로세스가 둘이면 무력하다.
   두 인스턴스가 같은 순간 tick 하면 같은 기사가 **두 번** 스풀된다(5/5). 중복 스풀은 ADR-008 트레이드오프가 「미발송보다 낫다」고 판단한 방향이지만 **의도하지 않은 중복은 다르다** — 운영이 절차로 막는다(§6-6·§6-7).

### 6-6. 전환 절차 — 스케줄러 작업 **교체**(추가가 아니다) · 검증 · 롤백 · 실패 알림 책임

1. **교체이지 추가가 아니다.** 기존 Node용 tick 작업의 **동작(Action)만** `tick-distribution-spring.ps1` 로 바꾸거나, 기존 작업을 **비활성화한 뒤** 새 작업을 등록한다. **삭제보다 비활성화가 먼저다**(되돌림 레버). 명령·판정은 §0-1 **U5**.
2. **자격**: 작업 실행 계정의 환경변수에 `NEWS_TICK_USER`·`NEWS_TICK_PASSWORD`(Z 계정) 를 넣는다. `NEWS_TICK_BASE` 는 같은 host:port(`http://127.0.0.1:<PORT>`). **bat·ps1·작업 인자에 자격을 두지 마라.**
3. **주기**: §6-4 — **90초 이상**(권장 5분). 기존 주기가 90초 미만이면 **그대로 옮기지 말고** 늘려라(옮기는 순간 429 로 멈춘다).
4. **검증**(한 주기 뒤): (a) 작업 "마지막 실행 결과" = `0` (b) `DIST_SPOOL_DIR` 하위 파일 수가 **주기당 한 벌만** 는다 (c) 활성 tick 작업이 **정확히 하나**(`schtasks /query /fo list /v /tn <이름>`).
   두 벌이 늘면 옛 작업이 살아 있는 것이다 — 즉시 하나를 비활성화한다(**파일은 지우지 않는다** — 외부 전송기가 이미 읽었을 수 있다).
5. **롤백**(역순 1회): Spring용 작업 비활성화 → Node용 작업 되살림. **tick 작업은 언제나 정확히 하나만 활성**이어야 한다. 수집 스위퍼를 함께 운영 중이면 **롤백 시 스위퍼를 먼저 끈다**(§5-5).
6. **실패 알림 책임은 운영이 소유한다**(앱은 자동 재시도·알림이 없다 — ADR-008 (6)). 스케줄러의 종료코드(≠0) 를 경보 조건으로 걸고 **그 경보를 받는 사람을 정한다**. 그 사람이 없으면 배부가
   조용히 멈춰도 아무도 모른다 — 수집 스위퍼(§5-4)와 같은 성질이다. 종료코드 `6`(락 점유)이 반복되면 이전 실행이 안 끝난 것이다(서버 무응답 → `-TimeoutSec` 30초 뒤 exit 5 로 풀린다).

### 6-7. 런북 §0 낭독 · §10 분기 — 「**Spring 은 두 번 뜬다**」

- **§0 낭독(전환 전 소리 내어 읽는다)**: 「**Spring 에는 단일 인스턴스 잠금이 없다. 서로 다른 포트로 서버를 두 개(Node+Spring 이든 Spring 2개든) 동시에 띄우지 마라.** 두 인스턴스가 같은 MySQL·같은 `uploads`·같은 `DIST_SPOOL_DIR`
  에 붙어 tick 이 양쪽에서 돌면 **같은 기사가 두 번 배부된다**(실측: 동시 tick 5/5 회차 파일 2). 이것을 막는 자동 게이트는 없다 — **지키는 것은 사람이다.**」
- **§10 분기 — 서버가 하나만 떠 있는지 확인하는 법(운영자 언어)**:
  1. `netstat -ano | findstr LISTENING` 에서 서버 포트가 **한 줄**인지. 같은 포트를 두 프로세스가 못 잡으므로 **같은 포트 이중 기동은 애초에 불가** — 위험은 언제나 **다른 포트**다.
  2. 작업 관리자·`tasklist` 에서 `java.exe`(Spring) 와 `기사작성기-server.exe`(Node) 가 **동시에** 떠 있지 않은지. 전환 후에는 서버로서의 `java.exe` 하나만 있어야 한다(IDE·언어 서버의 `java.exe` 와 구분 — 명령줄에 jar 이름이 보인다).
  3. **`/api/health` 로는 두 인스턴스를 구분할 수 없다** — 둘 다 `{ok:true}` 이고 인스턴스 식별자가 없다. 포트·프로세스 목록이 유일한 구분 수단이다.
  4. `DIST_SPOOL_DIR` 파일 수가 **주기당 한 벌보다 많이** 늘면 tick 작업이 둘이거나 서버가 둘이다 — 둘 중 하나를 즉시 비활성화한다(파일은 지우지 않는다).

### 6-8. 변이 결과표 (2026-09-08 · S1~S6 · 심기 → 측정 → 백업 원복 → 자기검사 16/16 확인 · 기대≠실제는 굵게)

방어선은 세 겹이다: **판정부 자기검사**(`ps1StaticFindings`·`judgeRoundtrip`·`judgeMultiInstance` — 프로브는 이것이 빨간 채로는 서버를 띄우지 않는다) → **프로브 왕복 + 스풀 파일 수** → **A-2 실측**. 앞 겹이 닫히면 뒤 겹은 돌지 않는다(관측 부재가 아니라 방어선이 앞에서 닫혔다는 뜻이다).

| 변이 | 심은 것 | 기대 | 실제 | 원복 |
|---|---|---|---|---|
| **S1** tick 에서 `x-session-id` 제거 | (a) 프로브 고정 행: 무세션 tick (b) ps1 의 tick 헤더를 `@{}` 로 | 401 · 검증이 잡는가 | (a) **직접 측정** `tick-no-session` = `401:unauthenticated`(Node·Spring 동일). (b) 헤더를 지우면 자기검사의 앵커(`'x-session-id' =`)가 사라져 **자기검사 red → 프로브 기동 거부**(exit 1 · 게이트가 앞에서 닫힘) | 백업 원복 · 16/16 |
| **S2** 비-Z 계정으로 로그인 | 프로브 고정 행: R·D 세션 tick + ps1 을 R 자격으로 | 403 forbidden(ADR-004) | **직접 측정** `tick-non-z` = `R=403:forbidden D=403:forbidden` · `ps1-non-z` = `exit=4 stage=tick status=403`. 비공허성: 자기검사 「두 서버가 같은 방향으로 틀리면 red」가 인가 완화(양쪽 200)를 잡는다 | 고정 행(변이 없음) |
| **S3** tick 2회 → 재배부 0 | (변이 아님 — 파일 수 검사의 비공허성) | **스풀 파일 수**로 재배부 0 | 단일 인스턴스 `files=1/1`(양 서버) · A-2 순차 `1→1` · **같은 실행 안에서 동시 tick 은 `2`** — 파일 수 검사가 1 과 2 를 실제로 구분했다(응답 `distributed` 만 보면 A·B 둘 다 「배부했다」고 답해 중복을 못 본다) | — |
| **S4** 종료코드 처리 제거(항상 0) | ps1 `exit $code` → `exit 0` | 실패가 스케줄러에 안 보인다 — 검증이 잡는가 | **`ps1StaticFindings` red = `no-nonzero-exit`**(실제 파일 스캔 · 자기검사 15/16) → 프로브 기동 거부. 뚫고 돌려도 `ps1-bad-password`·`ps1-non-z`·`ps1-no-env` 행이 `exit=0` 으로 뒤집혀 red | 백업 원복 · 16/16 |
| **S5** 자격을 ps1 에 평문으로 | `$secret = "…평문…"` | `SecretHygieneTest` 범위에 `packaging/**` 이 드는가 | **실측: `SecretHygieneTest` 는 `packaging/**` 을 _스캔은 한다_(가지치기 목록 밖) 그러나 6/6 green** — 세 패턴(jdbc-URL 자격 · `NEWS_*_PASSWORD=` 대입 · bootstrap SQL `IDENTIFIED BY`)이 PowerShell 리터럴 대입을 잡지 않는다 → **리포 Java 게이트는 못 잡는다(공백)**. 스크립트 자체 방어 `ps1StaticFindings` 는 red(`literal-password`·`password-not-from-env`) | 백업 원복 · 16/16. **테스트 범위 확대는 이 step 에서 하지 않는다**(별도 판단) |
| **S6** Node 2개 같은 `DATA_DIR` | (변이 아님 — 잃은 보호의 대조 실험) | 2번째가 ADR-012 잠금에 막힌다 | **Node 2번째 `exit 1`(506ms · stderr 안내 · 첫 인스턴스 health 유지) · Spring 2번째 health-ok** — 그 비대칭이 §6-5 첫 줄. sqlite·mysql 두 실행 모두 동일 | — |

위 표의 자기검사 수치는 **2026-09-08 판 16건** 기준이다 — 리뷰 후속으로 **22건**이 됐다(§6-11).

**S5 공백 기록**(2026-09-09 갱신): `tools/**`·`packaging/**` 스크립트의 앱 자격은 리포 전역 Java 게이트가 구조적으로 보지 못한다(패턴이 jdbc·env-대입·SQL 에 특화 — step6 R5 의 `tools/**` 공백과 같은 계열).
이 step 은 스크립트 **자체 정적 검사**(프로브 기동 게이트)로 닫았고, `SecretHygieneTest` 범위·패턴 확대는 별도 phase 의 판단이다. **그 자체 검사도 처음에는 `<이름> = '<값>'`(등호+따옴표) 세 형태만 봤다** —
리뷰 후속 (5) 로 `ConvertTo-SecureString -AsPlainText '<값>'`(`literal-secure-string`)과 콜론 구문 `"password": "<값>"`(`literal-password-json`) 두 형태를 더했다(각각 자기검사 red 케이스로 실증 ·
값이 `$변수`면 잡지 않는다 — 올바른 판을 벌하지 않기 위해). **남은 공백**: Base64 blob·외부 파일에서 읽는 자격은 여전히 형태로 못 잡는다(문자열 상수만 본다).

### 6-9. 이 step 이 잡은 함정·발견 (전부 실측)

1. **세션 단일 정책이 하네스를 속였다**: 1차 A-2 실측에서 「A 는 한 번도 배부하지 못하고 B 만 배부」가 6/6 으로 나왔다 — 중복 0 처럼 보였지만 실은 A 의 tick 이 전부 **401** 이었다. ps1 이 Z 로 로그인할 때마다
   `SessionStore.createSession` 이 같은 userId 의 이전 세션을 **전부 무효화**해(단일 세션 정책) 왕복 초기의 Z 토큰이 죽어 있었다. 토큰을 A-2 안에서 새로 발급하자 진짜 결과(동시 5/5 중복)가 나왔다.
   **교훈**: 다중 인스턴스 실측에서 `statusA/statusB` 를 표에 남겨야 「배부 안 함」과 「인증 실패」를 구분한다 — 프로브가 그렇게 기록한다.
2. **ps1 락 홀더의 판정 방식**: 별도 PowerShell 프로세스로 「열어 보기」 판정은 1차 실행에서 20초 동안 답을 못 냈다(원인 미확정 · 격리 재현 0/8). 홀더가 stdout 으로 `HELD` 를 스스로 알리는 방식으로 바꿔 결정적으로 만들었다.
3. **ps1 로그의 `/`**: 「missing-env (A / B)」 문구가 프로브의 「출력에 경로 구분자 0」 검사에 걸렸다 — 로그 문구에도 구분자를 쓰지 않는다(위생 검사가 문구까지 본다는 뜻이고, 그것이 옳다).
4. **`Invoke-WebRequest` 는 `Origin`·`Referer` 를 붙이지 않는다**(Node `fetch`/undici 도 — 실측). 그래서 ADR-009 관용이 그대로 통하고, 스크립트에 Origin 을 흉내내 넣으면 정적 검사가 `browser-origin-header` 로 막는다.
5. **`Start-Sleep -Seconds` 금지 · `-Milliseconds` 허용**: 락 열기 재시도(1초 안 5회)를 넣으며 정적 검사 규칙을 「초 단위 대기·`while($true)`·타이머는 상주 루프」로 좁혔다(밀리초 5자리 이상도 막는다).

### 6-10. 무엇을 보지 않는가

- 운영 스케줄러의 **실제 작업 이름·주기·스크립트 경로·자격 위치**(§0-6 전부 미상) — U5 가 사람 손으로 채운다. 산술표는 그래서 주기가 매개변수다.
- 두 인스턴스가 **다른 머신**에 있는 구성(같은 스풀을 SMB 로 공유) — ADR-012 트레이드오프의 미검증 영역이고 이 phase 도 재지 않는다.
- 스풀 파일 이름 충돌(같은 ms 에 두 인스턴스가 같은 `<articleId>_<stamp>.json` 을 쓰는 경우) — 5회 관측에서는 모두 다른 stamp 였다. 충돌 시 `ATOMIC_MOVE` 의 덮어쓰기 여부는 잰 적이 없다.
- 세션 재사용 판의 ps1 — 만들지 않았다(§6-3 결정).

### 6-11. 리뷰 후속 (2026-09-09 · 읽기 전용 리뷰 확정 5건 + 반박 1건 → fix 커밋 1개 · 자기검사 **16 → 22** · 게이트 재실행 없음 — `server-spring/**`·`contract/**`·`server/**`·`src/**`·`test/**` 무접촉)

| # | 발견(미검증 주장) | 코드로 확인 → 처리 | 실측 |
|---|---|---|---|
| 1 | ps1 stdout 원문이 `scrub` 없이 `tables.md`·콘솔로 나간다(다른 자식 출력 2곳은 `scrub` 을 탄다 — 비대칭) | **사실. 그리고 처방(값 마스킹)만으로는 부족했다** — ps1 은 호출마다 **자기 세션을 발급**하므로 그 토큰 값은 하네스가 모른다(§6-9 (1)). 그래서 ① 아는 값 마스킹(`maskSample`) ② **형식 allowlist**(`sanitizePs1Sample` — 시각·`tick`/`ok`/`FAIL`/`skipped`·`stage`/`status`/`reason`/건수 5키만 통과, 나머지는 `<형식 밖>`) ③ 검출기에 **형태** 규칙(`tokenShapeLeaks` — 32자 이상 16진수) | ps1 이 자기 sessionId 를 찍도록 변이(정적 검사를 통과하는 형태 `$s`) → **수정 전: `tables.md`·stdout 에 64hex 토큰 2건 · 프로브 exit 0**(값 비교 검출기가 못 봤다) → **수정 후: 리포트·stdout 토큰 0건**(`tick ok <형식 밖> distributed=1`) **· exit 1 · `FAIL … hex-token`** · 원복 후 md5 동일 |
| 2 | `Finish` 가 `Write-Line` 실패에 무방비 — 락 해제·`exit $code` 를 건너뛴다 | **사실** → 로그를 `try/catch` 안으로(실패는 stderr 1줄 `tick WARN stage=log reason=log-write-failed`) · `Dispose` 도 `try` 로 감싸 `exit` 가 **항상** 실행 | `-LogFile` 을 디렉토리로 주어 `Add-Content` 를 던지게 함: **수정 전 exit 1**(PowerShell 예외 코드 · stderr 에 경로까지 노출) → **수정 후 exit 2**(문서화된 config 코드 · stderr 1줄) · 로그 정상 경로도 exit 2 동일 |
| 3 | `runMigrator` 의 java 자식이 `ctx.children` 에 없어 SIGINT 때 고아가 된다(다른 spawn 3곳은 등록한다) | **사실**(등록 누락) → `spawn` 직후 `ctx.children.push(child)` + `'error'` 에서 `spawnError` 설정(죽은 자식을 정리 루프가 5초 기다리지 않게) | **실제 CTRL_C 로는 재현되지 않는다** — 콘솔 이벤트는 **콘솔 전체**에 가서 java 자식이 스스로 죽는다(`--db mysql` 중 CTRL_C → 자식 0 · `harness_ct_*` 0 · 드롭 완료). 등록의 값은 **콘솔 밖 SIGINT** 에서 드러난다: 100ms 샘플링 타임라인에서 **수정 전 = 프로브 종료 뒤에도 migrate java 생존**(`probe=0 migrator=2 pids=6556,21988`) → **수정 후 = 드롭 자식 1개만**(`probe=0 migrator=1 pids=30476`) |
| 4 | A-2 동시 라운드 판정이 `statusA`/`statusB` 를 보지 않아 「한쪽 401 + 한쪽 성공」 회차도 통과 | **사실**(기록만 하고 판정에 안 썼다) → 라운드마다 `statusA===200 && statusB===200` 요구 · 아니면 **무효 회차**로 red 이고 중복·최대파일 **수치에서 제외**(`validRounds`·`invalidRounds` 신설 · 표에도 남긴다) | 자기검사 red 2건(한쪽 401 · `statusA` 측정 누락) → green · 최종 `--db mysql` 실행에서 **5/5 유효(A+B 둘 다 200) · 무효 0** |
| 5 | 자격 평문 정규식이 등호+따옴표 형태만 본다 | **사실** → `literal-secure-string`·`literal-password-json` 2종 추가(§6-8 S5 공백 기록 갱신) | 자기검사 red 5케이스(인자 순서 3형 + 콜론 구문 2형) → green · 거짓 양성 방지 2케이스(`$env:` 판 · `password = $secret`)도 잠금 |
| 반박 | `catch [System.Net.WebException]` 가 PowerShell 7 에서 안 맞는다 | **코드는 고치지 않았다** — 이 리포는 배포 대상을 **Windows PowerShell 5.1** 로 명시한다(BOM 근거 · README `schtasks` 예시가 `powershell.exe` · 프로브도 5.1 로 실행). 대신 §6-3 에 「`pwsh` 로 등록하면 오류 처리 분기가 달라진다」 한 줄을 남겼다 | — |

**이 후속이 남긴 교훈**: 「검출기가 있으니 안전하다」는 **값을 아는 비밀에만** 참이다. 하네스가 값을 모르는 비밀(자식이 스스로 발급한 토큰)은 **형식 allowlist** 로만 막힌다 — 리포트로 나가는 줄은
「무엇을 지울까」가 아니라 **「무엇만 실을까」**로 짜라. 그리고 SIGINT 실측은 **콘솔 Ctrl+C 와 콘솔 밖 SIGINT 가 다른 사건**이다(전자는 자식에게도 직접 간다 — 등록 누락을 가린다).

## 7. 운영 적재 리허설 · 규모 점검 (`scripts/load-rehearsal.mjs` · `scripts/db-scale-probe.mjs` — step8)

> **이 절의 수치는 표본이다.** 소스는 **리포 `news.db` 의 사본**(178행)이고 **운영 데이터가 아니다** —
> 운영 사본은 2026-09-09 시점에 아직 없다(§0-2묶음 · Q3 미상). 그래서 이 절은 **절차와 커맨드를 완성**하고
> 표본 수치를 남기되, 운영 규모의 값은 **「미측정 — 운영 사본 필요」** 로 정직하게 비워 둔다.
> **운영 사본이 오면 §7-7 의 같은 커맨드를 그대로 다시 돌려 이 표를 채운다.**

### 7-0. 무엇이 실증됐고 무엇이 아직 아닌가

| 실증된 것(표본) | 아직 아닌 것 |
|---|---|
| 사본 → 임시 MySQL → 산출물 `.db` 의 **왕복 대조 불일치 0**(7테이블 · 178행 · 81컬럼 · **2,878셀**) | **운영 규모의 이관 시간**(정지 창 길이의 근거) |
| **롤백 자산이 진짜다** — export 산출물로 **Node 가 실제로 뜨고**(694 ms) 로그인·목록·상세가 200이다 | 운영 데이터의 768자 초과 PK·이모지·정본 밖 컬럼 유무 |
| 소스 사본이 **한 바이트도 변하지 않는다**(도구 출력 + 바깥 `md5sum` 양쪽) | 운영 `uploads/` 규모와 복사 시간 |
| 부분 적재(2차 `migrate`) 는 **exit 1 이고 아무것도 지우지 않는다**(T6) · **(나) 무삭제 복구**가 실측으로 돈다 | 운영 MySQL 이 이 머신인지(Q6) · 정지 창(Q7) |

### 7-1. 절차 — 사전 백업 2벌 → 정지 → 사본 → migrate → verify → grant → 기동

**전제**: 런북 `docs/ops-mysql.md` **§11-0 체크리스트 6항**이 전부 통과(jar 둘 · 자격 3키 · 판본 · **grant** ·
한글 인코딩 · **대상이 비어 있다**). 아래 1~3은 **사용자 실행 항목**이다(U3·U4·U1).

1. **백업 2벌**(U3 · 서버를 내린 뒤) → 원본과 사본 2벌의 **md5 세 값이 같아야** 시작한다.
2. **운영 프로세스 정지**(U4) — 정지 전에 뜬 사본은 「그 순간의 전부」가 아니다.
3. **사본을 리포 밖에 둔다**. 부산물(`-wal`/`-shm`/`-journal`)이 붙어 있으면 **도구가 시작 자체를 거부**한다
   (T2 실측) — 그때는 **부산물을 지우지 말고** 서버를 정상 종료한 뒤 사본을 다시 뜬다.
4. **리허설/적재를 한 번에 돈다**(아래 한 줄이 5~9를 순서대로 실행하고 수치를 남긴다):

```bash
# 자격은 argv 가 아니라 환경변수다(docs/ops-mysql.md §3 — 한 줄씩 · `set -a; .` 금지)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" \
  node scripts/load-rehearsal.mjs --source <리포 밖 사본.db> --work <리포 밖 작업 디렉토리>
```

  이 스크립트가 하는 일: **부산물 가드 → `ephemeral-create` → `migrate` → `verify` → `export` →
  `verify`(산출물) → 그 산출물로 `node server/index.js` 기동 → 로그인·목록·상세 자동 판정 → 부팅 전후 md5 →
  `ephemeral-drop`**. 대상은 **임시 DB(`harness_ct_<16hex>`) 뿐**이다 — `news`·`news_stage` 를 리허설
  대상으로 쓰지 않는다. 운영 사본이라 개발 계정이 없으면 로그인 계정을 **환경변수**로 준다
  (`NEWS_REHEARSAL_USER`·`NEWS_REHEARSAL_PASSWORD` — **argv 에 두지 마라**).

5. **실제 컷오버**는 같은 명령을 `--target NEWS_MIGRATOR`(URL 이 `news` 를 가리킨다)로 손수 돌리는 것이고,
   그 순서는 런북 §11-3 → §11-4 → **§11-4-b grant(U1)** → §11-5 Spring 기동이다. 리허설은 그 앞의 예행이다.

### 7-2. 리허설 실측표 — **표본(리포 `news.db` 사본 178행) · 2회** (2026-09-09)

소스 `D:/agents/76s8-work/rehearsal-source.db` = 리포 `news.db` 의 사본(606,208 B ·
md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967`). 대상은 회차마다 새 `harness_ct_<16hex>` 다.

| 단계 | 커맨드 | 1회차 | 2회차 | 관측 |
|---|---|---|---|---|
| 1 | `ephemeral-create` | 605 ms | 512 ms | exit 0 |
| 2 | `migrate --source <사본> --target <키집합>` | **2,685 ms** | **2,640 ms** | exit 0 · 옮긴 행 **178**(7테이블) · 소스 무변 확인 |
| 3 | `verify --source <사본> --target <키집합>` | **1,529 ms** | **1,513 ms** | exit 0 · **판정: 일치** · 불일치 **0** · 구조 문제 **0** |
| 4 | `export --target <키집합> --out <리포 밖 .db>` | **1,792 ms** | **1,773 ms** | exit 0 · 산출물 **606,208 B** · md5 `3f31505996c1afb682ef2bedc2ee89e6` |
| 5 | `verify --source <산출물> --target <키집합>` | **1,426 ms** | **1,376 ms** | exit 0 · 일치 · 불일치 0 |
| 6 | **export 산출물로 Node 기동** | **694 ms** | **686 ms** | `/api/health` 200 · **로그인 200 · 목록 200(77건) · 상세 200** · 부팅 전후 **md5 동일** |
| 7 | `ephemeral-drop` | 624 ms | 630 ms | exit 0 · 잔존 `harness_ct_*` **0** |
| — | **2~5 합계**(정지 창에 들어가는 부분) | **7,432 ms** | **7,302 ms** | 회차 차 1.7% |

**규모**(3의 출력 그대로 · 제외 `flyway_schema_history`):

| 테이블 | 행 | 컬럼 | 셀 | 불일치 |
|---|---|---|---|---|
| User | 11 | 10 | 110 | 0 |
| Article | 77 | 5 | 385 | 0 |
| Contents | 77 | 29 | 2,233 | 0 |
| ArticleHistory | 12 | 12 | 144 | 0 |
| ReceiverConfig | 0 | 12 | 0 | 0 |
| DistributionTarget | 0 | 7 | 0 | 0 |
| Photo | 1 | 6 | 6 | 0 |
| **합계** | **178** | **81** | **2,878** | **0** |

> **두 회차의 export 산출물 md5 가 같다**(`3f31505996c1…`) — 같은 입력에서 같은 바이트가 나온다.
> 그래서 롤백 자산은 **재현 가능**하고, 다른 값이 나오면 그것 자체가 신호다.
> **75 의 값과 다른 것 하나**: 75 step8 은 스테이징(239행)에서 618,496 B 를 얻었다. 크기는 **행 수에 따라 다르다**.

### 7-3. 규모 점검 — 운영에서만 드러나는 다섯 축 (`scripts/db-scale-probe.mjs`)

```bash
node scripts/db-scale-probe.mjs --source <리포 밖 사본.db> [--json <리포 밖 파일>]
```

읽기 전용으로 열고(부산물이 생기지 않는다) **값 원문은 출력하지 않는다**(글자 수·바이트 수·건수만).
상한은 손으로 베끼지 않고 마이그레이터 기반선(`V1__baseline.sql`)에서 읽는다.

| 축 | 왜 컷오버 전에 알아야 하는가 | **표본값(178행 사본 · 2026-09-09)** | **운영값** |
|---|---|---|---|
| **768자 초과 텍스트 PK**(`User.userId`·`Article.articleId`·`Contents.articleId`) | 있으면 **이관 자체가 실패**한다(MySQL 1406 · T4) — step9 와 함께 처분을 정해야 한다 | **없음**(최대 20자) | **미측정 — 운영 사본 필요** |
| **최대 값 바이트**(`markupVersion` 이 대표) | `max_allowed_packet`(67,108,864 B) 대비. **글자가 아니라 바이트**다 | **`Article.markupVersion` 165,802 B = 상한의 0.2471%** | **미측정 — 운영 사본 필요** |
| **4바이트 이모지(astral)** | 75 forward_notes (5) ⑤ 의 공백. `utf8mb4` 라 저장은 되지만 **재 본 적이 없었다** | **0건** | **미측정 — 운영 사본 필요** |
| **짝 없는 서로게이트** | 유효한 UTF-8 로 옮길 수 없다 — 이관 경로에서 치환·거부된다 | **0건** | **미측정 — 운영 사본 필요** |
| **NULL vs 빈 문자열** | 두 값이 섞인 컬럼은 방언 divergence 축이다(`db-mysql-mapping.md` §7-1) | **11컬럼이 섞여 있다** — 예: `Contents.embargoAt` NULL 10 / 빈 52 · `coAuthor` NULL 55 / 빈 16 · `category` NULL 73 / 빈 3 | **미측정 — 운영 사본 필요** |
| **정본 밖 테이블·컬럼**(수기 `ALTER` 흔적) | 있으면 `verify` 가 **구조 문제**로 잡고 이관이 서지 않는다 | **테이블 0 · 컬럼 0** | **미측정 — 운영 사본 필요** |

### 7-4. 실패 분기 — 런북 §11-8 의 8종을 **P3 문맥**으로 (전부 실측 문구)

| 무슨 일이 났는가 | 어떻게 드러나는가(실측) | 정지 창에서의 안전한 다음 수 |
|---|---|---|
| **사본 옆에 부산물** | **exit 1** · `소스 옆에 부산물이 있다 [<파일>-wal] — 다른 프로세스가 쓰는 중이거나 WAL 모드다. 그 상태의 스냅샷은 전부가 아닐 수 있으므로 시작하지 않는다: <경로>` (T2) | **부산물을 지우지 마라.** 서버를 정상 종료했는지 확인하고 **사본을 다시 뜬다** |
| **대상이 비어 있지 않다**(부분 적재) | **exit 1** · `대상이 비어 있지 않다 [User, Article, Contents, ArticleHistory, Photo] — 비우고 다시 넣지 않는다. 재실행하려면 빈 대상 DB 를 준비하라(docs/ops-mysql.md).` **소스·대상 모두 무변**(T6) | **U6 (나) 빈 DB 를 새로 만드는 무삭제 경로가 기본이다.** (가) 비우기는 예외 조건 4개를 **전부** 만족할 때만 |
| **768자 초과 PK** | **exit 1** · `이관에 실패했다(부분 성공은 커밋되지 않았다): <키집합> → <URL> (<계정>)` — ⚠ **메시지에 `1406` 도, 어느 테이블·컬럼인지도 없다**(T4). 대상은 **7테이블 전부 `COUNT(*) = 0`** 으로 롤백된다 | 원인 특정은 **`db-scale-probe` 로 사본을 먼저 재는 것**이다(§7-3). 컷오버 **전에** 돌려라 |
| **`verify` 불일치** | **exit 4** · `대조 불일치 N건 · 구조 문제 M건 — 리포트를 보세요.`(리포트는 OS 임시 디렉토리 · 값 원문 없이 길이만) | **전환을 멈춘다.** Node 가 아직 정본이므로 §11-6 을 시작하지 않았다면 아무 일도 없었다 |
| **`verify` 를 못 돌렸다** | **exit 1**(접속·파일 오류) | 데이터 판정이 아니다 — 자격·경로를 고쳐 다시 돌려라. **exit 4 와 섞지 마라** |
| **`DB_KIND` 누락/모순 기동** | **exit 1** · kind/url 모순 거부(설계된 거부) | 환경변수를 맞춘다 |
| **적재 전/부분 적재 상태로 Spring 기동** | **exit 1** · `DB 스키마가 이 서버의 요구를 만족하지 않습니다 (<대상>): 테이블 없음 = … . 이 서버는 스키마를 만들거나 고치지 않습니다 — news-migrator 로 대상 DB 를 적재한 뒤 다시 실행하세요(... migrate --source <news.db> --target <키집합> · 절차는 docs/ops-mysql.md §11-3).` | **step8 이 이 문구를 고쳤다**(그 전에는 「Node 서버로 데이터 디렉토리를 준비하라」였다 — 컷오버 중에 그 처방을 따르면 **두 저장소가 갈린다**). 처방대로 §11-3 으로 돌아간다 |
| **grant 누락** | 기동 성공 · 계약 하네스 **green** · `DELETE /api/receiver-config/:id` 만 **500**(T5) | §11-0-4·§11-4-b(U1). 감지는 `SHOW GRANTS` 뿐이다 |

### 7-5. 정지 창 길이의 근거 — **표본으로 산정하고 운영 사본에서 다시 잰다**

정지 창 = **① 백업 2벌 + ② 사본 + ③ 이관·대조(§7-2 의 2~5) + ④ grant + ⑤ Spring 기동 + ⑥ 육안 확인**
이고, 자동화가 재는 것은 ②③⑤ 뿐이다(①④⑥ 은 사람의 속도다).

| 항목 | 표본 실측 | 운영 추정 근거 |
|---|---|---|
| ① 백업 2벌 + md5 대조 | **173 ms**(606 KB · 75 §12 #1) | 파일 크기에 비례 — **운영 `news.db` 크기 미상**(§0-2묶음) |
| ③ `migrate`+`verify`+`export`+`verify` | **7.4 초**(178행 · 2회 평균 7,367 ms) | **행 수에 대한 선형성은 검증되지 않았다**(75 미검증 ①) — 그래서 **재측정이 필수**다 |
| ⑤ Spring 기동 + `/api/health` | **4.2 초**(75 §12 #13) | 데이터 규모와 거의 무관(부팅 스키마 검증은 카탈로그 읽기다) |
| (참고) 롤백 시 Node 기동 | **0.7 초** | 〃 |

**계산식**: `정지 창 ≥ (①+③+⑤) × 안전 계수 3 + ④ grant 1분 + ⑥ 육안 확인 8항목`.
표본으로는 `(0.2 + 7.4 + 4.2) × 3 ≈ 35초` + 사람 시간이지만, **이 값을 운영 창으로 쓰지 마라** —
178행짜리 표본이다. **운영 사본에서 §7-7 을 돌려 ③을 다시 잰 뒤에 창을 확정한다.**
안전 계수 3의 근거: 재시도 1회(부분 적재 → U6 (나) 로 새 DB 준비 → 재적재)를 창 안에 흡수하기 위해서다.

### 7-6. 변이 전건 결과표 (2026-09-09 · 기대/실제/원복)

| 변이 | 심은 것 | 기대 | 실제 | 원복 |
|---|---|---|---|---|
| **T1** 대조기의 제외에 정본 테이블 추가 | `RowVerifier.verify` 의 비교 루프에서 `Photo` 를 건너뛰게 한 뒤 jar 재빌드. 대상 임시 DB 의 `Photo.caption` 을 실제로 바꿔 **진짜 불일치**를 만들어 둔다(UPDATE · 삭제 0) | 그 불일치가 **조용히 통과** | **정상 jar: exit 4 · `Photo … 불일치 1`** → **변이 jar: exit 0 · 「판정: 일치」** — 공허화 실증. **유일한 흔적은 헤더**(`대조 테이블 수: 6 · 소스 총 177행` — 7·178 이어야 한다) | 원복 후 다시 **exit 4** · `git diff tools/news-migrator/src` **0줄** |
| **T2** 사본 옆 `-wal` | 빈 `source.db-wal` 생성 | **시작 거부** | **migrate exit 1** · `소스 옆에 부산물이 있다 [source.db-wal] …` · `load-rehearsal` 도 자체 가드로 **exit 1**(자기검사 통과 직후 · 아무것도 만들지 않음) | 부산물 제거 후 **exit 0 · 178행** |
| **T3** `SchemaGuard` mysql 처방을 sqlite 문구로 | (= 변경 전 상태 그대로) | 새 테스트 **red** | **`SchemaGuardTest` 20 tests · Failures 1** — `thePrescriptionDiffersByDialect` 가 `mysql 처방은 마이그레이터의 migrate 를 지목해야 한다` 로 실패 | 문구 분기 후 `clean verify` **1522 / 0** |
| **T4** 769자 텍스트 PK | 사본의 **사본**에 `User.userId` 769자 1행 INSERT(원본·리포 파일 무접촉) | **1406 실패** | **migrate exit 1** · 문구 `이관에 실패했다(부분 성공은 커밋되지 않았다): <키집합> → <URL> (<계정>)` — **1406 도 컬럼 이름도 문구에 없다**(발견). 대상은 7테이블 `COUNT(*) = 0` 으로 롤백. `db-scale-probe` 는 **`User.userId 1행(최대 769자)`** 로 지목한다 | 그 사본은 폐기(임시 디렉토리) · 소스 사본 md5 무변 |
| **T5** grant 없는 삭제 라우트 | (변이가 아니라 **현재 상태**다 — U1 미부착) | **500** & 같은 시점 `--db mysql --parity` **green** | `SHOW GRANTS`(**`news_app`**): `news`·`news_stage` 에 `DELETE` **없음**(있는 것은 `news_grant_probe.receiverconfig` 1줄). **500 관측 = `NewsAppMysqlWireTest`**(DB **`news_stage`** · 자격 **`news_app`**)가 grant 부재 분기에서 **500 · `internal-error` · `changes:1` 아님**을 단언하며 `clean verify` **1522 green**. 같은 시점 **`--db mysql --parity` 313관측 diffs 0 green**(DB **`harness_ct_<16hex>`** · 자격 **`news_ct`=ALL**) | 원복 없음(상태 관측) · `news_stage` 에 **행을 더하거나 지우지 않았다**(⚠ 단, AC 3 의 `clean verify` 자체가 그 스모크로 9행을 더한다 — 기존에 문서화된 동작이고 삭제는 0이다) |
| **T6** 적재된 대상에 `migrate` 재실행 | 같은 임시 DB 에 두 번째 `migrate` | **exit 1** + 문구 + 소스·대상 무변 | **exit 1** · `대상이 비어 있지 않다 [User, Article, Contents, ArticleHistory, Photo] — 비우고 다시 넣지 않는다.` · 대상 `COUNT(*)` **전건 동일**(11/77/77/12/1) · 소스 md5 무변 · 그 뒤 `verify` **exit 0 일치** | **(나) 무삭제 복구 실측**: 새 빈 DB 생성 → `migrate` **exit 0 · 178행** → `verify` **exit 0 일치**. **부분 적재 DB 는 그대로 남는다**(증거 보존) |

> **T5 의 두 축을 섞지 마라.** 「500」은 **`news_stage` · `news_app`** 에서 나오고 「parity green」은
> **`harness_ct_*` · `news_ct`(ALL)** 에서 나온다. 같은 시점에 둘 다 참이라는 것이 이 축의 전부다 —
> **패리티 green 은 grant 부재를 덮는다.**

### 7-7. 운영 사본이 오면 — **같은 커맨드로 재측정**한다

1. 사용자가 운영 서버를 내린 뒤 사본을 뜨고 **리포 밖 경로**를 알려 준다(§0-2묶음 · Q3).
2. `node scripts/db-scale-probe.mjs --source <사본> --json <리포 밖>/scale.json` → **§7-3 의 「운영값」 열을 채운다.**
   **768자 초과 PK 가 1건이라도 나오면 거기서 멈추고** step9 와 함께 처분을 정한다(이관이 서지 않는다).
3. `node scripts/load-rehearsal.mjs --source <사본> --work <리포 밖>` **2회** → **§7-2 의 시간을 갈아 끼운다**
   (2회를 재고 두 값을 모두 적는다 — 평균 하나만 적으면 흔들림이 보이지 않는다).
4. §7-5 의 계산식에 새 ③ 을 넣어 **정지 창을 확정**하고 §0-9묶음에 적는다.
5. 그 사본에는 운영 계정만 있으므로 로그인 판정은 `NEWS_REHEARSAL_USER`/`NEWS_REHEARSAL_PASSWORD`
   (환경변수 · **argv 금지**)로 준다. 계정을 못 받으면 **6번(Node 기동 판정)이 로그인에서 멈춘다** — 그 사실을 적고 넘어가지 마라.

### 7-8. 이 절이 보지 않는 것

- **운영 `news` DB 로의 실제 적재** — excluded (a). 이 절은 임시 DB(`harness_ct_*`)만 대상으로 했다.
- **`uploads/` 복사·검증** — 파일은 DB 밖이고 컷오버는 **같은 `DATA_DIR` 을 그대로 쓴다**(ADR-017 결정 5).
  운영 `uploads/` 의 파일 수·바이트는 여전히 **미상**(§0-2묶음).
- **부트 백필 2종**(`backfillEmptyDepartments`·`backfillHistoryTitles`) — 값을 **바꾸는** 동작이라 100% 대조와
  섞을 수 없다(excluded (e)). Node 기동 판정에서 **산출물 md5 가 부팅 전후 동일**했다는 사실이 「이 사본에서는
  백필이 아무것도 쓰지 않았다」는 뜻이고, **운영 데이터에서도 그렇다는 보장은 아니다**.
- **이관 중 단절·재시작에서의 복구** — 트랜잭션 롤백에 기대며 인위적으로 끊어 보지 않았다(75 미검증 ⑧).
- **마이그레이터 실패 메시지의 진단력** — T4 가 드러낸 공백(1406·컬럼 이름 부재)은 **고치지 않았다**
  (이 step 은 `SchemaGuard` 문구 하나만 고친다). 후속 판단 항목이다.

### 7-9. 리뷰 후속 (2026-09-09 · 읽기 전용 리뷰 5렌즈 → 확정 4 · 반박 1)

| # | 지적 | 처분 | 실측 |
|---|---|---|---|
| 1 | `parseVerifyReport` 가 표 줄을 하나도 못 읽어도 `불일치 0`·`구조 0` 으로 **green** 이 된다(규모 수치만 0으로 접힌다) | **사실** → 헤더 총계(`대조 테이블 수`·`소스/대상 총 N행`)와 표 줄을 **교차 검사**(`parseIncomplete`) · 어긋나면 `matched:false` (호출자가 잊어도 걸린다) | 자기검사 **7 → 10**(신규 3건 red 먼저) · 표 줄 전멸/일부 전멸/헤더 줄 부재 3형 · 재실행 **7테이블 178행 81컬럼 2,878셀 · 불일치 0 · exit 0** |
| 2 | 마이그레이터(java) 자식이 `ctx.children` 에 없어 SIGINT 가 죽이지 못한다(step7 과 같은 계열) | **사실** → `runMigrator` spawn 직후 등록 + `error` 에서 `spawnError` 설정 | 콘솔 밖 SIGINT 타임라인(100ms 샘플 · migrate 중): 수정 전 동기 드롭 구간에 **migrator=2**(고아 migrate + 드롭 자식) → 수정 후 **migrator=1**(드롭 자식만) · 양쪽 다 exit 130 · 잔존 `harness_ct_*` **0** |
| 3 | 768 경계 픽스처가 전부 ASCII 라 「글자↔바이트」 회귀를 못 잡는다 | **사실** → **한글 768자**(chars 768 · **bytes 2,304**)를 초과 아님으로, 한글 769자를 초과로 단언 | 자기검사 **9 → 10** · 구현을 `stats.bytes` 로 임시 변이 → **새 픽스처만 red**(기존 9건은 전부 green — 공백이 실재했다) → 원복 후 10/10 |
| 4 | `--keep` 가 죽은 플래그다(`opts.keep` 을 읽는 곳이 없고 `fs.rm*` 도 없다) | **사실** → 플래그·설명 제거. 대신 「**언제나 보존**한다」를 USAGE 에 남긴다(정리 로직을 새로 만들지 않는다) | `--keep` 은 이제 `알 수 없는 인자` 로 즉시 거부된다 |
| 반박 | §7-3 T4 진단 공백에 주인이 없다 | **코드·문서 무수정** — 그 문장은 계획서(step8.md)가 step9 를 가리킨 것이고, T4 의 CLI 문구 개선은 그 대상이 아니다. 인계는 step10 `forward_notes` 로 | — |

> **교훈**: 파서의 「문제 0」은 **문제가 없다**가 아니라 **읽지 못했다**일 수 있다. 출력을 읽는 판정부에는
> **자기 일관성 검사**(헤더 총계 ↔ 상세 줄)를 같이 넣어야 형식 변경이 조용한 green 으로 바뀌지 않는다.
> 그리고 **ASCII 픽스처만으로는 「글자냐 바이트냐」를 잠글 수 없다** — 한글·이모지 픽스처가 그 자리의 방어선이다.

## 8. 잔여 결정 — 커넥션 풀 1 천장 · `User.userId` 769자 · 이월 (step9)

> **이 절의 결론은 「둘 다 바꾸지 않는다」이고, 그 판단의 근거는 문장이 아니라 숫자다.**
> 풀을 늘리지 않았다는 사실은 `git diff -- server-spring/src/main/java/harness/news/db/NewsDataSource.java` 가
> **무출력**인 것으로, 769자 축에 검증을 넣지 않았다는 사실은 `UserService.create` 가 **0줄** 바뀐 것으로 증명된다.

### 8-1. 도구 — `scripts/pool-ceiling-probe.mjs` (기본 스위트 밖)

```bash
# 자격은 argv 가 아니라 환경변수다(NEWS_CT_MYSQL_URL/_USERNAME/_PASSWORD · 한 줄씩)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" \
  node scripts/pool-ceiling-probe.mjs --axis all --out-dir <리포 밖 디렉토리>
# 축을 따로: --axis load | sse | timeout | userid  (--rounds 는 기본 2)
node --test scripts/lib/poolProbe.self-test.mjs        # 순수 판정부 자기검사 12건(프로브가 시작 시 스스로 돌린다)
```

- **`mvnw verify`·`npm test` 는 이 파일을 돌리지 않는다.** 부하를 기본 스위트에 넣으면 매 빌드가 늘어지고,
  늘어진 게이트는 사람이 건너뛴다(step9 금지사항). **다른 무거운 작업과 동시에 돌리지 마라** — 겹치면
  재는 것이 서버가 아니라 이 머신이다.
- 대상은 **임시 인스턴스**뿐이다: 서버별 임시 `DATA_DIR`(스키마·시드는 `src/db/**`) + Spring 은 임시 MySQL DB
  `harness_ct_<16hex>`(끝나면 드롭). 리포 `news.db`·`uploads/` 는 실행 전후 스냅샷으로 무변을 단언한다.
- **프로브 자신의 비공허성**을 함께 잰다: 계단마다 **실제 동시 실행 최댓값**을 세고 목표에 못 미치면 실패로 만든다
  (변이 U2 — 순차 실행으로 바꾸면 exit 1). 동시 1에서 5xx 가 나오면 그것도 실패다(천장이 아니라 환경 결함이다).

### 8-2. 측정표 (2026-09-09 · 임시 인스턴스 · **계단마다 2회 · 두 값 모두**)

Node 는 언제나 SQLite(단일 프로세스·동기)이고 Spring 은 MySQL·**풀 1**이다 — **축이 다르다는 사실을 지우지 않는다.**
두 서버는 **같은 요청 구성**을 받는다(동시 32 쓰기 축의 상태 분포가 양쪽 다 `200` 170건 · `403` 86건으로 동일하다 —
사과와 사과를 비교한 것이다). 단위는 ms.

**① 읽기 위주** (요청 = 동시 수 × 8 · 계단마다 2회 · 두 값을 모두 적는다)

| 대상 | 동시 | 요청 | p50 (1회/2회) | p95 (1회/2회) | 최대 (1회/2회) | 5xx | 실제 동시 |
|---|---|---|---|---|---|---|---|
| Node(SQLite) | 1 | 8 | 3 / 3 | 4 / 3 | 4 / 3 | 0 | 1 / 1 |
| Node(SQLite) | 2 | 16 | 4 / 4 | 7 / 5 | 7 / 5 | 0 | 2 / 2 |
| Node(SQLite) | 4 | 32 | 8 / 9 | 11 / 13 | 11 / 13 | 0 | 4 / 4 |
| Node(SQLite) | 8 | 64 | 20 / 18 | 24 / 25 | 26 / 27 | 0 | 8 / 8 |
| Node(SQLite) | 16 | 128 | 30 / 31 | 32 / 33 | 40 / 36 | 0 | 16 / 16 |
| Node(SQLite) | 32 | 256 | 57 / 56 | 60 / 57 | 113 / 58 | 0 | 32 / 32 |
| Spring(MySQL · 풀 1) | 1 | 8 | 6 / 5 | 15 / 7 | 15 / 7 | 0 | 1 / 1 |
| Spring(MySQL · 풀 1) | 2 | 16 | 7 / 7 | 8 / 9 | 8 / 9 | 0 | 2 / 2 |
| Spring(MySQL · 풀 1) | 4 | 32 | 12 / 10 | 15 / 14 | 17 / 14 | 0 | 4 / 4 |
| Spring(MySQL · 풀 1) | 8 | 64 | 21 / 16 | 32 / 21 | 38 / 25 | 0 | 8 / 8 |
| Spring(MySQL · 풀 1) | 16 | 128 | 30 / 28 | 42 / 38 | 47 / 47 | 0 | 16 / 16 |
| Spring(MySQL · 풀 1) | 32 | 256 | 49 / 47 | 79 / 76 | 123 / 106 | 0 | 32 / 32 |

**② 쓰기 혼합** (요청 = 동시 수 × 8 · 계단마다 2회 · 두 값을 모두 적는다)

| 대상 | 동시 | 요청 | p50 (1회/2회) | p95 (1회/2회) | 최대 (1회/2회) | 5xx | 실제 동시 |
|---|---|---|---|---|---|---|---|
| Node(SQLite) | 1 | 8 | 20 / 15 | 45 / 19 | 45 / 19 | 0 | 1 / 1 |
| Node(SQLite) | 2 | 16 | 17 / 21 | 31 / 38 | 31 / 38 | 0 | 2 / 2 |
| Node(SQLite) | 4 | 32 | 44 / 46 | 49 / 51 | 50 / 54 | 0 | 4 / 4 |
| Node(SQLite) | 8 | 64 | 89 / 83 | 103 / 96 | 109 / 108 | 0 | 8 / 8 |
| Node(SQLite) | 16 | 128 | 173 / 179 | 205 / 216 | 214 / 226 | 0 | 16 / 16 |
| Node(SQLite) | 32 | 256 | 337 / 336 | 503 / 368 | 522 / 392 | 0 | 32 / 32 |
| Spring(MySQL · 풀 1) | 1 | 8 | 11 / 9 | 14 / 12 | 14 / 12 | 0 | 1 / 1 |
| Spring(MySQL · 풀 1) | 2 | 16 | 15 / 12 | 33 / 20 | 33 / 20 | 0 | 2 / 2 |
| Spring(MySQL · 풀 1) | 4 | 32 | 29 / 26 | 41 / 40 | 44 / 46 | 0 | 4 / 4 |
| Spring(MySQL · 풀 1) | 8 | 64 | 67 / 47 | 159 / 84 | 204 / 111 | 0 | 8 / 8 |
| Spring(MySQL · 풀 1) | 16 | 128 | 115 / 98 | 1088 / 186 | 1211 / 265 | 0 | 16 / 16 |
| Spring(MySQL · 풀 1) | 32 | 256 | 216 / 181 | 429 / 379 | 651 / 490 | 0 | 32 / 32 |

**③ 읽기 + SSE 3연결** (요청 = 동시 수 × 8 · 계단마다 2회 · 두 값을 모두 적는다)

| 대상 | 동시 | 요청 | p50 (1회/2회) | p95 (1회/2회) | 최대 (1회/2회) | 5xx | 실제 동시 |
|---|---|---|---|---|---|---|---|
| Node(SQLite) | 1 | 8 | 4 / 3 | 9 / 4 | 9 / 4 | 0 | 1 / 1 |
| Node(SQLite) | 2 | 16 | 5 / 4 | 5 / 5 | 5 / 5 | 0 | 2 / 2 |
| Node(SQLite) | 4 | 32 | 8 / 8 | 11 / 9 | 12 / 9 | 0 | 4 / 4 |
| Node(SQLite) | 8 | 64 | 23 / 20 | 38 / 23 | 40 / 25 | 0 | 8 / 8 |
| Node(SQLite) | 16 | 128 | 35 / 45 | 44 / 48 | 57 / 50 | 0 | 16 / 16 |
| Node(SQLite) | 32 | 256 | 63 / 65 | 68 / 109 | 92 / 114 | 0 | 32 / 32 |
| Spring(MySQL · 풀 1) | 1 | 8 | 6 / 6 | 15 / 6 | 15 / 6 | 0 | 1 / 1 |
| Spring(MySQL · 풀 1) | 2 | 16 | 7 / 7 | 9 / 8 | 9 / 8 | 0 | 2 / 2 |
| Spring(MySQL · 풀 1) | 4 | 32 | 12 / 12 | 16 / 17 | 19 / 17 | 0 | 4 / 4 |
| Spring(MySQL · 풀 1) | 8 | 64 | 21 / 17 | 33 / 23 | 36 / 28 | 0 | 8 / 8 |
| Spring(MySQL · 풀 1) | 16 | 128 | 31 / 26 | 44 / 40 | 61 / 51 | 0 | 16 / 16 |
| Spring(MySQL · 풀 1) | 32 | 256 | 52 / 49 | 77 / 83 | 104 / 102 | 0 | 32 / 32 |

**③ 쓰기 + SSE 3연결** (요청 = 동시 수 × 8 · 계단마다 2회 · 두 값을 모두 적는다)

| 대상 | 동시 | 요청 | p50 (1회/2회) | p95 (1회/2회) | 최대 (1회/2회) | 5xx | 실제 동시 |
|---|---|---|---|---|---|---|---|
| Node(SQLite) | 1 | 8 | 15 / 18 | 27 / 21 | 27 / 21 | 0 | 1 / 1 |
| Node(SQLite) | 2 | 16 | 19 / 18 | 32 / 33 | 32 / 33 | 0 | 2 / 2 |
| Node(SQLite) | 4 | 32 | 47 / 48 | 53 / 50 | 55 / 51 | 0 | 4 / 4 |
| Node(SQLite) | 8 | 64 | 97 / 88 | 116 / 104 | 124 / 104 | 0 | 8 / 8 |
| Node(SQLite) | 16 | 128 | 189 / 177 | 219 / 199 | 235 / 207 | 0 | 16 / 16 |
| Node(SQLite) | 32 | 256 | 363 / 356 | 397 / 409 | 417 / 420 | 0 | 32 / 32 |
| Spring(MySQL · 풀 1) | 1 | 8 | 16 / 11 | 30 / 15 | 30 / 15 | 0 | 1 / 1 |
| Spring(MySQL · 풀 1) | 2 | 16 | 14 / 13 | 22 / 23 | 22 / 23 | 0 | 2 / 2 |
| Spring(MySQL · 풀 1) | 4 | 32 | 36 / 35 | 53 / 60 | 54 / 69 | 0 | 4 / 4 |
| Spring(MySQL · 풀 1) | 8 | 64 | 56 / 60 | 95 / 98 | 138 / 148 | 0 | 8 / 8 |
| Spring(MySQL · 풀 1) | 16 | 128 | 126 / 120 | 189 / 209 | 300 / 243 | 0 | 16 / 16 |
| Spring(MySQL · 풀 1) | 32 | 256 | 228 / 190 | 423 / 390 | 533 / 496 | 0 | 32 / 32 |

> **[step10 리뷰 후속 재실행 · 2026-09-09]** 판정부가 **전송 계층 실패(`status:0`)를 세지 않고 분위수에만 섞고 있었다**
> (읽기 전용 리뷰 확정 3번). 고친 뒤(`transportFailures`·`measured` 신설 · 자기검사 12 → **15**) **프로브를 1회 다시 돌렸다**:
> **96계단 전부 `전송실패 0` · `측정 = 요청` · 5xx 0** — 즉 **위 표가 감추고 있던 실패는 없었고 판정은 그대로다.**
> 다만 그 회차의 **절대값은 위 표와 다르다**(머신 부하가 달랐다 — 예: `read+sse` Node 동시 32 p50 63 → **181 ms** ·
> Spring 51 → **198~210 ms**). **표는 갈아 끼우지 않았다** — 위 표는 step9 의 2회 측정이고 이 문단은 그 뒤의 재실행이다.
> 판정(5xx 0 · 동시 32까지 천장 미관측 · 쓰기에서 Spring 이 느리지 않다)은 **두 세션 모두 같다**.

- **전 축·전 계단에서 5xx 0건**이다. 두 회차가 서로 붙는다(꼬리 하나 예외: 쓰기 동시 16 Spring 1회차 p95 1,088 ms ·
  최대 1,211 ms — 2회차는 186/265 ms 다. 같은 계단의 다른 회차와 20% 이내로 붙지 않는 유일한 자리이고,
  **평균만 적었으면 보이지 않았을 값**이다).
- **풀 1 의 Spring 이 이 규모에서 Node 보다 느리지 않다.** 쓰기 축은 오히려 Spring 이 빠르다(동시 32 p50 181~216 ms
  vs Node 336~337 ms). SSE 3연결을 열어 둔 축도 같은 그림이다.

### 8-3. 30초 경계 — **재현해서 실측했다**

부하만으로는 이 경계에 닿지 않는다(아래 8-4의 산술). 그래서 **저장소 쪽에서** 만들었다: 외부 MySQL 세션이
`START TRANSACTION; SELECT … FOR UPDATE` 로 `Contents` 한 행을 쥐고 있는 동안 Spring 에 그 행을 건드리는
요청(`POST /api/articles/:id/lock`)을 보내면, 그 요청이 **유일 커넥션을 쥔 채** 잠금 대기에 들어간다.

| 관측 | 값 |
|---|---|
| 잠금에 막힌 앞 요청 | **43,102 ms** 뒤 **200**(외부 세션이 커밋하자 성공한다 — 실패가 아니라 **정지**다) |
| 그동안 보낸 무관한 요청(`GET /api/articles`) | **41,597 ms** 뒤 **500** |
| Hikari 예외(로그 1건) | `SQLTransientConnectionException: news-db - Connection is not available, request timed out after **30001ms** (total=1, active=1, idle=0, waiting=0)` |
| 그 500 의 **응답 본문 모양** | 키 `error·path·status·timestamp` — **앱 계약의 `{ok:false, reason}` 이 아니다**(컨테이너 기본 오류 JSON) |
| Node 대응물 | **없다.** 단일 프로세스·동기 SQLite 라 커넥션 풀·획득 대기라는 개념이 없다 |

> **두 가지가 이 관측의 핵심이다.** ① 풀이 마르면 나가는 것은 **계약 밖 응답**이다 — 클라이언트는 `reason` 토큰으로
> 분기하는데 그 자리에 `error/path/status/timestamp` 가 온다. ② **클라이언트 대기는 30초보다 길 수 있다**:
> 예외는 **30,001 ms** 에 났는데 클라이언트가 500 을 받은 것은 **41.6초** 뒤였다.
>
> **[step10 정정 · 2026-09-09 — 읽기 전용 리뷰 확정 2건]**
> **(가) ①의 원인은 「지속적 풀 경합」이 아니라 구조적 공백이다.** `PathPolicyFilter`(`server-spring/src/main/java/harness/news/web/PathPolicyFilter.java` **64행**)는
> **DispatcherServlet 앞에서 도는 raw 서블릿 필터**인데 그 줄에서 `sessions.touchSession(token)` → `SessionGuard.rederive()` → `UserRepository.findById()` 로
> **DB 를 치고 `try/catch` 가 없다**. 게다가 `WebConfig.register()`(165~170행)가 `setDispatcherTypes` 를 부르지 않아
> 필터는 **`DispatcherType.REQUEST` 전용**이다(모듈 전체에 `setDispatcherTypes`·`@WebFilter` **0건** — 확인). ⇒ **풀 고갈뿐 아니라
> 순간적 연결 blip·MySQL 지연 등 「어떤 DB 장애든」** 그 자리에서 `GlobalErrorHandler` 를 거치지 못하고 **컨테이너 기본 JSON** 이 나간다.
> SPA `httpModel.js` 는 `ok`/`reason` 을 읽으므로 그 응답을 **분류하지 못한다**. **계약 스위트는 이 경로에 DB 예외를 유도하지 않아 구조적으로 못 본다.**
> **(나) 11.6초의 공백에 대한 기계적 설명은 철회한다.** 초안은 「오류 디스패치가 같은 커넥션을 다시 기다렸다 — 잠금이 풀린 순간에야 나갔다」로 적었으나
> 필터가 REQUEST 전용이라 ERROR 디스패치에서 **다시 돌지 않고**, 무엇보다 **위 표 자신이 반증한다**: 잠금을 쥔 요청은 **43,102 ms 에 200** 인데
> 대기 요청의 **500 은 41,597 ms** 로 **1,505 ms 먼저** 나갔다. 사실만 남기면 **「30,001 ms 에 예외가 났고 클라이언트 수신은 41.6초였다 —
> 그 사이의 기계적 원인은 미확정」** 이다. 그리고 인증 확인이 **필터에서 한 번, 컨트롤러에서 한 번** 일어나므로
> **최악 대기는 30초의 배수일 수 있다**(미측정).
> **이 정정은 문서만 바꾼다 — 런타임 0줄이다**(처방은 `phases/76-spring-cutover/index.json` `forward_notes` (6): 필터 본문을 감싸
> 계약 shape 을 내보내되 **와이어 테스트로 DB 예외를 주입해 red→green** 을 만든 뒤 별도 커밋으로).

### 8-4. 판정 — **풀 1 을 유지한다**(확대는 이 phase 가 하지 않는다)

1. 측정 범위(**동시 32**)까지 **천장이 관측되지 않았다** — 5xx 0건 · p95 최대 429 ms(쓰기).
2. **요청 동시성만으로는 30초 천장에 닿지 않는다.** 읽기 p50 **6 ms**(동시 1 · Spring) 기준으로 30초를 채우려면
   큐에 **약 5,000건**이 서야 하는데, Tomcat 기본 스레드는 **200**이라 그 깊이가 서지 않는다(200 × 6 ms ≈ **1.2초**).
   쓰기(p50 9~11 ms)로 계산해도 200 × 11 ms ≈ 2.2초다.
3. 천장에 닿는 경로는 **「커넥션 하나가 오래 잡히는 사건」**이다(8-3 — 행 잠금 대기·느린 쿼리·긴 트랜잭션).
   **그때는 그 한 사건이 서버 전체를 30초 뒤 500으로 만든다.**
4. **[step10 정정]** 그리고 **계약 밖 500 은 풀 고갈에만 딸린 현상이 아니다** — 인증 필터가 DispatcherServlet **밖에서**
   DB 를 치고 그 예외에 방어가 없어(8-3 (가)) **어떤 DB 장애든** 같은 모양이 된다. 즉 이 축은 「풀 크기」 문제가 아니라
   **오류 경로의 구조** 문제이고, 풀을 늘려도 사라지지 않는다.

> **⚠ 알려진 한계 — 운영자가 알고 전환해야 하는 것(런북 §0 낭독 대상)**
> - **DB 쪽에서 한 요청이 오래 막히면 그 사이 모든 요청이 순서를 기다린다.** 30초를 넘긴 요청은 500이고
>   그 500은 **계약 밖 본문**이다(8-3). Node 에는 이 형태의 정지가 없었다(단일 프로세스라 요청이 서로를
>   기다리는 방식이 다르다).
> - **[step10 정정] 계약 밖 500 의 주체는 인증 필터다.** `PathPolicyFilter` 가 DispatcherServlet 밖에서 DB 를 치고
>   예외 방어가 없어 **풀 고갈이 아니어도**(연결 blip·DB 지연) 같은 모양이 나온다 — 그리고 **계약은 그것을 못 본다**.
> - **최악 대기는 30초가 아닐 수 있다**: 인증 확인이 **필터 + 컨트롤러 두 번** 일어나므로 대기가 겹치면 배수가 된다(미측정).
>   실측된 것은 「예외 30,001 ms · 클라이언트 수신 41.6초」 두 값뿐이고 그 사이의 원인은 **미확정**이다.
> - 그래서 **컷오버 후 첫 주에 볼 것**은 평균 응답시간이 아니라 **500의 유무**와 **응답시간의 꼬리**다.
> - 이 측정은 **178행 표본 · 동시 32까지**다. 운영의 실제 동시 접속 수는 **미상**(§0-7묶음 · 조사표 1·7)이므로
>   "여유가 있다"는 문장은 **그 범위 안에서만** 참이다.
> - **풀을 늘리는 것은 이 phase 의 답이 아니다**(excluded (j)). 늘리려면 별도 ADR + `LogsStreamWireTest` 항목 22
>   재설계 + 잠금 순서 재검증이 함께 와야 한다(U1 이 그 방어선이 실재함을 실측했다 — 8-7).

### 8-5. `User.userId` 769자 — 처분: **고치지 않는다**(성격이 바뀌었을 뿐이다)

`POST /api/users` 로 두 서버에 같은 값을 보내 실측했다(값 원문은 어디에도 싣지 않는다 — 길이만 남긴다 · 2회 동일):

| 케이스 | 글자 | 바이트 | Node(SQLite) | Spring(MySQL) |
|---|---|---|---|---|
| ASCII 768자 | 768 | 768 | 200 | **200** |
| ASCII 769자 | 769 | 769 | 200 | **500** `internal-error` |
| **한글 768자** | 768 | **2,304** | 200 | **200** |
| 한글 769자 | 769 | 2,307 | 200 | **500** `internal-error` |

> **⚠ 계획서와 달랐던 지점 — 768은 「바이트」가 아니라 「글자」다.** step9 계획서(금지사항 마지막 줄)는
> 「768은 **바이트** 상한이다」라고 적었다. **실측은 반대다**: 한글 768자는 **2,304바이트**인데 통과하고,
> 한글 769자에서 비로소 1406이 난다. 768이라는 숫자가 utf8mb4 인덱스 상한 3072바이트/4 에서 왔기 때문에
> 생긴 오해이고, 경계 자체는 `VARCHAR(768)` = **768 글자**다. (step8 리뷰가 같은 판정을 냈고 이 실측이 확정했다.)

- **왜 안 고치는가**: 400 + 사유 토큰으로 고치려면 **Node 응답도 함께 바뀌어야** 계약이 성립하는데 그것은 계약
  변경이다(excluded (k) · ADR-016 트레이드오프 ④). `UserService.create` 에 길이 검증을 넣지 않았다(**0줄**).
- **성격은 바뀌었다**: 컷오버 전에는 「Node 200 / Spring 500」이라는 **divergence**였지만, 컷오버 후에는 정본이
  Spring 하나뿐이라 비교 대상이 사라진다 — 그냥 **입력 길이 한계**이고 그 사실을 사람이 알아야 한다.
  `docs/db-mysql-mapping.md` 축 8·§7 ④·§7-1을 그 시점 문장으로 갱신했다.
- **실패는 조용하지 않다**(고칠 필요가 없다는 뜻이다): 그 500과 함께 서버 로그에 한 줄이 남는다 —
  `GlobalErrorHandler : POST /api/users org.springframework.dao.DataIntegrityViolationException: PreparedStatementCallback;`
  `SQL [INSERT INTO User (userId, name, password, role, department, departmentCode, active) VALUES (?, ?, ?, ?, ?, ?, ?)];`
  `Data truncation: Data too long for column 'userId' at row 1`. **컬럼 이름이 있고 값은 없다**(SQL 은 자리표시자다) —
  진단 가능하고 비밀·값이 새지 않는다. 그래서 로그 문구도 **0줄** 고쳤다.
- **나머지 두 텍스트 PK 는 사용자 입력에서 오지 않는다 — 코드로 재확인했다**(추정이 아니다):
  `Article.articleId`·`Contents.articleId` 는 `ArticleWriteService.create` **96행**이 `generateArticleId()` 로
  발급하고(`ArticleIds.generate` = `AKR` + UTC `YYYYMMDD` + 9자리 = **언제나 20자**), 클라이언트가 보낸
  `articleId` 는 **화이트리스트 밖이라 저장 문장에 들어가지 못한다**(`ARTICLE_FIELDS` = title·markupVersion·modifier ·
  `CONTENTS_FIELDS` 16개 — 둘 다 `articleId` 를 포함하지 않는다). Node 도 같은 모양이다
  (`src/services/articleService.js` 148행 `generateArticleId(db)` · 같은 두 화이트리스트 18·20행).
  ⇒ **768 초과가 도달 가능한 텍스트 PK 는 `User.userId` 하나뿐이다.**
- **운영 경고(런북·관리자 안내에 그대로 옮길 문장)**: **사용자 아이디는 768글자를 넘길 수 없다.**
  넘기면 저장이 실패하고(서버 500) 계정이 만들어지지 않는다. 한글도 **글자 수**로 센다(바이트가 아니다).
  운영 데이터에 이미 그런 행이 있으면 **이관 자체가 1406으로 막히므로** 컷오버 차단 항목이다 —
  판정 커맨드는 `node scripts/db-scale-probe.mjs --source <사본>`(§7-3)이고 표본에서는 **최대 20자 · 초과 0건**이다.

### 8-6. 그 밖의 이월 — 기록만 한다

| 항목 | 판단 | 근거 |
|---|---|---|
| `DistributionTargetService.checkName` 의 `String.trim()` → `NodeString.trim` 수렴 | **고치지 않는다 — 세 번째 이월이다**(74 → 75 → 76) | 235행이 여전히 `text.trim()` 이다. Java `trim()` 은 `U+0020` 이하만 걷고 JS `trim()` 은 유니코드 공백(`U+00A0`·`U+FEFF`·`U+2028` …)까지 걷는다 ⇒ 그런 문자가 섞인 이름에서 **저장 값이 갈린다**. 이 phase 의 규율은 「런타임 코드 0줄」이고, 고치면 저장 값이 바뀌므로 계약 관측 + 단위 테스트를 함께 세워야 한다. `NodeString` 은 이미 있다(같은 패키지 · 37행) — **다음 phase 의 첫 항목으로 올려라** |
| `helmet` 등가 보안 헤더 **11종**(HSTS·nosniff·frame-options 등 10종 + `/api` 응답 CSP) | **두 phase 연속 이월**(75 → 76) — excluded (d) | SPA 문서·자산의 CSP 1종만 step2 가 이식했다(§2). `/api` 응답에는 **보안 헤더가 없다** — step3 대조기가 그 사실을 관측·리포트에 **보이게** 남기고(허용 diff 516건), 런북 §0 낭독과 §10 분기가 운영자에게 알린다 |
| 부트 백필 2종(`backfillEmptyDepartments`·`backfillHistoryTitles`) 미이식 | **컷오버 후 판단**(excluded (e)) | 값을 **바꾸는** 동작이라 100% 대조와 섞을 수 없다. step8 리허설에서 **export 산출물 md5 가 Node 부팅 전후 동일**했다 = 그 사본에서는 백필이 아무것도 쓰지 않았다(운영 데이터에서도 그렇다는 보장은 아니다 — §7-8) |

### 8-7. 변이 전건 결과표 (기대 / 실제 / 원복)

| 변이 | 심은 것 | 기대 | 실제 | 원복 |
|---|---|---|---|---|
| **U1** `MAX_POOL_SIZE` 1 → 10 | `NewsDataSource.java` 49행 상수 | 항목 22가 **red** 또는 **조용히 통과**(후자면 그 자체가 발견) | **red 다 — 그리고 실패 메시지가 정확하다**: `LogsStreamWireTest` **22 tests / 1 failure** · `aPushWaitingForTheOnlyDbConnectionDoesNotStallEveryOtherRequest:764 → awaitConnectionWaiter:1128` = `구독 콜백이 커넥션을 기다리지 않는다 — 사슬이 성립하지 않아 이 테스트가 공허해진다`. **방어선이 스스로 「나는 이제 공허하다」고 말한다**(조용히 green 이 되지 않는다) | 1 로 되돌린 뒤 같은 클래스 **22 / 0 green** · 최종 `clean verify` **1522 / 0** · `git diff -- NewsDataSource.java` **무출력** |
| **U2** 부하 프로브를 **순차 실행**으로(동시 수는 그대로 보고) | `runStage` 의 워커 수를 1로 | 천장 미관측 = 프로브 자기검사가 잡는다 | **exit 1 · FAIL 20건**(`동시 요청 수 2/4/8/16/32 를 목표했는데 실제 동시 실행은 최대 1 였다 — 이 계단의 수치는 그 부하의 값이 아니다`). 동시 1 계단은 정상 통과(그 계단에서는 5xx 0) | 원복 후 **바이트 동일**(cmp) · 재실행 green |
| **U3** 768자 → 769자 경계 | ASCII `userId` 1글자 차 | 768 양쪽 200 / 769 Node 200 · Spring 500 | **기대와 정확히 일치**(위 표) · Spring 사유 토큰 `internal-error` · 2회 측정 동일 | 임시 인스턴스라 원복 불필요(임시 DB 드롭 · 잔존 `harness_ct_*` 0) |
| **U4** 같은 경계를 **글자가 아니라 바이트로** 읽는 실수 재현 | 한글 768자(**2,304바이트**)·769자(2,307바이트) | 바이트 상한이면 한글 768자에서 실패해야 한다 | **한글 768자는 200 이다** ⇒ 상한은 **글자**다. 계획서의 「768은 바이트 상한」이 틀렸음을 실측이 확정했다(8-5). 판정부 자기검사가 이 사실을 잠근다(`poolProbe.self-test.mjs` — 기대표를 바이트로 바꾸면 red) | 코드 무수정(관측) |

### 8-8. 이 절이 보지 않는 것

- **32 동시를 넘는 구간과 장시간 부하** — 이 프로브는 짧은 계단만 친다(지속 부하·메모리 누적은 재지 않았다).
- **운영 규모 데이터에서의 성능** — 표본은 178행이다. 보조 인덱스 0의 영향은 큰 테이블에서 커진다(excluded (f)).
- **풀 확대 후의 동작** — 재설계(ADR + 항목 22)가 선행이므로 **측정하지 않았다**. U1 은 「늘리면 무엇이 깨지는지」만 본다.
- **완전 정지 소비자와 SSE 의 상호작용** — 74가 남긴 공백이고 이 절은 **SSE 가 열려 있을 때 풀 경합이 달라지는지**만 봤다(달라지지 않았다).
- **`GET_LOCK` 류의 인스턴스 잠금** — open_questions (9)로 남는다(이 절의 축이 아니다).

## 9. 실행 런북 — 컷오버 당일 (P3판 · step10)

> **이 절은 `docs/ops-mysql.md` §11 을 대체하지 않는다.** 저장소 이관 명령(0 체크리스트 → 1 사전 → 2 계정 →
> **3 `migrate`** → **4 `verify`** → **4-b grant** → 5 Spring 기동 → 6 Node 중단 → 7 롤백 → 8 실패 분기)의 **정본은 §11** 이고,
> 이 절은 그 위에 **P3 전체의 순서**를 얹는다: 수집 스위퍼 · SPA · 클라이언트 · 운영 tick · 육안 확인 · **봉인** · 롤백.
> 겹치는 단계는 명령을 복사하지 않고 **§11-N 을 가리킨다**(명령이 두 곳에 있으면 한쪽이 늙는다).
>
> **읽는 법**: 각 단계는 `무엇을 / 정확한 명령 / 성공 판정 / 실패 시 분기 / 되돌리려면` 다섯을 갖는다.
> 꺾쇠(`<PORT>`·`<DATA_DIR>` …)는 **§0 조사표의 값**이다 — **미상인 채로 시작하지 마라**(그 목록이 §0-2 표다).
> 「기록지에 적는다」고 한 값(봉인 md5·다음 id·스풀 파일 수·스케줄러 작업명)은 이 문서가 아니라 **그날의 작업 기록지**에 적는다.
> `%M%` 은 `"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"` 다. **PowerShell 은 `<` 리디렉션을 지원하지 않는다**(§0-1).

### 9-0. 시작 전 체크리스트 — 하나라도 비면 **시작하지 않는다**

| # | 확인 | 커맨드 / 방법 | 기대 | 비어 있으면 |
|---|---|---|---|---|
| 1 | 백업 2벌 + md5 3값 동일 | §0-1 **U3** · ops §11-1 | 세 값이 같다 | **시작하지 않는다**(복사 중 서버가 살아 있었다는 뜻) |
| 2 | 정지 창 · **롤백 판단 권한자 대기** | §0-9묶음(Q7) | 시간대·길이·사람 이름이 적혀 있다 | 되돌릴 사람이 없으면 되돌림은 실행되지 않는다 |
| 3 | 삭제 예외 grant | `& %M% -u news_app -p -e "SHOW GRANTS"` | ``GRANT DELETE ON `news`.`receiverconfig` `` 한 줄 | 지금은 없어도 된다 — **9-4 에서 붙인다**(테이블이 생긴 뒤에만 붙는다) |
| 4 | 대상 `news` 가 비어 있다 | ops §11-0-6 · 판정은 **`COUNT(*)`** (§0-1 U6) | 테이블 0개 / 행 0 | 부분 적재다 → **U6 (나) 무삭제 경로** |
| 5 | jar 둘 + 화면 산출물 | `ls server-spring/target/*.jar tools/news-migrator/target/news-migrator.jar` · 운영 `web\` 3파일 md5 대조(§0-3묶음) | 존재 · md5 가 리포 `web/dist` 와 같다 | 다르면 **다른 화면을 서빙**하게 된다(대조 하네스도 다른 파일을 비교한 셈이다) |
| 6 | **768자 초과 텍스트 PK 0건** | `node scripts/db-scale-probe.mjs --source <리포 밖 사본>` (§7-3) | `초과 0건` | 1건이라도 있으면 **이관이 1406 으로 막힌다** — 여기서 멈추고 §8-5 로 |
| 7 | 스케줄러 작업 목록 | `schtasks /Query /FO LIST /V` | tick 작업의 **이름·주기·실행 계정·동작**을 §0-6 에 적었다 | 이름을 모르면 **옛 작업이 남아 두 번 돈다** |
| 8 | 부분 적재 복구 절차가 **손에** 있는가 | §0-1 **U6**(기본 = (나) 빈 DB 신설) | 명령을 인쇄·복사해 두었다 | 정지 창의 최빈 실패 분기다 |
| 9 | 스위퍼 전제 | 운영기 Node 런타임(v24) · `sweeper.js`·`lib.js` 복사 · `COLLECTION_TOKEN` 위치(§5-3) | 준비됨 | **수집이 멈춘다**(Spring 에는 watcher 가 없다 — §5) |
| 10 | Spring 자격 3키 로드 절차 | `docs/ops-mysql.md` §3(한 줄씩 · `set -a; .` 금지) | `NEWS_DB_*` 3키 | 기동이 거부된다(설계) |
| 11 | 한글 출력 | java 커맨드에 `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8` | 마이그레이터 메시지가 안 깨진다 | 실패 문구를 읽을 수 없다 |
| 12 | **알려진 한계 낭독**(아래 셋) | 소리 내어 읽는다 | 전원이 들었다 | 모르고 전환하면 사고 뒤에야 알게 된다 |

**낭독 3항 — 전환 전에 소리 내어 읽는다.**

1. **풀 1 천장**: 「이 서버는 DB 커넥션을 **하나**만 쓴다. 평상 부하로는 천장에 닿지 않지만(동시 32까지 5xx 0건),
   **DB 쪽에서 한 요청이 오래 막히면 그 사이 모든 요청이 줄을 선다.** 30초를 넘기면 500이고 그 500의 본문은
   **앱 계약 밖 모양**(`error·path·status·timestamp`)이다. 실측: Hikari 예외 **30,001 ms** · 클라이언트가 실제로 기다린 시간 **41.6초**.
   그러니 컷오버 후 첫 주에 볼 것은 평균 응답시간이 아니라 **500의 유무와 응답시간의 꼬리**다.」(§8-3·§8-4)
2. **보안 헤더**: 「Spring 의 **`/api` 응답에는 보안 헤더가 하나도 없다.** SPA 문서·자산에만 CSP 1종을 실었고
   나머지 **10종**(nosniff·XFO·Referrer-Policy·COOP/CORP 등)과 `/api` 의 CSP 는 **이월**이다 — 3연속 이월이며
   그 차이는 `spa-parity` 리포트에 **허용 diff 516건**으로 보인다.」(§2-3 · `excluded` (d) ②)
3. **단일 인스턴스**: 「**Spring 에는 ADR-012 단일 인스턴스 잠금이 없다.** Node 는 같은 `DATA_DIR` 이면 두 번째가
   `exit 1` 로 죽었지만 **Spring 은 둘 다 뜬다.** 서로 다른 포트로 서버를 두 개 띄우지 마라 — 같은 MySQL·같은 `uploads`·
   같은 `DIST_SPOOL_DIR` 에 붙어 tick 이 양쪽에서 돌면 **같은 기사가 두 번 배부된다**(실측: 동시 tick **5/5 회차** ·
   기사 하나에 **스풀 파일 2개**). 막는 자동 게이트는 **없다 — 지키는 것은 사람이다.**」(§6-5·§6-7)

### 9-1. Node 정지 — **tick 스케줄러를 먼저** 끈다

- **무엇을**: 요청을 받는 프로세스를 0으로 만든다. 순서는 **스케줄러 → 서버**다.
- **명령**:
  ```bat
  schtasks /Change /TN "<기존 tick 작업명>"  /DISABLE
  schtasks /Change /TN "<스위퍼 작업명(있으면)>" /DISABLE
  rem 서버: 콘솔 실행이면 Ctrl+C · NSSM 서비스면
  nssm stop <서비스명>
  ```
- **성공 판정**: `netstat -ano | findstr :<PORT>` 에 LISTENING **0건** · `tasklist | findstr 기사작성기-server` **0건**.
- **실패 시 분기**: 정지가 안 되면 **컷오버를 시작하지 않는다**. **Spring 을 다른 포트로 함께 띄우지 마라**(낭독 3).
- **왜 이 순서인가**: 서버를 먼저 내리면 다음 주기에 tick 이 깨어나 실패로 끝나고(스케줄러 이력·경보 오염), 무엇보다
  **정지 창 한가운데서 프로세스가 다시 뜨는** 길을 열어 둔다.
- **되돌리려면**: 이 시점에는 아무것도 바뀌지 않았다 — `/ENABLE` + 서버 기동이면 원상복구다.

### 9-2. 사본 2벌 + **봉인**(md5 · 크기 · mtime)

- **무엇을**: 되돌림 자산 2벌을 만들고, **그 순간의 `news.db` 를 봉인**한다.
- **명령**(운영 머신 · PowerShell):
  ```powershell
  copy "<DATA_DIR>\news.db" "<백업>\news.db.$(Get-Date -f yyyyMMdd-HHmmss).bak"
  copy "<DATA_DIR>\news.db" "<백업>\news.db.rollback-ready"
  certutil -hashfile "<DATA_DIR>\news.db" MD5
  certutil -hashfile "<백업>\news.db.rollback-ready" MD5
  Get-Item "<DATA_DIR>\news.db" | Select-Object Length, LastWriteTimeUtc
  ```
- **성공 판정**: **md5 세 값이 같다**(실측 606,208 B 사본 2벌에 **173 ms** — ops §12 #1).
- **기록지에 적는다**: `md5` · `Length`(바이트) · `LastWriteTimeUtc`. **이 셋이 봉인값이다.**
- **왜 봉인인가**: 컷오버 뒤에는 **Node 가 실수로 떠서 sqlite 에 쓰는 것을 잡을 수단이 이것뿐**이다.
  Spring 은 MySQL 을 보고, `verify` 는 「Spring 이 정상적으로 쓴 새 행」과 「Node 가 잘못 쓴 행」을 구분하지 못한다.
  **그 파일은 컷오버 이후 영원히 바뀌지 않아야 한다**(§9-8 이 주기적으로 다시 잰다).
- **실패 시 분기**: md5 가 하나라도 다르면 **시작하지 않는다** — 복사 중 서버가 살아 있었다는 뜻이다(9-1 로 돌아간다).
- **되돌리려면**: 해당 없음(복사만 했다 — **원본은 옮기지도 이름을 바꾸지도 지우지도 않는다**).

### 9-3. 이관 — `migrate` → `verify`

- **무엇을**: 사본이 아니라 **운영 `news.db` 를 소스로** 대상 `news` 에 옮기고 100% 대조한다.
- **명령**: `docs/ops-mysql.md` **§11-3**(migrate) · **§11-4**(verify) 그대로. 대상 전환은 URL 치환 한 줄
  (`NEWS_MIGRATOR_URL` 의 `news_stage` → `news`)이고 자격은 **환경변수**다(argv 금지).
- **성공 판정**: `migrate` **exit 0** + 테이블별 행 수·**다음 id** 를 기록지에 캡처 · `verify` **exit 0 · 「판정: 일치」 · 불일치 0 · 구조 문제 0**.
- **시간**(정지 창 산정): 표본 178행에서 `migrate`+`verify`+`export`+`verify` **7.4초**(§7-2 · 2회 7,432/7,302 ms).
  **운영 규모는 미측정이다** — §7-7 절차로 **운영 사본에서 다시 재고** §7-5 계산식으로 창을 확정한다.
- **실패 시 분기**: `대상이 비어 있지 않다 […]` **exit 1** → **U6 (나) 빈 DB 신설(무삭제)** · 1406(769자) → 9-0 #6 을 건너뛴 것이다(§8-5) ·
  `verify` **exit 4**(불일치) → **전환을 멈춘다** · **exit 1**(대조를 못 돌렸다)은 데이터 판정이 아니다(§7-4).
- **되돌리려면**: 아직 되돌릴 것이 없다 — Node 가 여전히 정본이고 대상 DB 만 채웠다. 9-1 을 역순으로 하면 끝이다.
  (대상에 남은 적재분은 지우지 않는다 — 증거다.)

### 9-4. **grant 부착**(root · 테이블이 생긴 지금에야 붙는다)

- **무엇을**: `GRANT DELETE ON news.ReceiverConfig TO 'news_app'@'localhost'`.
- **명령·판정**: §0-1 **U1** (가) 경로 · ops **§11-4-b**. 확인은 `SHOW GRANTS` 에 그 한 줄.
- **왜 지금**: MySQL 은 **테이블 단위 GRANT 를 대상 테이블이 있을 때만** 받는다(그 전에는 `ERROR 1146`).
- **실패 시 분기**: 안 붙인 채로 가면 **기동 성공 · 계약 하네스 green · 수신 설정 삭제만 500**이다(§7-6 T5).
  자동 감지 수단이 없으므로 **육안 체크리스트 A-7** 이 그 자리를 본다.
- **되돌리려면**: `REVOKE` 는 필요 없다(권한을 되돌릴 이유가 없다).

### 9-5. Spring 기동 — **같은 host:port**

- **무엇을**: 방금 내린 Node 와 **같은 주소**로 Spring 을 올린다(클라 config·북마크가 그대로 통하는 이유다).
- **env 표 — 값이 아니라 「어디서 오는가」를 적는다**:

| 키 | 값 | 규율 |
|---|---|---|
| `DATA_DIR` | **기존 값 그대로** | `news.db` 는 열지 않지만 **`<DATA_DIR>/uploads` 를 계속 서빙**한다. 옮기면 기존 첨부·사진이 전부 404(ADR-017 결정 5) |
| `PORT` · `HOST` | **기존 값 그대로** | 포트가 바뀌면 전 PC 의 클라 config 를 고쳐야 한다(= 클라 변경 = 되돌림 속성 상실) |
| `SPA_DIR` | 기존 `web\` 폴더(절대경로) | **`<dir>/index.html` 이 있어야** 활성이다. 빈 값 = 서빙 비활성 |
| `DIST_SPOOL_DIR` | **기존 값 그대로** | 외부 전송기가 걷는 폴더를 바꾸지 않는다. 미설정 = 배부 전면 비활성 |
| `DB_KIND` | `mysql` | 빠지면 기본 `sqlite` 와 URL 이 모순이라 **기동을 거부**한다(설계된 거부) |
| `NEWS_DB_URL` · `_USERNAME` · `_PASSWORD` | ops §3 절차로 셸에 싣는다 | argv·bat 에 값을 두지 않는다 |
| `RCV_SPOOL_DIR` | **주지 않는다** | Spring 은 읽지 않는다(watcher 가 없다). 수집은 **스위퍼**가 한다(9-7) |
| `APP_ENV` | **주지 않는다** | `production` 이면 쿠키가 `Secure; SameSite=None` 이 되어 **평문 HTTP LAN 접속이 죽는다**. 실기 시나리오는 이 함정을 **못 본다**(§3-7 P5) |

- **명령**(한 줄 · 자격은 이미 셸에 있다):
  ```bash
  DATA_DIR=<기존> PORT=<기존> HOST=<기존> SPA_DIR=<기존 web 폴더> DIST_SPOOL_DIR=<기존> DB_KIND=mysql \
    java -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar <배포>/server-spring-0.0.1-SNAPSHOT.jar
  ```
- **성공 판정 — 콘솔에 이 줄들이 보이면 정상이다**(문구는 §9-12 대조표의 실측값):
  1. `o.s.boot.tomcat.TomcatWebServer : Tomcat started on port <PORT> (http) with context path '/'`
  2. `harness.news.NewsServerApplication : Started NewsServerApplication in N seconds`
  3. `com.zaxxer.hikari.pool.HikariPool : news-db - Added connection com.mysql.cj.jdbc.ConnectionImpl@&lt;16진수&gt;`
     ← **이 한 줄이 「mysql 로 붙었다」는 유일한 콘솔 증거다.** sqlite 로 잘못 떴으면 같은 자리에
     `org.sqlite.jdbc4.JDBC4Connection@&lt;16진수&gt;` 가 보인다.
  4. `curl -i http://127.0.0.1:<PORT>/api/health` → **200 `{"ok":true}`**
  **콘솔에 없는 것도 알아 두라**: 바인드 host · SPA 활성 여부 · 스풀 루트는 **콘솔에 찍히지 않는다**(§9-12).
  바인드 범위는 `netstat -ano | findstr :<PORT>` 로, SPA 는 9-6 (b) 로, 스풀은 9-6 (d) 로 판정한다.
- **실패 시 분기**: §9-10 의 포트 점유 · `SchemaGuard` · kind/url 모순 · SPA 404 행.
- **되돌리려면**: Spring 을 내리고 Node 를 다시 올린다. **이 시점에 요청을 한 건도 받지 않았다면 `export` 는 필요 없다**
  (MySQL 에 쓴 것이 없다). 한 건이라도 받았으면 **9-9 로 간다**.

### 9-6. 검증 — 자동 판정부터, 그다음 사람

| # | 무엇을 | 명령 / 방법 | 성공 판정 |
|---|---|---|---|
| a | 살아 있는가 | `curl -i http://127.0.0.1:<PORT>/api/health` | **200 `{"ok":true}`** |
| b | **화면이 서빙되는가** | 브라우저로 `http://<host>:<PORT>/login.do` → 로그인 화면에서 **새로고침**(F5) → 개발자 콘솔(F12) | 화면이 뜨고 **새로고침에도 404 가 아니다**(SPA 폴백) · 콘솔에 **CSP 위반 0** |
| c | 데이터가 왔는가 | 로그인 → 목록 → 상세 1건 | **컷오버 전 기사가 보인다** · 상세 200 |
| d | 배부가 도는가 | 기사 1건 송고 → `<DIST_SPOOL_DIR>/<수신처 폴더>/` 를 본다 | 파일이 **1개** 늘었다(`<articleId>_<stamp>.json`) |
| e | tick 이 도는가 | `powershell -NoProfile -ExecutionPolicy Bypass -File <배포>\tick-distribution-spring.ps1 -BaseUrl http://127.0.0.1:<PORT> -LogFile <배포>\data\tick.log` | **exit 0** · `tick.log` 마지막 줄 `tick ok distributed=<n> …` |
| f | 수집이 도는가 | 스위퍼 `--dry-run` → 후보 수 확인 → `--once` 실행(§5-1) | exit **0** · 기사 1건 증가 · 스풀 파일은 **지워지지 않는다** |
| g | 클라이언트가 붙는가 | 운영 PC 한 대에서 **설정을 고치지 않고** exe 실행 | 주소 입력 화면 없이 로그인 화면 |

> **⚠ `scripts/verify-integration.mjs --server spring` 은 이 자리에서 쓰는 도구가 아니다.**
> 그 스크립트는 **언제나 자기 임시 서버를 띄운다**(이미 떠 있는 서버에 붙는 옵션이 없다 — 2026-09-09 확인).
> 그러므로 이것은 **컷오버 당일의 판정이 아니라 「jar + `web/dist` + 클라 exe 조합이 성립한다」는 사전 자산 점검**이다.
> **정지 창 전날** 개발 리포에서 돌려 exit 0 을 확인해 두고, 당일의 판정은 위 (a)~(g) 로 한다.
> 같은 이유로 `spa-parity`·`spool-parity`·`tick-cutover-probe` 도 **사전 점검용**이다(전부 자기 서버를 띄운다).
> 운영 인스턴스를 향해 돌릴 수 있는 것은 **스위퍼**(`--base`)와 **tick ps1**(`-BaseUrl`) 둘뿐이다.

### 9-7. 스케줄러 — tick **교체**(추가가 아니다) + 스위퍼 등록

- **무엇을**: 배부 tick 작업을 Spring 판으로 **교체**하고, 수집 스위퍼를 **새로 등록**한다. **같은 정지 창 안에서 끝낸다**
  (수집은 운영이 쓰고 있고 — §0-5묶음 「쓴다」 — Spring 에는 watcher 가 없다).
- **명령**: tick = §0-1 **U5** 1~4 그대로(기존 작업 `/DISABLE` → 새 작업 `/Create` · **주기 90초 이상 · 권장 5분**) ·
  스위퍼 = **§5-3** 1~7(1분 주기 · 같은 스풀에 작업은 **하나만** · 「이미 실행 중이면 새 인스턴스를 시작하지 않음」).
- **순서**: **Node 를 내린 뒤에 스위퍼를 켠다.** 반대로 하면(=Node watcher 와 스위퍼가 겹치면) 파일 하나가
  **기사 4건**이 된다(실측: watcher 3 + 스위퍼 1 — §5-5).
- **성공 판정**: (a) 활성 tick 작업이 **정확히 하나**(`schtasks /Query /FO LIST /V`) (b) 한 주기 뒤 `DIST_SPOOL_DIR` 파일이
  **한 벌만** 증가 (c) 두 작업의 「마지막 실행 결과」가 **0** (d) `tick.log` 에 주기마다 한 줄.
- **실패 시 분기**: 두 벌이 늘면 **옛 작업이 살아 있다** → 즉시 하나를 `/DISABLE`(**파일은 지우지 않는다** — 외부 전송기가 이미 읽었을 수 있다) ·
  tick 종료코드 `3`=자격/한도(429면 주기를 늘린다) · `4`=비-Z 또는 스풀 미설정 · `5`=서버 미도달 · `6` 반복=이전 실행 미종료(§6-6) ·
  스위퍼 종료코드 `1`=거부/실패 1건 이상 · `2`=설정·환경(파일을 건드리지 않았다).
- **되돌리려면**: **스위퍼를 먼저 `/DISABLE`**, 그다음 tick 을 옛 작업으로 되살린다(§5-5 · §6-6 5).

### 9-8. 육안 확인 + **봉인 재측정**(하루로 끝내지 않는다)

- **무엇을**: `packaging/체크리스트-육안확인-P3.md` 12항을 돌리고, **§9-2 의 봉인값을 다시 잰다**.
- **명령**(한 줄 · 앱 안에 넣지 마라):
  ```powershell
  $want = "<기록지의 md5>"
  $got  = ((certutil -hashfile "<DATA_DIR>\news.db" MD5)[1] -replace ' ','')
  if ($got -ne $want) { "SEAL BROKEN got=$got"; exit 1 } else { "seal ok"; exit 0 }
  ```
- **성공 판정**: 「봉인 시각의 md5 와 오늘의 md5 가 같다」.
- **주기**: **컷오버 당일 1회로 끝내지 마라** — 당일 · 다음날 · 첫 주는 매일 · 그 뒤 주 1회. 위 한 줄을 작업 스케줄러에
  등록해도 좋다(종료코드 1 을 경보로).
- **실패 시 분기**(=값이 바뀌었다): **그 순간 두 저장소가 갈리기 시작한 것이다.**
  ① `tasklist` 로 Node 프로세스를 찾아 **내린다** ② 파일 `mtime` 으로 **언제부터** 갈렸는지 확인한다
  ③ **롤백 판단자를 부른다**(갈린 구간의 데이터를 어느 쪽으로 살릴지는 사람의 결정이다).
- **되돌리려면**: 해당 없음(측정이다).

### 9-9. 롤백 — 역순 1회

**언제 되돌리는가(판정 기준 · 숫자와 현상으로)**

| 신호 | 임계 | 먼저 할 일 |
|---|---|---|
| `/api/health` 가 200 이 아니다 | **5분 이상** 지속(재기동 1회로 안 낫는다) | 롤백 |
| 로그인·목록·상세 중 하나가 500 | 재기동으로 안 낫는다 | 롤백 |
| **계약 밖 본문의 500**(`error·path·status·timestamp`) | 분당 1건 이상 지속 | **풀 고갈 신호**(§8-3) — DB 쪽 장기 잠금부터 본다. 안 풀리면 롤백 |
| `verify` 불일치(exit 4)를 뒤늦게 발견 | 1건이라도 | 즉시 롤백(데이터 정합이 깨졌다) |
| **봉인값 변화** | 1회라도 | 롤백보다 **먼저** §9-8 분기 조사(어느 쪽이 정본인지부터 정한다) |
| 스풀 파일이 주기당 **두 벌 이상** | 1주기 | 서버 이중 기동 또는 작업 이중(§6-7) — 하나를 끄면 되고 롤백은 아니다 |

**절차**(역순 · 1회)

1. **스위퍼 작업 `/DISABLE`** (먼저! — Node 를 올리면 watcher 가 살아난다 · §5-5)
2. Spring 용 tick 작업 `/DISABLE`
3. **Spring 정지** → `netstat` 으로 `<PORT>` LISTENING 0 확인
4. **컷오버 창 동안 쓰기가 있었다면** `export`: ops **§9-②**(`export --target … --out <리포 밖 새 이름>`) → **§9-③** 무결성 대조
   (`verify --source <산출물> --target …` — **원본 `news.db` 와의 대조가 아니다**. 그것은 이관 직후에만 0 이다)
5. 산출물을 `<DATA_DIR>\news.db` 로 **배치**(기존 파일은 **이름을 바꿔 보관** — 지우지 않는다)
6. **Node 기동**(같은 `PORT`) → `/api/health` 200 → 로그인 · 목록 · 상세 1건
7. 옛 tick 작업 `/ENABLE` (활성 tick 은 **언제나 정확히 하나**)
8. **새로 봉인**한다(아래 주의 1) — 그리고 이번에는 **Spring 이 돌지 않는지**를 같은 방식으로 감시한다

**주의 1 — 봉인값이 무효가 되는 순간**: 5 에서 export 산출물을 배치하면 **그 파일이 새 정본**이다.
§9-2 의 봉인값은 그 시점부터 **무효**이므로 6 이 끝나면 **즉시 새 md5·크기·mtime 을 기록지에 적는다**.

**주의 2 — `export` 를 생략한 롤백**: 컷오버 창 동안 **MySQL 에만 쓰인 기록은 대상 DB 에만 남는다.**
그 상태에서 재컷오버하며 대상을 비우면 그것은 **유일본 삭제**다(CLAUDE.md CRITICAL 위반). 그래서 U6 의 예외 조건 ④가
「컷오버 이후 생성된 행 0건 확인, 있으면 `export` 선행」을 요구한다. **생략했다면 그 사실을 작업 기록지에 굵게 남겨라 —
다음 사람이 조건 ④를 판정할 때 그것이 유일한 단서다.**

**주의 3 — 경로 함정**: 롤백으로 되살아난 Node 는 `RCV_SPOOL_DIR` watcher 를 다시 켠다. 그 값을 **8.3 짧은 경로**
(`PROGRA~1`·`%TEMP%` 파생)로 주면 **Node 가 기동 직후 죽는다**(libuv 단언 · §5-8 (2)). 긴 경로로 준다.

**주의 4 — 고아 업로드**: 컷오버 후 Spring 이 받은 업로드 파일은 롤백 뒤 DB 에서 참조되지 않는 채 디스크에 남는다
(무해하다 · 지우지 마라 — 재컷오버하면 다시 참조된다).

### 9-10. 실패 분기 — **전부 실측 문구**

| # | 무슨 일이 났는가 | 어떻게 드러나는가(실측) | 안전한 다음 수 |
|---|---|---|---|
| 1 | **포트 점유**(Node 를 안 내렸다) | Spring **exit 1** · `APPLICATION FAILED TO START` 다음 줄에 `Web server failed to start. Port <PORT> was already in use.` · `Identify and stop the process that's listening on port <PORT> or configure this application to listen on another port.` (2026-09-09 실측 · §9-13) | 9-1 로 돌아간다. **다른 포트로 띄우지 마라**(낭독 3) |
| 2 | 반대 방향 포트 점유(롤백 때 Spring 이 살아 있다) | Node **exit 1** · `Error: listen EADDRINUSE: address already in use 127.0.0.1:<PORT>` (`Unhandled 'error' event` 스택과 함께 · 실측) | Spring 을 먼저 내린다 |
| 3 | **대상이 비어 있지 않은데 `migrate`** | **exit 1** · `대상이 비어 있지 않다 [User, Article, Contents, ArticleHistory, Photo] — 비우고 다시 넣지 않는다.` · **소스·대상 무변**(§7-6 T6) | **U6 (나) 빈 DB 신설(무삭제)**. (가) 비우기는 예외 조건 4개를 **전부** 만족할 때만 |
| 4 | **769자 텍스트 PK**(1406) | **exit 1** · `이관에 실패했다(부분 성공은 커밋되지 않았다): …` — **1406 도 컬럼 이름도 문구에 없다**. 대상은 7테이블 `COUNT(*)=0` 으로 롤백 | 원인 특정은 `node scripts/db-scale-probe.mjs --source <사본>`(§7-3). 9-0 #6 을 건너뛴 것이다 |
| 5 | **`verify` 불일치** | **exit 4** · `대조 불일치 N건 · 구조 문제 M건 — 리포트를 보세요.` | **전환을 멈춘다.** 9-5 를 시작하지 않았다면 아무 일도 없었다 |
| 6 | **적재 전/부분 적재 상태로 Spring 기동** | **exit 1** · `DB 스키마가 이 서버의 요구를 만족하지 않습니다 (<대상>): 테이블 없음 = … 이 서버는 스키마를 만들거나 고치지 않습니다 — news-migrator 로 대상 DB 를 적재한 뒤 다시 실행하세요(… migrate --source <news.db> --target <키집합> · 절차는 docs/ops-mysql.md §11-3).` | 처방대로 9-3 으로 돌아간다(**mysql 처방으로 분기된 문구다** — step8 이전에는 「Node 서버로 데이터 디렉토리를 준비」였고 그대로 따르면 두 저장소가 갈렸다) |
| 7 | `DB_KIND` 누락·모순 | **exit 1** · `app.db.kind 와 app.db.url 이 서로 다른 저장소를 가리킵니다: kind=sqlite 인데 url 은 jdbc:mysql: 로 시작합니다` | 환경변수를 맞춘다(**URL 로 방언을 추론하지 않는 것이 설계다**) |
| 8 | **grant 누락** | 기동 성공 · 계약 하네스 **green** · `DELETE /api/receiver-config/:id` 만 **500**(§7-6 T5) | 9-4 로. 감지는 `SHOW GRANTS` 와 **육안 A-7** 뿐이다 |
| 9 | **SPA 404**(`SPA_DIR` 미설정·`index.html` 부재) | 서버는 **죽지 않는다**(health 200). `GET /` = **404** + 고정 HTML(`<pre>Not Found</pre>` — `HtmlErrors.notFound`) · 클라는 오류 화면 → 실기 시나리오에서는 `did-navigate` 누락(§3-7 P1) | `SPA_DIR` 과 `<dir>/index.html` 확인(9-5 env 표) |
| 10 | **SPA 는 뜨는데 콘솔에 CSP 위반** | 브라우저 콘솔에 `Refused to …` · 화면 기능이 **조용히** 죽는다 | 운영 `web\` 가 리포 `web/dist` 와 같은 산출물인지 md5 대조(§0-3묶음) → 다르면 배포 산출물을 맞춘다 |
| 11 | **클라가 붙지 않음** | 클라가 주소 입력 화면으로 떨어지거나 오류 창 | 포트가 바뀌었는지 먼저 본다(같은 host:port 가 전제) · `%APPDATA%\기사작성기\config.json` 의 `serverUrl` |
| 12 | **tick 401/403** | 401=세션 없음 · **403=비-Z 자격**(`R=403:forbidden D=403:forbidden` — §6-2) · ps1 은 `exit=4 stage=tick status=403` | `NEWS_TICK_USER` 가 **Z 계정**인지. 429 면 주기가 90초 미만이다(§6-4) |
| 13 | **스풀 미생성** | tick **503 `spool-disabled`**(§6-2) 또는 송고는 정상인데 파일 0건 | `DIST_SPOOL_DIR` 미설정(Spring 은 미설정이면 훅이 결선되지 않고 송고는 **정상 응답**한다 — §3-7 P2c) · 대상이 비활성인지 |
| 14 | **서버가 두 개 떠 있음** | `netstat` 에 서버 포트가 두 줄(다른 포트) · `tasklist` 에 `java.exe` 2개 · **스풀 파일이 주기당 두 벌** | 하나를 즉시 내린다. **`/api/health` 로는 구분할 수 없다**(둘 다 `{ok:true}`) — 포트·프로세스 목록이 유일한 수단(§6-7) |
| 15 | **봉인값 변화** | §9-8 의 한 줄 스크립트가 `SEAL BROKEN` | Node 를 찾아 내리고 `mtime` 으로 갈린 시점을 확인한 뒤 **롤백 판단자를 부른다** |
| 16 | 수집이 **두 번** 들어옴 | 같은 파일에서 기사가 2건 이상(§5-5 실측: watcher 3 + 스위퍼 1 = **4건**) | Node watcher 와 스위퍼가 겹쳤다 — 9-7 순서를 확인하고 **스위퍼를 먼저** 끈다 |

### 9-11. Node 은퇴의 전제 조건 — **지금은 지우지 않는다**

`server/**`·`src/**` 삭제는 이 phase 가 하지 않는다(ADR-017 결정 3 · `decisions` (6)). **무엇이 충족되면 지워도 되는가**:

1. **패리티 대조군의 대체 수단이 있다.** 지금 `--parity` 313관측은 **Node 리포트와의 비교**다 —
   Node 가 없으면 이 리포의 유일한 회귀 판정이 사라진다. 대체안(골든 리포트 동결 등)을 **먼저 세우고 실증**해야 한다.
2. **되돌림 지점이 더 이상 필요 없다.** 로드맵 187행의 「P3 완료 전 문제 시 Node 서버로 즉시 복귀(클라 무변경)」가
   유효한 동안에는 레버를 없애지 않는다. 판단 근거는 **운영 무사고 기간**이다(권장: 최소 한 분기 + 봉인 감시 무이상).
3. **`test/**` 1328건과 `web/**` 테스트의 기반이 옮겨졌다.** 그 테스트들은 Node 서버 위에서 돈다.
4. **롤백 자산 경로가 다른 형태로 보장된다**(MySQL 백업 + `export` 절차의 정기 리허설).
5. **`sqlite` 분기 제거 판단이 따로 내려졌다** — `TempNewsDb` 픽스처와 방언 차등 테스트 다수가 그 분기에 서 있다(75 forward_notes (6) ④).

**지우면 잃는 것**(같은 순서): 회귀 판정 · 되돌림 · 1328건의 기반 · 롤백 리허설의 대조군.
**지금 할 수 있는 것은 「운영에서 내리는 것」뿐이고, 그것이 이 런북이다.**

### 9-12. 부팅 로그 대조표 — 「정상 기동」을 무엇으로 판정하는가

**2026-09-09 실측**(두 서버를 같은 `SPA_DIR`·`DIST_SPOOL_DIR`·`RCV_SPOOL_DIR` 로 나란히 띄워 콘솔(stdout/stderr)과
로그 링 버퍼(`GET /api/logs/stream` · Z 전용)를 함께 캡처).

| 축 | Node(`server/index.js` 1347~1389행) | Spring | 어디서 보이는가 |
|---|---|---|---|
| **콘솔(stdout/stderr)** | **완전 무출력**(0바이트) — 모든 부팅 줄이 링 버퍼로 간다 | Spring Boot 배너 + `Starting NewsServerApplication …` · `Tomcat initialized with port <PORT>` · `Tomcat started on port <PORT> (http) with context path '/'` · `Started NewsServerApplication in N seconds` · Hikari 2줄 | Node 는 **콘솔로 아무것도 판정할 수 없다**(README-배포 §12 의 「콘솔 무출력」이 이것이다) |
| 인스턴스 잠금 | `instance lock acquired <DATA_DIR>\instance-lock.db` | **없음**(잠금 자체가 없다 — 낭독 3) | 링 버퍼 |
| **SPA 활성** | `serving SPA from <경로>` | `serving SPA from <경로>` (**같은 문구** · 링 버퍼에만) | 링 버퍼(Z 로그 화면). **콘솔에는 양쪽 다 없다** → 판정은 `GET /` 200(9-6 b) |
| **실제 바인드 host:port** | `API server on http://<host>:<port>` — **하드코딩이 아니라 실제 바인드 host** | **없음.** 콘솔의 `Tomcat started on port <PORT>` 에는 **host 가 없다** | Spring 은 `netstat -ano | findstr :<PORT>` 가 유일한 노출 범위 판정 수단이다 |
| **배부 스풀 루트** | `distribution spool root <dir>` | **없음** | 판정은 9-6 (d)(파일이 실제로 생기는가) |
| FTP 수집 | `FTP watcher watching <dir>` | **없음**(watcher 미이식 — 스위퍼가 대체 · §5) | 스위퍼의 `--report`·종료코드 |
| **DB 방언·대상** | (줄 없음 — sqlite 고정) | Hikari `news-db - Added connection <드라이버 커넥션 클래스>` — mysql 이면 `com.mysql.cj.jdbc.ConnectionImpl@&lt;16진수&gt;` · sqlite 면 `org.sqlite.jdbc4.JDBC4Connection@&lt;16진수&gt;` | **콘솔.** 방언 오설정을 콘솔에서 잡을 수 있는 유일한 줄이다 |
| 로그인 성공 | `login ok userId=<id>` | (없음 — 액세스 로그 `POST /api/login 200` 만) | 링 버퍼 |

> **읽는 법 — 이 표가 말하는 것 셋.**
> ① **운영자가 콘솔로 판정할 수 있는 것이 서버마다 다르다.** Node 는 콘솔이 비어 있고, Spring 은 포트·기동 완료·방언을 준다.
> ② **Spring 콘솔에는 바인드 host 가 없다** — LAN 개방 여부를 로그로 판단하지 마라(`netstat` 을 써라).
> ③ **진단 공백을 메우려고 로그 줄을 더하지 않았다**(런타임 코드 0줄 규율). 이유는 Node 의 그 줄들도 **콘솔이 아니라 링 버퍼**에 있기 때문이다 —
> Spring 콘솔에 경로를 찍으면 패리티가 회복되는 게 아니라 **새 divergence**(그리고 로그로 나가는 경로 노출)가 생긴다.
> 링 버퍼 축의 공백(`distribution spool root`·`API server on` 부재)은 `forward_notes` 로 넘긴다.

### 9-13. 이 런북을 **따라 해 본 기록**(리허설 · 2026-09-09)

운영 자산은 하나도 건드리지 않았다 — 리포 밖 임시 작업 루트 · 임시 MySQL DB(`harness_ct_*` · 끝나면 드롭) ·
「운영」 역은 **같은 `DATA_DIR`·같은 포트로 띄운 Node** 가 맡았다. **§9 의 1~9 를 순서대로 실행했고 롤백까지 돌렸다.**

| 단계 | 실행한 것 | 본 것 |
|---|---|---|
| 준비 | 「운영」 역 = **Node**(sqlite · `SPA_DIR`=리포 `web/dist` · `DIST_SPOOL_DIR`·`RCV_SPOOL_DIR` 설정 · 포트 19709) 기동 → 배부 대상(press)·수신 설정·기사 1건 생성 | health ok · `GET /` **200 · 413 B** · 목록 1건 |
| **실패 분기** | Node 가 포트를 쥔 채 **Spring 을 같은 포트로** | **exit 1** · `Web server failed to start. Port 19709 was already in use.`(§9-10 1행) |
| **9-1** | Node 정지 | 종료 · 포트 해제 |
| **9-2** | 사본 2벌 + 봉인 | **7 ms**(45,056 B) · **md5 3값 동일** · 봉인 `a9524d8e…` |
| **9-3** | `ephemeral-create` → `migrate` → `verify` | **432 / 2,181 / 1,252 ms** · 전부 **exit 0** · 7테이블 **불일치 0** · **소스 무변**(도구가 스스로 md5 재측정) |
| **9-4** | grant | **미실행 — root 자격이 없다**(리허설의 정직한 공백 · 아래 (c)) |
| **9-5** | Spring 기동 — **같은 포트** · `DB_KIND=mysql` · **같은 `DATA_DIR`** | health **4,017 ms** · 콘솔 `Tomcat started on port 19709 (http)` · `Started NewsServerApplication in 3.196 seconds` · Hikari `news-db - Added connection com.mysql.cj.jdbc.ConnectionImpl@…` |
| **9-6 a~d** | health · SPA · 목록·상세 · 송고 | 200 · `GET /` **200 · 413 B**(Node 와 같은 바이트 수) · **Node 시절 만든 기사가 그대로 보인다**(목록 1 · 상세 200 · 한글 제목 정상) · 송고 `DPS` → **스풀 파일 0 → 1** |
| **9-6 e** | **운영 tick 스크립트 원본**(`tick-distribution-spring.ps1`) | **exit 0** · 로그 한 줄 `2026-09-09T02:56:58Z tick ok distributed=0 scanned=0 failed=0 invalid=0` · 같은 스크립트로 `no-env`=**2** · 오비밀번호=**3** · 비-Z=**4** 재현(문서화된 종료코드 그대로) |
| **9-6 f** | 스위퍼 1회(`--once`) | **exit 0** · `files=1 ingested=1 rejected=0 failed=0 …` · **기사 1 → 2** · 스풀 파일은 지워지지 않았다 |
| (대조) | tick 인가 | 비-Z(desk) **403 `forbidden`** · 무세션 **401 `unauthenticated`** |
| **9-8** | 봉인 재측정(Spring 이 도는 중) | **md5 · 크기 · mtime 전부 동일** — Spring 은 sqlite 파일을 열지 않는다 |
| **실패 분기** | Spring 이 포트를 쥔 채 **Node 를 같은 포트로** | **exit 1** · `EADDRINUSE`(§9-10 2행) |
| **9-9** | 롤백 — Spring 정지 → `export` → `verify`(산출물↔MySQL) → 배치 → **Node 기동(같은 포트)** → 검증 → 새 봉인 | export **1,631 ms · 11행 · 45,056 B · md5 `00d6f99f…`** · verify **exit 0 · 불일치 0** · Node 기동 **662 ms** · 목록 **2건**(**컷오버 창에 수집된 기사가 살아 돌아왔다**) · 상세 200 · 부팅 전후 md5 동일 · **옛 봉인값도 그대로** |
| **실패 분기** | `SPA_DIR` 없이 Spring 기동 | health **200** · `GET /` **404**(§9-10 9행) |
| 정리 | 임시 MySQL DB 드롭 | `ephemeral-drop` **exit 0** · 잔존 `harness_ct_*` **0** |

> **따라 하다 막힌 자리 = 런북의 결함**이었고, 그 자리들은 위 본문에 이미 반영돼 있다:
> - **(a) `verify-integration --server spring` 은 운영 인스턴스를 판정하지 못한다.** 언제나 **자기 임시 서버**를 띄운다
>   (붙는 옵션이 없다). 그래서 §9-6 에서 그것을 「사전 자산 점검」으로 옮기고 당일 판정을 (a)~(g) 로 나눴다.
>   **처음 초안은 이 단계를 당일 검증에 넣고 있었고, 그대로 따라 했으면 운영 인스턴스는 한 번도 검증되지 않은 채 넘어갔을 것이다.**
> - **(b) tick ps1 을 PATH 로 부르지 마라.** 1차 시도에서 `powershell.exe` 를 찾지 못해(**ENOENT**) 스크립트가
>   **아예 실행되지 않았는데 종료코드는 비어 있었다**(`exit=null`). 절대 경로
>   `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 로 부르면 정상이다(스케줄러 등록도 그 형태다).
>   **판정 규율**: 종료코드가 `0` 이 아니라 **비어 있으면** 「성공」이 아니라 **「실행되지 않았다」** 다.
> - **(c) 9-4(grant)는 리허설로 증명할 수 없다** — root 자격이 없기 때문이다. 즉 **컷오버 당일에 처음 실행되는 유일한 단계**이고,
>   그래서 육안 체크리스트 **A-7** 이 그 실사용을 본다(자동 하네스는 `news_ct`=ALL 로 돌아 구조적으로 못 본다).
> - **(d) 롤백에 `export` 를 넣은 이유가 수치로 보였다.** 컷오버 창 동안 **수집으로 들어온 기사 1건**이 export 산출물에 담겨
>   Node 쪽 목록에 **2건**으로 돌아왔다. `export` 를 생략했다면 그 1건은 **MySQL 에만** 남았을 것이다(§9-9 주의 2).

## 10. 마감 실측과 교차 변이 (step10 · 2026-09-09)

> **마감은 재측정이다.** 앞 절들의 수치를 옮겨 적지 않고 **연속 2회** 다시 쟀다(평균을 적지 않는다 — 두 회차를 모두 싣는다).
> 회차 1 = 11:39:42~11:54:34 · 회차 2 = 11:57:10~12:12:13.

### 10-1. 13커맨드 × 2회

| # | 커맨드 | 1회차 | 2회차 |
|---|---|---|---|
| 1 | `cd server-spring && ./mvnw -B clean verify` | **Tests run 1522 / F 0 / E 0 / Skipped 0** · BUILD SUCCESS | **1522 / 0 / 0 / 0** · BUILD SUCCESS |
| 2 | `cd tools/news-migrator && ./mvnw -B clean verify` | **107 / 0 / 0 / 0** · BUILD SUCCESS | **107 / 0 / 0 / 0** · BUILD SUCCESS |
| 3 | `spring-contract --parity` | exit 0 · **313관측 diffs 0**(246·55·4·5·3) | exit 0 · **313 · 0** |
| 4 | `spring-contract --dual-run` | exit 0 · **313 · 0** | exit 0 · **313 · 0** |
| 5 | `spring-contract --db mysql --parity` | exit 0 · **313 · 0** | **exit 1 — diffs 는 0인데 실패**(아래 §10-4 ①) → **재실행 2회 전부 exit 0 · 313 · 0** |
| 6 | `spring-contract --db mysql --dual-run` | exit 0 · **313 · 0** | exit 0 · **313 · 0** |
| 7 | `spring-contract --db mysql --require-full-coverage` | exit 0 · **covered 39/39 · 미커버 쌍 0**(합산 관측 313) | exit 0 · **39/39 · 0** |
| 8 | `contract-inventory-check --require-spec-paths` | exit 0 · **routes 39**(GET 16 · POST 19 · PUT 3 · DELETE 1) · **spec-paths 39/39** | 동일 |
| 9 | `spa-parity` | exit 0 · **관측 38 · diffs 0 · 허용 diff 516** | 동일 |
| 10 | `spool-parity` | exit 0 · **폴더 3 · 파일 11 · diffs 0 · 눈감은 자리 66/66** | 동일 |
| 11 | `verify-integration --server spring --scenario loopback` | **exit 0**(13,278 ms) · data-safety 무변 4종 | **exit 0**(57,258 ms — 비표시 팝업 스로틀로 `unverified` 1건 추가) |
| 12 | `verify-integration --server exe --scenario loopback` | **exit 0**(51,183 ms) | **exit 0**(3,883 ms) |
| 13 | `npm test && npm run lint && npm run build` | **1328 pass / 0 fail**(51 suites) · lint exit 0 · build ok | **1328 / 0** · lint 0 · build ok |

**11·12의 소요 시간 편차는 결함이 아니다** — 비표시 Electron 창의 스로틀·attach 대기가 회차마다 다르고, 판정(exit code)과
`unverified` 항목의 성격은 §3-3에 이미 적혀 있다. **수치(관측 수·diffs·테스트 수)는 두 회차가 전부 같다.**

### 10-2. 자산 지문 (두 회차 동일)

| 자산 | 값 |
|---|---|
| 리포 `news.db` | **606,208 B · md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967`**(전 실행 전·후 무변) |
| `uploads/` | **32파일 · 6,068,792 B** |
| `web/dist` | **3파일 · 444,543 B**(`npm run build` 뒤에도 같은 해시 이름) |
| `server-spring` jar | **38,420,518 B** |
| `news-migrator` jar | **21,855,292 B** |
| 잔존 `harness_ct_*` | **0개** · 실행 후 `java.exe` **0** |

### 10-3. 교차 변이 6종 — 그리고 **각각을 심은 채 계약이 green 인가**

앞 step 들이 세운 게이트 중 **여섯**을 다시 심어 red 를 보고 원복했다. 그리고 **각각을 심은 채 계약(`--parity`)을 돌려**
「계약이 구조적으로 못 보는 축」 목록을 마감에서 다시 확정했다(원복은 전건 **바이트 동일** · 끝나고 `git diff` **0줄**).

| # | 심은 것(어디에) | 기대 | 실제 | **그 상태의 계약** | 원복 |
|---|---|---|---|---|---|
| **M1**(step2) | Java `SpaFallbackRules.isSpaFallbackRequest` — **`Accept` 게이트 제거**(`return true`) | 해시가 어긋난 자산이 200 index.html 로 뒤집힌다 | **`spa-parity` FAILED · 실패 diff 6건**(전부 `asset-missing`: `status` 404→**200** · `isIndex` false→**true** · `bodySha256` · `bodyLength` 163→**413** · `contentType` · CSP) · 허용 diff 516→**515** | **`--parity` 313관측 diffs 0 — green** | 바이트 동일 |
| **Q5**(step5 · **보안 축**) | Java `SpoolWriter.CONTENTS_FIELDS` 에 **`internalComment`·`lockYN` 추가** | 내부 전용 값과 **편집 잠금 컬럼**이 외부 수신처 파일로 나간다 | **`spool-parity` FAILED · diffs 11/11**(파일마다 `only-in-B=[internalComment,lockYN]` — 잠금 컬럼은 5축 전부에서) | **`--parity` 313관측 diffs 0 — green** | 바이트 동일 |
| **N4**(step3) | JS `scripts/lib/spaParity.mjs` `RECORD_FIELDS` 에서 **`contentType` 제거**(비교 항목 축소) | 대조가 조용히 좁아진다 | **자기검사 red 3건 → 하네스가 서버를 띄우지 않는다**(`판정부 자기검사가 실패했다 …` · exit 1) | (jar 무변 — 아래 공통 행) | 바이트 동일 |
| **R3**(step6) | JS `tools/collection-sweeper/lib.js` **멱등 장부 조회 제거**(`ledgerHas` → `null`) | 같은 파일이 다시 수집된다 | **단위 red 1/28**(`sweepOnce — 장부에 있는 파일은 skipped`) → 왕복은 돌지 않는다(앞 겹이 닫힌다) | 〃 | 바이트 동일 |
| **S2**(step7) | JS `scripts/lib/tickCutover.mjs` 기대표 — **비-Z tick 기대를 `200` 으로 완화** | 인가 회귀가 통과한다 | **자기검사 red 1/22 → 프로브 기동 거부**(exit 1). 실측 대조군은 리허설이 잡았다: 비-Z(desk) **403 `forbidden`** · 무세션 **401** | 〃 | 바이트 동일 |
| (공통) | **N4+R3+S2 를 함께 심은 채** | 계약은 하네스 쪽 변이를 보지 못한다 | — | **`--parity` 313관측 diffs 0 — green** | — |
| **T2**(step8/75) | Java 마이그레이터 `SourceFingerprint` 에 **죽은 코드 한 줄**(`Files.deleteIfExists(path)` · **SQL 은 0글자**) | 비파괴 정적 게이트가 red | **`MigratorHasNoDestructiveSqlTest.theMainTreeContainsNoDestructiveSqlAndNoDestructiveApiCall:241` red**(107 tests / **1 failure** · BUILD FAILURE) — 패턴 **둘**이 동시에 물었다(`\bFiles\s*\.\s*(delete\|deleteIfExists\|move)\s*\(` 와 맨이름 판) | **`--db mysql --parity` 313관측 diffs 0 — green**(그 죽은 코드가 든 jar 로 적재까지 했다) | 바이트 동일 |

**이 표가 확정하는 문장 셋**:
1. **계약은 이 phase 가 연 축을 하나도 보지 못한다** — SPA 응답(M1)·스풀 바이트(Q5)·마이그레이터의 파괴 코드(T2)를 심은 채로도 **313관측 diffs 0** 이다.
   그러므로 「계약이 green 이니 안전하다」는 이 축들에 대해 **거짓**이고, 방어선은 `spa-parity`·`spool-parity`·정적 게이트 셋뿐이다.
2. **하네스 자신을 무디게 하는 변이는 자기검사가 앞에서 막는다**(N4·S2 는 **기동 거부** · R3 는 단위 red). 게이트가 공허해지는 길은
   「대조를 느슨하게」가 가장 싸고, 그래서 그 자리를 자기검사가 지키고 있어야 한다.
3. **원복은 증명해야 한다** — 변이 전건 `bytes-identical=true` · `git diff --stat` **0줄** · 재빌드 후 `spa-parity` **38·0·516** ·
   `spool-parity` **3·11·0·66/66** · 스위퍼 단위 **28/28** · tick 자기검사 **22/22** · 리포 `news.db` md5 무변 · 잔존 `harness_ct_*` **0**.

### 10-4. 이 마감이 새로 잡은 것 (전부 실측 · 셋 다 「수치가 아니라 절차」의 결함이다)

1. **거짓 leak 경보 — 개발 비밀번호가 4자라서 난다(§0-1 U2 가 예고한 그 함정이다).**
   회차 2의 `--db mysql --parity` 가 **diffs 0 인 채로 exit 1** 이었고 사유는
   `FAIL [default] migrator migrate 출력에 비밀 값이 2회 섞여 나왔다` 였다. 원인은 **우연**이다:
   그 패스의 시드 md5(`4dd52cae…`) 안에 **4자 비밀번호와 같은 4글자**가 들어 있었다(값은 어디에도 싣지 않고
   `includes` 판정만 했다 — 히트 1). 하네스는 우연과 유출을 구분할 수 없으므로 **이 동작은 옳다** —
   고칠 자리는 하네스가 아니라 **U2(비밀번호를 8자 이상으로 교체)** 다. 재실행 2회 모두 exit 0(313 diffs 0).
   **판정 규약**: 이 실패를 「계약 회귀」로 읽지 마라 — `[diff]` 줄이 전부 0 인데 exit 1 이면 **위생 검사**를 먼저 보라.
2. **IDE 가 `target/` 을 동시에 건드리면 `clean` 이 있어도 빌드가 죽는다.** 변이 실험 1차에서
   `mvnw clean package -DskipTests` 가 **테스트 컴파일**에서 `LogRecord.seq() cannot find symbol` 로 죽었고
   (그 자리는 이 phase 가 만지지도 않은 파일이다) **jar 이 사라진 채** 뒤 단계가 전부 exit 1 이 됐다 —
   그대로 기록했으면 「변이가 잡혔다」로 오독됐을 것이다. 처방: 변이 빌드는 **`-Dmaven.test.skip=true`**(테스트 컴파일 자체를 건너뛴다) ·
   **jar 존재를 확인**하고 없으면 `rm -rf target` 후 1회 재시도 · 그래도 없으면 **그 단계의 수치를 버린다**.
3. **`powershell.exe` 를 PATH 로 부르면 조용히 실행되지 않는다**(§9-13 (b)) — 종료코드가 **비어 있는 것**이
   「성공」으로 보이는 자리다. 절대 경로로 부르고, **exit 가 `null`이면 실패로 판정**하라.
