# contract/ — 프레임워크 중립 계약 테스트 스위트 (포팅 P1)

REST/SSE 39 라우트 계약(`docs/api-contract/**`)을 **HTTP로만** 검증하는 스위트다. 대상 서버가 Node(현행)든 Spring(68+)이든 같은 케이스가 같은 판정을 내린다 — 케이스는 `CONTRACT_BASE_URL` 하나로만 서버에 접근하고, `server/**`·`src/**`·`web/**`의 어떤 모듈도 import하지 않는다.

## 실행법

```bash
npm run test:contract                                   # 전 프로파일(5종) — 프로파일별 서버 기동·시드·케이스 실행·리포트 병합
npm run test:contract -- --profile default              # 프로파일 한정
npm run test:contract -- --profile default --files contract/cases/default/health.contract.js   # 파일 한정
npm run test:contract -- --boot-check                   # 케이스 없이 기동→health→세션 준비→종료만 실증
npm run test:contract -- --out report.json              # 리포트 경로 지정(미지정 시 OS 임시 디렉토리)
npm run test:contract -- --require-full-coverage        # 커버리지 39/39 강제(기본은 미커버 경고 + exit 0)
```

외부(비 Node) 서버 대상 실행 — 서버를 기동·시드하지 않고 base URL로만 접근한다:

```bash
npm run test:contract -- --base-url-map targets.json --credentials creds.json
# targets.json: { "default": "http://host:port", "minimal": "...", ... }  (미제공 프로파일은 리포트 skipped)
# creds.json:   { "R": {"userId":"...","password":"..."}, "D": {...}, "Z": {...} }  — 외부 대상에서는 필수
```

리포트 2개의 기계 비교(이중 실행 diff)는 step12의 `scripts/contract-diff.mjs`가 소유한다.

## 대상 서버 사전조건 계약 (68+ Spring이 지켜야 할 것)

1. **계정 3종**이 존재하고, 역할이 각각 **R/D/Z**이며, 활성 상태여야 한다.
   - userId: `reporter`(R) · `desk`(D) · `admin`(Z). 비밀번호는 **`src/db/seed.js`의 `SAMPLE_USERS`와 동일**하다(값은 어떤 문서·리포트에도 쓰지 않는다).
   - 계정·비밀번호가 다른 서버는 `--credentials <file>`로 주입한다 — 케이스는 비밀번호를 하드코딩하지 않으므로 스위트 수정 없이 돈다.
2. **프로파일 프리셋** — 서버 구성 5종이 계약의 일부다.
   - **필수 3종**: `default`(스풀·수집 토큰 설정) · `minimal`(스풀·토큰 미설정 — spool-disabled 503·무토큰 수집 개방) · `auth-negative`(default와 동일 구성의 **전용 인스턴스** — 로그인 실패·잠금 423·레이트리밋 429 격리).
   - **선택 2종**: `failclosed`(외부 바인딩 + 수집 토큰 미설정 — collection-disabled 503) · `prod-cookie`(프로덕션 쿠키 속성 Secure·SameSite=None).
   - 선택 프로파일을 제공하지 않으면 그 케이스는 리포트에 `skipped:{reason:'profile-unavailable'}`로 남고 **diff에서 차이로 드러난다** — 통과로 위장되지 않는다.
3. **기존 데이터가 있어도 무방하다.** 스위트는 대상 DB에 직접 쓰지 않는다(픽스처 전부 API 경유 — `contract/lib/fixtures.js`). 목록/검색 케이스는 절대 개수를 단언하지 않고 자기 픽스처(고유 토큰)만 단언한다.

## 케이스 작성 규칙

- **서버 코드 import 금지** — `server/**`·`src/**`·`web/**`를 import하는 순간 스위트가 Node 구현에 묶인다. 서버 접근은 `contract/lib/http.js`(`api`)·`contract/lib/sse.js`(`openStream`)로만.
- **비밀번호는 `credentials(role)`로만** 받는다(`contract/lib/session.js`). 요청 body에만 쓰고 로그·리포트·에러 메시지에 넣지 않는다.
- **로그인 예산**: `POST /api/login`은 15분/10회 IP 레이트리밋 아래 있다. 러너가 프로파일당 R/D/Z 3회 로그인해 세션을 공급하므로 케이스는 `actor(role)`/`sid(role)`를 재사용한다. `default`에서 케이스 직접 로그인은 계획된 소수(step3 성공 1회 + step11 SSE 전용 1회)뿐이다. 로그인 다소비 음성 케이스(잠금·429)는 전부 `auth-negative` 소유다.
- **리포트는 `record`/`fromResponse`(`contract/lib/record.js`)로만** 남긴다 — 마스킹·정규화는 그 한 곳이 한다. 세션 토큰·쿠키 값·비밀번호·기사 본문·articleId·타임스탬프·절대 경로를 리포트에 담지 마라.
- **`routeId`는 인벤토리(`docs/api-contract/endpoints.json`) id 또는 `x-` 접두사**여야 한다. `x-`는 인벤토리에 없는 라우트의 관측 전용이며 커버리지 집계에서 제외된다. 그 밖의 미등재 id는 즉시 실패한다(오타가 커버리지를 비켜 가지 못하게).
- **절대 개수 단언 금지 · 자기 픽스처만 단언** — 사전 존재 데이터에 강건해야 두 서버에서 같은 판정이 나온다.
- **`--test-concurrency=1` 전제** — 케이스는 직렬로 돈다(러너가 강제). SSE 신호·레이트리밋 카운터를 공유하므로 병렬 실행을 가정한 코드를 쓰지 마라. 타이밍은 고정 sleep이 아니라 조건 대기 + 타임아웃으로만 맞춘다.
- **프로파일 오배치 방지** — 케이스 파일 상단에서 `requireProfile('<profile>')`(`contract/lib/profiles.js`)을 호출한다. 파일 위치는 `contract/cases/<profile>/<domain>.contract.js`.

## 디렉토리

```
contract/
  lib/       http.js(api·q) · session.js(actor·sid·credentials·hasSessions) · record.js(record·fromResponse)
             fixtures.js(unique·createArticle·createSentArticle·createTarget·createReceiverConfig·acquireLock)
             sse.js(openStream) · profiles.js(PROFILE·requireProfile)
  cases/     <profile>/<domain>.contract.js — 러너가 프로파일 디렉토리의 *.contract.js를 정렬 실행
```
