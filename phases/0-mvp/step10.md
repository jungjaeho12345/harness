# Step 10: frontend-app-controllers

## 읽어야 할 파일

- `/news.md` — **페이지(login.do/writer.do/list.do, .do SPA 라우팅, 미정의 경로→login), 세션 정책(F5 복원, sessionStorage), 사용자 정보, 권한** 섹션
- `/docs/ARCHITECTURE.md` — 상태 관리(sessionStorage, 재조회), 프론트 MVC
- `web/src/model/contract.js`, `web/src/model/httpModel.js`, `web/src/test/fakeModel.js`(step9)

## 작업

앱 셸·라우팅·컨트롤러 훅을 구현한다. **비즈니스 호출은 훅에서 Model로**(컴포넌트는 다음 step). TDD(vitest + @testing-library/react, fakeModel 주입).

1. `web/src/app/routing.js` — `.do` SPA 라우팅: `login.do` / `writer.do` / `list.do`, 정의되지 않은 경로는 `login.do`로. 브라우저 뒤로/앞으로(history) 지원. 활성 라우트 ↔ 주소창 동기화 헬퍼.
2. `web/src/app/context.js` — React context로 주입된 `model`과 세션 신원 공유.
3. `web/src/app/App.jsx` — 라우트 스위치 + **세션 복원**: 마운트 시 `model`로 세션 확인(+sessionStorage의 sessionId/user), **복원 끝나기 전에는 login으로 보내지 않는다**. 비로그인 시 login.do.
4. `web/src/controller/` 훅(각각 Model만 호출, UI 상태 보유):
   - `useLoginController.js` — 로그인/로그아웃, 실패 시 알림 신호.
   - `useViewController.js` — list.do: 4개 메뉴(데스크 미송고/부서별 작성/부서별 송고/개인별 수정) 필터, 부서 드롭다운 데이터(queryUsers), 페이징(10), **subscribe로 실시간 재조회**.
   - `useWriteController.js` — writer.do: 작성/편집 상태, 송고/보류/KILL(applyAction), 저장(saveArticle), 편집 잠금(lock/unlock/force), 다중 탭 + **sessionStorage 보존**, 강제 해제 수신 시 탭 자동 종료.
   - `useSearchController.js` — 이미지/영상/글기사 검색(searchMedia/searchArticles).
   - `useRcvMgmtController.js` — 수신 설정 CRUD(Z).
5. 테스트(`web/src/**/**.test.jsx`): fakeModel 주입으로 라우팅(미정의→login), 세션 복원 게이트, 로그인 흐름, 메뉴 필터/페이징, 작성 탭 sessionStorage 보존, 실시간 재조회를 검증.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. AC 실행.
2. 체크리스트: 미정의 경로가 login으로 가는가? 복원 전 login 리다이렉트를 막는가? 모든 데이터 호출이 Model 경유인가? 작성 탭이 sessionStorage로 유지되는가? subscribe로 실시간 갱신되는가?
3. step 10 업데이트(completed + summary: 라우팅/컨텍스트/각 훅의 책임과 시그니처).

## 금지사항

- 풀 마크업/스타일을 여기서 완성하지 마라(다음 step). 이유: scope 최소화 — 이 step은 라우팅+훅.
- 컴포넌트에서 직접 transport를 부르지 마라(훅→Model). 이유: ADR-003.
- 세션 복원 전에 login으로 강제 이동시키지 마라. 이유: news.md 세션 정책.
- 백엔드/기존 테스트를 깨뜨리지 마라.
