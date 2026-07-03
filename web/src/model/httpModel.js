// httpModel — Model 계약(ADR-003)의 실제 REST/SSE 배선. 모든 transport(fetch/EventSource)는
// 이 파일 안에만 있다. View/Controller는 절대 직접 fetch/EventSource를 호출하지 않는다.
//
// 인증의 1차 수단은 서버가 발급한 HttpOnly 세션 쿠키(step3)다. 요청은 credentials:'include'로
// 보내 브라우저가 쿠키를 자동 전송하게 한다. HttpOnly라 JS는 쿠키를 읽지 않으며, F5(새로고침)
// 신원 복원은 서버 /api/session이 담당한다(쿠키 자동 전송 → user 반환).
// x-session-id 헤더는 dev cross-origin(SameSite 제약)에서의 폴백으로 병행 유지한다 — 로그인 응답의
// sessionId를 sessionStorage에 보관해 요청에 첨부하고, logout 시 비운다.
// 응답 shape은 server/index.js(step8) 라우트와 1:1로 맞춘다.

const SESSION_STORAGE_KEY = 'yh.sessionId';

// 클립보드(Ctrl+V) 이미지 File은 file.name이 비어 있고 확장자가 없어 서버 확장자 화이트리스트에서
// invalid-file로 거부된다. MIME → 이미지 확장자 맵(서버 UPLOAD_EXT_ALLOWLIST의 이미지 항목과 정합).
const IMAGE_EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
});

// 확장자 유무 판정 — 마지막 '.' 뒤가 비어있지 않으면(trailing dot 제외) 확장자가 있다고 본다.
function hasExtension(name) {
  const s = typeof name === 'string' ? name : '';
  const dot = s.lastIndexOf('.');
  return dot >= 0 && dot < s.length - 1;
}

// 서버 /api/upload로 보낼 파일명을 결정하는 순수 함수(신뢰경계=서버 — 이 합성은 편의일 뿐 서버의
// 확장자 화이트리스트·5MB 검증을 대체하지 않는다).
//  1) 원본 name에 확장자가 있으면 그대로 사용(첨부/자료 파일 하위호환 — 재작성하지 않는다).
//  2) 확장자가 없고(빈 name 포함) MIME이 이미지 맵에 있으면 pasted-<ts>.<ext>로 합성.
//  3) 맵에 없는 MIME + 확장자 없음이면 임의 확장자를 지어내지 않고 원본 name을 그대로 전송한다
//     → 서버가 invalid-file로 안전 거부(화이트리스트 우회 시도 방지).
export function resolveUploadFilename(name, type) {
  const original = typeof name === 'string' ? name : '';
  if (hasExtension(original)) return original;
  const ext = IMAGE_EXT_BY_MIME[type];
  if (!ext) return original;
  return `pasted-${Date.now()}.${ext}`;
}

function readSessionId() {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    // sessionStorage 접근 불가(SSR/프라이버시 모드 등) — 토큰 없음으로 취급.
    return null;
  }
}

function writeSessionId(sessionId) {
  try {
    if (sessionId) globalThis.sessionStorage?.setItem(SESSION_STORAGE_KEY, sessionId);
    else globalThis.sessionStorage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // sessionStorage 접근 불가 — 무시(이번 세션은 메모리 없이 진행).
  }
}

// 배열 값은 server의 반복 파라미터 파싱(status IN / departments IN)에 맞춰 같은 키를 여러 번 append한다.
function buildQuery(params = {}) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => sp.append(key, v));
    else sp.append(key, value);
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

// base는 기본적으로 빈 문자열(동일 출처) — dev는 Vite 프록시(/api→API), prod는 API 서버가 정적 번들을 같이 서빙한다.
// 동일 출처여야 SameSite=Lax 세션 쿠키가 EventSource(SSE)에도 first-party로 실려 실시간이 동작한다.
// (cross-origin로 띄우려면 VITE_API_BASE를 vite.config 프록시 target으로 주거나 base를 명시 주입한다.)
export function createHttpModel({ base = '' } = {}) {
  // 모든 REST 호출의 단일 통로 — 쿠키 첨부(credentials:'include') + JSON 직렬화/역직렬화.
  // clientId: 편집 탭(EDIT TAB)별 고유 식별자 — 잠금/저장/해제 시 x-edit-client 헤더로 실어 서버가
  // 한 세션 내 1탭만 편집 가능(다른 탭은 차단)·같은 사용자 재로그인 takeover를 강제하게 한다(편집 잠금 계약).
  async function request(path, { method = 'GET', body, query, clientId } = {}) {
    const headers = {};
    const sessionId = readSessionId();
    if (sessionId) headers['x-session-id'] = sessionId;
    if (clientId) headers['x-edit-client'] = clientId;
    // 인증의 1차 수단은 HttpOnly 세션 쿠키(step3). credentials:'include'로 cross-origin 요청에도
    // 브라우저가 쿠키를 자동 전송한다(CORS credentials:true). HttpOnly라 JS로 쿠키를 읽지 않으며,
    // 신원 복원은 서버 /api/session에 위임한다. x-session-id 헤더는 dev cross-origin(SameSite 제약)
    // 폴백으로 병행 유지한다.
    const init = { method, headers, credentials: 'include' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}${buildQuery(query)}`, init);
    return res.json();
  }

  return {
    // --- 인증 / 세션 ---
    // 로그인 성공 시 서버가 Set-Cookie(sid)로 세션을 발급한다. 인증의 1차 수단은 그 쿠키지만,
    // dev cross-origin(SameSite 제약으로 쿠키 미적재) 폴백을 위해 응답의 sessionId를 sessionStorage에
    // 보관해 이후 요청에 x-session-id 헤더/?session= 쿼리로 병행 첨부한다.
    async login(userId, password) {
      const r = await request('/api/login', { method: 'POST', body: { userId, password } });
      if (r && r.ok && r.sessionId) writeSessionId(r.sessionId);
      return r;
    },
    // 서버가 세션 무효화 + clearCookie로 처리한다. 프론트는 폴백용 보관 토큰을 비운다(이후 헤더 미첨부).
    async logout() {
      const r = await request('/api/logout', { method: 'POST' });
      writeSessionId(null);
      return r;
    },
    // F5 복원 — 쿠키(credentials:'include')로 서버에 신원을 묻는다. 세션 없으면 throw가 아니라
    // 비로그인 응답({ ok:false, reason:'unauthenticated' })을 그대로 돌려준다.
    restoreSession() {
      return request('/api/session');
    },

    // --- 사용자 (Z 게이트는 서버가 강제. 응답에 비밀번호 없음) ---
    queryUsers(filters = {}) {
      return request('/api/users', { query: filters });
    },
    createUser(payload) {
      return request('/api/users', { method: 'POST', body: payload });
    },
    updateUser(userId, fields) {
      return request(`/api/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: fields });
    },

    // --- 기사 조회/검색/저장 ---
    queryArticles(filters = {}) {
      return request('/api/articles', { query: filters });
    },
    // 단건 조회 — 본문(markupVersion)을 포함한 전체 기사 { ok, article, contents }. 편집 진입 시 본문 채우기.
    getArticle(articleId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}`);
    },
    searchArticles(q) {
      return request('/api/articles/search', { query: { q } });
    },
    searchMedia(query, type) {
      return request('/api/media/search', { query: { q: query, type } });
    },
    // role은 서버 세션에서 도출 — body로 보내지 않는다(ADR-004).
    applyAction(articleId, action) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/action`, {
        method: 'POST',
        body: { action },
      });
    },
    // articleId 유무로 신규 생성(POST)/부분 수정(PUT, 잠금 보유자)을 한 메서드가 분기한다.
    // clientId(편집 탭 식별자)는 x-edit-client 헤더로 실어 PUT 저장 시 서버가 잠금 보유 탭인지 검증하게 한다
    // (assertLockHolder — 2번째 탭의 저장을 차단). 신규(POST)에도 무해하게 동행한다.
    // action(send/hold)은 신규(create=POST)에서만 body에 싣는다 — 서버 initialStatus가 Z+hold를 DDH로 둔다(step0).
    // PUT(편집 저장)에는 싣지 않는다(상태 전이는 applyAction 담당). action 미전달이면 키 없음(하위호환). role은 안 싣는다(ADR-004).
    saveArticle(dto = {}, clientId, action) {
      if (dto.articleId) {
        return request(`/api/articles/${encodeURIComponent(dto.articleId)}`, { method: 'PUT', body: dto, clientId });
      }
      const body = action ? { ...dto, action } : dto;
      return request('/api/articles', { method: 'POST', body, clientId });
    },

    // --- 메뉴 액션: 이력 / 파생 / 번역 (role은 서버 세션에서 도출 — body로 보내지 않는다, ADR-004) ---
    // 이력보기/송고이력보기 — 읽기 전용. sendOnly일 때만 쿼리에 sendOnly=1을 싣는다.
    queryHistory(articleId, { sendOnly } = {}) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/history`, {
        query: sendOnly ? { sendOnly: 1 } : {},
      });
    },
    // 기사이력비교 — 스냅샷 단건(본문 markupVersion 포함) 지연 조회. 목록(queryHistory)은 hasSnapshot 경량이라
    // 본문은 사용자가 고른 항목만 이 GET으로 받는다. 응답 { ok, item } 그대로 반환. 읽기 전용.
    getHistorySnapshot(articleId, historyId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/history/${encodeURIComponent(historyId)}`);
    },
    // 후속(followUp)/계속(continue)기사작성 — author는 서버가 세션에서 stamp한다.
    deriveArticle(articleId, mode) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/derive`, {
        method: 'POST',
        body: { mode },
      });
    },
    // 번역 — 서버가 DB 본문을 조회·번역한다(text를 클라가 싣지 않음). 기본 대상 언어 ko.
    translate(articleId, targetLang = 'ko') {
      return request(`/api/articles/${encodeURIComponent(articleId)}/translate`, {
        method: 'POST',
        body: { targetLang },
      });
    },

    // --- 파일 업로드(첨부파일/자료파일 + 클립보드 이미지) ---
    // File을 FileReader로 data URL로 읽어 "data:...;base64," 접두사를 떼어낸 raw base64만 서버로 보낸다
    // (server /api/upload 계약은 prefix 없는 raw base64를 받는다). 응답 { ok, path, filename }을 그대로 반환한다.
    // path 문자열이 Contents.attachmentFile/referenceFile(VARCHAR) 또는 임베드 src에 저장된다.
    // 파일명은 resolveUploadFilename으로 결정한다 — 확장자 있는 파일은 그대로, 확장자 없는 클립보드
    // 이미지는 MIME에서 유효 파일명을 합성한다(시그니처·요청/응답 shape은 불변).
    async uploadFile(file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('file-read-failed'));
        reader.readAsDataURL(file);
      });
      const contentBase64 = String(dataUrl).replace(/^data:[^;]*;base64,/, '');
      const filename = resolveUploadFilename(file.name, file.type);
      return request('/api/upload', {
        method: 'POST',
        body: { filename, contentBase64 },
      });
    },

    // --- 편집 잠금 ---
    // clientId(편집 탭 식별자)를 x-edit-client 헤더로 실어 서버 acquire/release가 보유 탭을 식별하게 한다.
    // 같은 탭 새로고침은 재획득 허용, 같은 세션 다른 탭은 차단, 같은 사용자 재로그인은 takeover(편집 잠금 계약).
    lockArticle(articleId, action, clientId) {
      const body = action ? { action } : {};
      return request(`/api/articles/${encodeURIComponent(articleId)}/lock`, { method: 'POST', body, clientId });
    },
    unlockArticle(articleId, clientId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/unlock`, { method: 'POST', clientId });
    },
    forceUnlockArticle(articleId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/force-unlock`, { method: 'POST' });
    },

    // --- 수신 설정 (Z 전용 — 서버 게이트) ---
    queryReceiverConfig(filters = {}) {
      return request('/api/receiver-config', { query: filters });
    },
    createReceiverConfig(entry) {
      return request('/api/receiver-config', { method: 'POST', body: entry });
    },
    deleteReceiverConfig(id) {
      return request(`/api/receiver-config/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    // --- 실시간 무효화 스트림 (SSE) ---
    // 인증의 1차 수단은 HttpOnly 세션 쿠키 — EventSource는 헤더를 못 보내지만 withCredentials:true로
    // cross-origin 쿠키를 자동 전송한다(step5, server는 쿠키 우선 readSessionToken으로 인증).
    // dev cross-origin(SameSite 제약으로 쿠키 미적재)에서는 보관된 sessionId를 ?session= 쿼리 폴백으로만
    // 붙인다(토큰 없으면 URL에 노출 안 함). ADR-005: 표준 EventSource가 끊김 시 자동 재연결을 제공한다.
    // onChange는 "무효화 신호"만 받으며, filter는 그대로 넘겨 Controller가 자기 필터로 재조회하게 한다.
    // onStatus(boolean) — 선택적 연결 상태 콜백. ready→true, error→false로 호출해 View가 실제 SSE 상태를 표시할 수 있게 한다.
    subscribe(filter, onChange, onStatus) {
      const url = `${base}/api/stream${buildQuery({ session: readSessionId() })}`;
      const source = new EventSource(url, { withCredentials: true });
      let connected = false;
      const setStatus = (next) => { connected = next; onStatus?.(next); };
      source.addEventListener('ready', () => setStatus(true));
      source.addEventListener('change', (event) => {
        let signal = {};
        try {
          signal = event.data ? JSON.parse(event.data) : {};
        } catch {
          signal = {};
        }
        onChange(signal, filter);
      });
      source.addEventListener('error', () => setStatus(false));
      return {
        connected: () => connected,
        unsubscribe: () => source.close(),
      };
    },
  };
}
