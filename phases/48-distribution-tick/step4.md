# Step 4: tick-endpoint-docs

**transport 계층 + 문서**를 마무리한다: `POST /api/distribution/tick` 라우트, 배부 완료 시 SSE 무효화 신호 재발행 결선, 문서 현행화.
파일: `server/index.js`, `docs/ARCHITECTURE.md`, `docs/ADR.md`(필요 시 문구 현행화만), `docs/SCHEMA.md`, `README.md` + 테스트.

## 읽어야 할 파일

- `server/index.js` — 전체 흐름. 특히:
  - 84~104행 `STATUS_BY_REASON` / `fail(res, result, fallback)`
  - 288~297행 `readSessionToken`, SSE 무효화 버스(`bus`), `app.notifyChange(kind)`
  - 386~438행 수신설정·배부대상 라우트(Z 전용 게이트를 서비스가 강제하는 얇은 라우트 관례)
  - 505~535행 기사 상태 전이 라우트(`app.notifyChange('status')` 호출 위치)
  - 829~880행 `bootstrap()` — `createControllers` → `createApp` 순서, `DIST_SPOOL_DIR` 로그
- `docs/ADR.md` ADR-005(SSE 무효화 신호), ADR-007(Z 전용 pull 엔드포인트 관례), ADR-008 (3).
- `docs/ARCHITECTURE.md` — 디렉토리 구조/데이터 흐름의 `[배부]` 블록(phase 47이 추가).
- `docs/SCHEMA.md` — Contents(`distributedAt`, `status`) 절.
- `README.md` — 환경변수/엔드포인트 절.
- step3 산출물: `src/controllers/index.js`의 `distribution.tick(sessionId)` / `distribution.onChange(listener)`.
- `test/server.*.test.js` 계열 — 라우트 테스트 관례(가짜 컨트롤러 또는 in-memory 조립, supertest 미사용 시 기존 방식 그대로).

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) 라우트 `POST /api/distribution/tick`

```js
// --- 시점 배부 tick (Z/시스템 전용 — 게이트는 controllers.distribution이 강제, ADR-008 (3)) ---
app.post('/api/distribution/tick', async (req, res, next) => {
  try {
    const r = await controllers.distribution.tick(readSessionToken(req));
    return r.ok ? res.json(r) : fail(res, r);
  } catch (e) { next(e); }
});
```
- 인가는 컨트롤러/서비스가 강제한다 — 라우트에서 role을 다시 판정하지 마라(`req.body.role` 금지).
- `spool-disabled`는 `STATUS_BY_REASON`에 `503`으로 추가한다(설정 누락은 클라이언트 잘못이 아니다). 기존 매핑 값을 바꾸지 마라.
- 요청 바디는 사용하지 않는다(무인자 pull). 바디로 대상 기사·시각을 받지 마라.

### 2) SSE 무효화 신호 재발행 결선

- `app.notifyChange`가 정의된 직후 구독을 건다:
  ```js
  controllers.distribution?.onChange?.(() => app.notifyChange('distribute'));
  ```
- 이 한 줄이 phase 48 요구사항 3("배부 완료 후 SSE 무효화 신호 재발행 — 목록의 배부시간 즉시 갱신")을 만족시킨다:
  송고 훅 경로(fire-and-forget이라 라우트가 완료 시점을 모른다)와 tick 경로 **모두** 배부 완료 후 신호가 나간다.
  step3에서 컨트롤러가 "배부 1건 이상 **또는** 완결 전이 1건 이상"일 때 리스너를 부르므로, EPS→DPS 전이만 일어난 tick에서도 목록이 갱신된다.
- 라우트에서 `app.notifyChange`를 별도로 호출하지 마라 — 알림 지점이 둘이 되면 신호 수가 경로마다 달라진다(step3의 seam이 단일 출처).
- 신호 payload는 기존과 동일하게 `{ kind: 'distribute' }` — **행 데이터를 담지 마라**(ADR-005).
- 웹 클라이언트는 변경하지 않는다: `useViewController`는 kind 무관하게 재조회하고(목록의 배부시간이 갱신됨), `useWriteController`는 `kind !== 'lock'`이면 무시한다. **`web/**`를 건드리지 마라.**

### 3) 테스트

- Z 세션으로 `POST /api/distribution/tick` → 200 + 요약 JSON. 미인증 → 401, R/D 세션 → 403.
- `DIST_SPOOL_DIR` 미설정 → 503 + `{ ok:false, reason:'spool-disabled' }`.
- tick으로 실제 배부가 일어나면 SSE(`/api/stream`) 구독자에게 `change` 이벤트가 도달한다(또는 `app.notifyChange` 호출을 관측한다 — 기존 SSE 테스트 방식을 따른다).
- 송고 경로에서도 배부 완료 후 무효화 신호가 한 번 더 나간다(status 신호와 별개).
- 기존 라우트 회귀 0.

### 4) 문서 현행화 (docs에 없던 정책을 발명하지 마라 — 아래는 ADR-008에서 도출된 사실의 기록이다)

- `docs/ARCHITECTURE.md`:
  - `src/services/` 목록에 `distributionTick`·`embargoSchedule` 추가.
  - 데이터 흐름 `[배부]` 블록에 tick 경로 한 줄: `외부 운영 루틴 → POST /api/distribution/tick(Z) → 엠바고 도래분 배부 → 배부 완결 시 EPS→DPS → SSE 무효화 신호(distribute)`.
- `docs/SCHEMA.md`:
  - Contents `status` 서술에 "EPS 기사는 엠바고 배부가 전부 완결되면 시점 배부(tick)가 DPS로 전이한다(ArticleHistory `eventType='status'`, `action='embargoComplete'`)" 한 줄.
  - ArticleHistory 관련 서술이 있으면 `eventType='distribute'`(action=kind)가 완결 판정 근거임을 한 줄 추가.
- `README.md`: 엔드포인트 목록에 `POST /api/distribution/tick`(Z 전용, 외부 운영 루틴이 주기 호출) 한 줄. 앱에 타이머가 없다는 점을 함께 적는다.
- `docs/ADR.md` ADR-008은 **결정 자체를 바꾸지 마라**. 구현 완료를 반영하는 문구 조정 외 수정 금지.

## Acceptance Criteria

```bash
npm test && npm run test:web && npm run lint && npm run build
```

- 백엔드 테스트 전량 green(회귀 0), 웹 테스트 기준선 1927 pass 유지(web 무변경), lint 경고 0, build clean.

## 검증 절차

1. 구현 전 라우트 테스트에서 red(404)를 확인한다.
2. `grep -nE "setInterval|setTimeout|cron" server/index.js` → 배부 관련 신규 0건(기존 무관 코드는 유지).
3. `git diff --stat` — `web/**` 무접촉.
4. `grep -n "distribution/tick" server/index.js` → 라우트 1곳만.

## 금지사항

- 서버가 tick을 스스로 주기 호출하게 만들지 마라(`setInterval`·재귀 `setTimeout`·cron 라이브러리). 이유: ADR-008 (3)의 핵심 결정이 "앱 내 타이머 없음"이다 — 넣는 순간 다중 인스턴스에서 같은 기사가 중복 반출된다.
- 라우트에서 `req.body`로 대상 기사·강제 시각·kind를 받지 마라. 이유: 외부 호출자가 엠바고 시각을 우회해 임의 기사를 반출할 수 있다(신뢰 경계는 서버 — ADR-004).
- 라우트에 배부 로직(이력 조회·시각 비교·전이)을 두지 마라. 이유: 얇은 transport 원칙(ADR-006) — 로직은 step2 서비스에 있다.
- SSE 신호에 기사 행/본문을 담지 마라. 이유: ADR-005는 역할별 노출을 피하려고 신호에 행 데이터를 담지 않는다.
- `web/**`를 수정하지 마라. 이유: 배부 UI는 MVP-4 범위이며, 기존 컨트롤러가 새 kind를 이미 안전하게 처리한다(재조회 또는 무시).
- 문서에 미확정 운영 정책(호출 주기·인증 토큰 발급 방식 등)을 새로 발명해 적지 마라. 이유: ADR-008이 정한 범위를 넘는 서술은 후속 phase의 설계를 잘못 구속한다.
