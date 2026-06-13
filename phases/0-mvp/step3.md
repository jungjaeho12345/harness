# Step 3: article-lifecycle-service

## 읽어야 할 파일

- `/news.md` — **기사 생애주기(전이 규칙), 편집 잠금(lockYN), 송고 시 "(끝)" 검증** 섹션이 이 step의 1차 기준. 권한 R/D/Z × 상태 × 액션 전이표 전체.
- `/schema.md` — status 값(RDS/DPS/RRH/RRK/DDH/DDK), 잠금 컬럼
- `/docs/ARCHITECTURE.md`, `/docs/ADR.md`(ADR-006 얇은 transport — 도메인 로직은 서비스에)
- `src/models/articleModel.js`, `src/db/articleId.js` (이전 step 산출물)

## 작업

기사 생애주기와 기사 서비스를 구현한다. **role은 항상 인자로 받는다(클라이언트 신뢰 아님 — 신뢰 검증은 step8 HTTP 계층)**. TDD: 전이표의 모든 칸을 테스트로 먼저 박아라.

1. `src/services/lifecycle.js`:
   - `export function transition(status, role, action)` — 순수 함수. action은 `'send'|'hold'|'kill'`. news.md 전이표대로 다음 status를 반환하거나, 정의되지 않은 (status, role, action) 조합은 거부(예: `{ ok:false, reason }`).
   - 핵심 규칙(news.md 그대로): 신규 최초 송고는 권한 무관 RDS 유지. R: RDS→send=RDS, hold=RRH, kill=RRK, DDH엔 액션 불가. D/Z(동일): RDS→send=DPS, hold=DDH, kill=DDK; DPS→send=DPS(재송고), hold=DDH, kill 불가; DDH→send=DPS, kill=DDK; DPS 삭제승인=DPD.
2. `src/services/articleService.js` — `export function createArticleService({ articleModel, db })`:
   - `create(dto)` — Article+Contents 조립, `generateArticleId`, status `RDS`, 트랜잭션 저장. `{ ok, articleId }`.
   - `update(articleId, fields)` — 부분 업데이트(트랜잭션). 잠금 보유 검증은 호출자(HTTP) 책임.
   - `query(filters)`, `search(q)` — 모델 위임.
   - `applyAction(articleId, role, action, { userId, sessionId })` — `transition` 적용 후 status 갱신. **send는 본문 블록 마지막에 "(끝)"이 있어야 한다 — 없으면 거부**(`reason:'no-end-marker'`). hold/kill은 "(끝)" 불필요.
   - 편집 잠금: `acquireEditLock(articleId, { userId, sessionId })`, `releaseEditLock(...)`, `forceReleaseEditLock(articleId)`, `assertLockHolder(articleId, { userId, sessionId })`. 보유자 = **세션 id**. 30분 무갱신이면 stale로 보고 다음 시도자가 획득 가능. 획득 실패 시 누가 잠갔는지 노출하지 않는다.
3. 테스트(`test/lifecycle.test.js`, `test/articleService.test.js`, `test/editLock*.test.js`): 전이표 전 조합(허용/거부), "(끝)" 송고 가드, 잠금 획득/해제/강제해제/stale 만료.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. AC 실행.
2. 체크리스트: news.md 전이표를 빠짐없이 구현했는가? 정의 외 조합을 모두 거부하는가? send "(끝)" 가드가 있는가? 잠금 보유자가 세션 id이고 stale 30분인가?
3. step 3 업데이트(completed + summary: transition/applyAction/lock API 시그니처).

## 금지사항

- 전이표에 없는 (상태,권한,액션) 조합을 통과시키지 마라. 이유: news.md — 정의 외 조합은 모두 거부.
- "(끝)" 없는 송고를 허용하지 마라. 이유: news.md 송고 조건.
- role을 세션/DB에서 다시 끌어오지 마라. 이유: 이 계층은 순수 도메인 — role은 인자. 신뢰 검증은 step8.
- HTTP/Express 코드를 넣지 마라. 기존 테스트를 깨뜨리지 마라.
