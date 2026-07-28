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
  // 배부 변경 구독자 — transport(createApp)가 SSE 무효화 신호(app.notifyChange)를 여기에 건다.
  // 컨트롤러가 seam을 소유하는 이유: 부트스트랩 순서상 app이 컨트롤러보다 나중에 만들어지므로,
  // 부트스트랩에서 app을 늦게 대입해 잇는 방식은 createApp을 직접 조립하는 경로에서 결선이 빠진다.
  const changeListeners = [];
  function notifyDistributionChange() {
    // 구독자 예외가 배부/tick 결과를 바꾸지 않도록 개별 격리한다.
    for (const listener of changeListeners) {
      try { listener(); } catch { /* 구독자 실패는 배부를 막지 않는다 */ }
    }
  }

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
      // 배부 완료(= distributedAt 갱신) 후 목록 무효화. 송고 훅 경로는 라우트가 완료 시점을 모르므로
      // 이 신호가 없으면 목록의 배부시간이 다음 수동 조회 전까지 옛 값으로 남는다.
      onDistributed: () => notifyDistributionChange(),
    })
    : undefined;

  // 시점 배부 tick(ADR-008 (3)) — 배부 비활성(스풀 미설정)이면 tickService가 spool-disabled를 반환한다.
  const distributionTickService = createDistributionTickService({
    articleModel,
    historyModel: articleHistoryModel,
    distributionService,
  });

  // 서비스 결선.
  const userService = createUserService({ userModel, ...lockoutPolicy });
  // distributionService 미주입(스풀 미설정) 시 송고 훅은 비활성 — 기존 동작 그대로.
  const articleService = createArticleService({
    articleModel, db, historyModel: articleHistoryModel, distributionService,
  });
  const authorization = createAuthorization({ sessionService: session, articleModel });
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

  // 시점 배부 실행(ADR-008 (3)) — Z/시스템 전용 pull. 앱에는 타이머가 없다(외부 운영 루틴이 호출).
  const distribution = {
    async tick(sessionId) {
      const gate = authorization.runDistributionTick(sessionId);
      if (!gate.ok) return gate;
      // actorUserId는 검증된 세션에서만 온다 — 클라이언트가 보낸 actor를 쓰면 이력이 위조된다(ADR-004).
      const result = await distributionTickService.tick({ actorUserId: gate.userId });
      // 배부가 0건이어도 완결 전이(EPS→DPS)가 있으면 목록의 status 배지가 바뀐다 — 알리지 않으면 화면이 옛 상태로 남는다.
      // (배부가 있었던 경우는 distributionService.onDistributed가 이미 알렸다. 중복 신호는 무해하고, 누락이 유해하다.)
      if (result.ok && result.completed && result.completed.length > 0) notifyDistributionChange();
      return result;
    },
    // 무효화 신호 구독 — transport가 app.notifyChange를 건다.
    onChange: (listener) => { if (typeof listener === 'function') changeListeners.push(listener); },
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
    auth, user, article, media, translation, receiverConfig, collection, photo, distributionTarget, distribution,
  };
}
