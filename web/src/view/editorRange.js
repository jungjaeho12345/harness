// 에디터 편집 범위 계산 — 단어(\S 런)/문단(빈 줄 경계) 경계. 순수 함수(DOM/transport 비의존).
// 문단 정의는 editorStats.paragraphIndex와 동일하다(빈 줄 '' 이 경계, 공백만 있는 줄은 비-빈 줄).
// 소비 측(선택/삭제/정렬)이 문자열/줄 배열을 넘긴다 — 이 계층은 blocksToText/serialize를 부르지 않는다.

// 한 줄 문자열에서 column(0-base, 줄-로컬 캐럿) 위치의 단어(연속 \S 런) 경계 { start, end }(end 배타).
// 캐럿이 단어 내부(양 끝 경계 포함)면 그 단어, 공백 위면 왼쪽으로 가장 가까운 단어,
// 왼쪽에 단어가 없으면 오른쪽 단어, 어느 쪽에도 없으면 start === end(빈 범위 = no-op 신호).
export function wordBoundsAt(lineText, column) {
  const s = String(lineText ?? '');
  const col = Math.max(0, Math.min(Math.trunc(Number(column)) || 0, s.length));
  const isWord = (ch) => ch != null && /\S/.test(ch);
  let anchor = -1;
  if (isWord(s[col])) {
    anchor = col;
  } else {
    for (let k = col - 1; k >= 0; k -= 1) {
      if (isWord(s[k])) {
        anchor = k;
        break;
      }
    }
    if (anchor === -1) {
      for (let k = col + 1; k < s.length; k += 1) {
        if (isWord(s[k])) {
          anchor = k;
          break;
        }
      }
    }
  }
  if (anchor === -1) return { start: col, end: col };
  let start = anchor;
  let end = anchor + 1;
  while (start > 0 && isWord(s[start - 1])) start -= 1;
  while (end < s.length && isWord(s[end])) end += 1;
  return { start, end };
}

// 줄 배열에서 lineIndex가 속한 문단의 줄 인덱스 범위 { startLine, endLine }(둘 다 포함).
// 비-빈 줄이면 위/아래로 연속된 비-빈 줄까지 확장, 빈 줄이면 그 빈 줄 하나.
// lineIndex는 [0, length-1]로 clamp한다(범위 밖 방어, 예외 없음).
export function paragraphBoundsAt(linesArr, lineIndex) {
  const arr = Array.isArray(linesArr) ? linesArr : [String(linesArr ?? '')];
  if (arr.length === 0) return { startLine: 0, endLine: 0 };
  const i = Math.max(0, Math.min(Math.trunc(Number(lineIndex)) || 0, arr.length - 1));
  if (arr[i] === '') return { startLine: i, endLine: i };
  let startLine = i;
  let endLine = i;
  while (startLine > 0 && arr[startLine - 1] !== '') startLine -= 1;
  while (endLine < arr.length - 1 && arr[endLine + 1] !== '') endLine += 1;
  return { startLine, endLine };
}
