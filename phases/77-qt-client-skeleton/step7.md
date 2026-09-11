# Step 7: net-http-core

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `decisions` (3)(4)(6)(7)(12) · `excluded` (i)
- `docs/ADR.md` **ADR-018** · **ADR-004**(신뢰 경계 · 매 요청 신원 재도출) · **ADR-009**(CSRF Origin/Referer 허용목록)
- `docs/api-contract/README.md` · **`docs/api-contract/reason-tokens.md`**(사유 토큰 → HTTP 상태 매핑 표) · `docs/api-contract/endpoints.json`(허용 헤더·인증 등급)
- `docs/news-md-overrides.md` — **L126·L128**(세션 운반: 쿠키 1차 · 헤더는 폴백) · **L22·L142**(423 계정 잠금 · 429 IP 제한) · **L131**(잠금 컬럼 비노출) · **L301**(CORS/Origin 방어선)
- **정본 소스(읽기 전용)**: `web/src/model/httpModel.js` — **70~79행 `buildQuery`**(쿼리 직렬화) · **81~110행 `request()`**(헤더 조립 · `credentials:'include'` · **98~101행 `body !== undefined`일 때만 Content-Type·본문** · `x-edit-client` 부착 지점) · **247~256행** 잠금 3종(`lockArticle`은 항상 본문 · unlock/force-unlock은 본문 없음) — **shape의 정본**
- **정본 잠금 테스트(읽기 전용)**: `web/src/model/httpModel.test.js` **197~202행**(배열 필터 = 반복 쿼리 키)
- **서버 실측(읽기 전용)**: `server/index.js` **283~305행 `csrfOriginGuard`** — **Origin·Referer가 둘 다 없으면 통과한다**(서버-서버/cron 클라이언트는 브라우저 공격 벡터가 아니다). 같은 파일 **564~584행** 세션 쿠키(`sid` · HttpOnly · 비프로덕션 `SameSite=Lax`) · **609~614행 `loginLimiter`**(커스텀 핸들러 없음 → 429 본문은 text/html) · **627~630행**(로그인 `locked` → 423) · **330행** `STATUS_BY_REASON.locked: 401`
- **계약 실측(읽기 전용)**: `contract/cases/auth-negative/login-negative.contract.js` **108~111행**(429 응답에 JSON 없음을 잠근다)
- **정본 셸(읽기 전용)**: `client/main.js` — `saveServer` 핸들러(**정규화 → 프로브 → 실패면 미저장 → 최종 origin 저장 → `config-saved`**) · `probeOrigin`(성공일 때만 승격 · `probe` payload `{origin,ok,finalOrigin,promoted,reason?}`)
- **호출부 데이터 흐름(읽기 전용)**: `web/src/controller/useWriteController.js` **116행**(`blankTab()`의 `clientId: null`) · **283행**(잠금 획득 시 `nextClientId()`)
- `phases/77-qt-client-skeleton/step2.md`(주소 판정) · `step4.md`(diag) · `step5.md`(`ProbeRunner` 주입 지점 · **`ProbeRunner::limitationNotice()`** — `client-qt/src/shell/proberunner.h` · 설정 화면이 형식 검사만으로 저장하는 현 상태)

## 배경

전송 계층은 **한 곳**이어야 한다 — 헤더·쿠키·타임아웃·오류 매핑이 두 곳에 생기면 규율이 갈린다.

확정된 계약 사실:

- **세션은 쿠키 자로 운반한다**(`decisions` (6) · override L126·L128). 서버는 쿠키 `sid` 우선, `x-session-id` 헤더 폴백인데 **폴백은 구현하지 않는다**.
- **쿠키를 디스크에 저장하지 마라**(`decisions` (6) — config 화이트리스트가 그 필드를 금지한다). 앱 재시작 = 재로그인.
- **`Origin` 헤더를 임의로 붙이지 마라.** 실측(`server/index.js` 289~292행): Origin·Referer가 **둘 다 없으면 통과**다. 잘못된 Origin을 붙이면 **403 `forbidden-origin`** 으로 상태 변경 요청이 전부 죽는다.
- **허용 헤더는 4종**(`Content-Type` · `x-session-id` · `x-collection-token` · `x-edit-client`)이고, 이 클라가 쓰는 것은 **`Content-Type`과 `x-edit-client`뿐**이다.
- **`x-edit-client`는 정확히 3 라우트에만** 실린다(`articles-lock`·`articles-unlock`·`articles-update` — `decisions` (3)). 값은 **편집 표면 1개당 1개**(`c-<uuid-v4>`), 프로세스당·세션당 금지. **웹은 이 불변식을 전송 계층이 아니라 호출부 데이터 흐름으로 지킨다**(`web/src/model/httpModel.js` `request()`는 `clientId`가 truthy면 어느 라우트에든 붙이지만, `web/src/controller/useWriteController.js` **116행** `blankTab()`이 `clientId: null`로 시작하고 283행의 잠금 획득 경로에서만 채워지므로 신규 기사 `POST`에는 실제로 붙지 않는다). **Qt는 라우트 표의 `sendsEditClient` 열로 전송 계층에서 구조적으로 강제한다 — 3 라우트 밖에서는 값이 있어도 붙이지 않는다. 관측 가능한 트래픽은 같다**(정본 동작의 강화이지 변경이 아니다).
- **오류 판별은 「토큰」이 아니라 「(라우트, 상태) 쌍」이 1차 키다 — 봉투가 항상 있는 것이 아니고, 같은 토큰이 두 뜻으로 쓰인다(② 2차 패치 · net 포트 스펙 실측).**
  - **로그인 429에는 사유 토큰이 없다 — 본문이 JSON이 아니다.** `server/index.js` **609~614행** `loginLimiter`에 커스텀 핸들러가 없어 express-rate-limit 기본 **text/html** 본문이 나간다(`contract/cases/auth-negative/login-negative.contract.js` **108~111행**이 `res.json === undefined`로 잠근다). ⇒ **429는 JSON 파싱 폴백보다 먼저 상태로 판정**하라. 순서를 거꾸로 두면 429가 「응답 깨짐(비-JSON)」과 같은 통에 떨어져 화면이 IP 제한을 알려 주지 못한다.
  - **`reason:'locked'`는 두 곳에서 재사용된다**: **423** `POST /api/login`(계정 잠금 5회/15분) · **401** `POST /api/articles/:id/lock`(편집 잠금 충돌 · `server/index.js` **330행** `STATUS_BY_REASON.locked: 401` · `docs/api-contract/reason-tokens.md` 표1 #8·표2 #1). **토큰 단독으로는 구분할 수 없다.** ⚠ **주석 드리프트 주의**: `server/index.js` **629행** 주석은 기사 편집 잠금을 「409」라 적었지만 **실제 코드 값은 401**이다(330행) — 주석을 믿고 409를 매핑하지 마라.
  - 로그인만 해도 401(자격 오류)·**423**(계정 잠금)·**429**(IP 레이트리밋)가 다르고 화면이 그것을 구분해 표시해야 한다(override L22·L142).
- **본문 없음 ≠ 빈 객체 본문.** 정본 `request()`는 `body !== undefined`일 때만 `Content-Type: application/json`과 본문을 싣는다(`httpModel.js` **98~101행**). 그래서 **`unlockArticle`·`forceUnlockArticle`·`runDistributionTick`·`deactivateDistributionTarget`은 `Content-Type`도 본문도 보내지 않고**, 반대로 **`lockArticle`은 `action`이 없어도 리터럴 `{}`를 보낸다**(`Content-Type` 전송 · 본문 `{}` — 247~256행). `QJsonObject` 하나로는 두 경우가 똑같이 빈 객체가 되어 **표현할 수 없다**(아래 `RequestSpec.body`).

## 작업

**테스트 먼저.** QtTest 안에서 **로컬 스텁 HTTP 서버**(`QTcpServer` 기반 최소 구현)를 띄워 왕복을 판정한다 — 실서버·네트워크에 의존하지 마라.

`client-qt/src/net/`에 전송 계층:

```cpp
struct HttpResponse { int status; QByteArray body; QJsonObject json; bool jsonOk; QString reason; };
struct RequestSpec  { QString routeId; QString method; QString path;
                      std::optional<QJsonObject> body;   // nullopt = 본문·Content-Type 미전송 / {} = "{}" 전송
                      QVariantMap query;                 // buildQuery 규칙으로 직렬화(아래)
                      QString editClientId; /*비어 있거나 라우트 표 sendsEditClient=false면 헤더 미부착*/ int timeoutMs; };

class HttpTransport {
public:
  HttpTransport(const QString& origin, Diag* diag);       // 쿠키 자는 내부 · 메모리 전용
  HttpResponse send(const RequestSpec&);                  // 동기 또는 콜백 — 선택은 재량
  void clearSession();                                    // 로그아웃·401 수신 시 쿠키 폐기
};
```

규율:

- **`net-request{route,method,status,ms}` diag를 요청마다 남긴다.** `route`는 **라우트 id 또는 경로 템플릿**이고 **구체 기사아이디를 적지 마라**(step4 C).
- **쿠키 자는 메모리 전용**이고 프로세스 종료와 함께 사라진다. 디스크 지속 금지.
- **세션 폐기는 「401 + `reason:'unauthenticated'`」일 때만** 하고 상위에 알린다(화면은 로그인으로 돌아간다 — step10). **401이 전부 세션 상실은 아니다**(`docs/api-contract/reason-tokens.md` 표1): `invalid-credentials`(로그인 자격 오류 — 세션이 원래 없다) · **`locked`(편집 잠금 충돌 — 세션은 멀쩡하다)**. `(articles-lock, 401, locked)`에서 세션을 버리면 잠금 충돌 한 번에 사용자가 로그아웃된다 — 위 「(라우트, 상태) 쌍」 규율의 실질 이유다. 자동 재시도·자동 재로그인 금지.
- **타임아웃을 반드시 걸어라**(무한 대기 금지). SSE는 예외이며 step9가 별도로 다룬다.
- **응답의 `lockerSessionId`·`lockerClientId`를 읽는 코드를 만들지 마라** — 그 두 필드는 **어떤 응답에도 없다**(override L131). 있을 것으로 가정한 파싱은 조용한 버그가 된다.
- **본문 규율**: `body == nullopt`면 **`Content-Type`도 본문도 보내지 않는다**. `body`가 값(빈 객체 포함)이면 `Content-Type: application/json` + JSON 본문. **두 경우를 각각 테스트로 잠가라** — 정본 테스트(`web/src/model/httpModel.test.js`)에도 `lockArticle`의 action 부재 시 Content-Type·본문을 단언하는 케이스가 **없다**(무잠금 축이다).
- **오류 판별 순서**: ① 전송 실패(연결 거부·타임아웃) → ② **상태 코드 우선 판정**(특히 **429는 본문을 보기 전에** 확정) → ③ JSON 봉투가 있으면 `reason` 추출 → ④ 비-JSON이면 `jsonOk=false`. 상위에 올리는 판별 키는 **(라우트 id, 상태, reason?)** 이다 — `locked`를 토큰만으로 해석하는 코드를 만들지 마라.
- **쿼리 직렬화(`buildQuery`) — 정본 `web/src/model/httpModel.js` 70~79행과 동형으로 만든다.** 이 규칙이 목록 필터(`GET /api/articles?status=RDS&status=DDH`)를 만들므로 **step11 완료 게이트에 직결**된다(틀리면 목록이 빈 채로 green이 될 수 있다). 규칙:
  - 값이 **`null`/미지정이면 키 자체를 생략**한다(`key=`도 보내지 않는다).
  - **배열은 같은 키를 원소마다 반복 append**한다(`status=RDS&status=DDH`) — 쉼표 결합·JSON 배열·`status[]` 접미사 **금지**(서버의 반복 파라미터 IN 파싱이 깨진다). **빈 배열은 아무 키도 내지 않는다.**
  - 스칼라는 1회 append. **빈 문자열은 생략하지 않고 `key=`로 보낸다**(`URLSearchParams` 동작 그대로).
  - 결과가 비면 `?` 없이 빈 문자열, 있으면 `?` 접두.
  - **인코딩은 `URLSearchParams`(application/x-www-form-urlencoded)와 동형** — 공백은 `+`다. `QUrlQuery`의 기본 인코딩은 이것과 다를 수 있으니 **믿지 말고 케이스로 확인**하라(phase 73이 `encodeURIComponent` vs `URLSearchParams`에서 6코드 차이 · 공백 `+`를 실측한 축과 같다).
  - 정본 잠금 케이스를 그대로 옮긴다: `web/src/model/httpModel.test.js` **197~202행**(`departments: ['정치','경제']` → `getAll('departments')`가 두 값 · `status: 'DPS'` 단일). 여기에 `null` 생략 · 빈 배열 · 빈 문자열 · 공백·`&`·`=`·`+`·한글 케이스를 더한다.
- **리다이렉트 정책을 명시 설정하라(원자료 크로스체크 [1] 누락 2 — 판정 문서 밖 추가 항목)**: 정본 `fetch`는 기본이 `redirect:'follow'`이고 쿠키가 따라간 요청에도 실린다. Qt의 `QNetworkAccessManager` 기본 리다이렉트 정책이 무엇인지는 **이 트리에서 실측되지 않았다** — 기본값을 믿지 말고 **정책을 코드에서 명시**하고(프로브 경로와 일반 요청 경로 모두) 스텁 서버의 302로 한 번 실측해 요약에 적어라.
- `ProbeRunner`의 **실제 구현**을 여기서 붙인다: `GET <origin>/api/health` → step2의 `interpretHealthResponse`로 판정 · **성공일 때만** 리다이렉트를 따라간 **최종 URL로 `resolveFinalOrigin`** 승격(실패면 요청 origin 유지 — 오류 페이지·캡티브 포털로의 리다이렉트가 저장 주소를 바꾸면 접속 불능이 영구화된다 · `client/main.js` `probeOrigin` 주석). diag는 **정본 payload와 동형**으로 남긴다: `probe{origin, ok, finalOrigin, promoted, reason?}`(응답 URL 원문은 싣지 않는다 — `client/main.js` 190~200행). step5의 미구현 러너를 **교체**하고, 설정 화면의 「연결 확인」이 실제로 동작하게 한다(step5가 둔 `ProbeRunner::limitationNotice()` 덕분에 대역 안내는 실 러너가 도착하면 자동으로 사라진다 — 사라지는지 확인하라).
- **저장 순서를 정본으로 복원한다 — 「프로브 성공 → 그때만 저장」(step5가 넘긴 의무).** step5의 설정 화면은 프로브가 없어서 **주소 형식만 검사하고 저장**한다. 정본(`client/main.js` `saveServer` 핸들러)은 **정규화 → 프로브 → 실패면 저장하지 않음 → 성공이면 승격된 최종 origin을 저장 → `config-saved{origin}`** 이다. 실 러너를 붙이면서 이 순서를 복원하라 — 안 그러면 **도달 불가 주소가 저장**되고 다음 부팅이 곧장 실패 화면으로 간다. 저장되는 값은 **입력 origin이 아니라 프로브가 돌려준 최종 origin**이다.
- **편집 표면 식별자**: `EditClientId` 발급기(`c-<uuid-v4>`)와 보관소를 만든다. P4에는 편집 표면이 없으므로 **발급·부착 경로만** 존재하고, 테스트가 「3 라우트에만 부착되고 나머지에는 부착되지 않는다」를 단언한다. 이 step에서는 부착 대상 3 라우트 id를 **전송 계층의 단일 상수 집합**으로 두고, **step8의 라우트 표 `sendsEditClient` 열이 이 집합과 정확히 같아야 한다**(step8 C가 대조한다 — 두 정본이 생기지 않게 step8에서 상수를 표에서 파생시키는 것으로 바꿔도 된다).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
```
- exit 0 · 테스트 총계 증가 · 실패 0. 아래가 테스트로 존재해야 한다:
  - 스텁 서버 왕복: 200 JSON 파싱 · 비-JSON 본문 처리(`jsonOk=false`) · 타임아웃 · 연결 거부.
  - **쿠키 왕복**: 스텁이 `Set-Cookie: sid=...`를 주면 다음 요청에 그 쿠키가 실린다. `clearSession()` 후에는 실리지 않는다.
  - **헤더 규율**: `Origin` 헤더가 **나가지 않는다** · `x-session-id`가 나가지 않는다 · `x-edit-client`는 **3 라우트에만** 나간다(**3 라우트 밖 요청에 `editClientId` 값을 채워 넣어도 헤더가 붙지 않는다** — 구조적 강제의 실증).
  - **본문 2축(각각 별도 케이스)**: `body=nullopt` 요청은 **`Content-Type` 헤더와 본문이 모두 없다**(unlock·forceUnlock·tick·deactivate 형) · `body={}` 요청은 **`Content-Type: application/json` + 본문 `{}`** 가 나간다(lockArticle action 부재 형).
  - **상태·토큰 매핑**: 401/403/404/409/**423**/**429**/500/503 각각이 상위에 구분 가능한 결과로 전달된다. 특히 ① **text/html 본문의 429**가 「비-JSON 응답」이 아니라 **레이트리밋**으로 판정된다 ② 같은 `reason:'locked'`이 **(`login`, 423)** 과 **(`articles-lock`, 401)** 에서 서로 다른 결과로 올라간다.
  - **`buildQuery` 정본 동형**: `httpModel.test.js` 197~202행 케이스(반복 키) · `null` 생략(키 없음) · 빈 배열(키 없음) · 빈 문자열(`key=`) · 빈 맵(`?` 없음) · 공백(`+`)·`&`·`=`·`+`·한글 인코딩.
  - **프로브 → 저장 순서**: 스텁이 health 실패를 주면 **config가 저장되지 않고** `config-saved`가 남지 않는다 · 성공(302로 다른 origin 승격 포함)이면 **최종 origin이 저장**된다 · `probe` diag가 `{origin,ok,finalOrigin,promoted,reason?}` 형태다.
  - **리다이렉트 정책**: 스텁의 302에 대해 명시한 정책대로 동작한다(실측 결과를 요약에 기록).
  - `net-request` diag가 요청마다 남고 `route` 값에 **구체 기사아이디가 없다**.

```
node scripts/verify-qt-client.mjs --scenario boot --server exe
node scripts/verify-qt-client.mjs --scenario boot --server spring
npm test
npm run lint
git status --porcelain
```
- step6 게이트 무회귀(두 모드 exit 0) · `npm test`·`lint` 무회귀 · 무접촉 경로 diff 0.

## 검증 절차

1. **TDD red 실증** 후 구현.
2. **변이 8종**(M7-7은 2개 변이):
   - M7-1 `x-edit-client`를 **모든 요청에** 붙인다 → 부착 라우트 테스트가 red인가? 원복.
   - M7-2 `Origin: http://evil.example`를 붙인다 → 헤더 규율 테스트가 red인가? 원복. (**참고**: 실서버에서는 이 변이가 상태 변경 요청을 403으로 만든다 — 왜 이 규율이 있는지의 실증이다.)
   - M7-3 쿠키 자를 파일 지속으로 바꾼다 → 「디스크에 세션이 남지 않는다」를 검사하는 테스트가 있는가? 없으면 추가하고 다시 실증. 원복.
   - M7-4 `body`를 `QJsonObject`로 되돌려 nullopt와 `{}`를 합친다(nullopt도 `{}` 전송) → 본문 2축 중 **nullopt 케이스**가 red인가? 원복.
   - M7-5 판별 순서를 「JSON 파싱 먼저 → 상태」로 뒤집는다 → text/html 429 케이스가 red인가? 원복.
   - M7-6 세션 폐기 조건을 「모든 401」로 넓힌다 → `(articles-lock, 401, locked)` 케이스에서 쿠키가 지워져 red인가? 원복.
   - M7-7 `buildQuery`에서 `null`을 `key=`로 보낸다 / 배열을 쉼표로 결합한다(2개 변이) → 각각 red인가? 원복.
   - M7-8 저장 순서를 「저장 → 프로브」로 되돌린다(step5 동작) → 「프로브 실패 시 미저장」 케이스가 red인가? 원복.
3. **실서버 왕복 1회 확인**(수동): step6 드라이버가 띄운 서버에 대해 `/api/health` 프로브가 `probe{ok:true}`를 남기는지 본다(자동 판정은 step10이 로그인 시나리오와 함께 붙인다).
4. **Qt 쿠키 함정 확인**: 비프로덕션 서버 쿠키는 `SameSite=Lax`다. Qt의 쿠키 자가 이를 어떻게 다루는지 실측하고(실어 보내는가) 결과를 요약에 적어라 — **「될 것이다」로 넘기지 마라**.

## 되돌림

`client-qt/src/net/`의 이 step 파일과 테스트, `common.pri` 항목 제거. `ProbeRunner`는 step5의 미구현 러너로 되돌린다.

## 금지사항

- **`x-session-id` 헤더 경로를 만들지 마라.** 이유: 네이티브 클라에 cross-origin 개발 폴백이 필요 없고, 헤더 경로는 세션 토큰의 노출 표면을 넓힌다(`decisions` (6)).
- **`Origin`/`Referer`를 임의로 붙이지 마라.** 이유: 실측상 둘 다 없으면 통과이고, 틀린 값은 **403 `forbidden-origin`** 이다(`server/index.js` 289~303행).
- **세션 쿠키를 파일에 쓰지 마라.** 이유: 설정 파일은 신뢰 경계 밖이고 정본이 그 필드를 금지한다.
- **401에 자동 재로그인·재시도를 넣지 마라.** 이유: 서버가 신원을 매 요청 재도출하므로(ADR-004 · override L123-128) 401은 「지금 권한이 없다」는 서버의 판정이다 — 클라가 그것을 우회하려 하면 과거 권한 상승 버그의 패턴을 재생산한다.
- **응답을 캐시하지 마라**(특히 세션/신원). 이유: 같은 축이다.
- **여기서 SSE를 구현하지 마라.** 이유: step9의 것이고, 장수명 연결은 타임아웃·재연결 규율이 완전히 다르다.
