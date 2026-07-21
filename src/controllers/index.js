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

import { createSessionService } from '../services/sessionService.js';
import { createUserService } from '../services/userService.js';
import { createArticleService } from '../services/articleService.js';
import { createAuthorization } from '../services/authorization.js';
import { createReceiverConfigService } from '../services/receiverConfigService.js';
import { createCollectionService } from '../services/collectionService.js';
import { createMediaSearch } from '../services/mediaSearch.js';
import { createTranslate } from '../services/translate.js';
import { createPhotoService } from '../services/photoService.js';

export function createControllers(db, {
  sessionService,
  env = process.env,
  fetchFn = globalThis.fetch,
  lockoutPolicy = {},
} = {}) {
  // 모델 결선.
  const userModel = createUserModel(db);
  const articleModel = createArticleModel(db);
  const articleHistoryModel = createArticleHistoryModel(db);
  const receiverConfigModel = createReceiverConfigModel(db);
  const photoModel = createPhotoModel(db);

  // 세션 스토어는 HTTP 계층과 공유 — 주입 없으면 새로 만든다.
  const session = sessionService ?? createSessionService();

  // 서비스 결선.
  const userService = createUserService({ userModel, ...lockoutPolicy });
  const articleService = createArticleService({ articleModel, db, historyModel: articleHistoryModel });
  const authorization = createAuthorization({ sessionService: session, articleModel });
  const receiverConfigService = createReceiverConfigService({ receiverConfigModel, authorization });
  const collectionService = createCollectionService({ articleService, receiverConfigModel, fetchFn });
  const mediaSearch = createMediaSearch({ fetchFn, env });
  const translate = createTranslate({ fetchFn, env });
  const photoService = createPhotoService({ photoModel });

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

  const collection = {
    receive: (sourceId, payload) => collectionService.receive(sourceId, payload),
    pull: (sourceId) => collectionService.pull(sourceId),
  };

  const photo = {
    register: (dto, opts) => photoService.register(dto, opts),
    search: (q) => photoService.search(q),
  };

  return { auth, user, article, media, translation, receiverConfig, collection, photo };
}
