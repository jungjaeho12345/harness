# Step 7: translation-service

## 읽어야 할 파일

- `phases/73-spring-media-upload/index.json` — decisions **(1)**(번역이 이 phase 범위인 이유) · **(15)**(graceful degrade · 계약 밖 분기) · (17)(계층) · (20) · (22)⑨.
- Node 정본: `src/services/translate.js` **전문** · `server/index.js` **396~416행**(`articleToText`) · **912~923행**(라우트) · `src/controllers/index.js` 185~187행.
- 계약(읽기만): `contract/cases/default/media-upload.contract.js` 150~193행.
- 명세(읽기만): `docs/api-contract/openapi.yaml`의 `/api/articles/{id}/translate` 절 + `TranslateResponse` 스키마 · `docs/api-contract/reason-tokens.md` 표 3 #13(`no-key`는 **200**).
- Spring 현행: `service/ArticleReadService.java`(기사 단건 조회 — `GET /api/articles/{id}`가 쓰는 경로) · `service/MarkupJson.java`(package-private JSON 판독) · `service/HistoryMeta.java`(블록에서 텍스트를 뽑는 **다른** 규칙 — 합치지 마라) · `service/EndMarker.java` · `service/NodeString.java` · `controller/ArticlesController.java`.
- step5·step6 산출물: `service/ExternalProxyClient.java` · `service/NodeUri.java`(있다면).

## 배경 (동결된 사실)

- **상태코드로 성공을 판정할 수 없는 대표 라우트다.** 키가 없어도 **200**이고 본문만 `ok:false`다. 4xx/5xx로 감싸면 클라이언트(`httpModel`)가 조용히 깨진다.
- 라우트 게이트 순서(정본): 세션 → `getById(id)` 없으면 **404 `{ok:false,reason:'not-found'}`** → `articleToText(found)` → `targetLang = body.targetLang ?? 'ko'` → 서비스 위임 → **서비스가 준 객체를 그대로 200으로** 내려보낸다.
- `translate(text, targetLang)`의 분기(정본 순서 그대로):
  1. **`!text`** → `{ok:true, translatedText:''}` — **2키, `reason` 없음**. ← 계약 밖(픽스처는 본문이 있다).
  2. 키 없음 → `{ok:false, reason:'no-key', translatedText:text}` — **3키**.
  3. 호출 후 `!res || !res.ok` 또는 파싱 실패 → `{ok:false, reason:'error', translatedText:text}`.
  4. 성공 → `{ok:true, translatedText:<번역문>, sourceLang:<감지 언어 — provider가 줄 때만>}`.
- `articleToText(found)`(정본): `raw = found.article.markupVersion` → truthy면 `JSON.parse` 시도 → `doc.blocks`가 배열이면 각 블록의 `typeof b.text === 'string' ? b.text : ''`를 **`'\n'`로 join** → **`.trim()`** → 비어 있지 않으면 반환. 파싱 실패면 `String(raw).trim()`을 같은 방식으로 판정. 전부 실패하면 `found.contents?.title ?? found.article?.title ?? ''`.
  - **`.trim()`은 JS trim이다 → `NodeString.trim`을 써라.**
  - 블록 필터가 `HistoryMeta`(제목 파생 — `type === 'text'`인 블록만)와 **다르다**. 합치지 마라(그 사실이 `MarkupJson` javadoc에 이미 적혀 있다).
- `targetLang`은 **`??`**(null 병합)다: `null`·미지정만 `'ko'`가 되고 빈 문자열·숫자·객체는 그대로 간다. 키 없는 서버에서는 관측 불가하니 억지로 정규화하지 마라.
- 계약 실측 관측 4건: `no-key`(200, bodyKeys `ok,reason,translatedText`) · `no-key-target-lang`(같음) · `missing-article`(404, `ok,reason`) · `unauth-translate`(401).

## 작업

1. **테스트 먼저**: `service/ArticleTextTest.java` — `articleToText` 이식의 표.
   - `markupVersion`이 `{"blocks":[{"text":"a"},{"type":"image"},{"text":"b"}]}` → `"a\n\nb"`(두 번째 블록은 빈 문자열) → trim.
   - 블록 전부가 빈 텍스트 → 결과가 빈 문자열 → **폴백(제목)으로 넘어간다**.
   - 깨진 JSON(평문 레거시) → 원문 문자열을 trim해서 쓴다.
   - `markupVersion`이 `null`/빈 문자열 → 폴백.
   - JSON이지만 `blocks`가 배열이 아님 → 폴백.
   - 폴백 순서: `contents.title` → `article.title` → `""`(**`??` 병합** — 빈 문자열 제목은 그대로 빈 문자열이지 다음 후보로 넘어가지 않는다. 이 케이스를 반드시 넣어라).
   - trim이 NBSP·BOM을 지운다(`NodeString.trim` 사용 증거 — `String.trim()`이면 red).
2. **테스트 먼저**: `service/TranslationServiceTest.java`(가짜 `ExternalProxyClient` 주입).
   - **빈 본문**: `text=""` → `{ok:true, translatedText:""}` **정확히 2키** · 어댑터 **호출 0회** · 키가 설정돼 있어도 마찬가지.
   - **키 없음**: `{ok:false, reason:'no-key', translatedText:<원문 그대로>}` **3키** · 어댑터 호출 0회.
   - **키 있음 · 성공**: 어댑터가 **1회** POST로 호출되고 URL이 정본과 문자 단위로 같다(`key,q,target,format` 순서 · 값은 `encodeURIComponent` 규칙). 응답에서 `data.translations[0].translatedText`를 뽑고 `detectedSourceLanguage`가 있으면 `sourceLang`을 싣는다(**없으면 키 자체가 없다**).
   - **키 있음 · 실패/비정상 shape**: `{ok:false, reason:'error', translatedText:<원문>}`.
   - `targetLang`이 `null`이면 `'ko'`, 빈 문자열이면 **빈 문자열 그대로** URL에 실린다.
   - **[② 재검토 med] 키 문자열 비유출 — 센티넬 테스트(무조건 항목)**: 키를 `SENTINEL-KEY-9f2c3a`처럼 **유일하게 식별되는 값**으로 설정한 뒤 **성공 경로와 실패 경로 양쪽**에서 (a) 반환 맵을 JSON으로 직렬화한 **전문** (b) `LogService` 링 버퍼에 쌓인 **모든 줄** (c) 발생한 **예외의 메시지·원인 체인** 셋 전부에 센티넬이 **0건**임을 단언한다. 근거: 로그 링 버퍼는 `GET /api/logs/digest`로 **밖으로 나간다**(ADR-007) — 거기 들어간 한 조각은 곧 응답이다. 71a가 수집 토큰에 같은 단언을 걸었다. **어댑터(step5)에만 이 단언이 있으면 부족하다**: URL에 키를 **합성하는 주체는 이 서비스**이고, 그 URL 문자열이 로그·예외·반환값으로 새는 경로는 여기서 생긴다.
3. `harness.news.service.ArticleText`(package-private 또는 public 헬퍼)와 `harness.news.service.TranslationService`를 만든다.
   - `ArticleText`는 `MarkupJson.parseOrNull`(같은 패키지)과 `NodeString.trim`을 쓴다. **`HistoryMeta`의 블록 필터를 재사용하지 마라.**
   - `TranslationService`는 생성자 주입으로 `ExternalProxyClient`와 키 프로퍼티를 받는다(step6에서 만든 `@ConfigurationProperties`에 `google-translate-api-key`를 더하거나 별도 레코드를 두어라 — **`AppProperties` 금지**).
   - `Map<String,Object> translate(String text, Object targetLang)` — 순서 있는 맵 투영(`ok,reason,translatedText` / `ok,translatedText` / `ok,translatedText,sourceLang`).
   - **서블릿 타입 import 0** · 예외 미전파.
4. **본문 도출은 서비스 계층에서 끝낸다.** 컨트롤러가 `ContentsRow`나 원본 행을 만지면 `ControllerProjectionBoundaryTest`가 red다. `ArticleReadService`가 이미 돌려주는 형태(투영된 맵)를 소비하거나, 필요하면 서비스 계층에 '기사 id → 번역 결과' 한 방향 진입점을 두어라(**컨트롤러는 id와 targetLang만 넘긴다**).

## Acceptance Criteria

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
# → BUILD SUCCESS · Tests run: N (N > step6 수치) · Failures: 0 · Errors: 0
# → ControllerProjectionBoundaryTest green (컨트롤러 시그니처·소스에 ContentsRow 0건)
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
# → exit 0 · profiles=5 · diffs=0 · 265관측 (불변 — 아직 라우트가 없다)
cd d:/agents/harness && npm test    # → 1328 pass / 0 fail (불변)
```

**AC 마지막 항목(필수)**: 아래 '검증 절차'의 변이 **전건**에 대해 `변이 | 심은 곳 | 기대 | 실제(red/green) | 원복 확인(git diff 공백)` 표를 **step 요약에 기록**하라. **미기록이면 이 step은 미완이다** — 빌드 green과 관측 수 불변만으로 만족되는 AC는 공허하다(index.json decisions (23)).

## 검증 절차 (변이 포함)

1. **변이 A(빈 본문 분기 제거)**: `!text` 분기를 지운다 → 빈 본문 테스트가 red(`no-key` 3키가 나온다) → 원복. **이 분기는 계약이 보지 못한다 — 이 테스트가 유일 방어선이다.**
2. **변이 B(상태코드)**: 키 없음을 `reason`만 남기고 서비스가 예외를 던지게 한다 → 200 유지 단언이 red → 원복.
3. **변이 C(trim)**: `NodeString.trim`을 `String.trim()`으로 → NBSP 케이스 red → 원복.
4. **변이 D(블록 필터 통합)**: `ArticleText`가 `type === 'text'`인 블록만 보게 한다 → 이미지 블록 포함 케이스가 red → 원복.
5. **변이 E(폴백 `??` → `||`)**: 빈 문자열 제목 케이스가 red인지 확인 → 원복.
6. **변이 F(호출 횟수)**: 키 없음에서도 어댑터를 부르게 한다 → 호출 0회 단언 red → 원복.
7. **변이 G(sourceLang)**: provider가 감지 언어를 주지 않았을 때도 `sourceLang: null`을 싣게 한다 → 키 집합 단언 red → 원복(키가 아예 없어야 한다).

## 금지사항

- **키 누락·외부 실패를 4xx/5xx로 감싸지 마라.** 이유: `httpModel`이 상태코드를 해석하지 않고 JSON의 `ok`만 읽는다 — 조용히 깨진다(reason-tokens.md 표 3 #13).
- **`no-key`·`error`를 `ReasonStatus`에 넣지 마라.** 이유: 상태 매핑이 아니라 **200 본문의 필드**다.
- **요청 body의 `text`를 번역 대상으로 쓰지 마라.** 이유: ADR-004 — 본문은 **서버 DB에서만** 취한다(계약이 원문 폴백으로 관측한다).
- **`HistoryMeta`·`EndMarker`의 블록 규칙과 통합하지 마라.** 이유: 세 규칙이 실제로 다르고, 합치면 이력 제목 파생(영속되는 값)이 함께 깨진다.
- **컨트롤러가 원본 행(`ContentsRow`)을 만지게 하지 마라.** 이유: `ControllerProjectionBoundaryTest`가 red를 낸다(투영 우회는 잠금 비밀 컬럼 유출 경로다).
- **`targetLang`을 문자열로 강제 정규화하지 마라.** 이유: Node는 `??`만 적용하고 나머지를 그대로 넘긴다 — 키 없는 서버에서는 관측 불가이나 키가 있는 배포에서 갈린다.
- **라우트 매핑을 붙이지 마라.** 이유: 결선은 step9다(그 step이 `IMPLEMENTED_ROUTES`와 scope 표를 함께 늘린다).
