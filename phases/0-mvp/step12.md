# Step 12: frontend-pages-styles

## 읽어야 할 파일

- `/news.md` — **기사 작성페이지(60:40, 4개 메타 탭, 송고/보류/KILL 버튼의 권한·상태별 표시 규칙, "(끝)" 송고 가드, 확인창), 기사 조회페이지(4개 메뉴, 실시간 SSE+재연결, 10 페이징, 우클릭 메뉴, 상태 배지 색, 컬럼 설정, 상세보기 새 창), 사용자 정보/세션** 섹션
- `/docs/UI_GUIDE.md` — **디자인 토큰/컴포넌트(이 step의 스타일 기준)**: 블루 #0a4da6, 레드 #c8102e, 배지색(RDS 회색/DPS 레드/보류 앰버 #d97706/KILL 슬레이트 #374151), 명조/고딕, 신문형 밀도
- `web/src/controller/*`(step10), `web/src/view/*`(step11), `web/src/model/*`(step9)

## 작업

페이지 컴포넌트와 스타일시트를 구현해 앱을 완성한다. 컨트롤러 훅 + 뷰 모듈을 결선만 한다. TDD(RTL + fakeModel).

1. `web/src/styles/yonhap.css` — UI_GUIDE 토큰을 `:root` 커스텀 프로퍼티로(blue/red/gold/neutral, serif/sans, 배지색, 간격/라운드/그림자). 신문형 레이아웃(헤더 48px sticky, 60:40, 표 밀도).
2. 페이지 컴포넌트(`web/src/app/` 또는 `web/src/view/`):
   - **LoginPage**(login.do) — 아이디/암호('아이디를 입력하세요'/'암호를 입력하세요'), 실패 ALERT.
   - **WriterPage**(writer.do) — 좌 에디터:우 메타 = **60:40**, 메타 4탭(공통정보/이미지/영상/글기사), 탭 위 송고/보류/KILL 버튼(**news.md 권한×상태 표시 규칙 정확히**), 송고 시 "(끝)" 없으면 ALERT 차단, 각 액션 확인창("송고하시겠습니까?" 등), 성공 후 작성페이지 초기화, 다중 작성 탭(＋).
   - **ListPage**(list.do) — 4개 메뉴, **실시간 SSE 목록 + 끊기면 재연결**(우상단 상태바), 컬럼(기사아이디/제목/작성자/수정자/작성시간/수정시간/기사상태/LockYN), 시간 내림차순, **10개 페이징**, 우클릭 ContextMenu, **상태 배지 색**(UI_GUIDE), 헤더 우클릭 컬럼 설정 모달, 행 클릭 시 **상세보기 새 창(720×800)**.
   - 공통: 우상단 사용자 정보(`유저아이디 · 부서 · (권한)`) + 로그아웃.
3. `App.jsx`/라우팅에 페이지 결선. `main.jsx`가 yonhap.css를 import.
4. 테스트(RTL + fakeModel): 로그인 실패 알림, 권한/상태별 버튼 표시 규칙, "(끝)" 송고 가드, 메뉴별 필터/페이징, 상태 배지 색, 실시간 갱신, 상세보기 트리거.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. AC 실행.
2. 체크리스트: 60:40 레이아웃인가? 송고/보류/KILL 버튼이 news.md 권한×상태 규칙대로 노출되는가? 배지 색이 UI_GUIDE와 일치하는가? SSE 재연결/페이징/상세보기 새 창이 동작하는가? AI 슬롭 안티패턴(글래스/그라데이션 텍스트/보라색)을 피했는가?
3. step 12 업데이트(completed + summary: 페이지 컴포넌트와 스타일 토큰, 결선).

## 금지사항

- 송고/보류/KILL 버튼의 권한·상태 표시 규칙을 어기지 마라. 이유: news.md 기사 작성 페이지 내 버튼.
- 상태 배지 색을 임의로 바꾸지 마라. 이유: UI_GUIDE 토큰.
- UI_GUIDE의 "AI 슬롭 안티패턴"(backdrop-blur, gradient-text, 보라색, glow)을 쓰지 마라.
- 컴포넌트에서 직접 transport 호출 금지(훅/Model). 기존 테스트를 깨뜨리지 마라.
