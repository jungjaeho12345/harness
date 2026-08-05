# Step 1: history-write-visibility

## 목표

**ArticleHistory insert 실패가 아무 흔적도 남기지 않고 삼켜지는 것**을 막는다. 실패해도 본 기능(편집·전이·배부)을 막지 않는 현재 동작은 그대로 두고, 선택 주입 콜백 `onHistoryError`로 사실만 표면화한 뒤 합성 루트에서 `logService.warn`에 결선한다.

> **선행**: backend 패스의 두 번째 step. step0(`src/services/contentsProjection.js`)과 파일 중복이 없다.
> 수정 대상은 **`src/services/articleService.js`, `src/services/distributionService.js`, `src/controllers/index.js` 3개 + 테스트**다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md` — 백엔드 계층 분리와 "모든 의존성은 주입 가능", 배부 데이터 흐름(스풀 기록 + ArticleHistory `eventType='distribute'`).
- `docs/LOGS.md` — 로그 레벨·포맷 규율(파일/DB 저장 금지, in-memory 링 버퍼).
- `src/services/articleService.js`
  - `createArticleService({ articleModel, db, historyModel, distributionService })` — 주입 시그니처.
  - `function record(rec)` — `historyModel` 미주입이면 return, `try { historyModel.insert({ ...rec, createdAt: nowISO() }); } catch { /* 무시 */ }`.
  - 호출 지점 3곳: `update`(eventType `'edit'`), `applyAction`(eventType `'status'`, action=send/hold/kill/approveDelete), `syncEmbargoStatus`(eventType `'status'`, action `'embargo'`).
- `src/services/distributionService.js`
  - `createDistributionService({ distributionTargetModel, articleModel, historyModel, spoolWriter, now, onFailure })`.
  - `function notifyFailure(info)` — `onFailure`를 try/catch로 감싸 호출(알림 실패가 배부를 깨뜨리지 않는다).
  - `function record(rec)` — articleService와 동형으로 삼킨다. 호출 지점은 `if (okInKind > 0) record({ articleId, eventType:'distribute', action: kind, actorUserId })` 1곳.
- `src/controllers/index.js`
  - `createControllers(db, { sessionService, env, fetchFn, lockoutPolicy, spoolFs, logService, now })` — `logService`는 이미 선택 주입이며 "배부 실패처럼 fire-and-forget 경로에서 사라질 사실을 표면화하는 데만 쓴다"고 문서화돼 있다.
  - `createDistributionService({ …, onFailure: ({ articleId, targetId, kind, reason }) => logService?.warn?.(…) })` — 기존 결선 예시(이 모양을 그대로 따라 하라).
  - `createDistributionTickService({ …, onError: ({ articleId, error }) => logService?.warn?.(…) })` — 두 번째 선례.
  - `createArticleService({ articleModel, db, historyModel: articleHistoryModel, distributionService })` — 여기에 `onHistoryError`를 추가한다.
- `src/services/logService.js` — `warn(message)` 시그니처(문자열 1개).
- 테스트 참고: `test/articleService.test.js`, `test/articleHistoryService.test.js`, `test/distributionService.test.js`, `test/controllers.test.js` — 주입형 in-memory 모델/스텁으로 서비스를 조립하는 기존 패턴.

## 배경 (자기완결) — 왜 결함인가

ArticleHistory 행은 감사 기록만이 아니라 **판정 입력**이다.

- `eventType='distribute'` 행 = phase 48 tick의 "이미 배부됨" 멱등 판정 근거. 이 행이 없으면 다음 tick이 같은 기사를 **다시 스풀에 쓴다**(중복 배부 — ADR-008상 스풀 기록은 회수 불가).
- `eventType='status'`(action=`send` 등) 행 = phase 51의 사이클 경계(`cycleDistributedKinds`) 판정 근거. 이 행이 없으면 경계가 어긋나 배부가 조용히 누락되거나 조기 실행된다.
- `eventType='edit'` 행의 `markupVersion` = 기사이력비교 스냅샷.

지금은 `historyModel.insert`가 던지면(디스크/제약/락 오류) `catch {}`가 전부 삼켜, 운영자는 위 사건이 벌어질 때까지 아무것도 모른다. 반대로 예외로 승격하면 **이미 커밋된** 편집·전이·스풀 기록을 되돌릴 수 없는 상태에서 호출자를 깨뜨린다. 그래서 이 step의 결론은 "삼키되 반드시 남긴다"다.

## TDD — 테스트 먼저

1. `test/articleService.test.js`(또는 `test/articleHistoryService.test.js` 중 이력 시나리오가 모여 있는 쪽) — `historyModel.insert`가 항상 `throw new Error('db locked')` 하는 스텁을 주입하고:
   - **결함 재현**: `onHistoryError`를 주입하면 `update`·`applyAction`(전이 성공 경로) 각각에서 **정확히 1회** 호출되고, 인자에 `articleId`·`eventType`(`'edit'`/`'status'`)·`action`(있을 때)·`reason`(문자열)이 담긴다.
   - **본 기능 비차단 회귀**: 같은 상황에서 `update`는 `{ ok:true, … }`, `applyAction`은 기존 성공 결과를 그대로 돌려주고 Contents 상태 전이가 실제로 반영된다(이력 실패가 전이를 되돌리지 않는다).
   - **콜백 자체가 던져도 안전**: `onHistoryError`가 throw하는 스텁이어도 `update`/`applyAction`이 정상 반환한다.
   - **미주입 회귀**: `onHistoryError`를 주입하지 않으면(오늘의 조립) 예외 없이 오늘과 동일하게 동작한다.
   - **정상 경로 무소음**: insert가 성공하는 정상 시나리오에서는 `onHistoryError` 호출 0회.
2. `test/distributionService.test.js` — 스풀 쓰기는 성공하고 `historyModel.insert`만 던지는 스텁으로:
   - `onHistoryError`가 1회 호출되고 인자에 `articleId`·`eventType:'distribute'`·`action`(kind)·`reason`이 담긴다.
   - 반환값 `{ ok:true, distributed:[…], failed:[] }`가 **오늘과 동일**하다(이력 실패는 `failed`에 넣지 않는다 — 스풀은 실제로 나갔다).
   - `Contents.distributedAt` 갱신은 그대로 일어난다.
   - 기존 `onFailure`(스풀 미발송)는 이 시나리오에서 호출 0회다(두 신호를 섞지 않는다는 계약).
3. `test/controllers.test.js` — `logService` 스텁(`warn` 수집)을 주입해 `createControllers`가 조립한 서비스에서 이력 실패가 `warn` 한 줄로 남는지 확인한다. 메시지에 `articleId`·`eventType`이 들어가고 **본문(markupVersion)·세션 토큰·비밀번호 문자열은 없다**는 단언을 함께 넣는다.

기존 테스트는 수정하지 않는다(주입 인자 추가는 하위 호환이라 그대로 green이어야 한다).

## 작업

1. `src/services/articleService.js`
   - 팩토리 시그니처에 선택 주입 `onHistoryError`를 추가한다: `createArticleService({ articleModel, db, historyModel, distributionService, onHistoryError })`.
   - `record(rec)`의 catch에서 콜백을 호출한다. **콜백 호출 자체를 try/catch로 감싼다**(알림 실패가 본 기능을 깨뜨리지 않게 — `distributionService.notifyFailure`와 동형).
   - 콜백 인자 shape(계약, 두 서비스 공통): `{ articleId, eventType, action, reason }`.
     - `action`은 없는 이벤트(`edit`)에서는 `undefined`/`null`로 둔다.
     - `reason`은 사람이 읽을 수 있는 짧은 문자열(예: 오류 message). **에러 객체를 그대로 넘기지 마라** — 소비처가 스택을 로그에 흘릴 수 있다.
     - `rec.markupVersion`(본문 스냅샷) 등 페이로드는 **절대 담지 않는다**.
2. `src/services/distributionService.js`
   - 팩토리에 같은 이름의 선택 주입 `onHistoryError`를 추가하고 `record`의 catch에서 같은 shape으로 호출한다(호출도 try/catch로 감싼다).
   - **기존 `onFailure`를 재사용하지 마라** — 그 신호는 "수신처 미발송"을 뜻하므로 운영자가 이력 실패를 배부 실패로 오독한다.
   - `distribute`의 반환 shape(`distributed`/`failed`)·`distributedAt` 갱신·상태 가드 흐름은 한 줄도 바꾸지 않는다.
3. `src/controllers/index.js`
   - 두 서비스 생성부에 결선을 추가한다. 메시지는 기존 두 선례와 같은 톤의 한 줄로:
     `logService?.warn?.(\`history write failed articleId=${articleId} eventType=${eventType} action=${action ?? '-'} reason=${reason}\`)`
   - `logService` 미주입 시 조용히 생략되는 기존 규율(`?.`)을 유지한다.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm test          # 백엔드 — 실패 0, 개수는 step0 종료 시점 + 이번 신규 케이스
npm run test:web  # 웹 무접촉 — 87 files / 2124 tests, 실패 0(개수 불변)
```

`git diff --name-only`에 `web/`·`docs/`가 없어야 한다(백엔드 3개 + 테스트 파일만).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 2종:
   - `record`의 catch에서 콜백 호출을 지우면 신규 케이스만 red가 되는지 확인 후 원복.
   - 콜백을 감싼 try/catch를 제거하면 "콜백이 던져도 안전" 케이스만 red가 되는지 확인 후 원복.
3. 무음 삼킴 잔여 확인: `git grep -n "catch {" -- src/services/articleService.js src/services/distributionService.js`로 남은 빈 catch가 **의도적으로 남긴 것들뿐**인지 확인하고, 새로 발견한 것이 있으면 **고치지 말고** step 요약에 보고한다(범위 확장 금지).
4. 아키텍처 체크리스트:
   - 서비스가 `logService`를 직접 import하지 않았는가(주입 콜백만 — 계층 분리)?
   - 이력 실패가 예외로 승격되거나 재시도 루프가 생기지 않았는가?
   - DB 스키마·행 변경 0건인가? 앱 내 타이머·네트워크 egress 0건인가(ADR-008)?
5. `phases/54-audit-closeout/index.json`의 step1을 `completed` + `summary`로 갱신한다. summary에 콜백 shape `{ articleId, eventType, action, reason }`과 "onFailure와 분리"를 명시하라.

## 금지사항

- 이력 insert 실패를 예외로 승격하거나 호출자의 반환값을 실패로 바꾸지 마라. 이유: 편집·전이·스풀 기록은 이미 끝났고 되돌릴 수단이 없다 — 호출자를 깨뜨리면 사용자는 성공한 작업을 실패로 오인하고 재시도해 중복을 만든다.
- insert 재시도 루프·타이머·큐를 만들지 마라. 이유: ADR-008의 "앱 내 타이머 0건" 불변식을 깨고, 재시도는 중복 이력(=중복 배부 판정 오염)을 만든다.
- `distributionService.onFailure`로 이력 실패를 흘리지 마라. 이유: 그 신호는 "스풀 미발송"으로 소비되고 tick 요약 어휘와 섞이면 운영자가 배부 실패로 오독한다.
- 로그 메시지에 본문(`markupVersion`)·세션 토큰·쿠키·비밀번호·payload를 넣지 마라. 이유: LOGS.md 마스킹 규율이며, 로그는 Z 권한 화면(logs.do)으로 노출된다.
- `historyModel`·`articleModel`·DB 스키마를 수정하지 마라. 이유: 이 step은 관측 가능성만 다룬다 — 저장 경로를 건드리면 회귀 표면이 배부·이력 전체로 번진다.
- `server/index.js`를 수정하지 마라. 이유: 결선은 합성 루트(`createControllers`)에서 끝나며 transport는 이미 같은 `logService` 인스턴스를 공유한다.
- `docs/ADR.md`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라. 이유: 다른 세션이 편집 중이거나 이 phase의 소유가 아니다.
- 기존 테스트를 깨뜨리지 마라.
