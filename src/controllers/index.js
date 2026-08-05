// 컨트롤러 계층 — 모델/서비스를 결선하고 도메인별 진입점을 노출한다 (ADR-006).
// CRITICAL: 비즈니스 로직(생애주기/인가/SQL)을 재구현하지 않는다 — 서비스/모델에 위임만 한다.
// HTTP/Express 코드는 두지 않는다(다음 step의 transport 계층 책임). 의존성은 모두 주입 가능.
//
// sessionService는 외부에서 주입받아 HTTP 계층(step8)과 한 스토어를 공유한다(없으면 생성).
// media 검색의 env(API 키)/fetchFn은 합성 루트인 여기서 기본값(서버 환경변수·전역 fetch)을 공급하고,
// 테스트는 가짜 fetchFn/env를 주입해 네트워크 없이 결정적으로 검증한다.

import { createUserModel } from '../models/userModel.js';
import { createArticleModel } from '../models/articleModel.js';
import { createArticleHistoryModel } from '../models/articleHistoryModel.js';
import { createReceiverConfigModel } from '../models/receiverConfigModel.js';
import { createPhotoModel } from '../models/photoModel.js';
import { createDistributionTargetModel } from '../models/distributionTargetModel.js';

import { createSessionService } from '../services/sessionService.js';
import { createSessionGuard } from '../services/sessionGuard.js';
import { createUserService } from '../services/userService.js';
import { createArticleService } from '../services/articleService.js';
import { createAuthorization } from '../services/authorization.js';
import { createReceiverConfigService } from '../services/receiverConfigService.js';
import { createCollectionService } from '../services/collectionService.js';
import { createMediaSearch } from '../services/mediaSearch.js';
import { createTranslate } from '../services/translate.js';
import { createPhotoService } from '../services/photoService.js';
import { createDistributionTargetService } from '../services/distributionTargetService.js';
import { createDistributionService } from '../services/distributionService.js';
import { createDistributionTickService } from '../services/distributionTickService.js';
import { createSpoolWriter } from '../services/spoolWriter.js';

// spoolFs(선택): 배부 스풀의 파일 조작(mkdir/writeFile/rename)을 주입한다 — fetchFn과 같은 이유로,
//   테스트가 실제 파일시스템을 건드리지 않게 하기 위한 seam이다. 미주입이면 node:fs/promises가 쓰인다.
// logService(선택): 배부 실패처럼 fire-and-forget 경로에서 사라질 사실을 표면화하는 데만 쓴다
//   (HTTP 계층의 logService와 같은 인스턴스를 부트스트랩이 넘긴다). 미주입이면 조용히 생략한다.
// now(선택): 엠바고 tick의 시계 seam — **ISO-8601 UTC 문자열**을 돌려주는 함수여야 한다
//   (숫자 epoch ms를 주면 embargoPolicy가 전 기사를 미도래로 떨어뜨려 배부가 조용히 0건이 된다).
//   테스트는 이걸로 가짜 시계를 주입한다. 클라이언트가 보낸 시각은 절대 여기로 들어오지 않는다(ADR-004).
export function createControllers(db, {
  sessionService,
  env = process.env,
  fetchFn = globalThis.fetch,
  lockoutPolicy = {},
  spoolFs,
  logService,
  now = () => new Date().toISOString(),
} = {}) {
  // 모델 결선.
  const userModel = createUserModel(db);
  const articleModel = createArticleModel(db);
  const articleHistoryModel = createArticleHistoryModel(db);
  const receiverConfigModel = createReceiverConfigModel(db);
  const photoModel = createPhotoModel(db);
  const distributionTargetModel = createDistributionTargetModel(db);

  // 세션 스토어는 HTTP 계층과 공유 — 주입 없으면 새로 만든다.
  // 그 위에 세션 가드를 씌워 touch/peek 마다 User 행을 재조회한다(비활성·역할 강등 즉시 반영, ADR-004).
  // CRITICAL: 이 합성 루트 아래의 모든 소비처(authorization 게이트·auth.*)는 원본이 아니라 **가드**를 쓴다 —
  //   한 갈래라도 원본을 직접 쓰면 그 경로만 옛 스냅샷 권한으로 남아 권한 상승 구멍이 된다.
  //   주입받은 원본(rawSession)은 그대로 살아 있어 HTTP 계층과 같은 스토어를 공유한다.
  const rawSession = sessionService ?? createSessionService();
  const session = createSessionGuard({ sessionService: rawSession, userModel });

  // ArticleHistory insert 실패의 단일 결선 — 두 서비스(편집/전이 이력·배부 이력)가 같은 어휘를 쓴다.
  // 이력 행은 판정 입력이므로(tick 멱등·사이클 경계) 무음으로 사라지면 안 된다. 본 기능은 막지 않는다.
  // 식별자와 사유만 남긴다(본문·세션 토큰·비밀번호 금지 — LOGS.md 마스킹 규율).
  const historyErrorLogger = ({ articleId, eventType, action, reason }) => {
    logService?.warn?.(`history write failed articleId=${articleId} eventType=${eventType} action=${action ?? '-'} reason=${reason}`);
  };

  // 배부(ADR-008) — 스풀 루트(DIST_SPOOL_DIR)가 설정된 환경에서만 활성화한다.
  // 기본값을 하드코딩하지 않는다: 미설정 환경에서 의도치 않은 파일 쓰기가 생기면 안 된다.
  // 앱은 스풀 파일을 쓰기만 한다 — 네트워크 전송(egress)도 타이머도 없다(발송은 외부 전송기).
  const spoolWriter = env && env.DIST_SPOOL_DIR
    ? createSpoolWriter({
      rootDir: env.DIST_SPOOL_DIR,
      // 주입은 FS 조작 3종만 받는다(rootDir 등 다른 설정을 덮어쓰지 못하게 한정).
      ...(spoolFs ? { mkdir: spoolFs.mkdir, writeFile: spoolFs.writeFile, rename: spoolFs.rename } : {}),
    })
    : undefined;
  const distributionService = spoolWriter
    ? createDistributionService({
      distributionTargetModel,
      articleModel,
      historyModel: articleHistoryModel,
      spoolWriter,
      // 송고 훅은 fire-and-forget이라 반환값을 보지 않는다 — 미발송을 로그로 표면화한다.
      // 기사/수신처 식별자와 사유만 담는다(본문·페이로드 금지 — 마스킹 규율).
      onFailure: ({ articleId, targetId, kind, reason }) => {
        logService?.warn?.(`distribution failed articleId=${articleId} targetId=${targetId} kind=${kind} reason=${reason}`);
      },
      // 이력 쓰기 실패는 배부 실패와 다른 사건이다(스풀은 나갔다) — 어휘를 분리해 오독을 막는다.
      onHistoryError: historyErrorLogger,
    })
    : undefined;

  // 서비스 결선.
  const userService = createUserService({ userModel, ...lockoutPolicy });
  // distributionService 미주입(스풀 미설정) 시 송고 훅은 비활성 — 기존 동작 그대로.
  const articleService = createArticleService({
    articleModel, db, historyModel: articleHistoryModel, distributionService,
    onHistoryError: historyErrorLogger,
  });
  const authorization = createAuthorization({ sessionService: session, articleModel });
  const receiverConfigService = createReceiverConfigService({ receiverConfigModel, authorization });
  const collectionService = createCollectionService({ articleService, receiverConfigModel, fetchFn });
  const mediaSearch = createMediaSearch({ fetchFn, env });
  const translate = createTranslate({ fetchFn, env });
  const photoService = createPhotoService({ photoModel });
  const distributionTargetService = createDistributionTargetService({ distributionTargetModel, authorization });
  // 엠바고 시점 배부 tick(ADR-008 (3)) — 배부가 활성인 환경에서만 결선한다.
  // 앱에 타이머를 두지 않는다: 실행 트리거는 외부 운영 cron의 POST /api/distribution/tick 뿐이다.
  const distributionTickService = distributionService
    ? createDistributionTickService({
      articleModel,
      historyModel: articleHistoryModel,
      distributionService,
      articleService,
      now,
      // 기사 단위 예외는 응답에 고정 토큰만 남는다 — 원인은 로그로 표면화한다(무음 삼킴 금지).
      onError: ({ articleId, error }) => {
        logService?.warn?.(`distribution tick failed articleId=${articleId} reason=${error?.message ?? error}`);
      },
    })
    : undefined;

  // 인증/세션 — 로그인은 자격 검증(userService) → 세션 발급(sessionService) 오케스트레이션.
  const auth = {
    async login(userId, password) {
      const result = await userService.login(userId, password);
      if (!result.ok) return result;
      const sessionId = session.createSession(result.user);
      return { ok: true, sessionId, user: result.user };
    },
    logout: (sessionId) => ({ ok: session.invalidate(sessionId) }),
    session: (sessionId) => session.touchSession(sessionId),
    // 비연장 조회 — SSE push 시점 재검증처럼 사용자 활동이 아닌 경로 전용(만료를 연장하지 않는다).
    // 일반 REST 요청은 슬라이딩 갱신이 계약이므로 반드시 session(touch)을 쓴다.
    peek: (sessionId) => session.peekSession(sessionId),
    manageUsers: (sessionId, op, payload) => authorization.manageUsers(sessionId, op, payload),
    editDps: (sessionId, articleId, action) => authorization.editDps(sessionId, articleId, action),
  };

  const user = {
    query: (filters) => userService.query(filters),
    create: (dto) => userService.create(dto),
    update: (userId, fields) => userService.update(userId, fields),
  };

  const article = {
    query: (filters) => articleService.query(filters),
    search: (q) => articleService.search(q),
    create: (dto, opts) => articleService.create(dto, opts),
    update: (articleId, fields) => articleService.update(articleId, fields),
    getById: (articleId) => articleService.getById(articleId),
    applyAction: (articleId, role, action, opts) => articleService.applyAction(articleId, role, action, opts),
    derive: (sourceId, mode, overrides) => articleService.deriveArticle(sourceId, mode, overrides),
    queryHistory: (articleId, opts) => articleService.queryHistory(articleId, opts),
    getHistorySnapshot: (articleId, historyId) => articleService.getHistorySnapshot(articleId, historyId),
    acquireEditLock: (articleId, opts) => articleService.acquireEditLock(articleId, opts),
    releaseEditLock: (articleId, opts) => articleService.releaseEditLock(articleId, opts),
    forceReleaseEditLock: (articleId) => articleService.forceReleaseEditLock(articleId),
    assertLockHolder: (articleId, opts) => articleService.assertLockHolder(articleId, opts),
  };

  const media = {
    search: (query, type) => mediaSearch.search(query, type),
  };

  const translation = {
    run: (text, targetLang) => translate.translate(text, targetLang),
  };

  const receiverConfig = {
    query: (sessionId, filters) => receiverConfigService.query(sessionId, filters),
    create: (sessionId, entry) => receiverConfigService.create(sessionId, entry),
    remove: (sessionId, id) => receiverConfigService.remove(sessionId, id),
  };

  // 배부 대상(수신처) — Z 전용 게이트·검증은 서비스가 강제한다(ADR-008). 삭제 경로 없음(deactivate).
  const distributionTarget = {
    query: (sessionId, filters) => distributionTargetService.query(sessionId, filters),
    create: (sessionId, entry) => distributionTargetService.create(sessionId, entry),
    update: (sessionId, id, fields) => distributionTargetService.update(sessionId, id, fields),
    deactivate: (sessionId, id) => distributionTargetService.deactivate(sessionId, id),
  };

  // 엠바고 시점 배부 실행(ADR-008 (3)) — 배부 대상 CRUD와 다른 책임이라 별도 도메인이다.
  // 오케스트레이션만 한다: 인가 게이트 → tick 서비스 위임. 스캔·시점 판정·상태 전이는 여기 없다(ADR-006).
  const distribution = {
    // 인가를 **먼저** 통과시킨다 — 비-Z/미인증에는 스풀 설정 여부조차 알려주지 않는다(설정 상태 노출 최소화).
    async tick(sessionId) {
      const gate = authorization.runDistributionTick(sessionId);
      if (!gate.ok) return gate;
      if (!distributionTickService) return { ok: false, reason: 'spool-disabled' };
      // actorUserId는 검증된 세션에서만 온다(클라이언트 값 불신 — ADR-004).
      return distributionTickService.run({ actorUserId: gate.userId ?? null });
    },
  };

  const collection = {
    receive: (sourceId, payload) => collectionService.receive(sourceId, payload),
    pull: (sourceId) => collectionService.pull(sourceId),
  };

  const photo = {
    register: (dto, opts) => photoService.register(dto, opts),
    search: (q) => photoService.search(q),
  };

  return {
    auth, user, article, media, translation, receiverConfig, collection, photo,
    distributionTarget, distribution,
  };
}
