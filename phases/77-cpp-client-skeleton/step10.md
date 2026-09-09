# Step 10: article-list-screen

ui 레이어의 **기사 목록 화면**을 만든다 — `queryArticles`로 목록을 그리고 **`subscribe`(SSE 무효화 신호)로 실시간 재조회·갱신**한다. 이 화면의 SSE 실시간 갱신이 로드맵 **AC ①의 본체**다. 서버 없이 `FakeModel`로 단위 테스트한다.

## 읽어야 할 파일
- `web/src/controller/useView.js`(또는 목록 조회 컨트롤러 정본 — 목록 필터·SSE 구독→재조회 흐름) · 목록 뷰 컴포넌트
- `web/src/model/httpModel.js` (`queryArticles` 필터 15키 화이트리스트 · `subscribe`)
- `docs/ADR.md` ADR-005(SSE 무효화 신호 · 클라 자기 필터로 재조회 · 행 데이터 push 없음)
- `docs/ARCHITECTURE.md` 「실시간 동기화」·「데이터 흐름[실시간]」(SSE → subscribe → 무효화 수신 → 재조회 → 뷰 갱신)
- `docs/porting-plan-cpp-spring.md` §7 P4 행(로그인→목록 SSE 실시간 갱신 실기)
- `phases/77-cpp-client-skeleton/index.json` decisions (4)(5) · `client-qt/net/`(step7·8) · `client-qt/ui/`(step9 로그인 — 로그인→목록 전환)

## 작업
1. **TDD**: `ListControllerTest`를 먼저 쓴다 — `FakeModel` 주입 · 초기 `queryArticles` 렌더 · `subscribe`의 무효화 신호(change kind)를 fake로 발사하면 **재조회가 일어나 목록이 갱신**되는지 · `event: unauthorized` 상태에서 로그인으로 되돌리는지. red 확인 후 구현.
2. `client-qt/ui/`에:
   - **목록 뷰**(QWidget — QTableView/QListView) — 헤드라인·상태·시각 등 **메타 컬럼**만(본문 렌더 없음 — 에디터는 P5). 최소 컬럼.
   - **목록 컨트롤러**(`useView.js` 동형 — Model 주입) — 진입 시 `queryArticles`, `subscribe(filter, onChange, onStatus)`로 구독. **onChange(무효화 신호) 수신 → 자기 필터로 재조회 → 뷰 갱신**(행 데이터를 신호에서 직접 꺼내지 않는다). onStatus의 unauthorized → 로그인 화면.
   - 로그인(step9) 성공 → 이 목록 화면으로 전환.
3. **재조회가 진실 공급원**: SSE는 "바뀌었다"만 알린다 — 목록의 실제 데이터는 항상 `queryArticles` 재조회에서 온다(캐시 신뢰 금지 · 권한별 노출 회피).

## Acceptance Criteria
```
cmake --build client-qt/build
QT_QPA_PLATFORM=offscreen ctest --test-dir client-qt/build --output-on-failure   # ListControllerTest green
cd /home/user/harness && git diff --stat    # client-qt/ui·tests 만 바뀐다
```
- `ListControllerTest`가 fake 무효화 신호 발사 → 재조회 → 목록 변화(행 추가/상태 변경 반영)를 단언한다 — 이것이 SSE 실시간 갱신의 단위 증거다.
- unauthorized 신호에서 로그인으로 되돌리는 경로가 단언된다.

## 검증 절차
1. 무효화 신호 처리가 재조회를 부르고, 신호 payload의 행 데이터를 뷰에 직접 쓰지 않는지 확인(ADR-005).
2. 로그인→목록 전환이 step9 컨트롤러와 이어지는지 확인.
3. 목록이 본문(article body)을 렌더하지 않는지 확인(에디터는 P5 — 메타만).

## 금지사항
- SSE 무효화 신호의 행 데이터를 뷰에 직접 반영하지 마라. 이유: 권한별 필터가 없는 broadcast라 재조회(자기 권한)만 안전하다(ADR-005).
- 본문 에디터·상세보기 창을 만들지 마라. 이유: P5~P6 범위다 — P4 목록은 메타 컬럼만이다(excluded (a)(b)).
- 목록을 로컬에 캐시해 SSE 없이 최신으로 가정하지 마라. 이유: `news.db`가 단일 진실 공급원이고 클라는 재조회한다(ARCHITECTURE 상태 관리).
