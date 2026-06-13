# Step 12: frontend-pages-styles

## 읽어야 할 파일

- `/docs/news.md` — **기사 작성페이지(60:40, 4개 메타 탭, 송고/보류/KILL 버튼의 권한·상태별 표시 규칙, "(끝)" 송고 가드, 확인창), 기사 조회페이지(4개 메뉴, 실시간 SSE+재연결, 10 페이징, 우클릭 메뉴, 상태 배지 색, 컬럼 설정, 상세보기 새 창), 사용자 정보/세션** 섹션
- `/docs/UI_GUIDE.md` — **디자인 토큰/컴포넌트(이 step의 스타일 기준)**: 블루 #0a4da6, 레드 #c8102e, 배지색(RDS 회색/DPS 레드/보류 앰버 #d97706/KILL 슬레이트 #374151), 명조/고딕, 신문형 밀도
- `/docs/RCV.md` — rcvMgmt.do 수신 설정 CRUD(Z 전용, 설정 행만 삭제)
- `web/src/controller/*`(step10 — useUserMgmt/useRcvMgmt 포함), `web/src/view/*`(step11), `web/src/model/*`(step9)

## 작업

페이지 컴포넌트와 스타일시트를 구현해 앱을 완성한다. 컨트롤러 훅 + 뷰 모듈을 결선만 한다. TDD(RTL + fakeModel).

1. `web/src/styles/yonhap.css` — UI_GUIDE 토큰을 `:root` 커스텀 프로퍼티로(blue/red/gold/neutral, serif/sans, 배지색, 간격/라운드/그림자). 신문형 레이아웃(헤더 48px sticky, 60:40, 표 밀도).
2. 페이지 컴포넌트(`web/src/app/` 또는 `web/src/view/`):
   - **LoginPage**(login.do) — 아이디/암호('아이디를 입력하세요'/'암호를 입력하세요'), 실패 ALERT.
   - **WriterPage**(writer.do) — 좌 에디터:우 메타 = **60:40**, 메타 4탭(공통정보/이미지/영상/글기사), 탭 위 송고/보류/KILL 버튼. **버튼 표시 규칙(news.md 61–68, 진입 컨텍스트=step10 useWriteController):**

     | 상태(진입) \ 권한 | R | D | Z |
     |---|---|---|---|
     | RDS(편집) | 송고·보류·KILL | 송고·보류·KILL | 송고·보류·KILL |
     | DDH(편집) | (없음) | 송고·KILL | 송고·KILL |
     | 신규(미저장, articleId 없음) | 송고·보류(KILL 숨김) | 송고·보류(KILL 숨김) | 송고·보류(KILL 숨김) |

     - **DPS 고침/포털고침 진입**은 권한 D만 가능(news.md 193). 이 컨텍스트에서는 **송고·보류만** 표시(KILL 없음).
     - 위 표/규칙에 없는 (상태,권한,진입) 조합은 버튼을 표시하지 않는다.
     - **가드/확인창**: 송고 시 본문에 "(끝)" 없으면 ALERT로 차단, **송고/보류 시 제목(첫 줄)이 비면 '제목이 없어 송고/보류할 수 없습니다' ALERT로 차단**. 각 액션은 '송고하시겠습니까?'/'보류하시겠습니까?'/'KILL하시겠습니까?' 확인창 후에만 진행(취소 시 저장/전송 없음).
     - **매핑 표시**: 편집 진입 시 제목/본문/작성자/엠바고/2차엠바고는 입력란, 기사아이디/수정자/송고자/부서/부서코드/작성·편집·송고시간은 read-only.
     - 송고/보류/KILL/삭제승인 성공 후 그 탭은 빈 새 기사 탭으로 초기화(편집 잠금 해제), 다중 작성 탭(＋).
   - **ListPage**(list.do) — 4개 메뉴, **실시간 SSE 목록 + 끊기면 재연결**(우상단 상태바), 컬럼(기사아이디/제목/작성자/수정자/작성시간/수정시간/기사상태/LockYN; 시간은 YYYY-MM-DD HH:mm 가운데 정렬), 시간 내림차순, **10개 페이징**, 우클릭 ContextMenu(step11 — 메뉴별 항목·활성 조건), **상태 배지 색**(UI_GUIDE: RDS 회색/DPS 레드/보류 앰버/KILL 슬레이트), 헤더 우클릭 컬럼 설정 모달(메뉴별 저장), 행 클릭 시 **상세보기 새 창(720×800)**. 우클릭 액션 결선: 편집/고침·포털고침→writer.do 진입, **삭제요청(DPS+D/Z)→approveDelete**, **Lock해제(잠금행+D/Z)→force-unlock**(확인창 경유).
   - **RcvMgmtPage**(rcvMgmt.do, **Z 전용**) — 자동기사 수신 설정 조회/생성/삭제(useRcvMgmtController). 삭제는 설정 행만(수집된 기사 보존). 비-Z 진입 시 list.do.
   - **UserMgmtPage**(userMgmt.do, **Z 전용**) — USER 입력/수정/조회(useUserMgmtController). 비밀번호 입력란은 빈칸이면 변경 안 함, 응답에 비밀번호 없음. 비-Z 진입 시 list.do.
   - 공통: 우상단 사용자 정보(`유저아이디 · 부서 · (권한)`) + 로그아웃. **권한 Z에게는 수신설정 관리·사용자 관리 진입 링크 표시**.
3. `App.jsx`/라우팅에 페이지(Login/Writer/List/RcvMgmt/UserMgmt) 결선. `main.jsx`가 yonhap.css를 import.
4. 테스트(RTL + fakeModel): 로그인 실패 알림, **권한/상태/진입별 버튼 표시 규칙(진리표)**, "(끝)"·제목 없음 송고 가드, 메뉴별 필터/페이징, 상태 배지 색, 실시간 갱신, 상세보기 트리거, 삭제요청(approveDelete)·Lock해제 결선, RcvMgmt/UserMgmt의 Z 전용 가드.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. AC 실행.
2. 체크리스트: 60:40 레이아웃인가? 송고/보류/KILL 버튼이 진리표(권한×상태×진입)대로 노출되는가? "(끝)"·제목 가드가 동작하는가? 배지 색이 UI_GUIDE와 일치하는가? SSE 재연결/페이징/상세보기 새 창이 동작하는가? 삭제요청(approveDelete)·Lock해제가 결선됐는가? RcvMgmt/UserMgmt가 Z 전용인가? AI 슬롭 안티패턴(글래스/그라데이션 텍스트/보라색)을 피했는가?
3. step 12 업데이트(completed + summary: 페이지 컴포넌트와 스타일 토큰, 결선).

## 금지사항

- 송고/보류/KILL 버튼의 권한·상태 표시 규칙을 어기지 마라. 이유: news.md 기사 작성 페이지 내 버튼.
- 상태 배지 색을 임의로 바꾸지 마라. 이유: UI_GUIDE 토큰.
- UI_GUIDE의 "AI 슬롭 안티패턴"(backdrop-blur, gradient-text, 보라색, glow)을 쓰지 마라.
- rcvMgmt.do/userMgmt.do를 비-Z에게 노출·허용하지 마라(클라이언트 가드 + 서버 Z 게이트). 이유: news.md/rcv.md 보안 — 관리 기능은 Z 전용.
- UserMgmt 폼/응답에 비밀번호(평문·해시)를 표시·보관하지 마라. 이유: news.md 보안.
- 컴포넌트에서 직접 transport 호출 금지(훅/Model). 기존 테스트를 깨뜨리지 마라.
