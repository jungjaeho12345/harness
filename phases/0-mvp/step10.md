# Step 10: frontend-app-controllers

## 읽어야 할 파일

- `/docs/news.md` — **페이지(login.do/writer.do/list.do/rcvMgmt.do/userMgmt.do, .do SPA 라우팅, 미정의 경로→login, Z 전용 페이지), 세션 정책(F5 복원, sessionStorage), 편집 잠금 수명, 기사 편집 매핑(read-only 필드), 사용자 정보, 권한** 섹션
- `/docs/RCV.md` — rcvMgmt.do 수신 설정 CRUD(Z 전용)
- `/docs/ARCHITECTURE.md` — 상태 관리(sessionStorage, 재조회), 프론트 MVC
- `web/src/model/contract.js`, `web/src/model/httpModel.js`, `web/src/test/fakeModel.js`(step9)

## 작업

앱 셸·라우팅·컨트롤러 훅을 구현한다. **비즈니스 호출은 훅에서 Model로**(컴포넌트는 다음 step). TDD(vitest + @testing-library/react, fakeModel 주입).

1. `web/src/app/routing.js` — `.do` SPA 라우팅: `login.do` / `writer.do` / `list.do` / `rcvMgmt.do` / `userMgmt.do`, 정의되지 않은 경로는 `login.do`로. **`rcvMgmt.do`·`userMgmt.do`는 권한 Z만 진입(비-Z는 list.do로 리다이렉트)**. 브라우저 뒤로/앞으로(history) 지원. 활성 라우트 ↔ 주소창 동기화 헬퍼(편집 탭이면 기사아이디 쿼리 표시, 새 기사 탭이면 제거).
2. `web/src/app/context.js` — React context로 주입된 `model`과 세션 신원 공유.
3. `web/src/app/App.jsx` — 라우트 스위치 + **세션 복원**: 마운트 시 `model.restoreSession()`로 서버 확인(+sessionStorage의 sessionId/user), **복원 끝나기 전에는 login으로 보내지 않는다**. 비로그인 시 login.do. Z 전용 라우트는 복원된 신원의 role로 가드한다.
4. `web/src/controller/` 훅(각각 Model만 호출, UI 상태 보유):
   - `useLoginController.js` — 로그인/로그아웃, 실패 시 알림 신호.
   - `useViewController.js` — list.do: 4개 메뉴 필터(**데스크 미송고=RDS·DDH / 부서별 작성=해당 부서·DPS와 RRH 제외 / 부서별 송고=DPS만·부서 다중선택 / 개인별 수정=로그인 작성자·RDS와 RRK**), 부서 드롭다운 데이터(queryUsers), 페이징(10), **subscribe로 실시간 재조회**. 우클릭 액션: 편집/고침·포털고침 진입(writer.do로 이동), Lock해제(force-unlock, D/Z), 삭제요청(applyAction `approveDelete`, D/Z, '정말 삭제하시겠습니까?' 확인). 비동작 항목(이력/번역/매핑 등)은 표시만.
   - `useWriteController.js` — writer.do: 작성/편집 상태, 송고/보류/KILL/삭제승인(applyAction), 저장(saveArticle — 신규는 생성·편집은 잠금 보유 PUT), 다중 탭 + **sessionStorage 보존**.
     - **편집 진입 컨텍스트 추적**: 새 작성 / 편집(데스크 미송고) / 고침·포털고침(DPS) 모드를 탭 상태로 보존한다(버튼 표시 규칙이 이 컨텍스트에 의존 — step12). 고침/포털고침 진입은 상태값 전이를 일으키지 않는다.
     - **매핑 필드 구분**(news.md): 편집 진입 시 제목/본문/작성자/엠바고/2차엠바고는 입력란에 채우고, 기사아이디/수정자/송고자/부서/부서코드/작성·편집·송고시간은 read-only로 보존한다.
     - **편집 잠금 수명**: 편집 탭을 열면 lock 획득(lockYN='Y' 유지), list.do로 이동해도 해제하지 않는다. 해제 시점 = 탭 닫기(×)/송고·보류·KILL·삭제승인 성공/로그아웃·세션 만료/**브라우저 탭 닫힘(`beforeunload`/`pagehide`에서 unlock 요청)**. 이미 열린 기사를 다시 열면 새 탭을 만들지 않고 그 탭을 활성화(dedup). 강제 해제(force-unlock) 수신 시 해당 편집 탭 자동 종료.
   - `useSearchController.js` — 이미지/영상/글기사 검색(searchMedia/searchArticles).
   - `useRcvMgmtController.js` — 수신 설정 CRUD(Z).
   - `useUserMgmtController.js` — USER 입력/수정/조회(Z): createUser/updateUser/queryUsers 호출. 비밀번호는 응답에 없음을 전제로 폼을 다룬다(빈칸이면 변경 안 함).
5. 테스트(`web/src/**/**.test.jsx`): fakeModel 주입으로 라우팅(미정의→login, Z 전용 라우트 가드), 세션 복원 게이트(restoreSession), 로그인 흐름, 메뉴별 필터/페이징, 작성 탭 sessionStorage 보존·재활성화 dedup·강제해제 자동종료, 실시간 재조회, USER/수신설정 CRUD(Z) 훅을 검증.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. AC 실행.
2. 체크리스트: 미정의 경로가 login으로 가는가? Z 전용 라우트가 비-Z를 막는가? 복원 전 login 리다이렉트를 막고 restoreSession을 쓰는가? 모든 데이터 호출이 Model 경유인가? 작성 탭이 sessionStorage로 유지되고 브라우저 닫힘 시 unlock을 보내는가? 편집 진입 컨텍스트/매핑 read-only 필드가 보존되는가? subscribe로 실시간 갱신되는가?
3. step 10 업데이트(completed + summary: 라우팅/컨텍스트/각 훅의 책임과 시그니처).

## 금지사항

- 풀 마크업/스타일을 여기서 완성하지 마라(다음 step). 이유: scope 최소화 — 이 step은 라우팅+훅.
- 컴포넌트에서 직접 transport를 부르지 마라(훅→Model). 이유: ADR-003.
- 세션 복원 전에 login으로 강제 이동시키지 마라. 이유: news.md 세션 정책.
- Z 전용 페이지 접근을 클라이언트 라우트 가드만으로 끝내지 마라. 이유: 실제 강제는 서버 Z 게이트(step8) — 클라이언트 가드는 UX일 뿐. (역할은 복원된 세션 신원에서만 읽는다)
- 백엔드/기존 테스트를 깨뜨리지 마라.
