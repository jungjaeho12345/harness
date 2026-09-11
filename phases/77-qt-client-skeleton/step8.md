# Step 8: net-contract-model

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `decisions` (4)(9) · `open_questions` (6) · `excluded` (c)(i)
- `docs/ADR.md` **ADR-018** · **ADR-003**(주입 가능한 Model 계약 — 이 step이 승계한다) · **ADR-001**(2계층 경계)
- **계약 정본(읽기 전용 · 고치지 마라)**: `docs/api-contract/endpoints.json` — `{version, routes[39]}` · 각 행 `{id, method, path, auth, profile, expect[], notes}` · SSE 라우트는 `sse:true`
- **계약 보조(읽기 전용)**: `docs/api-contract/openapi.yaml`(요청/응답 shape) · `docs/api-contract/reason-tokens.md`
- **Model 정본(읽기 전용)**: `web/src/model/contract.js` — `MODEL_KEYS` **35개**와 `assertModel` · `web/src/model/httpModel.js`(각 메서드가 어느 라우트로 나가는지 — `request(`/`EventSource(` 호출 지점 **36곳**, 127~348행) · **`web/src/test/fakeModel.js`**(357줄 · 가짜 구현의 형태 — ⚠ `web/src/model/`에는 없다. `web/src/model/contract.test.js` **3행**이 `'../test/fakeModel.js'`에서 import한다)
- `docs/porting-plan-cpp-spring.md` §6.2 **162행**·**167행**(net 계층과 `fakeModel` 이식 지침) · 부록 A(39 라우트 표)
- `phases/77-qt-client-skeleton/step7.md` 산출물(`HttpTransport`·`RequestSpec`(`std::optional` 본문)·**`buildQuery`**·`EditClientId`와 전송 계층의 3 라우트 집합)
- **정본 잠금 테스트(읽기 전용)**: `web/src/model/httpModel.test.js` **197~202행**(배열 필터 = 반복 쿼리 키 — `queryArticles` 결선 테스트의 기준)

## 배경

이 step이 **「net 계층이 동결 계약을 지키는가」를 기계가 판정하게 만든다**(`decisions` (4)).

두 겹이다.

- **(가) 정적 — 라우트 표 ↔ `endpoints.json`.** net 계층이 소유한 라우트 표를 QtTest가 **런타임에 계약 파일을 파싱해** 대조한다. 계약이 바뀌면 테스트가 따라가고, 클라가 계약 밖으로 새면 즉시 red다.
- **(나) 동적 — 실기 라우트 원장.** step6 드라이버가 `net-request` diag를 모아 판정한다(구현은 이미 step6에 있고, 이 step은 **라우트 id 어휘를 계약과 일치**시켜 그 판정이 성립하게 한다).

그리고 **ADR-003을 승계**한다: 35 메서드 인터페이스 + 가짜 구현 ⇒ **서버 없이 화면 로직을 테스트**한다. 이것이 로드맵 §6.2가 지목한 비용 절감 경로이고, step10·step11의 컨트롤러 테스트가 이 위에 선다.

**숫자에 주의**(`open_questions` (6) — 확정): 계약 라우트는 **39**, Model 메서드는 **35**다. 로드맵 P4 행의 "REST 35"는 Model 메서드 수다. 그리고 **메서드와 라우트는 1:1이 아니다**(② 2차 패치 · net 포트 스펙 실측):

- **`saveArticle`은 1 메서드 → 2 라우트**다 — 신규는 `articles-create`(`POST /api/articles` · `httpModel.js` 193행), 기존은 `articles-update`(`PUT /api/articles/:id` · 190행). 그래서 **35 메서드가 36 라우트를 덮는다**(호출 지점 36곳).
- **39 중 Model 메서드가 없는 라우트는 정확히 3개**다: `health`(**`ProbeRunner`가 소비** — step7) · `collection-receive`·`collection-pull`(**클라 금지** — 서버-대-서버 토큰 경로).
- 따라서 라우트 표는 **메서드↔라우트를 일대다로 표현**할 수 있어야 한다. 그래야 대조 테스트가 「**모든 비금지 라우트가 정확히 하나의 소비자(Model 메서드 또는 `ProbeRunner`)에 매핑된다**」와 「**모든 Model 메서드가 1개 이상의 라우트를 가진다**」를 둘 다 단언할 수 있다.

## 작업

### A. 라우트 표

`client-qt/src/net/`에 라우트 표를 **데이터로** 둔다(코드 여기저기 흩어진 문자열 금지):

```cpp
struct RouteSpec { QString id; QString method; QString pathTemplate; QString auth;
                   QString consumer;        // MODEL_KEYS 메서드 이름 · 또는 "ProbeRunner"(health 전용)
                   bool sendsEditClient; bool sse; bool hasBody; };
const QVector<RouteSpec>& routeTable();       // 클라가 호출할 수 있는 라우트만(36 + health = 37행)
const QSet<QString>& forbiddenRouteIds();     // collection-receive · collection-pull
QVector<RouteSpec> routesOf(const QString& modelMethod); // 일대다 조회 — saveArticle → 2행
QString buildPath(const QString& routeId, const QVariantMap& params); // :id 치환 · 인코딩
```

- `pathTemplate`은 계약의 `path`와 **문자 단위로 같아야 한다**(`/api/articles/:id` 형식).
- `auth`는 계약의 `auth` 필드 값을 **문자열 그대로** 옮긴다. 2026-09-11 실측 어휘는 **6종**: `public`(health·login·logout) · `session` · `admin` · `session-role` · `lock-holder`(articles-update·articles-unlock) · `token`(collection 2행 — 금지 목록). 이 열이 없거나 다르면 공개 라우트를 세션 라우트로 잘못 적어도 아무것도 red가 되지 않는다(`decisions` (4)의 「인증 등급」 대조 항목).
- `consumer`로 **메서드→라우트 일대다**를 표현한다(행마다 소비자 1개 · 한 메서드가 여러 행에 나타날 수 있다). `saveArticle`만 2행이고 나머지 34 메서드는 1행이며, `health`의 소비자는 `ProbeRunner`다.
- `hasBody`는 step7의 본문 규율(`body == nullopt`면 Content-Type·본문 미전송)을 라우트 수준에서 문서화한다 — 정본에서 **본문 키가 아예 없는 POST**는 `logout`·`articles-unlock`·`articles-force-unlock`·`distribution-targets-deactivate`·`distribution-tick`이고, **`articles-lock`은 항상 본문을 싣는다**(action 부재 시 `{}`). GET·DELETE는 본문이 없다(id는 전부 `endpoints.json` 실측 철자다).
- 경로 파라미터 치환은 **퍼센트 인코딩**을 반드시 거친다(정본 `httpModel.js`가 `encodeURIComponent`를 쓴다 — **쿼리의 `URLSearchParams` 인코딩과 규칙이 다르다**. 경로는 `encodeURIComponent`, 쿼리는 step7의 `buildQuery`다. 섞지 마라).
- `sendsEditClient`는 **정확히 3행**만 `true`(`articles-lock`·`articles-unlock`·`articles-update`). **이 열이 전송 계층 강제의 정본이 된다** — step7이 전송 계층 상수로 둔 3 라우트 집합을 이 표에서 파생시키도록 바꾸거나, 두 집합이 같음을 테스트로 단언하라(정본이 둘로 갈라지면 안 된다). 웹은 이 불변식을 호출부 데이터 흐름(`blankTab()`의 `clientId: null`)으로 지키지만, **Qt는 이 열로 구조적으로 강제**한다 — 관측 가능한 트래픽은 같다.

### B. Model 인터페이스 35 + 가짜 구현

```cpp
class INewsModel {           // 35 메서드 — MODEL_KEYS와 1:1 (이름·인자 의미 동형)
public:
  virtual ~INewsModel() = default;
  virtual ModelResult login(const QString& userId, const QString& password) = 0;
  // ... 34개 더 (contract.js의 MODEL_KEYS 순서를 그대로 따라라 — 대조가 쉬워진다)
};
class HttpNewsModel : public INewsModel { /* HttpTransport + routeTable */ };
class FakeNewsModel : public INewsModel { /* 결정적 응답 · 테스트/화면 개발용 */ };
```

- **목록 필터는 쿼리다 — `queryArticles(filters)`는 반드시 step7의 `buildQuery`를 거친다**(배열은 반복 키 · `null` 생략 · `URLSearchParams` 인코딩). `deskUnsent` 필터 `{status:['RDS','DDH']}`가 `?status=RDS&status=DDH`가 되지 않으면 **step11 완료 게이트가 틀린 목록 위에서 돈다** — `HttpNewsModel::queryArticles`가 만든 URL을 스텁으로 받아 **정본 `httpModel.test.js` 197~202행과 동형**으로 단언하는 테스트를 이 step에도 하나 둔다(전송 계층 단위 테스트와 별개로, **Model이 그 규칙을 실제로 쓰는지**의 결선 증거).
- **P4가 실기로 부르는 것은 6개**다 — `login`·`restoreSession`·`logout`·`queryArticles`·`subscribe` + **`getArticle`(선택)** (`index.json` `decisions` (9)와 같은 목록). 나머지는 **요청 조립까지만** 구현하고 라우트 표로 잠근다 — 화면이 없는 메서드를 실기로 부를 방법이 없기 때문이며, **그 사실을 미검증 항목으로 요약에 적어라**(「전부 구현했다」로 적지 마라). `getArticle`을 실기로 부르지 않았다면 그것도 미검증에 넣는다.
- `FakeNewsModel`은 **`web/src/test/fakeModel.js`**(357줄)의 규율을 따른다: **결정적**이고 **네트워크가 없으며** · **`assertModel`을 통과하는 전 메서드 구현**(35개 전부 — 빠진 메서드가 없다) · 사용자 응답에서 **비밀번호 필드를 제거**(`stripPassword`) · 삭제는 **soft-delete 모사**(행을 지우지 않고 비활성 — DB 비파괴 규율의 모사) · `saveArticle`은 **`body` 키를 버리고 서버 `ARTICLE_FIELDS` pick과 동형으로 정규화**한다. 목록·세션 같은 최소 상태를 메모리로 들고 있다. 이 규율 각각을 fake 자신의 테스트로 잠가라(fake가 서버와 다르게 굴면 그 위의 컨트롤러 테스트가 거짓 green이 된다).

### C. 기계 대조 테스트

QtTest가 `docs/api-contract/endpoints.json`을 **읽어**:

1. 라우트 표 ∪ 금지 목록 = 계약 39행의 id 집합(**정확히 같음** · 표 37행 + 금지 2행).
2. 각 행의 `method`·`path`가 계약과 같다.
3. **각 행의 `auth`가 계약의 `auth`와 같다**(`decisions` (4)의 「인증 등급」 대조 — ② 2차 패치로 추가).
4. 금지 목록 2행이 라우트 표에 **없다**.
5. `sse:true` 행(`stream`·`logs-stream`)이 표에서도 `sse=true`다.
6. `sendsEditClient`가 true인 행이 **정확히 3개**이고 그 id가 지정한 3개다 — **그리고 step7 전송 계층이 강제하는 집합과 같다**.
7. **소비자 매핑(일대다)**: ① 표의 모든 행이 소비자를 정확히 1개 가진다 ② 소비자가 `ProbeRunner`인 행은 **`health` 1개뿐**이다 ③ 나머지 36행의 소비자는 전부 `MODEL_KEYS` 안에 있다 ④ **`MODEL_KEYS` 35개 전부가 1행 이상**을 가진다 ⑤ **2행 이상을 가진 메서드는 `saveArticle` 하나**이고 그 행은 정확히 `{articles-create, articles-update}`다.
8. **`MODEL_KEYS` 35개가 전부 인터페이스에 있다** — 계약 파일이 아니라 `web/src/model/contract.js`를 읽어 대조하거나, 35개 이름을 표로 두고 **개수와 이름을 단언**한다(어느 쪽이든 「빠뜨림」이 red가 되어야 한다).

계약 파일 경로는 테스트에서 **리포 루트 기준 상대 경로**로 찾는다(빌드 디렉토리가 어디든 동작하도록 — 실패하면 **테스트가 red**여야지 skip하면 안 된다).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
```
- exit 0 · 테스트 총계 증가 · 실패 0 · 위 C의 **8항**이 전부 존재 · `FakeNewsModel` 규율 6종(결정적·무네트워크·35 전 구현·`stripPassword`·soft-delete·`saveArticle` 정규화) 테스트 존재 · `queryArticles` 결선 테스트(반복 키) 존재.
- 계약 파일을 **찾지 못하면 red**(skip 금지)임을 실증한다.

```
node scripts/verify-qt-client.mjs --scenario boot --server exe
node scripts/verify-qt-client.mjs --scenario boot --server spring
npm test
npm run lint
git status --porcelain
```
- 무회귀 · **`docs/api-contract/**` diff 0**(읽기만 했다) · `web/**` diff 0.

## 검증 절차

1. **TDD red 실증** 후 구현.
2. **변이 7종**:
   - M8-1 라우트 표에서 한 행을 지운다 → 집합 대조가 red인가? 원복.
   - M8-2 한 행의 `path`를 `/api/article/:id`로 오타 낸다 → red인가? 원복.
   - M8-3 `collection-receive`를 라우트 표에 넣는다 → 금지 목록 단언이 red인가? 원복.
   - M8-4 `sendsEditClient`를 4행으로 늘린다 → red인가? 원복.
   - **M8-5** `login`의 `auth`를 `session`으로 바꾼다 → **auth 대조(C-3)가 red**인가? 원복.
   - **M8-6** `articles-create` 행의 소비자를 비운다(`saveArticle`이 1행만 갖게) → **소비자 매핑(C-7 ⑤)이 red**인가? 원복.
   - **M8-7** `queryArticles`가 배열을 쉼표로 결합하게 한다 → **결선 테스트가 red**인가? 원복.
3. **드리프트 감지 실증**: 계약 파일을 **임시로** 한 행 늘린 복사본을 테스트가 읽게 해 red를 확인한다 — 단 **`docs/api-contract/endpoints.json` 원본을 고치지 마라**(복사본을 임시 경로에 두고 테스트가 경로를 받게 하거나, 이 확인을 수동으로 1회 하고 즉시 되돌려라. 되돌린 뒤 `git diff docs/api-contract/`가 비어 있음을 확인한다).
4. **한계를 요약에 적는다**: 이 두 겹은 요청 body shape의 전수 일치를 보증하지 않는다(`decisions` (4)).

## 되돌림

이 step의 소스·테스트·`common.pri` 항목 제거.

## 금지사항

- **`contract/**`·`docs/api-contract/**`를 고치지 마라.** 이유: 동결 계약이고, 클라가 계약에 맞춰야지 반대가 아니다. 계약에 없는 것이 필요하면 **`open_questions`로 올려라**.
- **라우트 문자열을 코드 여기저기 흩뿌리지 마라.** 이유: 표 하나가 아니면 기계 대조가 불가능해지고, 드리프트가 조용히 생긴다.
- **`collection-receive`·`collection-pull`을 호출 가능하게 만들지 마라.** 이유: 서버-대-서버 토큰 경로이고 네이티브 클라의 것이 아니다(`excluded` (i)).
- **35 메서드를 임의로 줄이거나 이름을 바꾸지 마라.** 이유: `MODEL_KEYS`가 프론트-백 통합 seam의 정본이고, 이름이 갈리면 P5·P7이 두 어휘를 오간다.
- **화면을 만들지 마라.** 이유: step10·step11의 것이다.
