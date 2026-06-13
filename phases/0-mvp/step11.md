# Step 11: frontend-editor-views

## 읽어야 할 파일

- `/docs/news.md` — **기사 에디터**(첫줄 제목/2~5줄 부제/이후 본문, 색상=제목 파랑·부제 빨강·본문 검정, 임베드 블록 markupVersion, Alt+Y "(끝)" 골드+뒤 입력 차단, Ctrl+D 라인 삭제, 클립보드 임베드 크기), **상세보기**(새 창, 공통정보 가로 나열, HTML 이스케이프) 섹션
- `/docs/UI_GUIDE.md` — 색상 토큰(파랑 #0a4da6, 빨강 #c8102e, 골드 #d4af37), 컴포넌트
- `web/src/controller/useWriteController.js`, `useSearchController.js`(step10)

## 작업

에디터/임베드/상세보기 등 **뷰 로직과 컴포넌트**를 구현한다. 본문은 항상 **블록 구조(markupVersion)** 로 다룬다. TDD(vitest + RTL; 순수 로직은 유닛, 컴포넌트는 RTL).

1. `web/src/view/` 순수 로직 모듈:
   - `editorContent.js` — 텍스트/임베드 블록 모델, 직렬화/역직렬화(`{format:'yh-editor',version:1,blocks:[...]}`), 평문 본문도 역호환 로드.
   - `editorColoring.js` — **구조 규칙: 첫 줄=제목, 2~5줄=부제(단 개행 2회 이상이면 2번째부터 본문)**. 색: 제목(파랑 #0a4da6)/부제(빨강 #c8102e)/본문(검정)/"(끝)"(골드 #d4af37). IME 조합 중 재색칠 금지, 조합 완료/포커스 이탈/로드 시 적용.
   - `editorNewline.js`, `editorCaret.js`, `editorShortcuts.js` — 개행 규칙, 캐럿, **Ctrl+D 라인 삭제(임베드 동반 삭제)**, **Alt+Y "(끝)" 삽입(골드, 중복 금지, 마커 뒤 입력 전면 차단, 맞춤법 on)**.
   - `clipboardEmbed.js` — 붙여넣기 이미지/유튜브 임베드(에디터 100% 기준 가로·세로 17%; 사진/영상 figure 폭 612px, 기사 참조 카드 480px), `columnConfig.js` — list 컬럼 표시/간격(메뉴별 저장), `articleDetail.js` — 상세보기 데이터 구성(공통정보 가로 나열, 빈 필드 '—', 본문 블록 순서 유지, HTML 이스케이프).
2. `web/src/view/` 컴포넌트:
   - `InlineEmbed.jsx`(× 삭제 버튼), 에디터 컴포넌트(**본문 영역 위 '본문' 라벨 텍스트 미표시, aria-label은 유지**).
   - `ContextMenu.jsx` — **메뉴별 항목 구성**:
     - 데스크 미송고: 편집 / 상세보기 / 이력보기 / 본문복사 / 제목만복사.
     - 부서별 작성·개인별 수정: 상세보기 / 이력보기 / 송고이력보기 / 본문복사 / 제목만복사 / 번역 / 매핑 / 후속기사작성 / 계속기사작성 / 고침(포털제외) / 포털고침 / 삭제요청 / 재송.
     - 부서별 송고: 위 항목 + **편집** 추가.
     - 활성 조건: **고침(포털제외)/포털고침은 DPS + 권한 D만 활성**(writer.do 편집 진입), **삭제요청은 DPS + 권한 D/Z만 활성**('정말 삭제하시겠습니까?' → approveDelete), **Lock해제는 잠긴(LockYN='Y') 행 + 권한 D/Z만 활성**('해제하시겠습니까?', R은 비활성). 이력보기/송고이력보기/번역/매핑/후속·계속기사작성/재송은 **표시만(비활성)**.
3. 테스트: 블록 직렬화 round-trip, 첫줄 제목/부제/본문 구조·색상 규칙, "(끝)" 삽입/중복/뒤 입력 차단/Ctrl+D 동반 삭제, 상세보기 이스케이프, 컬럼 설정, ContextMenu 메뉴별 항목과 고침/삭제요청/Lock해제 활성 조건(권한·상태).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. AC 실행.
2. 체크리스트: 본문이 블록(markupVersion)으로 저장/복원되는가? "(끝)" 뒤 입력이 차단되는가? 제목/부제/본문 색이 규칙대로인가? 상세보기가 HTML 이스케이프하는가? ContextMenu가 메뉴별로 항목을 구성하고 고침/삭제요청/Lock해제 활성 조건(권한·상태)을 지키는가? 미동작 항목이 비활성 표시인가?
3. step 11 업데이트(completed + summary: view 모듈/컴포넌트 목록과 핵심 규칙).

## 금지사항

- 본문을 평문 문자열로만 저장하지 마라(블록 markupVersion 필수). 이유: news.md 에디터/ schema.md.
- "(끝)" 마커 뒤 입력(타이핑/Enter/붙여넣기/IME)을 허용하지 마라. 이유: news.md.
- 비활성 우클릭 항목(번역/매핑/이력 등)을 동작하게 만들지 마라. 이유: news.md — 표시만.
- 컴포넌트에서 직접 transport 호출 금지(훅/Model 경유). 기존 테스트를 깨뜨리지 마라.
