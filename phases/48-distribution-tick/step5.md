# Step 5: web-des

프론트엔드에 **DES 상태를 노출**한다. 두 곳뿐이다: 상태 배지 토큰(View)과 엠바고 관리 메뉴의 조회 필터(Controller).
백엔드는 이 step에서 건드리지 않는다.

## 배경

- 사용자 확정 스펙 A.4: **엠바고 관리 메뉴(embargoMgmt)의 조회·편집 대상에 DES를 포함**한다(`status: ['EPS']` → `['DES','EPS']`).
  `statusBadge`에도 DES를 추가한다(색은 EPS 계열과 조화되게 — 선택은 재량).
- `docs/news.md:105`: "상태값 배지 색은 RDS는 회색, DPS는 레드, 보류(RRH/DDH/EEH)는 앰버, KILL(RRK/DDK/EEK)은 슬레이트, EPS(엠바고 송고 대기)는 인디고로 구분한다."
  → DES는 EPS와 같은 엠바고 족보이므로 **인디고 계열의 밝은 톤**으로 둔다(예: `#6366f1`, fg `#fff`). 회색 폴백(`#e8e8e8`)으로 떨어지면 안 된다.
- 상태 배열 필터는 이미 3면 계약(`contract`→`httpModel`→서버 `pickFilters`)이 배열을 지원한다
  (`web/src/model/httpModel.js:61-67`이 같은 키를 반복 append, `server/index.js:128-138`의 `FILTER_KEYS`에 `status` 포함, `src/models/articleModel.js:92-99`가 `IN` 처리).
  **Model 계약(contract.js/fakeModel/httpModel)은 변경할 필요가 없다** — 값만 바뀐다.

## 읽어야 할 파일

- `docs/news.md` — "엠바고 규칙" 절(엠바고 관리 메뉴), 105행(배지 색 규칙), "기사 생애주기" 절의 `RDS->DES->EPS` 행.
- `docs/UI_GUIDE.md` — "상태 배지 (기사 생애주기)" 표(44-50행)와 색 토큰 원칙("보라/인디고 브랜드 색상"은 브랜드 색으로 쓰지 않는다는 항목은 **크롬/브랜드** 이야기이며, 상태 배지의 EPS 인디고는 news.md가 정한 예외다 — 그대로 따른다).
- `web/src/view/statusBadge.js` — 전체(24행). `STATUS_BADGES`(5-16행), 폴백(18행).
- `web/src/view/statusBadge.test.js` — 19-25행(EEK/EEH/EPS 토큰 단언).
- `web/src/controller/useViewController.js` — 11-15행(메뉴 목록·D/Z 전용), 25-63행(`buildMenuFilter` — 27행 주석, 38-43행 `embargoMgmt` 분기).
- `web/src/controller/useViewController.test.jsx` — 44-47행(`embargoMgmt` 필터 단언).
- `web/src/view/ListPage.test.jsx` — 55-61행(엠바고 관리 탭이 조회하는 필터), 90-102행(EPS 행 우클릭 편집 진입).
- `web/src/view/ContextMenu.jsx` — 49-57행(embargoMgmt 분기는 **메뉴 기준**이라 상태 분기가 없다 — 코드 변경은 불필요, 주석만 현행화).
- `web/src/view/ContextMenu.test.jsx` — 176-190행(embargoMgmt 메뉴 항목 단언).
- `phases/48-distribution-tick/step1.md`, `step2.md` — DES의 의미(배부 전 대기)와 전이 계약.

## 작업

**TDD: 테스트를 먼저 고쳐 red를 확인한 뒤 구현한다.**

### 1) `web/src/view/statusBadge.js`

- `STATUS_BADGES`에 `DES` 항목 추가(EPS 인디고 계열, 라벨 `'DES'`).
- 파일 상단 주석에 근거를 남긴다: DES=엠바고 배부 전 대기 / EPS=배부 진행(첫 배부 후) — news.md `RDS->DES->EPS`.
- 기존 10개 토큰의 값은 **한 글자도 바꾸지 않는다**(디자인 토큰 고정 — UI_GUIDE).

### 2) `web/src/view/statusBadge.test.js`

- `DES`가 지정 토큰을 반환하고 **회색 폴백이 아님**을 단언(기존 EPS 케이스 23-25행과 동형).
- 기존 EPS/EEK/EEH 단언은 유지한다.

### 3) `web/src/controller/useViewController.js`

- `buildMenuFilter`의 `embargoMgmt` 분기: `{ status: ['DES','EPS'] }`.
  **순서는 `['DES','EPS']` 로 고정**한다(테스트 단언 안정성 — 서버는 `IN`이라 순서와 무관하다).
- 25-27행 주석의 "엠바고 관리: EPS"를 "엠바고 관리: DES·EPS(배부 전 대기 + 배부 진행)"로 갱신.
- **33행 주석도 함께 갱신**: 현재 "KILL 결과 상태: R의 RRK, D/Z의 DDK, **EPS의 EEK**" → "…, **DES·EPS의 EEK**".
  이유: DES도 KILL하면 EEK다(step1 전이표 `DES: { kill:'EEK', hold:'EEH' }`). 25-27행만 고치면 같은 파일 안에서 표기가 갈라진다.
- `killArticles` 필터(`['RRK','DDK','EEK']`) **값 자체는 그대로 둔다** — DES 기사의 KILL 결과도 `EEK`이므로 추가할 상태가 없다(주석만 갱신).

### 4) `web/src/controller/useViewController.test.jsx` (44-47행)

- `expect(buildMenuFilter('embargoMgmt', me, null)).toEqual({ status: ['DES','EPS'] })`로 갱신, 부서 조합 케이스도 동일 갱신.

### 5) `web/src/view/ListPage.test.jsx` (55-61행, 90-102행)

- 61행 기대 필터를 `{ status: ['DES','EPS'] }`로 갱신.
- 90-102행의 우클릭 편집 진입 케이스는 **DES 행으로도 통과**해야 한다 — 기존 EPS 케이스는 유지하고 DES 행 케이스를 추가하거나 파라미터화한다.

### 6) `web/src/view/ContextMenu.jsx` / `ContextMenu.test.jsx`

- `ContextMenu.jsx`는 **코드 변경 없음**(embargoMgmt 분기는 메뉴 기준). 53-55행 주석의 "EPS 기사를 조회하고"를 "DES·EPS 기사를 조회하고"로만 갱신.
- `ContextMenu.test.jsx:176-190`에 `{ status: 'DES' }` 케이스를 추가해 같은 항목 집합(편집 노출 / 고침·삭제요청·재송 미노출)이 유지됨을 잠근다.

## Acceptance Criteria

```bash
npm run test:web
npm run build
npm run lint
```

- `npm run test:web` **전부 통과, 실패 0**. 기준선은 **86 files / 1927 tests 전부 pass**이며, 통과 수는 신규 케이스만큼 **증가**해야 한다(감소하면 회귀).
- `npm run build` clean, `npm run lint` clean.
- 백엔드 무접촉이므로 `npm test`는 이 step의 필수 AC가 아니다. 다만 실행 시 기준선(**총 527 / pass 523 / fail 4**, 아래 기존 실패 4건 — Windows 경로 구분자 단언)이 그대로여야 한다:
  1. `createControllers: DIST_SPOOL_DIR 설정 시 송고가 활성 수신처 스풀에 배부된다`
  2. `레거시 행의 잘못된 spoolDir는 실제 writer가 거부해 failed로 격리된다(경로 조작 방어)`
  3. `spoolWriter: 수신처 폴더를 recursive mkdir 후 임시 파일에 쓰고 rename으로 게시한다`
  4. `spoolWriter: 파일명은 <articleId>_<timestamp>.json 이며 재배부해도 덮어쓰지 않는다`
  (step0-4에서 추가된 테스트만큼 총계·pass가 늘어난 상태가 정상이다.)

## 검증 절차

1. 테스트 먼저 수정/추가 → `npm run test:web` red 확인.
2. 구현 → green.
3. `npx vitest run --root web src/view/statusBadge.test.js src/controller/useViewController.test.jsx src/view/ListPage.test.jsx src/view/ContextMenu.test.jsx`로 대상 4파일 집중 확인.
4. `git diff --stat`이 `web/src/**`의 소스 2개(+주석 1개)와 테스트 4개로 한정되는지 확인 — `web/dist/**`(빌드 산출물)이 커밋에 섞이지 않았는지 반드시 확인한다.
5. 회귀 확인: 다른 5개 메뉴(`deskUnsent`·`deptWrite`·`deptSend`·`personal`·`killArticles`)의 필터 단언이 그대로 통과하는지 본다.

## 금지사항

- 기존 상태 배지 색 값을 바꾸지 마라. 이유: UI_GUIDE/news.md가 고정한 디자인 토큰이며, 색 변경은 스펙 위반이다.
- `killArticles` 필터에 DES를 넣지 마라. 이유: DES는 KILL 결과 상태가 아니다(KILL하면 EEK가 된다).
- `embargoMgmt` 필터에서 `EPS`를 빼지 마라. 이유: 레거시 EPS 행이 목록에서 사라져 편집·KILL·보류가 불가능해진다(마이그레이션 없음 — 사용자 확정 스펙 A.5).
- 프론트에서 상태 전이를 판단하거나 tick을 호출하는 UI를 추가하지 마라. 이유: tick은 Z/시스템 전용 운영 엔드포인트이며 이번 phase의 UI 범위가 아니다(ADR-008 (3)).
- `web/dist/**`(빌드 산출물)을 수정하지 마라. 이유: 생성물이며 소스가 단일 출처다.
- 백엔드 파일(`src/**`, `server/**`)을 이 step에서 수정하지 마라. 이유: 프론트 노출만 남은 단계이며, 레이어를 섞으면 검토 게이트가 무력화된다.
