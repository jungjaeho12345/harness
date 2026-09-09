# Step 2: editor-spike-verdict

**선행 게이트 ②** — `spikes/p0-qt-editor/` 스파이크를 그 AC(한글 조합 중 캐럿 튐 0 · 마커 뒤 입력 차단)에 대해 **실행으로 평가**하고, **go/no-go 판정을 evidence와 함께 기록**한다. 이 phase의 나머지 step(Qt 채택 전제)이 성립하는지를 여기서 확정한다. **프로덕션 코드 0줄** — 스파이크를 빌드·실행하고 결과를 문서에 남길 뿐이다.

## 읽어야 할 파일
- `spikes/p0-qt-editor/build.bat`(빌드 레시피 — MSVC·WinSDK·Qt 경로·`--selftest` 실행) · `spikes/p0-qt-editor/spike.pro`
- `spikes/p0-qt-editor/selftest.cpp`(4축 정본 — **T1** 줄 색상 · **T2** "(끝)" 마커 게이트 · **T3** IME 조합 무개입·캐럿 안정 · **T4** 캐럿 복원) · `selftest.h` · `main.cpp`(`--selftest` → JSON 한 줄 + exit 0=go)
- `spikes/p0-qt-editor/editorlogic.h`(순수 로직 계약 — 웹 `editorColoring.js`·`editorNewline.js` 동형)
- `docs/porting-plan-cpp-spring.md` §5(에디터 리스크) · §7 P0 행(go/no-go 기준: "한글 조합 중 캐럿 튐 0 · 마커 뒤 입력 차단 실기 확인. no-go면 §3-① 재결정")
- `phases/77-cpp-client-skeleton/index.json` decisions (1)(2) · `docs/cutover-p4.md` §0(step0의 툴체인 실측)

## 작업
1. step0이 실측한 툴체인으로 스파이크를 빌드한다(Windows: `build.bat` = `qmake && nmake` · Linux 오프스크린 재현이 가능하면 그 경로도 병기). **스파이크 소스는 수정하지 않는다**(증거물 고정).
2. `spike.exe --selftest`를 실행해 JSON 한 줄을 수집한다(오프스크린 강제 — `main.cpp`가 `QT_QPA_PLATFORM=offscreen`을 자동 설정). 출력의 `t1`~`t4` 각 `{pass,fail}`와 최상위 `go` 값을 기록한다.
3. **결정적 재현**: `--selftest`를 **연속 2회** 돌려 같은 JSON·같은 exit 코드가 나오는지 확인(flake 0).
4. **판정 기록**(evidence 필수):
   - go(권장 · 스파이크가 T1~T4 전부 pass·`go:true`·exit 0)면: 근거 JSON 전문·Qt 버전·2회 동일을 `docs/cutover-p4.md` §2와 `phases/77-cpp-client-skeleton/index.json`의 **forward_notes**(또는 decisions 보강)에 남기고, `docs/porting-plan-cpp-spring.md` §7 P0 행에 "[P4 step2 확정 · 날짜] go — evidence: selftest T1~T4 pass"를 순수 추가한다.
   - no-go(어느 축이든 fail)면: 실패 축·실패명(JSON `failed[]`)을 그대로 기록하고 **§3-① 재결정(WebView2 하이브리드 부상)** 을 open_questions로 승격시킨 뒤 **이 phase를 blocked로 표시**(오케스트레이터 판단 대기) — no-go에서 step3 이후를 강행하지 마라.
5. IME·캐럿은 자동 판정된 것(T3·T4 오프스크린)만 값으로 적고, **육안 실기(체감)** 는 P5 육안 게이트로 이월한다고 명시한다(자동≠체감).

## Acceptance Criteria
```
# Windows(정본 레시피):
cd spikes\p0-qt-editor && build.bat        # qmake && nmake && spike.exe --selftest 까지 · 마지막 줄 {"...,"go":true}
# 판정 재현(2회 동일):
release\spike.exe --selftest               # exit 0 · JSON go:true (연속 2회 동일)
```
- `spike --selftest`가 exit 0(go)이고 `t1.fail=t2.fail=t3.fail=t4.fail=0`이다 — 또는 no-go면 실패 축이 문서에 그대로 박히고 phase가 blocked 처리된다.
- `git diff --stat`에 `spikes/**` 소스 변경이 **없다**(문서만 바뀐다).

## 검증 절차
1. selftest JSON을 2회 수집해 동일함을 확인하고 전문을 §2에 붙인다.
2. `t3.caretStableDuringComposition`·`t3.noRecolorDuringComposition`(캐럿 튐 0) 와 `t2.typeBlocked`·`t2.pasteBlocked`·`t2.enterBlocked`(마커 뒤 차단)가 pass인지 개별 확인 — 이 둘이 로드맵 go/no-go 기준의 핵심이다.
3. porting-plan §7 P0 행 갱신이 순수 추가(삭제 0줄)인지 확인.

## 금지사항
- 스파이크 소스(`selftest.cpp`·`editorlogic.*`·`editorwidget.*`)를 고쳐 selftest를 통과시키지 마라. 이유: go/no-go는 **있는 그대로의 증거**여야 한다 — 스파이크를 손보면 판정이 위조된다.
- no-go인데 go로 적거나 step3로 진행하지 마라. 이유: Qt 전제가 깨진 채 골격을 쌓으면 전체 phase가 재작업된다.
- 자동 selftest 통과를 "IME 체감 검증 완료"로 적지 마라. 이유: 오프스크린 결정 검증과 기자 실사용 체감은 다른 축이다(§8 육안 게이트).
