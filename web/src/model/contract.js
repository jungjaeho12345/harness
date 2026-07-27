// 주입형 Model 계약 (ADR-003) — View/Controller가 transport-agnostic하도록 REST/SSE를 계약 뒤에 격리한다.
// MODEL_KEYS는 백엔드 라우트(server/index.js)와 잇는 단일 통합 seam이다. 실제 배선은 httpModel,
// 테스트/스토리는 fakeModel을 주입한다. JS라 타입 강제가 없으므로 assertModel로 계약을 런타임 검증한다.

export const MODEL_KEYS = Object.freeze([
  'login',
  'logout',
  'restoreSession',
  'queryUsers',
  'createUser',
  'updateUser',
  'queryArticles',
  'getArticle',
  'searchArticles',
  'searchMedia',
  // 사진발행/DB등록(phase 41) — 등록 POST /api/photos · 캡션 검색 GET /api/photos/search와 1:1.
  'publishPhoto',
  'searchPhotos',
  'applyAction',
  'saveArticle',
  'lockArticle',
  'unlockArticle',
  'forceUnlockArticle',
  'queryReceiverConfig',
  'createReceiverConfig',
  'deleteReceiverConfig',
  // 배부 대상 관리(phase 46, distMgmt.do — Z 전용) — /api/distribution-targets 라우트와 1:1. 삭제 없음(비활성=soft delete).
  'queryDistributionTargets',
  'createDistributionTarget',
  'updateDistributionTarget',
  'deactivateDistributionTarget',
  'subscribe',
  // 메뉴 액션(phase 1) — 이력보기/송고이력보기·후속/계속기사작성·번역. 백엔드 라우트와 1:1.
  'queryHistory',
  'deriveArticle',
  'translate',
  // 파일 업로드(첨부파일/자료파일) — POST /api/upload. path 문자열을 Contents.attachmentFile/referenceFile에 보관.
  'uploadFile',
  // 기사이력비교(phase 25) — 스냅샷 단건(본문 markupVersion 포함) 지연 조회. GET /api/articles/:id/history/:historyId와 1:1.
  'getHistorySnapshot',
  // 로그 뷰어(phase 26) — Z 전용 서버 로그. GET /api/logs/stream(SSE)·/api/logs/digest와 1:1.
  'subscribeLogs',
  'getLogsDigest',
]);

// 모든 계약 키가 함수로 구현되어 있는지 검증한다. 누락 시 어떤 키가 빠졌는지 알려주며 throw.
export function assertModel(model) {
  if (!model || typeof model !== 'object') {
    throw new Error('assertModel: model must be an object');
  }
  const missing = MODEL_KEYS.filter((key) => typeof model[key] !== 'function');
  if (missing.length > 0) {
    throw new Error(`assertModel: model is missing required methods: ${missing.join(', ')}`);
  }
  return model;
}
