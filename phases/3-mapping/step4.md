# Step 4: context-menu-activation

컨텍스트 메뉴의 `매핑`(mapping) 항목을 **활성화**하고, ListPage의 우클릭 선택 결선(`onCtxSelect`)에 `mapping` 케이스를 연결한다. **`번역`(translate)은 비활성 그대로 유지**한다(provider 미결정 — 다음 과제). 이 step은 **뷰 두 모듈(`web/src/view/ContextMenu.jsx`, `web/src/view/ListPage.jsx`)** 의 결선만 다룬다(컨트롤러/Model/스키마 무변경).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/news.md` — line 85~88(컨텍스트 메뉴 항목과 비활성 항목: `매핑` 활성화 대상, `번역`은 비활성 유지).
- `/web/src/view/ContextMenu.jsx` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `INACTIVE_ITEMS = [{key:'translate',label:'번역'}, {key:'mapping',label:'매핑'}]` — 현재 둘 다 비활성. **mapping을 여기서 제거**하고 translate만 남긴다.
  - `inactive(key)` — INACTIVE_ITEMS에서 라벨을 찾아 `{key,label,enabled:false}`를 만든다.
  - `buildContextMenuItems(menu, article, identity)`의 else 분기(부서별 작성·송고·개인별 수정)에 `inactive('translate'), inactive('mapping')` 순으로 들어가 있다. **`inactive('mapping')`을 정식 활성 항목 `{key:'mapping', label:'매핑', enabled:true}`로 교체**한다.
  - 항목 순서/라벨은 기존을 유지한다(translate, mapping, followUp, continue, 고침류, requestDelete, resend …). `deskUnsent` 메뉴는 매핑 항목이 없다 — 무변경.
  - 매핑 활성 조건: news.md상 매핑은 부서별 작성·송고·개인별 수정 메뉴에서 표시되며 **권한·상태 제한 없이 항상 활성**으로 둔다(매핑은 일반 편집 진입 — 잠금/권한은 서버가 강제. 후속/계속과 동일하게 `enabled:true`).
- `/web/src/view/ListPage.jsx` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `const { ..., editArticle, reviseArticle, followUpArticle, continueArticle, resendArticle, ... } = ctrl;` 구조분해. step2에서 추가한 **매핑 콜백(예: `mapArticle`)** 을 여기에 추가한다.
  - `onCtxSelect(key, article)`의 switch — `case 'edit'`/`'followUp'`/`'resend'` 등. **`case 'mapping': mapArticle(article); break;`** 를 추가한다.
  - `default:` 주석("비활성(표시만) 항목은 onSelect로 오지 않는다") — 매핑이 활성화되면 onSelect로 오므로 case가 필요하다.
- `/web/src/controller/useViewController.js` — step2에서 추가한 매핑 콜백 이름(`mapArticle` 등)·반환 노출 확인(읽기만, 수정 금지).
- `/web/src/view/ContextMenu.test.jsx` — 컨텍스트 메뉴 항목/활성 단언 테스트. 기존에 `mapping`이 **비활성**이라고 단언하는 케이스가 있으면 **활성**으로 갱신해야 한다. `translate`는 비활성 단언 유지.
- `/web/src/view/ListPage.test.jsx` — 우클릭 선택 결선 테스트(onCtxSelect→콜백 호출 단언) 패턴. 매핑 케이스를 추가한다.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**(또는 기존 비활성 단언 갱신)한 뒤 통과하는 구현을 작성한다.

핵심 결정(반드시 따른다):
- `매핑`만 활성화한다. **`번역`(translate)은 비활성(`enabled:false`) 그대로 유지**한다 — provider 미결정이며 이 phase 범위 밖이다. translate를 건드리지 마라.
- 매핑은 부서별 작성·송고·개인별 수정 메뉴에서 **권한·상태 제한 없이 항상 활성**(`enabled:true`)이다. `deskUnsent` 메뉴 항목 구성은 무변경(매핑 없음).

구현(시그니처는 재량, step3의 followUp/continue 활성화 패턴을 참고 — phase 2-followup-resend step3와 동일한 성격):
- `ContextMenu.jsx`: `INACTIVE_ITEMS`에서 `mapping`을 제거(translate만 남김). `buildContextMenuItems`의 else 분기에서 `inactive('mapping')`를 `{ key:'mapping', label:'매핑', enabled:true }`로 교체. `inactive('translate')`는 그대로 둔다. 항목 순서 유지.
- `ListPage.jsx`: 컨트롤러 구조분해에 매핑 콜백(`mapArticle` 등) 추가. `onCtxSelect` switch에 `case 'mapping': mapArticle(article); break;` 추가.

테스트:
- `ContextMenu.test.jsx`: 부서별 작성/송고/개인별 수정 메뉴에서 `mapping` 항목이 `enabled:true`인지(권한 R·D·Z, 상태 DPS·RDS 등 다양화). `translate`는 여전히 `enabled:false`인지. `deskUnsent`에는 매핑 항목이 없는지.
- `ListPage.test.jsx`: 컨텍스트 메뉴에서 `mapping` 선택 시 컨트롤러의 매핑 콜백(`mapArticle`)이 해당 article로 호출되는지(fakeModel/spy).
- 기존 followUp/continue/resend/edit 결선·비활성 translate 단언이 무회귀인지.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC를 실행한다. 기존 web 테스트 + 신규/갱신 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트:
   - `매핑`이 부서별 작성·송고·개인별 수정 메뉴에서 활성(`enabled:true`)인가?
   - `번역`(translate)은 비활성 그대로인가(미변경)?
   - `onCtxSelect`의 `mapping` 케이스가 컨트롤러 매핑 콜백으로 가는가(직접 fetch 없음, ADR-003)?
   - `deskUnsent` 메뉴·컨트롤러·Model·스키마가 무변경인가?
3. `phases/3-mapping/index.json`의 step 4를 업데이트(completed + summary: INACTIVE_ITEMS에서 mapping 제거(translate만 비활성)·매핑 정식 활성 항목·onCtxSelect mapping 케이스 결선·web 테스트 증감). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- `번역`(translate)을 활성화하거나 INACTIVE_ITEMS에서 제거하지 마라. 이유: provider 미결정이며 다음 과제다 — 이 phase 범위 밖이다.
- 매핑에 권한 게이트(상태/role 조건)를 걸지 마라. 이유: 매핑은 일반 편집 진입(고침류와 달리 상태 제한 없음)이며 잠금·권한은 서버 lock/PUT이 강제한다 — 메뉴 활성 조건을 거는 것은 설계와 어긋난다(후속/계속과 동일하게 항상 활성).
- 컨트롤러(`useViewController.js`)/Model/`server/` 백엔드/스키마를 수정하지 마라. 이유: 매핑 콜백은 step2에서 완료됐다 — 이 step은 메뉴 활성화·결선만이다.
- `deskUnsent` 메뉴 항목 구성을 바꾸지 마라(매핑 항목 없음). 이유: 무관한 메뉴 회귀를 막는다.
- 기존 테스트를 깨뜨리지 마라.
