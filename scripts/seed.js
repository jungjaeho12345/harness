// 시드 러너 — 루트 news.db를 열고 스키마를 보장한 뒤 샘플 사용자를 채운다(직접 실행 전용).
// 비파괴: createSchema는 additive 멱등 마이그레이션만, seedUsers는 없는 계정만 insert한다.
// 실행: npm run seed

import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { seedUsers } from '../src/db/seed.js';

const db = new DatabaseSync('news.db');
createSchema(db);
const inserted = seedUsers(db);

if (inserted.length) {
  console.log(`Seeded ${inserted.length} user(s): ${inserted.join(', ')}`);
} else {
  console.log('Sample users already present — nothing inserted (idempotent).');
}
