# Step 2: contract-lib

계약 케이스가 공유하는 **공용 lib 5종**과 **첫 케이스 1건(`GET /api/health`)**, `contract/README.md`, npm script `test:contract`를 만든다. 이 step이 끝나면 `npm run test:contract`가 실제 케이스를 실행하고 **정규화 리포트**를 만들며, 같은 실행을 2회 하면 리포트가 **바이트 동일**하다(이중 실행 diff 게이트의 전제).

## 읽어야 할 파일

- `CLAUDE.md`
- `phases/67-port-p1-contract/index.json` — decisions **(4)(5)(6)(8)(9)(10)(11)(15)(21)(22)(23)(26)**
- `phases/67-port-p1-contract/step1.md` — 러너 CLI·프로파일 표·**리포트 스키마 B**·자식에게 넘기는 env 6종(`CONTRACT_BASE_URL`·`CONTRACT_PROFILE`·`CONTRACT_SESSIONS`·`CONTRACT_CREDENTIALS`·`CONTRACT_REPORT_DIR`·`CONTRACT_COLLECTION_TOKEN`)
- `scripts/contract-run.mjs`(step1 산출물) — lib이 읽어야 할 파일 shape(`sessions.json`·`credentials.json`)의 실제 생성 코드
- `docs/api-contract/endpoints.json`(step0 산출물) — `routeId` 어휘와 태그 어휘
- `docs/LOGS.md` — 마스킹 규율(리포트 정규화의 근거)
- `server/index.js` — `GET /api/health`(606행), 세션 토큰 판독(586~589행: 쿠키 우선·`x-session-id` 폴백), SSE 프레임 형식(1137·1154행)
- `test/integration.smoke.test.js` 1~38행 — HTTP 왕복 헬퍼의 최소 형태(**참고만** — 이 lib은 서버 코드를 import하지 않는다)
- `eslint.config.js` — `contract/**/*.js`가 lint 대상(Node globals·ESM)임을 확인

## 배경 (설계 제약)

- `contract/**`는 `server/**`·`src/**`·`web/**`의 어떤 모듈도 import하지 않는다. 서버는 `CONTRACT_BASE_URL` 하나로만 접근한다.
- 케이스는 **비밀번호를 모른다**. 자격증명이 필요하면 `credentials(role)`로 러너가 공급한 값을 받는다(68+ Spring 대상은 계정이 다를 수 있어 `--credentials`로 덮어쓴다).
- 리포트 정규화가 결정적이지 않으면 이중 실행 diff가 무의미해진다 — 마스킹·정렬은 lib 한 곳에서만 한다.

## 작업

### A. `contract/lib/**` — 공용 모듈 (시그니처 수준 지시)

`contract/lib/http.js`
```js
export const BASE_URL;            // process.env.CONTRACT_BASE_URL (없으면 즉시 throw — 오구성 조용한 통과 금지)
export async function api(method, path, opts?) // opts: { sid, headers, body, query, raw, signal }
// 반환: { status, ok(=res.ok), json(파싱 실패 시 undefined), text(json이 없을 때만), headers(Headers) }
export function q(params)          // 반복 키 지원 쿼리 빌더: { status: ['RDS','DDH'] } → ?status=RDS&status=DDH
```
- `sid`는 **쿠키가 아니라 `x-session-id` 헤더**로 보내는 것을 기본으로 한다(쿠키 경로는 step3의 쿠키 계약 케이스가 별도로 검증한다).
- 절대 throw하지 않는다(네트워크 오류도 `{ status: 0, error }`로 정규화) — 케이스가 단언으로 실패를 표현하게 한다.

`contract/lib/session.js`
```js
export function actor(role)       // 'R'|'D'|'Z' → { sid, userId, name, role, department, departmentCode } (CONTRACT_SESSIONS)
export function sid(role)
export function credentials(role) // 'R'|'D'|'Z' → { userId, password } (CONTRACT_CREDENTIALS)
export function hasSessions()     // 세션 준비를 건너뛴 프로파일(auth-negative·prod-cookie)에서 false
```
- `actor`/`sid`는 세션 파일이 없으면 **명확한 메시지로 즉시 실패**한다(그 프로파일에서는 `credentials`로 직접 로그인하라는 안내 포함).
- `credentials`가 돌려주는 비밀번호는 **요청 body에만** 쓰고 로그·리포트·에러 메시지에 절대 넣지 않는다(마스킹 책임은 `record.js`가 지지만, 케이스가 직접 출력하는 것도 금지).

`contract/lib/record.js`
```js
export function record(routeId, tag, observation)  // observation: { status, ok, reason, bodyKeys, values, headers }
export function fromResponse(res, { values, headers } = {})  // 응답 → 정규화 observation(마스킹 규칙 내장)
```
- `CONTRACT_REPORT_DIR`에 파일당 1개의 JSONL로 append한다(파일명은 케이스 파일명 기반).
- 마스킹은 이 모듈 **한 곳**에서만 한다(케이스가 각자 마스킹하면 언젠가 한 곳이 새어 토큰이 리포트에 남는다).
- `routeId`는 `endpoints.json`의 id이거나 `x-` 접두사여야 한다(step1 리포트 스키마 B의 규칙 — 위반 시 즉시 실패하게 해서 오타가 커버리지를 비켜 가지 못하게 한다).

`contract/lib/fixtures.js`
```js
export function unique(prefix)                        // 충돌 없는 토큰(고유 문자열) — 사전 존재 데이터와 격리
export async function createArticle(role, overrides?) // POST /api/articles → { articleId, title }
export async function createSentArticle(overrides?)   // D로 create(끝 마커 포함) + POST action send → { articleId, status }
export async function createTarget(kind, overrides?)  // Z로 POST /api/distribution-targets → { id, spoolDir }
export async function createReceiverConfig(overrides?)// Z로 POST /api/receiver-config → { id, sourceId }
export async function acquireLock(articleId, role, clientId) // POST /api/articles/:id/lock
```
- 전부 **API로만** 만든다. 실패하면 명확한 메시지와 함께 throw한다(픽스처 실패를 계약 실패로 오인하지 않게).
- 본문의 `"(끝)"` 마커 포함 여부를 인자로 제어할 수 있게 한다(송고 가드 케이스가 양쪽을 다 쓴다).

`contract/lib/sse.js`
```js
export async function openStream(path, { sid, timeoutMs })
// 반환: { waitFor(predicate, timeoutMs) -> frame|null, frames(수신 누적), close() }
// frame: { event, data(원문 문자열), json(파싱 가능 시) }
```
- fetch 스트림을 읽어 `\n\n` 경계로 프레임을 자른다. **`ready` 프레임 수신 전에는 어떤 트리거도 쏘지 마라**(레이스).
- 모든 대기는 타임아웃으로 끝나고, 타임아웃은 `null` 반환(throw 아님). `close()`는 reader를 취소하고 커넥션을 끊는다(케이스는 `finally`에서 반드시 호출).

`contract/lib/profiles.js`
```js
export const PROFILE = process.env.CONTRACT_PROFILE;
export function requireProfile(name) // 다른 프로파일에서 실행되면 즉시 실패(케이스 오배치 방지)
```

### B. `contract/cases/default/health.contract.js` — 첫 케이스 1건

- `GET /api/health` → 200 · `{ok:true}` · `content-type`이 JSON · 인증 없이 통과.
- `record('health', 'success', ...)`가 리포트에 남는지 확인한다.

### C. `contract/README.md`

- 실행법(`npm run test:contract`, 프로파일/파일 한정 실행, `--boot-check`, 외부 서버 대상 실행).
- **대상 서버 사전조건 계약**(68+ Spring이 지켜야 할 것):
  - 계정 3종이 존재하고 **역할이 R/D/Z**이며 활성 상태일 것. 문서에는 **userId만** 적는다(`reporter`·`desk`·`admin`) — **비밀번호는 `src/db/seed.js`의 `SAMPLE_USERS`와 동일**하다고만 쓰고 값은 쓰지 않는다. 계정이 다른 서버는 `--credentials <file>`로 주입한다.
  - 프로파일 프리셋: **필수 3종**(`default`·`minimal`·`auth-negative`) / **선택 2종**(`failclosed`·`prod-cookie`). 선택 프로파일을 제공하지 않으면 그 케이스는 리포트에 `skipped`로 남고 diff에서 차이로 드러난다(통과로 위장되지 않는다).
  - 기존 데이터가 있어도 무방하며, 스위트는 대상 DB에 직접 쓰지 않는다(전부 API 경유).
- 케이스 작성 규칙: 서버 코드 import 금지 · 절대 개수 단언 금지 · 자기 픽스처만 단언 · **로그인 예산**(러너 3회 + 케이스 소수) · 비밀번호는 `credentials(role)`로만 · 리포트 마스킹 · `--test-concurrency=1` 전제 · `routeId`는 인벤토리 id 또는 `x-` 접두사.

### D. `package.json`

```
"test:contract": "node scripts/contract-run.mjs"
```
한 줄만 추가한다. `test` 스크립트는 건드리지 않는다.

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/health.contract.js
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

기대: 첫 두 커맨드 exit 0(두 번째는 미커버 라우트 38건을 **경고로** 나열하고 통과) · `npm test` 1327/1327 그대로 · lint clean(`contract/**`가 lint 대상이다) · 리포 데이터 무변 단언 통과.

## 검증 절차

1. **결정성 실증(이 step의 핵심)**: 같은 커맨드를 2회 돌려(`--out`으로 **OS 임시 디렉토리**의 두 파일에 기록) 두 리포트가 **바이트 동일**한지 확인한다. 다르면 원인(타임스탬프·랜덤 id·키 순서)을 찾아 정규화 규칙을 고친다. 비교 방법과 결과를 요약에 남긴다.
2. **누출 검사**: 리포트 전체를 스캔해 세션 토큰(64-hex)·비밀번호 문자열·`AKR` articleId·절대 경로가 없는지 확인한다(방법과 결과를 요약에 기록).
3. **routeId 규칙 실증(변이)**: 인벤토리에 없는 non-`x-` routeId로 `record`를 호출하면 즉시 실패하는지 확인하고 원복.
4. **vacuity 변이 2종**(각각 원복): (a) health 케이스의 기대 상태를 200→201로 바꿔 red 확인 (b) 세션 파일이 없는 프로파일에서 `actor('R')`를 부르면 안내 메시지와 함께 즉시 실패하는지 확인.
5. **외부 API 키 격리 확인**: 러너가 자식 env에서 키 4종을 지운다는 사실을 실제로 확인한다(임시로 `GOOGLE_TRANSLATE_API_KEY=dummy`를 부모 env에 두고 자식에 전달되지 않는지 관측 → 원복).
6. AC 전부 실행 후 `git status --porcelain` 증분이 소유 파일(`contract/lib/**`·`contract/cases/default/health.contract.js`·`contract/README.md`·`package.json`·`phases/67-port-p1-contract/index.json`)뿐인지 확인한다.
7. 아키텍처 체크: `contract/**`에 `server/`·`src/` import 0(직접 확인) · `scripts/contract-run.mjs` 무수정(step1 소유) · `test/**` 무수정 · `npm test` 스크립트 무변경 · 새 의존성 0.
8. index.json step2 status·summary 갱신.

## 금지사항

- `contract/**`에서 `server/`·`src/`·`web/`의 어떤 모듈도 import하지 마라. 이유: 그 순간 스위트가 Node 구현에 묶여 Spring 대상 실행이 불가능해진다 — 이 phase의 존재 이유가 사라진다.
- 케이스·lib에 비밀번호를 하드코딩하지 마라. 이유: 대상 서버의 계정이 다르면 스위트 전체가 재작성 대상이 된다(`credentials(role)`만 쓴다).
- `scripts/contract-run.mjs`를 수정하지 마라. 이유: step1의 소유이며, 러너 결함을 발견하면 요약에 남기고 마지막 step이 정리한다(두 step이 같은 파일을 만지면 증분 판정이 흐려진다).
- 고정 `sleep`으로 타이밍을 맞추지 마라. 이유: 느린 머신에서 flake, 빠른 머신에서 낭비다 — 조건 폴링 + 타임아웃만 쓴다.
- 리포트에 세션 토큰·쿠키 값·비밀번호·기사 본문·로그 라인을 담지 마라. 이유: 리포트는 CI 로그·Slack 보고로 흘러나갈 수 있다(LOGS.md 마스킹 규율).
- `npm test` 스크립트나 `test/**`를 고치지 마라. 이유: 기존 1327건과 계약 스위트는 별개 자산이고, 섞으면 실패 원인 격리가 무너진다.
- `--test-concurrency` 기본값(병렬)에 의존하지 마라. 이유: 케이스가 서로의 SSE 신호·레이트리밋 카운터를 흔들어 비결정적이 된다.
