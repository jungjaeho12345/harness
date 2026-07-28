# Step 3: wiring-docs

합성 루트(컨트롤러/부트스트랩)에서 step0~2를 실제로 결선하고, 문서를 현행화한다.
**새 HTTP 라우트는 만들지 않는다** — phase 47의 배부 트리거는 송고 훅뿐이다(tick 라우트는 phase 48).

## 읽어야 할 파일

- `src/controllers/index.js` — 모델·서비스 결선(합성 루트). `env`/`fetchFn` 기본값을 여기서 공급하는 관례.
- `server/index.js` — `bootstrap()`의 `RCV_SPOOL_DIR` 분기(수집 watcher) — **대칭 구현의 청사진**.
- `README.md` 환경변수 절, `.env.example`.
- `docs/ARCHITECTURE.md` — 디렉토리 구조/데이터 흐름.
- `docs/SCHEMA.md` — Contents(`distributedAt`) / DistributionTarget 절.
- step0~2 산출물: `src/services/spoolWriter.js`, `src/services/distributionService.js`, `src/services/articleService.js`.
- `test/controllers.test.js` — 컨트롤러 결선 테스트 관례.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) 테스트

- `test/controllers.test.js` 갱신: `createControllers(db, { env: { DIST_SPOOL_DIR: 'spool' } })`로 만들면 송고 시 배부 훅이 살아 있고,
  `DIST_SPOOL_DIR` **미설정이면 배부가 비활성**(파일 쓰기 시도 없음)이며 송고는 정상 동작한다.
  기존 도메인 집합 단언(9개)이 깨지지 않는지도 확인한다(**새 도메인 키를 추가하지 않는다면 9 유지**).
- 통합 성격 확인은 가짜 FS 주입이 어려우면 "서비스 주입 여부"만 단언한다 — **실제 파일 쓰기 테스트 금지**.

### 2) `src/controllers/index.js`

- `env.DIST_SPOOL_DIR`이 있으면 `createSpoolWriter({ rootDir: env.DIST_SPOOL_DIR })` → `createDistributionService({...})`를 만들고
  `createArticleService({ ..., distributionService })`에 주입한다. 없으면 `distributionService`를 주입하지 않는다(기능 비활성 — 기존 동작 유지).
- 배부 실행 진입점을 컨트롤러 도메인으로 **노출하지 않는다**(phase 47은 송고 훅 트리거만). 반환 도메인 집합은 9개 그대로.

### 3) `server/index.js`

- 부트스트랩 로그 한 줄만 추가 가능(`DIST_SPOOL_DIR` 설정 시 "배부 스풀 = ..."). **라우트·타이머·watcher 추가 금지.**
- 라우트 파일에 배부 실행 로직을 두지 마라(얇은 transport 원칙).

### 4) 문서

- `README.md` 환경변수 절: `(선택) DIST_SPOOL_DIR — 배부 스풀 루트 디렉토리(미설정 시 배부 비활성)` 추가.
- `.env.example`: 동일 항목 주석과 함께 추가.
- `docs/ARCHITECTURE.md`: `src/services/` 목록에 `spoolWriter`·`distributionService` 추가, 데이터 흐름에 "[배부] 송고 성공 → 엠바고 판정 → 활성 DistributionTarget별 스풀 파일 쓰기 → distributedAt·ArticleHistory 기록 (외부 전송기가 발송)" 한 블록 추가.
- `docs/SCHEMA.md`: Contents 절에 `distributedAt` 기록 규칙(최근 배부 지시 시각으로 갱신, 상세 이력은 ArticleHistory) 한 줄, ArticleHistory 관련 서술이 있으면 `eventType='distribute'`(action=kind) 한 줄 추가. DistributionTarget 절의 "실제 스풀 쓰기는 phase 47" 문구를 현행화한다.
- **docs에 없던 정책을 새로 발명해 적지 마라** — 위 항목은 ADR-008·news.md에서 도출된 사실의 기록이다.

## Acceptance Criteria

```bash
npm test && npm run test:web && npm run lint && npm run build
```

- 백엔드/웹 테스트 전량 green(웹은 이 phase에서 무변경이므로 기준선 1927 pass 유지), lint 경고 0, build clean.

## 검증 절차

1. `DIST_SPOOL_DIR` 미설정 상태에서 전체 테스트가 green인지(기본 경로 무회귀) 확인한다.
2. `grep -rn "distribution/tick\|setInterval\|setTimeout" server/index.js src/controllers/index.js` → 배부 관련 신규 0건.
3. `git diff --stat`으로 web/** 무접촉을 확인한다.

## 금지사항

- `POST /api/distribution/tick`을 만들지 마라. 이유: phase 48 범위다(스코프 혼입은 리뷰 게이트에서 반려된다).
- 프로덕션 부트스트랩에서 스풀 디렉토리를 미리 생성하지 마라. 이유: 디렉토리 생성은 실제 배부 시점의 `spoolWriter` 책임이며, 기동 시 부수효과는 테스트 격리를 깬다.
- `DIST_SPOOL_DIR` 기본값을 하드코딩하지 마라(예: `'dist-spool'`). 이유: 미설정 환경에서 의도치 않은 파일 쓰기가 발생한다.
- web/** 를 수정하지 마라. 이유: 배부 UI는 MVP-4 후속 범위다(PRD).
