// 엔진 중립 정규 스키마 명세 생성기 (phase 75-p2 step0)
//
// 스키마의 단일 진실 공급원은 `src/db/schema.js`의 `createSchema`가 만드는 실제 구조다
// (decisions (3)). `docs/SCHEMA.md`(산문)는 파싱하지 않고, `SCHEMA` const에 export를 추가하지
// 않는다(src/** 무접촉). in-memory SQLite에 `createSchema`를 적용한 뒤 `PRAGMA table_info`로
// (테이블·컬럼 순서·타입·기본값·PK)을 동작에서 파생한다. 값/행 데이터는 다루지 않는다(구조 전용).
//
// CLI:
//   node scripts/db-migrate/schema-spec.mjs           # docs/db-migration/schema-canonical.json 생성(덮어쓰기)
//   node scripts/db-migrate/schema-spec.mjs --check    # 커밋본과 재생성 결과를 비교. 다르면 diff + exit 1

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { createSchema } from '../../src/db/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'docs/db-migration/schema-canonical.json');

// 명세 스키마 자체의 버전 — 명세 형태(필드 구성)가 바뀌면 올린다(스키마 내용 버전이 아니다).
const SPEC_VERSION = 1;

// SQLite affinity 규칙: 선언 타입에 'INT'가 있으면 수치(integer)군, 그 외는 텍스트군.
// 현행 스키마에서 integer군 = PK id들 + ArticleHistory.targetId, 그 외 TEXT/VARCHAR = text군.
function typeClassOf(declaredType) {
  return String(declaredType).toUpperCase().includes('INT') ? 'integer' : 'text';
}

// in-memory DB에 createSchema를 적용하고 PRAGMA로 구조를 읽어 정규 명세 객체를 만든다(순수 파생).
export function buildCanonicalSchema() {
  const db = new DatabaseSync(':memory:');
  try {
    createSchema(db);

    // 테이블은 생성(선언) 순서 = sqlite_master rowid 순서로 읽는다(알파벳 정렬하지 않는다).
    const tableNames = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all()
      .map((r) => r.name);

    const tables = tableNames.map((name) => {
      // PRAGMA table_info는 cid(선언 순서)로 돌려준다.
      const info = db.prepare(`PRAGMA table_info(${name})`).all();

      const columns = info.map((c) => ({
        name: c.name,
        declaredType: c.type,
        typeClass: typeClassOf(c.type),
        notNull: c.notnull === 1,
        defaultValue: c.dflt_value === undefined ? null : c.dflt_value,
        ordinal: c.cid,
      }));

      // PK는 두 경로가 일치해야 한다: (a) pk 플래그가 선 컬럼 (b) 선언 순서 첫 컬럼(cid 0).
      const pkCols = info.filter((c) => c.pk > 0);
      if (pkCols.length !== 1) {
        throw new Error(
          `${name}: 단일 PK를 기대했으나 ${pkCols.length}개 (복합/무 PK는 현행 스키마에 없다)`,
        );
      }
      const first = info.find((c) => c.cid === 0);
      if (pkCols[0].name !== first.name) {
        throw new Error(
          `${name}: PK(${pkCols[0].name})가 첫 컬럼(${first.name})과 다르다 — 명세 계약 위반`,
        );
      }

      // 보조 인덱스·FK 없음(PK 자동 인덱스만). 명시적 인덱스(sql IS NOT NULL)가 늘면 구조 신호다.
      const explicitIndexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name",
        )
        .all(name)
        .map((r) => r.name);

      return {
        name,
        primaryKey: pkCols[0].name,
        columns,
        indexes: explicitIndexes,
      };
    });

    return {
      version: SPEC_VERSION,
      generatedFrom: 'src/db/schema.js',
      tables,
    };
  } finally {
    db.close();
  }
}

// 결정적 직렬화: 객체 키는 안정 정렬, 배열 순서는 보존(컬럼/테이블 순서 = 선언 순서), 2-space, 후행 개행.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

export function serializeCanonicalSchema(spec) {
  return `${JSON.stringify(sortKeysDeep(spec), null, 2)}\n`;
}

// 최소 라인 단위 diff(첫 불일치 지점 몇 줄) — 인자 파싱은 직접 짠다(baseline: 새 의존성 0).
function firstDiff(expected, actual) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i += 1) {
    if (e[i] !== a[i]) {
      return `line ${i + 1}:\n  committed:    ${JSON.stringify(e[i])}\n  regenerated:  ${JSON.stringify(a[i])}`;
    }
  }
  return '';
}

function main(argv) {
  const check = argv.includes('--check');
  const regenerated = serializeCanonicalSchema(buildCanonicalSchema());

  if (check) {
    if (!existsSync(OUTPUT_PATH)) {
      process.stderr.write(`[schema-spec] 정본 파일이 없습니다: ${OUTPUT_PATH}\n`);
      process.exit(1);
    }
    const committed = readFileSync(OUTPUT_PATH, 'utf8');
    if (committed !== regenerated) {
      process.stderr.write('[schema-spec] 스키마 드리프트: 커밋본 != 재생성 결과\n');
      process.stderr.write(`${firstDiff(committed, regenerated)}\n`);
      process.exit(1);
    }
    process.stdout.write('[schema-spec] OK — 커밋본 == 재생성 결과\n');
    return;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, regenerated, 'utf8');
  process.stdout.write(`[schema-spec] wrote ${OUTPUT_PATH}\n`);
}

// CLI 진입점(직접 실행 시에만). import 시에는 부작용 없음(build/serialize는 순수).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
