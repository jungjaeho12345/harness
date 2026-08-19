# Step 1: contract-runner

계약 스위트의 **실행 하네스(러너)** 를 만든다. 이 step이 끝나면 `node scripts/contract-run.mjs --boot-check`가 프로파일 5종의 서버를 순서대로 띄우고, 시드·세션·자격증명을 준비하고, `GET /api/health` 왕복으로 살아 있음을 확인하고, 종료·정리하고, 리포 데이터가 변하지 않았음을 단언한다. **케이스 파일과 공용 lib은 다음 step(2)의 소유이며 이 step에서는 만들지 않는다.**

## 읽어야 할 파일

- `CLAUDE.md`
- `phases/67-port-p1-contract/index.json` — decisions **(4)(5)(7)(8)(9)(11)(12)(13)(14)(17)(19)(21)(22)(23)(24)(25)(26)**
- `docs/api-contract/README.md` · `endpoints.json` (step0 산출물) — 프로파일·태그 어휘·39행 인벤토리(커버리지 게이트의 입력)
- `scripts/verify-integration.mjs` 전체 — **이 step이 따라 쓸 본보기**: `cleanEnv()`(99~108행), `pickFreePort`(154~165행), `healthOk`(176~187행), `repoDataSnapshot`(190~198행), 임시 디렉토리 시드(393~399행), `makeTmpCleanup`(349~366행), 자식 kill 절차(112~118행), 종합 판정·exit 코드(700~739행)
- `scripts/lib/cliArgs.mjs` — 값 플래그 파싱(`flagValue`) 재사용
- `test/verify-integration-portrange.test.js` — **포트 범위 불변식**(서버 20000~34999 · CDP 35000~44999)을 잠그는 기존 텍스트 잠금 테스트. 이 step이 고를 범위는 두 구간과 서로소여야 한다.
- `src/db/schema.js`(`createSchema`) · `src/db/seed.js`(`seedUsers`·`SAMPLE_USERS`) — **Node 대상 시드와 자격증명 조립에만** 쓴다
- `server/index.js` — `bootstrap()`이 읽는 env(`DATA_DIR`·`PORT`·`HOST`·`SPA_DIR`·`DIST_SPOOL_DIR`·`RCV_SPOOL_DIR`·`COLLECTION_TOKEN`·`NODE_ENV`·`FORCE_HTTPS`·`ALLOWED_ORIGINS`), `resolveRuntimePaths`(233~261행), `isLoopbackHost`(127~132행), 직접 실행 가드(1395~1397행), 수집 fail-closed 가드(1072~1122행)
- `docs/ADR.md` ADR-012 — 데이터 폴더당 인스턴스 1개(프로파일마다 `DATA_DIR`를 분리해야 하는 이유)

## 배경 (설계 제약 — 반드시 지킬 것)

- **러너만 Node 서버를 안다.** 케이스·lib(다음 step)은 `CONTRACT_BASE_URL` 하나로만 서버에 접근한다. `--base-url-map`을 주면 러너는 서버를 기동하지도, 시드하지도 않는다(68+ Spring 대상 경로).
- **로그인은 희소 자원이다.** `POST /api/login`은 15분/10회 IP 레이트리밋 아래 있다(`server/index.js` 609~614행). 러너가 프로파일당 R/D/Z **3회만** 로그인해 세션 파일에 담는다.
- **자격증명은 러너가 공급한다.** 케이스가 비밀번호를 하드코딩하면 68+ Spring 대상(계정·비밀번호가 다를 수 있다)에서 스위트가 통째로 죽는다. 러너가 `CONTRACT_CREDENTIALS` 파일을 만들어 넘기고, 외부 대상에서는 `--credentials <file>`로 덮어쓴다.
- **결정성**: 외부 API 키 env가 남아 있으면 미디어/번역 케이스가 실 네트워크를 때린다. 자식 env를 **명시 조립**해 그 키들을 지운다. `.env`도 로드하지 않는다(`npm run server`가 아니라 `node server/index.js` 직접 spawn).
- **데이터 안전**: 리포 `news.db`·`uploads/`는 절대 열리지 않아야 한다. 러너가 before/after 스냅샷으로 단언한다.

## 작업

### A. `scripts/contract-run.mjs` — 러너 (CLI)

인터페이스(후속 step의 AC 커맨드가 이 형태에 의존한다 — 이름을 바꾸지 마라):

```
node scripts/contract-run.mjs [--profile <name>]... [--files <path>[,<path>]...]
                              [--out <report.json>] [--base-url-map <file.json>] [--credentials <file.json>]
                              [--boot-check] [--require-full-coverage] [--require-spec-paths]
                              [--keep] [--timeout <ms>]
```

- `--profile` 미지정 = 전 프로파일. `--files` 미지정 = 해당 프로파일 디렉토리(`contract/cases/<profile>/`)의 `*.contract.js` 전부(정렬). 디렉토리가 없으면 케이스 0건으로 취급하고 **실패가 아니다**(이 step 시점에는 케이스가 존재하지 않는다).
- `--out` 미지정 = OS 임시 디렉토리에 리포트를 쓰고 경로를 stdout에 출력(리포 오염 금지).
- `--boot-check` = 케이스를 실행하지 않고 **프로파일 기동 → health 왕복 → 세션/자격증명 준비 → 종료·정리**까지만 수행한다(이 step의 AC가 쓰는 모드).
- `--base-url-map <file>` = `{ "<profile>": "<baseUrl>" }`. 있으면 서버를 기동하지 않고 시드도 하지 않는다. 맵에 없는 프로파일의 케이스는 실행하지 않고 리포트 `skipped`에 `{ profile, reason: 'profile-unavailable' }`로 남긴다.
- `--credentials <file>` = `{ "R": {"userId":"...","password":"..."}, "D": {...}, "Z": {...} }`. 미지정 + Node 대상이면 러너가 `SAMPLE_USERS`에서 조립한다. 외부 대상(`--base-url-map`)에서 이 옵션이 없으면 **즉시 실패**한다(비밀번호 추측 금지).
- `--require-full-coverage` = 커버리지 미달 시 exit 1(기본은 경고 목록 + exit 0). `--require-spec-paths` = `contract-inventory-check.mjs`의 YAML 경로 검사까지 실패로 취급(마지막 step 전용).

프로파일 표(서버 env 프리셋) — **이 5종이 계약의 일부다. 임의로 늘리지 마라**:

| profile | 구분 | env (공통: `DATA_DIR`=임시·시드, `PORT`=빈 포트, `SPA_DIR`='', 외부 API 키 4종 삭제, `RCV_SPOOL_DIR` 미설정) | 목적 | 세션 준비 |
|---|---|---|---|---|
| `default` | 필수 | `HOST=127.0.0.1` · `DIST_SPOOL_DIR`=임시 · `COLLECTION_TOKEN`=고정 테스트 토큰 | 대부분의 케이스 | 예(R/D/Z) |
| `minimal` | 필수 | `DIST_SPOOL_DIR` 미설정 · `COLLECTION_TOKEN` 미설정 | 배부 `spool-disabled` 503 · 토큰 미설정 수집 경로 | 예 |
| `auth-negative` | 필수 | `default`와 동일 구성, **별도 프로세스·별도 DATA_DIR** | 로그인 실패·계정 잠금(423)·레이트리밋(429) 격리 | **아니오**(케이스가 직접 로그인) |
| `failclosed` | 선택 | `HOST=0.0.0.0` · `COLLECTION_TOKEN` 미설정 (접속은 `127.0.0.1`) | 수집 fail-closed 503 `collection-disabled` | 예 |
| `prod-cookie` | 선택 | `NODE_ENV=production` · `FORCE_HTTPS=false` · `COLLECTION_TOKEN` 미설정 | 프로덕션 쿠키 속성(Secure·SameSite=None) 동결 | **아니오** |

프로파일 1개의 실행 절차:
1. 임시 `DATA_DIR` 생성 → `new DatabaseSync(<dataDir>/news.db)` → `createSchema` → `seedUsers` → `close`. (외부 대상 모드에서는 생략.)
2. **빈 포트 확보** — 후보를 실제로 listen해 확정한다(추측 금지). 범위는 **[45000, 49152)** 를 쓴다: 기존 verify 스크립트의 서버 [20000, 35000)·CDP [35000, 45000) 두 구간과 **서로소**여야 병행 실행에서 경합하지 않는다(`test/verify-integration-portrange.test.js`가 잠근 불변식). Windows 동적 포트 기본 범위(49152~)보다 아래로 둔다.
3. `node server/index.js`를 명시 env로 spawn → `GET /api/health`가 `{ok:true}`를 줄 때까지 폴링.
4. **세션·자격증명 준비**(세션 준비가 `예`인 프로파일만): `POST /api/login`을 R/D/Z **3회** 호출해 `{ "<role>": { sid, userId, name, role, department, departmentCode } }`를 임시 `sessions.json`에 쓴다. 자격증명은 프로파일과 무관하게 항상 `credentials.json`(`{ "<role>": { userId, password } }`)으로 쓴다 — 세션 준비를 건너뛰는 프로파일의 케이스가 스스로 로그인할 때 쓴다.
5. `node --test --test-concurrency=1 <파일들>`을 자식으로 실행하고 env로 `CONTRACT_BASE_URL`·`CONTRACT_PROFILE`·`CONTRACT_SESSIONS`·`CONTRACT_CREDENTIALS`·`CONTRACT_REPORT_DIR`·`CONTRACT_COLLECTION_TOKEN`을 넘긴다. 자식 exit code가 0이 아니면 그 프로파일은 실패지만 **나머지 프로파일은 끝까지 돈다**(실패 하나가 나머지 관측을 지우면 진단이 불가능하다).
6. 서버 종료(kill → 확인 → SIGKILL 폴백) → 임시 디렉토리 정리(`--keep`이면 보존, 실패 시 보존).

**기동 실패 처리(오탐 방지 계약)**: 3(health 왕복) 또는 4(세션 준비)가 실패하면 그 프로파일은 **부팅 실패**다. 그때는 (a) 그 프로파일의 전 케이스를 리포트 `skipped`에 `{ profile, reason: 'profile-boot-failed' }`로 남기고 (b) 자식 stdout/stderr를 진단에 첨부하고 (c) **나머지 프로파일은 계속 실행**하며 (d) 종합 판정은 **exit 1**이다. "조용히 건너뛰고 green"은 금지다 — 특히 `failclosed`(0.0.0.0 바인딩)는 환경(방화벽·권한)에 따라 기동이 막힐 수 있는데, 그것이 통과로 위장되면 수집 fail-closed 계약이 검증되지 않은 채 green이 된다.

전 프로파일 종료 후:
- `CONTRACT_REPORT_DIR`의 JSONL을 모두 읽어 `(profile, routeId, tag, caseId)`로 **정렬**해 하나의 리포트 JSON으로 합친다(스키마는 B).
- **커버리지 판정**: `endpoints.json`의 각 라우트 `expect` 태그가 리포트에 존재하는지. 미달 목록을 사람이 읽을 수 있게 출력하고, `--require-full-coverage`면 exit 1.
- **데이터 안전 단언**: 리포 `news.db`(존재 시 size·mtime)와 `uploads/` 엔트리 수의 before/after가 다르면 실패 + exit 1.
- stdout 마지막 줄에 `contract-run <ok|FAILED> profiles=<n> cases=<n> covered=<n>/39 skipped=<n> report=<path>` 요약을 남긴다.

### B. 리포트 스키마 (이중 실행 diff의 기반 — decisions (11)(12))

```json
{ "version": 1,
  "meta": { "target": "node|external", "profiles": ["default", "..."], "routeCount": 39 },
  "observations": [
    { "profile": "default", "routeId": "health", "tag": "success", "caseId": "health/ok",
      "status": 200, "ok": true, "reason": null,
      "bodyKeys": ["ok"], "values": { "ok": true },
      "headers": { "content-type": "application/json; charset=utf-8" } }
  ],
  "skipped": [ { "profile": "prod-cookie", "reason": "profile-unavailable" } ] }
```

- `bodyKeys`는 **정렬된 최상위 키 목록**. 배열 응답 원소의 키는 `values`에 요약해 담는다.
- `values`는 **결정적인 값만** 담는 화이트리스트다(불리언·상태 문자열·사유 토큰·존재 여부 플래그). **금지**: sessionId·쿠키 값·비밀번호·본문(markupVersion)·로그 라인·타임스탬프·articleId·포트·업로드 hex 파일명·절대 경로 → 단언에는 쓰되 리포트에는 `"<redacted>"`로만 남긴다.
- `headers`는 계약상 의미 있는 것만(`content-type`, `set-cookie`는 **속성만 정규화한 형태**, `access-control-allow-origin`). 값 원문(토큰)은 절대 담지 않는다.
- **`routeId` 규칙(커버리지 오염 방지)**: `routeId`는 원칙적으로 `endpoints.json`의 id여야 한다. 인벤토리에 **없는** 라우트(예: 존재하지 않아야 하는 `DELETE /api/distribution-targets/:id`의 404 관측)는 `x-` 접두사 id(`x-distribution-targets-delete` 등)로만 기록하며, **커버리지 집계에서 제외**되고 리포트·diff에만 남는다. 인벤토리에 없는 non-`x-` id가 발견되면 러너는 그것을 **오류로 보고**한다(오타가 조용히 커버리지를 비켜 가지 못하게).

## Acceptance Criteria

```bash
node scripts/contract-run.mjs --boot-check --profile default
node scripts/contract-run.mjs --boot-check
node scripts/contract-inventory-check.mjs
npm test
npm run lint
git status --porcelain
```

기대: 첫 두 커맨드 exit 0(두 번째는 **5 프로파일 전부** 기동·health 왕복·종료) · `npm test` **1327/1327 그대로** · lint clean(`scripts/**`는 eslint ignore 대상이지만 문법 오류가 없어야 실행된다) · 리포 데이터 무변 단언 통과 · 임시 디렉토리 잔존 0.

## 검증 절차

1. 하네스를 쓰기 전에 **손으로** 서버를 한 번 띄워 본다(임시 DATA_DIR·빈 포트·명시 env) — `GET /api/health` 응답과 부팅 로그를 눈으로 확인하고 요약에 남긴다.
2. `--boot-check`(전 프로파일)를 돌려 5 프로파일의 **기동 시간·선택된 포트·종료 여부**를 요약에 기록한다. `failclosed`(0.0.0.0)에서 방화벽 프롬프트가 떴는지도 기록한다(index.json open_questions (d)의 실측 근거).
3. **포트 범위 확인**: 선택된 포트가 전부 [45000, 49152) 안이고 기존 두 구간과 겹치지 않는지 확인한다. `npm test`의 `verify-integration-portrange` 잠금이 계속 green인지도 본다(이 step은 그 스크립트를 건드리지 않는다).
4. **기동 실패 경로 실증(변이)**: 프로파일 하나의 `PORT`를 이미 점유된 포트로 강제하거나 spawn 커맨드를 일부러 틀리게 만들어 → (a) 그 프로파일이 `profile-boot-failed`로 skipped 되고 (b) 나머지 프로파일이 계속 돌고 (c) 종합 exit이 1인지 확인한 뒤 원복한다. **이 실증이 없으면 조용한 skip으로 거짓 green이 날 수 있다.**
5. **자격증명·세션 파일 확인**: `--boot-check --keep`으로 남긴 임시 파일에서 `sessions.json`·`credentials.json`이 기대 shape인지 확인하고, 확인 후 **반드시 삭제**한다(비밀번호가 담긴 파일이다 — 요약에 값 금지, shape만).
6. **외부 대상 모드 가드**: `--base-url-map`만 주고 `--credentials`를 생략하면 즉시 실패하는지 확인한다(비밀번호 추측 금지 계약).
7. **데이터 안전 단언 실증**: 스냅샷 함수가 보는 대상 경로를 임시로 바꿔 차이를 만들어 실패로 잡히는지 확인하고 원복한다. **리포 `news.db`를 실제로 건드리는 실험은 절대 금지.**
8. AC 전부 실행 후 `git status --porcelain` 증분이 소유 파일(`scripts/contract-run.mjs`·`phases/67-port-p1-contract/index.json`)뿐인지 시작 시점 스냅샷 대비로 확인한다.
9. 아키텍처 체크: `server/**`·`src/**`·`test/**`·`web/**`·`client/**` 무수정 · `package.json` 무수정(npm script는 다음 step 소유) · 새 의존성 0.
10. index.json step1 status·summary 갱신(프로파일 5종 기동 실측·포트 범위·변이 결과).

## 금지사항

- 케이스 파일이나 `contract/lib/**`를 이 step에서 만들지 마라. 이유: 한 step은 한 레이어만 만진다(다음 step의 소유이며, 섞이면 실패 원인 격리가 무너진다).
- 포트 범위를 [20000, 35000)·[35000, 45000)에서 고르지 마라. 이유: `verify-integration`의 서버·CDP 구간과 겹쳐 병행 실행 시 경합하고, 그 불변식은 기존 텍스트 잠금 테스트가 지키고 있다.
- 프로파일 기동 실패를 경고로 넘기지 마라. 이유: 검증되지 않은 계약이 통과로 위장되고, 그 사실이 리포트·diff에도 남지 않는다.
- 케이스가 비밀번호를 알도록 설계하지 마라(자격증명은 러너가 파일로 공급). 이유: 68+ Spring 대상은 계정·비밀번호가 다를 수 있고, 하드코딩하면 스위트 전체가 재작성 대상이 된다.
- 리포 `news.db`·`uploads/`·`%APPDATA%`·`dist/**`를 대상으로 서버를 띄우거나 파일을 쓰지 마라. 이유: 실 데이터 오염은 되돌릴 수 없다(CLAUDE.md DB 비파괴).
- 러너가 서버를 남긴 채 종료되게 두지 마라. 이유: 다음 프로파일이 같은 DATA_DIR/포트로 뜨지 못하고(ADR-012 단일 인스턴스 잠금) 원인 불명의 실패가 된다.
- 자격증명·세션 파일 내용을 로그·요약·리포트에 남기지 마라. 이유: 세션 토큰과 비밀번호는 그 자체가 권한이다(ADR-004·LOGS.md).
