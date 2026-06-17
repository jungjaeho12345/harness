# Step 2: history-service-wiring

기사 변경/송고 시점에 이력을 **같은 트랜잭션으로 원자적으로 기록**하도록 결선하고, 이력 조회 서비스 메서드를 추가한다.

원자성 요구(기사 저장과 이력 기록이 함께 커밋/롤백) 때문에 이 step은 두 결합 지점을 함께 다룬다: (a) `articleModel.insert/update`가 같은 트랜잭션 안에서 이력 행을 INSERT하도록 확장, (b) `articleService`가 어떤 이벤트를 어떤 메타데이터로 남길지 결정. 두 지점은 트랜잭션 경계로 묶여 있어 분리하면 원자성이 깨진다.

## 읽어야 할 파일

- `/src/services/articleService.js` — `create`/`update`/`applyAction`의 현재 흐름. `create`는 status RDS·`createdAt` stamp, `update`는 `editedAt` stamp, `applyAction`은 `transition`으로 다음 status를 구해 `articleModel.update` 호출(send면 `sender`/`sentAt`도 stamp). role은 항상 인자로 받는다(클라 신뢰 아님).
- `/src/models/articleModel.js` — `tx(db, fn)` 트랜잭션 헬퍼, `insert`/`update`가 각각 자체 `tx`로 Article+Contents를 원자 저장. **이력 INSERT를 이 tx 안에 합류**시켜야 한다.
- `/src/models/articleHistoryModel.js` — step 1의 `recordWithDb(dbHandle, entry)`(자체 트랜잭션 없음 — 외부 tx 안에서 호출). `findByArticleId`/`findSendByArticleId`.
- `/src/controllers/index.js` — `createArticleService({ articleModel, db })` 결선부. (다음 step에서 historyModel 주입을 추가할 것이나, 이 step에서는 서비스 시그니처에 주입구만 마련한다 — 아래 작업 4 참고.)
- `/docs/news.md` — 기사 생애주기(line 205~219: send/hold/kill/approveDelete 전이), API 명세(applyAction).
- `/docs/ADR.md` — ADR-006(서비스가 도메인 로직, 모델은 데이터 접근), ADR-004(role은 인자/세션 도출).
- `phases/1-history/step1.md` — historyModel 시그니처.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과 구현.

### (a) `src/models/articleModel.js` — 트랜잭션 안에서 이력 합류
1. `insert`/`update`가 선택적 `history` 항목을 받아, 기존 `tx(db, ...)` 콜백 **안에서** 이력 INSERT를 수행하게 확장한다. 권장 방식: 생성자 `createArticleModel(db, { articleHistoryModel } = {})`로 historyModel을 **선택 주입**받고, `insert({ article, contents, history })`/`update(articleId, { article, contents, history })`에서 `history`가 있으면 같은 tx 안에서 `articleHistoryModel.recordWithDb(db, history)`를 호출한다.
   - `history`가 없으면 기존 동작과 100% 동일해야 한다(기존 호출자·테스트 무회귀).
   - historyModel이 주입되지 않았는데 `history`가 전달되면: 안전하게 무시하거나 명확히 처리(테스트로 고정). 단 기존 경로는 깨지면 안 된다.
   - **반드시 같은 tx 안에서** 호출한다 — 별도 tx로 빼면 기사 저장은 됐는데 이력만 롤백되는 비원자 상태가 생긴다.

### (b) `src/services/articleService.js` — 이벤트 결정·기록 결선
2. `createArticleService({ articleModel, db, articleHistoryModel } = {})`로 historyModel을 **선택 주입**받는다(없으면 이력 기록을 건너뛰되 나머지 동작은 동일 — 하위호환).
3. 이벤트 기록 결선(시각은 기존 `nowISO()` 재사용, `createdAt`은 이벤트 시각):
   - `create(dto)`: `articleModel.insert`에 `history = { articleId, eventType: 'create', actorUserId: dto.modifier ?? dto.author ?? null, title: dto.title ?? null, toStatus: 'RDS', createdAt }` 를 함께 넘긴다. (actor는 dto에서 도출 — 서비스는 role/userId를 인자로 받는 경로가 create엔 없으므로 dto 필드 사용.)
   - `update(articleId, fields)`: `eventType: 'edit'`, `actorUserId: fields.modifier ?? null`, `title: fields.title ?? null`. status 전이는 없으므로 from/toStatus는 NULL.
   - `applyAction(articleId, role, action, { userId })`: **전이가 성공해 실제로 저장될 때만** 이력을 남긴다. `eventType: action`(`send`/`hold`/`kill`/`approveDelete`), `actorUserId: userId ?? null`, `actorRole: role`, `fromStatus: row.contents.status`(전이 전), `toStatus: result.status`(전이 후). 기존 `articleModel.update(articleId, { contents })` 호출에 `history`를 합류시켜 **같은 트랜잭션**으로 기록한다.
   - 거부된 전이(`!result.ok`)·send의 `no-end-marker` 거부 등 **저장이 일어나지 않는 경로에서는 이력을 남기지 않는다.**
4. 조회 서비스 메서드 추가(읽기 전용, 위임만):
   - `getHistory(articleId)` → `articleHistoryModel.findByArticleId(articleId)`.
   - `getSendHistory(articleId)` → `articleHistoryModel.findSendByArticleId(articleId)`.
   - 반환 shape는 배열을 그대로(컨트롤러/라우트가 `{ ok, items }`로 감싼다). historyModel 미주입이면 빈 배열.
5. 테스트(`test/articleService.test.js` 확장 또는 `test/articleHistoryWiring.test.js` 신설): in-memory db + `createSchema` + 실제 `articleModel`+`articleHistoryModel`로 통합 검증.
   - `create` 후 `getHistory`에 `create` 이벤트 1건(toStatus RDS, title 보존).
   - `update` 후 `edit` 이벤트 추가, `getHistory`가 시간순.
   - `applyAction(send)` 성공 시 `send` 이벤트(from/toStatus·actorRole 보존), `getSendHistory`가 그 1건만 반환.
   - **거부된 applyAction(예: 정의 외 전이)은 이력을 남기지 않는다**(원자성·정합성).
   - 트랜잭션 원자성: 이력 INSERT가 기사 저장과 같은 tx인지(모델 tx 합류) — 모델 단에서 강제 실패를 주입해 롤백 시 기사·이력 둘 다 안 남는지(가능 범위에서) 검증.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. 위 AC 실행 — 기존 402개 무회귀(특히 기존 articleModel/articleService 테스트) + 신규 통과.
2. 체크리스트: 이력 기록이 기사 저장과 **같은 트랜잭션**인가? 거부된 액션은 이력을 남기지 않는가? historyModel 미주입 시 기존 동작과 동일한가(하위호환)? actorRole/userId가 서비스 인자에서만 도출되는가(클라 신뢰 아님)?
3. `phases/1-history/index.json`의 step 2 업데이트(completed + summary: 결선 지점·이벤트 매핑·시그니처 변경). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 이력 INSERT를 기사 저장과 별도 트랜잭션으로 분리하지 마라. 이유: 기사만 저장되고 이력이 롤백되는(또는 그 반대) 비원자 상태가 생긴다 — DB 정합성 위반.
- 거부/실패한 전이에서 이력을 남기지 마라. 이유: 실제로 일어나지 않은 변경을 이력에 남기면 정합성이 깨진다.
- 이력 행을 UPDATE/DELETE 하지 마라. 이유: 이력은 append-only·DB 비파괴.
- HTTP 라우트·컨트롤러 결선·프론트 코드를 건드리지 마라. 이유: step 3~5의 scope. 이 step은 서비스/모델 결선까지만.
- role 게이트(권한 검증)를 서비스에 박지 마라. 이유: ADR-004 — 인가 게이트는 HTTP 계층(step 3) 책임. 서비스는 인자로 받은 role을 기록만 한다.
