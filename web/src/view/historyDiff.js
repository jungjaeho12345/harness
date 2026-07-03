// 기사 이력 비교(도구>기사이력비교)의 라인 diff 순수 계산 모듈 — LCS(최장 공통 부분수열) 직접 구현.
// CRITICAL: 외부 diff 라이브러리 금지(철학 — 외부 의존성 최소화). 순수·결정적 — Date/Math.random/DOM/fetch 없음.
// 스냅샷 본문(markupVersion) → 비교용 텍스트 변환은 editorContent의 deserialize/blocksToText를 쓴다(이 모듈은 텍스트만 받는다).
// UI 다이얼로그(HistoryCompareDialog)·결선(WriterPage)은 이 모듈이 하지 않는다. editorFind.js 패턴을 따른다.

// 텍스트 → 라인 배열. null/undefined/빈 문자열은 라인 0개로 취급한다(''.split은 ['']라 빈 입력을 특별 처리).
function toLines(text) {
  const s = String(text ?? '');
  return s === '' ? [] : s.split('\n');
}

// 두 본문 텍스트(개행 구분 라인들)의 라인 단위 diff.
// 반환: 순서 보존 세그먼트 배열 — { type: 'equal'|'del'|'add', text, aIndex?, bIndex? }.
//   equal: 양쪽 공통 라인(aIndex/bIndex 모두), del: a(이전)에만 있는 라인(aIndex), add: b(이후)에만 있는 라인(bIndex).
// 표준 동적계획 LCS(suffix 테이블) 후 앞에서부터 역추적한다. 동률이면 del을 먼저 낸다(결정적).
export function diffLines(aText, bText) {
  const aLines = toLines(aText);
  const bLines = toLines(bText);
  const n = aLines.length;
  const m = bLines.length;

  // lcs[i][j] = aLines[i..]와 bLines[j..]의 LCS 길이.
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = aLines[i] === bLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const segments = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      segments.push({ type: 'equal', text: aLines[i], aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      segments.push({ type: 'del', text: aLines[i], aIndex: i });
      i += 1;
    } else {
      segments.push({ type: 'add', text: bLines[j], bIndex: j });
      j += 1;
    }
  }
  while (i < n) {
    segments.push({ type: 'del', text: aLines[i], aIndex: i });
    i += 1;
  }
  while (j < m) {
    segments.push({ type: 'add', text: bLines[j], bIndex: j });
    j += 1;
  }
  return segments;
}
