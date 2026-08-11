# Step 2: docs-closeout

## 목표

step0·step1이 만든 **확정 계약**을 운영자가 읽는 문서에 반영하고, 이 phase로 **거짓이 된 ADR-009 2문장을 정정**한 뒤 phase를 마감한다. **실행 코드는 0줄이다.**

대상은 4개 파일뿐이다.

- `README.md` — 실행법(빌드 후 동일 출처 서빙)과 환경변수(`HOST`·`SPA_DIR`).
- `.env.example` — 새 환경변수(주석 처리된 예시).
- `docs/ARCHITECTURE.md` — 개요·보안 경계에 동일 출처 서빙·바인딩 정책·수집 fail-closed 반영.
- `docs/ADR.md` — **ADR-009 "가정과 실패 모드"의 2문장만** 정정(아래 작업 4의 범위를 벗어나지 마라).

`docs/news.md`는 **무접촉**이다.

## 읽어야 할 파일

- `README.md`(전문 60행) — 특히 6~7행(프론트/백엔드 출처 설명), 16~26행(실행법), 40~51행(환경변수 목록 — `COLLECTION_TOKEN`·`DIST_SPOOL_DIR`이 어떤 톤으로 적혀 있는지), 53~60행(테스트/검증).
- `.env.example`(전문 17행) — 주석 스타일(무엇이 기본값이고 미설정 시 어떻게 되는지 한 줄 설명 + 주석 처리된 예시).
- `docs/ARCHITECTURE.md` — 3~7행(개요), 8~30행(디렉토리 구조), 37~65행(데이터 흐름), 73~80행(보안 경계). 특히 75행(allowlist)·79행(운영 환경변수 주의: `NODE_ENV=production`은 세션 쿠키를 `Secure`+`SameSite=None`으로 만든다)의 서술 밀도와 톤.
- `docs/ADR.md` ADR-009(50~54행 전체) — **이 step이 정정하는 유일한 문서 결정문**이다. 정정 범위·정정문은 `phases/60-same-origin-serving/index.json`의 `adr_correction`에 확정돼 있다(오케스트레이터 결정: phase 55·57·59가 같은 방식으로 "그 phase가 거짓으로 만든 문장을 같은 phase에서 정정"해 왔고, PR 머지가 곧 사용자 승인이다).
- `server/index.js`(step0·step1 완료본) — 문서에 쓸 내용을 **실코드와 대조**하기 위해 반드시 읽어라: `resolveSpaDir`/`resolveSpaRoot`/`isSpaFallbackRequest`의 실제 규칙, `resolveHost`의 기본값과 빈 값 처리, `isLoopbackHost`의 판정 범위(127.0.0.0/8 포함), `logHostDiagnostics`의 경고 조건, 수집 라우트의 503 `collection-disabled` 가드 조건, `bootstrap()`의 결선 순서. **문서가 코드보다 앞서가면 안 된다** — 추측으로 쓰지 말고 구현된 대로만 써라.
- `phases/60-same-origin-serving/index.json` — `scope`·`decisions`·`adr_correction`·`excluded`, 그리고 step0·step1의 `summary`(실제로 구현된 내용의 1차 출처).
- `test/spa-serving.test.js`·`test/host-binding.test.js`(step0·step1 산출물) — 문서에 적을 규칙이 테스트로 잠겨 있는지 확인하라.

## 작업

### 1) `README.md`

- 6~7행의 출처 설명에 **개발 시 두 출처 / 배포 시 한 출처**를 한 줄로 구분해 적는다(현재는 SPA `:5173`, API `127.0.0.1:3001`만 적혀 있어 배포 형태를 오해하게 한다).
- 실행법(16~26행)에 **동일 출처 실행** 절차를 추가한다. 개발 흐름(`npm run server` + `npm run dev`, `http://localhost:5173/login.do`)은 **그대로 두고**, 그 아래에 배포/단일 출처 확인용 흐름을 덧붙인다.

```bash
npm run build      # web/dist 생성 (Vite)
npm run server     # 같은 서버가 SPA + API 를 서빙 → http://127.0.0.1:3001/login.do
```

  이때 다음 사실을 명시한다: `web/dist`가 없으면 SPA 서빙은 **비활성**이고 API만 뜬다(개발 흐름 무영향).
- 환경변수 목록(40~51행)에 2개를 추가한다. 문구는 실코드와 정확히 일치해야 한다.
  - `HOST` — listen 바인드 주소(기본 `127.0.0.1`). 다른 PC에서 접속하려면 `0.0.0.0` 등으로 설정한다. **loopback 밖으로 열면서 `COLLECTION_TOKEN`을 설정하지 않으면 수집 인제스트 HTTP 라우트(`POST /api/collection/receive`·`/pull`)가 503 `collection-disabled`로 비활성되고 부트 경고가 남는다**(FTP 스풀 수집은 영향 없음).
  - `SPA_DIR` — SPA 정적 루트(기본: 서버 모듈 기준 `web/dist`). `<루트>/index.html`이 없으면 서빙 비활성. 명시적으로 빈 값을 주면 강제 비활성.
- 기존 `COLLECTION_TOKEN` 항목(48행)에 "LAN 바인딩 시 사실상 필수"라는 취지를 한 구절 덧붙인다.
- (선택) 테스트/검증 절(53~60행)에 `npm run build` 후 `npm test`를 돌리면 실제 빌드 산출물 스모크 테스트가 skip 없이 실행된다는 한 줄을 덧붙인다.

### 2) `.env.example`

기존 스타일(설명 주석 + 주석 처리된 예시)대로 항목을 추가한다.

- `HOST` — 기본 `127.0.0.1`(로컬 전용). 예시는 **주석 처리**해 둔다(`# HOST=0.0.0.0`) — 복사만으로 네트워크가 열리면 안 된다. 위 주석에 "loopback 밖 + 토큰 미설정 = 수집 HTTP 라우트 503 비활성" 한 줄을 남긴다.
- `SPA_DIR` — 기본 `web/dist`, `index.html` 부재 시 비활성. 예시는 주석 처리(`# SPA_DIR=/opt/news/web-dist`).
- (선택) `COLLECTION_TOKEN` — 현재 이 파일에 항목이 없다. `HOST` 주석이 이 변수를 언급하므로 주석 처리된 항목(`# COLLECTION_TOKEN=change-me`)을 함께 두는 것을 허용한다. 값을 실제로 채워 넣지는 마라.

### 3) `docs/ARCHITECTURE.md`

- **개요(3~7행)**: 현재 *"기사 작성기는 두 프로세스로 분리된다"* 로 시작한다. 이 서술은 개발 시 사실이고 배포 시에는 한 출처로 수렴한다는 점을 덧붙인다(문장을 통째로 갈아엎지 말고 최소 보강 — 두 프로세스 분리라는 설계 자체는 유지된다).
- **데이터 흐름 또는 개요 근처**에 SPA 서빙 규칙을 3~5줄로 정리한다. 반드시 포함할 것:
  - 활성 조건: `SPA_DIR`(기본 `web/dist`)의 `index.html` 존재 — 부재 시 비활성(현행 동작).
  - 폴백 규칙: `GET`/`HEAD` + `/api`·`/uploads` 제외(대소문자 무관) + `Accept: text/html`인 요청만 `index.html`. 그 외는 기존 404 그대로.
  - 등록 위치: 모든 `/api` 라우트 뒤·전역 에러 핸들러 앞(API를 가리지 않음이 구조적으로 보장된다).
  - "정의되지 않은 경로 → 로그인 페이지"(news.md 39행)는 **SPA의 책임**이며 서버는 문서를 주기만 한다.
  - 트레이드오프 1줄: 정적 자산 요청도 액세스 로그에 남는다(Z 전용 링 버퍼 소음, SPA 1회 로드당 3줄 내외로 수용).
- **보안 경계(73~80행)**에 아래를 추가한다(각 1~2줄, 기존 항목 톤에 맞춰 불릿으로).
  - 바인딩: 기본 `127.0.0.1`, `HOST`로만 확장. loopback 판정은 `localhost`·`::1`·`[::1]`·`127.0.0.0/8`(`isLoopbackHost`).
  - **수집 fail-closed**: loopback 밖 바인딩 + `COLLECTION_TOKEN` 미설정이면 `POST /api/collection/receive`·`/pull`이 503 `collection-disabled`(부팅·다른 기능·FTP 스풀 인제스트는 정상, 부트 경고 동반). 근거는 이 두 라우트가 세션 게이트 없는 라우트라 바인딩을 여는 순간 방어가 0이 된다는 것.
  - 동일 출처 서빙에서는 `csrfOriginGuard`의 **자기 출처 판정**만으로 쓰기가 통과하므로 `ALLOWED_ORIGINS`는 빈 목록이 정상 구성이다(별도 출처 SPA·호스트 재작성 프록시에서는 여전히 명시 설정이 필요하다).
  - **평문 HTTP LAN 배포 주의(79행 항목 옆에)**: TLS 종단 없이 LAN에 여는 구성에서는 `NODE_ENV=production`을 켜지 마라 — 세션 쿠키가 `Secure`+`SameSite=None`이 되어 브라우저가 저장·전송하지 않아 **로그인이 조용히 실패**한다(HTTPS 종단은 외부 프록시 책임이며, 두 스위치는 서로 다른 축이라는 기존 79행 서술의 LAN 배포판 각주다).
  - **LAN 개방의 노출 범위**: 열린 순간 `/uploads` 정적 파일과 로그인 페이지·로그인 API도 같은 네트워크에서 도달 가능해진다. 업로드 파일명은 서버 발급 랜덤 hex라 열거는 어렵지만 URL을 아는 사람은 **인증 없이** 받을 수 있고(의도된 기존 계약), 로그인은 레이트리밋(15분/10회)에만 의존한다.

### 4) `docs/ADR.md` — ADR-009 2문장 정정 (**이 범위만**)

`phases/60-same-origin-serving/index.json`의 `adr_correction`에 확정된 문안대로 고친다.

- (a) *"앱 자체는 SPA 번들을 서빙하지 않는다 — `express.static`은 `/uploads` 하나뿐이다."* → 앱이 `SPA_DIR`(기본 `web/dist`, `index.html` 부재 시 비활성)로 SPA 번들을 같은 출처에서 서빙한다는 사실 + 폴백 규칙 요약(`GET/HEAD` · `/api`·`/uploads` 제외 · `Accept: text/html`) + 이 배치에서는 자기 출처 판정만으로 쓰기가 통과하므로 `ALLOWED_ORIGINS` 빈 목록이 정상 구성이라는 문장으로 교체.
- (b) 같은 절의 *"이 결정은 동일 출처 배포를 전제한다(리버스 프록시가 SPA와 `/api`를 같은 출처로 묶는 배치)"* — 전제 자체는 유지하되 실현 수단을 **"리버스 프록시 또는 앱 자체의 SPA 서빙(phase 60)"** 으로 넓힌다.
- 그 절의 나머지 서술(별도 출처 배포 시 `ALLOWED_ORIGINS` 필요, 미설정 시 프로덕션 쓰기 403, 조용한 실패, `logOriginDiagnostics` 경고, 부팅을 막지 않음)은 **그대로 유지한다** — 여전히 사실이다.
- **다른 ADR(001~008)·ADR-009의 다른 문단(결정·이유·트레이드오프)은 한 글자도 고치지 마라.** ADR-001의 "두 origin" 서술은 개발 구성 기준으로 여전히 유효하므로 손대지 않는다.
- 새 ADR을 만들지 마라 — 이 변경은 ADR-009가 이미 전제한 동일 출처 배포를 앱 안에서 실현할 뿐 아키텍처 방향·계층·외부 계약을 바꾸지 않는다.

### 5) phase 마감

`phases/60-same-origin-serving/index.json`의 step2를 `completed` + `summary`로 갱신한다. **`phases/index.json`(top-level)은 건드리지 마라** — 최종 상태 마킹은 리뷰 게이트 통과 후 오케스트레이터가 한다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step1 종료 시점과 동일 개수(문서 step이므로 증감 0)
npm run test:web  # 실패 0 — 2368/2368(90 files) 기준선 유지
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `README.md`, `.env.example`, `docs/ARCHITECTURE.md`, `docs/ADR.md` **4개**(+ 진행 기록 `phases/60-same-origin-serving/index.json`)뿐. **`server/**`·`src/**`·`web/**`·`test/**` 증분 0**(실행 코드 0줄의 증거), `docs/news.md` 증분 0.

**ADR diff 확인**: `git diff docs/ADR.md`가 **ADR-009 절 안의 2군데**만 보여야 한다. 다른 ADR 번호의 줄이 diff에 나타나면 범위를 벗어난 것이다.

**추가 확인**: `git diff phases/index.json`으로 60 항목이 여전히 `pending`이고 그 외 변경이 없는지 확인하라.

**web 스위트 주의**: `npm run test:web`은 드물게 1건이 비고정으로 실패한 전례가 있다(병렬 실행 flake). 1회 실패 시 회귀로 단정하지 말고 재실행 2회로 판정하라 — 이 step은 `web/**`을 수정하지 않으므로 회귀 가능성 자체가 없다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(`npm test` 개수가 step1 종료 시점과 **정확히 같아야** 한다 — 문서 step이 테스트를 늘렸다면 범위를 벗어난 것이다).
2. **문서-코드 대조**(이 step의 핵심): 새로 쓴 문장 하나하나를 `server/index.js` 실코드와 맞춰 확인하라.
   - `HOST` 기본값이 문서와 코드에서 같은가(`127.0.0.1`)?
   - loopback 판정 범위 서술이 `isLoopbackHost` 구현과 같은가(127.0.0.0/8 포함)?
   - 503 발동 조건 서술이 라우트 가드 조건(`requireCollectionToken && !process.env.COLLECTION_TOKEN`)과 같은가? reason 문자열이 `collection-disabled`로 정확한가?
   - `SPA_DIR` 기본 경로 서술이 실제 해석 규칙(모듈 기준 `../web/dist`, 빈 값이면 비활성, `index.html` 부재 시 비활성)과 같은가?
   - 폴백 3조건(GET/HEAD · `/api`·`/uploads` 제외(대소문자 무관) · `Accept: text/html`)이 `isSpaFallbackRequest` 구현과 정확히 일치하는가?
   - 어긋나는 곳이 있으면 **코드가 아니라 문서를 고쳐라**(이 step은 실행 코드 0줄이다). 코드가 틀렸다고 판단되면 고치지 말고 `error`로 보고하라.
3. `git diff --stat`으로 실행 코드 증분이 0인지, `git diff docs/ADR.md`로 정정 범위가 ADR-009 2군데인지 확인한다.
4. 아키텍처 체크리스트:
   - `docs/news.md`가 무수정인가?
   - ADR-009의 결정·이유·트레이드오프 문단이 무수정인가(정정은 "가정과 실패 모드" 절 2군데뿐)?
   - 문서가 ADR-004(신뢰 경계)·ADR-008(타이머·egress 없음)·ADR-006(계층)과 모순되는 서술을 만들지 않았는가?
   - README의 개발 흐름(`npm run dev` + `:5173`) 설명이 **삭제되지 않고** 유지됐는가(개발 흐름은 그대로다)?
5. `phases/60-same-origin-serving/index.json`의 step2를 `completed` + `summary`로 갱신한다(수정한 문서 4개와 각 파일에 추가한 항목, ADR-009 정정 2군데의 실제 문안, 최종 AC 수치를 명시).

## 금지사항

- **ADR-009의 지정된 2문장 외에는 `docs/ADR.md`를 고치지 마라**(다른 ADR·다른 문단·오탈자 정정 포함). 이유: ADR은 결정문이고, 이 phase가 근거를 갖는 정정은 "이 phase가 거짓으로 만든 서술" 딱 그만큼이다. 범위를 넓히면 승인되지 않은 결정 변경이 diff에 섞인다.
- **새 ADR을 신설하지 마라.** 이유: 아키텍처 방향·계층·외부 계약이 바뀌지 않았다(신뢰 경계·인가·DB·SSE 계약 전부 불변). 신설 기준에 미달한다.
- **`docs/news.md`를 수정하지 마라.** 이유: 사용자 소유 스펙 문서이며, 39행의 "정의되지 않은 경로는 로그인 페이지로"는 이 phase로 **바뀌지 않았다**(여전히 SPA가 지킨다).
- **실행 코드를 한 줄도 고치지 마라**(`server/**`·`src/**`·`web/**`·`test/**`). 이유: 문서 step에서 코드가 섞이면 리뷰 게이트가 "문서만 봤다"는 전제로 통과시켜 버린다. 코드 문제를 발견하면 고치지 말고 보고하라.
- **`package.json`에 새 스크립트(`start`·`serve` 등)를 추가하지 마라.** 이유: 실행 진입점 정의는 배포 phase(61)의 결정 사항이고, 지금 임의로 만들면 그 phase의 선택지를 좁힌다.
- **`.env.example`에 실제 토큰·키 값을 채우지 마라.** 이유: 예시 파일은 커밋 대상이다(시크릿은 `.env`에만).
- **문서에 아직 없는 기능(SEA exe·Electron 클라이언트·HTTPS 종단·압축·캐시 정책·토큰 상시 필수화)을 확정된 것처럼 쓰지 마라.** 이유: 문서가 코드보다 앞서가면 운영자가 없는 기능을 설정하려다 실패한다. 후속 계획은 `phases/60-same-origin-serving/index.json`의 `forward_notes`에만 남긴다.
- **`phases/index.json`(top-level)을 수정하지 마라.** 이유: 최종 phase 상태 마킹은 리뷰 게이트 통과 후 오케스트레이터의 몫이다.
- **`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**` 무접촉. `git add -A`/`git add .` 금지**, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
