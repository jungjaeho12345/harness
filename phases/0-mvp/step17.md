# Step 17: list-page-clamp

기사 조회페이지(list.do)에서 **목록이 축소될 때 현재 페이지 번호가 범위를 벗어나 빈 화면에 갇히는** 버그를 수정한다. **이 step은 list/pagination 컨트롤러 상태 한 가지 관심사만 다룬다. 본문 contract(step14)·에디터 키입력 결선(step15)·임베드 보안(step16)은 건드리지 마라.**

## 근본 원인 (이 step에서 고치는 것)

### [Medium][correctness] 목록 축소 시 페이지 클램프 누락
- `web/src/controller/useViewController.js`에서 `page` 상태(`const [page, setPage] = useState(1);`, 약 L48)는 **`selectMenu`에서만 1로 리셋**된다(약 L83-87, `setPage(1)`).
- 그런데 SSE 무효화 신호가 오면 `refresh()`가 돌아 `items`가 갱신된다(약 L78-81의 `subscribe` → `refresh`). 결과 집합이 줄어드는 경우(예: 25건 → 5건인데 사용자가 현재 `page === 3`에 있음)를 생각해 보면:
  - `totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))`(약 L89)는 1로 줄지만,
  - `page`는 여전히 3으로 남는다.
  - `pageItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)`(약 L90) = `items.slice(20, 30)` = **빈 배열** → 목록이 빈 화면.
- UI 상태(`web/src/view/ListPage.jsx`의 pager, 약 L151-155): '다음' 버튼은 `disabled={page >= totalPages}`라 비활성이지만 '이전' 버튼은 `disabled={page <= 1}`이라 활성이다. 사용자가 빈 페이지에 갇혀 '이전'을 눌러야만 빠져나올 수 있다(나쁜 UX).
- 메뉴/부서 변경 경로는 `selectMenu`가 `setPage(1)`로 리셋하므로 안전하다. 문제는 **SSE 재조회·부서 필터 변경 등 page를 리셋하지 않는 경로로 items가 줄어들 때**다.

## 읽어야 할 파일

먼저 아래를 읽고 list.do 컨트롤러의 상태 흐름(필터 → refresh → items → 페이징)과 SSE 재조회 경로를 파악하라:

- `/docs/ARCHITECTURE.md` — 프론트엔드 MVC(View ← Controller ← Model), 실시간 동기화(SSE 무효화 → 자기 필터 재조회).
- `/docs/ADR.md` — ADR-003(transport는 httpModel 뒤에만), ADR-005(SSE 무효화 신호 → 클라가 재조회).
- `/docs/news.md` — 기사 조회페이지(4메뉴·10개 페이징) 관련 절.
- `web/src/controller/useViewController.js` — 특히 `page` state, `totalPages`/`pageItems` 파생값, `refresh`, `selectMenu`, SSE `subscribe` 결선.
- `web/src/view/ListPage.jsx` — pager 렌더(약 L151-155), `setPage`/`page`/`totalPages`/`pageItems` 사용처.
- 테스트 패턴(반드시 참고): `web/src/controller/useViewController.test.jsx` — `setup(seed, identity)` 헬퍼, `rds(n)`(RDS 기사 n개 생성), `PAGE_SIZE`/`act`/`waitFor` 사용법. SSE 재조회 테스트(`re-queries when an SSE invalidation signal arrives`, L61-67)가 `model.saveArticle(...)` → `notify` → 자동 재조회를 어떻게 검증하는지 본다.
- `web/src/test/fakeModel.js` — `saveArticle`/`applyAction`이 `notify`로 구독자에게 신호를 보내 컨트롤러 재조회를 유발하는 방식.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, **page를 어디서 클램프해야 다른 정상 동작(메뉴 변경·정상 페이지 이동)을 깨지 않는지** 설계한 뒤 작업하라.

## 작업

### TDD 순서: 빈 페이지에 갇히는 버그를 재현하는 실패 테스트를 먼저

`web/src/controller/useViewController.test.jsx`에 재현 테스트를 추가하라. 시나리오 예시:
1. `setup({ articles: rds(25) })` → `items` 25건, `totalPages === 3`이 될 때까지 `waitFor`.
2. `act(() => result.current.setPage(3))` → 현재 3페이지(5건 보임).
3. 목록을 축소시킨다 — fakeModel의 데이터를 줄이는 경로로. 예: seed에 줄어든 상태를 반영하거나, `model`을 통해 SSE 재조회가 더 적은 items를 돌려주도록 구성한다. (fakeModel `queryArticles`가 현재 articles 배열을 반환하므로, 축소 상황을 만들려면 seed/articles를 조정하거나 별도 model stub으로 `queryArticles`가 적은 결과를 반환하게 한 뒤 `refresh`/SSE를 유발한다.)
4. **기대:** items가 줄어든 뒤 `result.current.pageItems`가 빈 배열이 **아니어야** 하고, `page`가 `totalPages` 이하로 클램프되어야 한다(예: `result.current.page <= result.current.totalPages` 그리고 `pageItems.length > 0`).
5. 이 테스트가 현재 코드에서 **실패**(빈 pageItems)하는 것을 먼저 확인한 뒤 구현한다.

추가로, **회귀 방지** 테스트도 하나 둬라: 정상 상태(예: 25건, page 2)에서 클램프가 page를 잘못 깎지 않는다(page 2 그대로 유지, pageItems 10건).

### 구현: items 변경 시 page를 유효 범위로 클램프

`web/src/controller/useViewController.js`에서 page가 항상 `[1, totalPages]` 범위에 있도록 보장하라. 두 가지 방식 중 하나를 선택(둘 다 허용):

- **(권장) useEffect 클램프** — items가 바뀐 뒤 page가 범위를 벗어나면 클램프한다:
  ```js
  useEffect(() => {
    const max = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    setPage((p) => Math.min(p, max));
  }, [items]);
  ```
  `setPage`의 함수형 업데이트를 써서 page를 effect 의존성에 넣지 않아 불필요한 재실행/루프를 피한다.

- **(대안) 파생값 클램프** — `pageItems`/렌더에 쓰는 유효 페이지를 `const effectivePage = Math.min(page, totalPages);`로 계산해 `slice`에 `effectivePage`를 사용한다. 이 경우 pager가 표시하는 page 번호도 `effectivePage`로 일관되게 보여야 사용자가 혼란하지 않다(표시 page와 실제 slice page 불일치 금지).

어느 방식이든:
- **메뉴 변경(`selectMenu`)의 `setPage(1)` 동작을 유지**하라. 클램프가 이를 덮어쓰면 안 된다.
- 정상 페이지 이동(`setPage(n)`, n이 범위 내)을 방해하면 안 된다.
- 무한 재렌더 루프를 만들지 마라(effect가 매번 setPage를 호출해 리렌더 → effect 재실행 되는 패턴 금지 — 함수형 업데이트 + 동일값이면 React가 리렌더를 생략하도록 `Math.min`이 이미 같은 값을 반환하게 둔다).

`ListPage.jsx`의 pager는 컨트롤러가 노출하는 `page`/`totalPages`/`pageItems`를 그대로 쓰므로, 컨트롤러에서 클램프하면 뷰 변경은 최소화된다. 파생값 방식을 택해 컨트롤러가 노출하는 `page`의 의미가 바뀐다면 `ListPage.jsx`의 pager 표시도 일관되게 맞춰라.

## Acceptance Criteria

```bash
npm run lint                              # ESLint 통과
npm run build                             # 프론트 빌드 에러 없음
npm test                                  # 백엔드 node --test 전부 통과(이 step은 백엔드 무변경 → 그대로 통과)
npm run test:web                          # Vitest 전부 통과(신규 클램프 재현/회귀 테스트 포함)
```

이 step 시작 시점의 전체 테스트(프론트 + 백엔드)를 단 1개도 깨뜨리지 마라. 특히 `useViewController.test.jsx`의 기존 페이징 테스트(`defaults to the desk-unsent menu and pages 10 items` — 25건/3페이지/setPage(3)→5건)가 그대로 통과해야 한다.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - 목록 축소 시 page가 `[1, totalPages]`로 클램프되어 빈 페이지에 갇히지 않는가?
   - 메뉴 변경 시 `setPage(1)` 리셋과 정상 페이지 이동이 깨지지 않는가?
   - 무한 재렌더 루프가 없는가?(함수형 setPage·동일값 단락)
   - transport 직접 호출 없이 Model 계약(ADR-003)만 쓰는가? (이 step은 순수 상태 로직이라 새 Model 호출 추가 불필요)
3. 결과에 따라 `phases/0-mvp/index.json`의 step 17을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 중단

## 금지사항

- `selectMenu`의 `setPage(1)` 리셋을 제거하거나 클램프로 덮어쓰지 마라. 이유: 메뉴 변경 시 1페이지로 가는 것은 의도된 동작이다. 클램프는 "범위를 벗어난 page를 끌어내리는" 안전망일 뿐, 정상 리셋을 대체하지 않는다.
- page를 effect 의존성에 넣고 그 안에서 무조건 setPage를 호출하지 마라. 이유: setPage → 리렌더 → effect 재실행 → 무한 루프가 된다. 함수형 업데이트(`setPage(p => Math.min(p, max))`)로 동일값일 때 React가 리렌더를 생략하게 하라.
- 정상 범위 내 page를 클램프로 깎지 마라. 이유: 사용자가 보던 페이지가 임의로 1로 튀면 안 된다. `Math.min(page, totalPages)`만 적용한다.
- 백엔드/Model 계약/다른 컨트롤러를 건드리지 마라. 이유: 이 버그는 순전히 list 컨트롤러의 클라이언트 상태 문제다. 서버 페이징을 도입하지 마라(범위 밖).
- 본문 contract(step14)·에디터 키입력 결선(step15)·임베드 보안(step16)을 건드리지 마라. 이유: 각각 다른 step의 응집 단위다.
- 기존 테스트를 깨뜨리지 마라.
