# Step 3: dist-mgmt-ui

## 목표

배부 대상 관리 화면 **`distMgmt.do`(Z 전용)** 를 만든다: 목록 조회 / 등록 / 수정 / 비활성.
프론트 MVC의 **View + Controller + 라우팅 등록**만 다룬다 — 백엔드(`src/**`, `server/**`)와 Model 계약 3면(step2)은 무접촉.

배경(자기완결):
- step2에서 Model 계약에 4개 메서드가 추가됐다:
  `queryDistributionTargets(filters)` → `{ ok, items }` /
  `createDistributionTarget(entry)` → `{ ok, id }` /
  `updateDistributionTarget(id, fields)` → `{ ok, changes }` /
  `deactivateDistributionTarget(id)` → `{ ok, changes }`.
  item shape: `{ id, name, kind: 'press'|'nonpress', spoolDir, active: 'Y'|'N', createdAt, updatedAt }`.
- **비활성은 soft delete**다(ADR-008·DB 비파괴): 비활성 행은 목록에서 사라지지 않고 `active='N'`으로 남으며,
  수정 폼에서 `active='Y'`로 되돌려 재활성화할 수 있다.
- `spoolDir`는 배부 스풀 하위 폴더명 문자열이다. **이 화면은 문자열을 입력받아 저장할 뿐** — 폴더를 만들거나 파일을 올리지 않는다(스풀 쓰기는 phase 47).
- 프론트 라우트 가드는 UX일 뿐이고 **실제 인가는 서버 Z 게이트**가 강제한다(ADR-004). 그 사실을 코드 주석에 남긴다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 반드시 심볼명으로 재확인하라.

- `docs/ADR.md` — ADR-003(Model 계약)·ADR-004(신뢰 경계)·ADR-008(배부 아키텍처).
- `docs/UI_GUIDE.md` — 색상/컴포넌트 토큰(`.yh-page`·`.yh-card`·`.yh-field`·`.yh-table`·`.yh-btn`·`.yh-btn--primary`)과 **AI 슬롭 안티패턴 금지 표**.
- `docs/news.md` — 디자인/페이지 관례(`.do` 라우트).
- **step2 산출물**(이번 step의 입력): `web/src/model/contract.js`(추가된 4개 키), `web/src/model/httpModel.js`(배부 대상 블록),
  `web/src/test/fakeModel.js`(`distributionTargets` seed + 4메서드 — 테스트에서 seed로 주입한다).
- `web/src/controller/useRcvMgmtController.js` — **전체**(30줄). `useAppContext()`에서 model을 받아 `refresh`/`create`/`delete`를 `useCallback`으로 감싸는 구조 **청사진**.
- `web/src/controller/useUserMgmtController.js` — **전체**(33줄). `update` 계열 컨트롤러의 present-only 패치 정리 패턴.
- `web/src/view/RcvMgmtPage.jsx` — **전체**(113줄). Z 전용 관리 페이지의 폼+표 레이아웃·클래스 사용·`data-testid` 관례.
- `web/src/view/UserMgmtPage.jsx` — **전체**(118줄). **등록/수정 토글 폼**(`editing` state, `startEdit`, 제출 분기, 취소 버튼) — 이번 폼의 청사진.
- `web/src/app/routing.js` — **전체**(64줄). `ROUTES`(L7)·`Z_ONLY_ROUTES`(L8)·`resolveRoute`(L27~33).
- `web/src/app/App.jsx` — **전체**(69줄). import 목록(L9~15)·`RouteView` 분기(L18~32).
- `web/src/view/TopBar.jsx` — **전체**(45줄). `isZ` 전용 nav 버튼 블록(L27~33).
- `web/src/app/App.test.jsx` — Z 전용 라우트 가드 테스트(L54~75)와 `modelReturning`(L7~9) 하네스.
- `web/src/app/routing.test.js` — `resolveRoute` 가드 테스트(L23~46, `Z_ONLY_ROUTES`를 순회하므로 새 라우트가 자동 포함된다).
- `web/src/controller/useRcvMgmtController.test.jsx` — **전체**(41줄). 훅 테스트 하네스(`renderHook` + `AppContext.Provider` + `createFakeModel` seed + `vi.spyOn`).
- `web/src/view/UserMgmtPage.test.jsx` / `RcvMgmtPage.test.jsx` — 페이지 테스트 스타일(렌더 → 입력 → submit → 표 검증).
- `web/src/controller/useViewController.js` L11~23 — `VIEW_MENUS`/`DZ_ONLY_MENUS`/`visibleMenus`. **읽기만 — 수정 금지**(아래 금지사항 참조).

## 작업

### 1) 테스트 먼저 (TDD — red 확인 후 구현)

**a. `web/src/controller/useDistMgmtController.test.jsx` 신규**(`useRcvMgmtController.test.jsx` 하네스 차용, identity `{ role: 'Z' }`):

- `refresh`가 `distributionTargets` seed를 로드해 `targets`에 담는다.
- `createTarget(entry)`가 `model.createDistributionTarget`을 그 payload로 호출하고 **자동 refresh** 후 목록에 나타난다.
- `updateTarget(id, fields)`가 `model.updateDistributionTarget(id, fields)`를 호출하고 refresh 후 값이 반영된다.
- `deactivateTarget(id)`가 `model.deactivateDistributionTarget(id)`를 호출하고 refresh 후 **항목이 사라지지 않고** `active === 'N'`이 된다.
- 실패 응답(`{ ok: false, reason: 'invalid-spool-dir' }`)을 그대로 반환한다(컨트롤러가 삼키지 않는다).

**b. `web/src/view/DistMgmtPage.test.jsx` 신규**(`UserMgmtPage.test.jsx` 스타일):

- 마운트 시 목록이 그려진다(seed 2건 — `active:'Y'` 1건, `active:'N'` 1건이 **둘 다** 표시된다).
- 유형 표시가 한글 라벨이다: `press` → `언론사`, `nonpress` → `비언론사`.
- 등록: 이름/유형/스풀폴더 입력 → 제출 → `createDistributionTarget`이 `{ name, kind, spoolDir, active }`로 호출되고 폼이 초기화된다.
- 수정: 행의 `수정` 버튼 → 폼에 값이 채워지고 버튼 라벨이 `수정`으로 바뀐다 → 제출 시 `updateDistributionTarget(id, fields)` 호출(`id`는 body에 싣지 않는다).
- 취소 버튼이 편집 모드를 벗어나 폼을 초기화한다.
- 비활성: `비활성` 버튼 → `deactivateDistributionTarget(id)` 호출 → 그 행이 **목록에 남고** 활성 열이 `N`이 된다.
- 이미 `active==='N'`인 행에는 `비활성` 버튼이 없다(또는 disabled) — 재활성화는 `수정` 폼의 활성 select로 한다.
- **삭제 버튼이 존재하지 않는다**: `screen.queryByRole('button', { name: '삭제' })`가 `null`(회귀 가드).

**c. `web/src/app/routing.test.js` 갱신**: `ROUTES`에 `'distMgmt.do'`가 있고 `parseLocation({ pathname: '/distMgmt.do' }).route === 'distMgmt.do'`,
`Z_ONLY_ROUTES`에 포함된다는 단언을 추가한다(기존 가드 순회 테스트는 자동으로 새 라우트를 커버한다).

**d. `web/src/app/App.test.jsx` 갱신**: 비-Z가 `/distMgmt.do`로 가면 `list.do`로 리다이렉트되고,
Z는 `distMgmt.do`가 렌더되며 TopBar에 진입 버튼이 보인다(기존 logs.do 케이스 L72~ 형식과 동형).

### 2) `web/src/controller/useDistMgmtController.js` 신규

```js
export function useDistMgmtController() {
  // targets: item[] — 서버 목록(비활성 포함)
  // refresh(): 전체 재조회
  // createTarget(entry): 등록 후 refresh, 서버 응답 그대로 반환
  // updateTarget(id, fields): 수정 후 refresh, 서버 응답 그대로 반환
  // deactivateTarget(id): 비활성(soft delete) 후 refresh, 서버 응답 그대로 반환
  return { targets, refresh, createTarget, updateTarget, deactivateTarget };
}
```

- 데이터는 전부 `useAppContext().model` 경유(`useRcvMgmtController`와 동형). `useCallback` 의존성 배열을 정확히 채운다(lint react-hooks 규칙).
- 서버 응답(`{ ok, reason }`)을 **가공하지 않고 그대로** 반환한다(에러 표시 정책은 View 재량).
- 파일 상단 주석: "distMgmt.do, Z 전용 — 서버 게이트가 강제(ADR-004). 비활성은 soft delete이며 행은 남는다(ADR-008·DB 비파괴)."

### 3) `web/src/view/DistMgmtPage.jsx` 신규

- 레이아웃: `<main className="yh-page">` + `<h1>배부 대상 관리</h1>` + 등록/수정 폼(`.yh-card`, `data-testid="dist-form"`) + 목록 표(`.yh-table`).
- 폼 필드(`UserMgmtPage`의 `editing` 토글 패턴):

| 라벨 | id | 컨트롤 | 비고 |
|------|----|--------|------|
| 수신처명 | `dist-name` | text input | 필수 |
| 유형 | `dist-kind` | select | `press`=언론사 / `nonpress`=비언론사 |
| 스풀 폴더 | `dist-spool` | text input | 소문자 영숫자·`-`·`_`(1~64자). placeholder/도움말 한 줄로 규칙 안내 |
| 활성 | `dist-active` | select | `Y`/`N` — 편집 모드에서 재활성화 경로 |

- 제출 버튼 라벨은 `editing ? '수정' : '생성'`, 편집 중에는 `취소` 버튼을 함께 노출한다.
- 표 컬럼: 수신처명 / 유형(한글 라벨) / 스풀 폴더 / 활성 / 액션(`수정`, `active==='Y'`인 행만 `비활성`).
- **`비활성`에 확인 대화상자를 붙이지 않는다** — 되돌릴 수 있는 조작이다(행이 남고 `수정`으로 재활성화 가능). 그 이유를 주석 한 줄로 남긴다.
- 유형 라벨 매핑은 파일 상단 상수(`const KIND_LABEL = { press: '언론사', nonpress: '비언론사' }`)로 두고, 미지의 값은 원문 그대로 표시한다.
- UI_GUIDE 토큰만 사용한다(새 CSS 파일·인라인 그라데이션·글로우·보라 계열 금지).
- 파일 상단 주석: 페이지 용도(distMgmt.do, Z 전용) + "삭제 없음 — 비활성(soft delete)만" + "spoolDir는 문자열 저장일 뿐, 이 화면은 폴더를 만들지 않는다(스풀 쓰기는 phase 47 — ADR-008)".

### 4) 라우팅 등록 (3파일, 각 1~3줄)

- `web/src/app/routing.js`: `ROUTES`에 `'distMgmt.do'` 추가, `Z_ONLY_ROUTES`에도 추가.
- `web/src/app/App.jsx`: `DistMgmtPage` import + `RouteView`에 `else if (route === 'distMgmt.do') page = <DistMgmtPage />;` 분기 추가.
- `web/src/view/TopBar.jsx`: `isZ` 블록에 `<button ... onClick={() => navigate('distMgmt.do')}>배부대상 관리</button>` 추가
  (수신설정 관리 버튼 옆). 비-Z에게는 노출되지 않는다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

- `npm run test:web` **전부 통과, 실패 0**. 통과 개수는 **step2 완료 시점 이상**(신규 테스트만큼 증가 — 감소하면 회귀).
- `npm run build` clean, `npm run lint` clean(경고 0 — react-hooks 의존성 경고 포함).
- 백엔드 무접촉이므로 `npm test`는 이 step의 AC가 아니다(실행해도 무해하며, 통과 시 기준 427+ 유지 확인용으로만 쓴다).

## 검증 절차

1. 테스트를 먼저 작성해 red(`useDistMgmtController is not a function` / 라우트 미등록)를 확인한 뒤 구현한다.
2. 계약 체크리스트:
   - [ ] 목록에 **비활성 행이 표시**된다(숨기지 않는다).
   - [ ] `삭제` 버튼·행 제거 경로가 **없다**.
   - [ ] 비-Z는 `distMgmt.do`에 들어갈 수 없다(App 가드 테스트).
   - [ ] TopBar 진입 버튼이 Z에게만 보인다.
3. `grep -rn "fetch(\|EventSource" web/src/view/DistMgmtPage.jsx web/src/controller/useDistMgmtController.js` → **0건**(model 계약 경유만).
4. `git diff --stat`에 `src/**`·`server/**`·`web/src/model/**`·`web/src/test/fakeModel.js`가 **없어야** 한다
   (fakeModel은 step2에서 완성됐다 — 여기서 고쳐야 한다면 step2 계약이 틀린 것이므로 그대로 진행하지 말고 index.json에 사유를 남겨라).
5. 기존 web 테스트(App/routing/TopBar 소비처·RcvMgmt/UserMgmt 페이지) 전부 그린인지 확인한다.

## 커밋 계획

- **feat**: `feat(46-distribution-targets): step3 — distMgmt.do 배부 대상 관리 화면(Z 전용, 목록/등록/수정/비활성)`
  — `web/src/controller/useDistMgmtController.js`, `web/src/view/DistMgmtPage.jsx`, `web/src/app/routing.js`,
  `web/src/app/App.jsx`, `web/src/view/TopBar.jsx` + 테스트 4종(`useDistMgmtController.test.jsx`, `DistMgmtPage.test.jsx`,
  `routing.test.js`, `App.test.jsx`).
- **chore**: `chore(46-distribution-targets): step3 status — completed` — index.json만. 코드와 분리 커밋.

## 금지사항

- `web/src/controller/useViewController.js`를 수정하지 마라. 이유: `VIEW_MENUS`/`DZ_ONLY_MENUS`는 **list.do 기사 조회 메뉴**(상태 필터) 목록이다 — 배부 대상 관리는 기사 목록 메뉴가 아니라 별도 `.do` 라우트이므로, 가드의 동형 위치는 `rcvMgmt.do`/`userMgmt.do`/`logs.do`와 같은 `routing.js`의 `Z_ONLY_ROUTES`다. 역할 기반 노출 원칙만 `DZ_ONLY_MENUS`에서 차용하고 파일은 건드리지 않는다.
- 삭제 버튼이나 행 제거 UI를 만들지 마라. 이유: 서버에 삭제 경로가 없다(DB 비파괴 — 비활성만). 버튼이 있으면 사용자가 데이터가 사라졌다고 오해한다.
- 비활성 행을 목록에서 숨기거나 기본 필터로 걸러내지 마라. 이유: soft delete라 비활성 행이 곧 재활성화 대상이다 — 숨기면 관리 화면에서 영영 복구할 수 없다.
- 스풀 폴더 "생성/찾아보기/업로드" 류 UI나 파일 입력을 만들지 마라. 이유: ADR-008 — 앱은 이 phase에서 파일시스템에 손대지 않는다(스풀 쓰기는 phase 47).
- 배부 실행 버튼(즉시 배부·재배부·tick 호출)을 만들지 마라. 이유: 배부 실행은 phase 47/48 범위다 — 대상 관리 화면에 섞으면 스코프와 리뷰 게이트가 무너진다.
- `setInterval`/`setTimeout` 폴링이나 SSE 구독을 추가하지 마라. 이유: ADR-007/008 — 앱 내 타이머 금지이며, 관리 화면은 수신설정 관리와 동형으로 수동 조회로 충분하다.
- View/Controller에서 `fetch`·`EventSource`를 직접 호출하지 마라. 이유: ADR-003 — transport는 `httpModel` 뒤에만 존재한다.
- 프론트 가드로 인가를 대체하지 마라(예: "Z가 아니면 API를 안 부르니 안전하다"는 가정). 이유: ADR-004 — 실제 강제는 서버 세션 게이트다. 주석에도 그렇게 남겨라.
- `web/src/model/**`·`web/src/test/fakeModel.js`·`src/**`·`server/**`를 수정하지 마라. 이유: 계약은 step2, 백엔드는 step1에서 확정됐다 — 레이어 혼입 금지.
- UI_GUIDE의 AI 슬롭 안티패턴(글래스모피즘·그라데이션 텍스트·글로우 애니메이션·보라 계열·균일한 큰 라운드)을 쓰지 마라. 이유: 디자인 가이드가 명시적으로 금지한다.
- 기존 테스트를 삭제하거나 약화시키지 마라(기준: web 1893+ 통과 · lint/build clean).
