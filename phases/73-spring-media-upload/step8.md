# Step 8: uploads-static

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — decisions **(3)**(와이어 단일 지점과 그 유일한 예외) · (7)(경로 단일 출처) · (8)③(traversal) · (22)⑪⑫ · **open_questions (3)(4)**.
- Node 정본: `server/index.js` **560~562행**(`app.use('/uploads', express.static(uploadDir))` — **세션 게이트보다 앞**) · 556~558행(등록 위치 주석) · `docs/ADR.md` **ADR-009**의 '정적 마운트는 이제 `/uploads`와 SPA 루트 둘' 문장.
- 계약(읽기만): `contract/cases/default/media-upload.contract.js` **217~229행**(CRITICAL 주석: 세션을 붙이지 않는다 · capability URL 모델 · `x-uploads-static`).
- 명세(읽기만): `docs/api-contract/openapi.yaml`의 `/api/upload` 절 중 정적 서빙 문단.
- Spring 현행: `web/WebConfig.java` · `web/PathPolicyFilter.java` · `web/RoutePolicy.java` · `web/FilterOrder.java` · `web/CsrfOriginFilter.java` · `web/GlobalErrorHandler.java` · `web/RawContentType.java` · `web/JsonHttp.java` · `test/java/harness/news/web/HandlerInventoryTest.java` · `test/java/harness/news/testsupport/Wire.java`.
- step2 산출물: `service/UploadStore.java`(uploads 루트 도출 방식 — **같은 지점에서 도출하라**).

## 배경 (동결된 사실 · 실측값)

- Node 리포트 실측(`x-uploads-static` 관측 1건): `status 200` · `ok true`(러너가 비-JSON 본문에서는 `res.ok`를 쓴다 — `contract/lib/record.js` 121행) · `reason null` · `bodyKeys []` · **`headers: {"content-type": "image/png"}`**(charset 파라미터 **없음**).
- **세션이 없어도 200**이다. `express.static`이 세션 판독보다 앞에 마운트돼 있고, 비밀은 32-hex 파일명뿐인 **capability URL 모델**이다. **여기에 인증을 요구하면 발행 HTML에 재임베드된 이미지가 외부에서 깨진다.**
- `/uploads/**`는 **39 라우트 인벤토리 밖**이다. `RoutePolicy.match`가 `null`을 돌려주므로 `PathPolicyFilter`는 통과시킨다(넓히지 마라 — 표에 매칭되는 경로만 본다).
- **`@RequestMapping` 핸들러를 붙이면 `HandlerInventoryTest.everyHandlerCorrespondsToARowOfTheEndpointInventory`가 즉시 red다**(인벤토리에 없는 경로에 핸들러가 붙었다). 정적 리소스 핸들러는 `SimpleUrlHandlerMapping`에 등록되어 `RequestMappingHandlerMapping.getHandlerMethods()`에 잡히지 않는다.
- Boot는 기본적으로 `/**` → classpath 정적 위치 핸들러를 이미 갖고 있다. `/uploads/**`를 **더 구체적인 패턴**으로 등록하면 그쪽이 먼저 잡힌다.
- `CsrfOriginFilter`는 GET/HEAD/OPTIONS를 통과시키므로 정적 GET에 영향이 없다. `RequestLogFilter`는 이 경로도 로깅한다(Node도 그렇다).

## 작업

1. **테스트 먼저**: `test/java/harness/news/web/UploadsStaticWireTest.java` — **와이어**로 관측한다(`Wire.send`, 실제 소켓). `@TempDir` DATA_DIR을 `app.data-dir`로 주입하고 그 아래 `uploads/`에 실제 PNG 바이트를 직접 놓는다.
   - `GET /uploads/<32hex>.png` **세션 없이** → **200** · 응답 헤더 라인이 **정확히 `Content-Type: image/png`**(문자열 정확 비교 — 세미콜론·charset이 붙으면 red) · 본문 바이트가 놓은 파일과 동일.
   - `GET /uploads/<없는 파일>.png` → **200이 아니다**(404). 응답 shape을 계약이 관측하지 않으므로 상태코드만 단언하고, 실제로 무엇이 나오는지는 요약에 기록하라.
   - **traversal 거부**: `/uploads/../news.db` · `/uploads/..%2fnews.db` · `/uploads/%2e%2e/news.db` · `/uploads/....//news.db` · 백슬래시 변형 → 전부 **200이 아니다**(그리고 `news.db` 바이트가 본문에 없다).
   - `/uploads/` (디렉토리) → 200이 아니다(디렉토리 목록 노출 0).
   - **다른 확장자**: `.pdf`·`.txt`를 놓고 `Content-Type`이 무엇인지 **관측해 기록**하라(계약은 png 하나만 본다 — 단언은 png만 정확 비교하고 나머지는 기록만 한다. `.txt`에 charset이 붙는지 여부는 divergence 후보다).
   - **`HandlerInventoryTest`가 여전히 green**임을 이 step의 AC로 확인한다(정적 핸들러가 `@RequestMapping` 인벤토리에 나타나면 안 된다).
2. `WebConfig`에 `WebMvcConfigurer` 빈을 추가해 `/uploads/**` → `file:<app.data-dir>/uploads/`를 등록한다. 시그니처 수준 지시:
   - 위치 문자열은 반드시 **`/`로 끝나야** 한다(안 그러면 형제 디렉토리가 열린다).
   - **uploads 루트는 `UploadStore`와 같은 지점에서 도출**한다(`AppProperties.dataDirPath().resolve("uploads")`) — 두 곳이 갈리면 업로드는 성공하는데 서빙은 404가 된다. 도출 로직을 복제하지 말고 공유하라.
   - `@EnableWebMvc`를 붙이지 마라(Boot 기본 설정이 통째로 꺼져 기존 계약이 무너진다).
   - 캐시·ETag·`Cache-Control` 커스터마이즈는 **하지 않는다**(open_questions (4) 기본 결정 — 계약 밖이고, 조건부 요청 304 경로를 새로 열면 표면만 넓어진다).
3. **`Content-Type` 실측 결과에 따른 분기**(open_questions (3)):
   - 정확히 `image/png`가 나오면 **아무것도 더 하지 마라**.
   - 다르게 나오면(예: charset이 붙거나 `application/octet-stream`) **`JsonHttp`·`RawContentType`을 넓히지 말고** 리소스 핸들러 층에서만 교정하라(예: `ResourceHttpRequestHandler`의 미디어타입 결정 경로를 좁게 감싸는 방식). 교정했다면 **왜 필요했는지**를 코드 주석과 step 요약에 남겨라.
4. `server-spring/README.md`는 이 step에서 **고치지 않는다**(문서 갱신은 step10에서 한 번에).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step7 수치) · Failures: 0 · Errors: 0
# → HandlerInventoryTest green (여전히 32 라우트 + ANY /error — 정적 핸들러는 나타나지 않는다)
# → UploadsStaticWireTest green (Content-Type: image/png 정확 일치 · traversal 5종 거부)
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 265관측 (불변 — /uploads는 인벤토리 밖이고 아직 업로드 라우트가 없다)
cd d:/agents/harness && npm test    # → 1328 pass / 0 fail (불변)
```

리포 `uploads/` 32항목 / 6,068,792 B 무변을 확인하라. **리포 `news.db`가 어떤 응답 본문에도 실리지 않았음**을 traversal 테스트로 기계 확인했음을 요약에 적어라.

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **변이 A(세션 요구)**: `RoutePolicy`에 `/uploads/**`를 세션 요구로 넣는다 → '세션 없이 200' 테스트가 red → 원복. **이 변이는 계약도 잡는다**(step9에서 재확인) — 여기서 미리 red를 봐 두어라.
2. **변이 B(Content-Type)**: 리소스 핸들러 대신 `@GetMapping`으로 바이트를 쓰고 `response.setContentType("image/png")`를 쓴다 → **두 가지가 함께 red**여야 한다: (i) `HandlerInventoryTest`(인벤토리 밖 핸들러) (ii) `Content-Type` 정확 비교(Tomcat 재조립 여부를 실측으로 확인 — 결과를 요약에 적어라). 원복.
3. **변이 C(경로 도출)**: 리소스 위치를 `file:uploads/`(상대)로 바꾼다 → `@TempDir` 기반 테스트가 red → 원복. **원복 후 리포 루트에 `uploads/` 새 파일이 생기지 않았는지 반드시 점검하라.**
4. **변이 D(위치 접미 슬래시)**: 위치 문자열 끝의 `/`를 뺀다 → traversal/형제 디렉토리 테스트가 red인지 확인 → 원복. red가 안 나면 형제 디렉토리 접근 케이스를 테스트에 추가하라.
5. **변이 E(디렉토리 목록)**: 목록을 노출하는 설정을 켠다 → `/uploads/` 케이스가 red → 원복.

## 금지사항

- **`/uploads/**`에 `@RequestMapping` 핸들러를 붙이지 마라.** 이유: `HandlerInventoryTest`가 '인벤토리에 없는 경로에 핸들러가 붙었다'로 red를 낸다 — 그 게이트를 우회하려고 인벤토리에 행을 추가하는 것은 **계약 명세(`docs/api-contract/**`) 수정**이므로 절대 금지다.
- **`RoutePolicy`에 `/uploads` 행을 추가하지 마라.** 이유: 정적 서빙에 세션을 요구하면 발행 HTML의 재임베드 이미지가 외부에서 깨진다(계약 파일이 CRITICAL로 명시한 축이다).
- **`@EnableWebMvc`를 쓰지 마라.** 이유: Boot 기본 MVC 설정이 통째로 꺼져 기존 39 라우트의 동작이 함께 움직인다.
- **`RawContentType`/`JsonHttp`를 정적 경로로 넓히지 마라.** 이유: 그 클래스는 seam이 없으면 던지도록 설계된 **JSON 전용** 지점이고, 넓히면 와이어 단일 지점 규율이 무너진다.
- **SPA 정적 서빙을 함께 도입하지 마라.** 이유: `Accept: text/html` 판정·`/api`·`/uploads` 제외 규칙이 딸린 별도 계약이고 계약 스위트가 관측하지 않는다(excluded (i)).
- **ETag·`Cache-Control`을 Node에 맞추려 하지 마라.** 이유: 계약 리포트가 싣지 않는 헤더이고(허용 목록 밖), 조건부 요청 304 경로를 새로 열면 표면만 넓어진다(open_questions (4)).
- **업로드 라우트를 만들지 마라.** 이유: 결선은 step9다.
