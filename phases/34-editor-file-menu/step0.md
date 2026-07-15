# Step 0: file-menu-basic

에디터 상단 **파일 메뉴**의 가장 단순한 두 항목 — **새문서(`file.new`)**, **닫기(`file.close`)** — 를 결선한다. 둘 다 이미 존재하는 컨트롤러 메서드(`addTab` / `closeTab`)에 그대로 위임하는 얇은 배선이며, **새 모듈·새 컨트롤러 메서드·서버/DB 변경이 전혀 없다.** 파일 메뉴 8종 결선(phase 34)의 첫 발판이다.

## 배경 (자기완결)

`web/src/view/EditorMenuBar.jsx`의 파일 메뉴에는 8개 항목이 정의돼 있으나(`file.new/open/save/saveAs/recover/print/printPreview/close`), 현재 `WriterPage`의 `MENU_ENABLED` 배열에는 `'file.recover'`만 들어 있어 나머지 7종은 비활성 placeholder다(EditorMenuBar가 `enabledIds`에 없는 항목을 `disabled` 처리 — L166).

- **새문서(`file.new`)** = 새 빈 작성 탭 열기. 컨트롤러 `addTab()`이 정확히 이 동작을 한다(빈 탭 생성 + 활성화, 작성자 시드 자동 채움).
- **닫기(`file.close`)** = 현재 활성 탭 닫기. 컨트롤러 `closeTab(activeTabId)`이 정확히 이 동작을 한다(`removeTab(id, { unlock: true })` 경유 — **편집 탭이면 잠금 해제 요청**, 마지막 탭을 닫으면 빈 새 기사 탭 1개 유지). 화면 탭의 `×` 버튼과 동일한 경로다.

두 메서드는 이미 `useWriteController` 공개 API에 있고, `WriterPage`가 이미 구조분해로 받고 있다(`addTab`, `closeTab`, `activeTabId`). 따라서 **이 step은 `onMenuSelect`에 분기 2개 + `MENU_ENABLED`에 id 2개를 추가**할 뿐이다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md` — 프론트 MVC(View←Controller←Model), 세션 상태(탭 목록은 `sessionStorage` 보존).
- `docs/ADR.md` — ADR-003(view는 서버 상호작용을 controller 경유로만; 이 step은 순수 배선이라 model 직접 호출 없음).
- `docs/news.md` L181 — 파일 메뉴 스펙(새문서, 문서열기, 저장, 다른이름으로 저장, 복구, 인쇄, 인쇄미리보기, 닫기).
- `web/src/view/EditorMenuBar.jsx` L11-22 — 파일 메뉴 항목 id/label 정의. L114-189 — `enabledIds`(배열/Set) 미포함 항목은 `disabled`.
- `web/src/view/WriterPage.jsx`:
  - L93 `MENU_ENABLED` 배열(현재 file 계열은 `'file.recover'`만 포함).
  - L104-108 컨트롤러 구조분해(`tabs, activeTabId, activeTab, addTab, closeTab, selectTab, updateField, submit, saveMapping` — **`addTab`·`closeTab`·`activeTabId` 이미 존재**).
  - L535-691 `onMenuSelect(id)` — 메뉴 항목 라우팅. L598 `if (isMapping) return;`(매핑 가드), L600-609 `file.recover` 처리(참고 패턴).
- `web/src/controller/useWriteController.js`:
  - `addTab` L201-206(빈 탭 push + 활성화), `closeTab` L194 / `removeTab` L182-192(`unlock:true`면 편집 탭 잠금 해제, 마지막 탭 닫으면 빈 탭 유지).
  - 반환 객체(공개 API) L388-393 — `addTab`·`closeTab`이 이미 노출됨을 직접 확인하라.
- `web/src/view/WriterPage.test.jsx` — 상단 메뉴 열기/항목 클릭 헬퍼(`setup`/`openTopMenu` 류)와 기존 메뉴 결선 테스트(예: `file.recover`, `edit.selectAll`) 패턴을 동형 템플릿으로 삼아라.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### `web/src/view/WriterPage.jsx`

1. **`MENU_ENABLED`(L93)에 `'file.new'`, `'file.close'` 두 id를 추가**한다. 기존 항목(특히 `'file.recover'` 및 다른 메뉴 계열)은 **하나도 제거하지 마라**.
2. **`onMenuSelect`에 분기 2개를 `isMapping` 가드(L598) 앞에 추가**한다(탭 관리 동작이라 매핑 모드에서도 유효 — 죽은 버튼 방지):
   - `if (id === 'file.new') { addTab(); return; }`
   - `if (id === 'file.close') { closeTab(activeTabId); return; }`
   - 배치 이유(못박음): `file.new`/`file.close`는 현재 탭의 **본문을 변경하지 않는다**(탭 생성/제거). 따라서 본문-only 불변식을 지키는 `isMapping` 가드 앞에 둔다(`tools.fileInfo`/`tools.historyCompare`가 매핑 가드 앞에 있는 것과 동일 정책). 특히 매핑 탭을 `file.close`로 닫으면 `closeTab`이 잠금을 해제하므로 매핑 취소 경로로 자연스럽다.
3. `addTab`/`closeTab`/`activeTabId`는 **이미 구조분해(L104-108)에 있으므로 추가 분해가 불필요**하다. 없다면(코드가 이전 step으로 바뀌었다면) 추가하라.

새 컨트롤러 메서드·새 모듈은 만들지 마라 — 기존 `addTab`/`closeTab`을 그대로 위임한다.

### 테스트 — `web/src/view/WriterPage.test.jsx`

기존 메뉴 결선 테스트(예 `file.recover`/`edit.*`)의 setup·상단 메뉴 열기 헬퍼를 재사용해 신규 describe(`WriterPage — 파일 메뉴(새문서/닫기)`)를 추가한다:

- **새문서**: 파일 메뉴 → '새문서' 클릭 → 탭 개수가 1 증가하고 새 탭이 활성화됨을 단언(탭 목록 UI 또는 활성 탭 표식으로). 새 탭은 빈 본문임을 확인.
- **닫기(다중 탭)**: 탭이 2개 이상인 상태에서 '닫기' 클릭 → 활성 탭이 제거되고 탭 개수 1 감소 단언.
- **닫기(마지막 탭)**: 탭이 1개일 때 '닫기' 클릭 → 빈 새 기사 탭 1개가 유지됨(개수 0으로 떨어지지 않음) 단언.
- **닫기(편집 탭 잠금 해제)**: `articleId`를 가진 편집 탭을 활성으로 두고 '닫기' → 주입한 fake model의 `unlockArticle`가 그 `articleId`로 호출됨을 단언(잠금 수명 계약). fake model 미보유 테스트 harness면 최소한 탭이 닫히는 것만 단언하고 잠금 단언은 컨트롤러 테스트에 위임해도 된다.
- (선택) '새문서'/'닫기' 메뉴 항목이 **활성(enabled)** 임을 단언(placeholder였다가 결선됐음을 잠금).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test`는 실행 불필요. 이 step은 client 전용이며 server/DB를 건드리지 않는다.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `web/src/view/Editor.jsx`가 diff에 없는가?(에디터 내부 미접촉)
   - `server/` 하위와 DB 스키마가 diff에 없는가?(client 전용)
   - `MENU_ENABLED`에서 기존 결선 id(`file.recover` 등)가 하나도 제거되지 않았는가?
   - 기존 메뉴 결선 테스트가 모두 그린인가?(회귀 없음)
   - CLAUDE.md 준수: UTF-8 인코딩·DB 비파괴(행 삭제/스키마 변경 없음)·ADR-003(model 직접 호출 미추가).
3. 결과에 따라 `phases/34-editor-file-menu/index.json`의 step0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 한 줄 요약(무엇을 `MENU_ENABLED`/`onMenuSelect`에 추가했는지, 위임 대상 `addTab`/`closeTab`, 추가 테스트).
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 기록 후 즉시 중단.
4. top-level `phases/index.json`의 34 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- `MENU_ENABLED`에서 기존 결선 id를 제거하지 마라. 이유: `file.recover`·편집/도구/표/맞춤법 계열이 즉시 죽은 버튼이 되어 회귀한다.
- `file.new`/`file.close`용 새 컨트롤러 메서드를 만들지 마라. 이유: `addTab`/`closeTab`이 정확히 그 계약(빈 탭 생성/활성화, 편집 탭 잠금 해제 + 마지막 탭 유지)을 이미 제공한다 — 중복 구현은 잠금 수명 계약을 이원화한다.
- `closeTab`을 `removeTab(id, { unlock: false })`로 바꿔 부르지 마라. 이유: `unlock:false`는 편집 잠금을 해제하지 않아 다른 세션이 그 기사를 못 열게 잠긴 채 남는다(잠금 누수). 메뉴 닫기는 `×` 버튼과 동일하게 `unlock:true`여야 한다.
- `web/src/view/Editor.jsx`·`server/`·DB 스키마를 건드리지 마라. 이유: 이 step은 메뉴 라우팅 배선일 뿐이며, 에디터 내부/백엔드 변경은 범위 밖이고 회귀 표면만 넓힌다.
- `file.new`/`file.close` 분기에서 본문(`updateField('body', ...)`/`serialize`)을 건드리지 마라. 이유: 이 두 항목은 탭 관리 동작이지 본문 편집이 아니다 — 본문을 만지면 매핑 가드 앞 배치의 전제(본문 불변)가 깨진다.
- 기존 테스트를 깨뜨리지 마라.
