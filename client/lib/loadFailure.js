// 로드 실패 안내 정책 (phase 62 step0) — Electron 비의존 순수 모듈.
// did-fail-load(errorCode)·did-navigate(httpResponseCode)를 사용자용 한국어 안내로 바꾼다.
// null 반환 = 오류 화면을 띄우지 않는다(서브리소스 실패·정상 취소로 화면을 날리지 않기 위함).
// 문구에 스택·내부 경로·URL 전체 쿼리를 넣지 않는다 — URL은 origin까지만(기사아이디·토큰 노출 차단).

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// Chromium net error 중 운영 현장에서 실제로 갈리는 4종만 특화한다 — 나머지는 일반 문구.
const KNOWN_ERRORS = new Map([
  [-105, { // ERR_NAME_NOT_RESOLVED
    message: '서버 주소를 찾을 수 없습니다.',
    hint: '주소 오타 또는 DNS 문제일 수 있습니다 — 서버 주소를 다시 확인하세요.',
  }],
  [-102, { // ERR_CONNECTION_REFUSED
    message: '서버가 연결을 거부했습니다.',
    hint: '서버가 실행 중인지, 포트 번호가 맞는지 확인하세요.',
  }],
  [-109, { // ERR_ADDRESS_UNREACHABLE
    message: '서버 주소에 도달할 수 없습니다.',
    hint: '네트워크 연결과 방화벽 설정을 확인하세요.',
  }],
  [-118, { // ERR_CONNECTION_TIMED_OUT
    message: '서버 연결 시간이 초과되었습니다.',
    hint: '네트워크 상태 또는 방화벽을 확인한 뒤 다시 연결하세요.',
  }],
]);

export function describeLoadFailure({ errorCode, errorDescription, validatedUrl, isMainFrame } = {}) {
  if (isMainFrame === false) return null; // 서브리소스 실패로 오류 화면을 띄우면 정상 사용 중 화면이 날아간다.
  if (errorCode === -3) return null; // ERR_ABORTED — 사용자 조작·리다이렉트로 흔한 정상 취소.
  const origin = safeOrigin(validatedUrl);
  const suffix = origin ? ` (${origin})` : '';
  const known = KNOWN_ERRORS.get(errorCode);
  if (known) {
    return {
      title: '서버에 연결할 수 없습니다',
      message: `${known.message}${suffix}`,
      hint: known.hint,
      canRetry: true,
    };
  }
  return {
    title: '서버에 연결할 수 없습니다',
    message: `페이지를 불러오지 못했습니다.${suffix}`,
    hint: `잠시 후 다시 연결해 보세요. (원인: ${errorDescription || `code ${errorCode}`})`,
    canRetry: true,
  };
}

export function describeHttpFailure({ httpResponseCode, url } = {}) {
  if (!Number.isInteger(httpResponseCode) || httpResponseCode < 400) return null; // 2xx/3xx = 정상.
  const origin = safeOrigin(url);
  const suffix = origin ? ` (${origin})` : '';
  if (httpResponseCode === 404) {
    // 서버 exe만 있고 web/이 없는 배치가 정확히 이 증상이다(ADR-009 SPA 폴백 계약).
    return {
      title: '화면을 불러올 수 없습니다',
      message: `서버는 응답하지만 기사 작성기 화면(SPA)이 서빙되지 않습니다.${suffix}`,
      hint: '서버 배포 폴더의 web/ 폴더가 있는지 서버 담당자에게 확인하세요.',
      canRetry: true,
    };
  }
  return {
    title: '서버 오류',
    message: `서버가 오류를 돌려주었습니다. (HTTP ${httpResponseCode})${suffix}`,
    hint: '서버 상태를 확인한 뒤 다시 연결해 보세요.',
    canRetry: true,
  };
}
