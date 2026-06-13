import { describe, it, expect } from 'vitest';
import { submitButtons, SUBMIT_LABELS } from './writerButtons.js';

const roles = ['R', 'D', 'Z'];

describe('submitButtons — 권한×상태×진입 진리표', () => {
  it('신규(미저장, articleId 없음): 권한 무관 송고·보류만(KILL 숨김)', () => {
    for (const role of roles) {
      expect(submitButtons({ mode: 'new', status: null, role, articleId: null }))
        .toEqual(['send', 'hold']);
    }
  });

  it('RDS(편집): R·D·Z 모두 송고·보류·KILL', () => {
    for (const role of roles) {
      expect(submitButtons({ mode: 'edit', status: 'RDS', role, articleId: 'AKR1' }))
        .toEqual(['send', 'hold', 'kill']);
    }
  });

  it('DDH(편집): D·Z는 송고·KILL(보류 없음), R은 없음', () => {
    expect(submitButtons({ mode: 'edit', status: 'DDH', role: 'D', articleId: 'AKR1' }))
      .toEqual(['send', 'kill']);
    expect(submitButtons({ mode: 'edit', status: 'DDH', role: 'Z', articleId: 'AKR1' }))
      .toEqual(['send', 'kill']);
    expect(submitButtons({ mode: 'edit', status: 'DDH', role: 'R', articleId: 'AKR1' }))
      .toEqual([]);
  });

  it('DPS 고침/포털고침 진입: D만 송고·보류(KILL 없음), 그 외 없음', () => {
    expect(submitButtons({ mode: 'revise', status: 'DPS', role: 'D', articleId: 'AKR1' }))
      .toEqual(['send', 'hold']);
    expect(submitButtons({ mode: 'portalRevise', status: 'DPS', role: 'D', articleId: 'AKR1' }))
      .toEqual(['send', 'hold']);
    expect(submitButtons({ mode: 'portalRevise', status: 'DPS', role: 'Z', articleId: 'AKR1' }))
      .toEqual([]);
    expect(submitButtons({ mode: 'revise', status: 'DPS', role: 'R', articleId: 'AKR1' }))
      .toEqual([]);
  });

  it('표/규칙에 없는 (상태,권한,진입) 조합은 버튼 없음', () => {
    // DPS를 일반 편집(edit)로 진입 — 규칙 외.
    expect(submitButtons({ mode: 'edit', status: 'DPS', role: 'D', articleId: 'AKR1' })).toEqual([]);
    // 터미널 상태(RRK 등) 편집 — 규칙 외.
    expect(submitButtons({ mode: 'edit', status: 'RRK', role: 'R', articleId: 'AKR1' })).toEqual([]);
  });

  it('항상 송고→보류→KILL 순서로 거른다', () => {
    expect(SUBMIT_LABELS).toEqual({ send: '송고', hold: '보류', kill: 'KILL' });
  });
});
