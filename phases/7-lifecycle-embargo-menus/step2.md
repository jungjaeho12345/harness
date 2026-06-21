# Step 2: killarticles-menu-badges — KILL기사 조회 메뉴 + EPS/EEK/EEH 배지

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라(프로젝트 루트 기준):

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(view/controller는 직접 fetch 금지, model 경유), ADR-005(SSE 무효화)
- `/docs/news.md` — "# 기사 조회페이지": "메뉴가 5개 있는데 데스크 미송고(Default), 부서별 작성, 부서별 송고, 개인별 수정, KILL기사 메뉴가 있다." 및 상태 배지 규칙.
- `web/src/controller/useViewController.js` — `VIEW_MENUS`(11행: `['deskUnsent','deptWrite','deptSend','personal']`), `buildMenuFilter(menu, identity, departments)`(17~39행, switch case별 필터). 메뉴별 필터 규칙 주석(14~16행).
- `web/src/view/ListPage.jsx` — `MENU_LABELS`(18행 객체: deskUnsent/deptWrite/deptSend/personal 라벨), 메뉴 렌더(약 155행 `{MENU_LABELS[m]}`), `showDeptSelector`(약 142행 — 부서 셀렉터 노출 메뉴 집합).
- `web/src/view/statusBadge.js` — `STATUS_BADGES`(RDS 회색, DPS 레드, RRH/DDH 앰버 `#d97706`, RRK/DDK/DPD 슬레이트 `#374151`), `statusBadge(status)` 폴백.
- `web/src/view/statusBadge.test.js` 와 `web/src/controller/useViewController.test.jsx`(`buildMenuFilter` describe 블록 약 L21~39) — 기존 메뉴/배지 테스트 패턴. **web 테스트는 vitest(`describe`/`it`/`expect`) 러너로 작성한다 — `test/`의 `node:test`와 혼동하지 마라.**
- `web/src/view/ContextMenu.jsx` — 행 우클릭 메뉴(`buildContextMenuItems`)가 메뉴별로 노출 액션을 분기한다(`deskUnsent`/`else`). KILL기사 메뉴의 우클릭 정책 판단에 필요(아래 작업 5).
- `/docs/SCHEMA.md` — Contents.status enum 설명(신규 EPS/EEK/EEH 동기화 대상).
- **이전 step(1)에서 EPS/EEK/EEH 상태가 lifecycle에 추가됨** — 이 step은 그 상태들을 목록 UI에 노출한다.

## 배경 / 요구사항

조회 메뉴가 4개→**5개**로 늘었다(KILL기사 추가). 또한 신규 상태값 **EPS/EEK/EEH**의 배지가 없다. 이 step은 **web 목록 레이어**만 다룬다(서버/서비스 변경 없음).

## 작업

TDD로 진행한다(테스트 먼저).

### 1. KILL기사 메뉴 추가 (`web/src/controller/useViewController.js`)

- `VIEW_MENUS`에 `'killArticles'`를 추가한다(순서: 기존 4개 뒤).
- `buildMenuFilter`에 `case 'killArticles'` 추가 — KILL 계열 상태만 조회: **부서 키 없이 `status`만** 반환한다 → `{ status: ['RRK', 'DDK', 'EEK'] }` (기존 `personal` 케이스가 부서 키 없이 status만 반환하는 패턴과 동일). KILL기사는 부서 무관 전체 KILL 목록이다.
- 근거: KILL 결과 상태는 R의 RRK, D/Z의 DDK, EPS의 EEK다(news.md 생애주기).

### 2. 메뉴 라벨 (`web/src/view/ListPage.jsx`)

- `MENU_LABELS`에 `killArticles: 'KILL기사'` 추가. `VIEW_MENUS` 순회 렌더가 자동으로 5번째 탭을 그린다.
- `showDeptSelector`(부서 셀렉터 노출 집합)에 killArticles를 **넣지 마라**(KILL기사는 부서 무관 전체 목록). 단, 기존 deskUnsent/deptWrite/deptSend 동작은 보존.

### 3. 신규 상태 배지 (`web/src/view/statusBadge.js`)

- `STATUS_BADGES`에 추가:
  - `EEK`: KILL 계열이므로 **슬레이트 `#374151`/`#fff`**(RRK/DDK와 동일 족보).
  - `EEH`: 보류 계열이므로 **앰버 `#d97706`/`#fff`**(RRH/DDH와 동일 족보).
  - `EPS`: 신규(엠바고 송고 대기) — 다른 족보와 구분되는 **인디고 `#4f46e5`/`#fff`**. (이 색은 `news.md` 배지 규칙에 근거가 없는 합리적 도출색이다 — 아래 작업 4에서 문서에 함께 명문화한다.)
- 상단 주석의 색 족보 설명도 EPS/EEK/EEH를 포함하도록 갱신.

### 4. 문서 동기화 (`docs/SCHEMA.md`, `docs/news.md`)

- `docs/SCHEMA.md`: Contents.status enum/설명에 `EPS`, `EEK`, `EEH`를 추가한다(문서만 — DB 스키마 변경 아님).
- `docs/news.md`: 상태 배지 규칙 줄(약 L99)에 `EPS=인디고·EEK=슬레이트(KILL 족)·EEH=앰버(보류 족)`를 추가해 코드 배지와 문서를 정합시킨다.

### 5. KILL기사 우클릭 정책 (`web/src/view/ContextMenu.jsx`)

- KILL기사 메뉴 행도 `buildContextMenuItems`의 `else` 갈래로 떨어져, KILL 종료상태(RRK/DDK/EEK)에 부적절한 전이 액션(고침/포털고침/삭제요청/재송/후속/계속 등)이 노출될 수 있다. KILL기사 메뉴에서는 **읽기전용 항목(상세보기·이력보기 등)만** 노출하고 상태 전이 액션은 노출하지 마라(종료 상태이므로). `if (menu === 'killArticles')` 분기로 명시 처리한다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **ADR-003**: view/controller에서 직접 `fetch` 금지 — 메뉴 필터는 `buildMenuFilter`가 만들고 조회는 기존 `model.queryArticles` 경유. 새 네트워크 호출을 만들지 마라.
2. **회귀 금지**: 기존 4개 메뉴(deskUnsent/deptWrite/deptSend/personal)의 필터·라벨·부서 셀렉터 동작을 바꾸지 마라. 추가만 한다.
3. **서버 무변경**: 이 step은 web만 — `server/`·`src/`를 수정하지 마라(EPS/EEK/EEH 상태는 Step 1에서 이미 서버에 존재).
4. **배지 색 족보 일관성**: EEK=KILL(슬레이트), EEH=보류(앰버)를 기존 족보와 동일하게 둔다(임의 색 금지 — UI_GUIDE 토큰 일관성).
5. **기존 필터 불변(중요)**: `부서별 작성`(excludeStatus `['DPS','RRH']`)·`부서별 송고`·`개인별 수정` 필터를 **재정의하지 마라**. 신규 EPS/EEK/EEH가 기존 exclude 규칙에 따라 노출/제외되는 것은 의도된 동작으로 둔다(news.md가 별도 제외를 지시하지 않음). 특히 **EEH는 이번 버킷에서 전용 목록 메뉴가 없다**(KILL기사=RRK/DDK/EEK, 엠바고 관리=EPS) — 배지만 정의하고 목록 노출은 기존 부서 필터에 맡긴다. 이는 누락이 아니라 의도이며, 새 메뉴/필터를 임의로 만들지 마라.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (killArticles 필터·라벨·신규 배지 단언 포함)
npm run build       # vite build 성공
npm run lint        # ESLint 0
```

추가 단언:
- `buildMenuFilter('killArticles', ...)` → `{ status: ['RRK','DDK','EEK'] }`
- `VIEW_MENUS`에 `killArticles` 포함(길이 5), `MENU_LABELS.killArticles === 'KILL기사'`
- `statusBadge('EEK')`/`('EEH')`/`('EPS')`가 각각 슬레이트/앰버/인디고 색을 반환(폴백 아님)
- 기존 4개 메뉴 필터 단언 불변(회귀)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: controller/view 경계(ADR-003), 기존 메뉴 패턴 준수, 서버 무변경.
3. 결과에 따라 `phases/7-lifecycle-embargo-menus/index.json`의 step 2를 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "killArticles 메뉴(RRK·DDK·EEK)·라벨·EPS/EEK/EEH 배지·SCHEMA 동기화 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- 서버/서비스(`server/`, `src/`)를 수정하지 마라. 이유: 이 step은 목록 UI 노출만이며, 상태 전이는 Step 1에서 완료됐다.
- 기존 메뉴 4개의 동작/필터를 변경하지 마라. 이유: 회귀.
- 배지 색을 임의 값으로 넣지 마라(EEK/EEH는 기존 족보 색 재사용). 이유: UI 토큰 일관성.
- 엠바고 관리 메뉴(EPS 조회)는 이 step에서 만들지 마라. 이유: Step 3 범위(KILL기사와 분리).
- 기존 테스트를 깨뜨리지 마라.
