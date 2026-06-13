// 수집(자동기사) 기본 파서 — FTP 파일 문자열 / API 응답 객체에서 제목·본문을 추출한다.
// 결과 계약: { title, content } (둘 다 문자열). 외부 네트워크/FTP에 의존하지 않는다 (입력은 주입된 payload).

function str(v) {
  return v == null ? '' : String(v);
}

// 텍스트의 첫 줄을 제목, 나머지를 본문으로 분리한다.
// CRLF는 LF로 정규화하고 선행 빈 줄은 무시한다.
function splitFirstLine(text) {
  const normalized = str(text).replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const nl = normalized.indexOf('\n');
  if (nl === -1) return { title: normalized.trim(), content: '' };
  return { title: normalized.slice(0, nl).trim(), content: normalized.slice(nl + 1) };
}

// 기본 포맷 처리:
// - 객체(API 응답): { title, content } 또는 { title, body }에서 직접 추출.
//   title이 없으면 본문 첫 줄을 제목으로 승격한다.
// - 문자열(FTP 파일): 첫 줄이 제목, 나머지가 본문.
export function parse(payload) {
  if (payload && typeof payload === 'object') {
    const title = str(payload.title).trim();
    const content = str(payload.content ?? payload.body);
    if (!title && content) return splitFirstLine(content);
    return { title, content };
  }
  return splitFirstLine(payload);
}
