# Step 2: upload-tab-race-guard

첨부/자료파일 업로드 완료가 '업로드 시작 시점 탭'이 아니라 '응답 도착 시점의 활성 탭'에 기록돼, 업로드 대기 중 탭을 바꾸면 **다른 기사에 첨부가 오기록**되고 원래 기사는 첨부를 잃는 결함을 고친다. 이미 검증된 형제 가드(`pasteImageAtCaret`의 탭 고정 패턴)를 `CommonInfo.onFileChange`에 그대로 본뜬다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 프론트 MVC, 탭별 작성 내용 독립성(작성 탭 목록·탭별 내용).
- `/docs/ADR.md` — ADR-003(View는 transport 비의존, 업로드는 `model.uploadFile` 경유).
- `/docs/news.md` — 기사 작성 탭 규칙(55~61행: 탭별 작성 내용 독립·탭 전환), 공통정보 첨부/자료파일(49행).
- `/web/src/view/WriterPage.jsx` — **수정 대상**. 이 파일은 step0에서 (최소 변경이 있었다면) 이미 손댔을 수 있으니 **현재 파일을 처음부터 정독**하라. 특히:
  - `CommonInfo.onFileChange`(약 946~951행): `const r = await model.uploadFile(file); if (r && r.ok && r.path) updateField(field, r.path);` — 시작 시점 탭을 캡처하지 않는다.
  - `pasteImageAtCaret`(약 611~636행): 본떠야 할 **선례 가드**. `const tabId = activeTab.id; ... await ...; const current = activeTabRef.current; if (!current || current.id !== tabId) { window.alert('편집 탭이 바뀌어...'); return; }`.
  - `activeTabRef`(약 219~220행): 항상 최신 활성 탭을 가리키는 미러 ref(effect로 동기화). `updateField`는 항상 현재 활성 탭에만 쓴다.
  - `<CommonInfo tab={activeTab} updateField={updateField} model={model} readOnly={isMapping} />`(약 800행): 현재 CommonInfo에 넘기는 props. `activeTab`은 렌더 시점 활성 탭 스냅샷이라 `tab.id`가 곧 "그 렌더 시점 탭 id"다.
  - `CommonInfo` 함수 정의(약 941행~): `function CommonInfo({ tab, updateField, model, readOnly = false }) { ... }`.
- `/web/src/view/WriterPage.test.jsx` — **수정 대상**. 특히 참고할 선례 테스트:
  - "업로드 대기 중 다른 탭으로 이동하면 새 탭 본문이 파손되지 않는다"(약 596~618행): `uploadFile`을 지연 프라미스로 mock → 대기 중 '새 작성 탭' 클릭으로 탭 전환 → resolve → 삽입 취소 + `window.alert` 호출 단언. 이 패턴을 첨부/자료 업로드로 재현한다.
  - 첨부/자료 업로드 정상 케이스(약 916~955행): `userEvent.upload(getByLabelText('첨부파일'|'자료파일'), file)` → `model.uploadFile` 호출 → 보류 저장 dto에 path가 실림.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- 탭 A에서 첨부 파일 선택 → 업로드 왕복(await) 중 탭 B로 전환 → 응답 도착 → `updateField`가 활성 탭(B)에 기록 → 기사 B에 오첨부, 기사 A는 첨부 누락. B가 매핑 탭이면 path가 조용히 소실될 수 있다.
- 근본 원인: `onFileChange`가 업로드 **시작 시점 탭 id를 캡처하지 않고**, `updateField`가 항상 `activeRef.current`(현재 활성 탭)에만 쓴다. `pasteImageAtCaret`는 이미 이 위험을 `tabId` 고정 + `activeTabRef` 비교로 방어한다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `WriterPage.test.jsx`

`pasteImageAtCaret`의 탭 전환 테스트(약 596행)를 본떠 첨부/자료파일용 회귀 테스트를 추가한다:

- `model.uploadFile`을 **지연 프라미스**로 mock한다(예: `vi.spyOn(model,'uploadFile').mockImplementation(() => new Promise((res) => { resolveUpload = res; }))`).
- 탭 A에서 `userEvent.upload(getByLabelText('첨부파일'), file)`로 업로드를 시작(in-flight)한다.
- 업로드 대기 중 '새 작성 탭'으로 전환한다(선례 테스트와 동일한 방식: `getByRole('button', { name: '새 작성 탭' })` 클릭 후 에디터에서 이전 탭 본문이 사라짐을 확인).
- 그 뒤 `resolveUpload({ ok: true, path: '/uploads/x.pdf' })`로 응답을 도착시킨다.
- 단언: 새 탭(B)에 첨부 path가 기록되지 **않고**, `window.alert`가 호출되며(취소 안내), 원래 탭(A)로 돌아왔을 때 첨부가 A에만 반영(또는 취소로 미반영)됨을 확인한다. 최소 불변식은 "탭이 바뀌면 활성 탭(B)에 오기록되지 않는다"이다.
- 자료파일(`getByLabelText('자료파일')`)에 대해서도 동일 회귀를 1건 추가한다(같은 코드 경로지만 필드가 다름).
- 기존 정상 케이스 테스트(약 916~955행: 탭 전환 없이 업로드 → dto에 path 실림)는 **그대로 통과**해야 한다.

### 2) 구현 — WriterPage.jsx (`CommonInfo.onFileChange`)

- `onFileChange` 진입 시점에 시작 탭 id를 캡처한다(렌더 시점 스냅샷 `tab.id` 사용). `await model.uploadFile(file)` 후, 현재 활성 탭 id가 시작 탭 id와 **같을 때만** `updateField(field, r.path)`로 반영하고, 다르면 반영하지 않고 취소를 안내한다(`pasteImageAtCaret`과 동일 패턴·동일 안내 톤).
- `CommonInfo`는 현재 `activeTabRef`에 접근할 수 없다. **최소 prop만 추가로 넘겨** 현재 활성 탭 id를 읽을 수 있게 한다. 권장: `<CommonInfo ... activeTabRef={activeTabRef} />`로 넘기고 `onFileChange`에서 `activeTabRef.current?.id`와 비교한다(pasteImageAtCaret과 동일 소스). prop 이름/형태는 재량이나 **추가 prop은 최소 1개**로 제한하고, 다른 계약은 바꾸지 마라.
- 취소 시 안내는 `window.alert`로 하되 문구는 `pasteImageAtCaret`의 '편집 탭이 바뀌어 ...' 톤과 일관되게(예: '편집 탭이 바뀌어 파일 첨부가 취소되었습니다.') 한다.

### 시그니처 수준 지시

- `onFileChange`의 시그니처(`async (field, e) => {...}`)는 유지한다. 내부에 시작 탭 캡처 + await 후 탭 비교 가드만 추가한다.
- `CommonInfo({ tab, updateField, model, readOnly })`에 `activeTabRef`(또는 동등한 최소 getter) 1개만 추가한다.

### 핵심 불변식(반드시 준수)

- 업로드 응답 도착 시 활성 탭 id가 시작 탭 id와 다르면 **`updateField`를 호출하지 않는다**(다른 기사에 오기록·원본 기사 첨부 소실 방지).
- 탭 전환이 없는 정상 경로의 동작(업로드 → 해당 필드에 path 반영)은 기존과 동일하게 유지된다.
- View에서 `fetch`를 직접 호출하지 않는다 — 업로드는 `model.uploadFile`만 사용한다(ADR-003).

## Acceptance Criteria

```bash
npm run test:web   # 신규 탭 전환 레이스 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 업로드가 `model.uploadFile`만 경유하는가(View에서 fetch 직접 호출 없음 — ADR-003)?
   - 추가한 prop이 최소(1개)이고 다른 계약을 바꾸지 않았는가?
   - CLAUDE.md 규칙(DB 비파괴·zero-dep)을 위반하지 않았는가?
3. 결과에 따라 `phases/27-editor-critical-fixes/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- `pasteImageAtCaret`(붙여넣기 이미지 경로)를 수정하지 마라. 이유: 이미 검증된 가드이며, 이 step은 첨부/자료 업로드(`onFileChange`)에만 동일 패턴을 적용한다 — 검증된 코드를 건드리면 phase 20 회귀 위험이 생긴다.
- `updateField`의 동작(활성 탭 대상 기록)을 바꾸지 마라. 이유: 다수 필드·자동저장·매핑 저장이 이 동작에 의존한다 — 가드는 호출부(onFileChange)에서만 건다.
- `CommonInfo`에 여러 prop을 추가하거나 컴포넌트를 분해하지 마라. 이유: scope 최소화 — 탭 id 비교에 필요한 최소 1개 prop만 추가한다.
- View에서 `fetch`/`EventSource`를 직접 호출하지 마라. 이유: ADR-003 — transport는 httpModel 안에만.
- 서버/DB 스키마를 수정하지 마라(이 4건은 클라이언트 방어가 1차 — 서버 심화방어는 별도 phase). 이유: DB 비파괴 원칙, 그리고 이 결함은 클라이언트 탭 상태 관리 문제다.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라(특히 붙여넣기 이미지 탭 전환 테스트·첨부/자료 정상 업로드 테스트). 이유: 회귀 스위트가 하류 단계의 안전망이다.
