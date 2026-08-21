# Step 7: article-crud-http

기사 단건의 **HTTP 표면 3개**를 만든다: `POST /api/articles`(생성) · `GET /api/articles/:id`(단건 조회) · `PUT /api/articles/:id`(부분 수정). 컨트롤러는 신원 재도출 · 게이트 호출 · **신뢰 경계 stamp** · shape 매핑만 한다.

이 step이 끝나도 계약 파일은 green이 되지 않는다(`articles-write.contract.js`는 잠금 3라우트와 `action`이 더 필요하다 — index.json `order` (a)). 판정은 **Java 와이어 테스트 + 지정된 진단 실행의 실패 서명**으로 한다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(8)(12)(13)(14)(15)(19)(20)(22)(23)**
- `server/index.js` 811~822행(단건 조회) · 853~875행(생성) · 926~950행(부분 수정) — **이식 원본**. 특히 생성의 `delete dto.role` · `if (!dto.department)` · `if (!dto.author) dto.author = me.name || me.userId`, 수정의 `fields.modifier = me.userId` · `delete fields.role` · `'department' in fields && !fields.department`
- `server/index.js` 378~390행 — `FILTER_KEYS`는 목록 라우트 것이다(이 step에는 없다 — step11)
- `contract/cases/default/articles-write.contract.js` 88~185행(생성 3케이스: 성공 stamp · 신뢰 경계 · `action:'hold'` 초기 상태) · 306~418행(수정: 보유자 인가 · 화이트리스트 · 404 우선순위)
- `contract/cases/default/articles-read.contract.js` 436~460행 — 단건 조회의 봉투 3키·`article` 5키·`contents` 27키·없는 id 404
- `server-spring/src/main/java/harness/news/controller/UsersController.java` — 게이트 → 본문 순서, `JsonHttp` 사용, 경로 변수 처리의 기존 패턴
- `server-spring/src/main/java/harness/news/web/{JsonHttp,ReasonStatus,SessionTokens,RoutePolicy}.java`
- `server-spring/src/test/java/harness/news/web/PathPolicyWireTest.java` **104~110행** — 인증된 `GET /api/articles`를 404로 단언하는 스텁 금지 프로브(**이 step이 재조준해야 하는 대상** — 작업 C)
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` **98~109행** — 구현 라우트 목록과 **메서드명·실패 메시지에 박힌 라우트 수 표기**(행 추가 시 함께 갱신)
- step4(읽기 서비스) · step5(쓰기 서비스) · step6(잠금 서비스) 산출물

## 배경 (동결된 계약 사실)

- **생성**: 200 `{ok:true, articleId}` **정확히 2키**. 서버가 stamp하는 것 = 초기 `status`(세션 role + 의도 `action`) · 부서 2종(미전달·빈 값이면 세션 부서) · 작성자(미전달·빈 값이면 세션 사용자 이름, 없으면 userId). **클라가 보낸 `author`는 명시되면 보존된다**(대필 입력 — 무시하지 마라). 클라의 `role`·`status`·`articleId`·`sender`·`distributedAt`은 반영되지 않는다.
- 생성의 역할 게이트는 **R/D/Z 집합**이다(그 밖의 role은 403 `forbidden` — 계약 도달 불가지만 구현한다).
- **단건 조회**: 200 `{ok:true, article, contents}` **정확히 3키**. 없으면 404 `{ok:false, reason:'not-found'}`.
- **부분 수정**: 세션 → **존재(404) → 보유자(403 `not-holder`)** → 저장 → 200 `{ok:true, changes}`. `changes`는 두 갱신문의 합이고 리포트가 그 정수를 비교한다. `modifier`는 **세션 사용자로 덮어쓴다**(클라 값 무시). 부서 키가 **있는데 빈 값**이면 세션 부서로 보정하고, 키가 아예 없으면 건드리지 않는다.
- 잠금 보유 판정에 쓰는 탭 식별자는 `x-edit-client` 헤더다. **헤더가 없으면 없는 것**이며(빈 문자열로 바꾸지 마라) 그 상태에서 보유자 검사는 거부로 수렴한다(step6 decisions (11)).
- 응답은 전부 `JsonHttp` 한 지점으로 쓴다(decisions (22)).

## 작업

### A. Node 대조 리포트 실측 (구현 전, decisions (23))

```bash
cd /d/agents/harness && OUT="$(mktemp -d)" && node scripts/contract-run.mjs --profile default --files contract/cases/default/articles-write.contract.js --out "$OUT/node-articles-write.json" && ls -l "$OUT"
```

`articles-create`·`articles-update`·`articles-get` 관측의 `status`·`bodyKeys`·`values`(특히 **`changes`의 실제 정수**)·`content-type`을 확인하고 요약에 적는다. 리포트는 **리포 밖**에만 쓴다. `$TMPDIR`를 쓰지 마라 — win32 Git Bash에서 비어 있을 수 있어 경로가 `/node-articles-write.json`으로 펴진다. `mktemp -d`를 쓰고, 없는 셸이면 `${TMPDIR:-${TMP:-/tmp}}` 폴백으로 디렉토리를 만들어 쓴다(실제 경로를 요약에 남긴다 — step8이 같은 리포트를 다시 읽는다).

### B. 컨트롤러 3개

- **공통**: 쿠키 우선·`x-session-id` 폴백으로 토큰을 읽어 신원을 재도출한다. 신원이 없으면 401 `unauthenticated`(경로 정책 필터가 먼저 끊지만 컨트롤러도 자기 판정을 갖는다 — decisions (14)).
- **생성**: 역할 집합 확인 → 본문 맵을 dto로 복사하며 `role` 키 제거 → 부서·작성자 보정 → 서비스 호출(의도 `action`은 본문에서 그대로 전달) → `{ok:true, articleId}`.
- **단건 조회**: 서비스 결과가 없으면 404, 있으면 봉투 3키. 한쪽 테이블 행이 없으면 그 키를 **싣지 않는다**(decisions (20)).
- **부분 수정**: 보유자 검사(step6) → 실패 사유를 상태코드로 매핑(`not-found` 404 · `not-holder` 403) → 필드 맵에 `modifier` 세션 stamp · `role` 제거 · 빈 부서 보정 → 서비스 호출 → `{ok:true, changes}`.
- **값 취급**: 본문 맵의 값을 **그대로** 서비스·리포지토리로 넘긴다(`JsonHttp.text` 같은 문자열 전용 헬퍼로 걸러 null로 떨구지 마라 — decisions (8)). 빈 값 판정(부서·작성자 보정)은 Node의 falsy 의미론(`null`·빈 문자열·0·false)과 같게 한다.
- 사유 토큰 매핑은 `ReasonStatus`에 이 step이 도달하는 것만 추가한다(`not-found` 404 · `not-holder` 403 — decisions (19)).

### C. 인벤토리 갱신 + **기존 Java 테스트 파급 처리**

- `HandlerInventoryTest`의 구현 라우트 목록(`IMPLEMENTED_ROUTES`)에 3행을 추가한다(스텁 금지 게이트). **같은 step에서 그 테스트의 메서드명·실패 메시지에 박힌 라우트 수 표기도 갱신한다**(`exactlyTheSevenImplementedRoutesHaveHandlers`·실패 메시지의 '7 라우트' — step0이 이미 한 번 올렸으므로 현재 수치를 확인하고 맞춰라). **scope 표는 이 step에서 늘리지 않는다**(green이 되는 지점이 아니다 — index.json `order` (e)).
- **`PathPolicyWireTest`의 미구현 라우트 프로브를 재조준한다(필수 — 하지 않으면 AC 1번이 통과할 수 없다).** `server-spring/src/test/java/harness/news/web/PathPolicyWireTest.java:104-110`의 `authenticatedRequestToAnUnimplementedRouteIs404NotAStub`는 **인증된 `GET /api/articles` → 404 + `text/html`**을 스텁 금지 증거로 하드코딩한다. 이 step이 `POST /api/articles` 매핑을 붙이는 순간 그 GET은 **405 + Boot `/error` JSON**이 된다(경로에 매핑은 있고 메서드가 없다 — phase 68 forward_notes (13)이 `/api/users`에서 같은 전이를 실측했다). 그리고 step11에서 `GET /api/articles`가 구현되면 **200**이 된다.
  - 조치: 프로브 경로를 **이 phase 내내 미구현으로 남는 라우트**(예: `GET /api/media/search` — index.json excluded (b))로 바꾼다. 새 경로가 `RoutePolicy` 표에 있고 이 phase가 구현하지 않는다는 것을 확인한 뒤 고른다.
  - **테스트를 삭제하거나 단언을 약화하지 마라**(404를 405 허용으로 바꾸는 것도 약화다). 이유: 그 단언이 '스텁 0'을 지키는 게이트이며, 없애면 이후 어떤 step도 스텁을 만들 수 있게 된다.
  - 같은 파일의 `deadTokenOnAProtectedRouteIs401`·후행 슬래시 케이스는 **필터 단계에서 끊기므로 그대로 401**이다 — 건드리지 마라.
  - `server-spring/src/test/**`에서 `/api/articles`를 **미구현 전제**로 쓰는 단언이 더 있는지 검색하고(예: 404·text/html 단언) 같은 규율로 처리한다. 처리한 목록과 재조준한 경로를 요약에 적는다.

### D. 테스트 (먼저 쓴다 — 전 기동 `RANDOM_PORT` + 원시 HTTP, MockMvc 금지)

계약 케이스의 단언을 Java 와이어 테스트로 **선반영**한다(계약은 step10에서 green이 된다).

1. 생성 200 2키 · `articleId` 형식 · 되읽기로 `status`=`RDS`·작성자·부서가 세션 값으로 stamp됐다.
2. 생성 신뢰 경계: `role`/`status`/`articleId`/`sender`/`distributedAt`을 보내도 반영되지 않고 **명시한 `author`만 보존**된다.
3. 생성 + `action:'hold'`: D→`DDH` · R→`RRH`.
4. 단건 조회 200 3키 · `contents` 27키 · `article` 5키 · **잠긴 기사에서도 두 잠금 컬럼이 없다** · 없는 id 404.
5. 수정: 잠금 없이 → 403 `not-holder` · 보유 탭 → 200 `changes`가 **Node 실측값과 같다** · 같은 세션의 다른 탭 → 403.
6. 수정 404가 403보다 먼저다(없는 기사 + 아무 탭).
7. 수정 화이트리스트: `status`/`sender`/`articleId`/`role`/`modifier`를 보내도 무시되고 `modifier`는 세션 사용자다 · 빈 부서는 세션 부서로 보정된다.
8. 미인증 3라우트 전부 401 JSON(경로 정책 필터 경유) · **`x-edit-client`만 붙인 요청도 401**(탭 헤더는 인증 수단이 아니다).
9. 인코딩·경로 파라미터 우회 확인: `/api/artic%6Ces/<id>`류·`;k=v`가 붙은 경로에서도 미인증이면 401이고 인증되면 정상 동작한다(68 forward_notes (10)(20) 승계 — 새 핸들러가 붙었으므로 **이제 실제 도달이 가능해졌다**).
10. Content-Type이 `application/json; charset=utf-8`(세미콜론 뒤 공백 1바이트 포함)이다.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- **이 블록의 5개 커맨드만 exit 0 대상이다**(AC = exit 0 게이트). 아래 검증 절차의 **진단 실행은 AC가 아니며 실패가 정상**이다 — AC 블록에 넣지 마라(④ 테스터가 정상 red를 회귀로 오판한다).
- 1번: exit 0 · failures/errors 0. **작업 C의 프로브 재조준을 하지 않으면 이 커맨드는 통과할 수 없다**(`PathPolicyWireTest`의 미구현 프로브가 405로 뒤집힌다).
- 3번은 무회귀 확인(관측 수 step0과 동일 · `diffs=0`) — 이 step은 scope 표를 늘리지 않는다.

## 검증 절차

1. red 먼저(D의 10군). 특히 9번(인코딩 우회)의 red/green을 실측해 적는다.
2. AC 실행. Java 테스트 수 증가분 기록.
3. **진단 실행(AC 아님 — 실패가 정상이다)**: 아래를 1회 돌리고 실패 지점을 기록한다. **exit 코드로 판정하지 마라**(0이 아닌 것이 이 시점의 정상이다).
   ```bash
   cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile default --files contract/cases/default/articles-write.contract.js
   ```
   이 시점에는 **잠금 3라우트와 `action` 미구현 때문에 실패하는 것이 정상**이다. 확인할 것: 생성·단건 조회·미인증 케이스는 통과하고, 실패가 **잠금/송고 픽스처에서만** 나는가. 그 서명을 요약에 적는다(step8·step10의 잔여 범위를 확정하는 관측이다). 실패가 그 밖의 케이스에서도 나면 그것은 이 step의 결함이다.
4. **인코딩 경로 divergence 실측·기록(고치지 마라)**: 핸들러가 붙었으므로 **인증된** 퍼센트 인코딩 경로(`/api/artic%6Ces/<id>` 등)가 Spring에서는 디스패처의 디코딩 매칭으로 **정상 동작(200)**하고 Node에서는 라우트에 매칭되지 않아 **404**가 될 수 있다. 두 서버에 같은 요청을 넣어 상태코드를 **실측**하고 결과를 요약에 적는다(계약이 관측하지 않는 축이다 — 계약 관측 축인 '미인증이면 401'은 D의 9번이 잠근다). **Spring의 매칭 동작을 바꾸지 마라**: 폐색·기록만 하고 step12 forward_notes로 인계한다(라우트를 늘리는 후속 phase마다 같은 divergence가 생기므로 경로 정규화 정책은 별도 판단이다).
5. **변이 실증 3종**(확인 후 원복): (a) `modifier`를 클라 값으로 두면 7번이 red인가(권한/감사 위조 재현 — 반드시 원복) (b) 수정에서 존재 검사와 보유자 검사의 순서를 바꾸면 6번이 red인가 (c) 생성에서 명시 `author`를 무시하면 2번이 red인가.
6. **DB 비파괴 확인**: 이 step의 테스트·진단 실행이 만든 기사 행은 전부 임시 DB 안이며 리포 `news.db`는 무변(하네스 단언 + 크기·mtime 눈 확인).
7. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/{controller,web}/**` · `server-spring/src/test/**`(프로브 재조준 포함) · `phases/69-spring-articles/index.json`.
8. index.json step7 status·summary 갱신(진단 실행의 실패 서명 · 프로브 재조준 경로 · 인코딩 divergence 실측 포함).

## 금지사항

- 스텁을 만들지 마라(빈 배열·`ok:true` 고정 응답). 이유: 계약 스위트가 아직 그 라우트를 돌리지 않으므로 **모든 게이트에 보이지 않는 착시**가 된다 — `HandlerInventoryTest`가 그 구멍을 막으려고 존재한다.
- `PathPolicyWireTest`의 스텁 금지 프로브를 삭제·비활성(`@Disabled`)·약화(405 허용·상태코드 단언 제거)하지 마라. 이유: 그 단언이 '스텁 0'을 지키는 유일한 와이어 게이트다 — 경로만 미구현 라우트로 재조준하는 것이 정답이고, 없애면 이후 어떤 step도 스텁을 만들 수 있게 된다.
- 인코딩 경로 divergence를 '고치려고' 디스패처 매칭·인코딩 설정을 손대지 마라. 이유: 계약이 관측하지 않는 축이고, 매칭 정책 변경은 39 라우트 전부의 경로 판정에 영향을 준다 — 실측·기록 후 폐색이 이 phase의 처분이다.
- 요청 본문·헤더의 `role`을 판정에 쓰지 마라. 이유: acting role은 검증된 세션에서만 도출한다(ADR-004).
- `x-edit-client` 헤더만으로 저장을 인가하지 마라. 이유: 클라이언트가 만든 문자열이다 — 인가는 세션 userId와 함께 판정한다.
- 헤더 부재를 빈 문자열로 정규화하지 마라. 이유: step6의 값 동등성 규칙(decisions (11))이 '둘 다 비어 있으면 거부'에 의존한다 — 정규화하면 인가 구멍이 열린다.
- 응답을 Spring MVC 메시지 컨버터로 `return`하지 마라. 이유: Content-Type이 컨테이너에서 재조립돼 세미콜론 뒤 공백이 사라지고 전 관측이 diff가 된다(decisions (22)).
- 새 게이트에서 경로 문자열을 직접 비교하지 마라. 이유: 후행 슬래시·경로 파라미터·퍼센트 인코딩 정규화는 `RoutePolicy` 한 곳이 소유한다(68 forward_notes (10)(20)의 실측 우회 2건).
- 목록·검색·이력 라우트를 여기서 만들지 마라. 이유: step11의 범위이며 한 step에 여러 모듈을 넣으면 실패 원인 격리가 무너진다.
