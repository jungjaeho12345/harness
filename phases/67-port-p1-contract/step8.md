# Step 8: collection

**수집 인제스트 2 라우트**를 동결한다: `POST /api/collection/receive`(#35) · `POST /api/collection/pull`(#36). 이 두 라우트는 세션 게이트가 없고 방어가 **"loopback 바인딩 + 선택적 토큰"** 둘뿐이라, 구성에 따라 동작이 갈리는 유일한 라우트다. 그래서 프로파일 3종(`default`=토큰 있음 · `minimal`=토큰 없음 · `failclosed`=비-loopback 바인딩 + 토큰 없음)에서 각각 관측한다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(5)(6)(7)(9)(14)(16)(18)** · excluded (e)
- `docs/api-contract/endpoints.json` — `collection-receive`·`collection-pull` 행(`notes`에 프로파일 3종)
- `server/index.js` — 수집 라우트 2개(1067~1122행: fail-closed 가드 → 토큰 검사 → 위임), `isLoopbackHost`(127~132행), `requireCollectionToken` 주입 지점(1341~1346행), `logHostDiagnostics`(149~158행)
- `src/services/collectionService.js` 전체(69줄) — `receive`/`pull`의 판정과 토큰(`unregistered`·`inactive`·`fetch-failed`·`no-active-api-source`)
- `src/parsers/parser.js` · `src/parsers/defaultParser.js` — payload에서 제목·본문을 뽑는 규칙(**요청 payload shape가 계약이다**)
- `src/models/receiverConfigModel.js` — sourceId 조회·active 판정
- `docs/RCV.md` 전체(23줄) — 수집 스펙(미등록 ID 차단·속성 '자동기사')
- `docs/ARCHITECTURE.md` "보안 경계 > 수집 fail-closed" 절
- `test/collectionService.test.js` · `test/host-binding.test.js` — 예측 수립용

## 배경

- 가드 순서가 계약이다: **fail-closed(503) → 토큰(401) → 서비스 판정(403 등)**. 순서가 바뀌면 미구성 서버가 토큰 오류를 먼저 노출한다.
- `default` 프로파일은 `COLLECTION_TOKEN`이 설정돼 있으므로 `x-collection-token` 헤더가 맞아야 통과한다(틀리면 401 `unauthenticated`).
- `minimal` 프로파일은 토큰 미설정 + loopback이므로 **토큰 없이 통과**한다(이 개방이 loopback 전제의 계약이다).
- `failclosed` 프로파일은 `HOST=0.0.0.0` + 토큰 미설정이므로 두 라우트가 **503 `collection-disabled`**다(다른 기능은 정상).
- `pull`은 서버가 외부를 호출한다. 결정성을 위해 **외부 인터넷을 쓰지 않는다** — 등록하는 `apiEndpoint`는 (a) 성공 경로: **테스트 대상 서버 자신의 `/api/health`**(loopback, 항상 200 JSON) (b) 실패 경로: 아무도 듣지 않는 loopback 포트(예: `http://127.0.0.1:1/`)로 잡는다.

## 작업

### A. `contract/cases/default/collection.contract.js` (토큰 있음)

1. **토큰 인가**: `POST /api/collection/receive`를 (a) 헤더 없이 (b) 틀린 토큰으로 → 401 `unauthenticated`. (c) 올바른 토큰(`CONTRACT_COLLECTION_TOKEN` env로 러너가 넘긴다) + **미등록 sourceId** → 403 `unregistered`.
2. **등록 후 수신 성공**: step7에서 동결한 `POST /api/receiver-config`로 고유 sourceId를 등록(Z 세션) → 올바른 토큰 + 그 sourceId + payload → 200 · 응답 shape 실측(`articleId`가 오는지 등). 이어서 `GET /api/articles?articleId=<...>`(또는 검색)로 되읽어 **제목·본문이 파서 규칙대로 채워졌고 `attribute`가 '자동기사'인지** 확인(RCV.md 규칙 — 실측으로 확정).
3. **비활성 소스**: 설정을 만들 때 `active:'N'`으로 만든 sourceId로 수신 → 실측 상태/토큰(`unregistered`인지 `inactive`인지 — 예측과 대조해 기록).
4. **payload 형태**: 파서가 요구하는 필드를 코드에서 확인해 (a) 정상 payload (b) 필수 필드 누락 payload 두 케이스를 만들고 결과를 실측한다. 잘못된 payload가 200으로 통과해 빈 기사를 만든다면 그 사실이 계약이며 요약·명세에 명시한다.
5. **pull 성공 경로**: `type:'API'` + `apiEndpoint = <대상 서버 base URL>/api/health` 설정을 등록 → 올바른 토큰 + 그 sourceId로 `POST /api/collection/pull` → 결과를 **실측**해 명세에 기록한다(파싱 성공/실패 어느 쪽이든 그것이 계약이다).
6. **pull 실패 경로**: `apiEndpoint = http://127.0.0.1:1/`(연결 거부) → 실측 상태/토큰(`fetch-failed` 예상). 타임아웃이 길어지면 러너 타임아웃 안에서 끝나는지 확인하고, 오래 걸리면 그 사실을 요약에 남긴다.
7. **pull 미등록/비-API 소스**: 미등록 sourceId → 403 `unregistered`. `type:'FTP'` 소스로 pull → 실측(`no-active-api-source` 예상).
8. **DB 비파괴 경계 케이스**(step7에서 이관): 2에서 수집된 기사를 남긴 채 그 `ReceiverConfig` 행을 `DELETE`한다 → 200 · **기사는 그대로 조회된다**(`GET /api/articles?articleId=<...>` 200 + 동일 필드). 이 케이스가 "설정 행만 지운다"는 계약의 유일한 실증이다.

### B. `contract/cases/minimal/collection-open.contract.js` (토큰 미설정)

1. 토큰 헤더 **없이** `POST /api/collection/receive` + 미등록 sourceId → 403 `unregistered`(= 토큰 게이트를 통과했다는 증거이지 개방 취약점 리포트가 아니다).
2. 등록 후 토큰 없이 수신 성공 → 200.
3. 아무 값이나 담은 `x-collection-token` 헤더를 보내도 **무시**되는지 확인(서버가 토큰 미설정이면 헤더를 보지 않는다).

### C. `contract/cases/failclosed/collection-disabled.contract.js`

1. `POST /api/collection/receive` → **503 `collection-disabled`**(토큰 헤더 유무와 무관하게 2케이스).
2. `POST /api/collection/pull` → 503 `collection-disabled`.
3. **같은 서버의 다른 기능은 정상**: `GET /api/health` 200 · 세션 라우트가 정상 동작(이 프로파일에는 러너 세션이 준비돼 있다 — 없다면 `GET /api/session` 401로 대신한다). 이유: fail-closed가 서버 전체를 죽이는 것이 아니라 두 라우트만 닫는다는 것이 계약이다.

### D. 명세 반영 `docs/api-contract/openapi.yaml`

- 2 라우트 paths 추가. **가드 순서(503 → 401 → 403)** 와 3가지 구성별 동작 표를 description에 명시한다.
- 요청 payload 스키마(파서가 읽는 필드)와 "미등록 sourceId는 수신 거부"를 명시한다.
- `x-collection-token` securityScheme을 이 두 라우트에만 붙인다.

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/collection.contract.js
npm run test:contract -- --profile minimal --files contract/cases/minimal/collection-open.contract.js
npm run test:contract -- --profile failclosed
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. 예측 먼저: 3 프로파일 × 2 라우트의 기대 상태를 표로 적고 실측과 대조한다(비활성 소스·잘못된 payload·pull 실패 3건은 예측이 빗나가기 쉽다).
2. **egress 0 확인**: 이 step이 만드는 어떤 요청도 외부 인터넷으로 나가지 않는지 확인한다(등록한 `apiEndpoint`가 전부 loopback인지 코드로 확인 + 요약에 근거 기록). 이유: ADR-008의 egress 0 규율과 오프라인 결정성.
3. **vacuity 변이 2종**(각각 원복): (a) C-1의 기대 상태를 503→401로 바꿔 red 확인 (b) A-1(c)의 기대 토큰을 `unregistered`→`unregister`로 바꿔 red 확인.
4. `failclosed` 프로파일에서 0.0.0.0 바인딩 시 방화벽 프롬프트가 떴는지, 접속(127.0.0.1)이 정상이었는지 요약에 기록한다(index.json open_questions (d)의 실측 근거).
5. AC 전부 실행 · 결정성(연속 2회 green) 확인.
6. `git status --porcelain` 증분 = 케이스 3파일 · `docs/api-contract/openapi.yaml` · `phases/67-port-p1-contract/index.json`.
7. 아키텍처 체크: 서버 코드 무수정 · `npm test` 1327 유지.
8. index.json step8 status·summary 갱신(3 프로파일 실측 표 포함).

## 금지사항

- `apiEndpoint`에 외부 인터넷 주소를 넣지 마라. 이유: 오프라인·폐쇄망에서 스위트가 무너지고, 앱이 외부로 나가지 않는다는 ADR-008 규율을 스위트가 스스로 어기게 된다.
- 수집으로 만든 기사를 지우려 하지 마라. 이유: DB 비파괴 원칙이며 그런 API도 없다(A-8은 **설정 행만** 지운다).
- `failclosed` 프로파일에 다른 도메인 케이스를 추가하지 마라. 이유: 그 프로파일의 목적은 "수집 2 라우트가 닫힌다"는 단일 사실의 관측이고, 비-loopback 바인딩이라 환경(방화벽)에 영향을 받는다 — 다른 계약이 환경 문제로 함께 무너지면 안 된다.
- 토큰 값을 리포트·요약에 남기지 마라. 이유: `COLLECTION_TOKEN`은 인증 자격이다(테스트 값이라도 규율은 같다).
- 수집 라우트에 세션 인증을 기대하는 케이스를 쓰지 마라. 이유: 이 두 라우트는 사용자 세션 라우트가 아니다(토큰·바인딩이 유일한 방어) — 세션을 요구하도록 명세를 적으면 Spring이 잘못 구현한다.
- pull 실패 케이스에서 재시도·백오프를 기대하지 마라. 이유: 앱은 자동 재시도를 하지 않는다(ADR-008) — 1회 시도 후 사유 토큰 반환이 계약이다.
