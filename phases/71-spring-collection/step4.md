# Step 4: collection-api-source

`ApiSourceFetcher`의 **실구현**을 만든다 — `HttpApiSourceFetcher`(JDK `java.net.http.HttpClient`). 이 파일은 이 서버에서 **아웃바운드 네트워크 호출이 허용된 유일한 자리**이며, step1이 세운 ADR-008 정적 게이트의 **예외 2개 중 하나**다.

이 step은 **어댑터 한 클래스만** 만든다. 컨트롤러가 없어 계약은 아직 green이 될 수 없다.

## 읽어야 할 파일

- `phases/71-spring-collection/index.json` — decisions **(2)(8)** · open_questions **(c)**
- `phases/71-spring-collection/step1.md` — 정적 게이트의 예외 파일 목록과 그 근거
- `src/services/collectionService.js` 50~66행 — Node의 fetch 사용부: `init`은 `apiKey`가 있을 때만 `{headers:{Authorization:'Bearer …'}}` · `!res || !res.ok` → `fetch-failed` · `await res.text()` · `catch` → `fetch-failed`
- `contract/cases/default/collection.contract.js` — `assertNoEgress`(등록 가능한 endpoint는 **대상 서버 자신** 또는 `127.x`뿐) · `DEAD_ENDPOINT = 'http://127.0.0.1:1/'`(연결 거부) · `pull-self-health-source`(자기 `/api/health`를 소스로 걸어 200 성공 경로를 결정적으로 만든다)
- 이 phase의 step3 산출물: `.../service/ApiSourceFetcher.java`(인터페이스)
- `server-spring/src/test/java/harness/news/testsupport/` — 테스트 유틸 관례(`Wire`·`TempNewsDb`) 확인

## 배경 (동결된 사실)

- **`res.ok`는 2xx다**(`200 <= status < 300`). Node `fetch`의 정의 그대로다 — 3xx는 `ok=false`이지만 `HttpClient`는 기본적으로 리다이렉트를 따르지 않는다(`Redirect.NEVER`). **Node `fetch`는 기본 `redirect:'follow'`**라 여기서 divergence가 생긴다: 계약은 리다이렉트 소스를 등록하지 않아 관측되지 않으므로 **`NEVER`로 두고 forward_notes에 기록**한다(따라가게 만들면 SSRF 표면이 넓어진다 — 안전 방향으로 틀린다).
- **재시도·백오프 금지**(ADR-008 (6)). `HttpClient` 기본은 재시도를 하지 않는다 — `jdk.httpclient.enableAllMethodRetry` 같은 옵션을 켜지 마라.
- **connect timeout 10초**(decisions (8) · open_questions (c) 기본 결정), request timeout은 두지 않는다. 근거: Node `fetch`에는 타임아웃이 없어 완전 동형은 '무한 대기'인데, 그러면 Tomcat 워커가 고갈될 수 있다. 연결 단계만 막고 그 divergence를 기록한다.
- **SSRF 방어(허용 목록)를 추가하지 마라.** Node에는 없고, 대상 endpoint는 Z가 등록한 값이다. 추가하면 계약 픽스처(loopback)가 막히거나, 막히지 않더라도 검증되지 않은 정책이 생긴다.
- 응답 본문은 **문자열로** 돌려준다(`decodeBody`의 JSON 파싱은 step3 서비스 책임). 인코딩은 **UTF-8**로 읽는다(`BodyHandlers.ofString(StandardCharsets.UTF_8)`) — 기본 `ofString()`은 `Content-Type`의 charset을 따라가 서버에 따라 갈린다.
- **예외를 밖으로 던지지 않는다**: `IOException`·`InterruptedException`·`IllegalArgumentException`(잘못된 URI)·`SecurityException` 전부 `ok=false`로 수렴시킨다. `InterruptedException`은 반드시 `Thread.currentThread().interrupt()`로 인터럽트 상태를 복원한 뒤 `ok=false`를 돌려준다.

## 작업

### A. `HttpApiSourceFetcher` (`harness.news.service`)

- `@Component`로 `ApiSourceFetcher`를 구현한다. `HttpClient`는 **필드 하나로 재사용**한다(호출마다 새로 만들지 마라 — 커넥션 누수).
- `fetch(endpoint, apiKey)`:
  1. `URI.create(endpoint)`(예외 → `ok=false`). **`http`/`https` 스킴이 아니면 거부**(`file:`·`jar:` 스킴이 파일을 읽는 경로가 되지 않게 — Node `fetch`도 그 두 스킴만 지원한다. 이것은 방어 추가가 아니라 Node 동형이다).
  2. `apiKey`가 null/빈 문자열이 아니면 헤더 `Authorization: Bearer <apiKey>` **1개만** 추가한다.
  3. `GET` · `HttpResponse.BodyHandlers.ofString(UTF_8)`.
  4. `ok = (status >= 200 && status < 300)`. `ok=false`여도 본문은 담아 돌려준다(호출자가 쓰지 않지만 로깅·진단 여지를 남긴다 — **단, 본문을 로그에 찍지 마라**).
- **로깅 규율**: endpoint·apiKey·본문을 로그에 남기지 마라(자격증명·수집 본문 마스킹). 남긴다면 상태 코드와 실패 여부만.

### B. step1 게이트의 예외 목록 — **확인만 한다(수정 금지)**

- step1이 네트워크 예외를 `HttpApiSourceFetcher.java` **하나**로 이미 확정해 두었다. 이 step은 **그 이름의 파일을 채울 뿐** 목록을 건드리지 않는다.
- `mvnw -B verify`에서 `Adr008DisciplineTest`(특히 `onlyTheCollectionPullAdapterTalksToTheNetwork`·`theExceptionListIsExactlyTwoFiles`)가 green인지 확인한다. red라면 파일명이 목록과 어긋난 것이므로 **목록이 아니라 파일명을 맞춰라**.

### C. 테스트 (먼저 쓴다 — `HttpApiSourceFetcherTest`)

외부 의존 없이 **로컬 테스트 서버**를 띄운다: `com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0)`(JDK 내장 — **새 의존성 0**). 테스트 종료 시 반드시 `stop(0)`.

1. 200 + JSON 본문 → `ok=true`, 본문 문자열 그대로.
2. 200 + **UTF-8 한글 본문** → 깨지지 않는다(`ofString()` 기본값이면 red가 나도록 서버가 charset 없는 `Content-Type`을 보낸다).
3. 404·500 → `ok=false`(예외 아님).
4. **연결 거부**(`http://127.0.0.1:1/`) → `ok=false`.
5. 잘못된 URI(`"not a url"`·`""`·`null`) → `ok=false`(예외 아님).
6. `file:///…` 스킴 → `ok=false`(요청을 보내지 않는다).
7. `apiKey`가 있으면 서버가 받은 `Authorization` 헤더가 `Bearer <값>`이고, 없으면 그 헤더가 **없다**.
8. 리다이렉트(302 → 다른 경로) → **따라가지 않는다**(`ok=false`). 이 테스트가 곧 divergence의 기록이다.
9. 재시도 없음: 서버가 요청 횟수를 세어 **정확히 1회**임을 단언한다(ADR-008 (6)의 행동 단언 — 정적 스캔이 못 보는 축).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가 · **`Adr008DisciplineTest` green**(예외 파일이 정확히 2개, 그중 이 파일 1개).
- 2번: exit 0 · 4 프로파일 diffs 0(+ `failclosed`는 `bootOnly` skip) · 관측 수 215 불변.
- 3번 증분 = `.../service/HttpApiSourceFetcher.java` · 대응 테스트 · `phases/71-spring-collection/index.json`. **`Adr008DisciplineTest.java`는 증분에 없어야 한다** — step1이 예외 목록을 확정했으므로 정상 경로에서 그 파일은 변경 0이다. 변경이 필요하다고 느껴지면 그것은 **예외 목록 확대**이며 별도 근거와 리뷰가 필요하다(증분에 조용히 얹지 마라).

## 검증 절차

1. **red 먼저**: 어댑터 테스트를 구현 전에 돌려 실패 실측.
2. **인코딩 변이(원복)**: `ofString(UTF_8)` → `ofString()`으로 바꿔 2번(한글) 테스트 red 확인 → 원복.
3. **게이트 변이(원복)**: 다른 main 파일(예: `CollectionService.java`)에 `HttpClient` 참조를 넣어 `Adr008DisciplineTest`가 red인지 확인 → 원복. (예외가 **파일 단위**로만 열려 있음을 실증. 게이트 테스트 파일 자체는 건드리지 않는다.)
4. **재시도 변이(원복)**: 실패 시 한 번 더 시도하는 코드를 넣어 9번 테스트 red 확인 → 원복.
5. 테스트 실행 후 **잔존 프로세스·열린 포트 0** 확인(로컬 HttpServer가 반드시 닫혔는지).
6. AC 실행. index.json step4 상태 갱신.

## 금지사항

- SSRF 허용 목록·사설 IP 차단을 추가하지 마라. 이유: Node에 없는 정책이고, 계약 픽스처가 loopback을 쓴다 — 막으면 `pull-self-health-source`가 red다.
- 리다이렉트를 따라가게 하지 마라. 이유: 등록된 endpoint 밖으로 요청이 새는 표면이 열린다(안전 방향으로 틀리는 divergence를 택했다).
- 재시도·백오프·커넥션 풀 워머·워커 스레드를 넣지 마라. 이유: ADR-008 (6) — step1 게이트와 9번 행동 단언이 함께 막는다.
- endpoint·apiKey·응답 본문을 로그·예외 메시지에 담지 마라. 이유: 자격증명·수집 본문 마스킹 규율(로그 버퍼는 `GET /api/logs/digest`로 밖으로 나간다).
- 새 Maven 의존성을 추가하지 마라(테스트 서버 포함). 이유: JDK 내장(`java.net.http` · `com.sun.net.httpserver`)으로 충분하며, 의존성 추가는 별도 판단이다.
- `HttpClient`를 요청마다 새로 만들지 마라. 이유: 커넥션·셀렉터 스레드 누수 — 반복 pull에서 드러난다.
