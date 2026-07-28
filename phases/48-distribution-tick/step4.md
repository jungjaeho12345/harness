# Step 4: docs-sync

phase 48에서 확정된 **사실**(tick 엔드포인트·단일 실행 게이트·완결 전이·SSE 신호 출처)을 문서에 반영하고, 전량 회귀로 phase를 닫는다.
소스 동작 변경은 없다(문서 + 필요한 경우 주석 현행화만).

## 읽어야 할 파일

- `docs/ARCHITECTURE.md` — `src/services/` 목록, 데이터 흐름 절(수집/배부 블록 서술 형식).
- `docs/SCHEMA.md` — Contents 절(`status`, `distributedAt`), ArticleHistory 절(`eventType`/`action`), DistributionTarget 절.
- `docs/ADR.md` — ADR-008 전문, **ADR-004(세션 정책 — 1시간 idle 만료, 쿠키 우선 + `x-session-id` 헤더 폴백)**. **결정 문구는 수정하지 않는다**(이번 phase는 ADR-008의 구현이지 개정이 아니다).
- `README.md` — API 목록·환경변수 절.
- `.env.example` — 이번 phase는 **신규 환경변수 없음**(확인만).
- `server/index.js` — `readSessionToken(req)`(L299~): 쿠키 우선, `x-session-id` 헤더 폴백. README 인증 문구의 근거.
- step0~3 산출물:
  - `src/services/articleService.js` (`requiredDistributionKinds`, `completeEmbargoDistribution`)
  - `src/services/distributionTickService.js` (모듈 스코프 단일 실행 게이트 → `busy`)
  - `src/services/authorization.js` (`runDistributionTick` capability)
  - `src/controllers/index.js` (`distribution.tick`, `onChange`)
  - `server/index.js` (`POST /api/distribution/tick`, `STATUS_BY_REASON.busy = 409`, 부트스트랩 늦은 바인딩)
  - `src/services/distributionService.js` (`onDistributed`)

## 작업

### 1) `docs/ARCHITECTURE.md`
- `src/services/` 목록에 `distributionTickService` — "시점 배부 tick(외부 호출 pull). 앱 내 타이머 없음. 프로세스 내 단일 실행 게이트로 중첩 호출을 거절(`busy`)" 한 줄 추가.
- 데이터 흐름에 배부 tick 블록 1개 추가:
  `[배부/시점] 외부 cron → POST /api/distribution/tick(Z 세션) → EPS 후보 조회 → 도래한 kind만 배부(요구 집합 ∩ 도래 − 기배부) → 요구 배부 완결 시 EPS→DPS 전이 → SSE 무효화 신호`
- SSE 신호 출처 한 줄: 배부 신호(`'update'`)는 `distributionService.onDistributed`가 단일 출처이고, 상태 전이 신호(`'status'`)는 tick 라우트가 발행한다.

### 2) `docs/SCHEMA.md`
- ArticleHistory 서술에 한 줄: `eventType='status', action='distributeComplete'` — 엠바고 배부 완결로 EPS→DPS 전이된 사실(actor는 tick 실행자).
- Contents 서술에 한 줄: `status`의 EPS→DPS 전이 주체는 송고(applyAction)와 배부 완결(completeEmbargoDistribution) 두 경로뿐임.
- 이번 phase에 **스키마 변경은 없다**는 사실을 명시한다(신규 테이블/컬럼 0 — 판정 근거는 기존 `ArticleHistory` 행).

### 3) `README.md`
- API 목록에 `POST /api/distribution/tick` — **Z 전용**, 외부 운영 cron이 주기 호출, 요청 본문 없음, 응답 `{ ok, evaluated, distributed, transitioned, failed }`.
- 응답 코드: `401`(무세션) / `403`(비Z) / `400`(`spool-disabled` — `DIST_SPOOL_DIR` 미설정) / `409`(`busy` — 이전 tick 실행 중, 다음 호출에서 재시도).
- **운영 인증 메모 한 줄**: tick 인증은 **세션 기반**이다 — 서버는 쿠키를 우선 읽고 없으면 `x-session-id` 헤더를 쓴다(`readSessionToken`). 외부 cron은 Z 계정으로 로그인해 얻은 세션ID를 **`x-session-id` 헤더로** 전송하며, 세션은 1시간 idle 만료이므로(ADR-004) 호출이 인증 실패하면 재로그인해 세션을 갱신해야 한다. (헤더 전용 인증이라고 적지 마라 — 쿠키도 유효한 경로다.)
- 운영 메모 한 줄: 앱에는 스케줄러가 없으므로 tick 호출 주기가 곧 시점 배부의 정시성이다(ADR-008 트레이드오프).

### 4) 문서 작성 규율
- **docs에 없던 정책을 발명해 적지 마라.** 위 항목은 ADR-008·ADR-004·news.md·구현된 코드에서 도출된 사실의 기록이다.
- 새 ADR을 추가하거나 ADR-008 결정문을 고치지 마라.

## Acceptance Criteria

```bash
npm test && npm run test:web && npm run lint && npm run build
```

- 백엔드/웹 테스트 전량 green(웹은 이 phase에서 무변경), lint 경고 0, build clean.

## 검증 절차

1. 위 커맨드 전량 green 확인.
2. `grep -rn "setInterval\|setTimeout" src/services/distributionTickService.js src/controllers/index.js server/index.js` → 배부 관련 **0건**.
3. **DB 비파괴(신규 변경분 한정)**: `git diff --name-only <phase 시작 커밋>..HEAD -- src/ server/` 로 나온 파일들에 대해서만 `grep -n "DELETE FROM\|DROP TABLE\|DROP COLUMN"` → **0건**.
   - 리포지토리 전체 기준값(참고): 현재 `src/`·`server/` 통틀어 `DELETE FROM`은 `src/models/receiverConfigModel.js:35`(`DELETE FROM ReceiverConfig` — 수신처 설정 행이며 기사 데이터가 아니다) **1건이 이미 존재**한다. 이 기존 1건은 이번 phase의 변경 대상이 아니며 **손대지 마라**. 즉 기대값은 "기존 1건 외 신규 0건"이다.
4. `grep -rn "CREATE TABLE\|ALTER TABLE" src/db/schema.js` → 이번 phase 신규 변경 **0건**(스키마 무변경 확인 — `git diff`에 `src/db/schema.js`가 없어야 한다).
5. `git diff --stat` → 문서 파일만 변경(소스 변경이 있다면 주석 현행화 수준인지 확인).
6. phase 전체 재확인: `grep -rn "distribution/tick" test/` → `POST /api/distribution/tick`이 무세션 401, 비Z 403, 중첩 호출 409(`busy`)를 돌려주는 테스트가 존재하는지 확인.

## 금지사항

- 문서에 "cron 5분마다 실행" 같은 **운영 수치를 확정 사실처럼** 적지 마라. 이유: 호출 주기는 운영 결정이며 문서에 근거가 없다(권고는 "주기는 운영 정책" 수준까지만). 세션 만료 1시간은 ADR-004에 근거가 있으므로 적어도 된다.
- tick 인증을 "`x-session-id` 헤더 전용"이라고 적지 마라. 이유: 서버는 쿠키를 먼저 읽는 세션 인증이며(`readSessionToken`), 헤더 전용이라고 쓰면 문서가 코드와 어긋나고 운영자가 잘못된 전제를 갖는다.
- `src/models/receiverConfigModel.js`의 기존 `DELETE FROM ReceiverConfig`를 이 step에서 고치거나 제거하지 마라. 이유: 이번 phase의 변경 범위 밖이고, 마감 step에서의 무관한 수정은 검증 없이 흘러 들어간다.
- ADR-008의 결정/이유 문구를 수정하지 마라. 이유: ADR은 결정 기록이며 구현 결과로 소급 편집하면 결정 이력이 소실된다.
- 배부 UI·실패 재전송(MVP-4)에 대한 계획/설명을 문서에 추가하지 마라. 이유: 다음 phase 범위이며 미구현 기능을 문서화하면 문서가 스펙과 어긋난다.
- 이 step에서 소스 동작을 바꾸지 마라(리팩터링 포함). 이유: 마감 step에서의 동작 변경은 검증 없이 흘러 들어간다.
