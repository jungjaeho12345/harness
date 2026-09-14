# Step 1: adr-editor-core

## 읽어야 할 파일

- `phases/78-qt-editor-core/index.json` — `decisions` (1)~(13) · `open_questions` · `excluded`
- `docs/ADR.md` — 전체 형식(결정/이유/트레이드오프) · **ADR-003**(주입형 Model) · **ADR-011**(spellcheck:false 확정 예외) · **ADR-018**(P4 Qt 클라) · **ADR-008**(배부 타이머 금지 — UI 자동저장과 별개 축임을 명시)
- `docs/porting-plan-cpp-spring.md` — §3①(Qt 6 · 리치 텍스트 위젯) · §5(에디터 재구현 리스크 7축) · §6.2(클라 구조 core/editor)
- `docs/news-md-overrides.md` — **L174**(네이티브 맞춤법 미배선) · **L164**(툴바 2개) · **L169**(붙여넣기 이미지) · **L201**(입력모드=Byte)
- `spikes/p0-qt-editor/editorwidget.{h,cpp}` · `editorlogic.{h,cpp}` · `selftest.cpp` — 승격할 접근(읽기)
- `web/src/view/editorNewline.js` 78~101행 · `editorContent.js` 1~7행 — 마커 이중 기준·직렬화 계약(읽기)

## 배경

P5는 텍스트 엔진 접근·마커 이중 기준·IME 무개입·자동저장 백엔드·순수모듈 배치라는 되돌리기 비싼 결정을 담는다. P4가 step0 뒤에 ADR-018을 쓴 이유(값을 모른 채 쓴 ADR은 추측을 결정으로 굳힌다)를 승계해, step0이 골격·스파이크 접근을 실증한 **뒤에** 이 결정들을 명문화한다. **코드는 한 줄도 쓰지 않는다.**

## 작업

`docs/ADR.md`에 **ADR-019(에디터 코어 — Qt 텍스트 엔진)** 를 **순수 추가**(기존 ADR 무삭제·무수정)한다. 담을 결정(근거를 index `decisions`에서 인용):

1. **텍스트 엔진 = QPlainTextEdit + QSyntaxHighlighter**(스파이크 go 승계 · 커스텀 QAbstractScrollArea 밑바닥 재구현 금지) — decisions (1).
2. **순수 모듈은 `client-qt/src/editor/`에 위젯 비의존으로**(QString/QVector/QJsonObject만 · 웹 순수 모듈 동형) — decisions (2).
3. **\"(끝)\" 마커는 두 판정 기준을 분리 유지**(substring `isInputBlocked` vs 블록 trim `isMarkerBlock`) — decisions (3) · 오염 본문이 송고·배부되면 비가역(ADR-008).
4. **IME 조합 중 무개입**(재색칠·인터셉트·동기화 없음) + **캐럿·IME는 실물 육안 게이트** — decisions (4) · 로드맵 §5 리스크 ②.
5. **자동저장 = 로직 + Qt 초안 저장소 백엔드만 P5**(서버 결선은 PUT #27 · POST #23으로 P6/P7 이월 · 새 엔드포인트·DELETE 금지) — decisions (5).

트레이드오프 문단에 최소 다음을 적는다: 네이티브 맞춤법 미배선(override L174 · ADR-011 승계) · `editorSelect` 네이티브 대체(open_question (1)) · 서버 자동저장·잠금 결선 미포함이 만드는 divergence · IME는 기계 판정 불가라 육안에 의존.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
node scripts/verify-qt-client.mjs --scenario list --server spring
npm test
npm run lint
git status --porcelain
```

- 문서 전용 step — **기존 게이트 전건 무회귀**(빌드·시나리오·`npm test`·lint 인계값 그대로).
- `docs/ADR.md`는 **삭제 0행**(순수 추가 · `git diff` 접두 비교는 CRLF로 신뢰 불가하니 추가 블록 단위로 확인).
- 무접촉 경로 diff 0.

## 검증 절차

1. ADR-019가 기존 ADR을 한 줄도 지우지 않았음을 확인한다(추가 블록만).
2. 5개 결정 각각이 index `decisions`의 근거·`web`/`spikes` 실측을 인용하는지 확인한다(추측 서술 금지).

## 금지사항

- **코드를 쓰지 마라.** 이유: 이 step은 결정 명문화 전용이고, 구현이 섞이면 검토 게이트가 무력화된다.
- **기존 ADR을 수정·삭제하지 마라.** 이유: ADR은 append-only 카탈로그다(ADR-019는 순수 추가 1자리).
- **결정을 실측 없이 단정하지 마라.** 이유: step0이 확인한 스파이크 접근·정본 실측만 근거로 쓴다.
