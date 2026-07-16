// 보기 정렬(왼쪽/가운데/오른쪽/양쪽) 순수 계산 — 블록 배열 in → 블록 배열 out(입력 불변).
// editorEditOps.js와 동일 계층(DOM/transport 비의존). 정렬값은 텍스트 블록의 선택적 align 필드에만 저장한다.
// 대상은 캐럿이 놓인 '텍스트 줄'(임베드 제외) 하나뿐 — 임베드/다른 줄/"(끝)" 마커는 절대 건드리지 않는다.

import { normalizeBlocks, textBlock, isValidAlign } from './editorContent.js';
import { textLineToBlockIndex } from './writerBody.js';

// 상단 메뉴바 '보기' 정렬 메뉴 id → 정렬값.
export const ALIGN_BY_MENU = {
  'view.justify': 'justify',
  'view.alignLeft': 'left',
  'view.alignCenter': 'center',
  'view.alignRight': 'right',
};

// 캐럿 줄(텍스트 줄 인덱스, 임베드 제외)에 align을 설정한 새 blocks와 changed를 반환한다.
// - textLineIndex는 '텍스트 줄' 순번 — writerBody.textLineToBlockIndex로 blocks 인덱스로 환산.
// - 범위 밖(-1)·무효 align·기존 값과 동일 → { blocks: <원본 정규화>, changed: false } no-op.
// - 임베드/다른 텍스트 줄/"(끝)" 마커는 절대 건드리지 않는다(대상 인덱스 하나만 교체).
export function setLineAlign(blocks, textLineIndex, align) {
  const list = normalizeBlocks(blocks);
  if (!isValidAlign(align)) return { blocks: list, changed: false };
  const i = textLineToBlockIndex(list, textLineIndex);
  if (i < 0) return { blocks: list, changed: false };
  if (list[i].align === align) return { blocks: list, changed: false }; // 이미 같은 값 — 불필요 dirty 방지.
  const next = list.slice();
  next[i] = textBlock(list[i].text, align);
  return { blocks: next, changed: true };
}
