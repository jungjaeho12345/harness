# Step 0: baseline-and-editor-skeleton

## 읽어야 할 파일

- `phases/78-qt-editor-core/index.json` — `baseline`(인계 수치 · 무접촉/가변 경로 · 함정) · `decisions` (1)(2) · `order`
- `phases/77-qt-client-skeleton/index.json` — `forward_notes` (2)(빌드·러너·common.pri·tests.pro 결선) · (10)(11)(12) · `baseline` (A)~(I)
- `client-qt/README.md` — 「P4 마감」 장 · 빌드/실행 · 디렉토리 규약 · 테스트 러너 결선
- `client-qt/env.bat` · `client-qt/build.bat` · `client-qt/run.bat` · `client-qt/common.pri` · `client-qt/tests/main.cpp` — 빌드·러너 정본(읽기)
- `spikes/p0-qt-editor/` 전체 — 승격할 정본 접근(읽기 · 복제 대상)

## 배경

P5는 P4가 세운 `client-qt/` 위에 **에디터 순수 로직층 `client-qt/src/editor/`** 를 신설한다. 이 step은 (1) 인계 게이트 수치를 **자기 손으로 다시 재고**, (2) `src/editor/` 뼈대를 세워 새 QtTest 클래스가 러너에 등록되는 경로를 실증한다. **도메인 로직은 여기서 만들지 않는다**(step2부터).

- **인계 수치를 실측으로 위장하지 마라.** 하나라도 어긋나면 그 사실부터 요약에 적는다(깨끗한 트리에 Spring jar이 없어 대조기가 exit 1인 P4 step0 함정을 그대로 겪을 수 있다 — jar 부재는 회귀가 아니다).
- 빌드는 `client-qt/build.bat`(리포 루트). Bash 도구면 `PATH=/c/Windows/System32:$PATH`를 붙여라(`findstr` 부재 = 거짓 BUILD FAILED).

## 작업

1. **기준선 재측정(연속 2회 A·B · 수치 전건 기록)**: `client-qt\build.bat`(QtTest 총계) · `verify-qt-client.mjs --scenario boot|login|list --server exe|spring` · `npm test` · `npm run lint` · `npm run build` · `spring-contract --parity` · `spa-parity` · `spool-parity`. 자산 지문: 리포 `news.db` 크기·md5 · `uploads/` 파일수·바이트 · 무접촉 축 `git diff --stat` 무출력.
2. **`client-qt/src/editor/` 신설**: 빈 헤더/소스 자리(`.gitkeep` 또는 최소 placeholder 모듈)와 **`common.pri`에 `src/editor` `INCLUDEPATH`/소스 목록 hook**을 additive로 추가한다(기존 net/shell/ui 등록을 건드리지 않는다).
3. **테스트 러너 결선 실증**: `tests/`에 스모크 QtTest 클래스 1개(`EditorSkeletonTest` 등)를 만들어 `tests/main.cpp`의 `runTestClass<…>`에 등록하고, `client-qt/src/editor/`의 placeholder를 호출해 **새 모듈이 app·tests 빌드에 실린다**를 확인한다. **테스트 전용 더블은 `tests/tests.pro`에만**(P4 F1 교훈 — app 빌드 오염 금지).
4. **TDD red→green 실증**: 스모크 테스트에 일부러 틀린 단언(예: `QCOMPARE(1,2)`)을 넣어 `build.bat` exit 1을 본 뒤 고쳐 green.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
cmd /c client-qt\run.bat --selftest
node scripts/verify-qt-client.mjs --scenario boot --server exe
node scripts/verify-qt-client.mjs --scenario list --server exe
node scripts/verify-qt-client.mjs --scenario list --server spring
npm test
npm run lint
npm run build
git status --porcelain
```

- `build.bat` exit 0 · QtTest 총계가 인계값(310) 이상(스모크 추가분만큼 증가) · 실패 0.
- 세 시나리오(boot/login/list) 두 모드 exit 0 — **P4 게이트 무회귀**.
- `npm test`·`lint`·`build` 인계값 무회귀 · 무접촉 경로 diff 0.
- `git status --porcelain`에 빌드 산출물 0줄(`release/`·`Makefile*`·`*.obj`·`.qmake.stash` 무시 확인).

## 검증 절차

1. 재측정 A·B 두 회차 수치를 요약에 **전건** 적고, 인계값과 다르면 그 사실을 먼저 기록한다.
2. TDD red(스모크 실패 단언 → exit 1) → green을 요약에 적는다.
3. `subdirs` 재귀 빌드가 `src/editor` 추가 후에도 서는지 확인한다(P4가 `subdirs`로 선 것을 승계 — 안 서면 그 사실과 폴백을 기록).

## 금지사항

- **도메인 로직을 여기서 만들지 마라.** 이유: 이 step은 골격·러너 결선 전용이고, 블록 모델은 step2의 것이다(실패 원인 격리).
- **`client-qt/src/net|shell|ui/**`·`web/**`·계약을 고치지 마라.** 이유: P5는 계약 관측을 하나도 늘리지 않고 P4 산출물을 재사용만 한다.
- **`git add -A` 금지.** 이유: 빌드 산출물이 통째로 실린다 — 명시 경로만 add.
- **인계 수치를 재지 않고 그대로 옮겨 적지 마라.** 이유: 하네스가 매번 공허 통과로 데인 축이다.
