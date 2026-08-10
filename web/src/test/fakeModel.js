// fakeModel — Model 계약(ADR-003)을 만족하는 in-memory 가짜. 테스트/스토리에서 실제 네트워크 없이 주입한다.
// httpModel과 같은 응답 shape({ ok, items, user, articleId, ... })을 흉내내고, 비밀번호는 어떤 응답에도 넣지 않는다.
// assertModel을 통과해야 한다(모든 MODEL_KEYS를 함수로 구현).

// 배부 대상 조회 필터 / 수정 가능 필드 — 서버(distributionTargetService)의 FILTER_KEYS·검증 대상과 같은 집합.
// id·createdAt·updatedAt은 서버 소유라 클라 입력으로 바뀌지 않는다.
const DIST_TARGET_FILTER_KEYS = ['id', 'name', 'kind', 'spoolDir', 'active'];
const DIST_TARGET_MUTABLE_KEYS = ['name', 'kind', 'spoolDir', 'active'];

function stripPassword(user) {
  if (!user) return user;
  const safe = { ...user };
  delete safe.password;
  return safe;
}

export function createFakeModel(seed = {}) {
  const users = [...(seed.users ?? [])];
  const articles = [...(seed.articles ?? [])];
  const receiverConfigs = [...(seed.receiverConfigs ?? [])];
  // 배부 대상(phase 46) — 행은 절대 지우지 않는다(비활성=active 'N', 서버 soft delete와 동형).
  const distributionTargets = [...(seed.distributionTargets ?? [])];
  // 배부 실패(phase 57 MVP-4) — fake는 서버가 파생해서 주는 '미해소 목록'을 모사한다.
  // 원장(ArticleHistory) 자체를 모사하지 않는다: 해소를 배열 제거로 구현하지만 그것이 DB 행 삭제를
  // 뜻하지 않는다(서버는 append-only 이력에서 미해소 여부를 파생한다 — distributionFailureLog).
  const distributionFailures = [...(seed.distributionFailures ?? [])];
  // 수동 tick 응답 모사 — seed.tickResult가 있으면 그걸, 없으면 빈 요약 기본값을 준다.
  const tickResult = seed.tickResult
    ?? { ok: true, at: new Date().toISOString(), scanned: 0, distributed: [], failed: [], invalid: [] };
  const mediaItems = [...(seed.mediaItems ?? [])];
  // 사진DB(phase 41) — 등록→검색 루프를 네트워크 없이 재현하는 in-memory 스토어.
  const photos = [...(seed.photos ?? [])];
  // articleId -> 이력 배열(최신순). 컨트롤러 테스트가 seed로 주입한다.
  const histories = { ...(seed.histories ?? {}) };
  // articleId -> 번역문(seed). 없으면 원문 모사로 graceful 폴백.
  const translations = { ...(seed.translations ?? {}) };
  // 서버 로그 record 배열 모사(각 { seq, ts, level, message, line }) — subscribeLogs 접속 replay에 쓴다.
  const logs = [...(seed.logs ?? [])];
  const listeners = new Set();
  const logListeners = new Set();
  let session = null; // { sessionId, user }
  let seq = 1;

  const notify = (kind) => { for (const fn of listeners) fn({ kind }); };
  const findArticle = (articleId) => articles.find((a) => a.articleId === articleId);

  return {
    login(userId, password) {
      const found = users.find((u) => u.userId === userId
        && (password === undefined || u.password === password));
      if (!found) return { ok: false, reason: 'invalid-credentials' };
      const user = stripPassword(found);
      session = { sessionId: `fake-${userId}`, user };
      return { ok: true, sessionId: session.sessionId, user };
    },
    logout() {
      session = null;
      return { ok: true };
    },
    restoreSession() {
      return session
        ? { ok: true, user: session.user }
        : { ok: false, reason: 'unauthenticated' };
    },

    queryUsers() {
      return { ok: true, items: users.map(stripPassword) };
    },
    createUser(payload = {}) {
      users.push({ ...payload });
      return { ok: true, user: stripPassword(payload) };
    },
    updateUser(userId, fields = {}) {
      const u = users.find((x) => x.userId === userId);
      if (!u) return { ok: false, reason: 'not-found' };
      Object.assign(u, fields);
      return { ok: true, user: stripPassword(u) };
    },

    queryArticles(filters = {}) {
      let items = articles;
      if (filters.status !== undefined) {
        const allow = [].concat(filters.status);
        items = items.filter((a) => allow.includes(a.status));
      }
      if (filters.excludeStatus !== undefined) {
        const deny = [].concat(filters.excludeStatus);
        items = items.filter((a) => !deny.includes(a.status));
      }
      return { ok: true, items: items.map((a) => ({ ...a })) };
    },
    searchArticles(q = '') {
      const needle = String(q);
      const items = articles.filter((a) => (a.title ?? '').includes(needle));
      return { ok: true, items: items.map((a) => ({ ...a })) };
    },
    searchMedia(query, type) {
      const items = mediaItems.filter((m) => !type || m.type === type);
      return { ok: true, items: items.map((m) => ({ ...m })), error: false };
    },
    // 사진 등록 — registeredBy는 현재 세션 사용자로만 stamp한다(서버 동형 — payload 값 신뢰 안 함, ADR-004).
    publishPhoto(payload = {}) {
      const { src, caption, sourceArticleId } = payload;
      const id = seq++;
      photos.push({
        id,
        src,
        caption: caption ?? '',
        sourceArticleId: sourceArticleId ?? '',
        registeredBy: session?.user?.userId ?? null,
        createdAt: new Date().toISOString(),
      });
      return { ok: true, id };
    },
    // 사진DB 캡션 부분일치 검색 — searchArticles와 동형(복사본 반환 — 원본 불변).
    searchPhotos(q = '') {
      const needle = String(q);
      const items = photos.filter((p) => (p.caption ?? '').includes(needle));
      return { ok: true, items: items.map((p) => ({ ...p })) };
    },
    applyAction(articleId, action) {
      const a = findArticle(articleId);
      if (!a) return { ok: false, reason: 'not-found' };
      a.lastAction = action;
      notify('status');
      return { ok: true, articleId };
    },
    getArticle(articleId) {
      const a = findArticle(articleId);
      if (!a) return { ok: false, reason: 'not-found' };
      // 서버 getById와 같은 shape({ article, contents }). in-memory는 평탄 1행이라 둘 다 같은 행을 비춘다.
      return { ok: true, article: { ...a }, contents: { ...a } };
    },
    // clientId(편집 탭 식별자)는 PUT 저장 시 잠금 보유 탭 검증(assertLockHolder)에 쓰인다 — in-memory에선
    // 보유 탭(lockerClientId)이 다르면 거부해 "2번째 탭 저장 차단" 계약을 단위테스트에서 재현할 수 있게 한다.
    // 경고(축소 모사): 이 더블은 clientId만 본다. 서버는 phase51·52 이후 세션에서 도출한 userId ↔
    // Contents.lockerUserId까지 대조하므로, 여기서 통과한 시나리오가 서버에서 통과한다는 보장이 없다.
    // 저장/잠금 인가 계약의 진실은 백엔드 테스트(test/editLock.test.js·test/server.test.js)다.
    saveArticle(dto = {}, clientId) {
      // 서버는 본문을 markupVersion 컬럼에만 저장하고 body 키는 버린다(ARTICLE_FIELDS pick 이음새).
      // 같은 정규화를 해야 contract 불일치(본문이 body로 전송되는 버그)가 단위테스트에서도 드러난다.
      const { body, ...persist } = dto; // eslint-disable-line no-unused-vars
      // 편집(PUT, articleId 보유)일 때만 잠금 보유 탭을 검증한다. 잠겨 있고 보유 탭이 다르면 거부.
      if (persist.articleId) {
        const locked = findArticle(persist.articleId);
        if (locked && locked.lockYN === 'Y' && locked.lockerClientId
          && clientId !== undefined && clientId !== locked.lockerClientId) {
          return { ok: false, reason: 'not-holder' };
        }
      }
      if (persist.articleId) {
        const a = findArticle(persist.articleId);
        if (a) Object.assign(a, persist);
        else articles.push({ ...persist });
        notify('update');
        return { ok: true, articleId: persist.articleId };
      }
      const articleId = `AKRFAKE${String(seq++).padStart(9, '0')}`;
      articles.push({ ...persist, articleId, status: 'RDS' });
      notify('create');
      return { ok: true, articleId };
    },

    // --- 메뉴 액션: 이력 / 파생 / 번역 ---
    // 이력보기/송고이력보기 — seed의 이력 배열을 반환. sendOnly면 송고(action==='send') 항목만 필터.
    // 서버 /history 계약(phase 56): 목록은 본문 blob(markupVersion) 없는 경량 응답이다 — 여기서도 제외한다
    // (blob을 되살리지 마라 — 뷰가 실서버에 없는 필드에 의존해도 테스트가 못 잡는다). title/version/status는
    // 서버가 파생해 싣는 값이라 fake는 계산하지 않고 시드 값 그대로 통과시킨다(파생 규칙의 진실은
    // 백엔드 src/services/historyMeta.js). 원본 시드는 변형 금지 — getHistorySnapshot이 같은 배열에서 본문을 읽는다.
    queryHistory(articleId, { sendOnly } = {}) {
      const items = (histories[articleId] ?? [])
        .map(({ markupVersion, ...rest }) => rest); // eslint-disable-line no-unused-vars
      const filtered = sendOnly ? items.filter((h) => h.action === 'send') : items;
      return { ok: true, items: filtered };
    },
    // 기사이력비교 — 스냅샷 단건 지연 조회 모사. seed 이력에서 id 일치 항목을 복사해 { ok, item }으로 반환한다
    // (원본 불변·읽기 전용). articleId 스코프 밖/없는 id는 서버와 동일하게 not-found.
    getHistorySnapshot(articleId, historyId) {
      const h = (histories[articleId] ?? []).find((x) => x.id === historyId);
      if (!h) return { ok: false, reason: 'not-found' };
      return { ok: true, item: { ...h } };
    },
    // 후속/계속기사작성 — saveArticle처럼 새 articleId를 만들어 push. 원본은 변경하지 않는다(비파괴 모사).
    deriveArticle(articleId, mode) {
      const src = findArticle(articleId);
      if (!src) return { ok: false, reason: 'not-found' };
      const newId = `AKRFAKE${String(seq++).padStart(9, '0')}`;
      // continue는 본문 복사·followUp은 빈 본문(서버 deriveArticle 도메인 모사). 원본 객체는 건드리지 않는다.
      const derived = { ...src, articleId: newId, status: 'RDS' };
      if (mode === 'followUp') delete derived.body;
      articles.push(derived);
      notify('create');
      return { ok: true, articleId: newId };
    },
    // 번역 — seed의 번역문, 없으면 원문(title) 모사로 graceful 폴백.
    translate(articleId, targetLang = 'ko') { // eslint-disable-line no-unused-vars
      if (translations[articleId] !== undefined) {
        return { ok: true, translatedText: translations[articleId] };
      }
      const a = findArticle(articleId);
      return { ok: true, translatedText: a?.title ?? '' };
    },
    // 파일 업로드(첨부파일/자료파일) — 네트워크 없이 server /api/upload 응답 shape({ ok, path, filename })을 모사.
    // 저장 path는 server와 동일하게 /uploads/ 접두사를 둔다(테스트/스토리가 path 문자열을 그대로 dto에 싣는다).
    uploadFile(file = {}) {
      const name = file.name ?? 'file';
      return { ok: true, path: `/uploads/fake-${name}`, filename: name };
    },

    // clientId(편집 탭 식별자)-aware in-memory 잠금. acquire 규칙(편집 잠금 계약 a/b/c 모델의 축소판):
    // 이미 다른 clientId가 잠그고 있으면 'locked' 거부(같은 세션 다른 탭/다른 사용자), 같은 clientId면 재획득 허용.
    // 경고: 서버는 여기에 더해 세션 userId ↔ lockerUserId를 대조한다(saveArticle 주석 참조) — 인가 판정의
    // 진실은 백엔드 테스트다. 이 더블의 판정을 실제 서버 규칙으로 오해하지 마라.
    lockArticle(articleId, action, clientId) { // action은 서버 게이트용 — fake는 잠금 식별(clientId)만 검증
      const a = findArticle(articleId);
      if (a) {
        if (a.lockYN === 'Y' && a.lockerClientId && clientId !== undefined && a.lockerClientId !== clientId) {
          return { ok: false, reason: 'locked' };
        }
        a.lockYN = 'Y';
        a.lockerClientId = clientId ?? null;
      }
      notify('lock');
      return { ok: true };
    },
    // 보유 탭(lockerClientId===clientId)만 해제한다. 비보유 탭은 not-holder, 이미 해제면 멱등 ok.
    unlockArticle(articleId, clientId) {
      const a = findArticle(articleId);
      if (a) {
        if (a.lockYN === 'Y' && a.lockerClientId
          && clientId !== undefined && a.lockerClientId !== clientId) {
          return { ok: false, reason: 'not-holder' };
        }
        a.lockYN = 'N';
        a.lockerClientId = null;
      }
      notify('lock');
      return { ok: true };
    },
    // 강제 해제(D/Z) — clientId 무관하게 잠금을 비운다(보유 탭 검증 없음).
    forceUnlockArticle(articleId) {
      const a = findArticle(articleId);
      if (a) { a.lockYN = 'N'; a.lockerClientId = null; }
      notify('lock');
      return { ok: true };
    },

    queryReceiverConfig() {
      return { ok: true, items: receiverConfigs.map((c) => ({ ...c })) };
    },
    createReceiverConfig(entry = {}) {
      const id = seq++;
      receiverConfigs.push({ ...entry, id });
      return { ok: true, id };
    },
    deleteReceiverConfig(id) {
      const i = receiverConfigs.findIndex((c) => c.id === id);
      if (i >= 0) receiverConfigs.splice(i, 1);
      return { ok: true };
    },

    // --- 배부 대상(Z 전용 — 게이트/검증의 진실은 서버, fake는 shape만 모사) ---
    // 허용 키 동등 필터 후 복사본 반환(원본 불변). 비활성 행도 숨기지 않는다 — 서버가 그렇게 응답한다.
    queryDistributionTargets(filters = {}) {
      const items = distributionTargets.filter(
        (t) => DIST_TARGET_FILTER_KEYS.every((k) => filters[k] === undefined || t[k] === filters[k]),
      );
      return { ok: true, items: items.map((t) => ({ ...t })) };
    },
    // id·createdAt·updatedAt은 서버가 정한다 — entry의 동명 필드는 채택하지 않는다(ADR-004 동형).
    // active 미지정 시 'Y' stamp도 서버와 동형. 그 외 값 검증(kind 집합·슬러그·유일성)은 흉내내지 않는다.
    createDistributionTarget(entry = {}) {
      const id = seq++;
      const stamp = new Date().toISOString();
      distributionTargets.push({
        id,
        name: entry.name,
        kind: entry.kind,
        spoolDir: entry.spoolDir,
        active: entry.active ?? 'Y',
        createdAt: stamp,
        updatedAt: stamp,
      });
      return { ok: true, id };
    },
    // present-only 병합 — 전달한 가변 필드만 반영하고 미전달 필드는 불변.
    updateDistributionTarget(id, fields = {}) {
      const t = distributionTargets.find((x) => x.id === id);
      if (!t) return { ok: false, reason: 'not-found' };
      for (const key of DIST_TARGET_MUTABLE_KEYS) {
        if (fields[key] !== undefined) t[key] = fields[key];
      }
      t.updatedAt = new Date().toISOString();
      return { ok: true, changes: 1 };
    },
    // 비활성(soft delete) — 행을 제거하지 않는다(splice 금지). active='N'만 설정한다.
    deactivateDistributionTarget(id) {
      const t = distributionTargets.find((x) => x.id === id);
      if (!t) return { ok: false, reason: 'not-found' };
      t.active = 'N';
      t.updatedAt = new Date().toISOString();
      return { ok: true, changes: 1 };
    },

    // --- 배부 실패 복구/실행(phase 57 MVP-4 — 게이트/판정의 진실은 서버, fake는 shape만 모사) ---
    // 미해소 항목의 복사본 배열 반환(원본 불변). 서버 shape의 전 필드(targetKind·kindDistributed 포함)를
    // 그대로 통과시킨다 — fake가 기본값을 지어내지 않는다(화면 테스트의 입력이 시드 그대로 흐르게).
    queryDistributionFailures(filters = {}) {
      let items = distributionFailures.map((f) => ({ ...f }));
      if (filters.limit !== undefined) items = items.slice(0, filters.limit);
      return { ok: true, items };
    },
    // 식별자는 목록의 키(historyId)다 — 일치 항목이 없으면 no-failure(서버 어휘 동형).
    // 있으면 해소 처리 후 성공 shape 반환(articleId·targetId·kind는 그 항목에서 도출 — 서버 동형).
    // 배열 제거는 '미해소 목록'에서의 이탈 모사일 뿐 DB 행 삭제가 아니다(위 distributionFailures 주석).
    retryDistribution(historyId) {
      const i = distributionFailures.findIndex((f) => f.historyId === historyId);
      if (i < 0) return { ok: false, reason: 'no-failure' };
      const [resolved] = distributionFailures.splice(i, 1);
      return {
        ok: true, articleId: resolved.articleId, targetId: resolved.targetId,
        kind: resolved.kind, at: new Date().toISOString(),
      };
    },
    // 수동 tick — seed 응답(또는 기본 요약)을 복사본으로 반환. 앱 내 타이머/자동 실행은 두지 않는다(ADR-008 (3)).
    runDistributionTick() {
      return { ...tickResult };
    },

    subscribe(filter, onChange, onStatus) {
      const handler = (signal) => onChange(signal, filter);
      listeners.add(handler);
      onStatus?.(true); // fake 스트림은 즉시 연결됨으로 본다.
      return {
        connected: () => true,
        unsubscribe: () => listeners.delete(handler),
      };
    },

    // --- 로그 뷰어(Z 전용 — 서버 게이트) 모사 ---
    // 다이제스트 — logsDigest seed가 있으면 그걸, 없으면 logs를 { ok, items } 복사본으로 반환(원본 불변).
    getLogsDigest() {
      return { ok: true, items: (seed.logsDigest ?? logs).map((r) => ({ ...r })) };
    },
    // 로그 스트림 모사 — 접속 시 seed 로그를 즉시 replay(서버 replay 모사)한 뒤 구독 등록.
    subscribeLogs(onLog, onStatus) {
      for (const r of logs) onLog({ ...r });
      const handler = (r) => onLog({ ...r });
      logListeners.add(handler);
      onStatus?.(true); // fake 스트림은 즉시 연결됨으로 본다.
      return {
        connected: () => true,
        unsubscribe: () => logListeners.delete(handler),
      };
    },
  };
}
