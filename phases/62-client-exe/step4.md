# Step 4: client-docs

## 읽어야 할 파일

- `CLAUDE.md`, `docs/ADR.md`(**전문** — 특히 철학 문단과 ADR-009·ADR-010의 서술 톤/길이), `docs/ARCHITECTURE.md`(전문), `README.md`(배포 절)
- `phases/62-client-exe/index.json` — decisions·open_questions·excluded 전체
- `phases/62-client-exe/step0.md`~`step3.md`와 **그 네 step의 `summary`(실측치의 단일 출처)**
- `packaging/server/README-배포.md` — 운영 가이드 문서의 리포 표준(절 구성·경고 배치·문제 해결 표). 클라이언트 가이드는 이 형식을 따른다.
- 실제 산출물 `dist/기사작성기/`(step3 결과) — 문서에 쓰는 파일 목록·경로는 **실물과 대조**해서 쓴다

## 배경

이 step은 **문서 전용**이다(실행 코드 0줄). 앞 네 step이 만든 것을 운영자·기자가 쓸 수 있게 문서로 닫고, Electron 접속형 셸이라는 아키텍처 결정을 ADR로 남긴다.

문서에 쓰는 모든 수치·경로·동작은 **step1~step3 요약의 실측치**(특히 step2의 D-1~D-9 결론)에서 가져온다. 값이 없으면 "미측정"이라고 쓰거나 그 항목을 빼라 — **추정치를 사실처럼 쓰지 마라**(phase 61 step3의 규율: 문서-실코드 대조 항목별 확인).

## 작업

### 1. `packaging/client/README-배포-클라이언트.md` (신규)

배포 폴더에 자동 동봉된다(step3의 `dist-client.mjs`가 `packaging/client/**`를 복사한다 — 이 파일을 만들면 다음 `npm run dist:client`부터 포함된다. 그 사실을 검증 절차에서 실제로 확인하라).

최소 절 구성(순서 고정):

1. **구성** — 폴더 내용(`기사작성기.exe`, `resources/`, `locales/` 등)과 **이 프로그램은 서버에 접속만 한다**(DB·서버 내장 없음)는 한 줄.
2. **설치** — 압축을 풀고 원하는 폴더에 두면 끝(무설치·포터블). 관리자 권한 불필요. 네트워크 드라이브/USB 실행 시 첫 기동이 느릴 수 있음.
3. **최초 실행** — 서버 주소 입력 화면 → 형식(`192.168.0.10:3001`, 스킴 생략 시 `http://` 자동) → [연결 확인] → [저장하고 시작]. **주소가 기사작성기 서버가 아니면 저장되지 않는다**(health 응답 확인 — decisions (14)). 저장 위치는 **%APPDATA% 아래 `기사작성기\config.json`**(사용자별. 폴더를 복사해도 설정은 따라가지 않는다).
4. **서버 주소 변경** — 메뉴 `파일 > 서버 주소 변경`. **메뉴에는 단축키가 없다**(기사 편집 단축키와 충돌하지 않게 한 의도적 설계). 서버가 죽어 있으면 오류 화면에서도 변경할 수 있다.
5. **새로고침·확대/축소** — 메뉴 `보기`에서 클릭으로 한다(같은 이유로 단축키 없음). step2 D-8 결과에 따라 메뉴 자체가 없는 구성으로 갔다면 그 사실과 대체 수단을 쓴다.
6. **연결 실패 시** — 오류 화면 안내와 원인별 대처(주소 오타/DNS, 서버 미기동, 포트·방화벽, 서버는 뜨는데 화면이 404 → **서버 배포 폴더의 `web/` 누락**).
7. **알려진 제약** — step2 D-1~D-9 실측에서 확인된 것만 사실대로. 최소한 아래를 반영하라:
   - 인쇄(파일 > 인쇄/인쇄미리보기)의 실제 동작과 제약(D-3).
   - 평문 HTTP(LAN IP) 접속 시 복사/붙여넣기 제약 유무(D-4) — 제약이 있으면 회피책(서버와 같은 PC에서 `127.0.0.1`로 쓰는 경우는 정상 / 근본 해결은 HTTPS)까지.
   - 창을 닫을 때 편집 잠금이 즉시 풀리지 않을 수 있음(D-6) → 데스크(D/Z)의 강제 해제 안내.
   - **맞춤법 검사 밑줄은 표시되지 않는다**(셸에서 브라우저 맞춤법 검사를 끈 의도적 설정 — 사전 다운로드 등 외부 통신을 만들지 않기 위함. 맞춤법 검사는 에디터 메뉴 기능을 쓴다).
   - Alt 조합 단축키(Alt+Y/V/O) 동작 여부(D-8).
   - **서명되지 않은 실행 파일이라 SmartScreen·백신 경고가 뜰 수 있다**(추가 정보 → 실행). 회사 배포 시 예외 등록 안내.
   - 프로그램은 **한 번만 실행된다**(두 번째 실행은 기존 창을 띄운다).
8. **업데이트** — 자동 업데이트 없음. 새 폴더를 받아 덮어쓰면 된다(설정은 %APPDATA%에 있어 유지). **화면(기사 작성기 UI) 변경은 서버만 갱신하면 반영된다**는 사실도 한 줄.
9. **문제 해결 표** — 증상 / 원인 / 조치 3열, 최소 6행(빈 화면·연결 실패·로그인 실패·실시간 목록 미갱신·인쇄 안 됨·두 번 실행해도 창이 안 뜸).
10. **서버 담당자에게 물어볼 것** — 서버 주소·포트, 계정, 서버 배포 가이드(`README-배포.md`) 위치.

톤: 기자·데스크가 읽는 문서다. 개발 용어(webContents·preload 등)를 쓰지 마라.

### 2. `README.md` — 배포 절 보강

- 기존 "배포 (Windows 서버 EXE)" 절 **뒤에** "배포 (Windows 클라이언트 EXE)" 절 추가:
  ```bash
  npm run dist:client   # → dist/기사작성기/ 생성 (Electron 접속형 클라이언트, 무설치 폴더)
  ```
  산출물 구성 · 접속형(서버·DB 미내장) · 설정 위치(%APPDATA% 아래 `기사작성기\config.json`) · 운영 가이드(`packaging/client/README-배포-클라이언트.md`) · 설계 배경(ADR-011) 링크.
- 개발 커맨드에 `npm run client:dev`(로컬 셸 실행)와 `node scripts/verify-client.mjs --dev --scenario all`(셸 스모크)을 한 줄씩 추가한다.
- **`npm install`이 Electron 런타임(수백 MB)을 내려받는다**는 사실 + 서버 빌드 전용 머신에서 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`로 건너뛸 수 있다는 안내를 요구사항/설치 절에 추가한다(**직접 확인한 경우에만** 쓰고, 확인 못 했으면 그 문장을 빼라).
- 기존 문장·표(샘플 계정 등)를 재작성하지 마라 — 추가만 한다.

### 3. `docs/ARCHITECTURE.md` — 클라이언트 배치 절 추가

- "배포 산출물 (Windows 서버 EXE)" 절 **뒤에** "### 배포 산출물 (Windows 클라이언트 EXE)"를 추가한다(불릿 6~8개):
  - `npm run dist:client` → `dist/기사작성기/`(Electron 런타임 복사 + `resources/app/`에 셸 코드 화이트리스트 배치 + 한글 exe rename). 실측 크기·기동 시간.
  - **접속형**: 셸은 `loadURL(<서버 origin>/)`만 한다. SPA·API·세션·SSE는 전부 서버(phase 60 동일 출처 서빙) 책임이고 클라이언트에는 DB·백엔드·수집·배부 코드가 **0**이다.
  - 창 2종 분리(원격 앱 창 = preload 없음 / 셸 로컬 창 = preload 있음, 로컬 창은 원격으로 내비게이트하지 않는다)와 그 이유(신뢰 경계), 그리고 **미등록 webContents는 가장 제한적으로 취급**한다는 fail-closed 규칙.
  - `window.open` 정책(`about:blank`·동일 출처만 허용, 외부는 기본 브라우저, 로컬 창은 전면 거부) — SPA의 상세보기·인쇄 새 창이 그 위에서 동작한다.
  - 부팅 순서 계약(userData 지정 → 단일 인스턴스 잠금)과 그 이유.
  - 설정(서버 주소·창 크기)은 %APPDATA% 아래 `기사작성기\config.json`. **세션·자격증명은 저장하지 않는다.**
  - 셸에도 **앱 내 타이머·주기 통신이 없다**(ADR-008) — 주소 프로브는 사용자 액션 1회이고 `{ ok:true }` 본문까지 확인한다.
- "디렉토리 구조" 트리에 `client/`(main.js·preload.cjs·menu.js·ipcGuard.js·diag.js·lib/·pages/)와 `scripts/dist-client.mjs`·`scripts/verify-client.mjs`·`packaging/client/`를 추가한다. **다른 절은 수정하지 마라.**

### 4. `docs/ADR.md` — ADR-011 신설

`### ADR-011: 데스크톱 클라이언트는 Electron 접속형 셸 — 백엔드·DB 미내장, 원격 페이지에 Node 권한 0`

- **결정**: Electron 셸이 서버 origin을 `loadURL`만 한다 / 서버 주소는 사용자 영역 JSON에 저장하고 최초 실행 시 입력받아 `/api/health`의 `{ ok:true }`까지 확인한 뒤 저장한다 / 창은 원격 앱 창(preload 없음)과 셸 로컬 창(preload 있음, 원격 내비게이션 금지) 둘로 분리한다 / `setWindowOpenHandler`는 `about:blank`와 동일 출처만 허용하고 외부는 기본 브라우저로 보내며 로컬 창의 새 창은 전면 거부한다(`about:blank` 자식이 부모 webPreferences를 상속하기 때문) / 단일 인스턴스 잠금(userData 지정 후 요청) / **`spellcheck:false`** / 메뉴에 액셀러레이터·편집 role을 두지 않는다 / 패키징은 Electron 런타임 폴더 복사 + `resources/app` 배치(무설치 포터블, 자동 업데이트·서명 없음) / `electron`은 **devDependency**이며 런타임 의존성 5개는 불변.
- **이유**: 접속형이라 DB·백엔드가 중복되지 않고 서버 1곳만 업그레이드하면 된다 / SPA는 서버가 서빙하는 것을 그대로 써서 브라우저 접속 경로와 동작이 갈라지지 않는다(web/** 무수정) / 원격 페이지를 여는 셸에서 preload·nodeIntegration을 주면 서버 침해가 곧 클라이언트 PC 침해가 된다 / 정책·메뉴·sender 검증을 순수 함수로 뽑아 Electron 없이 단위 테스트로 잠갔다(ADR-010의 "명시 주입 > 런타임 탐지"와 같은 축) / **`spellcheck:false`는 사전 다운로드·서버측 제안 같은 앱 밖 통신을 만들지 않기 위함이다(ADR-008의 egress 0 규율 · 폐쇄망 배치)** — 맞춤법 기능은 SPA 자체 메뉴가 제공한다 / 메뉴 액셀러레이터를 두지 않는 것은 에디터 단축키(Ctrl+Y·Ctrl+A·Ctrl+D 등)를 메뉴가 먼저 삼키기 때문이다 / 패키저 없이 조립하는 이유는 필요한 것이 폴더 복사와 이름 변경뿐이고 설치 관리자·자동 업데이트를 만들지 않기로 했기 때문이다.
- **트레이드오프**: 폴더가 크다(실측치) / 서명 없어 SmartScreen 경고 / 자동 업데이트 없음(폴더 교체 운영) / 평문 HTTP LAN 접속은 secure context가 아니라 일부 브라우저 API가 제약된다(D-4 실측 결과를 사실대로) / 인쇄는 Chromium 동작에 의존한다(D-3) / 창 닫힘 시 편집 잠금 해제 요청 도달이 보장되지 않는다(D-6, 복구는 데스크 강제 해제) / **맞춤법 밑줄이 없다**(spellcheck:false의 대가) / 새로고침·확대축소가 키가 아니라 메뉴 클릭이다 / Electron 버전이 배포물에 고정되어 보안 패치에 재빌드가 필요하다(ADR-010과 동형) / 크로스 컴파일 불가.
- **CRITICAL**: ADR-001~010 **본문은 한 글자도 수정하지 마라**. 철학 문단은 필요하면 **한 문장 이내**로만 보강한다(빌드/실행 셸 전용 devDependency 축에 electron이 포함된다는 사실). 번호 체계·문서 톤을 기존 ADR과 맞춰라.

### 5. phase 마감

- `phases/62-client-exe/index.json`의 step4 갱신 + 전 step 상태 확인.
- `phases/index.json`의 `62-client-exe` 항목을 `completed`로 바꾸고 `note` 앞머리에 `[완료 YYYY-MM-DD: …]` 요약을 단다(phase 61 항목 형식 그대로 — 실측치·제외 유지·잔여 백로그 포함).
- 미해결은 `open_questions`에 **사용자 확정 대기**로 남긴다(임의로 결론 내리지 마라).

## Acceptance Criteria

```bash
npm run lint          # clean (문서만 바뀌었으므로 무변)
npm test              # 기준선 그대로, 실패 0
npm run test:web      # 2368/2368 무영향
npm run build         # clean

npm run dist:client                                   # README-배포-클라이언트.md 자동 동봉 확인
test -f "dist/기사작성기/README-배포-클라이언트.md" && echo "DOCS-BUNDLED-OK"
node scripts/verify-client.mjs --exe "dist/기사작성기/기사작성기.exe" --scenario all   # 문서 작업 후에도 산출물 정상

# ADR 무수정 확인(자동 판정) — 삭제 라인 ≤ 1(철학 문단 1문장 보강 허용), 나머지는 순수 추가여야 한다.
test "$(git diff --numstat docs/ADR.md | cut -f2)" -le 1 && echo "ADR-ADDITIVE-OK"
# ARCHITECTURE 무수정 확인 — 기존 절 재작성 없이 추가 위주인지(삭제 라인 ≤ 3)
test "$(git diff --numstat docs/ARCHITECTURE.md | cut -f2)" -le 3 && echo "ARCH-ADDITIVE-OK"
```

`npm run test:web` 비고정 실패 규약: 1건이 비고정으로 실패하면 **최대 2회 재실행 + 단독 실행**으로 판정한다(green이면 통과, 사실을 요약에 남긴다).

## 검증 절차

1. 위 AC를 실행한다.
2. **문서-실물 대조**(항목별로 확인하고 결과를 요약에 남긴다): 배포 폴더 파일 목록 ↔ README 구성 절 / 설정 파일 경로 ↔ 실제 %APPDATA% 경로 / 메뉴 항목 이름 ↔ `client/menu.js`의 실제 템플릿 / 제약 목록 ↔ step2의 D-3·D-4·D-6·D-8·D-9 실측 결과 / ARCHITECTURE 트리 ↔ 실제 `client/` 구조 / ADR-011 서술 ↔ `client/lib/windowPolicy.js`의 실제 정책 분기(특히 로컬 창 전면 거부·fail-closed 기본값).
3. `git status --porcelain` 증분이 `packaging/client/README-배포-클라이언트.md`·`README.md`·`docs/ARCHITECTURE.md`·`docs/ADR.md`·`phases/62-client-exe/index.json`·`phases/index.json` 뿐인지 확인한다(시작 시점 스냅샷 대비 증분).
4. 무접촉 확인: `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`·`web/**`·`src/**`·`server/**`·`test/**`·`client/**`·`scripts/**` 변경 0건.

## 금지사항

- 실행 코드를 수정하지 마라(`client/**`·`scripts/**`·`server/**`·`src/**`·`web/**`). 이유: 이 step은 문서 게이트다. 코드 결함은 고치지 말고 요약과 open_questions에 기록해 보고하라(리뷰가 코드 변경을 볼 수 없게 된다).
- 실측하지 않은 수치·동작을 문서에 쓰지 마라. 이유: 배포 문서의 거짓 진술은 운영자가 잘못된 원인을 파고들게 만든다(phase 61에서 콘솔 서술 오류가 리뷰 지적으로 잡힌 전례).
- `docs/news.md`를 수정하지 마라. 이유: 사용자 소유 스펙 문서다(무접촉 규약).
- ADR-001~010 본문을 손보지 마라(오탈자 포함). 이유: ADR은 결정의 시점 기록이다 — 사후 편집은 이력을 왜곡한다.
- 문서에 실환경 IP·계정·비밀번호를 예시로 넣지 마라(사설 대역 `192.168.0.10` 같은 명백한 placeholder만). 이유: 배포물에 사내 정보가 박힌다.
- open_questions를 임의로 "확정"으로 바꾸지 마라. 이유: 사용자 확정 사항이며, 계획 문서가 승인 없이 결정을 만들면 하류 phase가 잘못된 전제 위에서 진행된다.
