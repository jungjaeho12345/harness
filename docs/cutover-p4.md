# 컷오버 P4 — C++ Qt 클라이언트 골격 산출 정본

> 이 문서는 **로드맵 P4(C++ 클라 골격 — `docs/porting-plan-cpp-spring.md` §7 181행)** 의 산출 정본이다.
> phase 77 step0 이 신설했다. **대안 문서는 없다** — P4 의 baseline·툴체인 실측·요구 정리·스파이크 판정·diag
> 이벤트 목록은 전부 이 문서의 고정 §앵커에 모인다. 후속 step 이 이 앵커를 **하드 참조**한다.
>
> **§앵커 계약(고정)**: **§0** baseline·툴체인 실측·사용자 실행 항목(step0) · **§1** ADR-overrode-news.md 목록(step1)
> · **§2** 에디터 스파이크 go/no-go 판정(step2) · **§5** diag 유지/재매핑 이벤트 목록(step5).
>
> **규율** — 이 문서의 실측값은 **이 개발 머신에서 직접 잰 값**이지 운영 머신·Windows 실기 머신의 값이 아니다.
> 빈칸을 추측으로 채우지 않는다("미상 + 막는 step" 으로 남긴다). 비밀 값(비밀번호·토큰·세션 id)을 적지 않는다.
> 인계 수치를 실측으로 위장하지 않는다 — 어긋난 값은 **어긋났다는 사실부터** 적는다.

---

## 0. baseline 재측정 · Qt/CMake 툴체인 실측 · 사용자 실행 항목 (step0 · 2026-09-09)

측정 머신: Linux 6.18 (Ubuntu 24.04 기반) · Node v22.22.2 / npm 10.9.7. **이 머신은 운영기도 Windows 실기 머신도 아니다.**

### 0-A. 기준선 재측정 (이 트리에서 직접 · 각 커맨드 2회 연속 · flake 0)

**선행 사실(중요) — 이 트리는 `node_modules` 가 없는 상태였다.** 인계 컨텍스트는 의존성이 설치된 트리를 가정했으나
이 체크아웃에는 `node_modules/` 가 부재했고(`ls node_modules` → No such file or directory), 설치 전 `npm test` 는
`bcryptjs` 등 미해결 import 로 **36 파일 fail** 했다. `npm ci`(package-lock 기준 436 패키지 설치) **후** 아래 값을 측정했다.
이는 코드 결함이 아니라 체크아웃 상태이며, 하류 측정의 전제로 기록한다.

| 항목 | 인계값(계획서 baseline) | 이 트리 실측(2회 일치) | 판정 |
|---|---|---|---|
| `npm test` (web/dist **부재** 시) | 1328 pass / 0 fail / 0 skip | **1349 tests · 1348 pass · 0 fail · 1 skip** | ⚠ 어긋남 — 아래 주 참조 |
| `npm test` (web/dist **존재** = build 후) | — | **1349 tests · 1349 pass · 0 fail · 0 skip** | 0 fail 확인 |
| `npm run lint` | exit 0 | **exit 0** (2회) | 일치 |
| `npm run build` | exit 0 | **exit 0** (2회 · `web/dist` 산출 · vite built in ~1.4s) | 일치 |
| `node scripts/spring-contract.mjs --parity` | 313관측 diffs 0 | **이 step 미측정**(아래 주) | 미측정 |
| 리포 `news.db` md5 | `7247e9e0dfe5cc8cd040ebb1dc9fb967` | **미상 — 파일 부재** (아래 주) | ⚠ 측정 불가 |
| `uploads/` 파일수·바이트 | (ADR-016 기록 32파일 6,068,792 B) | **미상 — 폴더 부재** (아래 주) | ⚠ 측정 불가 |
| `web/src/model/contract.js` `MODEL_KEYS` | 35 (REST 33 + SSE 2) | **35** (SSE 2 = `subscribe`·`subscribeLogs`) | 일치 |

**어긋남 주 — `npm test` 카운트(무엇이·얼마나·왜)**: 인계값은 1328 pass / 0 skip 인데 이 트리는 **총 1349 tests**(+21)
이고 skip 은 **build 상태 의존**이다. skip 1 건의 정체는 `test/spa-serving.test.js` **E22**("실제 web/dist 서빙 + CSP
호환 잠금")로 `{ skip: !fs.existsSync(REAL_INDEX) }`(274행) — `web/dist/index.html` 이 있어야만 돈다. `npm run build`
전에는 E22 가 skip(→ 1348 pass / 1 skip), build 후에는 실행(→ 1349 pass / 0 skip)한다. 즉 **인계값의 "0 skip" 은 build
산출물이 존재하는 상태에서 잰 것**이고, 총 카운트 +21 은 계획 인계(phase 75/76 마감 1328) 이후 스위트가 늘어난 것이다.
어느 상태에서도 **fail 0** 이고 두 상태 각각 2회 연속 동일(flake 0)이다.

**측정 불가 주 — `news.db`·`uploads/`**: 둘 다 **`.gitignore` 로 추적 제외된 런타임 산출물**이다(`.gitignore` 19~21행
`news.db`/`-journal`/`-wal` · 45행 `uploads/`). 신선 체크아웃인 이 트리에는 두 경로가 **존재하지 않는다**(`git ls-files`
결과 0건 · `md5sum news.db` → No such file or directory). 따라서 인계 md5 를 이 트리에서 재현할 수 없다 —
**위조하지 않고 "부재"로 기록한다.** 인계 md5 `7247e9e0…` 는 `docs/ADR.md` ADR-016 P2 마감 실측(606,208 B)이 적은
운영/개발 실행 산출 DB 의 값이며, 서버를 한 번도 기동하지 않은 이 트리에는 그 파일이 없다. **P4 클라이언트는 DB·백엔드가
0 이므로**(index.json excluded (e) · ADR-011) 이 부재는 P4 진행을 막지 않는다 — 후속 step 의 통합 검증(step11)은 서버를
임시 DATA_DIR 로만 기동하고 리포 `news.db` 에 절대 바인딩하지 않는다.

**미측정 주 — spring-contract 패리티**: `scripts/spring-contract.mjs --parity` 는 `server-spring/target/*.jar`(mvn 빌드
산출)에 의존하고 그 jar 는 이 트리에 부재하며, 빌드하려면 MySQL 8.0 이 있어야 한다(ADR-016 ⑧ — `mvnw verify` 는 MySQL
없으면 skip 이 아니라 fail). jar 빌드·MySQL 기동은 **P4(클라이언트 골격) 범위 밖**이므로 이 step 은 패리티를 재측정하지
않는다 — 최근 기록은 phase 75 step9 / phase 76 의 **313관측 diffs 0** 이다. (java 25 · mvn 은 PATH 에 존재하나 사용하지
않았다.)

### 0-B. Qt/CMake 툴체인 실측 (실행 머신 · 버전 커맨드 직접 실행 · 경로 베끼기 금지)

| 툴 | 상태 | 실측 근거(직접 실행) |
|---|---|---|
| CMake | **존재 3.28.3** | `cmake --version` → `cmake version 3.28.3` |
| ctest | **존재 3.28.3** | `ctest --version` → `ctest version 3.28.3` |
| Node / npm | **존재 v22.22.2 / 10.9.7** | `node --version` · `npm --version` |
| C++ 컴파일러 | **존재 g++ 13.3.0** (C++17 이상 지원) | `g++ --version` → `g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1)` |
| **qmake / qmake6** | **부재** | `which qmake qmake6` → 무출력 · `qmake -v` → `command not found` |
| **Qt 6 (Widgets·Test)** | **부재** | `find / -name Qt6Config.cmake` → 0건 · `ls /usr/include/qt6` → No such file or directory |
| MSVC | **부재**(이 머신은 Linux) | build.bat 이 지정한 `MSVC 14.50.35717` 은 Windows 경로 |
| `QT_QPA_PLATFORM=offscreen` ctest | **불가** | Qt6/qmake 부재 → 스파이크(`QT += widgets testlib`)를 **컴파일·링크할 수 없다** → offscreen selftest 도달 불가 |

**제너레이터**: Qt 가 없어 판정 대상 아님(N/A). Linux 라면 Make/Ninja 가 후보이나 빌드 대상 Qt 가 없다. 스파이크의 정본
경로(`spikes/p0-qt-editor/build.bat` 4~7행)는 **Windows MSVC + `D:/agents/tools/Qt/6.8.3/msvc2022_64` + WinSDK
10.0.26100.0** 로 하드코딩돼 있어 이 Linux 머신과 불일치한다.

### 0-C. 툴체인 부재 blocked 게이트 — **발효** (step2 no-go 분기와 동형)

**게이트 판정: Qt6 부재로 게이트가 FIRE 한다.** 실행 머신에 **Qt6 와 qmake 가 없고**, 그 결과 스파이크
`--selftest`(step2 선행 게이트 ②의 실행 입력)와 `client-qt/` CMake 빌드(step3~)가 **이 머신에서 불가능**하다.
이는 **프로덕션 코드 결함이 아니라 환경 미비**다.

- **이 phase 를 blocked(사용자 툴체인 프로비저닝 대기)로 표시한다.** 반영 위치: `phases/77-cpp-client-skeleton/index.json`
  — step2(editor-spike-verdict) `status: "blocked"` + `blocked_reason`(Qt6 툴체인 부재), 그리고 phase 수준 사실은
  `forward_notes` 에 「Qt6 부재로 phase blocked · step3 진입 금지」로 명문화.
- **step3 진입을 금지한다.** step3~step12(빌드·ctest·통합)는 Qt6 프로비저닝 전까지 착수하지 않는다.
- **step0·step1 은 blocked 가 아니다** — 측정(step0)과 DOCS/ADR 정리(step1)는 Qt 없이 완결되며 이 문서·ADR 로 산출된다.
- execute.py 가 이 환경 미비를 **오해 소지 있는 error 로 3회 재시도·마감하게 두지 마라** — blocked 로 명시하고
  오케스트레이터/사용자 판단을 기다린다.

**프로비저닝 성공 판정(사용자가 채운 뒤 재개 조건)**: 실행 머신에서 (i) `qmake -v`(또는 Qt6 CMake 패키지)가 6.x 를
출력하고 Widgets·Test 모듈이 존재하며 (ii) 스파이크가 `QT_QPA_PLATFORM=offscreen release/spike --selftest` 로 돌아
JSON 한 줄 + exit 0 을 내면, step2 게이트가 실측으로 열린다.

### 0-D. 스파이크 지문 (`spikes/p0-qt-editor/` · step2 go/no-go 재현 입력 고정 · 무수정 증거물)

- **파일 목록(11)**: `build.bat` · `spike.pro` · `main.cpp` · `editorlogic.h`/`.cpp` · `editorwidget.h`/`.cpp` ·
  `selftest.h`/`.cpp` · `out.png`(시각 증거) · `.gitignore`.
- **`spike.pro`**(qmake · 무수정): `QT += widgets testlib` · `CONFIG += console c++17 release` ·
  `SOURCES += main.cpp editorlogic.cpp editorwidget.cpp selftest.cpp` · `HEADERS += editorlogic.h editorwidget.h selftest.h`.
  (decisions (2): 제품 골격은 **CMake** 로 가되 스파이크의 qmake `spike.pro` 는 건드리지 않는다 — 증거물이다.)
- **`selftest.cpp` 4축 존재 확인**(runSelftest() 가 JSON 한 줄 + exit 코드 0=go 로 낸다):
  - **T1 색상** — 줄 역할 색상: 순수 `classifyLines`(제목 `#0a4da6`·부제 `#c8102e`·본문 `#1a1a1a`·"(끝)" `#d4af37`) + 위젯 charFormat 실측.
  - **T2 마커 게이트** — "(끝)" `isInputBlocked` 경계: 마커 시작 오프셋 이상 삽입 차단, 마커 앞 삽입·삭제·붙여넣기 허용.
  - **T3 IME 조합** — preedit "ㅎ→하→한" 주입 중 문서 불변·재분류 0·캐럿 튐 0, commit "한" 정확 1회·종료 시 재색칠 1회, 차단 구간 문서 불변.
  - **T4 캐럿 복원** — `focusLineStart(2)` 정확 이동, 재로드 후 캐럿 초기화→복원, 범위 밖 no-op.
- **`main.cpp`**: `--selftest` 시 `QT_QPA_PLATFORM` 미설정이면 `offscreen` 강제(러너 결정성) · `--screenshot <png>` · 무인자 대화형.

### 0-E. 사용자 실행 항목 (에이전트가 못 하는 것 — 왜 사람이 · 확인 방법 · 성공 판정)

| 항목 | 왜 사람이 | 확인 방법 | 성공 판정 | 막는 step |
|---|---|---|---|---|
| **Qt6 툴체인 프로비저닝** | 에이전트는 이 머신에 Qt6/MSVC 를 설치할 수 없다(0-B: 전부 부재). build.bat 은 Windows MSVC 14.50 + Qt 6.8.3(`D:/agents/tools/Qt/6.8.3`) + WinSDK 10.0.26100 을 요구한다 | 실행 머신에서 `qmake -v`(또는 Qt6 CMake 패키지 버전) · Widgets·Test 모듈 존재 | 6.x 출력 + `offscreen … --selftest` 가 exit 0 | **2·3·4·5·6·7·8·9·10·11** (phase blocked) |
| **Windows 실기 IME 조합 육안 검증** | 한글 조합 체감·캐럿 튐은 자동 판정 밖(`docs/porting-plan-cpp-spring.md` §8 육안 게이트 — P5~P6 실기 검증, P4 범위 밖) — 사람 눈이 정본 | Windows 실기에서 조합 입력 실기 | P5~P6 육안 체크리스트 | (P5~P6) |
| **정식 feature 브랜치 명명·분기점** | 브랜치 명명·PR·머지는 오케스트레이터/사용자 판단(open_questions (5)) | — | 오케스트레이터 결정 | (전 phase) |
| **빌드 시스템 CMake vs qmake 이의** | decisions (2) 기본은 CMake. qmake 승계를 원하면 **step3 착수 전** 사용자가 말해야 한다(open_questions (1)) | 사용자 통지 | 미통지 = CMake 확정 | 3 |
| **diag 자동 검증 경로 (가)/(나) 선택** | AC ②의 실행 경로(open_questions (3)) — step11 은 이 결정 없이 착수 금지 | 사용자 통지 | (가) verify-integration 확장 / (나) verify-client-qt 신설 중 택1 | 11 |
| **`ContentsVO.md` 원본 확보** | 원본은 **사용자만 보유**(§10-7) — 에이전트가 만들거나 추측 불가. **단 P4 범위 밖**(excluded (c) · open_questions (2)) | 리포에 파일 존재 | 파일 등재(P5 착수 전) | (P5 — P4 무관) |

---

## 1. ADR-overrode-news.md — news.md 드리프트 정리 목록 (step1 · 2026-09-09)

**목적**: `docs/news.md` 를 포팅 요구 정본으로 읽되, **ADR 이 이미 덮어쓴 지점**은 문자 그대로 이식하지 않도록
"정본을 읽는 렌즈"를 명문화한다. **news.md 원문은 고치지 않는다**(사료 보존 · §10-8 지시) — 드리프트는 여기서만 정리한다.
아래 좌표는 2026-09-09 에 `docs/news.md`·`docs/ADR.md`·`docs/ARCHITECTURE.md` 를 직접 읽어 확인했다.

| # | news.md 문장(좌표) | 덮은 ADR / 현행 규율 | 포팅 시 처분(P4 네이티브 클라) |
|---|---|---|---|
| D1 | **~174행** "Alt+Y를 누르면 브라우저 맞춤법 검사가 켜진다(spellcheck=true, lang=ko)" | **ADR-011** — 데스크톱 셸의 `spellcheck:false` 확정, 맞춤법은 SPA/앱 메뉴 책임(브라우저 맞춤법이 아니라 앱 자체 기능). index.json decisions (9)도 "셸 `spellcheck` off 확정". | **그대로 이식하지 않는다.** "Alt+Y 가 브라우저 맞춤법을 켠다"는 서술은 네이티브에 이식 대상이 아니다 — Qt 셸에는 브라우저 맞춤법 개념이 없다. 맞춤법은 **P6 앱 맞춤법**(news.md 180/187/219행의 앱 메뉴 통합/문단/현재위치 검사)으로 대체하며 이는 별개 기능으로 살아남는다. P4 골격은 에디터·맞춤법을 만들지 않는다(excluded (a)). |
| D2 | **~301행** "CORS는 개발 클라이언트(localhost:5173)만 허용한다" | **ADR-009**(CSRF Origin/Referer allowlist) + **ADR-004**(세션 인가) + **ADR-017**(동일 출처 배포). 현행은 `ALLOWED_ORIGINS` 체계다(`docs/ARCHITECTURE.md` 134~140행): 비프로덕션 기본 `http://localhost:5173`·`http://127.0.0.1:5173`, **프로덕션은 `ALLOWED_ORIGINS` 등록 출처만**, **동일 출처 배포는 빈 목록이 정상**(ADR-017 · csrfOriginGuard 자기 출처 판정만으로 통과). | **한 줄을 문자 그대로 이식하지 않는다.** "localhost:5173 만 허용"은 개발 시점 서술이고 현행 정본이 아니다. **단 이는 서버(§2 동결) 사안이고 P4 클라는 CORS 설정 주체가 아니다** — Qt 클라의 REST 는 동일 출처 상대 경로(`/api/...`)로 나가고(decisions (4)), 인증은 세션 쿠키다(decisions (5)). 클라는 `ALLOWED_ORIGINS` 를 건드리지 않는다. |

**추가 스캔 결과(발견 없음도 사실로 기록)**: news.md 전문을 CORS/localhost/5173/Origin · spellcheck/맞춤법 · 설치/SEA/포터블
· CSRF/SameSite/쿠키 키워드로 스캔했다. **위 D1·D2 외의 드리프트는 발견되지 않았다.** 구체적으로 — (i) `localhost:5173`
은 **301행 1곳뿐**이다. (ii) 맞춤법 언급 5곳 = 드리프트 1(174행 브라우저 맞춤법) + 앱메뉴 4(163/180/187/219행)이며, 이 중 174행만 "브라우저 맞춤법"(드리프트)이고 163/180/187/219행은 **앱 메뉴 맞춤법**
(ADR-011 이 지목한 대체 기능이지 드리프트 아님). (iii) SEA·단일 실행·무설치 서술은 news.md 에 **0건**(ADR-010 소멸 축은
news.md 에 노출된 요구가 아니다). 따라서 ADR-overrode-news 목록은 **D1·D2 2건이 확정 전부**다.

---

## 2. 에디터 스파이크 go/no-go 판정 (step2)

<!-- PLACEHOLDER — step2(editor-spike-verdict)가 채운다. 스파이크 --selftest 실측 evidence + go/no-go. 툴체인 부재로 현재 blocked(§0-C). -->

---

## 5. diag 유지/재매핑 이벤트 목록 (step5)

<!-- PLACEHOLDER — step5(shell-diag)가 채운다. 셸 계열 유지 이벤트 · 렌더러 4이벤트 재매핑/생략 확정. 툴체인 부재로 현재 blocked(§0-C). -->
