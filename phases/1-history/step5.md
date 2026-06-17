# Step 5: history-view-wiring

이력보기/송고이력보기 컨텍스트 메뉴 항목을 **활성화**하고, 선택 시 이력을 조회해 새 창에 표시하도록 결선한다. 이 phase의 마지막 step(프론트 View/Controller 결선).

## 읽어야 할 파일

- `/web/src/view/ContextMenu.jsx` — `INACTIVE_ITEMS`에 `history`('이력보기')·`sendHistory`('송고이력보기')가 비활성으로 들어가 있다. `buildContextMenuItems(menu, article, identity)`에서 데스크 미송고는 `inactive('history')`, 그 외 메뉴는 `inactive('history')`+`inactive('sendHistory')`를 넣는다. **이 둘만 활성 항목으로 바꾼다**(나머지 비활성 5개 translate/mapping/followUp/continue/resend는 절대 건드리지 않는다 — 다음 phase 소관).
- `/web/src/view/ListPage.jsx` — `openDetail(article)`가 `window.open('', '_blank', 'width=720,height=800')` 후 `renderDetailHtml`을 write하는 새 창 패턴. `onCtxSelect(key, article)` switch가 `detail`/`copyBody` 등을 처리하고 `default`는 무시(비활성 항목은 onSelect로 오지 않는다는 전제). **여기에 `history`/`sendHistory` case를 추가**한다.
- `/web/src/view/articleDetail.js` — `escapeHtml`·`renderDetailHtml` 패턴(모든 값 이스케이프, 스크립트 실행 불가). **이력 표시 HTML도 같은 이스케이프 규칙**을 따른다.
- `/web/src/controller/useViewController.js` — 우클릭 액션 핸들러(`editArticle`/`reviseArticle`/`releaseLock`/`requestDelete`)가 `model` 경유로 동작하고 반환을 ListPage가 쓰는 패턴. 모든 데이터는 Model 계약 경유(ADR-003). **이력 조회 핸들러를 여기에 추가**한다.
- `/web/src/model/contract.js`·`fakeModel.js` — step 4에서 추가된 `getArticleHistory`/`getSendHistory`.
- `/docs/news.md` — line 85~92(컨텍스트 메뉴: 4개 조회 메뉴 + 데스크 미송고 모두에서 이력보기 제공, 부서별 메뉴는 송고이력보기도), line 102~106(상세보기 새 창 패턴·HTML 이스케이프).
- `phases/1-history/step4.md` — Model 키 시그니처(`getArticleHistory(articleId)` → `{ ok, items }`).

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과 구현.

### (a) `ContextMenu.jsx` — 항목 활성화
1. `buildContextMenuItems`에서 `history`/`sendHistory` 항목을 활성(`enabled: true`)으로 바꾼다. `inactive('history')`/`inactive('sendHistory')` 호출을 `{ key:'history', label:'이력보기', enabled:true }`/`{ key:'sendHistory', label:'송고이력보기', enabled:true }`로 교체한다(데스크 미송고 메뉴는 history만, 그 외 메뉴는 history+sendHistory). `INACTIVE_ITEMS` 배열에서 `history`/`sendHistory`는 더 이상 inactive로 쓰이지 않으므로 제거하되, **나머지 5개(translate/mapping/followUp/continue/resend)는 inactive로 그대로 둔다.**

### (b) `useViewController.js` — 이력 조회 핸들러
2. `viewHistory(article)`·`viewSendHistory(article)` 콜백을 추가한다(`model.getArticleHistory`/`getSendHistory` 위임). 반환은 Model 응답(`{ ok, items }`)을 그대로. 훅 반환 객체에 두 핸들러를 노출한다.
   - 데이터는 반드시 Model 계약 경유(직접 fetch 금지).

### (c) `ListPage.jsx` — 새 창 표시 결선
3. 이력 표시 HTML 렌더 함수를 추가한다(View 순수 함수로 — `articleDetail.js`처럼 별도 모듈 `web/src/view/historyView.js`에 두고 테스트하는 것을 권장). 예: `renderHistoryHtml(items, { title, kind })` — 이력 항목을 시간순 목록으로(발생시각·이벤트 종류·행위자·상태전이 from→to) 렌더하되 **모든 값 `escapeHtml`** (스크립트 실행 불가, CRITICAL). 빈 목록이면 '이력이 없습니다' 같은 안내.
4. `onCtxSelect` switch에 case 추가:
   - `case 'history'`: 이력보기. `case 'sendHistory'`: 송고이력보기.
   - **새 창 팝업 차단 회피**: `window.open(...)`은 클릭 핸들러 안에서 **동기적으로 먼저 호출**해 창 핸들을 얻은 뒤, `viewHistory(article)`(async)로 데이터를 받아 그 창에 write한다. (먼저 await 한 다음 open하면 브라우저가 팝업으로 차단한다 — 이유: 사용자 제스처 컨텍스트 소실.) `openDetail`처럼 빈 문서로 열고, 조회 완료 후 `w.document.write(renderHistoryHtml(...))`; 조회 실패면 오류 안내를 write.
   - 창 크기/제목은 상세보기와 일관(예: 720×800, 제목은 기사 제목 + '이력'/'송고이력' 구분).
5. 테스트:
   - `ContextMenu.test.jsx`(기존, line 12 근처 데스크 미송고 키 배열 단언 포함): `history`/`sendHistory`가 이제 `enabled:true`이고 클릭 시 `onSelect`가 호출되는지 갱신. **기존 단언이 깨질 것이므로 새 동작에 맞게 수정**한다(키 배열·enabled 기대값).
   - `useViewController` 테스트(fakeModel 주입): `viewHistory`/`viewSendHistory`가 Model을 호출하고 items를 반환한다.
   - `historyView` 렌더 테스트: 이력 항목이 HTML로 렌더되고, 악성 값(`<script>` 등)이 이스케이프되며, 빈 목록 안내가 나온다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 실행 — 기존 무회귀(특히 `ContextMenu.test.jsx`의 기존 단언을 새 동작에 맞게 갱신했는지) + 신규 통과.
2. 체크리스트: history/sendHistory만 활성화하고 나머지 5개 비활성 항목은 그대로인가(번역/매핑/후속/계속/재송 = 다음 phase)? 이력 데이터가 Model 계약 경유인가(직접 fetch 없음)? 새 창 HTML이 전부 이스케이프되는가(XSS 방어)? 팝업 차단 회피를 위해 window.open을 동기 호출하는가?
3. `phases/1-history/index.json`의 step 5 업데이트(completed + summary: 활성화 항목·핸들러·렌더 모듈). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- translate/mapping/followUp/continue/resend 항목을 활성화하거나 건드리지 마라. 이유: 이 phase 범위 밖(다음 phase). 이번엔 history/sendHistory 2개만 동작시킨다.
- 이력 표시 HTML에서 값을 이스케이프 없이 write하지 마라. 이유: 저장된 제목/본문/행위자 값에 스크립트가 섞이면 새 창에서 실행된다(XSS) — CRITICAL.
- View/Controller에서 직접 fetch/EventSource를 호출하지 마라. 이유: ADR-003 — transport는 Model(httpModel) 뒤에만.
- 데이터를 받은 뒤(await 후)에 `window.open`을 호출하지 마라. 이유: 사용자 제스처 컨텍스트가 끊겨 브라우저가 팝업을 차단한다 — 이력 창이 안 뜬다.
- 백엔드/Model 계약 파일을 수정하지 마라. 이유: step 0~4에서 완료. 이 step은 View/Controller 결선만.
