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
export function createControllers(db, {
  sessionService,
  env = process.env,
  fetchFn = globalThis.fetch,
  lockoutPolicy = {},
  spoolFs,
  logService,
} = {}) {
  // 모델 결선.
  const userModel = createUserModel(db);
  const articleModel = createArticleModel(db);
  const articleHistoryModel = createArticleHistoryModel(db);
  const receiverConfigModel = createReceiverConfigModel(db);
  const photoModel = createPhotoModel(db);
  const distributionTargetModel = createDistributionTargetModel(db);

  // 세션 스토어는 HTTP 계층과 공유 — 주입 없으면 새로 만든다.
  const session = sessionService ?? createSessionService();

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
    })
    : undefined;

  // 서비스 결선.
  const userService = createUserService({ userModel, ...lockoutPolicy });
  // distributionService 미주입(스풀 미설정) 시 송고 훅은 비활성 — 기존 동작 그대로.
  const articleService = createArticleService({
    articleModel, db, historyModel: articleHistoryModel, distributionService,
  });
  const authorization = createAuthorization({ sessionService: session, articleModel });
  // 시점 배부(tick, phase 48) — 스풀 미설정이어도 항상 생성한다: 인가 게이트(Z 전용)가 스풀 설정 여부보다
  // 먼저 판정돼야 비인가 호출자에게 배부 설정 상태(spool-disabled)가 새지 않는다.
  // distributionService 미주입(스풀 미설정) 시 서비스 계약대로 'spool-disabled'를 반환한다(step1).
  const distributionTickService = createDistributionTickService({
    articleModel, historyModel: articleHistoryModel, distributionService, articleService, authorization,
  });
  const receiverConfigService = createReceiverConfigService({ receiverConfigModel, authorization });
  const collectionService = createCollectionService({ articleService, receiverConfigModel, fetchFn });
  const mediaSearch = createMediaSearch({ fetchFn, env });
  const translate = createTranslate({ fetchFn, env });
  const photoService = createPhotoService({ photoModel });
  const distributionTargetService = createDistributionTargetService({ distributionTargetModel, authorization });

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

  const collection = {
    receive: (sourceId, payload) => collectionService.receive(sourceId, payload),
    pull: (sourceId) => collectionService.pull(sourceId),
  };

  const photo = {
    register: (dto, opts) => photoService.register(dto, opts),
    search: (q) => photoService.search(q),
  };

  // 시점 배부(tick) — Z 전용 게이트·프로세스 내 단일 실행·spool-disabled 판정은 distributionTickService가
  // 강제한다(ADR-008 (3)). 컨트롤러는 위임만 한다(ADR-006) — HTTP 결선은 server/index.js(step2).
  const distribution = {
    tick: (sessionId) => distributionTickService.run(sessionId),
  };

  return {
    auth, user, article, media, translation, receiverConfig, collection, photo, distributionTarget,
    distribution,
  };
}
