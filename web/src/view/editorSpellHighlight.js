// 에디터 맞춤법 하이라이트 세그먼트 모델 — 본문 평문과 오류 span 목록을 줄별
// 하이라이트/비-하이라이트 세그먼트로 분할하는 순수 계산(표시 전용 파생값, 본문 미수정).
// 좌표는 blocksToText(blocks)(텍스트 블록만 개행으로 이은 평문)의 절대 오프셋
// (UTF-16 코드유닛, end 배타적) 기준 — checkSpelling 이슈의 start/end를 그대로 받는다.
// 순수·결정적, DOM/transport/Date/랜덤 비의존. 렌더(DOM 분할)는 Step 1이 담당한다.

// span 정규화·병합 — [0, length]로 clamp하고 빈/역전/비유한 구간은 버린 뒤,
// 시작 오름차순 정렬 후 겹치거나 맞닿은(다음.start <= 현재.end) 구간을 합집합으로 합친다.
// 서로 다른 규칙군의 이슈는 겹칠 수 있고(editorSpell), 맞닿은 하이라이트가 갈라지지 않게.
function mergeSpans(spans, length) {
  const clamped = [];
  for (const span of spans) {
    if (!span || !Number.isFinite(span.start) || !Number.isFinite(span.end)) continue;
    const start = Math.max(0, span.start);
    const end = Math.min(length, span.end);
    if (start >= end) continue;
    clamped.push({ start, end });
  }
  clamped.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const span of clamped) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push(span);
    }
  }
  return merged;
}

// 본문 평문(blocksToText 결과)과 오류 span 목록을 받아, 줄별 하이라이트 세그먼트 배열을 반환한다.
// text: string. spans: [{ start, end }] (issue 객체를 그대로 넘겨도 start/end만 읽는다).
// 반환: text.split('\n')의 줄 인덱스로 색인된 배열 — 각 원소는 [{ text, hl }] 세그먼트 목록.
// 불변식: 각 줄 세그먼트의 text를 순서대로 이으면 그 줄 텍스트와 정확히 같다(공백 포함).
// 하이라이트 없는 줄은 [{ text: 줄 전체, hl: false }] 단일 세그먼트(빈 줄은 text '') —
// Step 1 렌더가 이 경우 기존과 동일한 순수 텍스트 노드로 내 DOM 동일성을 유지한다.
// 줄 사이 '\n' 자체는 하이라이트 대상이 아니며, 여러 줄에 걸친 span은 줄별로 나뉜다.
export function buildLineHighlights(text, spans) {
  const s = String(text ?? '');
  const merged = mergeSpans(Array.isArray(spans) ? spans : [], s.length);
  const result = [];
  let lineStart = 0;
  let spanIdx = 0;
  for (const line of s.split('\n')) {
    const lineEnd = lineStart + line.length;
    const segments = [];
    let cursor = lineStart;
    // 이 줄 이전에 끝난 병합 구간은 건너뛴다(구간은 정렬·비중첩 — 인덱스는 앞으로만 이동).
    while (spanIdx < merged.length && merged[spanIdx].end <= lineStart) spanIdx += 1;
    for (let i = spanIdx; i < merged.length && merged[i].start < lineEnd; i += 1) {
      const hlStart = Math.max(merged[i].start, lineStart);
      const hlEnd = Math.min(merged[i].end, lineEnd);
      if (hlStart > cursor) segments.push({ text: s.slice(cursor, hlStart), hl: false });
      segments.push({ text: s.slice(hlStart, hlEnd), hl: true });
      cursor = hlEnd;
    }
    if (cursor < lineEnd) segments.push({ text: s.slice(cursor, lineEnd), hl: false });
    if (segments.length === 0) segments.push({ text: line, hl: false });
    result.push(segments);
    lineStart = lineEnd + 1;
  }
  return result;
}
