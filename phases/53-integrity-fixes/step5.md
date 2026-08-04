# Step 5: lock-integrity

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md` — TDD(테스트 먼저)
- `docs/ADR.md` — ADR-003(주입형 Model 계약), ADR-004(신뢰 경계=서버, 인가는 세션에서만), ADR-005(SSE는 무효화 신호만 — 클라이언트가 재조회)
- `docs/news.md` — 편집 잠금 수명(편집 탭 열면 잠금 획득, 강제 해제 수신 시 편집 탭 자동 종료), 151행(편집 저장은 잠금 보유 세션만)
- `web/src/controller/useWriteController.js` — **이 step이 수정하는 유일한 프로덕션 파일**. 파일 상단 잠금 수명 주석, `removeTab`(L193~203), **`openArticle`(L222~252)**, **SSE 잠금 핸들러(L382~395)**
- `web/src/model/httpModel.js` L88~118, L247~253 — `request`는 reject하지 않고 실패를 `{ ok:false, reason }`으로 정규화한다(`network-error`/`invalid-response`). `lockArticle(articleId, action, clientId)`는 성공 시 `{ ok:true }`만 돌려준다(잠금 메타 없음)
- `src/services/articleService.js` L141~162(읽기 경로 투영), L331~353(`acquireEditLock`) — **서버는 `lockerSessionId`·`lockerClientId`를 응답에서 제거**하고(phase 51) `lockYN`·`lockerUserId`·`lockedAt`만 내보낸다
- `src/services/contentsProjection.js` — `PRIVATE_CONTENTS_COLS = ['lockerSessionId','lockerClientId']`
- `server/index.js` 잠금 라우트(`/api/articles/:id/lock`·`/unlock`) — 실패 사유 토큰(`locked`·`forbidden`·`not-found`·`unauthenticated`)과 상태코드 매핑
- `web/src/test/fakeModel.js` — `lockArticle`/`unlockArticle`/`forceUnlockArticle`/`queryArticles`의 in-memory 모사(주의: fake는 `lockerUserId`를 stamp하지 않고 `lockerClientId`를 응답에서 지우지도 않는다 — 서버와 다르다)
- `web/src/controller/useWriteController.test.jsx` — `IDENTITY = { userId: 'kim', ... }`, `setup(seed)`, 기존 잠금 테스트('편집중입니다.' 2건, force-unlock 자동 종료 1건)

## 배경 (이 step 안에서 자기완결)

감사 발견 두 건을 **같은 모듈(작성 컨트롤러)** 에서 닫는다.

**(E) 잠금 획득 실패 fail-open** — `openArticle`(L242~246):

```js
const lock = await Promise.resolve(model.lockArticle(...)).catch(() => null);
if (lock && lock.ok === false && lock.reason === 'locked') { alert('편집중입니다.'); return null; }
// 그 외에는 그대로 편집 탭을 연다
```

네트워크 단절·401·403·서버 장애·비JSON 응답에서도 **무잠금 편집 탭이 열린다**. 사용자는 한참 편집한 뒤 저장에서 거부당한다(phase 51·52가 저장 인가를 강화해 거부는 확실해졌다 — 그만큼 편집분 유실 위험이 커졌다). phase 49 step7 이후 `httpModel`이 실패를 값(`network-error`/`invalid-response`)으로 정규화하므로 이제 사유별 판정이 가능하다.

**(D) SSE takeover 좀비 탭** — 잠금 신호 처리기(L391):

```js
if (a && a.lockYN === 'N') removeTab(t.id, { unlock: false });
```

타인이 강제 해제 후 곧바로 재획득(takeover)하면 `lockYN`은 `'Y'`로 유지되어 **내 편집 탭이 살아남고 계속 편집 가능**하다. 저장은 거부되지만 사용자는 그 사실을 모른 채 계속 쓴다.

**(D)의 트레이드오프 — 반드시 인지하고 문구에 반영하라**: 탭을 닫으면 그 탭의 **미저장 편집분이 사라진다**. 자동저장(초안)은 기본 off이고, 컨트롤러는 `editorDraft`를 import하지 않는다(ADR-003 계층 방향 — 저장/초안은 View·Model 책임). 즉 C·E가 "편집분 소실 방지"를 명분으로 삼는 것과 달리 D는 **의도적으로 편집분을 버리는 쪽**이다. 그럼에도 닫는 이유: 잠금은 이미 타인에게 넘어갔고(서버가 저장을 `not-holder`로 거부한다) 그 탭에서 계속 쓰는 모든 입력은 **어차피 저장될 수 없는 입력**이라, 살려두면 사용자가 더 오래 헛수고한 뒤 더 큰 분량을 잃는다. 그래서 안내 문구에 **"저장되지 않은 변경은 반영되지 않았다"는 사실을 반드시 명시**해 사용자가 상황을 알 수 있게 한다(무음 종료 금지).

판정 신호(확정 — 재논의하지 마라): 클라이언트가 볼 수 있는 보유자 신호는 **`lockYN`·`lockerUserId`·`lockedAt`뿐**이다(phase 51 step0이 `lockerSessionId`·`lockerClientId`를 응답 투영에서 제거했다). 따라서 **`lockerUserId` ≠ 내 `identity.userId`** 일 때만 takeover로 본다. `lockedAt` 변화 기반 판정은 같은 사람의 F5·재획득까지 오탐해 미저장 편집분이 있는 탭을 닫으므로 채택하지 않는다. 같은 사용자의 다른 탭 takeover는 이 phase에서 닫지 않는다(서버 계약 확장이 필요 — 범위 밖).

## 작업

### 1) 착수 전 실측

```bash
npm run test:web
npm run lint
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`web/src/controller/useWriteController.test.jsx`에 케이스를 추가한다.

**(E) 잠금 획득 실패** — 결함 재현(구현 전 red):

1. `lockArticle`이 `{ ok:false, reason:'network-error' }` → `openArticle` 반환 `null`, 편집 탭이 열리지 않는다(`tabs.some(t => t.articleId==='AKR1') === false`), 안내 alert 1회.
2. `lockArticle`이 `{ ok:false, reason:'unauthenticated' }` → 동일하게 미개방 + 안내.
3. `lockArticle`이 `{ ok:false, reason:'forbidden' }`(DPS 고침 권한 없음 등) → 미개방 + 안내.
4. `lockArticle`이 `rejects`(예외) → `.catch`로 `null`이 되어도 미개방 + 안내.
5. `lockArticle`이 `{ ok:false, reason:'not-found' }` → 미개방 + 안내.

정상 플로우 무손상(회귀 — 반드시 포함):

6. `{ ok:false, reason:'locked' }` → 기존 문구 **정확히** `'편집중입니다.'` + 미개방(기존 테스트 2건 그대로 green).
7. `{ ok:true }` → 편집 탭이 열리고 `clientId`가 발급·보관되며 필드 매핑이 그대로다(기존 테스트 green).
8. 이미 열린 기사 재진입(dedup)은 잠금을 다시 획득하지 않는다(기존 테스트 green).
9. `openFromSource`(후속/계속)는 잠금을 획득하지 않으므로 영향이 없다.

**(D) takeover 감지** — 결함 재현(구현 전 red):

10. 내 편집 탭(`AKR1`, `identity.userId === 'kim'`)이 열린 상태에서, 잠금 SSE 신호 수신 후 재조회 결과가 `{ articleId:'AKR1', lockYN:'Y', lockerUserId:'lee' }`(다른 사용자 보유) → 그 탭이 닫힌다. **`model.unlockArticle`은 호출되지 않는다**(남의 잠금을 풀려 하지 않는다). 안내 alert 1회이며, 그 문구에 **"저장되지 않은 변경은 반영되지 않았다"**는 취지의 조각이 포함된다(문구 조각으로 단언).
11. **서버 투영 정합**: 위 재조회 행에 `lockerClientId` 키가 **아예 없어도** 10의 판정이 성립한다(프로덕션 응답에는 그 키가 없다).

정상 플로우 무손상(회귀 — 반드시 포함):

12. `lockerUserId`가 내 `userId`와 같으면(정상 재연결·내 재획득) 탭이 유지된다.
13. `lockerUserId`가 없거나(레거시 NULL) `identity.userId`가 없으면 닫지 않는다(fail-safe — 닫기는 되돌릴 수 없다).
14. 기존 force-unlock 경로(`lockYN === 'N'`)는 그대로 자동 종료된다(기존 테스트 green) — 이 경로에는 안내를 추가하지 않는다.
15. 잠금 신호가 와도 편집 탭이 없으면 재조회조차 하지 않는다(기존 early return 유지).

테스트 셋업 힌트(강제 아님 — 계약을 깨지 않는 선에서 택일):
- fakeModel은 `lockArticle`에서 `lockerUserId`를 stamp하지 않는다. 테스트에서 seed 기사 객체를 직접 준비/변경해 `{ lockYN:'Y', lockerUserId:'lee' }` 상태를 만든 뒤, **다른 기사**에 `lockArticle`/`unlockArticle`을 호출해 `notify('lock')` 신호를 발생시키는 방식이 가장 가볍다.
- fakeModel을 확장해도 되지만, `MODEL_KEYS`·메서드 시그니처·응답 shape은 바꾸지 마라(`contract.test.js`와 다른 컨트롤러 테스트가 함께 깨진다).

### 3) 구현 — `web/src/controller/useWriteController.js`만 수정

**(E) `openArticle`**:

```js
const lock = await Promise.resolve(model.lockArticle(article.articleId, lockAction, clientId)).catch(() => null);
if (!lock || lock.ok !== true) {
  globalThis.alert?.(lockFailMessage(lock && lock.reason));
  return null;                    // 무잠금 편집 진입 금지
}
```

- 사유 → 문구 매핑은 모듈 스코프의 작은 상수 맵 + 폴백으로 만든다. 최소 매핑:
  - `locked` → `'편집중입니다.'` (**문자열 변경 금지** — 테스트가 잠근 계약)
  - `network-error`/`invalid-response` → 서버에 연결하지 못했다는 안내
  - `unauthenticated` → 세션 만료·재로그인 안내
  - `forbidden` → 편집 권한 없음 안내
  - `not-found` → 기사를 찾을 수 없음 안내
  - 그 외/미상 → 일반 실패 안내(사유 토큰을 문구에 덧붙여도 좋다. 단 `'(null)'`/`'(undefined)'` 같은 문자열이 사용자에게 보이지 않게 하라)
- 성공 판정은 `lock.ok !== true`(truthy 판정 금지).
- `openArticle`의 다른 동작(dedup, 단건 재조회 폴백, `clientId` 발급, 탭 push/활성화)은 그대로 둔다.

**(D) SSE 잠금 핸들러**:

```js
for (const t of editTabs) {
  const a = list.find((x) => x.articleId === t.articleId);
  if (!a) continue;                                  // 목록에 없으면 판단하지 않는다(기존)
  if (a.lockYN === 'N') { removeTab(t.id, { unlock: false }); continue; }   // 강제 해제(기존·무음)
  // takeover: 다른 사용자가 보유 중 → 내 탭은 좀비다
  if (myUserId && a.lockerUserId && a.lockerUserId !== myUserId) { /* 정리 + 안내 */ }
}
```

- `myUserId`는 `identity && identity.userId`에서만 얻는다(다른 출처 금지 — ADR-004의 클라이언트 값 불신 규율과 같은 규율).
- 탭 정리는 반드시 `removeTab(t.id, { unlock: false })` — **해제 요청을 보내지 마라**(남의 잠금이고 서버는 `not-holder`로 거부한다).
- 안내는 **takeover 경로에서만**, 여러 탭이 동시에 걸려도 **한 번만** 띄운다(닫힌 기사 id를 문구에 모아 넣어도 좋다). 기존 force-unlock 경로는 무음 종료를 유지한다(news.md 계약).
- 안내 문구에는 (1) 다른 사용자가 편집을 가져가 편집 탭이 닫혔다는 사실과 (2) **저장되지 않은 변경은 반영되지 않았다**는 사실이 **둘 다** 들어가야 한다(위 트레이드오프). 테스트에서 (2)에 해당하는 문구 조각을 단언해 잠가라.
- 핸들러는 마운트 시 클로저가 고정되므로 최신 신원을 봐야 한다면 기존 `authorRef` 미러링 패턴(ref)을 따르라. `identity`를 effect 의존성에 넣어 재구독시키는 방식은 **택하지 마라**(구독 해제/재연결이 늘어난다).
- 왜 `lockerUserId`만 보는지(서버 투영이 `lockerClientId`를 제거했다), 왜 같은 userId면 닫지 않는지(오탐 시 미저장 편집분 소실)를 주석으로 남겨라.

## Acceptance Criteria

```bash
npm run test:web    # 기준선 + 신규 케이스, fail 0
npm run lint        # clean
npm run build       # 번들 빌드 성공
npm test            # 백엔드 무접촉 확인 — 751 그대로 green
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증(각각 확인 후 반드시 원복):
   - `openArticle`의 새 fail-closed 분기를 제거하면 케이스 1~5가 red가 되는가?
   - takeover 분기를 제거하면 케이스 10·11이 red가 되는가?
   - takeover 판정에서 `myUserId` 가드를 제거하면 케이스 13이 red가 되는가?
3. 아키텍처 체크리스트:
   - 수정 범위가 `web/src/controller/useWriteController.js` + 그 테스트(+ 필요 시 `web/src/test/fakeModel.js`의 테스트 전용 보강)뿐인가? (`server/`·`src/`·`httpModel.js`·`contract.js` 변경 0건)
   - 판정에 `lockerClientId`/`lockerSessionId`를 쓰지 않았는가?(서버 응답에 없다)
   - 컨트롤러가 View를 import하지 않는가?
4. 결과에 따라 `phases/53-integrity-fixes/index.json`의 step 5를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "openArticle fail-closed 사유 매핑·takeover 판정 규칙(lockerUserId)·안내 정책·테스트 증감 요약"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- 잠금 실패 시 편집 탭을 여는 폴백을 남기지 마라(특정 사유만 예외 처리하는 것도 금지). 이유: 무잠금 진입은 동시 편집과 저장 거부로 이어지고, 사용자는 편집분을 잃는다 — fail-open이 바로 이번 감사 지적이다.
- `'편집중입니다.'` 문구를 바꾸지 마라. 이유: 기존 테스트 2건이 문자열을 계약으로 잠그고 있고, 사용자에게 익숙한 문구다.
- takeover 판정에 `lockerClientId`·`lockerSessionId`·`lockedAt`을 쓰지 마라. 이유: 앞의 둘은 phase 51 step0이 응답 투영에서 제거해 **프로덕션에는 존재하지 않는다**(fakeModel에만 남아 있어 잘못된 구현이 테스트를 통과한다). `lockedAt`은 같은 사람의 F5·재획득까지 오탐해 미저장 탭을 닫는다.
- takeover 감지 시 `model.unlockArticle`을 호출하지 마라. 이유: 이미 남의 잠금이라 서버가 `not-holder`로 거부하고, 무의미한 실패 요청만 남는다.
- 강제 해제(`lockYN === 'N'`) 경로에 안내를 추가하지 마라. 이유: news.md가 정의한 기존 무음 자동 종료 계약이며 이번 감사 지적 대상이 아니다.
- SSE 구독 effect의 의존성 배열을 늘려 재구독이 잦아지게 만들지 마라. 이유: 구독 해제/재연결이 늘면 신호 유실 창이 생긴다(기존 `[model, removeTab]` 유지 — 최신 값은 ref 미러링으로 얻는다).
- 서버(`src/`·`server/`)나 Model 계약(`contract.js`·`httpModel.js`)을 수정하지 마라. 이유: 이번 5건은 프론트 결함이며, 계약 확장은 별도 phase 결정이 필요하다.
- `web/src/controller/useViewController.js`의 `enterEditor`(L136~150, 같은 fail-open 패턴)를 이 step에서 함께 고치지 마라. 이유: 다른 모듈이라 한 step에 묶으면 실패 격리가 불가능하고, writer 측이 fail-closed가 되면 **무잠금 편집 자체는 이미 성립하지 않는다**(목록에서 이동은 되지만 편집 탭이 열리지 않고 안내가 뜬다). 안내 시점을 목록 페이지로 앞당기는 것은 UX 개선이라 후속 phase 후보다 — 근거는 `phases/53-integrity-fixes/index.json`의 excluded 항목에 있다.
- takeover 감지 시 편집분을 지키겠다고 컨트롤러에서 초안 저장(`editorDraft`)을 호출하지 마라. 이유: 컨트롤러가 View 모듈을 import하는 역방향 의존이 된다(ADR-003·ARCHITECTURE). 자동저장 정책 변경은 별도 phase 결정 사항이다.
- 기존 테스트를 깨뜨리지 마라.
