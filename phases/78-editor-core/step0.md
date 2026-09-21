# Step 0: baseline-and-editor-skeleton

P5(에디터 코어)의 첫 step. Qt/MSVC 머신에서 기준선을 재측정하고, `client-qt/src/editor/` 디렉토리를 신설한 뒤, P0 스파이크의 검증된 순수 로직을 `editor/`의 첫 프로덕션 모듈로 이식해 QtTest green을 낸다.

> **환경 전제(CRITICAL)**: 이 step은 실제 **Qt 6.8.3 + MSVC 14.50.35717 + Windows SDK 10.0.26100.0** 머신에서만 실행 가능하다(`client-qt/env.bat`이 그 경로를 하드코딩). Linux/JDK21 환경에서는 `client-qt`를 빌드할 수 없다 — index.json `open_questions` (0) 참조.

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — scope · baseline(인계 수치) · decisions (1)(2) · order 근거.
- `phases/77-qt-client-skeleton/index.json` 의 `forward_notes` (1)(2)(8)(10) — 마감 실측 전문 · 빌드/러너/구조/결선 지점 · P5 착수 지점 · 먼저 열 파일 순서.
- `client-qt/README.md` — 빌드·실행 규약, 디렉토리 규약, 「P4 마감」 장.
- `client-qt/env.bat`·`client-qt/build.bat`·`client-qt/run.bat` — 툴체인 정본과 빌드 레시피.
- `client-qt/common.pri`·`client-qt/tests/tests.pro`·`client-qt/tests/main.cpp` — 모듈·테스트 등록 지점.
- `client-qt/client-qt.pro`·`client-qt/app/app.pro` — `subdirs` 구조.
- `spikes/p0-qt-editor/editorlogic.h`·`editorlogic.cpp`·`selftest.cpp` — **이식 원본**(순수 로직: `classifyLines`·`colorForRole`·`isInputBlocked`). **읽되 고치지 마라(동결).**
- `spikes/p0-qt-editor/editorwidget.h`·`editorwidget.cpp` — Qt 위젯 기반 확인용(open_questions (1) — step8 준비).
- `web/src/view/editorColoring.js`·`editorNewline.js` — 스파이크 순수 로직의 웹 정본(동형 확인).

## 작업
1. **기준선 재측정(자기 손으로)**: index.json baseline의 인계 커맨드를 이 머신에서 전부 실행해 수치를 재확인한다(`cmd /c client-qt\build.bat` · `verify-qt-client --scenario boot|login|list --server exe`·`--server spring` · `npm test` · `lint` · `build` · parity 3종). 인계값과 하나라도 어긋나면 그 사실부터 step 요약에 적는다(위장 금지). 리포 `news.db` md5(`7247e9e0dfe5cc8cd040ebb1dc9fb967`) 무변 지문 기록.
2. **디렉토리 신설**: `client-qt/src/editor/`. 여기에 P0 스파이크 `editorlogic`을 이식한다 — `client-qt/src/editor/editorroles.h`/`.cpp`(제안 이름): `Role{Title,Subtitle,Body,End}` · `classifyLines(const QStringList&) -> QVector<Role>` · `colorForRole(Role) -> QColor` · `isInputBlocked(const QString&, int caretOffset) -> bool` · `extern const QString END_MARKER`. **웹 `editorColoring.js`/`editorNewline.js`와 동형임을 주석으로 명시**(스파이크 주석 승계). 색 상수는 제목 `#0a4da6`/부제 `#c8102e`/본문 `#1a1a1a`/`(끝)` `#d4af37`.
3. **빌드 결선**: 새 모듈을 `common.pri`의 `CLIENT_SOURCES`/`CLIENT_HEADERS`에 등록(프로덕션 모듈이므로 — 테스트 더블이 아니다). 새 QtTest 클래스(`tests/editorrolestest.h`/`.cpp` 제안)를 `tests/main.cpp`의 `runTestClass<EditorRolesTest>()` **한 줄**로 등록.
4. **QtTest 작성(TDD)**: `spikes/p0-qt-editor/selftest.cpp`의 케이스 + `editorColoring.test.js`·`editorNewline.test.js`의 대표 입출력을 QtTest 케이스로 옮긴다. **먼저 red를 본 뒤 green**(비어 있으면 러너가 exit 2로 green을 거부).

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → **exit 0** · QtTest Totals 첫 숫자가 이전(310) + 신규 클래스 함수 수만큼 증가 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot --server exe` → **exit 0**(P4 부팅 회귀 무변).
- `git status --porcelain` 이 `client-qt/src/editor/**`·`client-qt/common.pri`·`client-qt/tests/**`·`phases/78-editor-core/**` 밖을 건드리지 않음.
- 리포 `news.db` md5 무변.

## 검증 절차
1. 기준선 12커맨드를 연속 2회 실행해 두 회차 수치 동일(flake 0)을 확인, 표로 기록.
2. 새 QtTest 클래스에 우회 변이 최소 2종(색 상수 오타 · `isInputBlocked` 부등호 뒤집기)을 심어 red를 보고 원복(소스 diff로 판정 — 재빌드 exe md5는 매번 다르다).
3. 무접촉 경로 diff 0 확인: `git diff --stat -- server-spring web client src contract spikes client-qt/src/net client-qt/src/shell`.

## 금지사항
- `spikes/**`를 고치지 마라. 이유: P0 스파이크는 동결 회귀 기준이다 — 이식은 새 `editor/` 파일에 복제로 한다.
- 테스트 더블을 `common.pri`에 넣지 마라. 이유: `app.pro` 경유로 배포 `news-client.exe`에 링크돼 phase 77 `rule7`이 red가 된다(테스트 더블은 `tests/tests.pro` 전용).
- `git add -A`를 쓰지 마라. 이유: 빌드 산출물(`release/`·`*.exe`)과 타 세션 산출물이 통째로 실린다 — 명시 경로만 add.
- 인계 baseline 수치를 실측으로 위장하지 마라. 이유: 어긋난 수치를 덮으면 하류 step이 오염된 기준 위에 선다.
