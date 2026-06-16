# Step 3: context-menu-activation

`후속기사작성`(followUp)/`계속기사작성`(continue)/`재송`(resend) 3개 컨텍스트 메뉴 항목을 **활성화**하고 ListPage의 `onCtxSelect`에 결선한다. `번역`(translate)/`매핑`(mapping)은 비활성 유지한다. 이 step은 **뷰 결선(ContextMenu.jsx + ListPage.jsx)** 을 다룬다. 컨트롤러 콜백(step0의 `resendArticle`, step2의 `followUpArticle`/`continueArticle`)은 이미 존재한다 — 여기서는 메뉴 항목 enabled 조건과 case 결선만 한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/news.md` — line 85~88(메뉴 항목·현재 비활성), line 217(재송=DPS 재송고 → DPS+D/Z 대상), line 195(DPS는 D 권한 관련 규칙). 후속/계속은 권한·상태 제한 서술이 없다(일반 작성 진입).
- `/docs/ADR.md` — ADR-003(View는 onSelect로만 위임, transport 직접 호출 금지).
- `/web/src/view/ContextMenu.jsx` — **이 step에서 수정할 파일.** 핵심 구조:
  - `INACTIVE_ITEMS`(현재 translate/mapping/followUp/continue/resend 5개가 비활성) + `inactive(key)` 헬퍼.
  - `buildContextMenuItems(menu, article, identity)` — 메뉴별 항목 배열. 활성 조건 계산 변수들(`isDPS`, `role`, `canRevise`, `canDelete`, `canManage` 등). phase 1-history에서 `history`/`sendHistory`를 enabled:true로 전환한 패턴이 정확한 참고 모델이다(주석 line 1~9 참고).
- `/web/src/view/ContextMenu.test.jsx` — 항목 활성/비활성·onSelect 호출 테스트 패턴. 이 파일에 테스트를 추가한다.
- `/web/src/view/ListPage.jsx` — **이 step에서 수정할 파일.** `onCtxSelect(key, article)`의 `switch`(line 73~87)에 case를 추가한다. 컨트롤러 구조분해(line 56~62)에서 step0/step2가 추가한 콜백(`resendArticle`, `followUpArticle`, `continueArticle`)을 꺼내 결선한다.
- `/web/src/controller/useViewController.js` — **수정 금지(읽기만).** step0/step2가 이미 `resendArticle`/`followUpArticle`/`continueArticle`를 반환 객체에 노출했음을 확인하라. step0/step2 완료 summary(phases/2-followup-resend/index.json)에 정확한 콜백 이름이 있다.
- `/web/src/view/ListPage.test.jsx` — 우클릭→onCtxSelect 결선 테스트 패턴.

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

### (a) `ContextMenu.jsx` — 활성 조건

`INACTIVE_ITEMS`에서 `followUp`, `continue`, `resend` 3개를 제거하고, **`translate`, `mapping`만 비활성으로 남긴다**. 제거한 3개는 `buildContextMenuItems`에서 enabled 조건과 함께 정식 항목으로 구성한다. 항목의 **순서·label은 기존 그대로 유지**한다(translate, mapping, followUp, continue, 고침류…, resend 순서):

- `followUp`(`후속기사작성`)/`continue`(`계속기사작성`): **항상 활성**(enabled:true). 일반 신규 작성 진입이라 권한·상태 제한이 없다(news.md에 제한 서술 없음).
- `resend`(`재송`): **DPS 상태 + 권한 D/Z일 때만 활성.** 재송 = DPS 재송고(send 전이)이며 lifecycle상 DPS+send는 D/Z만 통과한다(R은 거부). 기존 `canManage`(D/Z) 또는 `canDelete`(isDPS && D/Z) 계산 패턴을 따라 `canResend = isDPS && (role === 'D' || role === 'Z')`로 둔다. DPS가 아니거나 R이면 비활성으로 표시한다.

`translate`/`mapping`은 `inactive('translate')`/`inactive('mapping')`로 그대로 둔다(다음 phase 소관).

주의: 후속/계속/재송 항목은 `deskUnsent`(데스크 미송고) 메뉴에는 원래 없다(그 메뉴 항목은 편집/상세보기/이력보기/본문복사/제목만복사뿐). `else` 분기(부서별 작성·송고·개인별 수정)에만 둔다 — 기존 배열 위치를 유지하라.

### (b) `ListPage.jsx` — onCtxSelect 결선

- 컨트롤러 구조분해에 `resendArticle`, `followUpArticle`, `continueArticle`를 추가한다.
- `onCtxSelect`의 switch에 case 추가:
  - `case 'followUp': followUpArticle(article); break;`
  - `case 'continue': continueArticle(article); break;`
  - `case 'resend': resendArticle(article); break;`
- `default`(비활성 항목은 onSelect로 오지 않음) 주석은 유지한다.

### 테스트

`ContextMenu.test.jsx`:
- DPS 기사 + D 권한 → `followUp`/`continue`/`resend` 모두 enabled, `translate`/`mapping`은 disabled.
- DPS 기사 + R 권한 → `resend`는 disabled, `followUp`/`continue`는 enabled.
- 비-DPS(RDS) 기사 + D 권한 → `resend` disabled, `followUp`/`continue` enabled.
- 활성 항목 클릭 시 `onSelect(key, article)`가 호출되는지(기존 클릭 테스트 패턴).
- (회귀) `deskUnsent` 메뉴에는 followUp/continue/resend 항목이 없는지.

`ListPage.test.jsx`:
- `onCtxSelect('followUp'/'continue'/'resend', article)` 분기가 각 컨트롤러 콜백을 호출하는지(콜백 스파이).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC를 실행한다. 기존 테스트 + step0~2 신규 테스트 + 이 step 신규 테스트가 모두 통과해야 한다(무회귀).
2. 체크리스트:
   - `INACTIVE_ITEMS`에 `translate`/`mapping`만 남았는가(followUp/continue/resend 제거)?
   - `resend`가 DPS+D/Z에서만 활성인가? 후속/계속은 항상 활성인가?
   - 항목 순서·label이 기존과 동일한가(UI 무회귀)?
   - ListPage가 컨트롤러 콜백에 위임만 하고 직접 transport를 호출하지 않는가(ADR-003)?
3. `phases/2-followup-resend/index.json`의 step 3을 업데이트(completed + summary: 활성화한 3항목·resend 활성 조건·남긴 비활성 2항목·결선한 case). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- `translate`/`mapping`을 활성화하지 마라. 이유: 다음 phase 소관(translate는 외부 provider 결정 필요, mapping은 정의 모호). 이 phase 범위 밖이다.
- `resend`를 비-DPS 또는 R 권한에서 활성화하지 마라. 이유: lifecycle상 DPS+send는 D/Z만 통과한다 — R에 활성으로 보이면 서버 거부를 유발하는 죽은 버튼이 된다.
- ListPage/ContextMenu에서 `model`/`fetch`를 직접 호출하지 마라. 이유: View는 onSelect로 컨트롤러에 위임만 한다(ADR-003). 비즈니스 로직 재구현 금지.
- 메뉴 항목 순서·label을 바꾸지 마라(enabled만 토글). 이유: phase 1-history에서 history/sendHistory를 활성화할 때와 동일하게, 순서/라벨 변경은 UI 회귀·테스트 단언 깨짐을 부른다.
- 컨트롤러(useViewController/useWriteController)를 수정하지 마라. 이유: 콜백은 step0/step2에서 완성됐다. 이 step은 뷰 결선 한 레이어만이다.
- 기존 테스트를 깨뜨리지 마라.
