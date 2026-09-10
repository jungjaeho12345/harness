# Step 7: net-http-core

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `decisions` (3)(4)(6)(7)(12) · `excluded` (i)
- `docs/ADR.md` **ADR-018** · **ADR-004**(신뢰 경계 · 매 요청 신원 재도출) · **ADR-009**(CSRF Origin/Referer 허용목록)
- `docs/api-contract/README.md` · **`docs/api-contract/reason-tokens.md`**(사유 토큰 → HTTP 상태 매핑 표) · `docs/api-contract/endpoints.json`(허용 헤더·인증 등급)
- `docs/news-md-overrides.md` — **L126·L128**(세션 운반: 쿠키 1차 · 헤더는 폴백) · **L22·L142**(423 계정 잠금 · 429 IP 제한) · **L131**(잠금 컬럼 비노출) · **L301**(CORS/Origin 방어선)
- **정본 소스(읽기 전용)**: `web/src/model/httpModel.js` **81~100행 부근**(`request()` — 헤더 조립 · `credentials:'include'` · `x-edit-client` 부착 지점) — **shape의 정본**
- **서버 실측(읽기 전용)**: `server/index.js` **283~305행 `csrfOriginGuard`** — **Origin·Referer가 둘 다 없으면 통과한다**(서버-서버/cron 클라이언트는 브라우저 공격 벡터가 아니다). 같은 파일 **564~584행** 세션 쿠키(`sid` · HttpOnly · 비프로덕션 `SameSite=Lax`).
- `phases/77-qt-client-skeleton/step2.md`(주소 판정) · `step4.md`(diag) · `step5.md`(`ProbeRunner` 주입 지점)

## 배경

전송 계층은 **한 곳**이어야 한다 — 헤더·쿠키·타임아웃·오류 매핑이 두 곳에 생기면 규율이 갈린다.

확정된 계약 사실:

- **세션은 쿠키 자로 운반한다**(`decisions` (6) · override L126·L128). 서버는 쿠키 `sid` 우선, `x-session-id` 헤더 폴백인데 **폴백은 구현하지 않는다**.
- **쿠키를 디스크에 저장하지 마라**(`decisions` (6) — config 화이트리스트가 그 필드를 금지한다). 앱 재시작 = 재로그인.
- **`Origin` 헤더를 임의로 붙이지 마라.** 실측(`server/index.js` 289~292행): Origin·Referer가 **둘 다 없으면 통과**다. 잘못된 Origin을 붙이면 **403 `forbidden-origin`** 으로 상태 변경 요청이 전부 죽는다.
- **허용 헤더는 4종**(`Content-Type` · `x-session-id` · `x-collection-token` · `x-edit-client`)이고, 이 클라가 쓰는 것은 **`Content-Type`과 `x-edit-client`뿐**이다.
- **`x-edit-client`는 정확히 3 라우트에만** 실린다(`articles-lock`·`articles-unlock`·`articles-update` — `decisions` (3)). 값은 **편집 표면 1개당 1개**(`c-<uuid-v4>`), 프로세스당·세션당 금지.
- 오류는 `{ok:false, reason:'<토큰>'}` + HTTP 상태다. **상태와 토큰을 함께** 다뤄라 — 로그인만 해도 401(자격 오류)·**423**(계정 잠금)·**429**(IP 레이트리밋)가 다르고 화면이 그것을 구분해 표시해야 한다(override L22·L142).

## 작업

**테스트 먼저.** QtTest 안에서 **로컬 스텁 HTTP 서버**(`QTcpServer` 기반 최소 구현)를 띄워 왕복을 판정한다 — 실서버·네트워크에 의존하지 마라.

`client-qt/src/net/`에 전송 계층:

```cpp
struct HttpResponse { int status; QByteArray body; QJsonObject json; bool jsonOk; QString reason; };
struct RequestSpec  { QString routeId; QString method; QString path; QJsonObject body; QVariantMap query;
                      QString editClientId; /*비면 헤더 미부착*/ int timeoutMs; };

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
- **401을 받으면 세션을 폐기**하고 상위에 알린다(화면은 로그인으로 돌아간다 — step10). 자동 재시도·자동 재로그인 금지.
- **타임아웃을 반드시 걸어라**(무한 대기 금지). SSE는 예외이며 step9가 별도로 다룬다.
- **응답의 `lockerSessionId`·`lockerClientId`를 읽는 코드를 만들지 마라** — 그 두 필드는 **어떤 응답에도 없다**(override L131). 있을 것으로 가정한 파싱은 조용한 버그가 된다.
- `ProbeRunner`의 **실제 구현**을 여기서 붙인다: `GET <origin>/api/health` → step2의 `interpretHealthResponse`로 판정 · 리다이렉트를 따라간 **최종 URL로 `resolveFinalOrigin`** 승격(fail-safe 규칙 그대로) · `probe{ok,reason,origin}` diag. step5의 미구현 러너를 **교체**하고, 설정 화면의 「연결 확인」이 실제로 동작하게 한다.
- **편집 표면 식별자**: `EditClientId` 발급기(`c-<uuid-v4>`)와 보관소를 만든다. P4에는 편집 표면이 없으므로 **발급·부착 경로만** 존재하고, 테스트가 「3 라우트에만 부착되고 나머지에는 부착되지 않는다」를 단언한다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
```
- exit 0 · 테스트 총계 증가 · 실패 0. 아래가 테스트로 존재해야 한다:
  - 스텁 서버 왕복: 200 JSON 파싱 · 비-JSON 본문 처리(`jsonOk=false`) · 타임아웃 · 연결 거부.
  - **쿠키 왕복**: 스텁이 `Set-Cookie: sid=...`를 주면 다음 요청에 그 쿠키가 실린다. `clearSession()` 후에는 실리지 않는다.
  - **헤더 규율**: `Origin` 헤더가 **나가지 않는다** · `x-session-id`가 나가지 않는다 · `x-edit-client`는 **3 라우트에만** 나간다.
  - **상태·토큰 매핑**: 401/403/404/409/**423**/**429**/500/503 각각이 상위에 구분 가능한 결과로 전달된다.
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
2. **변이 3종**:
   - M7-1 `x-edit-client`를 **모든 요청에** 붙인다 → 부착 라우트 테스트가 red인가? 원복.
   - M7-2 `Origin: http://evil.example`를 붙인다 → 헤더 규율 테스트가 red인가? 원복. (**참고**: 실서버에서는 이 변이가 상태 변경 요청을 403으로 만든다 — 왜 이 규율이 있는지의 실증이다.)
   - M7-3 쿠키 자를 파일 지속으로 바꾼다 → 「디스크에 세션이 남지 않는다」를 검사하는 테스트가 있는가? 없으면 추가하고 다시 실증. 원복.
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
