# Step 5: dept-list-query-ui

기사 조회페이지의 **부서 선택 UI**를 명세(news.md 78~92행)에 맞춰 완성하고, 목록에 **부서·송고시간 컬럼**을 노출하며, **데스크 미송고 편집 권한**을 데스크/관리자로 좁힌다. 인라인 체크박스를 **'전체' 토글이 있는 체크박스 멀티셀렉트 Select 드롭다운**으로 바꾸고, 명시적 **'조회' 버튼**을 둔다. **이 step은 뷰/컨트롤러 필터·목록 표시·메뉴 활성 조건만 다룬다(백엔드/스키마 무변경, transport는 Model 뒤에만 — ADR-003).**

## 읽어야 할 파일

먼저 아래를 읽고 부서 선택 → 필터 → 조회 흐름과 컬럼 설정 구조를 파악하라:

- `/docs/news.md` — 79~83행(부서별 작성·송고 페이지: Select 메뉴 + 조회 버튼, '전체' 토글 체크박스 멀티셀렉트 드롭다운), 81행(조회 버튼), 88~89행(부서별 송고 우클릭에 편집 항목 추가), 90~92행(데스크 미송고는 RDS/DDH만, 컬럼 8종).
- `/docs/ADR.md` — ADR-003(주입형 Model 계약, transport는 httpModel 뒤에만), ADR-004(role은 서버 세션에서만 도출 — 메뉴 활성은 표시용 UX, 인가는 서버 강제), ADR-006(controllers→services→models 계층).
- `/docs/ARCHITECTURE.md` — 디렉토리 구조·데이터 흐름·DB 비파괴 원칙.
- `/web/src/controller/useViewController.js` — **이 step에서 수정.** `buildMenuFilter(menu, identity, departments)` 메뉴별 필터(deskUnsent=RDS·DDH / deptWrite=DPS·RRH 제외 / deptSend=DPS만 / personal=작성자+RDS·RRK), `departments` 상태(기본값), `refresh`(재조회), `enterEditor` 결선.
- `/web/src/view/ListPage.jsx` — **이 step에서 수정.** `DeptSelector` 컴포넌트, `showDeptSelector` 조건, `renderCell`(시간 컬럼 분기), `refresh` 결선.
- `/web/src/view/columnConfig.js` — **이 step에서 수정.** `COLUMNS` 공통 컬럼 정의(메뉴별 토글·localStorage 지속).
- `/web/src/view/listFormat.js` — **이 step에서 수정.** `formatCell(key, value)`의 시간 컬럼 'YYYY-MM-DD HH:mm' 포맷 분기.
- `/web/src/view/ContextMenu.jsx` — **이 step에서 수정.** `buildContextMenuItems(menu, article, identity)`의 deskUnsent 분기 `edit` 항목 활성 조건.
- `/web/src/styles/yonhap.css` — 부서 Select 드롭다운 스타일(`.yh-dept-selector`·`.yh-dept-select__trigger`·`__panel`·`__option`)과 조회 바 정렬(`.yh-dept-bar`).
- `/scripts/seed-articles.js` — 데모 시드 러너(직접 실행 전용). 비파괴·멱등 INSERT 원칙 참고.
- 테스트: `/web/src/controller/useViewController.test.jsx`, `/web/src/view/ListPage.test.jsx`, `/web/src/view/columnConfig.test.js`, `/web/src/view/listFormat.test.js`, `/web/src/view/ContextMenu.test.jsx`.

이전 step에서 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성/갱신**한 뒤 통과하는 구현을 작성한다.

핵심 결정(반드시 따른다):
- 부서 멀티선택의 **선택 계약은 배열이며 `[]`(빈 선택) = '전체'(부서 미지정)** 다. 이 계약은 UI를 인라인 체크박스→Select 드롭다운으로 바꿔도 **불변**(컨트롤러/조회 로직 무영향).
- 부서 선택은 **데스크 미송고·부서별 작성·부서별 송고 3개 메뉴 공통**으로 노출하고, **세 메뉴 기본값을 '전체'로 통일**한다(부서별 작성 기본값을 기존 '내 부서'에서 '전체'로 변경).
- 데스크 미송고 우클릭 **편집은 데스크(D)·관리자(Z)만 활성**, 기자(R)·권한 미정의는 항목을 노출하되 비활성(disabled). **실제 인가는 서버 잠금/applyAction 게이트가 최종 강제**한다(ADR-004 — 메뉴 활성은 표시용 UX일 뿐).

구현(시그니처는 재량, 실제 변경 기준):
- **부서 필터 확장** — `useViewController.js` `buildMenuFilter`: `const depts = (departments && departments.length) ? departments : null`로 정규화하고, `deskUnsent`(status RDS·DDH)·`deptWrite`(excludeStatus DPS·RRH)·`deptSend`(status DPS)에서 `depts`가 있으면 `f.departments = depts`를 단다. `departments` 초기 상태 주석을 `null/[] = '전체'(부서 미지정) — 3개 메뉴 공통 기본값`으로 통일. `personal`은 무변경.
- **Select 드롭다운** — `ListPage.jsx` `DeptSelector({ options, selected, onChange })`: `useState(open)`·`useRef`로 트리거 버튼 + 팝오버 패널을 구성. 트리거는 현재 선택 요약(`isAll`→'전체' / 1개→부서명 / 그 외→`${n}개 부서`)을 표시. 패널 안 '전체' 체크박스는 select-all(`onChange([])`), 개별 부서는 토글. `isAll`은 `sel.length === 0 || (options.length>0 && options.every(d=>sel.includes(d)))`로 빈 선택/전부 선택을 똑같이 '전체'로 본다. **바깥 클릭(mousedown)** 시 패널을 닫는 `useEffect`를 패널 열림에만 단다. `showDeptSelector`에 `deskUnsent`를 추가하고, `DeptSelector`에서 `menu` prop을 제거(공통화). `menu === 'deptSend' ? [] : null` 분기를 일괄 `onChange([])`로 단순화.
- **접근성** — 패널은 체크박스 묶음이므로 `role="listbox"`(option 자식 기대)가 아니라 `role="group"`으로 두고, 트리거 `aria-haspopup`은 `"listbox"`→`"true"`로 시맨틱을 일치시킨다. `aria-expanded`는 `open`을 반영.
- **조회 버튼** — `ListPage.jsx`: 컨트롤러 구조분해에 `refresh`를 추가하고, `DeptSelector`를 `.yh-dept-bar` 컨테이너로 감싸 옆에 `<button type="button" className="yh-btn yh-btn--primary" onClick={() => refresh()}>조회</button>`를 둔다(news.md 81행). 진입/부서 변경 시 자동조회는 컨트롤러가 유지.
- **목록 컬럼** — `columnConfig.js` `COLUMNS`에 `department`(부서)·`departmentCode`(부서코드)와 `sentAt`(송고시간)을 additive로 추가(메뉴별 토글 가능). `listFormat.js` `formatCell`의 시간 포맷 분기에 `sentAt`을 추가(createdAt·editedAt과 동일한 'YYYY-MM-DD HH:mm'). `ListPage.jsx` `renderCell`의 `yh-col--time` 분기에도 `sentAt` 추가. 데이터는 Contents.sentAt(송고 시 stamp) — **백엔드/스키마 무변경**.
- **데스크 미송고 편집 권한** — `ContextMenu.jsx` `buildContextMenuItems`: `const canDeskEdit = role === 'D' || role === 'Z'`를 도출하고, deskUnsent 분기의 `edit` 항목을 `{ ...edit, enabled: canDeskEdit }`로 바꾼다(항목은 노출, R·미정의는 disabled).
- **데모 시드(직접 실행 전용)** — `scripts/seed-articles.js` 신설: 송고(DPS) 30건 + 데스크 미송고(RDS/DDH) 20건을 부서별 메타(작성자/수정자/송고자/부서/작성·편집·송고시간)와 함께 랜덤 생성. `createSchema`는 additive 멱등, 기존 행 삭제/수정 없이 새 articleId로 INSERT만, 부서별 기자 계정은 없는 것만 멱등 insert. **비파괴 원칙 준수**.
- **정렬/스타일** — `yonhap.css`: Select 트리거·패널·옵션 스타일과, `.yh-dept-bar` 스코프로 조회 버튼 세로 패딩을 셀렉트 트리거 높이에 맞추고(`var(--yh-sp-sm)`) 셀렉터 `margin-bottom: 0`으로 가운데 정렬을 맞춘다.

테스트:
- `useViewController.test.jsx`: deskUnsent가 RDS·DDH·기본 '전체'·부서 선택 시 departments 반영 / deptWrite가 DPS·RRH 제외·기본 '전체'(내 부서 아님)·명시 선택 반영.
- `ListPage.test.jsx`: 데스크 미송고에서 부서 Select(기본 전체) 노출·열면 체크박스 표시 / 부서 선택 시 departments로 재조회 / '전체' select-all / '조회' 버튼 재조회 / 바깥 클릭 시 패널 닫힘 / 부분 선택 시 트리거 요약(부서명·N개 부서).
- `columnConfig.test.js`: 공통 컬럼에 department·departmentCode·sentAt 포함(순서 단언 갱신). `listFormat.test.js`: `formatCell('sentAt', ...)` 포맷 단언 추가.
- `ContextMenu.test.jsx`: 데스크 미송고 편집이 D/Z만 활성(R 비활성)인지.
- 기존 web 테스트 무회귀.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다(기존 web 테스트 + 신규/갱신 테스트 전부 통과·무회귀).
2. 아키텍처 체크리스트:
   - 부서 선택 계약(`[]` = '전체')이 UI 변경(인라인→Select)과 무관하게 불변인가? `buildMenuFilter`가 3개 메뉴에서 departments를 일관 처리하는가?
   - '조회' 버튼이 컨트롤러 `refresh`만 호출하는가(뷰에서 직접 fetch 없음, ADR-003)?
   - 데스크 미송고 편집 활성은 표시용 UX이고, 실제 인가는 서버 lock/applyAction이 강제하는가(ADR-004)? 클라가 role을 서버로 보내지 않는가?
   - 컬럼/시간 포맷 추가가 additive이고 백엔드/스키마 무변경인가? `seed-articles.js`가 비파괴·멱등(INSERT만)인가(CLAUDE.md CRITICAL·ADR-002)?
   - 패널 접근성(`role="group"`·`aria-haspopup="true"`·`aria-expanded`)이 시맨틱과 일치하는가?
3. 결과에 따라 `phases/4-mvp-polish/index.json`의 step 5를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 중단

## 금지사항

- 부서 선택 계약(`onChange` 배열, `[]` = '전체')을 바꾸지 마라. 이유: UI를 Select로 교체하더라도 컨트롤러/`buildMenuFilter`/조회 로직이 이 계약에 의존한다 — 계약을 바꾸면 3개 메뉴의 조회가 모두 회귀한다.
- 데스크 미송고 편집 활성/비활성을 **인가의 최종 근거로 삼지 마라.** 이유: ADR-004 — 메뉴 활성은 표시용 UX일 뿐 실제 인가는 서버 잠금/applyAction 게이트가 강제한다. 클라가 role을 서버로 보내서도 안 된다.
- 뷰/컨트롤러에서 직접 `fetch`/`EventSource`를 호출하지 마라. 이유: ADR-003 — 모든 transport는 `httpModel` 뒤에만. '조회' 버튼은 컨트롤러 `refresh`만 호출한다.
- 백엔드/스키마(`src/`, `server/`, `schema.js`)를 수정하지 마라. 이유: sentAt·부서 컬럼은 기존 데이터(Contents.sentAt 등)를 표시만 하는 것이며, 이 step은 뷰/컨트롤러 표시·필터·메뉴 활성 조건만 다룬다.
- DB 행을 삭제/덮어쓰지 마라. 이유: CLAUDE.md CRITICAL·ADR-002 비파괴 원칙. `seed-articles.js`는 새 articleId로 INSERT만, 기자 계정은 없는 것만 멱등 insert여야 한다.
- 기존 테스트/기능을 깨뜨리지 마라.
