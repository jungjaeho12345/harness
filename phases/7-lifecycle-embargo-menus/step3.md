# Step 3: embargo-management-menu — 엠바고 관리 메뉴 (EPS 기사 조회/편집)

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라(프로젝트 루트 기준):

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(model 경유), ADR-004(잠금/인가는 서버 강제)
- `/docs/news.md` — "## 엠바고 규칙": "엠바고는 엠바고 관리 메뉴에서 기사를 편집할 수 있다.", "EPS된 기사는 엠바고 관리 메뉴에서 편집할 수 있다." 및 "기사 편집 기능"의 편집 진입 매핑(엠바고/2차 엠바고 시간 포함).
- `web/src/controller/useViewController.js` — **Step 2에서 `VIEW_MENUS`/`buildMenuFilter`/`killArticles`가 추가됨**. `enterEditor(article, mode)`(약 111행 — 잠금 획득 후 writer.do로 이동, `reviseArticle`/`editArticle` 등), 우클릭 액션들.
- `web/src/view/ListPage.jsx` — **Step 2에서 `MENU_LABELS.killArticles`/`showDeptSelector`가 갱신됨**. 행 우클릭 메뉴(편집/고침 등) 구성, 메뉴별 노출 액션.
- `web/src/view/ContextMenu.jsx`(또는 행 컨텍스트 메뉴 컴포넌트) — 메뉴별 사용 가능한 액션 분기.
- `web/src/controller/useWriteController.js` — 편집 진입 시 엠바고/2차 엠바고 시간 매핑(공통정보). EPS 기사 편집 시 1·2차 엠바고 시간이 입력란에 채워지는지 확인.
- 이전 step들의 산출물(EPS 상태, killArticles 메뉴)을 정독한 뒤 작업하라.

## 배경 / 범위 (중요)

새 스펙은 **엠바고 관리 메뉴**를 추가한다 — **EPS 기사**(엠바고 송고 대기)를 조회하고 **편집**(1·2차 엠바고 시간 포함)할 수 있다.

**scope = partial.** 이 step의 in-scope 경계:
- ✅ in: 엠바고 관리 메뉴(EPS 목록 조회) + 기존 편집 진입 재사용으로 EPS 기사 편집(엠바고 시간 편집).
- ❌ out: **실제 배부**(1차→언론사, 2차→비언론사 전송)와 배부 스케줄러/타이밍. 이는 배부 시스템(out-of-scope, CLAUDE.md)이다. 이 step에서 구현하지 마라.

이 step은 **web 목록 레이어**만 다룬다(서버/서비스 변경 없음).

## 작업

TDD로 진행한다(테스트 먼저).

### 1. 엠바고 관리 메뉴 (`web/src/controller/useViewController.js`)

- `VIEW_MENUS`에 `'embargoMgmt'`를 추가한다(killArticles 뒤 또는 적절한 위치).
- `buildMenuFilter`에 `case 'embargoMgmt'` → `{ status: ['EPS'] }` 추가. (부서 셀렉터 적용 여부는 ListPage 규칙과 일관되게 — 엠바고 관리는 부서 무관 전체 EPS 목록으로 두라.)

### 2. 메뉴 라벨 (`web/src/view/ListPage.jsx`)

- `MENU_LABELS`에 `embargoMgmt: '엠바고 관리'` 추가.
- `showDeptSelector`에 embargoMgmt를 넣지 마라(부서 무관).
- (참고) `docs/news.md` L78 조회 메뉴 목록은 이미 6개(…KILL기사, 엠바고 관리)로 정합돼 있다 — news.md를 추가로 고치지 마라.

### 3. 우클릭 편집 진입 노출 (`web/src/view/ContextMenu.jsx`) — **필수**

- 현재 `buildContextMenuItems`는 `menu==='deskUnsent'`와 `else` 두 갈래뿐이라, `embargoMgmt`는 `else`로 떨어져 **edit 항목이 노출되지 않는다**(그 갈래의 고침/포털고침은 `canRevise = isDPS && role==='D'`라 EPS에선 항상 비활성). 따라서 메뉴/필터만 추가해서는 EPS 행에서 편집을 시작할 수 없다.
- `if (menu === 'embargoMgmt')` 분기를 추가해, **기존 edit 항목(=`editArticle` → `enterEditor(article,'edit')` → navigate 경로)을 재사용**해 push하라(`deptSend`가 `items.push(edit)` 하는 패턴과 동일 — 신규 편집 흐름을 만들지 마라). EPS 컨텍스트에 부적절한 전이 액션(고침/포털고침/삭제요청/재송/후속/계속 등)은 이 분기에 노출하지 마라.

### 4. 편집 모드 고정 — `edit` (mapping/revise 금지)

- EPS 편집은 반드시 `editArticle`(= `enterEditor(article, 'edit')`)로 진입하라. 이유:
  - `reviseArticle`(mode `revise`/`portalRevise`)는 **DPS 포털 고침** 전용이라 EPS(isDPS=false) 전체 편집에 부적절하다.
  - `mapping` 모드는 `web/src/controller/useWriteController.js`(약 L258)에서 `embargoAt`/`secondEmbargoAt`를 **거부**하므로, mapping으로 진입하면 1·2차 엠바고 시간 편집이 막혀 AC를 위배한다.
- `edit` 모드 진입 시 기존 공통정보 매핑으로 1·2차 엠바고 시간이 입력란에 채워지고 수정·저장 가능해야 한다(기존 매핑 재사용).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **ADR-003**: 새 fetch 금지 — `buildMenuFilter` + 기존 `model.queryArticles`/편집 진입 경로 재사용.
2. **회귀 금지**: 기존 메뉴(4개 + Step 2의 killArticles)의 필터/라벨/동작 불변. 추가만.
3. **편집 진입 재사용 + 모드 고정**: EPS 편집을 위한 별도 잠금/저장 경로를 새로 만들지 마라 — `enterEditor`(잠금 획득 → sessionStorage → navigate)를 그대로 쓰되 **반드시 `edit` 모드**(`editArticle`)로 진입한다. `revise`/`portalRevise`(DPS 고침)와 `mapping`(엠바고 시간 거부, useWriteController L258)은 쓰지 마라. 인가/잠금은 서버가 강제(ADR-004).
4. **배부 금지**: 1·2차 배부 실행/스케줄링을 구현하지 마라. 이유: out-of-scope 배부 시스템.
5. **백엔드 무변경**: `server/` 와 백엔드 `src/`(서비스/모델/컨트롤러)는 수정 금지. 이 step의 수정 범위는 **프론트(`web/src/` — useViewController·ListPage·ContextMenu)와 문서**뿐이다(상태/전이는 Step 1에서 완료).

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (embargoMgmt 필터·라벨·편집 진입 단언 포함)
npm run build       # vite build 성공
npm run lint        # ESLint 0
```

추가 단언:
- `buildMenuFilter('embargoMgmt', ...)` → `{ status: ['EPS'] }`
- `VIEW_MENUS`에 `embargoMgmt` 포함, `MENU_LABELS.embargoMgmt === '엠바고 관리'`
- `buildContextMenuItems(... menu='embargoMgmt' ...)`가 **edit 항목을 노출**하고, EPS 컨텍스트에 부적절한 전이 액션(고침/포털고침/삭제요청/재송)은 노출하지 않음을 단언
- 엠바고 관리 메뉴의 EPS 행에서 편집이 `editArticle`(=`enterEditor(article,'edit')`) 경로를 호출(잠금 획득 → navigate)함을 검증
- 기존 메뉴 필터/동작 단언 불변(회귀)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: controller/view 경계(ADR-003), 편집 진입 재사용, 서버 무변경, 배부 미구현(범위 준수).
3. 결과에 따라 `phases/7-lifecycle-embargo-menus/index.json`의 step 3을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "embargoMgmt 메뉴(EPS)·라벨·편집 진입 재사용 요약 (배부 미구현)"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- 엠바고 **배부**(언론사/비언론사 전송, 배부 타이밍/스케줄러)를 구현하지 마라. 이유: out-of-scope 배부 시스템(CLAUDE.md). 이 step은 EPS 조회/편집까지만.
- 백엔드(`server/`, 백엔드 `src/` 서비스/모델/컨트롤러)를 수정하지 마라. 이유: 상태/전이는 Step 1에서 완료. (프론트 `web/src/`의 ContextMenu.jsx 등은 이 step의 정상 수정 대상이다.)
- EPS 편집을 `mapping` 또는 `revise`/`portalRevise` 모드로 진입시키지 마라. 이유: mapping은 엠바고 시간 입력을 거부하고(useWriteController L258), revise는 DPS 고침 전용이라 EPS 전체 편집에 부적절하다. 반드시 `edit` 모드.
- EPS 편집용 별도 잠금/저장 경로를 새로 만들지 마라. 이유: 기존 `enterEditor`/PUT 저장/잠금 게이트 재사용으로 충분하며 중복은 회귀·불일치를 부른다.
- 기존 메뉴 동작을 변경하지 마라.
- 기존 테스트를 깨뜨리지 마라.
