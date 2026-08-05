# Step 8: save-contract-guard

## 목표

`web/src/controller/useWriteController.js`에 남아 있는 **계약 위생 2건**을 닫는다.

1. **오버라이드 반쪽 적용**: `toSaveDto(tab, override)`가 `override.body`만 있으면 본문은 교체하면서 제목은 `tab.fields.title`(변환 전 값)로 남긴다 — 주석은 "전부 아니면 전무로 수렴한다"고 선언하는데 코드는 body-only를 허용한다(주석과 코드 불일치 + 자기모순 스냅샷 가능).
2. **reject 규율 불일치**: 같은 파일에서 `lockArticle`·`unlockArticle`·`submit`의 `saveArticle`은 `Promise.resolve(...).catch(...)`로 reject를 값으로 흡수하는데, `save`·`saveAsNew`·`saveMapping`의 `saveArticle`, `submit`의 신규 경로 `saveArticle`과 `applyAction`, SSE 핸들러의 `queryArticles`는 감싸지 않아 **모델이 reject하면 호출부의 실패 안내가 통째로 건너뛰어진다**(사용자에겐 아무 반응 없는 버튼).

> **선행**: controller 패스의 두 번째 step. **step7이 끝난 뒤** 시작한다(같은 파일 순차 수정 — 동시 수정 금지).
> 수정 대상은 **`web/src/controller/useWriteController.js` + `web/src/controller/useWriteController.test.jsx` 2개뿐**이다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md` — 프론트 MVC(Model은 주입형 계약, 컨트롤러가 오케스트레이션).
- `web/src/controller/useWriteController.js`
  - `toSaveDto(tab, override)`:
    ```js
    const { body, ...rest } = tab.fields;
    const ov = override && typeof override === 'object' ? override : null;
    const dto = { ...rest, markupVersion: ov?.body ?? body };
    if (ov && ov.body != null && ov.title != null) dto.title = ov.title;
    if (tab.articleId) dto.articleId = tab.articleId;
    ```
    바로 위 주석이 계약을 서술한다: 본문은 `markupVersion` 키로만 싣는다 / `role`은 어디에도 싣지 않는다 / 제목 파생은 뷰의 `bodyTitle` 단일 출처 / **"계약 위반은 '전부 아니면 전무'로 수렴한다"** / `title=''`도 유효한 제목이라 `!= null` 판정만 쓴다(truthy 금지).
  - `save`(L352 근처) / `saveAsNew`(L367) / `saveMapping`(L376) / `submit`의 신규 경로(L394) / `submit`의 `applyAction`(L414) / SSE 핸들러의 `queryArticles`(L463) — **감싸지 않은** 모델 호출.
  - 이미 감싼 선례: `openArticle`의 `lockArticle`, `submit`의 편집 경로 `saveArticle`, `unlockArticle` 2곳(`.catch(() => {})`).
  - `openArticle`/`openFromSource`의 `getArticle`은 이미 `try/catch`로 감싸여 있다(중복 처리 금지).
- `web/src/view/WriterPage.jsx`(읽기만) — 오버라이드 생산자: `autoCompanyCodeOverride()`가 **항상** `{ body: nextBody, title: bodyTitle(nextBody) }` 한 쌍을 돌려주거나 `null`을 돌려준다. 소비부는 `saveDocument`(`r && r.ok ? '저장되었습니다.' : '저장에 실패했습니다.'`), `onAction`(`if (r && r.ok) {…} else window.alert(submitFailMessage(action, r))`), `onSaveMapping`(`if (r && r.ok)`), `saveAsDocument`.
- `web/src/model/httpModel.js`(읽기만) — `request()`는 절대 reject하지 않고 `{ ok:false, reason:'network-error'|'invalid-response' }`로 정규화한다(phase 49). 즉 프로덕션 도달성은 낮고, 이 step은 **규율 통일**이 목적이다(같은 파일 안에서 방어 수준이 갈리면 다음 수정자가 어느 쪽이 계약인지 알 수 없다).
- `web/src/controller/useWriteController.test.jsx` — 저장/송고 계약 테스트가 모여 있다(`mockResolvedValue`/`mockRejectedValue` 관례, 탭 상태·호출 인자 단언).

## 배경 (자기완결) — 왜 결함인가

**(1)** `override`는 "저장/송고 직전에 뷰가 만든 본문 교체값"이고, 본문이 바뀌면 **제목(본문 첫 줄)도 함께 바뀌어야** 한다. 지금 코드는 `body`만 온 오버라이드에서 본문만 갈아끼우고 제목은 그대로 둬, 서버에 "본문과 제목이 서로 다른 기사"를 만든다(목록의 제목과 본문 첫 줄이 어긋난다). 오늘의 생산자는 항상 쌍을 보내므로 프로덕션 동작은 바뀌지 않지만, 주석이 선언한 계약과 코드가 어긋난 채로 남아 있으면 다음 생산자가 body-only를 보내는 순간 조용히 깨진다.

**(2)** 컨트롤러가 reject를 그대로 흘리면 `await submit(...)`/`await save(...)`를 감싸지 않은 뷰 핸들러가 통째로 중단돼 **실패 안내가 뜨지 않는다**(phase 53이 "실패는 반드시 알린다"를 계약으로 못 박았다). 같은 파일이 이미 세 곳에서 `.catch`로 흡수하고 있으므로, 나머지도 같은 규율로 맞추는 것이 유일하게 일관된 상태다.

## TDD — 테스트 먼저

`web/src/controller/useWriteController.test.jsx`에 red → green으로 추가한다.

**A. 오버라이드 원자성**
1. 결함 재현: `save({ body: '<새 본문>' })`(title 없음) → `model.saveArticle`에 실린 dto의 `markupVersion`이 **탭의 원래 본문**이고 `title`도 원래 값이다(오버라이드 통째로 무시).
2. 결함 재현: `submit('send', { body: '<새 본문>' })`(편집 경로)에서도 같은 결과다.
3. 회귀: `{ body, title }` 쌍 오버라이드는 오늘처럼 둘 다 실린다(`title: ''`도 실린다 — truthy 금지 계약).
4. 회귀: 오버라이드가 `null`/`undefined`/문자열(옛 계약)이면 통째로 무시되고 탭 필드가 그대로 실린다.
5. 회귀: `title`만 있는 오버라이드도 통째로 무시된다(기존 동작 유지).
6. 회귀: dto에 `body` 키가 없고 `markupVersion`만 있으며 `role`이 없다. `tab.articleId`가 있으면 `articleId`가 실리고 `saveAsNew`는 실리지 않는다.

**B. reject 흡수 규율**
7. 각 경로별 결함 재현(`mockRejectedValue(new Error('boom'))`):
   - `save()` → 예외가 새지 않고 falsy(또는 `{ ok:false }`) 결과를 반환한다.
   - `saveAsNew()` → 동일.
   - `saveMapping()` → 동일하고 `unlockArticle`·탭 리셋이 일어나지 않는다.
   - `submit('send')` **신규 경로**(articleId 없음) → 예외 없이 실패 결과, 탭 리셋 없음.
   - `submit('send')` **편집 경로**에서 `applyAction`만 reject → 예외 없이 실패 결과이고 **잠금 해제·탭 리셋이 일어나지 않는다**(저장은 이미 성공했으므로 되돌리지 않는다).
   - SSE 잠금 신호 처리 중 `queryArticles`가 reject → 예외가 새지 않고 편집 탭이 그대로 살아 있다(오탐 종료 금지).
8. 회귀: 정상 성공 경로(저장→전이→unlock→탭 리셋), 저장 실패(`{ ok:false, reason:'not-holder' }`) 시 `{ ok:false, reason:'save-failed', saveReason:'not-holder' }` 반환(phase 53 계약) 등 기존 케이스가 **무수정 green**이다.

## 작업

1. `toSaveDto`를 "전부 아니면 전무"로 맞춘다 — 오버라이드는 **`ov.body != null && ov.title != null`일 때만** 적용하고, 그 외에는 `tab.fields`를 그대로 쓴다.
   ```js
   const ov = override && typeof override === 'object' && override.body != null && override.title != null
     ? override : null;
   const dto = { ...rest, markupVersion: ov ? ov.body : body };
   if (ov) dto.title = ov.title;
   ```
   - `!= null` 판정을 유지하라(`title: ''`은 유효한 제목이다 — truthy 체크 금지).
   - 주석은 이미 이 계약을 서술하고 있다. **코드를 주석에 맞추는 것**이 이 항목의 전부다(주석 재작성 금지, 필요하면 "body-only도 무시한다"만 명확히).
   - **예외적 주석 정정 1줄 허용**: `//   title — 그 본문에서 뷰가 bodyTitle(단일 출처)로 파생한 제목. 미전달이면 tab.fields.title 유지(문서화된 폴백).`(≈L91)은 변경 후 "body만 보내면 제목만 유지된다"로 오독된다 — "body·title은 **쌍으로만** 적용되며, 한쪽이라도 없으면 오버라이드 전체를 무시하고 tab.fields를 쓴다"는 취지로 그 한 줄만 정정하라(다른 주석 줄은 그대로).
2. 감싸지 않은 모델 호출을 같은 파일의 선례와 동일한 형태로 흡수한다: `await Promise.resolve(model.X(...)).catch(() => null)`.
   - 대상: `save`·`saveAsNew`·`saveMapping`의 `saveArticle`, `submit` 신규 경로의 `saveArticle`, `submit`의 `applyAction`, SSE 핸들러의 `queryArticles`.
   - 흡수 후 분기는 기존 falsy 처리를 그대로 탄다(`if (r && r.ok)` / `const list = (r && r.items) || []`). **새 사유 토큰을 만들지 마라** — reject는 "결과 없음(null)"으로만 표현한다.
   - `saveAsNew`는 값을 그대로 반환하므로 `return Promise.resolve(model.saveArticle(dto)).catch(() => null);` 형태가 된다.
   - 이미 감싼 3곳과 `getArticle`의 `try/catch`는 **건드리지 마라**(이중 방어 중복).
   - 각 흡수 지점에 이유를 붙이지 말고, 파일 상단(또는 첫 흡수 지점)의 기존 설명 주석에 "모델 reject는 값으로 흡수한다 — 호출부 실패 안내가 건너뛰어지지 않게" 한 줄만 유지·보강하라.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm run test:web  # 실패 0 — step7 종료 시점 + 이번 신규 케이스
npm test          # 백엔드 무접촉 — 실패 0(개수는 step2 종료 시점과 동일)
```

`git diff --name-only`는 `web/src/controller/useWriteController.js`, `web/src/controller/useWriteController.test.jsx` **2개뿐**이어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. phase 53이 추가한 저장 게이트·잠금 무결성 테스트가 **무수정 green**인지 확인한다.
2. 변이 검증 2종(확인 후 원복):
   - `toSaveDto`의 `title != null` 조건을 지워 body-only를 다시 허용하면 A의 결함 재현 케이스만 red.
   - 새로 추가한 `.catch(() => null)` 중 하나를 지우면 대응하는 B 케이스만 red(unhandled rejection).
3. 전수 확인: `git grep -n "await model\." -- web/src/controller/useWriteController.js`로 남은 미흡수 호출이 없는지 확인한다(`getArticle` 2곳은 `try/catch` 안이므로 정상).
4. 아키텍처 체크리스트:
   - 컨트롤러가 `web/src/view/**`를 import하지 않는가?
   - 컨트롤러에 `alert`/`confirm` 같은 사용자 안내가 새로 들어가지 않았는가(안내는 View 책임 — 잠금 실패 안내는 기존 예외)?
   - 실패 시 자동 재시도가 없는가? 새 타이머·네트워크 경로가 없는가?
   - DB·서버 계약(dto 키) 변경 0건인가?
5. `phases/54-audit-closeout/index.json`의 step8을 `completed` + `summary`로 갱신한다. summary에 (a) 오버라이드 원자성 판정식, (b) reject 흡수를 적용한 호출 목록, (c) 프로덕션 동작 무변경(생산자는 항상 쌍을 보낸다)을 명시하라.

## 금지사항

- `title`을 truthy로 판정하지 마라(`ov.title &&` 금지). 이유: 본문 첫 줄이 빈 줄이면 제목은 정당하게 `''`이며, truthy 판정은 그 경우 제목 갱신을 조용히 건너뛴다.
- 컨트롤러에서 제목을 파생(본문 첫 줄 계산)하지 마라. 이유: 제목 파생의 단일 출처는 뷰의 `bodyTitle`이고, 컨트롤러는 view를 import할 수 없다(의존 방향).
- reject를 새 사유 토큰(`'reject'` 등)으로 바꾸지 마라. 이유: 사유 토큰은 서버·모델이 생산하는 계약이며, 컨트롤러가 새 어휘를 만들면 뷰의 문구 매핑이 갈라진다.
- 실패한 저장/전이를 자동으로 재시도하지 마라. 이유: `not-holder`/`forbidden`은 영구 실패이고 네트워크 실패 재시도는 중복 저장·중복 이력(=중복 배부 후보)을 만든다(phase 53 확정 결정).
- `submit`의 저장 실패 게이트(`saved.ok !== true`면 전이·unlock·리셋 생략, `{ ok:false, reason:'save-failed', saveReason }` 반환)를 바꾸지 마라. 이유: phase 53 step4가 검증한 무결성 계약이며 뷰의 안내 문구가 이 키에 묶여 있다.
- SSE 잠금 핸들러의 판정 로직(강제 해제·takeover 조건, `removeTabs` 1회 호출)을 바꾸지 마라. 이유: phase 53 step5의 검증 완료분이다 — 이 step은 그 안의 조회 호출만 흡수한다.
- `web/src/view/**`·`src/`·`server/`를 수정하지 마라. 이유: 이 step은 컨트롤러 한 파일만 다룬다.
- `docs/ADR.md`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라.
- 기존 테스트를 깨뜨리지 마라.
