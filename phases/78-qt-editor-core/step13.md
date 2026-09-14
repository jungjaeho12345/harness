# Step 13: draft-and-prefs

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (5)(7)(11)(12) · `open_questions` (2)(3) · `excluded` (b)(d)(f)
- **정본 소스(읽기 전용)**: `web/src/view/editorDraft.js` (118행) · `web/src/view/editorPrefs.js` (122행)
- **정본 테스트(전환 대상)**: `web/src/view/editorDraft.test.js` (19) · `web/src/view/editorPrefs.test.js` (40) — 전수 전환
- `client-qt/src/shell/configstore.{h,cpp}` — 원자적 tmp→rename 쓰기·화이트리스트 패턴(재사용 · 읽기)
- `docs/news-md-overrides.md` — **L174**(맞춤법 설정은 저장만, 네이티브 미배선)

## 배경

자동저장 차원의 **순수 로직 + Qt 초안 저장소 백엔드**를 만든다. 정본은 시각(`nowMs`)을 인자로 주입받고 저장소만 `localStorage`다 — **저장소 백엔드만 Qt 파일(원자적 tmp→rename · `configStore` 패턴)로 교체**하고 로직은 1:1 이식한다(decisions (5)). **타이머·서버 결선·WriterPage는 P6/P7**(서버로 나갈 때 PUT #27 · POST #23만 · 새 엔드포인트·DELETE 금지).

**실패 격리(중요 — 이 step은 P5에서 유일하게 실 파일 I/O를 도입한다)**: 이 step은 세 관심사가 섞이기 쉬운 유일한 순수 step이다 — ① **초안/설정 순수 로직**(saveDraft·expireDrafts·normalizeAutosave 등 · 시각/키만 인자) ② **저장소 추상화**(로직이 의존하는 인터페이스 · 테스트는 인메모리 페이크 주입) ③ **실 파일 I/O 백엔드**(원자적 tmp→rename · 실사용자 폴더 밖). 셋을 코드·테스트에서 분리하라: 순수 로직 케이스는 인메모리 페이크로만 판정하고(파일 I/O 없이 정본 59 케이스 전환), 실 파일 백엔드는 별도 케이스(원자적 쓰기·손상 복구·읽기 실패 graceful)로 판정한다. 이렇게 나누면 「로직이 틀린 것」·「저장소 인터페이스가 틀린 것」·「파일 쓰기가 틀린 것」이 섞이지 않는다.

정본 규칙(draft): `saveDraft(key,data,nowMs)`·`loadDraft`·`clearDraft`·`draftScopeId`(sessionStorage 상당 → Qt 세션 스코프)·`draftKeyFor(articleId,tabId)`·`loadDraftForRecover`(새 키 → 옛 키 폴백 · 기존 기사는 폴백 없음)·`expireDrafts(retentionDays,nowMs)`(`savedAt < nowMs - retentionDays*86400000`). graceful(저장소 불가 시 no-op/기본).

정본 규칙(prefs): `DEFAULT_EDITOR_PREFS`(freeze) · `loadEditorPrefs`(한 단계 깊이 병합) · `normalizeAutosave`(enabled bool · intervalSec/retentionDays finitePositive) · `saveEditorPrefs` · `normalizeLineSpacing`(≤1.0·비유한 → 1.8) · `fontFamilyCss`(명명 폰트만 · sentinel '기본'/무효 → null) · `fontSizeCss`(≤0·비유한 → null) · `setEditorPref`(category 얕은 병합 · 입력 불변).

## 작업

**테스트 먼저.** 두 테스트 파일(19+40=59)을 QtTest로 옮긴다. `nowMs`는 인자 주입(테스트 결정성) — Qt에서도 `Date.now()` 상당을 모듈 내부에서 부르지 않는다(scope id 생성 전용 예외는 정본과 동형).

**`fontFamilyCss`/`fontSizeCss`는 웹 정본 동형 보존을 위한 값 생산·대조일 뿐이다** — P5 위젯은 이 CSS 문자열을 소비하지 않는다(Qt 폰트 적용 = `QFont` 결선은 P6 위젯 스타일과 함께). step13은 이 두 함수가 정본과 같은 문자열(명명 폰트 스택 · sentinel/무효 → null)을 돌려주는지 QtTest로 대조만 하고, 그 값을 위젯에 주입하지 않는다.

`client-qt/src/editor/draft.{h,cpp}` + `client-qt/src/editor/prefs.{h,cpp}` + **초안 저장소 백엔드**(open_question (3): `%APPDATA%\기사작성기-qt\drafts.json` 등 파일 기반 원자적 쓰기 · `configStore` 패턴 재사용 · `QSettings` 금지). 저장소 접근을 인터페이스로 추상화해 테스트에서 인메모리 페이크를 주입한다(정본이 localStorage를 graceful하게 다루는 것과 동형).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
node scripts/verify-qt-client.mjs --scenario boot --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorDraft.test.js`·`editorPrefs.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 59(19+40)와 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **59에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 반드시 존재: draft 만료 cutoff · 복구 옛 키 폴백(기존 기사는 폴백 없음) · normalizeAutosave 손상값(0·음수·NaN·문자열) 정규화 · normalizeLineSpacing/fontFamilyCss/fontSizeCss sentinel 케이스.
- 초안 저장소가 실사용자 폴더 밖(하네스 임시 폴더)에서만 동작하고, `boot` 시나리오가 실사용자 스냅샷 무변을 유지한다.

## 검증 절차

1. 두 테스트 파일 전수 대조(원본 19·40 대비 이식 수 기록). open_question (2) 범위 판정(어느 export를 잠갔는지)과 (3) 저장소 형식을 요약에 적는다.
2. **변이 2종**: (M13-a) `normalizeAutosave`의 finitePositive 제거 → 0·음수 intervalSec 케이스 red? 원복. (M13-b) 복구 폴백이 기존 기사에도 적용되게 → 오복구 케이스 red? 원복. 결과표 기록.

## 금지사항

- **자동저장 타이머·서버 PUT/POST 결선을 여기서 만들지 마라.** 이유: 작성 화면(WriterPage)이 있어야 성립 — P6/P7이다(decisions (5)).
- **서버로 나갈 자동저장에 새 엔드포인트·DELETE를 쓰지 마라.** 이유: PUT #27·POST #23만이 계약이다. DB 비파괴.
- **맞춤법 설정을 네이티브 맞춤법 배선에 쓰지 마라.** 이유: override L174 — 저장 로직만 이식한다.
- **`QSettings`·레지스트리에 초안을 쓰지 마라.** 이유: P4 config 원자적 쓰기 규율과 갈린다(open_question (3)).
- **위젯 의존·웹 원본 수정 금지.**
