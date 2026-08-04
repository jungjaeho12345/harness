# Step 4: unlock-authz

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `docs/ADR.md` — ADR-004(신뢰 경계=서버, 클라이언트 값 불신), ADR-006(얇은 transport)
- `docs/news.md` — 편집 잠금 수명(편집 탭 닫기·송고/보류/KILL 성공·로그아웃/세션 만료·브라우저 탭 닫힘에 해제), Lock해제(강제 해제)는 D/Z 전용
- `src/services/articleService.js` — `acquireEditLock`(같은 탭 재획득 / 같은 사용자 재로그인 takeover / 같은 세션 다른 탭 차단 / stale 30분), `releaseEditLock`, `forceReleaseEditLock`, **`assertLockHolder`(phase 51 step1이 세션 userId 대조로 강화한 판정 — 이 함수의 규율을 그대로 따른다)**
- `src/controllers/index.js` — `article.releaseEditLock(articleId, opts)`는 서비스로 그대로 위임한다
- `server/index.js` — `POST /api/articles/:id/unlock`(현재 `x-edit-client` 헤더의 clientId만 넘긴다), 비교 대상으로 `PUT /api/articles/:id`(세션 `{ sid, me }`에서 신원을 넘긴다), `POST /api/articles/:id/force-unlock`(D/Z 게이트)
- `test/editLock.test.js` — 잠금 테스트 패턴
- `test/server.test.js` — 잠금/저장 e2e 패턴(`clientId` 헤더 전달 포함)
- `web/src/controller/useWriteController.js` — `model.unlockArticle(articleId, clientId)` 호출 지점(탭 닫기·탭 전환·pagehide/beforeunload). **이 step에서 web은 수정하지 않는다** — 호출 시점에 세션이 살아 있다는 사실만 확인하라.

## 배경 (이 step 안에서 자기완결)

2026-08-03 전수감사 발견 [low, phase 51에서 명시 제외 → 이월]: `releaseEditLock(articleId, { clientId })`는 보유자 **신원을 검증하지 않는다**.

```js
if (c.lockYN !== 'Y') return { ok: true };
if (c.lockerClientId && c.lockerClientId !== clientId) return { ok: false, reason: 'not-holder' };
```

`lockerClientId`가 NULL인 레거시 잠금 행이면 두 번째 조건이 falsy로 빠져 **아무 인증 사용자나 남의 잠금을 해제**할 수 있다. phase 51 step1은 저장(PUT) 경로(`assertLockHolder`)만 세션 userId 대조로 강화하고 해제 경로는 명시 제외했다. 이 step이 그 잔여를 닫는다.

확정된 설계(재논의하지 마라): `assertLockHolder`와 **동일한 관용도**를 유지한다 — 같은 `userId`면 세션이 바뀌어도(재로그인) 허용하고, `sessionId`는 판정에 쓰지 않는다. `lockerUserId`가 NULL인 레거시 행은 거부한다(해제 경로는 D/Z의 `force-unlock`과 30분 stale 재획득이 남아 있어 사용자가 영구히 막히지 않는다). `force-unlock`은 별개 권한이므로 **건드리지 않는다**.

## 작업

### 1) 착수 전 실측

```bash
npm test        # step 3 반영본 기준선 pass, fail 0
npm run lint
```

`src/services/articleService.js`의 `acquireEditLock`/`releaseEditLock`/`assertLockHolder` 세 함수와 그 주석을 정독하고, `articleModel.setLock`/`clearLock`이 쓰는 컬럼(`lockYN`, `lockerUserId`, `lockerSessionId`, `lockerClientId`, `lockedAt`)을 확인하라.

### 2) 테스트 먼저 (TDD — red 확인 필수)

`test/editLock.test.js`에 케이스를 추가하고, `test/server.test.js`에 e2e 회귀 1건을 추가한다.

**갱신 대상 기존 단언(이 step의 계약 강화로 필연적으로 red가 된다 — 규칙을 완화하지 말고 픽스처를 보강하라):**

- `test/editLock.test.js` L134~147 `'releaseEditLock: 보유 탭(clientId)은 해제할 수 있고 비보유 탭은 해제할 수 없다'` — L143의 **보유 탭 해제** `service.releaseEditLock(articleId, { clientId: 'c1' })`는 `userId`가 없어 새 규칙에서 `not-holder`가 된다. 잠금은 `{ userId: 'kim', sessionId: 's1', clientId: 'c1' }`으로 획득했으므로 `{ clientId: 'c1', userId: 'kim' }`으로 인자를 보강한다.
- `test/controllers.test.js` L203 `assert.equal(controllers.article.releaseEditLock(c.articleId, { clientId: 'c1' }).ok, true)` — 같은 이유로 `{ clientId: 'c1', userId: 'kim' }`으로 보강한다(그 위 L190에서 `userId: 'kim'`으로 획득한다).
- 이 두 건은 **보유자 본인의 정상 해제**이므로 인자 보강이 맞다. "userId가 없으면 통과"라는 폴백을 넣어 green을 만들면 이 step이 닫으려는 구멍(레거시 NULL·신원 미상 해제)을 그대로 남기는 것이다.
- 영향 없음(확인만 하고 건드리지 마라): `test/editLock.test.js` L139(비보유 탭 → 여전히 `not-holder`)·L151(미잠금 기사 → 판정 2단계 멱등 `ok`), `test/server.test.js`·`test/response-secrets.test.js` L121의 unlock 호출(라우트 경유라 서버가 세션 `userId`를 넣어준다).

공격/보안 시나리오:

1. 레거시 잠금 행(`lockYN='Y'`, `lockerUserId='kim'`, `lockerClientId=NULL` — 모델로 직접 셋업) → 다른 사용자 `lee`가 임의 clientId로 해제 시도 → `{ ok:false, reason:'not-holder' }`이고 **`lockYN='Y'`가 유지된다**(DB로 단언).
2. `lockerUserId='kim'`인 잠금을 `lee`가 **정확한 clientId를 알고** 해제 시도 → `not-holder`(탭 문자열을 알아도 사람이 다르면 거부).
3. `userId` 미전달(`releaseEditLock(id, { clientId })`) → `not-holder`("미전달이면 통과" 폴백 금지).
4. `lockerUserId`가 NULL인 잠금 행은 보유자를 자처하는 누구도 해제할 수 없다 → `not-holder`.
5. e2e(`test/server.test.js`): R이 `clientId=tab-r`로 잠근 기사를 D 세션이 `x-edit-client: tab-r`로 `POST /:id/unlock` → **403 not-holder** + 잠금 유지. 이어서 D가 `POST /:id/force-unlock` → 200(강제 해제 권한은 그대로 동작).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

6. 보유자 본인(같은 `userId` + 같은 `clientId`)의 해제 → `{ ok: true }` + `lockYN='N'`.
7. 재로그인 관용: 같은 `userId`가 새 세션(다른 sessionId)에서 같은 `clientId`로 해제 → `ok`(세션 일치를 강제하면 red).
8. 멱등: 잠기지 않은 기사(`lockYN='N'`) 해제 → `{ ok: true }`(탭 닫기·언로드 경로가 중복 호출한다).
9. 없는 기사 → `{ ok:false, reason:'not-found' }`(기존 계약 유지).
10. `acquireEditLock`(같은 탭 재획득·재로그인 takeover·다른 탭 차단·stale) 기존 케이스와 `assertLockHolder` 기존 케이스 전부 green.

### 3) 구현

#### 3-1. `src/services/articleService.js`

```js
function releaseEditLock(articleId, { clientId, userId } = {})
```

판정 순서(이 규칙에서 벗어나지 마라):

1. 기사/contents 없음 → `{ ok:false, reason:'not-found' }` (기존 유지)
2. `c.lockYN !== 'Y'` → `{ ok: true }` (멱등, 기존 유지)
3. `!userId || !c.lockerUserId` → `not-holder`
4. `c.lockerUserId !== userId` → `not-holder`
5. `c.lockerClientId && c.lockerClientId !== clientId` → `not-holder` (기존 탭 규칙 그대로)
6. `articleModel.clearLock(articleId)` → `{ ok: true }`

- 실패 사유는 전부 `not-holder`로 수렴한다(누가 잠갔는지 노출 금지 — `assertLockHolder`와 동일 규율).
- `sessionId`는 받지도 쓰지도 않는다(재로그인 관용 유지). 주석으로 그 의도를 남겨라.
- `acquireEditLock`·`assertLockHolder`·`forceReleaseEditLock`은 **한 줄도 바꾸지 마라**.

#### 3-2. `server/index.js` — `POST /api/articles/:id/unlock`

```js
const { me } = sessionOf(req);           // 이미 있는 인증 게이트
const clientId = req.get('x-edit-client');
const r = controllers.article.releaseEditLock(req.params.id, { clientId, userId: me.userId });
```

신원은 검증된 세션에서만 도출한다(ADR-004) — body/헤더에서 `userId`를 받지 마라. 컨트롤러(`src/controllers/index.js`)는 opts를 그대로 위임하므로 수정이 필요 없다(확인만 하라).

## Acceptance Criteria

```bash
node --test test/editLock.test.js test/server.test.js   # 신규 + 기존 잠금 테스트 green
npm test                                                # 전체 green, fail 0
npm run lint                                            # clean
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증: `lockerUserId` 대조 절(3·4)을 제거하면 시나리오 1~4와 e2e 5가 red가 되는지 확인하고 원복한다.
3. 기존 테스트가 red면 원인을 분류하라. **보유자 본인의 정상 해제인데 인자에 `userId`가 없어 실패하는 red는 픽스처를 고쳐라**(위 §2 "갱신 대상 기존 단언"). **정상 보유자가 올바른 인자로도 막히는 red만 구현 결함**이다. 어느 경우에도 판정 규칙을 완화해 green을 만들지 마라.
4. 아키텍처 체크리스트:
   - 수정 범위가 `src/services/articleService.js`(`releaseEditLock` 1개 함수) + `server/index.js`(unlock 라우트 1곳) + 테스트뿐인가? (`web/` 변경 0건)
   - DB 스키마·행 변경 0건인가? 잠금 해제는 `clearLock`(UPDATE)만 쓰고 행 삭제가 없는가?
   - ADR-004: 인가 판정 입력이 전부 서버(세션·DB)에서 왔는가?
5. 결과에 따라 `phases/52-security-hardening/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "판정 순서·관용도(재로그인 허용)·레거시 NULL 정책·테스트 증감 요약"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- `forceReleaseEditLock`과 `POST /:id/force-unlock`의 권한·동작을 바꾸지 마라. 이유: 강제 해제는 보유자 신원과 무관한 D/Z 전용 권한이며(news.md), 이 step의 표적이 아니다.
- `acquireEditLock`/`assertLockHolder`를 수정하지 마라. 이유: phase 51 step1이 확정하고 테스트가 잠근 계약이다. 함께 바꾸면 저장·획득 회귀의 원인 격리가 불가능해진다.
- `sessionId` 일치를 해제 조건으로 강제하지 마라. 이유: 재로그인(세션 갱신) 후 편집 탭이 잠금을 놓지 못해 잠금이 stale 30분까지 남고, 사용자는 자기 기사를 다시 열 수 없다고 느낀다(획득 경로의 `sameUserReLogin` 관용과 어긋난다).
- 멱등 계약(`lockYN!=='Y'` → `{ ok:true }`)을 깨뜨리지 마라. 이유: 탭 닫기/`pagehide`/탭 전환 경로가 같은 해제를 중복 호출하며, 여기서 실패를 반환하면 정상 종료 UX가 에러로 바뀐다.
- `lockerUserId`가 NULL일 때 통과시키는 폴백을 만들지 마라. 이유: 그 폴백이 바로 이번 감사 지적(레거시 NULL이면 아무나 해제)이다.
- 실패 사유에 보유자 식별자(userId/clientId)를 담지 마라. 이유: 잠금 보유자 노출은 phase 51 step0이 닫은 정보 노출 경로를 되살린다.
- `web/`(httpModel·useWriteController)을 수정하지 마라. 이유: 클라이언트는 이미 `clientId`를 보내고 `userId`는 서버가 세션에서 도출한다 — 변경이 필요 없다.
- 기존 테스트가 red라고 해서 판정 규칙을 완화하지 마라(특히 "`userId` 미전달이면 통과" 폴백). 이유: 그 폴백이 이번 감사 지적 그 자체이며, 라우트가 항상 세션 `userId`를 넣어주므로 프로덕션에는 미전달 경로가 없다. red 처리 원칙은 §검증 절차 3을 따른다 — 인자 보강이 필요한 픽스처는 §2에 목록으로 명시돼 있다.
- §2에 명시된 2건(`test/editLock.test.js` L143·`test/controllers.test.js` L203) 외의 기존 테스트를 손대지 마라. 이유: 그 밖의 red는 구현 결함 신호이며, 테스트를 고쳐 덮으면 회귀를 놓친다.
