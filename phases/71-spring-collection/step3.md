# Step 3: collection-service

수집 도메인 서비스를 만든다 — `CollectionService.receive(sourceId, payload)`와 `pull(sourceId)`. 등록·활성 판정 → 파싱 → 기사 등록(`attribute='자동기사'`, `status=RDS`)까지가 책임이다. 외부 호출은 **주입 seam**(`ApiSourceFetcher` 인터페이스)으로 두고 이 step에서는 **가짜 구현으로만** 테스트한다.

이 step은 **service 계층만** 건드린다. 컨트롤러가 없어 수집 계약 3파일은 아직 green이 될 수 없다 — 판정은 Java 서비스 단위 테스트 + 이미 green인 scope 무회귀다.

## 읽어야 할 파일

- `phases/71-spring-collection/index.json` — decisions **(6)(7)(9)(11)(15)** · excluded **(e)**
- `src/services/collectionService.js` — **이식 원본 전문**(69행): `receive`(unregistered → inactive → parse → create) · `pull`(unregistered → no-active-api-source → fetch → decodeBody → receive 재사용) · `decodeBody`
- `src/services/articleService.js` 147~159행 — `create(dto, {role, action})`가 하는 일(articleId 발급 · `status=initialStatus(role,action)` · `createdAt` stamp · 파일 참조 정화 · 두 행 트랜잭션 삽입 · **반환 `{ok:true, articleId}`** · **이력 0행**)
- `contract/cases/default/collection.contract.js` — 이 step이 만족시켜야 할 서비스 판정: `receive-unregistered`(403 `unregistered`) · `receive-inactive-source`(403 `inactive`) · `receive-text-payload`/`receive-object-payload`/`receive-missing-payload`(200 `{ok,articleId}` · `attribute='자동기사'` · `status='RDS'`) · `pull-unregistered` · `pull-ftp-source`(400 `no-active-api-source`) · `pull-fetch-failed`(400 `fetch-failed`) · `pull-self-health-source`(200 · 빈 제목 · 블록 1개)
- `contract/cases/minimal/collection-open.contract.js` — 같은 판정을 토큰 없는 서버에서
- `server-spring/src/main/java/harness/news/model/ReceiverConfigRepository.java` — `query(Map<String,?> filters)`(phase 70). 필터 키 화이트리스트와 반환 shape을 확인한다
- `server-spring/src/main/java/harness/news/service/ArticleWriteService.java` — `create(Map<String,?> dto, String role, String action)` → 발급된 `articleId` 반환. `CONTENTS_FIELDS`에 `attribute`가 있음을 확인
- `server-spring/src/main/java/harness/news/service/Lifecycle.java` — `initialStatus(role, action)`: 둘 다 null이면 `RDS`
- 이 phase의 step2 산출물: `.../service/CollectionParser.java` · `.../service/CollectionMarkup.java`

## 배경 (동결된 계약 사실)

- **수집 라우트는 사용자 세션 라우트가 아니다.** 이 서비스는 세션·role·`Authorization`을 **전혀 모른다**(계약 파일 서문: 세션은 픽스처용일 뿐 판정에 쓰이지 않는다).
- `receive(sourceId, payload)` 판정 순서(문자 그대로):
  1. `receiverConfigModel.query({ sourceId })` 결과가 없거나 0건 → `unregistered`.
  2. 그 중 **하나라도** `(active ?? 'Y') !== 'N'`이 아니면(= 전부 비활성) → `inactive`. **`active`가 NULL/미설정이면 활성으로 본다**(`?? 'Y'`). `'y'`·`'n'` 소문자는 `'N'`이 아니므로 **활성**이다(관용 추가 금지 — Node 그대로).
  3. `CollectionParser.parse(payload)` → `ArticleWriteService.create({title, markupVersion: toMarkup(title, content), attribute: '자동기사'}, null, null)` → `{ok:true, articleId}`.
  - **`sourceId`를 기사에 저장하지 않는다**(Contents에 그런 컬럼이 없다). 계약도 그것을 요구하지 않는다.
  - **입력 검증이 없다**: `payload` 누락도 200이다.
- `pull(sourceId)` 판정 순서:
  1. `query({sourceId})` 0건 → `unregistered`.
  2. 그 중 **`(active ?? 'Y') !== 'N'` && `type === 'API'` && `apiEndpoint` truthy**인 첫 행을 고른다. 없으면 → `no-active-api-source`. (`type`은 **엄격 비교** — `'api'` 소문자는 안 된다.)
  3. `apiKey`가 truthy면 헤더 `Authorization: Bearer <apiKey>` 1개, 아니면 헤더 없음.
  4. `fetchFn(apiEndpoint, init)` → 응답이 없거나 `res.ok`가 아니면(=2xx 아님) → `fetch-failed` · 예외(연결 거부·잘못된 URL 등) → `fetch-failed`. **재시도·백오프 없음(1회 시도)**.
  5. 본문 텍스트 → `decodeBody`: JSON 파싱을 시도해 성공하면 그 값(객체·배열·숫자 무엇이든), 실패하면 **평문 문자열 그대로**.
  6. `receive(sourceId, payload)` **재사용**(등록·활성 재확인이 한 번 더 일어난다 — 그대로 둔다).
- `no-active-api-source`·`fetch-failed`는 **전역 표에 없어 폴백 400**이다(계약이 400을 동결). **`ReasonStatus`에 넣지 마라.**
- 반환은 Node 결과 객체 동형(`record`로): 성공 `{ok:true, articleId}` · 실패 `{ok:false, reason}`. **예외를 던져 실패를 표현하지 마라**(graceful 거부 — news.md).

## 작업

### A. Node 실측 대조(decisions (14))

```
node scripts/contract-run.mjs --profile default --files contract/cases/default/collection.contract.js --out <리포_밖_임시경로>/collection-node.json
```

리포트에서 `collection-receive`·`collection-pull`의 `status`·`bodyKeys`·`values`를 확인하고 요약에 적는다. (이 실행은 **Node 대상**이므로 지금도 green이다.)

### B. 주입 seam — `ApiSourceFetcher`

- 인터페이스 1메서드(구현 재량): `FetchResult fetch(String endpoint, String apiKey)` — 반환 `record FetchResult(boolean ok, String body)`. **`java.net.http`를 import하지 않는다**(그 구현은 step4).
- 실패는 예외가 아니라 `ok=false`로 표현한다. 구현체가 예외를 던지더라도 서비스가 잡아 `fetch-failed`로 수렴시킨다(방어).

### C. `CollectionService` (`harness.news.service`)

생성자 주입: `ReceiverConfigRepository` · `ArticleWriteService` · `ApiSourceFetcher`. 시그니처(구현 재량, Node 결과 객체 동형):

- `Result receive(Object sourceId, Object payload)`
- `Result pull(Object sourceId)`
- `record Result(boolean ok, String articleId, String reason)`

주의:

- `sourceId`는 **클라이언트 입력**이다(문자열이 아닐 수 있다). 리포지토리 필터에 넘기기 전 값 바인딩 정책(`ColumnValues`)을 그대로 태운다 — 불리언·객체는 예외 → 전역 핸들러 500(Node `node:sqlite`와 동형, phase 69 decisions (8)).
- `decodeBody`는 **JSON 파싱 시도 후 실패 시 평문**이다. Jackson `readValue`가 던지면 원문 문자열을 그대로 쓴다. `{"ok":true}` 같은 응답은 객체가 되어 파서가 `{title:'',content:''}`를 돌려준다(계약 `pull-self-health-source`가 그 결과를 단언한다).
- **서블릿 타입을 import하지 마라**(ADR-006).

### D. 테스트 (먼저 쓴다 — `CollectionServiceTest`, 임시 DB + 가짜 fetcher)

1. `receive`: 미등록 → `unregistered` · 전부 비활성 → `inactive` · `active` NULL → **활성**(`?? 'Y'`) · 여러 행 중 하나만 활성 → 통과.
2. `receive` 성공: `attribute='자동기사'` · `status='RDS'` · 발급된 `articleId` 반환 · `Article.markupVersion`이 step2 규칙의 JSON · **이력 0행**(create는 이력을 남기지 않는다).
3. `receive`: `payload` 누락 → 200 · 빈 제목 · 블록 1개.
4. `pull`: 미등록 → `unregistered` · `type='FTP'` → `no-active-api-source` · `type='API'`인데 `apiEndpoint` 없음 → `no-active-api-source` · 비활성 API 소스만 있음 → `no-active-api-source`.
5. `pull`: fetcher가 `ok=false` → `fetch-failed` · fetcher가 **예외를 던져도** `fetch-failed`(서비스가 잡는다).
6. `pull`: `apiKey`가 있으면 fetcher에 그 값이 전달되고, 없으면 null이 전달된다(가짜 fetcher가 인자를 기록).
7. `pull` 성공: JSON 본문(`{"title":"T","content":"C"}`) → 제목·본문 반영 · **비-JSON 평문 본문** → 첫 줄=제목 · `{"ok":true}` → 빈 제목·블록 1개.
8. **비-ASCII 왕복**: 한글 제목·본문이 저장·조회에서 깨지지 않는지(계약 픽스처는 이 축을 일부만 본다 — Java가 방어선이다).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가(실측 기록).
- 2번: exit 0 · **4 프로파일** diffs 0(+ `failclosed`는 `bootOnly` skip) · 관측 수 **215 불변**.
- 3번 증분 = `.../service/CollectionService.java` · `.../service/ApiSourceFetcher.java` · 대응 테스트 · `phases/71-spring-collection/index.json`.

## 검증 절차

1. **red 먼저**: 서비스 단위 테스트를 구현 전에 돌려 실패 실측.
2. **활성 판정 변이(원복)**: `(active ?? 'Y') !== 'N'`을 `"Y".equals(active)`로 바꿔 1번의 NULL 활성 테스트가 red인지 확인 → 원복. (이 변이는 **기존 수집 소스를 전부 죽이는** 종류다.)
3. **pull 소스 선택 변이(원복)**: `type` 비교를 대소문자 무시로 바꿔 4번이 통과해 버리는지 확인(= 관용이 생겼다는 증거) → 원복.
4. **재사용 변이(원복)**: `pull`이 `receive`를 재사용하지 않고 직접 create하도록 바꿔, 비활성 소스의 pull이 200이 되는지 확인 → 원복.
5. AC 실행. `--parity` 관측 수 불변.
6. index.json step3 상태 갱신.

## 금지사항

- 이 서비스에 세션·role·`Authorization`을 끌어들이지 마라. 이유: 수집 라우트의 방어는 바인딩과 수집 토큰뿐이다 — 세션 게이트를 넣으면 계약(200 경로)이 401이 된다.
- `java.net.http`·`RestTemplate` 등 네트워크 타입을 이 파일에서 import하지 마라. 이유: step1 정적 게이트가 red를 낸다(예외 파일은 `HttpApiSourceFetcher.java` 하나다).
- 실패를 예외로 던지지 마라. 이유: 계약이 400/403 JSON 본문을 동결한다 — 예외는 500이 된다.
- 재시도·백오프·큐를 넣지 마라. 이유: ADR-008 (6) — 1회 시도 후 사유 반환이 계약이다(`pull-fetch-failed`).
- `no-active-api-source`·`fetch-failed`를 `ReasonStatus`에 넣지 마라. 이유: fail fallback 400이 계약이다.
- 수집 기사에 `sourceId`·수집 시각 같은 새 컬럼을 만들지 마라. 이유: DDL 0(DB 비파괴) · 스키마 정본은 Node다.
- 컨트롤러·라우트·scope 표를 건드리지 마라. 이유: 이 step은 service 계층 전용이다.
