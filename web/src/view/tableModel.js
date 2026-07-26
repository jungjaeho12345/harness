// 표(table) 임베드 순수 데이터 모델·그리드 변환(단일 출처) — news.md 표 메뉴 10종의 데이터 레이어.
// 표는 embedType:'table' 임베드 블록으로, payload는 2차원 문자열 배열(rows[행][셀])이다.
// 직렬화는 editorContent(embedBlock/serialize/deserialize)를 그대로 재사용한다 — 이 모듈은 순수 로직만.
// 셀 값은 원본 문자열만 보관한다(HTML 이스케이프는 렌더 레이어 책임 — 이중 이스케이프 방지).

import { embedBlock, isEmbedBlock } from './editorContent.js';

export const TABLE_EMBED_TYPE = 'table';

function coerceCell(cell) {
  if (cell === null || cell === undefined) return '';
  return String(cell);
}

// rows를 '직사각형 2차원 문자열 배열'로 정규화한다(방어적 단일 출처).
// 배열 아님/빈 배열 → []. 행이 배열 아니면 빈 행. 셀은 문자열 강제, 열 수는 최대 열 수로 패딩(ragged 방지).
export function normalizeTableRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const cols = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  return rows.map((row) => {
    const cells = Array.isArray(row) ? row : [];
    return Array.from({ length: cols }, (_, c) => coerceCell(cells[c]));
  });
}

// r행 × c열의 빈 문자열 그리드(표 삽입 기본 그리드). r, c는 1 이상으로 클램프.
export function makeEmptyTableRows(r, c) {
  const rowCount = Math.max(1, Math.trunc(Number(r) || 0));
  const colCount = Math.max(1, Math.trunc(Number(c) || 0));
  return Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => ''));
}

// 표 임베드 팩토리 — 다른 make*Embed와 동형(부적격 입력이면 null → insertEmbed no-op).
export function makeTableEmbed(rows) {
  const normalized = normalizeTableRows(rows);
  if (normalized.length === 0 || normalized[0].length === 0) return null;
  return embedBlock({ embedType: TABLE_EMBED_TYPE, rows: normalized });
}

export function isTableEmbed(block) {
  return isEmbedBlock(block) && block.embedType === TABLE_EMBED_TYPE;
}

// --- 그리드 순수 변환: 입력을 변형하지 않고 새 배열 반환. 항상 정규화를 먼저 적용해 직사각형 보장. ---

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// index 위치에 빈 행 삽입(열 수는 기존 열 수, 표가 비면 1열). 범위 밖 index는 [0, 행수]로 클램프.
export function insertRow(rows, index) {
  const grid = normalizeTableRows(rows);
  const cols = grid.length === 0 ? 1 : grid[0].length;
  const at = clamp(index, 0, grid.length);
  const next = grid.slice();
  next.splice(at, 0, Array.from({ length: cols }, () => ''));
  return next;
}

// 모든 행의 index 위치에 빈 셀 삽입. 범위 밖 index는 [0, 열수]로 클램프.
export function insertCol(rows, index) {
  const grid = normalizeTableRows(rows);
  const cols = grid.length === 0 ? 0 : grid[0].length;
  const at = clamp(index, 0, cols);
  return grid.map((row) => [...row.slice(0, at), '', ...row.slice(at)]);
}

// index 행 삭제. 행이 1개 이하면 삭제하지 않고 정규화 그리드 반환(최소 1행 유지 — 0×N 표 방지, 반환 계약은 정규화로 통일).
export function deleteRow(rows, index) {
  const grid = normalizeTableRows(rows);
  if (grid.length <= 1) return grid;
  const at = clamp(index, 0, grid.length - 1);
  return grid.filter((_, r) => r !== at);
}

// 모든 행의 index 열 삭제. 열이 1개 이하면 삭제하지 않고 정규화 그리드 반환(최소 1열 유지 — N×0 표 방지, 반환 계약은 정규화로 통일).
export function deleteCol(rows, index) {
  const grid = normalizeTableRows(rows);
  const cols = grid.length === 0 ? 0 : grid[0].length;
  if (cols <= 1) return grid;
  const at = clamp(index, 0, cols - 1);
  return grid.map((row) => row.filter((_, c) => c !== at));
}

// (r,c) 셀을 문자열로 교체. 범위 밖이면 원본 반환.
export function setCell(rows, r, c, value) {
  const grid = normalizeTableRows(rows);
  if (r < 0 || r >= grid.length || c < 0 || c >= (grid[0]?.length ?? 0)) return rows;
  return grid.map((row, ri) => (ri === r ? row.map((cell, ci) => (ci === c ? coerceCell(value) : cell)) : row));
}

// 표 → 탭 구분 텍스트(TSV) — 표 복사/잘라내기의 클립보드 표현(클립보드 I/O는 WriterPage step3 책임).
// 셀 안의 개행/탭은 공백으로 치환해 구분자 파괴를 막는다.
export function tableToTsv(rows) {
  return normalizeTableRows(rows)
    .map((row) => row.map((cell) => cell.replace(/[\t\r\n]/g, ' ')).join('\t'))
    .join('\n');
}

// 메뉴 표 연산의 '대상 표' 블록 인덱스를 캐럿 인접으로 도출한다.
// fromBlockIndex는 blocks 배열 인덱스다(writerBody.textLineToBlockIndex가 산출하는 좌표계 — 변환은 Step 3 책임).
// 규칙: fromBlockIndex부터 (1) 뒤로 가장 가까운 표 → (2) 앞으로 가장 가까운 표.
//       null/범위 밖이면 (3) 마지막 표. 표가 없으면 -1.
export function findTargetTableIndex(blocks, fromBlockIndex) {
  const list = Array.isArray(blocks) ? blocks : [];
  const inRange = Number.isInteger(fromBlockIndex) && fromBlockIndex >= 0 && fromBlockIndex < list.length;
  if (inRange) {
    for (let i = fromBlockIndex; i < list.length; i += 1) if (isTableEmbed(list[i])) return i;
    for (let i = fromBlockIndex - 1; i >= 0; i -= 1) if (isTableEmbed(list[i])) return i;
    return -1;
  }
  for (let i = list.length - 1; i >= 0; i -= 1) if (isTableEmbed(list[i])) return i;
  return -1;
}
