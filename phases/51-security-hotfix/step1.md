# Step 1: save-lock-authz

## 목표

**기사 저장(PUT) 인가가 클라이언트가 보낸 문자열 하나만 보고 통과하는 구멍을 막는다 — 저장 권한을 검증된 세션 신원과 대조하게 한다.**

현재 `PUT /api/articles/:id`(server/index.js L593~613)는

```js
const clientId = req.get('x-edit-client');
const hold = controllers.article.assertLockHolder(req.params.id, { clientId });
```

로 끝난다. `assertLockHolder`(src/services/articleService.js L360~367)는 `lockYN === 'Y' && lockerClientId === clientId`만 본다. 즉 **잠금 보유자가 누구인지(어느 사용자·어느 세션인지) 서버가 전혀 대조하지 않는다.** 공격자는 자기 세션으로 로그인한 상태에서 남의 `clientId` 문자열만 알면 남이 편집 중인 기사를 덮어쓸 수 있다(ADR-004 "클라이언트가 보낸 값은 신뢰하지 않는다" 위반). step0이 `lockerClientId`를 응답에서 제거해 재료 하나를 없앴지만, **인가 판정 자체가 신원을 안 보는 것이 근본 결함**이다.

수정 방침: `assertLockHolder`가 **검증된 세션에서 도출한 userId/sessionId**를 받아 `Contents.lockerUserId`/`lockerSessionId`와 대조한다. 라우트는 세션에서만 그 값을 만든다(body/헤더의 사용자 값 사용 금지).

이 step은 **`src/services/articleService.js`의 `assertLockHolder` 한 함수 + `server/index.js`의 PUT 라우트 한 줄**만 바꾼다(+테스트). 잠금 획득/해제/강제해제 로직·모델·DB·web 무접촉.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ADR.md` — **ADR-004**(acting 신원은 검증된 세션에서만 도출), **ADR-006**(라우트는 세션 검증 → 인가 게이트 → 위임만).
- `docs/ARCHITECTURE.md` — "보안 경계" 절.
- `src/services/articleService.js` — **전체**를 읽되 특히:
  - `assertLockHolder(articleId, { clientId })`(L360~367) ← **수정 대상**.
  - `acquireEditLock(articleId, { userId, sessionId, clientId })`(L306~335) — 잠금 획득 규칙의 단일 출처. **L321~325의 a/b/c 모델**(같은 탭 재획득 허용 / 같은 사용자 재로그인 takeover 허용 / 같은 세션 다른 탭 차단)을 반드시 이해하고, **수정하지 마라**.
  - `LOCK_TTL_MS`/`isStale`(L10~11, L51~56) — 30분 stale 규칙. 이 step에서 건드리지 않는다.
  - `releaseEditLock`(L338~348)·`forceReleaseEditLock`(L351~356) — **수정 금지**(범위 밖, index.json excluded 근거).
- `server/index.js`
  - `sessionOf(req)`(L304~307) — `{ sid, me }`를 돌려주는 세션 판독기. `me.userId`가 검증된 사용자다.
  - `PUT /api/articles/:id`(L593~613) ← **수정 대상**(한 줄). 이미 `const { me } = sessionOf(req)`를 부르고 있다 — `sid`도 함께 꺼내면 된다.
  - `POST /api/articles/:id/lock`(L618~632) — 잠금 획득 시 `{ userId: me.userId, sessionId: sid, clientId }`를 넘기는 기존 결선(대조 대상 값이 어디서 오는지의 근거). **수정 금지**.
  - `STATUS_BY_REASON`(L84~104) — `'not-holder' → 403`. 사유 문자열을 바꾸면 HTTP 상태와 클라이언트 메시지 계약이 함께 깨진다.
- `src/controllers/index.js` L143 — `assertLockHolder: (articleId, opts) => articleService.assertLockHolder(articleId, opts)`(opts 통과만 — 수정 불필요).
- `test/editLock.test.js` — **전체**. L81~87의 `assertLockHolder` 테스트가 **이 step에서 갱신 대상**이다.
- `test/controllers.test.js` L186~195 — 컨트롤러 위임 테스트에도 `assertLockHolder` 호출이 있다(**갱신 대상**).
- `test/server.test.js` L313~360 — PUT 잠금 보유자 HTTP 테스트(같은 세션으로 lock→PUT 하므로 그대로 green이어야 한다. red가 나면 구현이 과하게 좁은 것이다).

## 배경 (자기완결)

잠금 행에는 세 개의 보유자 식별자가 함께 저장된다(`articleModel.setLock`):

| 컬럼 | 출처 | 성격 |
|---|---|---|
| `lockerUserId` | 검증 세션의 `me.userId` | **서버가 아는 신원** |
| `lockerSessionId` | 검증 세션 토큰 `sid` | 서버가 아는 신원(세션 단위) |
| `lockerClientId` | 클라이언트 헤더 `x-edit-client` | **클라이언트가 만든 탭 식별자** |

`clientId`는 "한 사용자가 여러 탭에서 동시에 편집하지 못하게" 하는 **탭 구분자**이지 인증 수단이 아니다. 따라서 판정은 `clientId`(탭) **AND** 세션 신원(사람) 둘 다여야 한다.

재로그인 takeover 정합(중요): `acquireEditLock`은 "같은 userId가 다른 sessionId로 재로그인"하면 takeover를 허용하고, 성공하면 잠금 행의 `lockerSessionId`/`lockerClientId`를 **새 값으로 덮어쓴다**. 그러므로 정상 흐름에서는 저장 시점의 세션과 잠금 행의 세션이 일치한다. 다만 세션이 갱신됐는데 탭이 재획득을 못 한 드문 경우까지 저장을 막으면 편집물이 유실될 수 있으므로, **판정의 필수 조건은 `lockerUserId === 세션 userId`** 로 두고 `sessionId` 불일치는 같은 사용자에 한해 허용한다(= `acquireEditLock`의 `sameUserReLogin`과 같은 관용도).

## 작업

### 1) `assertLockHolder` 시그니처·판정 확장

```js
// 해당 편집 탭(clientId)이 잠금 보유자인지 — 편집 저장(PUT) 인가에 쓴다.
// CRITICAL(ADR-004): clientId는 클라이언트가 만든 탭 식별자일 뿐이다. 저장 인가는 반드시
//   "검증된 세션의 userId"와 잠금 행의 lockerUserId를 함께 대조한다(문자열 하나로 인가하지 않는다).
function assertLockHolder(articleId, { clientId, userId, sessionId } = {})
```

판정 순서(모두 `{ ok:false, reason:'not-holder' }` 로 수렴 — 누가 잠갔는지는 절대 응답에 담지 않는다):

1. 행 없음 → `{ ok:false, reason:'not-found' }`(기존).
2. `lockYN !== 'Y'` → not-holder(기존).
3. `lockerClientId !== clientId` → not-holder(기존 탭 규칙 유지).
4. **신규**: `userId`가 없거나(`undefined`/`null`/`''`) `lockerUserId`가 비어 있거나 둘이 다르면 → not-holder.
   - "userId 미전달이면 통과" 같은 하위호환 폴백을 **만들지 마라** — 그 폴백이 곧 이번 취약점이다.
   - `lockerUserId`가 NULL인 과거 잠금 행도 거부한다(사용자는 편집 재진입으로 잠금을 다시 획득하면 복구된다 — DB를 고치지 않는다).
5. `sessionId` 불일치는 그 자체로 거부하지 않는다(같은 `userId`면 재로그인 takeover 정합).
   - 즉 **`sessionId` 인자는 현재 판정에 쓰이지 않는다**(라우트가 세션에서 넘겨 로그·감사·후속 강화의 접점으로만 존재한다). 이 사실을 **주석에 명시하라**: "sessionId는 판정에 쓰지 않는다 — `acquireEditLock`의 `sameUserReLogin`과 같은 관용도(같은 사용자의 재로그인 허용)를 유지하기 위함이다. 세션 일치를 강제하면 세션이 갱신됐는데 탭이 잠금을 재획득하지 못한 편집자의 저장이 거부돼 편집물이 유실된다."
   - 인자를 받아만 두고 안 쓰는 것이 lint(no-unused-vars 등)에 걸리면, **판정을 추가하지 말고** 주석 + 구조분해 형태로 해결하라(계약을 위해 남기는 인자다).

반환 shape(`{ ok:true }` / `{ ok:false, reason }`)과 사유 토큰(`not-holder`/`not-found`)은 **불변**이다.

### 2) 라우트 결선(한 줄)

`PUT /api/articles/:id`에서 `const { sid, me } = sessionOf(req)`로 세션 값을 꺼내

```js
const hold = controllers.article.assertLockHolder(req.params.id, {
  clientId, userId: me.userId, sessionId: sid,
});
```

- 값은 **오직 세션에서만** 온다. `req.body`/커스텀 헤더의 userId 류를 쓰지 마라.
- 라우트의 나머지(`fields.modifier = me.userId`, `delete fields.role`, 빈 부서 보정, `notifyChange('update')`)는 **그대로** 둔다.
- 컨트롤러는 opts를 통과시키므로 수정 불필요하다(확인만).

## TDD — 테스트 먼저

### (a) 서비스 단위 (`test/editLock.test.js`)

기존 L81~87 테스트를 **갱신**하고(인자에 userId/sessionId 추가) 아래를 추가한다:

1. 보유 탭 + 같은 사용자 → `{ ok:true }`.
2. **핵심 회귀**: 같은 `clientId`를 알고 있는 **다른 사용자**(`userId:'lee'`)의 요청 → `not-holder`.
3. 다른 `clientId` → `not-holder`(기존 규칙 보존).
4. `userId` 미전달(`{ clientId:'c1' }`) → `not-holder`(폴백 금지 잠금).
5. 같은 사용자·다른 `sessionId`(재로그인) + 같은 `clientId` → `{ ok:true }`.
6. `articleModel.setLock`으로 `lockerUserId: null`인 레거시 잠금을 만든 뒤 → `not-holder`.
7. 실패 응답에 `lockerUserId`/`lockerSessionId`/`lockerClientId`가 없다(보유자 비노출).

### (b) 컨트롤러 (`test/controllers.test.js` L186~195)

8. 위임 테스트를 새 인자 형태로 갱신한다(통과 인자 그대로 서비스에 전달되는지).

### (c) HTTP (`test/server.test.js` 또는 새 파일)

9. **핵심 e2e**: D(`desk1`)가 `x-edit-client: tab-d`로 잠금 획득 → R(`rep1`) 세션이 **같은 `tab-d`** 헤더로 `PUT /api/articles/:id` → **403 `not-holder`**, 그리고 DB의 제목/본문이 바뀌지 않았음을 단언(쓰기 0건).
10. 정상 경로 회귀: D가 자기 세션·자기 탭으로 PUT → 200, 제목이 실제로 바뀐다.
11. 기존 L335~360("같은 세션의 2번째 탭 차단") 테스트가 그대로 green.

각 케이스는 **구현 전 red 확인**(2·4·6·9는 현재 red여야 한다) 후 green으로 만든다.

## Acceptance Criteria

```bash
node --test test/editLock.test.js test/controllers.test.js test/server.test.js test/articleService.test.js
npm test                 # tests 636+N / fail 0  (step0가 올려둔 green 기준선 유지)
npm run lint
git diff --name-only      # web/ 변경 0건, src/models/·src/db/ 변경 0건
```

## 검증 절차

1. 위 AC 커맨드 실행 — `npm test` fail 0.
2. 변이 검증: `assertLockHolder`의 `lockerUserId` 대조 절을 제거하면 (a)-2·4·6과 (c)-9가 red가 되는가?
3. 아키텍처 체크리스트:
   - 라우트에 인가 판정 로직을 재구현하지 않았는가(판정은 서비스 한 곳 — ADR-006)?
   - 신원 값이 전부 `sessionOf(req)`에서만 오는가(`req.body`/헤더 파생 0건)?
   - `acquireEditLock`/`releaseEditLock`/`forceReleaseEditLock`은 무변경인가(`git diff`)?
   - DB 비파괴: 잠금 컬럼 백필·행 삭제 0건인가?
4. `phases/51-security-hotfix/index.json`의 step1 상태·summary를 갱신한다.

## 금지사항

- `assertLockHolder`에 "userId가 없으면 통과" 류의 하위호환 폴백을 넣지 마라. 이유: 그 폴백이 정확히 이번 취약점의 형태다 — 호출자가 인자를 빠뜨리면 조용히 인가가 열린다.
- 기존 테스트를 "통과시키기 위해" 판정을 약화하지 마라. 인자가 부족한 기존 테스트는 **테스트를 갱신**해서 맞춘다(테스트가 계약을 따라간다).
- `acquireEditLock`의 a/b/c 규칙(같은 탭 재획득·재로그인 takeover·같은 세션 다른 탭 차단)이나 stale 30분 규칙을 바꾸지 마라. 이유: 잠금 획득 UX 계약이며 이 step의 범위(저장 인가)가 아니다.
- `releaseEditLock`/`forceReleaseEditLock`을 함께 고치지 마라. 이유: 해제 경로는 후속 백로그다(index.json excluded) — 한 step에 두 인가 경로를 넣으면 회귀 원인 격리가 불가능하다.
- 거부 사유 토큰(`not-holder`)이나 HTTP 상태(403)를 바꾸지 마라. 이유: `STATUS_BY_REASON`과 클라이언트 메시지 매핑이 이 문자열에 묶여 있다.
- 거부 응답에 누가 잠갔는지(userId/sessionId/clientId)를 담지 마라. 이유: 기존 계약(editLock.test.js L35~37)이자 정보 노출이다.
- `x-edit-client` 헤더 자체를 제거하지 마라. 이유: 같은 사용자의 2번째 탭 차단이 이 값에 의존한다.
- 세션 토큰을 로그 message에 담지 마라. 이유: `logService` 마스킹 규율(server/index.js L174~176).
