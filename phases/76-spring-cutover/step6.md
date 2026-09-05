# Step 6: collection-sweeper

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — `baseline` (E) · `decisions` (7)(12)(13) · `open_questions` (3)
- `docs/ADR.md` **ADR-008**(앱 내 타이머·egress 금지 · tick pull) · **ADR-014**(egress 예외의 축 — 무엇이 예외가 **아닌지**) · **ADR-017**(step1)
- `docs/RCV.md` — 수집(자동기사) 스펙 · 스풀 레이아웃 `<dir>/<sourceId>/<file>`
- `docs/ARCHITECTURE.md` 수집 흐름 절
- **Node 정본**: `server/ftpWatcher.js` 전문 · `server/index.js` **1369~1389행**(배선 · 로그 문구 · `notifyChange('create')`)
- `src/services/collectionService.js` · `src/controllers/*`의 collection 진입점
- **Spring 대응**: `server-spring/src/main/java/harness/news/service/CollectionService.java` · `CollectionAccess.java` · `CollectionParser.java` · `CollectionTokenSource.java` · `harness/news/config/CollectionProperties.java` · 컨트롤러의 `POST /api/collection/receive`
- `contract/cases/default/collection.contract.js` · `contract/cases/failclosed/*`(수집 fail-closed 판정 — **무접촉, 명세로 읽는다**)
- `docs/cutover-p3.md` §0 조사표 **5번**(운영이 `RCV_SPOOL_DIR`을 쓰는가) — **이 step의 분기 입력**
- `server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java`(무접촉 — 예외 목록이 왜 안 열리는지 확인용)

## 배경

**Spring에는 FTP 스풀 수집이 없다.** Node는 `RCV_SPOOL_DIR`이 설정된 경우 `fs.watch(dir,{recursive:true})`로 깨어나 `<dir>/<sourceId>/<file>`을 읽고 **`controllers.collection.receive(sourceId, payload)`** 를 부른다. `server-spring`에는 `WatchService`·`RCV_SPOOL` 철자가 **0건**이다(75 forward_notes (3)이 divergence로 인계한 축).

그래서 **Node를 내리면 이 경로가 사라진다.** P3의 AC ①은 '작성→송고→배부→**수집**'이므로 이 축을 비워 둘 수 없다.

**해법은 Spring에 watcher를 넣는 것이 아니다**(decisions (7)): `Adr008DisciplineTest`의 '주기 실행'·'비동기·재시도' 두 군은 예외가 **0개**이고, 여는 순간 ADR-008의 '앱은 스스로 깨어나지 않는다'가 무너진다. 대신 **앱 밖 스위퍼**가 파일을 읽어 **이미 동결된 라우트** `POST /api/collection/receive`로 넣는다 — watcher가 부르던 진입점과 **같은 서비스 진입점**이다. 배부 tick(외부 cron pull)과 정확히 대칭이고, 새 게이트 예외가 0이며, Node watcher는 무수정으로 남아 롤백을 지킨다.

**분기(open_questions (3))**: step0 조사표 5번이 **'운영 미사용'** 이면, 스위퍼는 컷오버의 전제가 아니라 **Node 은퇴의 전제**로 내려간다. 그 경우에도 **도구는 만든다**(만들지 않으면 은퇴 시점에 이 축이 다시 공백으로 튀어나온다) — 다만 런북에서의 위치와 검증 강도가 달라진다. 조사표가 '미상'이면 이 step은 **blocked**이고, 그 사실을 index.json에 기록한다.

## 작업

### A. 스위퍼 도구

위치는 재량이되 **앱 밖**이어야 한다. 권장: `tools/collection-sweeper/`(Node 스크립트 1파일 + 자기검사) 또는 `scripts/collection-sweeper.mjs`. **`server-spring/src/main`에 넣지 마라.**

시그니처 수준 요구:

```
사용: node <스위퍼> --spool <RCV_SPOOL_DIR> --base <서버 origin> [--once] [--move-to <처리완료 폴더>] [--dry-run]
```

- **스캔은 1회 실행 = 1회 스캔**이 기본(`--once`). **자체 루프·setInterval·watch를 넣지 마라** — 주기는 외부 스케줄러가 정한다(tick과 같은 규율). 상주 모드를 만들고 싶다면 그것은 별도 결정이고 이 step의 범위가 아니다.
- 파일 → `sourceId` 도출은 **Node watcher와 같은 규칙**이다: `<spool>/<sourceId>/<file>`, 세그먼트가 2개 미만이면 무시(최상위 항목·디렉토리 생성 이벤트).
- 전송: `POST <base>/api/collection/receive` · 본문은 **파일 내용 그대로** · 인증은 `x-collection-token`(운영이 LAN 바인딩이면 필수). **토큰은 argv가 아니라 환경변수로만** 받는다(프로세스 목록 노출 금지 — 75 decisions (7)).
- **부분 파일 방어**: 외부 FTPd가 쓰는 중인 파일을 집어가면 파싱이 깨진다. Node watcher가 이 문제를 어떻게 다루는지(또는 다루지 않는지) **실측**하고, 스위퍼는 최소한 **파일 크기·mtime 안정화 확인**(연속 2회 관측에서 동일)을 하라. Node가 하지 않는 방어를 스위퍼가 한다면 **그것은 divergence이므로 문서에 적어라**(더 나은 쪽이라도 기록한다).
- **처리 완료 파일의 처분**: **삭제하지 마라.** 기본은 `--move-to`로 지정된 폴더로 **이동**(미지정이면 이동하지 않고 **장부 파일**에 처리 완료를 기록해 재전송을 막는다). 근거: CLAUDE.md의 최상위 규칙(삭제 금지)의 정신과, 실패 시 원본이 남아야 복구할 수 있다는 실무. **어느 쪽을 택하든 재실행이 멱등**이어야 한다 — 같은 파일을 두 번 넣으면 기사 2건이 생기는지 **실측하고 기록**하라(수집 서비스의 중복 판정이 무엇인지 코드로 확인).
- **실패 격리**: 한 파일 실패가 다음 파일을 막지 않는다(Node watcher의 규율). 실패는 stderr + 종료코드로 표면화하되 **payload를 로그에 싣지 마라**(마스킹 — `docs/LOGS.md`).
- **종료코드 규약**을 정하고 문서화한다(0=전건 성공/처리 0건, 1=일부 실패, 2=설정 오류 등).

### B. 테스트

1. **순수 판정부 단위 테스트**(`node --test`): `sourceId` 도출(경로 구분자 `/`·`\` 양쪽 · 2세그먼트 미만 무시 · 중첩 경로) · 안정화 판정 · 멱등 장부 · 종료코드 결정.
2. **왕복 테스트**: 임시 스풀에 파일을 놓고 **Spring 인스턴스**에 실제로 넣어 기사가 생기는지. `Wire`나 스크립트 중 어느 쪽으로 할지는 재량이되, **Node 대상으로도 같은 왕복을 돌려 결과를 대조**하라(같은 파일 → 양쪽에서 같은 기사 필드가 나오는가). 대조 항목: 생성 성공 여부 · 거부 사유 토큰 · 만들어진 기사의 투영 필드.
3. **미등록 sourceId·잘못된 형식·빈 파일·거대 파일**의 거부가 양쪽에서 같은 사유 토큰인지.

### C. 문서

- `docs/cutover-p3.md` §5: 이 축의 divergence(Spring에 watcher가 없다) · 스위퍼 설치·등록 방법(작업 스케줄러) · 멱등·실패·감시 책임이 운영으로 넘어간다는 사실 · **Node로 롤백하면 watcher가 다시 살아나므로 스위퍼를 반드시 멈춰야 한다**(둘 다 돌면 같은 파일을 두 번 넣는다 — 이것이 이 step의 가장 위험한 운영 함정이다. 굵게 적어라).
- `packaging/server/README-배포.md`에 스위퍼 절 추가(**기존 Node FTP 수집 절은 삭제 금지**).

## Acceptance Criteria

```bash
# 1) 스위퍼 단위·왕복 테스트
node --test <스위퍼 테스트 경로>

# 2) Java 무회귀 (이 step은 server-spring/src/main을 0줄 고친다)
git diff --stat -- server-spring/src/main   # 무출력
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify

# 3) 계약·SPA·스풀 무회귀
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity
node scripts/spa-parity.mjs
node scripts/spool-parity.mjs

# 4) 무접촉
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java   # 무출력
```

- 2번의 첫 줄(`server-spring/src/main` 0줄)이 **이 step의 핵심 AC**다 — 스위퍼는 앱 밖이고, 앱은 이 축 때문에 한 줄도 바뀌지 않는다.
- **변이 전건 결과표(필수)** — 최소 6종:
  - **R1** `sourceId` 도출에서 백슬래시 구분자 처리 제거 → 기대: 단위 테스트 red(Windows 경로).
  - **R2** 2세그먼트 미만 무시 규칙 제거 → 기대: 최상위 파일이 `sourceId` 없이 전송돼 실패/오동작.
  - **R3** 멱등 장부(또는 이동) 제거 → 기대: 재실행이 같은 파일을 다시 넣는다. **실제로 기사가 2건이 되는지 재서 기록하라**(수집 서비스가 막는다면 그 사실이 발견이다).
  - **R4** 실패 격리 제거(첫 실패에서 중단) → 기대: 뒤 파일이 처리되지 않는 테스트 red.
  - **R5** 토큰을 argv로 받도록 변경 → 기대: 비밀 위생 게이트/리뷰가 잡는가. 잡지 못하면 **그 사실이 공백**이므로 기록하고 스위퍼 자체 가드(argv에 토큰 형태가 오면 거부)를 넣어라.
  - **R6** 스위퍼에 `setInterval` 상주 루프를 넣음 → 기대: 이 step이 만든 '앱 밖·주기 없음' 정적 스캔(있다면)이 red. **없다면 만들어라** — 그리고 그 스캔의 비공허성을 이 변이가 실증한다.
  - 각 변이에 기대/실제/원복 확인.
- **분기 기록(필수)**: step0 조사표 5번의 값과, 그에 따라 이 step이 '컷오버 필수'인지 '은퇴 전제'인지의 판정을 **명시 문장으로** 남긴다.

## 검증 절차

1. Node watcher와 스위퍼를 **같은 스풀에 동시에** 돌려 보고 무슨 일이 생기는지 **실측**한다(중복 수집이 나면 그것을 런북의 경고 문구 근거로 쓴다). 실험은 **임시 스풀**에서만.
2. 왕복 테스트를 Node·Spring 두 대상에 각각 돌려 결과를 표로 대조한다.
3. 스위퍼가 처리한 파일이 **삭제되지 않았는지** 확인한다.
4. `docs/RCV.md`의 스풀 레이아웃 규약과 실제 도출 규칙이 어긋나지 않는지 대조한다.

## 되돌림 절차

- 도구 삭제로 끝난다(앱 코드 0줄). 운영에는 아직 아무것도 등록하지 않았다.
- **운영에 등록한 뒤의 되돌림**(step10 런북이 소유): 스케줄러에서 스위퍼 작업을 **먼저 끄고** Node를 올린다. 순서를 지키지 않으면 watcher와 스위퍼가 동시에 돌아 중복 수집이 난다.

## 금지사항

- **Spring에 `WatchService`·`@Scheduled`·상주 스레드를 넣지 마라.** 이유: `Adr008DisciplineTest`의 두 군은 예외가 0이고, 여는 것은 ADR-008을 뒤집는 별도 아키텍처 결정이다.
- **스위퍼에 자체 주기 루프를 넣지 마라.** 이유: 주기는 외부 스케줄러가 정한다(tick과 같은 규율). 상주가 필요하면 별도 결정으로 올려라.
- **처리한 파일을 삭제하지 마라.** 이유: 실패 시 복구 수단이 사라진다. 이동 또는 장부로 멱등을 만들어라.
- **토큰·자격을 argv나 리포에 두지 마라.** 이유: 프로세스 목록 노출 · `SecretHygieneTest`.
- **`server/ftpWatcher.js`·`server/index.js`를 고치지 마라.** 이유: 롤백 레버다. Node의 수집 경로는 그대로 살아 있어야 한다.
- **payload를 로그에 싣지 마라.** 이유: `docs/LOGS.md` 마스킹 규율 — Node watcher도 `sourceId`와 결과만 남긴다.
- **조사표가 '미상'인 채로 진행하지 마라.** 이유: 이 step의 위치(컷오버 필수 / 은퇴 전제)가 정해지지 않으면 런북의 순서를 쓸 수 없다. 그 경우 `blocked`로 두고 물어라.
