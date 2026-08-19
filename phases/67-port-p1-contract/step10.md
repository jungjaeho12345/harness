# Step 10: distribution

**배부 7 라우트**를 동결한다: 수신처 CRUD `GET/POST /api/distribution-targets`·`PUT /api/distribution-targets/:id`·`POST /api/distribution-targets/:id/deactivate`(#11~#14) · `POST /api/distribution/tick`(#15) · `GET /api/distribution/failures`(#16) · `POST /api/distribution/retry`(#17). 계약 축은 **Z 전용 인가**, **행 삭제 없음(soft delete만)**, **tick은 body를 읽지 않는다**, **응답에 서버 파일시스템 경로가 실리지 않는다**, **미구성 서버는 503 `spool-disabled`** 다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(5)(6)(7)(9)(11)(14)(16)(18)(23)** · excluded (f)
- `docs/api-contract/endpoints.json` — `distribution-targets-*`·`distribution-tick`·`distribution-failures`·`distribution-retry` 행
- `docs/ADR.md` **ADR-008 전문** — 파일 스풀 outbound · tick pull · 앱 내 타이머/egress 0 · 자동 재시도 없음 · stale-cycle 거부
- `server/index.js` — targets 4 라우트(709~738행: **삭제 라우트를 두지 않는다는 주석**), tick(744~752행: body 미사용·배부 1건 이상일 때만 SSE), failures(758~764행: `limit`만 화이트리스트), retry(766~790행: `historyId`만 읽음 + 500 매핑 3토큰)
- `src/services/distributionTargetService.js` — 검증 토큰(`invalid-name`·`invalid-kind`·`invalid-spool-dir`·`duplicate-spool-dir`·`invalid-active`·`not-found`)
- `src/services/distributionTickService.js` — `run()` 반환 shape(`{ok,at,scanned,distributed,failed,invalid}`·`skipped:'in-progress'`)와 `tick-failed`
- `src/services/distributionRetryService.js` — `list()`/`retry()` 반환 shape와 거부 토큰 8종
- `src/services/embargoPolicy.js` — 도래 판정(1차=언론사·2차=비언론사)
- `docs/SCHEMA.md` DistributionTarget 절 · ArticleHistory의 `targetId`/`reason` 컬럼
- `test/distribution-targets-api.test.js` · `test/distribution-tick-api.test.js` · `test/distribution-failure-api.test.js` — 예측 수립용(특히 응답 위생 단언)

## 배경

- 이 7 라우트는 전부 **Z 전용**이고, 게이트는 라우트가 아니라 서비스/authorization이 강제한다(미인증 401 · 비-Z 403).
- **삭제 라우트가 없다**는 것이 계약이다(`DELETE /api/distribution-targets/:id`는 존재하지 않는다 — 404여야 한다). 제거는 `active='N'` soft delete뿐이다.
- tick은 **body를 읽지 않는다**(`role`·시각·대상 목록을 클라가 주입하면 엠바고가 무력화된다 — ADR-004). GET으로 열려 있지 않다.
- tick/retry 응답에는 **스풀 디렉토리·파일 경로가 실리면 안 된다**(서비스의 화이트리스트 투영이 transport까지 유지되는지가 계약).
- `minimal` 프로파일(`DIST_SPOOL_DIR` 미설정)에서는 tick·retry가 **503 `spool-disabled`**, failures는 스풀 설정과 무관하게 동작한다(조회는 항상 결선).
- 배부 실패 행을 API만으로 결정적으로 만들 수 없다(수신처 CRUD가 잘못된 spoolDir를 애초에 거부한다) → #16·#17은 "빈 목록 shape·인가·`no-failure`·`spool-disabled`" 축만 동결한다(excluded (f), forward_notes에 미동결로 기록).

## 작업

### A. `contract/cases/default/distribution-targets.contract.js`

1. **인가**: 4 라우트 × (미인증 401 · R 세션 403 · D 세션 403 — D도 안 된다는 것이 계약이다) 전수.
2. **생성**: Z로 `{name, kind:'press', spoolDir:'ct-<unique-slug>'}` → 200 · 응답 shape 실측(`id` 등). `kind:'nonpress'` 1건 더.
3. **검증 거부**: `name` 누락 → `invalid-name` · `kind:'bogus'` → `invalid-kind` · `spoolDir`에 경로 구분자/상대 경로(`../x`, `a/b`) → `invalid-spool-dir` · 이미 쓰는 spoolDir 재사용 → `duplicate-spool-dir` · `active:'x'` → `invalid-active`. **각각의 HTTP 상태를 실측**해 명세에 기록(전역 fallback 400인지 확인).
4. **목록**: Z로 `GET` → 자기 수신처가 보인다(절대 개수 단언 금지) · 행의 키 집합 실측(`spoolDir`가 응답에 실리는지 — 실린다면 그것이 계약이며 명세에 명시).
5. **수정**: `PUT`으로 name 변경 → 200 · 되읽어 반영 · `updatedAt` 존재. 없는 id → 404 `not-found`. 숫자 아닌 id → 실측.
6. **soft delete 2경로**: (a) `POST /:id/deactivate` → 200 · 되읽어 `active='N'` · **행이 목록에서 사라지지 않고 남아 있는지** 실측(목록 필터 정책이 계약이다) (b) `PUT`에 `active:'N'` → 같은 결과.
7. **삭제 라우트 부재**: `DELETE /api/distribution-targets/<id>` → **404**(라우트 없음). 이 케이스가 "행 삭제 경로가 없다"는 계약의 유일한 실증이다.
   - 기록은 **커버리지 집계 제외 채널**로 한다: `record('x-distribution-targets-delete', 'not-found', ...)`. `x-` 접두사는 "인벤토리에 없는 라우트에 대한 관측" 전용이며(step0 F·step1 리포트 스키마 B의 규칙) 커버리지에는 잡히지 않고 리포트·diff에만 남는다.
   - **인벤토리에 있는 라우트 id(`distribution-targets-deactivate` 등)에 이 관측을 매달지 마라** — 실재하는 라우트의 `not-found` 태그가 거짓으로 채워져 커버리지가 오염된다.

### B. `contract/cases/default/distribution-tick.contract.js`

1. **인가**: tick·failures·retry × (미인증 401 · R 403 · D 403).
2. **메서드 계약**: `GET /api/distribution/tick` → 404(부수효과 라우트를 GET으로 열지 않는다).
3. **tick 성공(빈 실행)**: Z로 `POST` (body 없음) → 200 · 키 집합 `{ok, at, scanned, distributed, failed, invalid}` 실측 · `distributed`가 배열.
4. **tick body 무시**: body에 `{role:'Z', now:'2999-01-01T00:00:00Z', targets:[...], articleId:'...'}`를 넣어도 3번과 **같은 shape·같은 판정**이 나오는지 확인(주입이 통하지 않는다는 음성 증거).
5. **tick 실배부**: (a) A에서 만든 활성 press 수신처가 있는 상태에서 (b) `embargoAt`을 **과거 시각**으로 설정한 기사를 만들고 D로 send(마커 포함) → status 실측(`DES` 예상) (c) Z로 tick → 200이며 `distributed`에 그 기사 항목이 있다(항목 키 집합 실측) (d) `GET /api/articles/:id`로 되읽어 `distributedAt`이 채워지고 status가 승격됐는지 확인. **비동기 승격 가능성 때문에 되읽기는 폴링(타임아웃 있는 조건 대기)으로 한다** — 고정 sleep 금지.
6. **응답 위생**: 3·5의 tick 응답 전체 문자열에 스풀 루트 경로·`spoolDir` 값·`.json` 파일명이 **없는지** 단언한다(경로 유출 방지 투영의 실증).
7. **멱등**: 5 직후 같은 조건으로 tick 재실행 → 같은 기사가 **다시 배부되지 않는다**(`distributed`에 없음). 이력 기준 멱등이 계약이다.
8. **failures 빈 목록**: Z로 `GET /api/distribution/failures` → 200 `{ok:true, items:[...]}` · items 원소 키 집합은 비어 있으면 확인 불가이므로 "빈 배열도 계약"으로 기록. `?limit=1`·`?limit=abc`(NaN)·`?limit=-1` 각각의 동작 실측(정규화·클램프는 서비스 책임).
9. **retry 거부**: Z로 `POST /api/distribution/retry` `{historyId: 999999999}` → 404 `no-failure`. `historyId` 누락/문자열 → 실측(`no-failure` 예상). 다른 사용자(R/D) → 403.

### C. `contract/cases/minimal/distribution-disabled.contract.js`

1. Z로 tick → **503 `spool-disabled`**.
2. Z로 retry(임의 historyId) → **503 `spool-disabled`**(인가 → 설정 판정 순서 확인: 비-Z는 503이 아니라 403이어야 한다 — 1건으로 못 박는다).
3. Z로 failures → **200**(조회는 스풀 설정과 무관하게 결선된다).
4. 수신처 CRUD는 스풀 설정과 무관하게 동작하는지 1건(생성 → 200).

### D. 명세 반영 `docs/api-contract/openapi.yaml`

- 7 라우트 paths 추가.
- tick: "body를 읽지 않는다"·"GET 없음"·"실제 배부가 있을 때만 SSE `status` 신호"·응답 필드 의미(`scanned`/`distributed`/`failed`/`invalid`/`skipped:'in-progress'`)를 description에.
- targets: "삭제 라우트 없음 — soft delete만", spoolDir 슬러그 규칙, kind enum을 명시.
- retry: "식별자는 `historyId` 하나뿐이며 나머지는 서버가 실패 행에서 도출한다"와 500으로 가는 3토큰(`spool-write-failed`·`invalid-spool-dir`·`invalid-article-id`)을 명시.
- `spool-disabled` 503의 조건(`DIST_SPOOL_DIR` 미설정)을 명시.

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/distribution-targets.contract.js,contract/cases/default/distribution-tick.contract.js
npm run test:contract -- --profile minimal --files contract/cases/minimal/distribution-disabled.contract.js
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. 예측 먼저: 검증 거부 5종의 HTTP 상태, `DELETE` 라우트 부재 시 상태, minimal에서 비-Z retry의 상태(403 vs 503)를 예측하고 실측과 대조해 요약에 남긴다.
2. **스풀 산출물 확인**: B-5 실행 후 임시 `DIST_SPOOL_DIR` 아래에 파일이 생겼는지 확인한다(러너가 그 경로를 알고 있으므로 요약에 "파일 n개 생성" 사실만 기록 — 경로·내용은 리포트에 넣지 마라). 리포 밖 경로에는 아무것도 생기지 않아야 한다.
3. **vacuity 변이 2종**(각각 원복): (a) B-6 응답 위생 단언을 "경로가 있어야 한다"로 뒤집어 red 확인 (b) C-1의 기대 토큰을 `spool-disabled`→`spool_disabled`로 바꿔 red 확인.
4. B-7(멱등) 케이스가 **B-5 없이 단독 실행돼도** 의미가 있도록 같은 파일 안에서 순서 의존을 명시적으로 만든다(같은 파일·직렬 실행 전제). 파일 단독 재실행이 green인지 2회 확인한다.
5. AC 전부 실행 · 리포트 누출 재확인(spoolDir·경로·articleId가 없어야 한다).
6. `git status --porcelain` 증분 = 케이스 3파일 · `docs/api-contract/openapi.yaml` · `phases/67-port-p1-contract/index.json`.
7. 아키텍처 체크: 서버 코드 무수정 · `npm test` 1327 유지 · **앱 내 타이머/egress를 유발하는 케이스 0**(tick은 외부 pull이라는 계약 그대로).
8. index.json step10 status·summary 갱신(미동결로 남긴 실패 원장 축을 명시).

## 금지사항

- 배부 실패를 억지로 만들려고 서버·파일시스템 권한을 조작하지 마라(예: 스풀 디렉토리를 읽기 전용으로 바꾸기). 이유: 환경 의존적이라 다른 머신·Spring에서 재현되지 않고, 실패 원장 계약은 기존 backend 테스트가 소유한다(excluded (f)).
- tick을 반복 호출해 성능·경합을 탐색하지 마라. 이유: 실제 스풀 파일이 쌓이고 실행 시간이 늘며, 동시성 계약(`skipped:'in-progress'`)은 이 스위트가 결정적으로 관측할 수 없다(미검증 기록).
- 수신처를 **비활성화하지 않은 채** 남기지 마라(케이스가 만든 press/nonpress 수신처). 이유: 같은 프로파일의 뒤 케이스에서 송고가 예상치 못한 배부를 유발해 status·distributedAt이 흔들린다. 각 케이스는 `finally`에서 자기 수신처를 deactivate한다.
- `DELETE /api/distribution-targets/:id`가 동작하기를 기대하거나 서버에 추가하지 마라. 이유: 행 삭제 없음이 ADR-008·SCHEMA.md의 명문 계약이다.
- tick body로 시각·대상·role을 주입해 배부를 유도하려 하지 마라(음성 케이스로만 쓴다). 이유: 그 주입이 통하면 엠바고가 무력화된다 — 통하지 않는 것이 계약이다.
- 앱에 주기 실행·재시도를 기대하는 케이스를 쓰지 마라. 이유: 앱에는 타이머가 없다(ADR-008) — 복구는 Z의 명시 재전송뿐이다.
