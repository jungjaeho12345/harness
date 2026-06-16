# Step 6: translate-http

번역을 HTTP로 노출한다. **이 step은 얇은 transport 레이어(server/index.js)만 다룬다** — 번역 로직은 step5의 서비스/컨트롤러에 있다. `mediaSearch` 프록시 라우트(`GET /api/media/search`)와 동일한 세션 게이트 패턴을 따른다.

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-004(세션 게이트), ADR-006(얇은 transport).
- `/docs/ARCHITECTURE.md` — 보안 경계(외부 호출은 서버 프록시).
- `/docs/news.md` — 51~52행(미디어 프록시 패턴·실패 시 빈 결과), 85행(번역 메뉴), 186행(`/api/media/search` 프록시 라우트 존재).
- step5 산출물: `src/services/translate.js`(`translate(text, targetLang)` graceful), `src/controllers/index.js`(`translate.run` 또는 동등 위임).
- 현재 구현(반드시 정독):
  - `server/index.js` — `GET /api/media/search`(L303-310, 세션 게이트→`controllers.media.search` 위임→`{ ok, items, error }` 매핑). 이 패턴을 본떠라.
  - 테스트 패턴: `test/server.test.js`(media 위임 테스트 포함).

이전 코드를 정독하고, media 프록시 라우트가 어떻게 세션 게이트 후 위임·shape 매핑만 하는지 이해한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

`test/server.test.js`(또는 신규 `test/translate.http.test.js`, 실제 `createApp` + `:memory:` db, **번역 서비스는 가짜 fetchFn/env 주입**으로 결정적) 시나리오:

1. 미인증(`x-session-id` 없음)은 401 `unauthenticated`.
2. 로그인 후 `POST /api/articles/:id/translate` body `{ targetLang }` → 세션 게이트 통과·서버가 DB에서 본문 조회·`controllers.translate.run`에 위임된 결과를 `{ ok, translatedText, ... }`로 반환.
3. **키 누락 환경**(가짜 env에 키 없음)에서도 라우트가 500이 아니라 graceful 응답(`ok:false, reason:'no-key', translatedText:<원문>`)을 그대로 내려준다.
4. 번역 대상 텍스트는 **서버에서 기사 본문으로부터 조회**한다(클라이언트가 보낸 text를 신뢰하지 않는다 — 형태 (A) 확정).

먼저 실패를 확인한 뒤 구현한다.

### 구현: 번역 라우트

`server/index.js`에 라우트를 추가하라. **라우트 형태는 (A) 기사 기준으로 확정**(plan-reviewer 권고 반영 — step7 httpModel·step10 컨트롤러가 이 형태에 의존하므로 임의로 바꾸지 마라):

- **(A) 기사 기준 — 확정** `POST /api/articles/:id/translate` — 세션 게이트 후 `controllers.article.getById(req.params.id)`로 **서버에서 본문을 조회**해 번역 대상 텍스트를 구성(제목+본문 블록 텍스트)하고 `controllers.translate.run(text, targetLang)` 위임. 본문 신뢰 원천이 DB이므로 클라가 본문을 위조 전송할 수 없다(ADR-004). 본문 블록→텍스트 변환은 `articleService`가 쓰는 블록 파싱 방식(`markupVersion` JSON의 `blocks` 중 텍스트 블록만)을 참조해 제목/텍스트만 최소 추출하라(`blocksToText`는 프론트 모듈이므로 서버에서 재사용 불가 — 서버에 최소 추출 헬퍼를 두되 과한 재구현 금지).

> (B) `POST /api/translate`(클라가 보낸 text 그대로 번역) 형태는 **채택하지 않는다**. 이유: 본문 신뢰 원천을 서버 DB에 두는 (A)가 보안 경계 정신에 맞고, step7/10이 (A) 시그니처에 맞춰 설계되었다.

확정 형태 (A)에서:

- 세션 게이트: `me` 없으면 401(`UNAUTH`).
- `targetLang`은 body에서, 기본 `'ko'`.
- 결과를 그대로 `res.json(r)`(graceful 객체 — 500으로 감싸지 마라).
- **DB를 변경하지 않는다(읽기 전용).**
- 라우트 등록 순서: (A)면 `:id/translate`를 기존 `:id` 그룹에 둔다(`/search` 뒤). 정독한 순서를 깨지 마라.

이 step은 transport만 변경한다. 번역/본문 추출 로직을 과하게 재구현하지 마라(본문 텍스트 추출은 최소).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

기존 테스트를 단 1개도 깨뜨리지 마라. **번역 서비스를 가짜 fetchFn/env로 주입해 실제 키 없이 통과해야 한다**(createApp 테스트가 controllers에 fetchFn/env를 주입하는 기존 패턴 사용 — `createControllers(db, { sessionService, env, fetchFn })`).

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - 라우트가 세션 게이트→위임→shape 매핑만 하는가? (ADR-006)
   - 외부 키 누락 시 500이 아니라 graceful 응답을 내려주는가? (news.md degrade)
   - (A)를 택했다면 본문이 서버 DB에서 조회되는가(클라 위조 불가)? 읽기 전용인가?
   - 미인증 401인가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 6을 업데이트한다(완료/error/blocked 양식 동일). **`summary`에 확정 라우트의 정확한 path·method·body 키(`POST /api/articles/:id/translate`, body `{ targetLang }`)를 명시하라** — step7 httpModel·step10 컨트롤러가 이 시그니처에 의존한다(plan-reviewer 권고). 외부 라이브 검증이 필요해 진행 불가하면 step5와 동일하게 blocked 사유를 남긴다(단위/통합 테스트가 가짜 fetchFn으로 통과하면 completed).

## 금지사항

- 외부 키 누락/오류를 500으로 감싸지 마라. 이유: news.md — graceful degrade(서비스가 반환한 객체를 그대로 전달).
- 번역/본문 추출 로직을 server/index.js에서 광범위하게 재구현하지 마라. 이유: ADR-006 — 번역은 step5 서비스에 있다. transport는 얇게.
- DB 행을 변경하지 마라. 이유: 번역은 읽기 전용(DB 비파괴).
- 모델/서비스/컨트롤러/프론트를 이 step에서 수정하지 마라. 이유: transport 단일 관심사 — 프론트는 step7·10.
- 기존 테스트를 깨뜨리지 마라.
