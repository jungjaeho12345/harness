# Step 7: list-screen

## 읽어야 할 파일

- `/docs/news.md` (기사 목록 절 — 원문) **+** `/docs/news-md-overrides.md` (**L97·L100 기본 컬럼 11종(+토글 배부시간) · L80 SSE 단일 무효화→전체 재조회 · L131 잠금 컬럼 응답 비노출 · L104 시간 포맷 · L84 부서 기본 '전체'** 필독)
- `/docs/api-contract/endpoints.json` (`GET /api/articles` 필터 15키 화이트리스트 · `GET /api/articles/search`)
- `/docs/ADR.md` (ADR-003 seam · ADR-004 신뢰 경계 · ADR-005 SSE)
- `web/src/view/ListPage.jsx` · `web/src/view/columnConfig.js` · `web/src/controller/useViewController.js` (있으면 — 목록 동작·컬럼·필터 명세. 읽기 전용)
- `phases/77-cpp-qt-client-skeleton/step1.md`(타입/fakeModel) · `step2.md`(HttpModel) · `step3.md`(SseClient 무효화 시그널) · `step6.md`(로그인→list 진입)

## 작업

`client-cpp/ui/`에 **기사 목록 화면(View) + 컨트롤러**를 만든다. SSE 무효화 시그널(step 3)에 반응해 전체 재조회한다 — 이것이 P4 done-criteria의 핵심 동작이다.

1. **View(`ui/ListView`)**: 기사 목록 테이블. **기본 표시 컬럼 11종**(기사아이디·제목·작성자·수정자·작성시간·수정시간·기사상태·LockYN + **부서·부서코드·송고시간**) + **배부시간은 토글 컬럼(기본 숨김)**(L97·L100). 시간 컬럼은 환경설정 날짜 포맷을 따르되 기본값 `YYYY-MM-DD HH:mm`, 가운데 정렬(L104).
2. **Controller(`ui/ListController`)**: `model.listArticles(filter)`로 조회. 필터는 `endpoints.json`의 15키 화이트리스트만 전송(밖의 키는 무시). 부서 기본 선택은 **'전체'(부서 미지정)** 이다(L84 — 로그인 사용자 부서 아님).
3. **SSE 결선**(L80 · ADR-005): step 3의 SseClient가 방출하는 **단일 무효화 시그널**을 구독해, kind와 무관하게 **현재 필터로 목록 전체를 재조회**한다(부분 갱신·kind별 처리 금지). unauthorized로 SSE가 닫히면 재조회하지 말고 세션 만료 UX로 전이(재로그인 유도).
4. **잠금 컬럼 투영**(L131): 서버 응답에 `lockerSessionId`·`lockerClientId`가 없음을 전제로 하되, 화면은 **`lockYN`만** 표시한다(그 두 필드는 타입에도 없다 — step 1). 어떤 경우에도 세션 토큰/탭 식별자를 목록에 렌더하지 마라.
5. **테스트**(TDD, fakeModel + 목 SseClient): 초기 목록 로드 · 기본 컬럼 11종 노출 + 배부시간 토글 · 필터 화이트리스트 전송 · **무효화 시그널 수신 → 전체 재조회 1회** · 부서 기본 '전체' · lockYN만 표시(locker 필드 미표시). 

**핵심 규칙:**
- **SSE 무효화에 kind별 부분 갱신을 하지 마라**(L80). 단일 무효화 → 전체 재조회.
- **잠금 세션/클라 식별자를 목록에 렌더하지 마라**(L131).
- **필터 화이트리스트(15키) 밖의 키를 서버로 보내지 마라.**
- **Model/SseClient를 주입받아라**(ADR-003) — 테스트가 목으로 대체한다.

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
```

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트: 무효화 시그널→전체 재조회? 기본 컬럼 11종+토글 배부시간? 필터 화이트리스트? locker 세션/클라 미표시? 부서 기본 '전체'? Model/SSE 주입?
3. news-md-overrides L97·L100/L80/L131/L104/L84 반영 확인.
4. 결과 반영: 성공 → completed + summary(ListView/Controller · 컬럼 · SSE 재조회 결선). 실패 3회 → error.

## 금지사항

- SSE 무효화를 kind별 부분 갱신으로 처리하지 마라. 이유: 계약은 단일 무효화+전체 재조회다.
- 잠금 세션/클라 식별자를 목록에 표시하지 마라. 이유: 응답에 없어야 하는 필드이며 권한 상승 재료다.
- 필터 화이트리스트 밖 키를 전송하지 마라. 이유: 서버 계약과 어긋난다.
- 부서 기본을 로그인 사용자 부서로 두지 마라. 이유: 실제 기본값은 '전체'다.
- 기존 테스트를 깨뜨리지 마라.
