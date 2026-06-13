// 샘플 사용자 시드 — 개발/데모용 R/D/Z 계정을 1회 채운다 (HTTP 비의존, db 주입형).
// CRITICAL: 멱등하다 — 이미 있는 계정은 건드리지 않고 skip한다(삭제/덮어쓰기 없음, DB 비파괴 — CLAUDE.md/ADR).
// 비밀번호는 bcrypt 해시로 저장한다(평문 보관 금지). 실제 news.db 부트스트랩은 scripts/seed.js 러너가 한다.

import bcrypt from 'bcryptjs';
import { createUserModel } from '../models/userModel.js';

// 개발/데모용 기본 계정. 비밀번호는 평문(시드 시점에만)이며 저장은 해시로 한다.
export const SAMPLE_USERS = [
  { userId: 'reporter', name: '김기자', password: 'reporter123', role: 'R', department: '사회부', departmentCode: 'SOC' },
  { userId: 'desk', name: '박데스크', password: 'desk123', role: 'D', department: '편집부', departmentCode: 'EDT' },
  { userId: 'admin', name: '관리자', password: 'admin123', role: 'Z', department: '운영부', departmentCode: 'ADM' },
];

// 없는 계정만 insert하고 새로 넣은 userId 목록을 반환한다(2회 실행 시 두 번째는 빈 배열).
export function seedUsers(db) {
  const userModel = createUserModel(db);
  const inserted = [];
  for (const { password, ...rest } of SAMPLE_USERS) {
    if (userModel.findById(rest.userId)) continue; // 이미 존재 → 멱등 skip(덮어쓰지 않음).
    userModel.insert({
      ...rest,
      password: bcrypt.hashSync(password, 10),
      active: 'Y',
    });
    inserted.push(rest.userId);
  }
  return inserted;
}
