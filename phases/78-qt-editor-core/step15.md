# Step 15: input-gate-and-ime

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (3)(4)(11) · `baseline` (A)(D)
- **정본 접근(승격 대상)**: `spikes/p0-qt-editor/editorwidget.{h,cpp}`(`caretBlockedForInsert`·`keyPressEvent`·`inputMethodEvent`·`insertFromMimeData`·`inputMethodQuery`) · `selftest.cpp`(T2 마커 게이트·T3 IME 조합 축)
- `client-qt/src/editor/newline.{h,cpp}`(step4 `isInputBlocked`) · `coloring.{h,cpp}`(step6 `shouldRecolor`)
- `phases/78-qt-editor-core/step14.md` — `EditorWidget`(이 step이 확장)
- `client-qt/README.md` — P4 육안 체크리스트 형식(이 step이 P5 IME 항목 추가)
- `web/src/view/Editor.jsx` — `isComposing`/`shouldRecolor`/조합 중 무개입(명세 · L4·398~416)
- `docs/porting-plan-cpp-spring.md` §5 리스크 ②(한글 IME) · `docs/news-md-overrides.md` L174

## 배경

이 step이 P5의 **실기/육안 게이트**다. 마커 입력 차단을 **모든 입력 경로**에 결선하고(로드맵 §5 리스크 ③: 타이핑·Enter·붙여넣기·드롭·IME·치환·정렬·약물·날짜가 전부 이 게이트를 경유) IME 조합 무개입을 구현한다. **기계 판정 가능한 축**(게이트가 마커 뒤 입력을 막는가 · 조합 중 재색칠 0)은 오프스크린 QtTest로, **기계 판정 불가한 축**(실물 MS-IME 조합 중 캐럿 튐)은 **육안 체크리스트**로 잠근다.

정본 규칙(스파이크 승격):
- `keyPressEvent`: 마커 차단 구간(`caretBlockedForInsert` = step4 `isInputBlocked`)에서 텍스트 삽입 키를 삼킨다(앞 줄 편집·삭제·이동은 허용).
- `insertFromMimeData`(붙여넣기/드롭): 차단 구간이면 삽입 안 함 · replaceRange 규칙(step4)으로 마커 앞에 삽입.
- `inputMethodEvent`(IME): 조합 중(`preeditString` 비어 있지 않음)에는 재색칠·본문 동기화·단축키 인터셉트를 하지 않는다(`m_composing`) · 조합 완료(`compositionend` 상당)에만 `recolorNow()`(`shouldRecolor`) · 차단 구간에서는 commit도 막는다.
- `inputMethodQuery(ImEnabled)`: 마커 차단 구간이면 false를 돌려 플랫폼 IME를 끈다.

## 작업

**테스트 먼저(기계 축).** step14 `EditorWidget`을 확장하고 오프스크린 QtTest로:
- 마커 뒤 캐럿에서 keyPress 텍스트 입력이 삼켜진다(세 경로: keyPress·insertFromMimeData·inputMethodEvent commit).
- 마커 앞 편집·삭제·이동은 허용된다.
- 조합 중(`inputMethodEvent` preedit) `reclassifyCount()`가 증가하지 않는다(T3 동형).
- `inputMethodQuery(ImEnabled)`가 차단 구간에서 false다.

**육안 체크리스트(실물 축).** `client-qt/README.md`에 P5 에디터 육안 체크리스트를 추가한다(P4 형식 승계 · `packaging/**`는 무수정):
1. 실물 MS-IME(한글)로 본문 타이핑 중 **조합 중 캐럿 튐 0**.
2. 조합 중 **재색칠이 일어나지 않고**, 조합 완료 시에만 줄 역할 색이 갱신된다.
3. "(끝)" 마커 뒤에서 한글/영문/붙여넣기/드롭 입력이 **차단**되고, 마커 앞은 정상 편집.
4. 캐럿 복원(줄 이동·로드) 후 IME 조합이 그 위치에서 정상 시작.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
node scripts/verify-qt-client.mjs --scenario list --server spring
npm test
npm run lint
git status --porcelain
```
- `build.bat` exit 0 · 게이트 오프스크린 QtTest green(세 입력 경로 차단 · 조합 중 재색칠 0 · ImEnabled false) · 실패 0.
- P4 게이트 무회귀 · 무접촉 diff 0.
- `client-qt/README.md`에 P5 IME/캐럿 육안 체크리스트 4항이 존재한다.
- **실물 MS-IME 육안 체크리스트 실행 결과를 요약에 기록한다**(기계 AC가 아니라 육안 게이트 — 통과/미통과·관측 시간을 정직하게 적는다. 실기 환경이 없으면 「미검증」으로 남기고 그 사실을 기록).

## 검증 절차

1. **변이 3종(기계 축)**: (M15-a) `caretBlockedForInsert`를 항상 false → 마커 뒤 입력 차단 케이스 red? 원복. (M15-b) 조합 중에도 `recolorNow` 호출 → 재색칠 0 케이스 red? 원복. (M15-c) `insertFromMimeData` 게이트 제거 → 붙여넣기 차단 케이스 red? 원복. 결과표 기록.
2. **실물 IME 육안** 4항을 실제 MS-IME로 확인하고 결과를 기록(P0 스파이크가 이 머신에서 go를 받았으나 정식 위젯에서 재확인 — fn P5 착수 전제).
3. 세 입력 경로가 **모두** step4 순수 게이트를 경유함을 테스트로 잠근다(경로별 별도 케이스).

## 금지사항

- **조합 중 재색칠·단축키 인터셉트·본문 동기화를 하지 마라.** 이유: 캐럿 튐의 원인(decisions (4) · §5 리스크 ②).
- **일부 입력 경로만 게이트하지 마라.** 이유: 마커 뒤 오염이 한 경로라도 뚫리면 송고·배부되고 비가역이다(§5 리스크 ③).
- **IME 「된다」를 관측 없이 적지 마라.** 이유: 실물 MS-IME 육안이 유일한 판정이다.
- **`client-qt/src/net|shell|ui/**`·`packaging/**`를 고치지 마라.**
