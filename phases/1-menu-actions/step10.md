# Step 10: frontend-translate-view

우클릭 메뉴의 **번역(translate)**을 동작하게 만든다. 클릭 시 기사 본문/제목을 번역해 모달/새 창으로 보여준다. 이 step은 프론트엔드 View + Controller 레이어를 다룬다. **이 step은 translate만 담당한다 — mapping은 step11(mapping-embed-mode)에서 활성화하므로 여기서는 건드리지 않는다.**

**graceful degrade 전제:** 번역 키가 없거나 외부 호출이 실패하면(step5·6) 서버가 `{ ok:false, reason:'no-key'|'error', translatedText:<원문> }`를 graceful하게 내려준다. 프론트는 오류를 던지지 말고 **원문 + "번역 불가" 안내**를 표시한다.

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-003(View←Controller←Model·transport는 httpModel 뒤).
- `/docs/ARCHITECTURE.md` — 프론트엔드 MVC.
- `/docs/news.md` — 51~52행(외부 실패 시 빈 결과/graceful), 85행(번역 메뉴), 88행(현재 비활성), 103~106행(새 창 표시·HTML 이스케이프).
- step5/6 산출물: 번역 서비스/라우트(graceful 응답 shape).
- step7 산출물: `web/src/model/*`(`translate(...)` 메서드 — step6/7이 택한 시그니처 확인).
- step8 산출물: ListPage 모달/새 창 표시 패턴(번역도 동일 방식 재사용 권장).
- 현재 구현(반드시 정독):
  - `web/src/view/ContextMenu.jsx` — `INACTIVE_ITEMS`(`translate`·`mapping` 남음)·`inactive()`·`buildContextMenuItems`. **여기서 translate만 활성화한다. mapping은 step11 소관이므로 손대지 마라**(현재 상태 그대로 두면 된다 — 비활성으로 강제하지도, 활성화하지도 않는다).
  - `web/src/view/ListPage.jsx` — `onCtxSelect`·표시 UI 패턴.
  - `web/src/controller/useViewController.js` — 우클릭 액션 핸들러 패턴.
  - 테스트 패턴: `web/src/view/ContextMenu.test.jsx`·`web/src/controller/useViewController.test.jsx`·`web/src/view/ListPage.test.jsx`.

이전 코드를 정독하고, step8의 history 표시 방식(모달/새 창)을 확인해 일관되게 재사용한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

1. **ContextMenu** `web/src/view/ContextMenu.test.jsx`: `translate` 항목이 부서별 작성/송고·개인별 수정 메뉴에서 **활성**이다(세션 있으면 가능 — 권한 게이트 없음, 서버가 인증 게이트). `mapping`은 이 step의 검증 대상이 아니다(step11 소관) — `mapping` 활성/비활성에 대한 단언을 이 step에서 추가하지 마라.
2. **Controller** `web/src/controller/useViewController.test.jsx`(fakeModel): `runTranslate(article, targetLang)`가 `model.translate`를 호출하고 `translatedText`를 반환한다. 서버가 `ok:false`(키 없음)를 줘도 throw하지 않고 `{ ok:false, translatedText:<원문> }`를 그대로 반환한다.
3. **ListPage**(선택): 우클릭 `번역` 선택 시 모달/창에 번역문(또는 graceful 안내)이 표시된다.

먼저 실패를 확인한 뒤 구현한다.

### 구현 A: 컨텍스트 메뉴 활성화 `web/src/view/ContextMenu.jsx`

`translate`를 `inactive()`에서 빼고 `{ key:'translate', label:'번역', enabled:true }`로 활성화하라(세션만 있으면 가능 — 권한/상태 게이트 없음).

- **`mapping`은 건드리지 마라**(step11 소관). `mapping`을 `INACTIVE_ITEMS`에서 빼지도, 비활성으로 새로 강제하지도 마라 — 현재 상태 그대로 둔다.
- history/sendHistory(step8)·followUp/continue/resend(step9)의 활성 상태를 건드리지 마라.

### 구현 B: 컨트롤러 핸들러 `web/src/controller/useViewController.js`

`runTranslate(article, targetLang = 'ko')`를 추가하고 반환에 노출하라:

```
const runTranslate = useCallback(async (article, targetLang = 'ko') => {
  // step6/7 시그니처에 맞춤: (A) model.translate(article.articleId, targetLang)
  //                         (B) model.translate(<화면 본문 텍스트>, targetLang)
  const r = await model.translate(...);
  return r; // { ok, translatedText, reason? } — graceful, throw 없음
}, [model]);
```

- 모든 데이터는 `model.translate` 경유(직접 fetch 금지 — ADR-003).
- (B) 형태라면 번역할 텍스트를 화면 본문에서 구성(예: `blocksToText(deserialize(article.markupVersion))` — ListPage가 copyBody에서 쓰는 패턴 재사용). (A) 형태라면 articleId만 넘기고 서버가 본문을 조회한다.

### 구현 C: 표시 UI `web/src/view/ListPage.jsx`

`onCtxSelect`에 `case 'translate':` 추가 — `runTranslate(article)` 결과를 step8과 동일한 방식(모달 또는 새 창)으로 표시:

- 성공(`ok:true`): `translatedText`를 표시.
- graceful 실패(`ok:false`): `translatedText`(원문)와 함께 "번역을 사용할 수 없습니다(원문 표시)" 안내. **오류 모달/throw가 아니라 안내**여야 한다.
- 새 창 방식이면 **HTML 이스케이프**하라(번역문/원문이 사용자 유래 — XSS 방어, news.md 106행).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

기존 테스트를 단 1개도 깨뜨리지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - `translate`만 활성화했는가? `mapping`은 손대지 않고 그대로 두었는가(step11 소관)? history/sendHistory/followUp/continue/resend 상태를 안 건드렸는가? (step 분리)
   - 번역이 `model.translate` 경유인가? 직접 fetch가 없는가? (ADR-003)
   - 키 없음/외부 실패 시 throw 없이 원문+안내로 graceful 표시되는가? (news.md degrade)
   - 새 창 방식이면 번역문/원문이 HTML 이스케이프되는가? (XSS 방어)
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 10을 업데이트한다(완료/error/blocked 양식 동일).

## 금지사항

- 번역을 위해 직접 `fetch`를 호출하지 마라. 이유: ADR-003 — `model.translate`만.
- 번역 실패를 오류 모달/throw로 처리하지 마라. 이유: news.md — 외부 실패는 graceful degrade(원문+안내).
- `mapping` 메뉴 항목을 이 step에서 활성화하거나 비활성으로 강제하지 마라. 이유: 매핑 활성화는 step11(mapping-embed-mode) 소관이다 — step 분리. 이 step은 translate만 다룬다.
- 번역 결과를 이스케이프 없이 새 창/DOM에 삽입하지 마라. 이유: XSS 방어(news.md 106행).
- history/sendHistory/followUp/continue/resend의 활성 상태를 변경하지 마라. 이유: step8·9 소관 — 회귀 위험.
- 기존 테스트를 깨뜨리지 마라.
