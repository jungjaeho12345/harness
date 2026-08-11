# Step 1: host-binding

## 목표

두 가지를 한다.

1. **listen 주소 설정화** — `bootstrap()`의 하드코딩된 바인드 주소를 `HOST` env로 바꾼다.

```js
app.listen(port, '127.0.0.1', ...)   // 현재
app.listen(port, host, ...)          // 목표 — host = HOST env, 기본 '127.0.0.1'(불변)
```

2. **수집 인제스트 fail-closed** — loopback 밖으로 바인딩하면서 `COLLECTION_TOKEN`을 설정하지 않으면 `POST /api/collection/receive`·`POST /api/collection/pull`을 **503 `collection-disabled`** 로 비활성한다. 부팅·다른 기능·FTP 스풀 인제스트는 그대로 동작하며, 부트 경고 로그도 함께 남긴다(운영자가 "왜 503인지" 알아야 한다).

수정 대상은 `server/index.js` 하나뿐이다(step0 완료본 위에서 시작한다). `src/**`·`web/**`·`docs/**`는 무수정이다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md` 73~80행(보안 경계) — 특히 *"외부 노출은 부트스트랩의 127.0.0.1 바인딩 + 선택적 토큰(COLLECTION_TOKEN)으로 좁힌다"* 계열 서술과 79행의 운영 환경변수 주의(NODE_ENV / FORCE_HTTPS는 서로 다른 축).
- `docs/ADR.md` — **ADR-004**(25~28행: 신뢰 경계는 서버, 세션에서만 role 도출), **ADR-009**(50~54행). **이 step에서는 읽기 전용·무접촉**(ADR-009 문장 정정은 step2 소관이다).
- `docs/RCV.md` — 수집(inbound) 계약. `/api/collection/*`가 사용자 세션이 아니라 `COLLECTION_TOKEN`(선택)으로만 보호된다는 사실을 확인하라.
- `server/index.js`(step0 완료본) — **이름으로 찾아라**(step0 편집으로 행 번호가 밀렸다).
  - `logOriginDiagnostics` — **이 step이 따라야 할 진단 헬퍼 전례**다: 인자 주입(`env`/`origins`/`logService`), 값 반환(테스트가 분기를 직접 확인), "부팅을 막지 않고 경고만" 정책, 로그 문구 수위.
  - `allowedOrigins(env = process.env)` — env를 인자로 받고 함수 안에서 `process.env`를 따로 읽지 않는 주입 seam 관례.
  - `isLoopbackOrigin` / `LOOPBACK_HOSTNAMES` — **재사용하지 마라**(금지사항 참조). 입력 문법이 다르다(origin URL vs 바인드 주소).
  - `createApp` 파라미터 주석 블록의 `cookieSecure`·`forceHttps` — **정책 불리언 주입 전례**다. "환경 판정은 부트가 하고 앱은 정책만 받는다"는 이 파일의 확립된 형태이며, 이 step의 `requireCollectionToken`이 정확히 같은 모양이다.
  - `STATUS_BY_REASON`의 `'spool-disabled': 503` 항목과 그 주석(*"배부 미설정(DIST_SPOOL_DIR 없음)은 클라이언트 잘못이 아니라 서버 기능 미가용이다"*) — 이 step이 쓰는 503의 의미론적 전례다.
  - `app.post('/api/collection/receive', ...)` · `app.post('/api/collection/pull', ...)` — 현재 토큰 검사는 다음 형태다(요청 시점에 `process.env`를 읽는다).
    ```js
    const required = process.env.COLLECTION_TOKEN;
    if (required && req.get('x-collection-token') !== required) {
      return res.status(401).json(UNAUTH);
    }
    ```
    그리고 그 위 주석 *"외부 노출은 부트스트랩의 127.0.0.1 바인딩 + 선택적 토큰(COLLECTION_TOKEN)으로 좁힌다."* — **이 주석이 이 step으로 낡는다**(바인딩이 설정 가능해지고, 대신 fail-closed 가드가 생긴다). 주석을 사실에 맞게 갱신하는 것까지가 이 step의 일이다.
  - `bootstrap()` — 현재 순서는 `origins 계산 → createApp → logOriginDiagnostics → port 계산 → app.listen(port,'127.0.0.1') → DIST_SPOOL_DIR 로그 → RCV_SPOOL_DIR watcher`다. **watcher의 `onFile`은 `controllers.collection.receive`를 직접 호출한다 — HTTP 밖 경로라 이 step의 가드와 무관하다**(파일 스풀 인제스트는 계속 동작한다).
  - step0이 추가한 `isSpaFallbackRequest`/`resolveSpaRoot`/`resolveSpaDir`와 마운트 블록 — 같은 파일의 헬퍼 스타일을 맞추기 위해 읽어라. **step0 산출물은 수정하지 마라.**
- `test/server.test.js` 756~790행 — **수집 HTTP 왕복 테스트 전례**다: `createReceiverConfigModel(ctx.db).insert({ sourceId: 'src-1', type: 'FTP', active: 'Y' })`로 소스를 등록하고 `POST /api/collection/receive`를 친 뒤 `ctx.controllers.article.query({ articleId })`로 DB 반영을 확인한다. `pull`은 같은 파일에서 `start({ fetchFn })`로 외부 호출을 주입해 결정적으로 만든다.
- `test/server.test.js` 24~56행 — `start()`/`api()` 헬퍼 형태.
- `test/csrf-origin.test.js`의 `logOriginDiagnostics` 테스트(175행 부근) — 가짜 `logService`로 로그 줄을 검사하는 스타일 기준.
- `phases/60-same-origin-serving/index.json`의 `decisions` (8)·(9)·(9-1)과 `excluded`.

## 배경 (자기완결 — 이전 대화 참조 없음)

**왜 여는가.** 현재 서버는 `127.0.0.1`에만 바인딩한다. "로컬 개발 + 외부 리버스 프록시" 전제에서는 안전한 기본값이지만, 후속 로드맵(단일 exe 서버를 사내 PC에 두고 다른 PC의 클라이언트가 접속)에서는 LAN 바인딩이 필요하다. 그래서 기본값은 그대로 두고 `HOST`로 열 수 있게만 한다.

**왜 경고만으로는 부족한가.** 앱의 라우트는 대부분 세션 게이트(ADR-004)로 보호되지만, 수집 인제스트 2개(`POST /api/collection/receive`, `POST /api/collection/pull`)는 사용자 세션 라우트가 **아니다**. 방어는 딱 두 겹이다 — (1) `127.0.0.1` 바인딩, (2) **선택적** `COLLECTION_TOKEN`. `HOST=0.0.0.0`으로 열면서 토큰을 설정하지 않으면 (1)이 사라지고 (2)는 애초에 없던 상태라 **방어가 0**이 된다. 같은 네트워크의 누구나 기사(자동기사)를 등록할 수 있다. 로그 경고는 사후 관측일 뿐 노출 자체를 막지 못하므로, 그 조합에서는 **라우트를 비활성(fail-closed)** 한다.

**왜 503인가.** 이 거부는 클라이언트가 뭔가 잘못해서가 아니라 **서버 구성상 그 기능이 지금 제공되지 않는다**는 뜻이다. 같은 파일의 `spool-disabled`(배부 스풀 미설정 → 503)와 정확히 같은 의미론이다. 401(인증 실패)·403(권한 없음)은 "토큰만 맞추면 된다"는 잘못된 신호를 준다.

**무회귀 경계.** `requireCollectionToken`의 기본값은 `false`이고, loopback 바인딩(= 기본 구성)에서는 부트가 `false`를 넘긴다. 즉 **기존 1015건 테스트와 기존 로컬/프록시 운영은 아무것도 바뀌지 않는다.** 토큰이 설정돼 있으면 loopback이든 아니든 기존 토큰 검사(401)가 그대로 작동한다. FTP 스풀 인제스트는 HTTP 밖 경로(watcher → controllers 직접 호출)라 어떤 경우에도 영향받지 않는다.

**CSRF/CORS는 손댈 필요가 없다.** 브라우저가 `http://192.168.x.x:3001/list.do`로 SPA를 받으면 그 페이지의 Origin은 서버의 자기 출처와 같으므로 `csrfOriginGuard`의 자기 출처 판정을 그대로 통과한다(ADR-009). `ALLOWED_ORIGINS`는 빈 목록 그대로가 정상이다. **이 phase에서 CORS·CSRF 코드를 고치지 마라.**

## TDD — 테스트 먼저

신규 파일 `test/host-binding.test.js`를 만든다(**기존 테스트 파일 무수정**). `bootstrap()`은 테스트가 실행하지 않으므로(`import.meta.url === argv[1]` 가드), 검증 대상은 **export된 순수 헬퍼 3개 + `createApp` 정책 주입의 HTTP 왕복**이다.

> **env 원복 주의**: D 계열은 `process.env.COLLECTION_TOKEN`을 실제로 세팅한다(라우트가 요청 시점에 `process.env`를 읽는다). 각 테스트는 **`try/finally`로 원래 값을 복원**하라(원래 미설정이면 `delete process.env.COLLECTION_TOKEN`). 복원을 빠뜨리면 같은 프로세스의 다른 테스트 파일이 오염된다.

**A. `resolveHost(env)`**

1. `HOST` 미설정(`{}`) → `'127.0.0.1'`.
2. `HOST: ''` → `'127.0.0.1'`(빈 값은 기본값 — 오타로 조용히 전 인터페이스에 열리지 않게).
3. `HOST: '   '` → `'127.0.0.1'`(공백만도 동일).
4. `HOST: '0.0.0.0'` → `'0.0.0.0'`.
5. `HOST: '  192.168.0.10  '` → `'192.168.0.10'`(트림).
6. `HOST: '::'` → `'::'`(IPv6 전 인터페이스도 그대로 전달 — 값 해석은 Node에 맡긴다).
7. **주입 seam 잠금**: 인자로 받은 env만 본다 — `process.env.HOST`를 임시로 세팅해도 인자로 넘긴 `{}`의 결과가 `'127.0.0.1'`이다(테스트 후 `process.env`는 반드시 원복).

**B. `isLoopbackHost(host)`**

8. `'127.0.0.1'` · `'localhost'` · `'::1'` · `'[::1]'` → `true`.
9. **`'127.0.0.2'` · `'127.1.2.3'` → `true`**(127.0.0.0/8 전체가 loopback이다 — 이 판정이 좁으면 오탐이 경고가 아니라 **수집 기능 차단**이 된다).
10. `'0.0.0.0'` · `'::'` · `'192.168.0.10'` · `'10.0.0.5'` → `false`.
11. `undefined` · `''` · 비문자열 → `false`(모르는 값은 "개방"으로 간주하는 안전 방향).
12. `'LOCALHOST'` → `true`(대소문자 무관).

**C. `logHostDiagnostics({ host, env, logService })`**

13. `host: '127.0.0.1'`, 토큰 없음 → **경고 0줄**, 반환 `false`.
14. `host: 'localhost'` / `'::1'` / `'127.0.0.2'`, 토큰 없음 → **경고 0줄**(B와 같은 판정을 공유한다는 증거).
15. `host: '0.0.0.0'` + `COLLECTION_TOKEN` 미설정 → **WARN 정확히 1줄**, 반환 `true`. 메시지에 실제 host 문자열과 `COLLECTION_TOKEN`이라는 **변수명**, 그리고 수집 인제스트가 **비활성(disabled)** 이라는 사실이 담긴다(경고를 보고 503의 원인을 알 수 있어야 한다).
16. `host: '0.0.0.0'` + `COLLECTION_TOKEN: 'secret-value'` → **경고 0줄**, 반환 `false`.
17. `host: '192.168.0.10'` + 토큰 없음 → 경고 1줄.
18. **마스킹**: 케이스 16 상황에서 어떤 로그 줄에도 토큰 **값**(`'secret-value'`)이 등장하지 않는다.
19. `logService` 미주입에도 throw하지 않는다.

**D. 수집 fail-closed — HTTP 왕복 (`test/server.test.js` 756~790행 패턴 재사용)**

각 케이스는 **등록된 소스를 미리 심어 둔 상태**로 친다(`createReceiverConfigModel(db).insert({ sourceId:'src-1', type:'FTP', active:'Y' })`). 그래야 거부가 "미등록(403 unregistered)" 때문이 아님이 증명된다.

20. **비활성**: `createApp({ ..., requireCollectionToken: true })` + `COLLECTION_TOKEN` 미설정 →
    - `POST /api/collection/receive`(등록된 sourceId, 정상 payload) → **503**, `body.reason === 'collection-disabled'`.
    - `POST /api/collection/pull`(등록된 API 소스) → **503**, 같은 reason.
    - **DB 증가 0**: 요청 전후로 `controllers.article.query({})`의 길이가 같다(부수효과가 전혀 없다).
    - 주입한 `fetchFn`이 **호출되지 않는다**(pull이 외부 호출까지 가지 않았다는 증거 — 가드가 라우트 최상단에 있다).
21. **토큰이 있으면 기존 계약 그대로**: `requireCollectionToken: true` + `COLLECTION_TOKEN: 'tok'` →
    - 헤더 `x-collection-token: 'tok'` → **200**, 기사 1건 증가(`attribute === '자동기사'`).
    - 헤더 불일치(`'wrong'`) → **401** `unauthenticated`(503 아님 — 토큰이 설정된 순간부터는 기존 인증 계약이다).
    - 헤더 누락 → **401**.
22. **기본값 무회귀**: `createApp({ ... })`에 `requireCollectionToken`을 **주입하지 않고**(기본 `false`) `COLLECTION_TOKEN`도 미설정 → `POST /api/collection/receive` → **200**, 기사 1건 증가(현행 동작과 완전히 동일).
23. **부작용 범위 잠금**: 케이스 20과 같은 구성(`requireCollectionToken: true`, 토큰 미설정)에서 `GET /api/health` → 200, 로그인 → 200, `GET /api/articles`(세션 포함) → 200. **수집 2개 라우트만 막힌다.**

## 작업

### `server/index.js` — 1) 헬퍼 3개 export

`logOriginDiagnostics` 근처(부트 진단 헬퍼끼리 모으는 위치)에 추가한다.

```js
// 바인드 주소가 loopback인가 — 진단·수집 fail-closed·문서가 같은 규칙을 공유하도록 단일 함수로 둔다.
// 127.0.0.0/8 전체를 포함한다: 판정이 좁으면 오탐이 '경고'가 아니라 '수집 기능 차단'이 된다.
// CSRF 가드의 isLoopbackOrigin과 공유하지 않는다 — 저쪽 입력은 origin URL이고 이쪽은 바인드 주소다.
export function isLoopbackHost(host) { /* → boolean */ }

// listen 바인드 주소 — 기본은 loopback(127.0.0.1)이다. 명시 설정(HOST)한 경우에만 넓힌다.
// 빈 문자열/공백은 기본값으로 수렴시킨다 — 오타나 빈 .env 항목으로 전 인터페이스에 열리면 안 된다.
// 판정은 인자로 받은 env만 본다(주입 seam — 함수 안에서 process.env를 따로 읽지 않는다).
export function resolveHost(env = process.env) { /* → string */ }

// 부트 진단 — loopback 밖 바인딩 + COLLECTION_TOKEN 미설정 조합을 경고한다.
// 이 조합에서는 수집 인제스트 2개 라우트가 503 collection-disabled로 비활성되므로(fail-closed),
// 경고에 그 사실을 담아 운영자가 503의 원인을 로그에서 추적할 수 있게 한다.
// 부팅은 막지 않는다(LAN 개방은 의도된 배포 형태다) — logOriginDiagnostics와 같은 정책.
// 로그에 토큰 '값'은 절대 담지 않는다(LOGS.md 마스킹) — 변수명만 언급한다.
// 반환값은 "경고를 남겼는가" — 테스트가 분기를 직접 확인하기 위한 것이고 호출부는 쓰지 않는다.
export function logHostDiagnostics({ host, env = process.env, logService }) { /* → boolean */ }
```

경고 문구는 기존 부트 로그(`API server on ...`, `allowed origins (CORS/CSRF): ...`)의 수위에 맞춘 영문 한 줄로 쓰고, **무엇이 위험한지**(비-loopback 바인딩) + **지금 무슨 일이 일어났는지**(수집 인제스트 HTTP 라우트 비활성) + **무엇을 하면 되는지**(`COLLECTION_TOKEN` 설정)를 담는다.

### `server/index.js` — 2) `createApp`에 정책 불리언 + 라우트 가드

- 시그니처에 `requireCollectionToken = false`를 추가하고, 파라미터 주석 블록에 근거를 남긴다: **host 문자열이 아니라 정책 불리언만 받는다**(앱은 자신이 어디에 바인딩되는지 몰라도 된다 — `forceHttps`·`cookieSecure`와 같은 형태). 기본 `false`라 미주입 기존 테스트는 무회귀다.
- 두 수집 라우트의 **최상단**(기존 토큰 검사 바로 위)에 가드를 넣는다. 기존 토큰 검사 코드는 **한 글자도 바꾸지 마라.**

```js
// fail-closed — loopback 밖 바인딩인데 토큰이 없으면 이 라우트는 제공하지 않는다(503).
// 세션 게이트가 없는 라우트라 이 조합에서는 방어가 0이 된다. 클라이언트 잘못이 아니라
// 서버 구성상 기능 미가용이므로 401/403이 아니라 503이다('spool-disabled' 503과 동형).
if (requireCollectionToken && !process.env.COLLECTION_TOKEN) {
  return res.status(503).json({ ok: false, reason: 'collection-disabled' });
}
```

- 토큰은 기존 코드와 동일하게 **요청 시점에 `process.env`에서** 읽는다(부트 시점 스냅샷으로 바꾸지 마라 — 기존 라우트와 동작이 갈린다).
- `STATUS_BY_REASON`에 `collection-disabled`를 추가하지 **마라.** 그 맵은 컨트롤러/서비스가 돌려주는 reason 토큰용이고, 이 거부는 라우트가 직접 내는 응답이다(바로 위의 토큰 401과 같은 층).
- 로그는 이 가드에서 남기지 않아도 된다(요청 로거가 `POST /api/collection/receive 503`을 남기고, 원인은 부트 경고에 있다).

### `server/index.js` — 3) `bootstrap()` 결선 (순서 조정 포함)

`resolveHost()`를 **`createApp` 호출보다 앞으로** 옮겨야 정책 불리언을 만들 수 있다.

```js
const origins = allowedOrigins();
const host = resolveHost();                                   // (신규) createApp보다 먼저 계산
const app = createApp({
  controllers, logService, forceHttps, origins,
  spaDir: /* step0 산출물 그대로 */,
  requireCollectionToken: !isLoopbackHost(host),               // (신규) 정책만 주입
});
logOriginDiagnostics({ origins, logService });
logHostDiagnostics({ host, logService });                      // (신규)

const port = Number(process.env.PORT) || 3001;
app.listen(port, host, () => {
  logService.info(`API server on http://${host}:${port}`);
});
```

- 기동 로그에 **실제 바인드 host**를 찍는다(하드코딩된 `127.0.0.1` 문자열을 남기지 마라 — 운영자가 로그만 보고 오판한다).
- `bootstrap()`의 다른 줄(스키마·백필·`DIST_SPOOL_DIR`·`RCV_SPOOL_DIR` watcher)은 건드리지 마라. step0이 추가한 `spaDir` 결선도 그대로 둔다.

### `server/index.js` — 4) 낡은 주석 갱신 (로직 0줄)

두 수집 라우트 위의 *"외부 노출은 부트스트랩의 127.0.0.1 바인딩 + 선택적 토큰(COLLECTION_TOKEN)으로 좁힌다."* 를 사실에 맞게 고친다. 취지: 기본값은 여전히 루프백이고, `HOST`로 넓히면 **토큰이 유일한 방어**가 되므로 토큰이 없으면 이 라우트가 503으로 비활성되며, 부트 경고가 그 사실을 알린다. 문장만 고치고 **토큰 검사 로직은 한 줄도 바꾸지 마라**.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step0 종료 시점 개수 + 신규 케이스(23건 이상: A 7 · B 5 · C 7 · D 4계열)
npm run lint      # 통과
```

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `server/index.js`, `test/host-binding.test.js` **2개**(+ 진행 기록 `phases/60-same-origin-serving/index.json`)뿐. `src/**`·`web/**`·`docs/**`·`README.md`·`.env.example` 증분 0.

**추가 확인**: `git diff phases/index.json`으로 60 항목이 여전히 `pending`이고 그 외 변경이 없는지 확인하라(이 파일은 계획 단계부터 `M` 상태라 증분 판정에 안 잡힌다).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. `git diff server/index.js`로 step0 산출물(`isSpaFallbackRequest`·`resolveSpaRoot`·`resolveSpaDir`·마운트 블록)이 **한 글자도 안 바뀌었는지** 확인하라(같은 파일을 두 step이 순차로 만지므로 이 확인이 필수다).
3. **기존 수집 테스트 무수정 green 확인**: `test/server.test.js`(수집 인제스트·pull 2건)·`test/csrf-origin.test.js`(collection 경로 2건)·`test/server-logging.test.js`(collection 로깅) — 기본값 `false`가 실제로 무회귀라는 증거다.
4. 변이 검증 5종(확인 후 반드시 원복):
   - `resolveHost`의 빈 문자열 폴백을 제거 → 케이스 2·3이 red.
   - 기본값을 `'0.0.0.0'`으로 바꿈 → 케이스 1이 red(**기본값 변경은 이 phase가 절대 하지 않는 일이다**).
   - `logHostDiagnostics`의 토큰 조건을 무시하고 항상 경고 → 케이스 16이 red.
   - 경고 메시지에 토큰 값을 덧붙임 → 케이스 18이 red(마스킹).
   - **fail-closed 분기(두 라우트의 503 가드)를 제거** → 케이스 20이 red(503 대신 200이 나고 DB가 증가한다).
5. `bootstrap()` 결선은 테스트가 실행하지 않는다 — `git diff`로 **눈으로** 확인하라: `app.listen(port, host, ...)`인가, `resolveHost()`가 `createApp` 호출보다 앞인가, `requireCollectionToken: !isLoopbackHost(host)`가 실제로 전달되는가, 기동 로그가 실제 host를 찍는가, `logHostDiagnostics` 호출이 listen보다 앞인가.
6. 실기 스모크(가능하면 수행하고 결과를 summary에 기록): (a) `npm run server` → 로그가 `http://127.0.0.1:3001`이고 경고 0줄, (b) `HOST=0.0.0.0 npm run server` → 기동 로그 host가 `0.0.0.0`, **경고 1줄**, 그리고 `curl -X POST http://127.0.0.1:3001/api/collection/receive -H "content-type: application/json" -d "{}"` → **503 collection-disabled**, (c) `COLLECTION_TOKEN`까지 준 상태 → 경고 0줄이고 503이 사라진다. 확인 뒤 서버를 반드시 종료하라. (PowerShell은 `$env:HOST='0.0.0.0'; npm run server` 형태이며, 확인 후 `Remove-Item Env:HOST`·`Remove-Item Env:COLLECTION_TOKEN`으로 원복하라.)
7. 아키텍처 체크리스트:
   - `createApp`이 **host 문자열·포트를 모르는가**(정책 불리언 하나만 받는가)?
   - 기존 토큰 검사(401)·수집 컨트롤러·서비스가 무수정인가(ADR-006: 라우트는 게이트와 shape 매핑만)?
   - CORS·`csrfOriginGuard`·`allowedOrigins`·세션/쿠키 코드가 무수정인가?
   - 새 타이머·egress·DB 접근이 0인가(ADR-008)?
   - 헬퍼가 인자만 보고 전역 상태를 직접 읽지 않는가(`allowedOrigins`·`logOriginDiagnostics` 관례)?
8. `phases/60-same-origin-serving/index.json`의 step1을 `completed` + `summary`로 갱신한다(헬퍼 3개 시그니처, 기본값 불변 확인, fail-closed 조건과 503 reason, 가드 위치, 갱신한 주석 위치, 테스트 증가분, 변이 5종 결과, 스모크 결과 명시).

## 금지사항

- **기본 바인드 주소를 바꾸지 마라.** 이유: `HOST` 미설정 시 동작이 `127.0.0.1`에서 달라지면 기존 배포·개발 환경이 조용히 네트워크에 노출된다. 이 step은 "열 수 있게" 만들 뿐 "열지" 않는다.
- **loopback 구성에서 `COLLECTION_TOKEN`을 필수로 만들지 마라.** 이유: 토큰 없이 루프백으로 운영·테스트 중인 기존 구성(그리고 기존 수집 테스트)이 즉시 깨진다. fail-closed는 **비-loopback 바인딩에서만** 발동하며, `requireCollectionToken` 기본값은 `false`다. 토큰 상시 필수화는 계약 변경이라 별도 phase에서 근거와 함께 한다.
- **`createApp`에 host 문자열·포트·`process.env` 접근을 추가하지 마라.** 이유: 앱은 자신이 어느 주소에 바인딩되는지 몰라도 되며(계층 침범), 환경 판정을 앱 안으로 들이면 `forceHttps`·`cookieSecure`가 세운 "부트가 판정하고 앱은 정책만 받는다" 형태가 무너진다. 넘기는 것은 불리언 하나뿐이다.
- **기존 토큰 검사 로직(401 `unauthenticated`)을 고치지 마라.** 이유: 토큰이 설정된 순간부터는 기존 인증 계약이 그대로 유효해야 하고, 이를 503으로 바꾸면 수집 클라이언트의 오류 처리가 뒤집힌다.
- **fail-closed 가드를 FTP watcher 경로(`bootstrap()`의 `onFile` → `controllers.collection.receive`)에 넣지 마라.** 이유: 그 경로는 HTTP 밖이고 파일시스템 권한으로 보호된다. 여기에 가드를 넣으면 토큰 없이 운영 중인 스풀 수집이 죽는다(이 phase가 막으려는 위험은 네트워크 노출이지 로컬 파일 드롭이 아니다).
- **비-loopback 바인딩에서 부팅을 실패시키거나, 방화벽·IP allowlist를 구현하지 마라.** 이유: LAN 개방은 후속 로드맵이 의도한 배포 형태다. 위험 표면은 수집 2개 라우트 fail-closed로 닫고, 나머지는 경고로 표면화한다.
- **`isLoopbackOrigin`/`LOOPBACK_HOSTNAMES`(CSRF 가드용)를 재사용하거나 수정하지 마라.** 이유: 입력 문법이 다르다 — 저쪽은 `http://host:port` **origin URL**을 파싱하고 이쪽은 **바인드 주소 문자열**(`0.0.0.0`·`::`)이다. 한쪽 요구로 공용 함수를 고치면 CSRF 게이트 판정이 오염된다. 별도 상수·별도 판정을 둬라.
- **로그에 `COLLECTION_TOKEN` 값·세션 토큰·쿠키를 담지 마라.** 이유: LOGS.md 마스킹 규율이며, 이 로그는 Z 전용 SSE로 그대로 흘러나간다.
- **CORS·`csrfOriginGuard`·`ALLOWED_ORIGINS`·HTTPS 강제 코드를 고치지 마라.** 이유: 동일 출처 배포에서는 자기 출처 판정으로 이미 통과한다 — 건드릴 이유가 없고, 건드리면 ADR-009 계약의 회귀 표면이 열린다.
- **step0이 추가한 SPA 서빙 코드를 수정하지 마라.** 이유: 같은 파일을 순차로 만지므로, 재수정이 섞이면 실패 원인 격리와 코드리뷰 diff 판독이 불가능해진다.
- **`src/**`·`web/**`·`scripts/**`·`docs/**`·`README.md`·`.env.example`를 수정하지 마라.** 문서·환경변수 예시·ADR-009 정정은 step2 소관이다.
- **`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**` 무접촉. `git add -A`/`git add .` 금지**, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
- 기존 테스트를 수정·삭제하지 마라.
