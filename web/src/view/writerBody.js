// 작성 페이지 본문(markupVersion) 편집 헬퍼 — transport 비의존 순수 함수.
// 에디터에서 타이핑된 텍스트와 기존 임베드를 합쳐 정규 순서(본문 텍스트 → 임베드 → "(끝)")로 직렬화한다.
// 이미지/영상/글기사 검색 결과를 본문에 임베드로 덧붙이는 것도 같은 정규 순서를 유지한다.

import {
  deserialize, serialize, textBlock,
  blocksToText, END_MARKER,
} from './editorContent.js';

// 본문 문자열에서 첫 줄(=제목)을 도출한다(블록 → 텍스트 → 첫 줄).
export function bodyTitle(body) {
  const text = blocksToText(deserialize(body));
  return (text.split('\n')[0] ?? '').trim();
}

// 에디터가 읽어 보낸 블록(텍스트 + 임베드)을 본문 문자열로 직렬화한다.
// 임베드는 커서/DOM 순서를 그대로 보존하고(news.md 156·167행), "(끝)" 마커만 항상 최종 블록으로 보낸다(news.md 159행).
// 마커 재생성 시 정렬(align)은 승계한다(문서 순서상 첫 마커 — editorEditOps.sortDocument와 동일 규칙).
export function serializeBodyFromBlocks(blocks) {
  const list = deserialize(blocks); // 배열/문자열/객체 모두 정규화
  const isEnd = (b) => b.type === 'text' && String(b.text).trim() === END_MARKER;
  const prevMarker = list.find(isEnd);
  const rest = list.filter((b) => !isEnd(b));
  if (prevMarker) rest.push(textBlock(END_MARKER, prevMarker.align));
  return serialize(rest);
}

// 텍스트 줄 인덱스(0-base, 임베드 제외) → blocks 배열 인덱스.
// WriterPage(onKeyDown 라인 삭제)와 insertEmbedAfterLine이 공유한다(텍스트 블록만 센다 — Editor의 textLine 카운팅과 같은 규칙).
// null/음수/범위 밖이면 -1을 반환한다(count는 0부터 증가하므로 그런 값과는 절대 일치하지 않는다).
export function textLineToBlockIndex(blocks, textLineIndex) {
  let count = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i] && blocks[i].type === 'text') {
      count += 1;
      if (count === textLineIndex) return i;
    }
  }
  return -1;
}

// 임베드를 textLineIndex 텍스트 줄의 블록 "뒤"에 삽입하고, 임베드 뒤에 빈 텍스트 줄을 넣는다(커서를 그 빈 줄로 보낼 수 있게 — news.md 156행).
// "(끝)"은 항상 최종 블록으로 유지하고(serializeBodyFromBlocks 규칙), 빈 줄은 "(끝)" 앞에 둔다. 기존 블록 순서는 재배치하지 않는다.
// textLineIndex가 null/음수/범위 밖이면 끝("(끝)" 앞)에 임베드 + 빈 줄을 추가하는 폴백.
// 반환: { body: <직렬화 문자열>, caretTextLine: <새 빈 줄의 텍스트-줄 인덱스 | null> }.
export function insertEmbedAfterLine(currentBody, embed, textLineIndex) {
  if (!embed) return { body: currentBody, caretTextLine: null };
  const blocks = deserialize(currentBody);
  const blockIndex = textLineToBlockIndex(blocks, textLineIndex);
  const emptyLine = textBlock('');
  const next = blocks.slice();
  if (blockIndex < 0) {
    next.push(embed, emptyLine); // 폴백: 끝에 임베드 + 빈 줄(아래 정규화로 "(끝)"은 다시 최종으로).
  } else {
    next.splice(blockIndex + 1, 0, embed, emptyLine); // 지정 텍스트 줄 블록 다음에 임베드 + 빈 줄.
  }
  // "(끝)"을 최종 블록으로 정규화(serializeBodyFromBlocks와 동일 규칙)한 블록 순서를 직접 만들어, 그 위에서 빈 줄의 텍스트-줄 인덱스를 센다.
  // 마커 재생성 시 정렬(align)은 승계한다(문서 순서상 첫 마커).
  const isEnd = (b) => b.type === 'text' && String(b.text).trim() === END_MARKER;
  const prevMarker = next.find(isEnd);
  const ordered = next.filter((b) => !isEnd(b));
  if (prevMarker) ordered.push(textBlock(END_MARKER, prevMarker.align));
  let caretTextLine = null;
  let count = -1;
  for (const b of ordered) {
    if (b.type === 'text') {
      count += 1;
      if (b === emptyLine) { caretTextLine = count; break; }
    }
  }
  return { body: serialize(ordered), caretTextLine };
}

// 검색 결과 임베드를 본문에 덧붙인다(텍스트 뒤, "(끝)" 앞). embed가 없으면 본문 그대로.
export function appendEmbedToBody(currentBody, embed) {
  if (!embed) return currentBody;
  const blocks = deserialize(currentBody);
  const endIdx = blocks.findIndex((b) => b.type === 'text' && String(b.text).trim() === END_MARKER);
  if (endIdx >= 0) {
    const next = blocks.slice();
    next.splice(endIdx, 0, embed); // "(끝)" 앞에 삽입.
    return serialize(next);
  }
  return serialize([...blocks, embed]);
}
