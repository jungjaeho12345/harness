# Step 3: route-contract

## 목표

`GET /api/articles/:id/history`의 **HTTP 응답 계약**을 테스트로 잠근다: 인증 세션이면 파생 필드(`title`·`version`·`status`)가 실려 오고, 본문 blob(`markupVersion`)은 어떤 경우에도 실리지 않으며, `sendOnly` 필터 후에도 파생 값이 보존된다.

라우트는 `controllers.article.queryHistory`에 위임만 하므로 **코드 변경이 필요 없을 가능성이 높다**. 필요하다고 판단되면 최소 변경만 하고, 왜 필요한지 summary에 근거를 남겨라. 이 step의 산출물은 원칙적으로 **테스트**다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md` — "얇은 transport"(라우트는 세션 검증 → 인가 게이트 → 컨트롤러 위임 → 응답 매핑만), 응답 투영 규율.
- `docs/ADR.md` ADR-004(인가는 세션에서만 도출)·ADR-006. **읽기 전용(무접촉)**.
- `server/index.js`
  - L592~605 `app.get('/api/articles/:id/history', …)` — `sessionOf(req)`로 `me` 없으면 401, `sendOnly`는 `req.query.sendOnly`(`'0'`/`'false'` 제외) 또는 `req.query.type === 'send'`, 그리고 `controllers.article.queryHistory(req.params.id, { sendOnly })` 위임 후 `{ ok:true, items }`.
  - L607~620 `GET /api/articles/:id/history/:historyId` — 단건 스냅샷(본문 포함) 라우트. **이 라우트는 건드리지 않는다.**
- `src/services/contentsProjection.js` — `toPublicContents`(Contents 행의 `lockerSessionId`/`lockerClientId` 제거 단일 지점). ArticleHistory 행에는 그런 비공개 컬럼이 없지만, **새 읽기 경로가 모델 행을 그대로 흘리지 않는지** 확인하는 기준으로 읽어라.
- `test/server.test.js`
  - L204~226 `GET /api/articles/:id/history` 기존 테스트(미인증 401 / 인증 시 `items` 배열 / create는 이력 없음 · 송고 1건),
  - L228~ `?sendOnly=1` 기존 테스트,
  - 파일 상단의 `start()`·`login()`·`api()`·`seedUser()`·`END_MARKUP` 헬퍼(이 헬퍼들을 그대로 재사용하라).
- `test/response-secrets.test.js` L107~120 — 라우트 목록에 `/api/articles/:id/history`가 이미 등록돼 있고 응답 본문에서 세션 토큰·잠금 식별자 누출을 스캔한다. **무수정 green이어야 한다.**

## 배경 (자기완결)

step2에서 서비스 반환 shape이 넓어졌다. 라우트는 위임만 하므로 자동으로 통과하지만, **"경계에서 blob이 새지 않는다"와 "sendOnly 경로에서도 파생이 살아 있다"는 계약은 서비스 단위 테스트가 아니라 HTTP 경계에서 한 번 더 잠가야** 한다(프론트가 실제로 소비하는 건 이 응답이다). 또한 이력보기는 로그인 세션이면 누구나 열 수 있는 읽기 경로이므로, 파생 제목이 인가 경계를 넓히지 않는지(이미 같은 세션이 `GET /api/articles/:id`로 본문 전체를 볼 수 있다) 확인해 둔다.

## TDD — 테스트 먼저

`test/server.test.js`에 케이스를 **추가**한다(기존 L204~ 케이스 수정 금지). 실제 서버를 띄우는 기존 패턴(`start()` → `finally { await ctx.close(); }`)을 그대로 따른다.

1. **파생 필드 전달**: 로그인 → 기사 생성 → `PUT /api/articles/:id`로 본문(`markupVersion`) 편집 2회 → 송고. `GET /api/articles/:id/history`의 각 item이 `title`·`version`·`status` 키를 갖고, 최신 편집의 제목이 그 편집 행의 `title`로 온다.
1-1. **편집 없이 송고한 기사(v1 경로)**: 생성 → 바로 송고(편집 0회)면 송고 item의 `version === 1`이고 `title`이 최초 본문 첫 줄로 채워진다(step2의 v1 본문 예외가 HTTP 경계까지 이어지는지 확인 — 실운영에서 가장 흔한 경로다).
2. **blob 미노출**: 같은 응답의 모든 item에 `markupVersion`이 없다. 추가로 **응답 본문 문자열 전체**에 편집 본문의 고유 문자열(예: 본문에 심어둔 `'대외비본문표식'`)이 등장하지 않는지 확인하라(키 이름만 보는 단언보다 강하다). 단, 제목 줄에 심으면 당연히 제목으로 나오므로 **표식은 둘째 줄 이후에** 넣어라.
3. **sendOnly 경로 보존**: `?sendOnly=1` 응답의 유일한 송고 item이 `version`·`title`을 그대로 갖는다(전체 조회의 같은 `id` item과 값이 일치).
4. **미인증 401 회귀**: 파생 추가와 무관하게 세션 없는 요청은 401이고 응답 본문에 `items`가 없다.
5. **이력 없음**: 이력이 없는 기사도 `{ ok:true, items: [] }`(404 아님).
6. **단건 스냅샷 라우트 회귀**: `GET /api/articles/:id/history/:historyId`는 여전히 `markupVersion`(본문)을 반환한다 — 목록만 경량이라는 대비가 유지되는지 확인(기존 케이스가 있으면 실행 확인으로 대체 가능).

## 작업

1. 위 테스트를 추가하고 실행한다. **전부 green이면 `server/index.js`는 수정하지 않는다**(위임 계약이 이미 성립).
2. red가 나면 원인을 먼저 규명하라.
   - 서비스 반환 shape 문제면 **step2로 되돌려 고칠 사안**이다(라우트에서 필드를 덧붙여 덮지 마라 — 도메인 로직이 transport로 샌다).
   - 라우트가 응답을 재매핑하며 필드를 떨어뜨리는 경우에만 라우트를 최소 수정한다.
3. 라우트를 수정하게 되면 인가 게이트(`sessionOf` → 401)와 `sendOnly` 파싱 규칙(`'0'`/`'false'` 제외, `type=send`)을 **그대로 보존**하라.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step2 종료 시점 개수 + 이번 신규 케이스
npm run lint      # 통과
```

**diff scope**: step을 시작하기 전에 `git status --porcelain`을 찍어 스냅샷으로 남겨라. 종료 시점의 `git status --porcelain`이 그 스냅샷과 **다른 부분**은 `test/server.test.js` 1개(라우트 수정이 불가피했다면 + `server/index.js`)여야 한다(절대 목록 비교 금지 — 트리에 사용자 소유 미커밋 파일이 이미 있다).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 2종(확인 후 원복):
   - step2의 `decorateHistoryRows` 호출을 임시로 지우면 케이스 1·3이 red(HTTP 경계에서 파생이 실제로 관측되는지 확인).
   - 서비스가 `markupVersion`을 함께 반환하도록 임시 개조하면 케이스 2가 red(blob 가드가 진짜인지 확인).
3. 아키텍처 체크리스트:
   - 라우트에 비즈니스 로직(파생·필터·매핑)이 들어가지 않았는가(ADR-006 얇은 transport)?
   - acting 신원이 여전히 `x-session-id` 세션에서만 도출되는가(ADR-004 — 쿼리/바디의 role 신뢰 금지)?
   - `test/response-secrets.test.js`가 무수정 green인가?
4. `phases/56-history-view-columns/index.json`의 step3을 `completed` + `summary`로 갱신한다. summary에 (a) 라우트 코드 변경 여부와 근거, (b) HTTP 경계에서 잠근 계약 목록을 명시하라.

## 금지사항

- 라우트에서 응답 item에 필드를 덧붙이거나 계산하지 마라. 이유: 도메인 파생이 transport로 새면 같은 규칙이 두 곳에 생기고, 컨트롤러 직접 호출 경로(테스트·내부 소비처)와 값이 갈라진다.
- 이력 목록 응답에 본문(`markupVersion`)을 싣는 쪽으로 "편의상" 계약을 넓히지 마라. 이유: 경량 목록 계약이 무너지고, 편집이 많은 기사에서 응답이 수 MB가 된다(제목만 필요하다).
- 인가 게이트를 완화하거나(예: 미인증 허용) `sendOnly` 파싱 규칙을 바꾸지 마라. 이유: ADR-004 신뢰 경계와 기존 프론트 호출 계약(`sendOnly=1`)이 그대로 유지돼야 한다.
- 새 라우트를 만들지 마라(예: `/history/columns`). 이유: 컬럼 설정은 클라이언트 UI 환경설정이며 localStorage에 저장한다(step4) — 서버 상태가 아니다.
- `docs/news.md`·`docs/ADR.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 이번 phase 무접촉 대상이며, `docs/news.md`는 사용자 소유의 미커밋 편집분(이 phase의 입력 스펙)이다.
- `git add -A`/`git add .`로 스테이징하지 마라 — 반드시 이번 step이 만진 파일만 명시 경로로 `git add` 하라. 이유: 작업 트리에 사용자 소유 미커밋 파일(`docs/news.md` 등)이 이미 있어, 통짜 add는 그것들을 커밋에 끌어들인다.
- 미커밋 사용자 파일(`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)을 `git restore`/`git checkout --`/`git stash`/`git clean`으로 되돌리거나 치우지 마라. 이유: 이 phase의 유일한 스펙 원문이 소실된다.
