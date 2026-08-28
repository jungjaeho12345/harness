# Step 5: external-proxy-client

> **[② 검토에서 확정] 이식한다. 이 step은 조건부가 아니다 — 삭제 조건은 없다.**
> ②가 `src/services/mediaSearch.js` 57행·`src/services/translate.js` 45행이 실제 egress임을 확인했고,
> **후속 phase가 없어 미이식은 무성(無聲) 회귀**라고 판정했다. `ApiSourceFetcher`가 GET+Bearer 전용이라
> POST 번역을 표현할 수 없다는 재사용 불가 판단도 타당하다고 확인됐다.
> **전제 조건**: 이 파일의 존재 근거인 **`ADR-014`는 step2 작업 A0이 이미 `docs/ADR.md`에 추가해 두었다.**
> 없으면 이 step을 시작하지 말고 step2로 돌아가라(근거 없는 예외는 게이트가 거짓을 주장하게 만든다).

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — decisions **(6)**(예외 목록 · 신설 파일 경로는 step2가 예약해 뒀다) · (20)(1회 시도·값으로 접기) · (22)⑩ · **open_questions (1)**.
- `docs/ADR.md` — **`ADR-014`**(step2 A0이 신설 — **이 파일의 존재 근거**: 서버 보유 키 프록시 · 사용자 트리거 동기 1회 조회는 ADR-008 egress 금지의 축이 아니다) · **ADR-008**(1)(3)(6). **`ADR-005`를 인용하지 마라 — 그 ADR은 SSE 결정이다.**
- Node 정본: `src/services/mediaSearch.js` 전문(엔드포인트·`buildUrl`·`fetchFn` 사용 형태) · `src/services/translate.js` 전문(`ENDPOINT`·`buildRequest`·`parseResponse`·POST) · `src/controllers/index.js` 6~7행·41~44행·106~109행(`fetchFn` 주입 지점).
- Spring 선례(**형태·규율·테스트 방식을 그대로 따르라**): `service/ApiSourceFetcher.java` · `service/HttpApiSourceFetcher.java` **전문**(타임아웃·리다이렉트·본문 상한·UTF-8·예외 미전파·로깅 규율) · `service/HttpApiSourceFetcherTest.java`(로컬 스텁 서버로 실왕복하는 테스트 형태).
- step2 산출물: `config/Adr008DisciplineTest.java`(예외 목록에 `harness/news/service/HttpExternalProxyClient.java`가 **이미 예약돼 있다**).

## 배경 (동결된 사실)

- **예외 목록은 step2가 이미 넓혀 놓았다. 이 step은 `Adr008DisciplineTest`를 0줄 고친다.** 파일을 **정확히 그 경로**(`harness/news/service/HttpExternalProxyClient.java`)에 만들어라 — 다른 패키지에 두면 예외가 성립하지 않아 즉시 red다.
- Node가 실제로 하는 외부 호출은 **두 가지 모양**뿐이다:
  - 미디어: `fetchFn(url)` — **GET**, 헤더 없음. URL에 키가 쿼리로 실린다.
    - 이미지: `https://www.googleapis.com/customsearch/v1?key=<GOOGLE_API_KEY>&cx=<GOOGLE_CSE_ID>&searchType=image&q=<encodeURIComponent(q)>`
    - 영상: `https://www.googleapis.com/youtube/v3/search?key=<YOUTUBE_API_KEY>&part=snippet&type=video&q=<encodeURIComponent(q)>`
  - 번역: `fetchFn(url, {method:'POST'})` — **POST, 본문 없음**. URL은 `https://translation.googleapis.com/language/translate/v2?` + `URLSearchParams({key, q:text, target:targetLang, format:'text'})`.
- Node가 결과에서 쓰는 것은 `res.ok`와 `await res.json()` 두 가지뿐이다. 상태코드·헤더는 판정에 쓰이지 않는다.
- 실패 처리(정본): `!res || !res.ok` → 미디어 `{items:[],error:true}` / 번역 `{ok:false,reason:'error',translatedText:원문}`. `catch` → 같은 값. **예외를 밖으로 던지지 않는다.**
- 계약 하네스는 API 키 4종을 자식 env에서 지우고 java 자식 env는 **허용 목록**이라 애초에 키가 도달하지 않는다 → **계약은 이 파일의 코드를 한 줄도 실행하지 않는다.** 이 step의 테스트가 유일 방어선이다.

## 작업

1. **테스트 먼저**: `service/HttpExternalProxyClientTest.java`. `HttpApiSourceFetcherTest`처럼 **로컬 스텁 HTTP 서버**(`com.sun.net.httpserver.HttpServer` 또는 기존 테스트가 쓰는 방식)를 [15000,20000) 밖의 임의 빈 포트에 띄워 실왕복으로 관측한다.
   - GET 성공(2xx) → `ok=true` + 본문 문자열.
   - 비-2xx(404·500) → `ok=false`.
   - POST가 실제로 **POST 메서드**로 나가고 **본문이 비어 있다**(스텁 서버가 메서드와 Content-Length를 기록해 단언).
   - **요청 횟수가 정확히 1**이다(재시도 0 — 서버에서 센다).
   - **리다이렉트를 따라가지 않는다**(302를 주는 스텁 → `ok=false`).
   - 연결 거부·잘못된 URI·`file:` 스킴 → **예외 없이** `ok=false`.
   - 본문은 응답이 선언한 charset과 무관하게 **UTF-8로 판독**한다(스텁이 `text/plain; charset=euc-kr`로 UTF-8 바이트를 보내도 같은 문자열).
   - 본문 상한(16 MiB — `HttpApiSourceFetcher`와 같은 값)을 작게 주입해 초과 시 `ok=false`임을 관측한다.
   - **로그·예외 메시지에 URL·키·본문이 실리지 않는다**(예외를 강제로 유발해 메시지 문자열을 검사).
2. `harness.news.service.ExternalProxyClient` 인터페이스를 만든다(**네트워크 타입을 import하지 않는다**).
   - `Result get(String url)` / `Result post(String url)` — `record Result(boolean ok, String body)`.
   - javadoc에 규율 셋을 적어라: **1회 시도** · **실패는 예외가 아니라 `ok=false`** · **헤더를 붙이지 않는다**(키는 URL에 있다 — Node 동형).
3. `harness.news.service.HttpExternalProxyClient`(**예약된 경로**)를 만든다.
   - **[② 검토 확정 — 명문 승계] `HttpApiSourceFetcher`(71a)의 안전 파라미터를 그대로 승계한다. 임의로 완화·강화하지 마라.**
     `HttpClient`를 **필드 하나로 재사용**(호출마다 새로 만들면 커넥션과 셀렉터 스레드가 누적된다) · **`connectTimeout` 10초** · **`HttpRequest.timeout` 30초** · **`Redirect.NEVER`** · **본문 상한 16 MiB** · **UTF-8 고정 판독** · `executor(...)` **미지정**(워커 풀을 우리가 만들지 않는다) · **`sendAsync` 금지**(동기 `send`만 — 비동기는 `Adr008DisciplineTest`의 비동기 군 위반이고 이 파일은 그 군의 예외가 아니다) · **예외 미전파**.
     이 승계가 ②가 '워커 잠식 결함이 재생산되지 않는다'고 판정한 근거다. **잔여 위험은 71a와 동일하게 남는다**: `HttpRequest.timeout`은 응답 **헤더**까지만 덮으므로 본문을 천천히 흘리는 상대는 Tomcat 워커를 계속 점유한다(그것을 막으려면 타이머나 별도 스레드가 필요하고 그것이 ADR-008 (3)(6) 위반이다). 이 사실을 클래스 javadoc과 step10 forward_notes에 남겨라.
   - `http`/`https` 외 스킴은 거부(Node `fetch`도 `file:`에 던진다 — 동형).
   - 테스트 전용 생성자로 상한·타임아웃을 주입할 수 있게 하되 **프로덕션 배선은 기본 생성자**로 고정한다.
   - 클래스 javadoc에 **왜 이 파일이 ADR-008 네트워크 예외 2번째 자리인지**를 **`ADR-014` 인용과 함께** 적고, `HttpApiSourceFetcher`(수집 pull — `rcv.md`)와 **역할이 다르다**는 것을 명시하라. **`ADR-005`를 인용하지 마라**(그 ADR은 SSE 단방향 무효화 스트림 결정이며, 초안의 오인용을 ②가 반려했다).
4. `AppConfig`에 `ExternalProxyClient` 빈 배선을 추가한다. 이 step에서는 **아직 아무도 주입받지 않는다** — step6·step7이 소비한다. (미사용 빈이 한 step 동안 존재하는 것은 허용한다. 만약 이 step과 step6을 연속으로 실행한다면 배선을 step6으로 미뤄도 된다.)

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step4 수치) · Failures: 0 · Errors: 0
# → Adr008DisciplineTest green (예외 4파일 · 이 step은 그 파일을 0줄 고쳤다)
cd d:/agents/harness && git diff --stat -- server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java
# → 출력 없음(0줄 변경)
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 265관측 (불변)
cd d:/agents/harness && npm test    # → 1328 pass / 0 fail (불변)
```

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **변이 A(경로)**: 파일을 `harness/news/web/HttpExternalProxyClient.java`로 옮긴다 → `Adr008DisciplineTest`가 **네트워크 군 위반**으로 red(예외는 경로로 매칭된다) → 원복.
2. **변이 B(재시도)**: 실패 시 한 번 더 호출하는 루프를 넣는다 → '요청 횟수 1' 테스트가 red → 원복. (정적 게이트는 이것을 못 잡는다 — 행동 테스트가 유일 방어선임을 요약에 적어라.)
3. **변이 C(리다이렉트)**: `Redirect.NORMAL`로 바꾼다 → 302 테스트가 red → 원복.
4. **변이 D(예외 전파)**: `catch`를 지운다 → 연결 거부 테스트가 red(예외) → 원복.
5. **변이 E(charset)**: `ofString()` 기본형으로 바꾼다 → euc-kr 선언 테스트가 red → 원복.
6. **변이 F(비동기)**: `sendAsync`로 바꾼다 → `Adr008DisciplineTest`의 **비동기 군**이 red(이 파일은 그 군의 예외가 아니다) → 원복.

## 금지사항

- **`Adr008DisciplineTest`를 고치지 마라.** 이유: step2가 이미 예약 자리를 만들어 뒀다. 여기서 고쳐야 한다면 그것은 경로가 틀렸다는 신호다.
- **재시도·백오프·타이머·비동기·스레드풀을 넣지 마라.** 이유: ADR-008 (3)(6)이고 예외는 **네트워크 군에만** 열려 있다.
- **SSRF 허용 목록·사설 IP 차단을 넣지 마라.** 이유: Node에 없다. 방어를 추가하면 두 서버가 같은 입력에 다른 결과를 준다(`HttpApiSourceFetcher`가 같은 판단을 이미 문서화했다).
- **URL·API 키·응답 본문을 로그·예외 메시지에 담지 마라.** 이유: 로그 링 버퍼는 `GET /api/logs/digest`로 밖으로 나간다(ADR-007) — 거기 들어간 한 조각은 곧 응답이다.
- **`ApiSourceFetcher`를 확장하거나 그 구현을 재사용하지 마라.** 이유: 그 인터페이스는 GET+Bearer 전용이고 71a 자산이며, 확장하면 그 fake 구현들(`CollectionServiceTest` 등)이 함께 움직인다. 무엇보다 '수집 pull 어댑터'라는 예외 정당화가 미디어·번역까지 덮는 것처럼 오독된다.
- **미디어/번역 도메인 로직(데모 폴백·응답 파싱·`no-key` 판정)을 여기 넣지 마라.** 이유: 이 파일은 '밖으로 나가는 방법'만 안다(ADR-006 계층). 파싱과 판정은 step6·step7의 서비스가 소유한다.
