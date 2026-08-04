# Step 6: submit-failure-feedback

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md` — TDD(테스트 먼저)
- `docs/ADR.md` — ADR-003(View ← Controller ← Model)
- `docs/news.md` 148~151행 — **"송고/보류/KILL 요청이 성공하면 버튼 아래에 상태 메시지를 표시하지 않는다"**, 150행(제목 없으면 실패 ALERT)
- `web/src/view/WriterPage.jsx` — **이 step이 수정하는 유일한 프로덕션 파일**. `ACTION_VERB`(L111), `onAction`(L1439~1460), `saveDocument`의 실패 alert 패턴(L794~806)
- `web/src/controller/useWriteController.js` — **step 4가 확정한** `submit` 반환 계약: 저장 실패 시 `{ ok:false, reason:'save-failed', saveReason }`, 전이 거부 시 `applyAction` 결과 그대로(`{ ok:false, reason:'forbidden-transition' }` 등)
- `web/src/view/editorDraft.js` — `saveDraft`/`loadDraft`/`clearDraft`(초안 보존 단언에 쓴다)
- `web/src/view/WriterPage.test.jsx` — 송고/보류 버튼 테스트와 `window.alert`/`window.confirm` 스텁 패턴

## 배경 (이 step 안에서 자기완결)

`onAction(action)`(L1439~1460)은 제목/`"(끝)"` 가드와 확인창까지는 안내하지만, **`submit` 결과가 실패일 때는 아무 피드백이 없다**:

```js
const r = await submit(action, auto);
if (r && r.ok) { clearDraft(key); historiesRef.current.delete(histTabId); }
// 실패면 조용히 아무 일도 일어나지 않는다
```

step 4가 저장 실패 시 상태 전이를 막았으므로, 이제 실패는 "아무 일도 일어나지 않음"으로 나타난다 — 사용자는 송고가 된 줄 알거나(화면이 그대로라 혼란) 같은 버튼을 반복해서 누른다. 이 step이 그 마지막 구멍을 닫는다.

성공 시에는 **아무 메시지도 띄우지 않는다**(news.md 149행 — 성공 상태 메시지 금지). 실패에만 안내한다.

## 작업

### 1) 착수 전 실측

```bash
npm run test:web    # step 5까지 완료된 상태가 전부 green인지 확인
npm run lint
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`web/src/view/WriterPage.test.jsx`에 케이스를 추가한다(`window.confirm`은 `true`로 스텁, `window.alert`는 스파이).

결함 재현 케이스(구현 전 red여야 한다):

1. 편집 탭에서 `model.saveArticle`이 실패(`{ ok:false, reason:'not-holder' }`)하도록 주입하고 송고 → **저장 실패를 알리는 alert가 뜬다**(문구에 "저장" 실패와 "송고되지 않았다"는 사실이 함께 담겨야 한다). 그리고 `model.applyAction`이 호출되지 않고, 탭이 유지되며(본문·articleId 그대로), **초안이 지워지지 않는다**(`loadDraft(key)`가 그대로 남아 있음 — 사전에 `saveDraft`로 초안을 심어 확인).
2. 저장은 성공하지만 `applyAction`이 실패(`{ ok:false, reason:'forbidden-transition' }`) → 전이 실패를 알리는 alert가 뜬다(문구가 1과 구분된다). 탭 유지·초안 유지.

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

3. 성공 송고/보류 → `window.alert`가 **호출되지 않고**(news.md 149행), 탭이 빈 새 기사 탭으로 리셋되며 초안이 삭제된다(기존 테스트 그대로).
4. 제목 없음·`"(끝)"` 없음 가드의 기존 alert 문구가 그대로다.
5. 확인창(`confirm`)에서 취소하면 아무 요청도 나가지 않는다(기존 동작).
6. 매핑 저장(`onSaveMapping`)·파일>저장(`saveDocument`)의 기존 안내가 변하지 않는다.

### 3) 구현 — `web/src/view/WriterPage.jsx`만 수정

`onAction`의 결과 처리부만 바꾼다:

```js
const r = await submit(action, auto);
if (r && r.ok) { clearDraft(key); historiesRef.current.delete(histTabId); return; }
// 실패 — 사유별 안내. 상태 전이가 일어나지 않았고 편집 내용이 그대로 남아 있다는 사실을 반드시 알린다.
```

핵심 규칙(설계 의도 — 벗어나지 마라):

- `reason === 'save-failed'` → 저장이 실패해 `${ACTION_VERB[action]}`하지 않았고 **편집 내용은 그대로 남아 있다**는 안내. `saveReason` 토큰을 참고 정보로 덧붙여도 되지만, `undefined`/`null`이 문구에 그대로 노출되지 않게 하라.
- 그 외 실패(`forbidden-transition`·`no-end-marker`·`not-found`·`network-error`·응답 없음 등) → `${ACTION_VERB[action]}에 실패했습니다` 계열의 일반 안내(사유 토큰 표시는 선택).
- **성공 시 alert 금지**(news.md 149행).
- `clearDraft`·`historiesRef.delete`는 **성공일 때만** 실행한다(현행 유지 — 실패 시 초안·undo 히스토리를 지우면 편집분 복구 수단이 사라진다).
- 안내 수단은 기존과 동일하게 `window.alert`만 쓴다(새 토스트/배너 컴포넌트 도입 금지 — 이 phase는 무결성 수정이지 UX 개편이 아니다).
- 문구 상수는 이 파일 안에 둔다(`ACTION_VERB` 옆). 다른 화면과 공유하는 메시지 모듈을 새로 만들지 마라.

## Acceptance Criteria

```bash
npm run test:web    # 기준선 + 신규 케이스, fail 0
npm run lint        # clean
npm run build       # 번들 빌드 성공
npm test            # 백엔드 무접촉 확인 — 751 그대로 green
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증(각각 확인 후 반드시 원복):
   - 실패 안내 분기를 제거하면 케이스 1·2가 red가 되는가?
   - 성공 경로에도 alert를 띄우게 바꾸면 케이스 3이 red가 되는가?(news.md 149행 잠금 확인)
3. 아키텍처 체크리스트:
   - 수정 범위가 `web/src/view/WriterPage.jsx` + `web/src/view/WriterPage.test.jsx`뿐인가? (`useWriteController.js`·`Editor.jsx`·`server/`·`src/` 변경 0건)
   - View가 컨트롤러 반환 계약(`reason`/`saveReason` 토큰)만 소비하고, 저장/전이 로직을 다시 구현하지 않는가?
4. 결과에 따라 `phases/53-integrity-fixes/index.json`의 step 6을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "onAction 실패 안내 분기·문구 정책(성공 무메시지 유지)·초안/히스토리 보존 확인·테스트 증감 요약"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- 성공 시 상태 메시지/alert를 추가하지 마라. 이유: news.md 149행이 "성공하면 상태 메시지를 표시하지 않는다"로 명시한 스펙이다.
- 실패 시 `clearDraft`·`historiesRef.delete`·탭 리셋을 실행하지 마라. 이유: 그 순간 편집분과 되돌리기 수단이 함께 사라진다(이번 감사 지적의 핵심 피해).
- 실패 후 자동 재시도·자동 저장을 View에서 걸지 마라. 이유: step 4가 컨트롤러 차원에서 재시도를 금지한 것과 같은 이유(영구 실패 사유·중복 저장).
- 컨트롤러(`useWriteController.js`)를 수정하지 마라. 이유: 반환 계약은 step 4에서 확정됐고, 두 계층 동시 수정은 실패 격리를 막는다.
- 토스트/스낵바/모달 같은 새 안내 컴포넌트를 도입하지 마라. 이유: 이 phase는 데이터 무결성 수정 범위이며, 기존 `window.alert` 패턴이 전 화면에서 일관되게 쓰인다.
- 사유 토큰(`not-holder`·`network-error` 등)을 그대로 노출하는 것 외의 서버 내부 정보(스택·경로 등)를 문구에 넣지 마라. 이유: 내부 정보 비노출 규율(전역 에러 핸들러와 같은 규율).
- 기존 테스트를 깨뜨리지 마라.
