// 미디어 검색 서버 프록시 서비스 — 이미지=Google 이미지 검색, 영상=YouTube 검색 (ADR-005 서버 프록시).
// CRITICAL: API 키는 주입된 env(서버 환경변수)에서만 읽는다 — 소스 하드코딩 금지(news.md 보안).
// CRITICAL: 외부 호출은 주입된 fetchFn으로 추상화한다 — globalThis.fetch 직접 호출 금지(테스트 결정성).
// 외부 호출 실패는 예외로 전파하지 않고 빈 결과를 반환한다(news.md: 실패 시 빈 결과).
// API 키가 없는 개발/데모 환경에서는 빈 결과 대신 데모 샘플을 반환해 검색 UI가 동작하게 한다(아래 demoResults).

const GOOGLE_IMAGE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const YOUTUBE_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';

// 외부 호출 실패 시 반환 — 매번 새 객체로 만들어 호출자가 items를 변형해도 안전하게 한다.
const empty = () => ({ items: [], error: true });

// 데모 폴백 — API 키가 설정되지 않은 개발/데모 환경에서 빈 결과 대신 보여줄 샘플.
// 실제 키(GOOGLE_*/YOUTUBE_*)가 있으면 buildUrl 경로로 실 API를 호출하므로 이 폴백은 쓰이지 않는다.
// 이미지=picsum(쿼리 시드로 결정적), 영상=공개 샘플 유튜브 영상(임베드 가능한 실제 video id).
const DEMO_VIDEO_IDS = ['aqz-KE-bpKQ', 'jNQXAC9IVRw', 'ScMzIvxBSi4', 'YE7VzlLtp-4'];

function demoResults(type, query) {
  const q = String(query ?? '').trim() || '뉴스';
  if (type === 'image') {
    return Array.from({ length: 6 }, (_, i) => ({
      title: `${q} 이미지 ${i + 1} (데모)`,
      link: `https://picsum.photos/seed/${encodeURIComponent(q)}-${i}/320/200`,
    }));
  }
  return DEMO_VIDEO_IDS.map((id, i) => ({
    title: `${q} 관련 영상 ${i + 1} (데모)`,
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
  }));
}

// 알 수 없거나 누락된 type은 'video'로 처리한다.
function normalizeType(type) {
  return type === 'image' ? 'image' : 'video';
}

// type별 검색 요청 URL을 만든다. 키가 없으면 undefined.
function buildUrl(type, query, env = {}) {
  const q = encodeURIComponent(query ?? '');
  if (type === 'image') {
    if (!env.GOOGLE_API_KEY || !env.GOOGLE_CSE_ID) return undefined;
    return `${GOOGLE_IMAGE_ENDPOINT}?key=${env.GOOGLE_API_KEY}&cx=${env.GOOGLE_CSE_ID}&searchType=image&q=${q}`;
  }
  if (!env.YOUTUBE_API_KEY) return undefined;
  return `${YOUTUBE_ENDPOINT}?key=${env.YOUTUBE_API_KEY}&part=snippet&type=video&q=${q}`;
}

export function createMediaSearch({ fetchFn, env }) {
  async function search(query, type) {
    const kind = normalizeType(type);
    const url = buildUrl(kind, query, env);
    // 키 누락 — 외부 호출 없이 데모 샘플을 반환한다(개발/데모에서 검색 UI가 비지 않도록).
    if (!url) return { items: demoResults(kind, query), error: false, demo: true };

    try {
      const res = await fetchFn(url);
      if (!res || !res.ok) return empty();
      const body = await res.json();
      return { items: Array.isArray(body?.items) ? body.items : [], error: false };
    } catch {
      return empty(); // 네트워크/파싱 오류 — 예외 대신 빈 결과.
    }
  }

  return { search };
}
