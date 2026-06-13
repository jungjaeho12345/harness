# Step 7: controllers

## 읽어야 할 파일

- `/docs/ARCHITECTURE.md` — `controllers → services → models` 계층, 컨트롤러는 오케스트레이션
- `/docs/ADR.md` — ADR-006(얇은 transport, 계층형)
- 이전 step 산출물: `src/services/*`(articleService, lifecycle, sessionService, userService, authorization, collectionService, receiverConfigService, mediaSearch), `src/models/*`

## 작업

서비스/모델을 묶는 컨트롤러 계층을 구현한다. **비즈니스 로직 재구현 금지 — 서비스에 위임만**. TDD.

1. `src/controllers/index.js` — `export function createControllers(db, { sessionService } = {})`:
   - 내부에서 모델(userModel, articleModel, receiverConfigModel)과 서비스들을 생성/주입 결선한다. sessionService는 외부에서 주입받아 HTTP 계층과 공유한다(없으면 생성).
   - 반환: `{ auth, user, article, media, receiverConfig, collection }`
     - `auth`: `login`, `logout`, `manageUsers`, `editDps`, (필요시 session 헬퍼)
     - `user`: `query`
     - `article`: `query`, `search`, `create`, `update`, `applyAction`, `acquireEditLock`, `releaseEditLock`, `forceReleaseEditLock`, `assertLockHolder`
     - `media`: `search`
     - `receiverConfig`: `query`, `create`, `remove`
     - `collection`: `receive`
   - 각 메서드는 해당 서비스를 호출하는 얇은 래퍼.
2. 테스트(`test/controllers.test.js` 등): in-memory db로 createControllers를 만들고, 대표 흐름(로그인, 기사 create→applyAction, receiverConfig Z 게이트, media search)이 서비스로 위임되는지 검증.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. AC 실행.
2. 체크리스트: createControllers가 모든 도메인을 결선하는가? 컨트롤러가 로직을 재구현하지 않고 서비스에 위임하는가? sessionService 주입을 지원하는가?
3. step 7 업데이트(completed + summary: createControllers 반환 형태와 메서드 맵).

## 금지사항

- 컨트롤러에서 생애주기/인가/SQL을 다시 구현하지 마라. 이유: ADR-006 — 로직은 서비스/모델.
- Express/HTTP 코드를 넣지 마라. 이유: 다음 step(8)의 scope.
- 기존 테스트를 깨뜨리지 마라.
