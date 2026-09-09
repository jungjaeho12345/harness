// 운영 적재 리허설의 순수 판정부 (phase 76 step8).
//
// 왜 별도 모듈인가: scripts/load-rehearsal.mjs 는 CLI 로 즉시 돌아 자식(마이그레이터·Node 서버)을 띄우므로 그 안의
// 함수를 가져다 시험할 수 없다(spring-contract.mjs·spool-parity.mjs 와 같은 이유). 여기 있는 것은 **부산물 판정 ·
// verify 출력 읽기 · 규모 산술 · 지문 무변 판정** 넷뿐이고, 넷 다 틀리면 "리허설이 돌았는데 아무것도 재지 않은"
// 상태가 조용히 green 으로 남는다. 잠금은 scripts/lib/loadRehearsal.self-test.mjs 가 한다.
// 부수효과(spawn·fs·env)는 여기 두지 않는다 — 전부 호출자의 몫이다(존재 확인도 함수를 주입받는다).

/**
 * SQLite 가 쓰기 경로에서 남기는 부산물. 마이그레이터(SourceFingerprint)와 **같은 목록**이어야 한다 —
 * 하나라도 빠지면 "다른 프로세스가 쓰는 중인 사본"으로 리허설이 돌고, 그 사본은 원본과 같지 않다.
 */
export const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];

/** 사본 옆에 실제로 있는 부산물 경로들(존재 확인 함수는 주입받는다). */
export function sidecarsOf(dbPath, exists) {
  return SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`).filter((path) => exists(path));
}

// verify 리포트의 한 줄: `User                 소스    37행 · 대상    37행 · 컬럼 10 · 불일치 0`
const TABLE_LINE = /^(\S+)\s+소스\s+(\d+)행\s+·\s+대상\s+(\d+)행\s+·\s+컬럼\s+(\d+)\s+·\s+불일치\s+(\d+)\s*$/;
const VERDICT_LINE = /^판정:\s*(\S+)\s*$/;
// 헤더 총계는 표 줄과 **같은 값에서** 나온다(RowVerifier.java:168 — 테이블 수 = tables().size() · 소스/대상 총합 = 표 줄의 합).
// 그래서 둘을 교차 검사하면 "표 줄만 형식이 바뀐" 경우를 산술로 잡을 수 있다.
const TOTALS_LINE = /^대조 테이블 수:\s*(\d+)\s*·\s*소스 총\s*(\d+)행\s*·\s*대상 총\s*(\d+)행\s*$/;
const EXCLUDED_LINE = /^제외\(대조 대상 아님\):\s*(.+?)\s*$/;
const STRUCTURAL_HEAD = '구조 문제';
const DIFF_HEAD = '불일치';

/**
 * `news-migrator verify` 의 사람이 읽는 출력을 표로 읽는다.
 *
 * **판정 줄이 없으면 일치로 읽지 않는다**(`verdict: null` · `matched: false`) — 출력 형식이 바뀌거나 명령이
 * 조기 종료했을 때 파서가 조용히 "문제 0"을 내면 그 리허설은 아무것도 재지 않은 것이 된다.
 * 같은 이유로 **헤더 총계와 표 줄을 교차 검사**한다(`parseIncomplete`): 표 줄 형식만 바뀌면 판정·헤더는 그대로
 * 읽히고 `tables` 만 비므로 `불일치 0`·`구조 0`이 **자동으로 참**이 된다 — 그러면 리허설이 green 으로 끝나는데
 * 규모 수치(테이블·행·컬럼·셀)는 전부 0이다. 어긋나면 `matched` 도 false 다(호출자가 잊어도 걸린다).
 * 값 원문은 어차피 리포트에 실리지 않는다(도구가 길이만 싣는다) — 여기서도 수치만 다룬다.
 */
export function parseVerifyReport(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const tables = [];
  const structural = [];
  let verdict = null;
  let tableCount = null;
  let sourceRows = null;
  let targetRows = null;
  let excluded = [];
  let section = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const verdictMatch = VERDICT_LINE.exec(line);
    if (verdictMatch) { verdict = verdictMatch[1]; continue; }
    const totals = TOTALS_LINE.exec(line);
    if (totals) {
      tableCount = Number(totals[1]);
      sourceRows = Number(totals[2]);
      targetRows = Number(totals[3]);
      continue;
    }
    const excludedMatch = EXCLUDED_LINE.exec(line);
    if (excludedMatch) {
      excluded = excludedMatch[1] === '없음' ? [] : excludedMatch[1].split(',').map((name) => name.trim());
      continue;
    }
    if (line.startsWith(STRUCTURAL_HEAD)) { section = 'structural'; continue; }
    if (line.startsWith(DIFF_HEAD)) { section = 'diff'; continue; }
    const table = TABLE_LINE.exec(line);
    if (table) {
      tables.push({
        table: table[1], sourceRows: Number(table[2]), targetRows: Number(table[3]),
        columns: Number(table[4]), diffs: Number(table[5]),
      });
      continue;
    }
    if (section === 'structural' && line.trim().startsWith('- ')) structural.push(line.trim().slice(2));
  }
  const diffs = tables.reduce((sum, table) => sum + table.diffs, 0);
  const parseIncomplete = crossCheckTotals({ verdict, tableCount, sourceRows, targetRows, tables });
  return {
    verdict, matched: verdict === '일치' && parseIncomplete.length === 0,
    tableCount, sourceRows, targetRows, excluded, tables, structural, diffs, parseIncomplete,
  };
}

/**
 * 헤더 총계 ↔ 표 줄 교차 검사. 어긋나는 이유는 하나뿐이다 — **출력 형식이 바뀌어 표 줄을 못 읽었다**
 * (마이그레이터는 같은 목록에서 둘을 찍는다). 사람이 읽을 사유 문자열을 돌려준다(수치만 싣는다).
 */
function crossCheckTotals({ verdict, tableCount, sourceRows, targetRows, tables }) {
  const problems = [];
  if (verdict === null) return problems; // 판정 줄부터 없다 — 이미 matched:false 이고 사유가 중복된다
  if (tableCount === null) {
    problems.push('총계 줄(대조 테이블 수: … · 소스 총 …행)을 읽지 못했다 — verify 출력 형식이 바뀌었는가');
    return problems;
  }
  if (tables.length !== tableCount) {
    problems.push(`표 줄을 ${tables.length}개 읽었는데 헤더는 ${tableCount}개라고 한다 — 표 줄 형식이 바뀌었는가`);
  }
  const sumSource = tables.reduce((sum, table) => sum + table.sourceRows, 0);
  const sumTarget = tables.reduce((sum, table) => sum + table.targetRows, 0);
  if (sourceRows !== null && sumSource !== sourceRows) {
    problems.push(`표 줄의 소스 행 합 ${sumSource} 이 헤더 총계 ${sourceRows} 과 다르다`);
  }
  if (targetRows !== null && sumTarget !== targetRows) {
    problems.push(`표 줄의 대상 행 합 ${sumTarget} 이 헤더 총계 ${targetRows} 과 다르다`);
  }
  return problems;
}

/** 셀 수 = Σ(소스 행 × 컬럼). 행만 세면 컬럼 결손이 규모 기록에 보이지 않는다. */
export function cellsOf(tables) {
  return (tables ?? []).reduce((sum, table) => sum + table.sourceRows * table.columns, 0);
}

/** 규모 한 줄 요약 — 테이블·행·컬럼·셀. */
export function totalsOf(tables) {
  const list = tables ?? [];
  return {
    tables: list.length,
    rows: list.reduce((sum, table) => sum + table.sourceRows, 0),
    columns: list.reduce((sum, table) => sum + table.columns, 0),
    cells: cellsOf(list),
  };
}

/**
 * 파일 지문(크기·md5)의 무변 판정. 어느 한쪽이 없어도 문제다 — "재지 못했다"를 "같다"로 읽지 않는다.
 * 값(md5·크기)은 비밀이 아니므로 메시지에 싣는다.
 */
export function digestProblems(label, before, after) {
  if (!before || !after) {
    return [`${label}: 지문을 재지 못했다(before=${JSON.stringify(before)} after=${JSON.stringify(after)})`];
  }
  if (before.size !== after.size || before.md5 !== after.md5) {
    return [`${label}이 변했다: before=${before.size}B/${before.md5} after=${after.size}B/${after.md5}`];
  }
  return [];
}
