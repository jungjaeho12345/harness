// 사진DB 서비스 — 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입(photoModel).
// 등록(register)은 append-only — 삭제/수정 경로를 두지 않는다(DB 비파괴).
// src 검증은 sanitizeFileRef(fileRef.js — 첨부/자료 파일과 같은 단일 출처)로 한다:
// 등록된 src는 재임베드로 발행 HTML까지 흐르므로 /uploads 상대경로·https:// 만 저장한다.

import { sanitizeFileRef } from './fileRef.js';

function nowISO() {
  return new Date().toISOString();
}

export function createPhotoService({ photoModel }) {
  // 등록 — registeredBy는 인자 userId(검증된 세션에서 도출)로만 채운다.
  // dto.registeredBy가 있어도 무시한다(ADR-004 — 클라이언트가 보낸 신원은 신뢰하지 않는다).
  function register(dto = {}, { userId } = {}) {
    const src = sanitizeFileRef(dto.src ?? '');
    if (src === '') return { ok: false, reason: 'invalid-src' };
    const id = photoModel.insert({
      src,
      caption: dto.caption ?? '',
      sourceArticleId: dto.sourceArticleId ?? '',
      registeredBy: userId ?? null,
      createdAt: nowISO(),
    });
    return { ok: true, id };
  }

  // 캡션 검색 — 얇은 위임(도메인 규칙 없음).
  function search(q = '') {
    return photoModel.searchByCaption(q);
  }

  return { register, search };
}
