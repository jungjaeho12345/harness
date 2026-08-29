# Step 9: media-upload-http  (**GREEN — 계약 1파일 31관측**)

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — **전문**. 특히 decisions (1)(계약이 5 라우트를 강제한다) · (3) · (8) · (9)(프로브 재조준) · (16)(ReasonStatus 무접촉) · (17)(계층·컨트롤러 배치).
- 계약(읽기만, 그러나 **전문을 읽어라**): `contract/cases/default/media-upload.contract.js`.
- Node 정본: `server/index.js` 912~923행(translate) · 993~1002행(media) · 1011~1043행(upload) · 1048~1065행(photos 2).
- Spring 현행: `web/RoutePolicy.java` 155·160~163행(5 라우트가 **이미 `AuthClass.SESSION`으로 등재돼 있다** — 표를 고칠 일이 없다) · `web/JsonHttp.java` · `web/ReasonStatus.java` · `web/SessionTokens.java` · `web/PathPolicyFilter.java` · `controller/ArticlesController.java` · `controller/DistributionController.java`(컨트롤러 형태의 최신 선례) · `test/java/harness/news/web/HandlerInventoryTest.java` · `test/java/harness/news/web/PathPolicyWireTest.java` 107~126행 · `test/java/harness/news/controller/ControllerProjectionBoundaryTest.java`.
- 하네스: `scripts/spring-contract.mjs` 68~100행(**default 프로파일 files 목록 — 알파벳 정렬 순서**).
- step0~step8 산출물 전부.

## 배경 (동결된 사실)

- 이 step이 붙이는 라우트는 **5개**다: `GET /api/media/search` · `POST /api/upload` · `POST /api/photos` · `GET /api/photos/search` · `POST /api/articles/{id}/translate`. 구현 라우트는 **32 → 37**이 된다.
- **5개를 절반만 붙일 수 없다.** 계약 파일이 하나이고 5 라우트를 모두 관측하므로 부분 결선은 확정 red다.
- 계약 실측 목표치: `--profile default --files contract/cases/default/media-upload.contract.js` → `cases=31 covered=5/39` · **observation 31건**(`articles-translate` 4 · `media-search` 6 · `photos-create` 8 · `photos-search` 3 · `upload` 9 · `x-uploads-static` 1). 전체 `--parity`는 **default 198 → 229 · 총 265 → 296관측 diffs 0**.
- **default 프로파일 files 목록은 알파벳 정렬 순서다.** `media-upload.contract.js`는 `health.contract.js`와 `receiver-config.contract.js` **사이**에 들어간다(`distribution-tick` < `health` < `media-upload` < `receiver-config`). 순서를 어기면 러너의 디렉토리 스캔 순서와 어긋나고 `auth.contract.js`의 공용 세션 복구 규약이 뒤 파일에 이어지지 않는다.
- 사유 토큰 `invalid-file`·`too-large`·`invalid-src`는 **라우트 직접 400**이다. `ReasonStatus`는 **무접촉**이다.
- `RoutePolicy`도 **무접촉**이다(5 라우트가 이미 등재돼 있다). 미인증 401은 `PathPolicyFilter`가 만들고 계약의 5건 unauth 관측이 그것을 본다.

## 작업

1. **테스트 먼저 — 와이어 테스트 4벌**(`test/java/harness/news/controller/`):
   - `MediaWireTest`: 200 · `bodyKeys` 3종 · `error:false` · image 6/video 4 · type 정규화 3변형 · 2회 호출 동일 · 미인증 401.
   - `UploadWireTest`: png 200(`path` 정규식·`filename` 원문 반향) · `.PNG` 소문자화 · 14종 전수 200 · 거부 4종 400 `invalid-file` · 6MB 400 `too-large` · 미인증 401 · **응답 전문에 드라이브 문자로 시작하는 절대경로·경로 구분자 0건**.
   - `PhotosWireTest`: 등록 2종 200 `{ok,id}` · 거부 4종 400 `invalid-src`와 **행 미생성**(되읽기) · body의 `registeredBy` 무시(세션 stamp 되읽기) · 검색 6키·id DESC · 빈 `q`/`q` 생략 동일 · 미인증 401 2건.
   - `TranslateWireTest`: `no-key` 200 3키 · 없는 기사 404 · 미인증 401 · **`targetLang` 지정도 같은 결과**.
   - 모든 와이어 테스트는 **응답 헤더 라인이 `Content-Type: application/json; charset=utf-8`**(세미콜론 뒤 공백 포함)임을 정확 비교로 단언한다.
2. 컨트롤러를 만든다(**shape 매핑만** — 검증·투영·시계·외부 호출은 전부 서비스가 소유한다):
   - `controller/MediaController.java` — `GET /api/media/search`. **`q`·`type`은 반복 키를 값 리스트로** 넘긴다(`@RequestParam(required=false) List<String>` 또는 `HttpServletRequest.getParameterValues` — 첫 값으로 접지 마라). 응답은 서비스 결과에서 `{ok:true, items, error}` **3키만** 재조립한다(`demo` 플래그를 싣지 마라).
   - `controller/UploadController.java` — `POST /api/upload`. body는 `JsonHttp.readBody`로 읽고 **문자열 여부 판정은 서비스가 한다**(컨트롤러는 `body.get("filename")`·`body.get("contentBase64")`를 `Object`로 그대로 넘긴다 — `JsonHttp.text(...)`로 미리 접으면 '숫자 12345' 케이스가 `content-missing`과 구분되지 않는다). 실패 시 **400 고정**(`ReasonStatus`를 거치지 마라 — Node도 라우트 직접이다).
   - `controller/PhotosController.java` — `POST /api/photos` · `GET /api/photos/search`. body에서 `src`·`caption`·`sourceArticleId` **셋만** 꺼내 넘긴다(**`registeredBy`를 읽지 마라**). `userId`는 세션에서 재도출한 값만 쓴다. 실패는 400 고정.
   - `controller/ArticlesController.java`에 `POST /api/articles/{id}/translate` 매핑 1개를 추가한다(open_questions (5) 기본 결정). 없는 기사 404 `not-found`는 `ReasonStatus.of("not-found")` 기존 경로를 쓴다. 성공/실패 모두 **200**으로 서비스 객체를 그대로 쓴다.
   - 응답은 예외 없이 **`JsonHttp.write`** 한 지점으로 쓴다. 메시지 컨버터로 값을 `return`하지 마라.
   - 세션 판독은 기존 `SessionTokens`(쿠키 우선 · `x-session-id` 폴백)만 쓴다. **쿼리에서 토큰을 읽지 마라.**
3. `HandlerInventoryTest.IMPLEMENTED_ROUTES`에 **5행을 추가**한다(32 → 37). 같은 커밋에서:
   - 테스트 메서드 이름 `exactlyTheThirtyTwoImplementedRoutesHaveHandlers` → **37로** 고치고 실패 메시지의 수치도 고친다.
   - 클래스 javadoc의 목록 설명에 'phase 73 step9의 미디어·업로드·사진·번역 5개'를 추가한다.
4. `scripts/spring-contract.mjs`의 default 프로파일 `files`에 **`'contract/cases/default/media-upload.contract.js'`를 알파벳 순서 자리에** 넣고, 위 행들과 같은 형식의 주석 1줄(`// phase 73 step9 — 미디어·업로드·사진·번역 5라우트가 붙으면서 green이 됐다(...)`)을 단다. **다른 줄은 건드리지 마라.**
5. `PathPolicyWireTest.authenticatedRequestToAnUnimplementedRouteIs404NotAStub`의 프로브를 **`GET /api/media/search` → `GET /api/stream`**으로 재조준한다. javadoc에 재조준 이력과 **다음 규칙**(index.json decisions (9))을 남긴다. 단언(404 + `Content-Type: text/html; charset=utf-8`)은 **그대로 유지**한다.
6. 리포트 위생: 계약 실행 후 **5개 리포트 전문**에서 64-hex 세션 토큰 · 시드 비밀번호 · 32-hex 업로드 파일명 · 드라이브 문자로 시작하는 절대경로가 **0건**임을 확인하라.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step8 수치) · Failures: 0 · Errors: 0
# → HandlerInventoryTest green (정확히 37 라우트 + ANY /error)
# → ControllerProjectionBoundaryTest green · ResponseBodyProjectionGuardTest green
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests

# (1) 새 계약 파일만 단독으로 — 실패 원인을 이 파일로 좁힌다
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs \
  --profile default --files contract/cases/default/media-upload.contract.js
# → exit 0 · cases=31 · covered=5/39

# (2) default 프로파일 전체 — 기존 파일과의 간섭(업로드 파일 잔존·픽스처 충돌)을 본다
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile default
# → exit 0 · files=12 · cases=194 (163 + 31)

# (3) 전체 패리티
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 관측 229/55/4/5/3 = 296

cd d:/agents/harness && npm test    # → 1328 pass / 0 fail (불변)
cd d:/agents/harness && npm run lint && npm run build   # → exit 0
cd d:/agents/harness && node scripts/contract-inventory-check.mjs --require-spec-paths
# → exit 0 · routes=39 · spec-paths=39/39
cd d:/agents/harness && npm run test:contract -- --require-full-coverage
# → exit 0 · profiles=5 cases=274 covered=39/39   (Node 대상 — 정본 무수정의 증거)
```

리포 `uploads/` **32항목 / 6,068,792 B 무변** · 리포 `news.db` 크기·mtime 무변 · 하네스가 띄운 java 프로세스 잔존 0.

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **AC (1)이 먼저 green이 된 뒤에 (2)(3)을 돌려라.** (1)이 red인데 (3)을 보면 실패 원인이 기존 11파일과 섞인다.
2. **변이 A(스텁 착시)**: `MediaController`가 `{ok:true, items:[], error:false}`를 돌려주게 한다 → 계약이 `items.length > 0`에서 red → 원복. (이 변이가 `HandlerInventoryTest`만으로는 안 잡힌다는 것을 확인하라 — 스텁 금지 게이트는 '핸들러 존재'만 보고 계약이 '내용'을 본다.)
3. **변이 B(신원 위조)**: `PhotosController`가 body의 `registeredBy`를 서비스에 넘기게 한다 → 계약 `registered-by-session` 케이스가 red → 원복.
4. **변이 C(정적 서빙 인증)**: `RoutePolicy`에 `/uploads` 세션 요구를 넣는다 → 계약 `x-uploads-static` 관측이 **401**이 되어 red → 원복.
5. **변이 D(와이어 포맷)**: 컨트롤러 하나에서 `JsonHttp.write` 대신 값을 `return`한다 → `--parity`가 그 라우트의 `content-type` diff로 red → 원복. **기능 테스트는 통과하는데 패리티만 red인 것**을 눈으로 확인하고 요약에 적어라(이 프로젝트가 계약 diff를 판정 기준으로 삼는 이유다).
6. **변이 E(반복 키)**: `MediaController`가 `type`의 첫 값만 쓰게 한다 → 계약은 **green이다**(계약이 반복 키를 보내지 않는다) → step6의 Java 테스트만 red인지 확인 → 원복. 이 사실을 요약에 적어라(계약이 못 보는 축의 실증).
7. **변이 F(scope 표 누락)**: `spring-contract.mjs`의 새 행을 지운 채 `mvnw verify`를 돌린다 → `HandlerInventoryTest`는 **green이다**(목록만 보면 통과한다) → 그래서 '목록 갱신 = 계약도 같이 늘렸다는 선언'이라는 규율이 사람의 규율임을 확인하고 원복. AC (3)의 관측 수 296이 그 규율의 기계 증거다.
8. 계약 리포트를 `--keep`으로 보존해 위생 검사(토큰·비밀번호·hex 파일명·절대경로 0건)를 하고 **확인 후 직접 삭제**하라(리포 밖).

## 금지사항

- **5 라우트를 나눠 붙이지 마라.** 이유: 계약 파일이 하나라 부분 결선은 확정 red이고, `IMPLEMENTED_ROUTES`만 먼저 늘리면 '구현했는데 계약이 관측하지 않는 라우트 0개' 불변식이 깨진다.
- **`docs/api-contract/**`·`contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`를 고치지 마라.** 이유: 정본 무수정이 이 포팅의 전제다. 계약이 틀렸다고 판단되면 고치지 말고 forward_notes에 적어라.
- **`scripts/spring-contract.mjs`에서 scope 표 1행 외의 것을 고치지 마라.** 이유: 프로파일 축·env 주입은 71a 자산이고 두 대상의 구성이 갈리면 구성 차이가 계약 차이로 위장된다.
- **`ReasonStatus`·`RoutePolicy`를 고치지 마라.** 이유: 5 라우트가 이미 표에 있고 사유 3종은 라우트 직접 400이다(검증되지 않은 표 확대 금지).
- **컨트롤러에서 검증·투영·시계·외부 호출을 하지 마라.** 이유: ADR-006·ADR-013 계층이고 `ControllerProjectionBoundaryTest`가 타입 경계를 정적으로 잠근다.
- **`PathPolicyWireTest`의 프로브 단언을 지우거나 405를 허용으로 넓히지 마라.** 이유: 스텁 0을 지키는 유일한 와이어 게이트가 사라진다.
- **업로드 응답에 서버 절대경로·디렉토리 이름을 싣지 마라.** 이유: 응답이 곧 파일시스템 구조 노출이다(72 tick 규율과 동형).
