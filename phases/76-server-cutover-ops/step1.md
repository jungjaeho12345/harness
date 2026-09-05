# Step 1: scenario-driver

## 읽어야 할 파일

먼저 아래를 읽고 계약(요청/응답 shape)과 자체 기동 하네스 관행을 파악하라:

- `phases/76-server-cutover-ops/index.json` — 이 phase의 scope·decisions(특히 (4) ADR-008 외부 트리거·(7) 컨테이너 실행). step0 summary도 확인.
- `scripts/lib/spoolCanon.mjs` — **step0 산출물**. `readSpoolManifest`로 스풀 트리를 매니페스트로 만든다.
- `scripts/verify-integration.mjs` — 서버를 자체 기동하고 임시 `DATA_DIR`·before/after 스냅샷으로 무변을 단언하는 **기존 통합 스모크의 형태**. 임시 디렉토리·시드·프로세스 관리·데이터 안전 규율을 여기서 그대로 베낀다.
- `scripts/spring-contract.mjs` — 패스마다 임시 `DATA_DIR`에 `createSchema`+`seedUsers`로 시드하고 `DIST_SPOOL_DIR`·`COLLECTION_TOKEN`을 주입하는 형태(상단 주석과 PROFILES). 리포 `news.db`·`uploads/` 무변 단언 방식도 여기 있다.
- `src/db/schema.js`(`createSchema`) · `src/db/seed.js`(`seedUsers`, `SAMPLE_USERS`) — 시드 단일 출처.
- `contract/cases/default/distribution-tick.contract.js` — **작성→송고→배부** 시퀀스와 배부 가능한 기사(활성 수신처·엠바고 도래·`DES→DPS` 승격)를 만드는 **정확한 요청 순서의 정본**. 이 시퀀스를 그대로 미러링하라(추측하지 마라).
- `contract/cases/default/collection.contract.js` — **수집**(`POST /api/collection/receive`·`/pull`, 토큰·loopback)의 요청/응답 정본.
- `contract/cases/default/articles-write.contract.js` · `contract/cases/default/distribution-targets.contract.js` — 작성·수신처 생성 요청 shape.
- `server/index.js` 1354~1366행 근처 — `PORT`·`HOST`·`DIST_SPOOL_DIR`·`COLLECTION_TOKEN` 기동 환경변수.

## 작업

동결된 REST 계약으로 **작성→송고→배부→수집** 전체 루프를 **한 대상 서버**에 대해 구동하고, 결과 배부 스풀을 step0의 매니페스트로 방출하는 드라이버를 만든다.

> **TDD 형태**: 이 산출물은 순수 함수가 아니라 **실서버 구동 스모크 스크립트**다(`verify-integration.mjs`·`spring-contract.mjs`와 같은 계열 · `scripts/**`는 eslint ignore라 인자 가드가 유일한 정적 안전망이다). 따라서 **자체 실행(self-run) 스모크가 곧 이 step의 테스트이자 AC**다 — 별도 단위 테스트를 두지 않는다. 순수 판정 로직(스풀 정규화·대조)은 **step0에서 이미 테스트-우선으로** 만들었고 이 드라이버는 그것을 소비한다. 스모크가 각 단계 status·스풀 비어있지 않음을 단언하지 못하면 red다.

새 파일 `scripts/operation-scenario.mjs`. CLI(순수 인자 가드는 `scripts/lib/cliArgs.mjs`/기존 스크립트 패턴 재사용):

```
node scripts/operation-scenario.mjs --server node [--keep] [--timeout <ms>] [--out <manifest.json>]
```

- `--server node`: 이 step의 유일 모드. 스크립트가 **Node 서버를 자체 기동**한다 — 임시 `DATA_DIR`(`createSchema`+`seedUsers`), 임시 `DIST_SPOOL_DIR`, `COLLECTION_TOKEN=<랜덤>`, `HOST=127.0.0.1`, `PORT=<loopback 랜덤>`. (step2가 `--dual`·`--server spring`·`--db`를 더한다 — 이 step은 그 자리를 남겨 두되 만들지 않는다.)

시나리오 시퀀스(각 단계 응답 status를 단언):
1. **작성** — 로그인(시드 계정) → `POST /api/articles`로 기사 1건 생성(본문 `{format:'yh-editor',version:1,blocks:[...]}`). articleId 확보.
2. **배부 준비** — `POST /api/distribution-targets`(Z)로 활성 수신처 1곳 생성(`spoolDir` slug 지정). 기사 엠바고가 도래하도록 설정한다(정확한 필드·전이는 `distribution-tick.contract.js`를 따른다).
3. **송고** — `POST /api/articles/:id/action`(send)로 배부 가능 상태까지 전이.
4. **배부** — `POST /api/distribution/tick`(Z, body 무시)을 **1회** 호출 → 스풀 파일이 수신처 폴더에 써진다. (ADR-008: 외부 트리거 1회 · 앱에 타이머 추가 금지.)
5. **수집** — `POST /api/collection/receive`(토큰·loopback)로 자동기사 1건 인제스트 → 200 · 인제스트된 기사가 `GET /api/articles`에 나타남을 단언(필요 시 `/pull`도).

종료:
- `readSpoolManifest(DIST_SPOOL_DIR, …)`로 매니페스트를 만들어 `--out` 경로(또는 stdout)로 방출한다.
- **단언(단일 대상 모드)**: 각 단계 status 정상 · 활성 수신처에 대한 스풀 매니페스트가 **비어 있지 않음** · 수집 200.
- **데이터 안전(CRITICAL)**: 리포 `news.db`·`uploads/`·실사용자 데이터에 **절대 바인딩하지 않는다**. 무변 단언은 **부재까지 포함한다** — 리포 `news.db`는 `.gitignore` 대상이라 컨테이너에는 **없다**(`md5sum news.db`는 ENOENT). 실행 전 존재하면 실행 후 **md5 무변**을, 실행 전 없으면 실행 후에도 **여전히 없음(생성 0)**을 단언한다. `uploads/`도 같은 규칙. 임시 디렉토리는 `--keep`가 아니면 정리한다(`verify-integration.mjs`·`spring-contract.mjs`와 동형).
- **위생**: 세션 쿠키·`COLLECTION_TOKEN`·시드 비밀번호를 stdout/로그에 싣지 마라.

## Acceptance Criteria

```bash
# Node/SQLite만 필요 — 컨테이너에서 그대로 돈다(JDK·MySQL 불요)
node scripts/operation-scenario.mjs --server node   # exit 0 · 스풀 매니페스트 비어있지 않음 · 각 단계 status 정상
npm run lint
npm test                                             # 기존 1328 무회귀
```

## 검증 절차

1. 위 AC 커맨드를 실행한다(컨테이너 실행 가능).
2. 실행 후 리포 `news.db`가 **있으면 md5 무변 / 없으면 여전히 없음(생성 0)**을 확인한다(스크립트가 스스로 단언하지만 밖에서도 잰다 · 컨테이너에는 `.gitignore`로 부재).
3. 아키텍처 체크리스트:
   - 배부는 `POST /api/distribution/tick` **외부 호출**로만 일으켰는가? 앱(`server/**`·`src/**`)에 타이머·코드를 추가하지 않았는가(ADR-008)?
   - 계약 정본(`contract/**`)·Node 서버·`package.json`을 고치지 않았는가?
   - 시드·스키마 단일 출처(`src/db/**`)를 재사용했는가?
4. 결과에 따라 `phases/76-server-cutover-ops/index.json`의 step 1을 업데이트한다(completed→summary / error→error_message / blocked→blocked_reason).

## 금지사항

- 앱에 타이머·재시도·큐·egress를 추가하지 마라. 이유: ADR-008을 정면으로 위반한다 — 배부는 외부 tick 1회로만 일으킨다.
- 리포 `news.db`·`uploads/`에 바인딩하지 마라. 이유: 최상위 규칙(DB 비파괴) 위반이며 실데이터를 오염시킨다.
- 요청 shape을 추측하지 마라. 이유: `contract/cases/**`가 정본이다 — 추측은 하류 대조를 거짓으로 만든다.
- `contract/**`·`server/**`·`src/**`·`package.json`을 고치지 마라. 이유: 이 step은 **새 스크립트만** 추가한다(동결 정본 무접촉).
- 세션 쿠키·토큰·비밀번호를 로그에 싣지 마라.
- 기존 테스트를 깨뜨리지 마라.
