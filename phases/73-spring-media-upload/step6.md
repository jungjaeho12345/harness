# Step 6: media-search-service

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — decisions **(13)**(데모 폴백의 계약 밖 축 5종) · **(14)**(반복 쿼리 키) · (20) · (22)⑥⑦.
- Node 정본: `src/services/mediaSearch.js` **전문**(특히 `DEMO_VIDEO_IDS` · `demoResults` · `normalizeType` · `buildUrl` · `search`) · `server/index.js` 993~1002행(라우트가 `{ok:true, items, error}` 3키로 **재조립**하고 서비스의 `demo` 플래그를 떨군다) · `src/controllers/index.js` 181~183행.
- 계약(읽기만): `contract/cases/default/media-upload.contract.js` 41~42행·78~148행.
- 명세(읽기만): `docs/api-contract/openapi.yaml`의 `/api/media/search` 절 · `MediaImageItem`/`MediaVideoItem`/`MediaSearchResponse` 스키마.
- Spring 선례: `service/NodeString.java`(공백 판정 단일 출처) · `service/CollectionService.java`(어댑터 실패를 값으로 접는 형태).
- step5 산출물: `service/ExternalProxyClient.java` · `service/HttpExternalProxyClient.java`(**이식은 ② 검토에서 확정됐다 — 조건부가 아니다. 아래 '키 있음 경로'를 축약하지 마라**).

## 배경 (동결된 사실)

- **응답 키는 정확히 3종**(`ok`·`items`·`error`)이고 `ok`는 **언제나 true**다. 실패는 `error: true` **불리언 플래그**로만 표현된다(사유 토큰이 아니다). 서비스가 내부적으로 붙이는 `demo: true`는 **라우트가 떨군다**.
- 키가 없으면 **외부 호출을 아예 하지 않고** 결정적 데모 폴백을 준다:
  - 시드 `q = String(query ?? '').trim() || '뉴스'`
  - image: **6건**, 원소는 `{title: "<q> 이미지 <i+1> (데모)", link: "https://picsum.photos/seed/<encodeURIComponent(q)>-<i>/320/200"}` (i = 0..5)
  - video: **4건**, `DEMO_VIDEO_IDS = ['aqz-KE-bpKQ','jNQXAC9IVRw','ScMzIvxBSi4','YE7VzlLtp-4']`, 원소는 `{title: "<q> 관련 영상 <i+1> (데모)", videoId: id, url: "https://www.youtube.com/watch?v=<id>"}`
- `normalizeType(type)`: `type === 'image'`면 image, **그 밖은 전부 video**(누락·이상값·배열 포함).
- **계약이 관측하는 것은 4가지뿐**이다(리포트 실측): `bodyKeys=[error,items,ok]` · `error:false` · `itemKeys`(`link,title` / `title,url,videoId`) · `itemCount`(**image 6 · video 4**). **제목 문자열·link URL·videoId 값·`encodeURIComponent` 결과는 리포트에 실리지 않는다.** 계약 파일 안의 `deepEqual`은 같은 서버 2회 호출 비교라 서버 간 차이를 잡지 못한다. → **이 step의 테스트가 유일 방어선**이다.
- Java `URLEncoder.encode`는 `encodeURIComponent`가 **아니다**: 공백을 `+`로 바꾸고 `!`·`'`·`(`·`)`·`~`·`*`의 처리가 다르다. `encodeURIComponent`의 비예약 집합은 `A-Za-z0-9 - _ . ! ~ * ' ( )`이고 나머지는 UTF-8 바이트를 **대문자 hex**로 퍼센트 인코딩한다.
- 계약 질의는 ASCII `contract-media-q`뿐이라 인코딩 축은 **전부 계약 밖**이다.

## 작업

1. **테스트 먼저**: `service/NodeUriTest.java`(또는 동등) — `encodeURIComponent` 이식의 표.
   리포 **밖** 스크립트로 Node 실측표를 뽑아 대조하라. 최소 포함: 공백 · `한글` · `!'()~*` · `-_.` · `/?&=+#%` · `€`(3바이트) · 이모지(서러게이트 페어) · 제어문자 · `+`.
   **대조군 단언**: 같은 입력에서 `URLEncoder.encode(s, UTF_8)`와 결과가 **다른** 케이스를 최소 3건 명시적으로 단언하라(표준 API로 갈음할 수 없다는 증명).
2. `harness.news.service.NodeUri`(또는 `NodeString`에 이웃하는 이름)에 `encodeURIComponent(String)`를 만든다. **문자가 아니라 UTF-8 바이트 단위로** 인코딩하고 hex는 대문자로 낸다.
3. **테스트 먼저**: `service/MediaSearchServiceTest.java`(가짜 `ExternalProxyClient` 주입 — 네트워크 없음).
   - **키 없음 경로**: 어댑터가 **한 번도 호출되지 않는다**(호출 횟수 0 단언 — Node가 `buildUrl` undefined에서 즉시 반환하는 것의 등가물).
   - image 6건 / video 4건 · 각 원소의 **키 집합과 값 전체**를 문자열로 단언한다(제목·link·videoId·url 전부).
   - 시드 정규화: `null`·`""`·`"  "`·NBSP만 있는 문자열 → `'뉴스'`. **`NodeString.trim`을 쓴다**(`String.trim()`/`strip()` 둘 다 NBSP·BOM에서 틀린다 — 그 사실을 대조 단언으로 남겨라).
   - **반복 쿼리 키**: `q = List.of("a","b")` → 시드 `'a,b'` · `type = List.of("image","video")` → **video**.
   - `type` 누락·`"audio"`·`""`·`null` → video. `"image"`만 image. 대소문자 다른 `"IMAGE"` → **video**(Node는 엄격 비교다).
   - **결정성**: 같은 인자로 2회 호출한 결과가 완전히 같다.
   - **키 있음 경로(무조건 항목 — 계약이 구조적으로 보지 못하는 유일 방어선이다. 축약 금지)**: 어댑터가 **정확히 1회** 호출되고 URL이 정본과 문자 단위로 같다(키·`cx`·`searchType`·`part`·`type`·`q` 순서 포함). 성공 응답의 `items`가 배열이면 그대로, 아니면 **빈 배열**(`Array.isArray` 동형)이고 `error:false`. `ok=false` 또는 파싱 실패 → `{items:[], error:true}`이고 **`demo` 플래그가 없다**.
   - **[② 재검토 med] 키 문자열 비유출 — 센티넬 테스트(무조건 항목)**: 키를 `SENTINEL-KEY-9f2c3a`처럼 **유일하게 식별되는 값**으로 설정한 뒤 **성공 경로와 실패 경로 양쪽**에서 (a) 반환 맵을 JSON으로 직렬화한 **전문** (b) `LogService` 링 버퍼에 쌓인 **모든 줄** (c) 발생한 **예외의 메시지·원인 체인** 셋 전부에 센티넬이 **0건**임을 단언한다. 근거: 로그 링 버퍼는 `GET /api/logs/digest`로 **밖으로 나간다**(ADR-007) — 거기 들어간 한 조각은 곧 응답이다. 71a가 수집 토큰에 같은 단언을 걸었다. **어댑터(step5)에만 이 단언이 있으면 부족하다**: URL에 키를 **합성하는 주체는 이 서비스**이고, 그 URL 문자열이 로그·예외·반환값으로 새는 경로는 여기서 생긴다.
4. `harness.news.service.MediaSearchService`를 만든다. 시그니처 수준 지시:
   - 생성자 주입: `ExternalProxyClient`, 그리고 **API 키 3종의 출처**. 키는 `@ConfigurationProperties` 레코드(예: `MediaProperties` — `app.media.google-api-key=${GOOGLE_API_KEY:}` 등)로 바인딩하라. **`AppProperties`에 필드를 추가하지 마라**(record 호출부 9곳이 함께 움직인다 — `CollectionProperties`·`SpoolProperties` 선례). 빈 값·공백은 **미설정**으로 수렴시킨다(JS truthy 동형).
   - `Map<String,Object> search(Object query, Object type)` — 반환은 순서 있는 맵 `{items, error}`(+ 내부 `demo`는 두지 마라. 라우트가 떨굴 값을 애초에 만들지 않는 편이 낫다. Node가 만드는 이유는 다른 소비자가 없어서일 뿐이며, **응답 3키가 계약**이다).
   - **`items`는 매 호출 새 리스트**로 만든다(Node `empty()`가 매번 새 객체를 만드는 이유와 같다 — 호출자가 변형해도 안전해야 한다).
   - 원소 맵은 `LinkedHashMap`으로 **정본 리터럴 순서**(image: `title,link` / video: `title,videoId,url`)를 재현한다.
   - 예외를 밖으로 던지지 마라 — 어댑터 실패는 `{items:[], error:true}`로 접는다.
5. `AppConfig`에 `MediaSearchService`(+ 키 프로퍼티) 배선을 추가한다.

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step5 수치) · Failures: 0 · Errors: 0
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 265관측 (불변 — 아직 라우트가 없다)
cd d:/agents/harness && npm test    # → 1328 pass / 0 fail (불변)
```

**추가 확인**: 새 설정 키를 만들었다면 `server-spring/src/main/resources/application.properties`에 `${GOOGLE_API_KEY:}` 형태로 넣고 **절대경로·실제 키를 하드코딩하지 않았음**을 확인하라. 하네스의 java 자식 env는 허용 목록이라 이 키들은 계약 실행 중 **언제나 미설정**이다(그래서 계약이 데모 폴백을 관측한다).

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **변이 A(인코딩)**: `NodeUri.encodeURIComponent`를 `URLEncoder.encode(s, UTF_8)`로 바꾼다 → 대조 케이스가 red → 원복.
2. **변이 B(trim)**: `NodeString.trim`을 `String.trim()`으로 바꾼다 → NBSP 시드 케이스가 red → 원복.
3. **변이 C(개수)**: image 6 → 5로 바꾼다 → `itemCount` 단언이 red → 원복. (이 축은 계약도 관측한다 — step9에서 다시 확인된다.)
4. **변이 D(타입 정규화)**: `equalsIgnoreCase`로 바꾼다 → `"IMAGE"` 케이스가 red → 원복.
5. **변이 E(반복 키)**: `List` 입력에서 첫 값만 쓰게 한다 → `type` 반복 키 케이스가 red → 원복.
6. **변이 F(키 없음인데 호출)**: 키 미설정에서도 어댑터를 부르게 한다 → '호출 횟수 0' 단언이 red → 원복. **이 변이는 실제 네트워크 egress를 만드는 변이다** — 반드시 red가 나야 한다.
7. **변이 G(원소 키)**: video 원소에 `link` 키를 추가한다 → `itemKeys` 단언이 red → 원복.

## 금지사항

- **응답에 `demo` 플래그를 실지 마라.** 이유: 응답 키 3종이 계약이고 계약이 `deepEqual(Object.keys().sort(), ['error','items','ok'])`로 단언한다.
- **`ok`를 false로 만들거나 4xx/5xx를 만들지 마라.** 이유: 이 라우트는 **항상 200 · `ok:true`**이고 실패는 `error:true` 플래그다.
- **`URLEncoder`·`URI`·`UriComponentsBuilder`로 질의를 인코딩하지 마라.** 이유: 셋 다 `encodeURIComponent`와 다르며(공백·`!'()~*`), 그 차이는 계약이 보지 못한 채 실 API 호출 결과를 갈라 놓는다.
- **키를 소스에 하드코딩하지 마라.** 이유: 보안 규율(news.md)이고 정본도 env에서만 읽는다.
- **`AppProperties`에 필드를 추가하지 마라.** 이유: record 생성자 호출부 9곳이 함께 움직인다.
- **어댑터를 2회 이상 부르거나 실패에 폴백 호출을 넣지 마라.** 이유: ADR-008 (6) — 재시도 0.
- **`Set.of(...).contains(null)`을 부르지 마라 — NPE이고 그 순간 400이 500이 된다.** 이유: 불변 집합은 `contains(null)`에 `NullPointerException`을 던지며 phase 68·69·70에서 **반복 발생**한 함정이다. 이 step의 위험 지점은 **`normalizeType(type)`과 시드 정규화**다 — `type`·`q`는 정상적으로 `null`로 들어온다(쿼리 파라미터 미전달). 집합 조회나 `equals` 좌변에 null이 오지 않도록 **먼저 접고**, **`type=null`·`q=null`이 각각 video 폴백과 `'뉴스'` 시드로 수렴하며 500이 아니다**를 단언하는 테스트를 두어라(index.json decisions (24)).
- **컨트롤러를 만들지 마라.** 이유: 이 step은 서비스 레이어 하나만 소유한다.
