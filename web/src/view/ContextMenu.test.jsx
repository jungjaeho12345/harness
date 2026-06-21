import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextMenu, buildContextMenuItems } from './ContextMenu.jsx';

const keys = (items) => items.map((i) => i.key);
const find = (items, key) => items.find((i) => i.key === key);

describe('buildContextMenuItems — per-menu items', () => {
  it('desk-unsent: 편집/상세보기/이력보기/본문복사/제목만복사', () => {
    const items = buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'D' });
    expect(keys(items)).toEqual(['edit', 'detail', 'history', 'copyBody', 'copyTitle']);
    expect(find(items, 'history').enabled).toBe(true); // step8: 이력보기 활성
    expect(find(items, 'edit').enabled).toBe(true);
  });

  it('dept-write/personal: full inactive + revise/delete items, no 편집', () => {
    const items = buildContextMenuItems('deptWrite', { status: 'RDS' }, { role: 'R' });
    expect(keys(items)).toContain('reviseNoPortal');
    expect(keys(items)).toContain('requestDelete');
    expect(keys(items)).not.toContain('edit');
  });

  it('dept-send adds an 편집 item', () => {
    const items = buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'D' });
    expect(keys(items)).toContain('edit');
  });

  it('데스크 미송고 편집은 D(데스크)/Z(관리자)만 활성이다', () => {
    // D/Z → 활성.
    expect(find(buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'D' }), 'edit').enabled).toBe(true);
    expect(find(buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'Z' }), 'edit').enabled).toBe(true);
    // R(기자)·권한 미정의 → 비활성(항목은 노출하되 disabled).
    expect(find(buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'R' }), 'edit').enabled).toBe(false);
    expect(find(buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: undefined }), 'edit').enabled).toBe(false);
  });

  it('매핑(mapping)은 세션만 있으면 활성이다 (step11)', () => {
    // 권한/상태 게이트 없음 — 서버가 세션 인증·잠금 게이트. 부서별 작성/송고·개인별 수정에서 모두 활성.
    for (const menu of ['deptWrite', 'deptSend', 'personal']) {
      for (const role of ['R', 'D', 'Z']) {
        const items = buildContextMenuItems(menu, { status: 'RDS' }, { role });
        expect(find(items, 'mapping').enabled).toBe(true);
      }
    }
    // 데스크 미송고 메뉴에는 매핑이 노출되지 않는다(news.md 85행 — 부서별 작성/송고·개인별 수정만).
    expect(keys(buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'D' }))).not.toContain('mapping');
  });

  it('번역(translate)은 세션만 있으면 활성이다 (step10)', () => {
    // 권한/상태 게이트 없음 — 서버가 세션 인증 게이트. 부서별 작성/송고·개인별 수정에서 모두 활성.
    for (const menu of ['deptWrite', 'deptSend', 'personal']) {
      for (const role of ['R', 'D', 'Z']) {
        const items = buildContextMenuItems(menu, { status: 'RDS' }, { role });
        expect(find(items, 'translate').enabled).toBe(true);
      }
    }
  });

  it('후속/계속기사작성은 작성 권한(R/D/Z)에서 활성이다 (step9)', () => {
    for (const role of ['R', 'D', 'Z']) {
      const items = buildContextMenuItems('deptWrite', { status: 'RDS' }, { role });
      expect(find(items, 'followUp').enabled).toBe(true);
      expect(find(items, 'continue').enabled).toBe(true);
    }
    // 권한 미정의(예: 빈 role)면 비활성.
    const none = buildContextMenuItems('deptWrite', { status: 'RDS' }, { role: undefined });
    expect(find(none, 'followUp').enabled).toBe(false);
    expect(find(none, 'continue').enabled).toBe(false);
  });

  it('재송(resend)은 DPS + D/Z에서만 활성이다 (step9)', () => {
    // DPS + D/Z → 활성.
    expect(find(buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'D' }), 'resend').enabled).toBe(true);
    expect(find(buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'Z' }), 'resend').enabled).toBe(true);
    // DPS지만 R 권한 → 비활성.
    expect(find(buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'R' }), 'resend').enabled).toBe(false);
    // 비-DPS(RDS) + D → 비활성.
    expect(find(buildContextMenuItems('deptWrite', { status: 'RDS' }, { role: 'D' }), 'resend').enabled).toBe(false);
  });

  it('이력보기/송고이력보기는 활성이다 (step8)', () => {
    // 데스크 미송고: 이력보기만 활성(송고이력보기 항목 없음).
    const desk = buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'R' });
    expect(find(desk, 'history').enabled).toBe(true);
    expect(keys(desk)).not.toContain('sendHistory');

    // 부서별 작성/송고·개인별 수정: 이력보기·송고이력보기 둘 다 활성(권한/상태 무관).
    for (const menu of ['deptWrite', 'deptSend', 'personal']) {
      const items = buildContextMenuItems(menu, { status: 'RDS' }, { role: 'R' });
      expect(find(items, 'history').enabled).toBe(true);
      expect(find(items, 'sendHistory').enabled).toBe(true);
    }
  });

  it('mapping is always active (매핑=일반 편집 진입, 권한·상태 제한 없음)', () => {
    // 권한 R·D·Z, 상태 DPS·RDS 다양화 — 매핑은 항상 활성.
    for (const menu of ['deptWrite', 'deptSend', 'personal']) {
      for (const [status, role] of [['DPS', 'D'], ['RDS', 'R'], ['DPS', 'Z'], ['RDS', 'D']]) {
        const items = buildContextMenuItems(menu, { status }, { role });
        expect(find(items, 'mapping')).toBeTruthy();
        expect(find(items, 'mapping').enabled).toBe(true);
        expect(find(items, 'mapping').label).toBe('매핑');
      }
    }
  });

  it('deskUnsent 메뉴에는 매핑/번역 항목이 없다 (회귀)', () => {
    const items = buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'D' });
    expect(keys(items)).not.toContain('mapping');
    expect(keys(items)).not.toContain('translate');
  });

  it('활성 매핑 클릭 시 onSelect(mapping, article) 호출', async () => {
    const onSelect = vi.fn();
    const article = { articleId: 'AKR7', status: 'RDS', lockYN: 'N' };
    render(
      <ContextMenu menu="deptWrite" article={article} identity={{ role: 'R' }} onSelect={onSelect} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '매핑' }));
    expect(onSelect).toHaveBeenCalledWith('mapping', article);
  });

  it('번역은 세션만 있으면 항상 활성 — 클릭 시 onSelect(translate, article) 호출', async () => {
    // 번역은 권한/상태 게이트 없이 항상 활성(서버가 세션 인증·graceful degrade). 클릭하면 onSelect가 발생한다.
    const onSelect = vi.fn();
    const article = { articleId: 'AKR6', status: 'DPS', lockYN: 'N' };
    render(
      <ContextMenu menu="deptWrite" article={article} identity={{ role: 'D' }} onSelect={onSelect} onClose={vi.fn()} />,
    );
    const tr = screen.getByRole('menuitem', { name: '번역' });
    expect(tr).toBeEnabled();
    await userEvent.click(tr);
    expect(onSelect).toHaveBeenCalledWith('translate', article);
  });

  it('followUp/continue are always active (일반 신규 작성 진입)', () => {
    // DPS + D
    const dpsD = buildContextMenuItems('deptWrite', { status: 'DPS' }, { role: 'D' });
    expect(find(dpsD, 'followUp').enabled).toBe(true);
    expect(find(dpsD, 'continue').enabled).toBe(true);
    // DPS + R
    const dpsR = buildContextMenuItems('deptWrite', { status: 'DPS' }, { role: 'R' });
    expect(find(dpsR, 'followUp').enabled).toBe(true);
    expect(find(dpsR, 'continue').enabled).toBe(true);
    // 비-DPS(RDS) + D
    const rdsD = buildContextMenuItems('deptWrite', { status: 'RDS' }, { role: 'D' });
    expect(find(rdsD, 'followUp').enabled).toBe(true);
    expect(find(rdsD, 'continue').enabled).toBe(true);
  });

  it('resend active only for DPS + role D/Z (재송=DPS 재송고)', () => {
    // DPS + D/Z → 활성
    expect(find(buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'D' }), 'resend').enabled).toBe(true);
    expect(find(buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'Z' }), 'resend').enabled).toBe(true);
    // DPS + R → 비활성(R은 send 전이 거부)
    expect(find(buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'R' }), 'resend').enabled).toBe(false);
    // 비-DPS(RDS) + D → 비활성
    expect(find(buildContextMenuItems('deptWrite', { status: 'RDS' }, { role: 'D' }), 'resend').enabled).toBe(false);
  });

  it('KILL기사 메뉴는 읽기전용 항목만 노출하고 전이 액션은 없다 (step2 — 종료 상태)', () => {
    // 종료 상태(RRK/DDK/EEK)이므로 어떤 권한이든 읽기전용(상세보기·이력·복사)만 노출한다.
    for (const status of ['RRK', 'DDK', 'EEK']) {
      for (const role of ['R', 'D', 'Z']) {
        const items = buildContextMenuItems('killArticles', { status }, { role });
        expect(keys(items)).toEqual(['detail', 'history', 'sendHistory', 'copyBody', 'copyTitle']);
        // 부적절한 전이/편집 액션은 노출하지 않는다.
        for (const k of ['reviseNoPortal', 'revisePortal', 'requestDelete', 'resend', 'followUp', 'continue', 'mapping', 'translate', 'edit']) {
          expect(keys(items)).not.toContain(k);
        }
      }
    }
  });

  it('엠바고 관리 메뉴는 편집(edit)을 노출하고 EPS에 부적절한 전이 액션은 노출하지 않는다 (step3)', () => {
    // EPS 기사 편집 진입을 위해 edit 항목을 노출한다(기존 enterEditor 'edit' 재사용).
    // 권한과 무관하게 edit 항목이 보이고, 고침/포털고침·삭제요청·재송·후속/계속·매핑·번역 등 전이/부적절 액션은 노출하지 않는다.
    for (const role of ['R', 'D', 'Z']) {
      const items = buildContextMenuItems('embargoMgmt', { status: 'EPS' }, { role });
      expect(keys(items)).toContain('edit');
      for (const k of ['reviseNoPortal', 'revisePortal', 'requestDelete', 'resend', 'followUp', 'continue', 'mapping']) {
        expect(keys(items)).not.toContain(k);
      }
    }
  });

  it('엠바고 관리 메뉴의 활성 편집 클릭 시 onSelect(edit, article) 호출 (step3)', async () => {
    const onSelect = vi.fn();
    const article = { articleId: 'AKR-EPS', status: 'EPS', lockYN: 'N' };
    render(
      <ContextMenu menu="embargoMgmt" article={article} identity={{ role: 'D' }} onSelect={onSelect} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '편집' }));
    expect(onSelect).toHaveBeenCalledWith('edit', article);
  });

  it('deskUnsent 메뉴에는 followUp/continue/resend 항목이 없다 (회귀)', () => {
    const items = buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'D' });
    expect(keys(items)).not.toContain('followUp');
    expect(keys(items)).not.toContain('continue');
    expect(keys(items)).not.toContain('resend');
  });

  it('활성 followUp 클릭 시 onSelect(key, article) 호출', async () => {
    const onSelect = vi.fn();
    const article = { articleId: 'AKR2', status: 'DPS', lockYN: 'N' };
    render(
      <ContextMenu menu="deptSend" article={article} identity={{ role: 'D' }} onSelect={onSelect} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '후속기사작성' }));
    expect(onSelect).toHaveBeenCalledWith('followUp', article);
  });

  it('history/sendHistory are now active (이력보기/송고이력보기)', () => {
    const items = buildContextMenuItems('deptWrite', { status: 'RDS' }, { role: 'R' });
    expect(find(items, 'history').enabled).toBe(true);
    expect(find(items, 'sendHistory').enabled).toBe(true);
    // 데스크 미송고는 history만, sendHistory 없음.
    const desk = buildContextMenuItems('deskUnsent', { status: 'RDS' }, { role: 'R' });
    expect(find(desk, 'history').enabled).toBe(true);
    expect(keys(desk)).not.toContain('sendHistory');
  });

  it('history click emits onSelect (활성 항목)', async () => {
    const onSelect = vi.fn();
    const article = { articleId: 'AKR1', status: 'RDS', lockYN: 'N' };
    render(
      <ContextMenu menu="deptWrite" article={article} identity={{ role: 'R' }} onSelect={onSelect} onClose={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '이력보기' }));
    expect(onSelect).toHaveBeenCalledWith('history', article);
  });
});

describe('buildContextMenuItems — active conditions', () => {
  it('고침/포털고침 active only for DPS + role D', () => {
    const dpsD = buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'D' });
    expect(find(dpsD, 'reviseNoPortal').enabled).toBe(true);
    expect(find(dpsD, 'revisePortal').enabled).toBe(true);

    const dpsZ = buildContextMenuItems('deptSend', { status: 'DPS' }, { role: 'Z' });
    expect(find(dpsZ, 'reviseNoPortal').enabled).toBe(false); // Z 아님 — D만

    const rdsD = buildContextMenuItems('deptSend', { status: 'RDS' }, { role: 'D' });
    expect(find(rdsD, 'reviseNoPortal').enabled).toBe(false); // DPS 아님
  });

  it('삭제요청 active only for DPS + role D/Z', () => {
    expect(find(buildContextMenuItems('deptWrite', { status: 'DPS' }, { role: 'D' }), 'requestDelete').enabled).toBe(true);
    expect(find(buildContextMenuItems('deptWrite', { status: 'DPS' }, { role: 'Z' }), 'requestDelete').enabled).toBe(true);
    expect(find(buildContextMenuItems('deptWrite', { status: 'DPS' }, { role: 'R' }), 'requestDelete').enabled).toBe(false);
    expect(find(buildContextMenuItems('deptWrite', { status: 'RDS' }, { role: 'D' }), 'requestDelete').enabled).toBe(false);
  });

  it('Lock해제 appears only on locked rows; active for D/Z, disabled for R', () => {
    expect(keys(buildContextMenuItems('deptWrite', { status: 'RDS', lockYN: 'N' }, { role: 'D' })))
      .not.toContain('releaseLock');

    const lockedD = buildContextMenuItems('deptWrite', { status: 'RDS', lockYN: 'Y' }, { role: 'D' });
    expect(find(lockedD, 'releaseLock').enabled).toBe(true);

    const lockedR = buildContextMenuItems('deptWrite', { status: 'RDS', lockYN: 'Y' }, { role: 'R' });
    expect(find(lockedR, 'releaseLock').enabled).toBe(false);
  });
});

describe('ContextMenu component', () => {
  it('renders items and emits onSelect for enabled items only', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const article = { articleId: 'AKR1', status: 'DPS', lockYN: 'N' };
    render(
      <ContextMenu menu="deptSend" article={article} identity={{ role: 'R' }} onSelect={onSelect} onClose={onClose} />,
    );

    // 활성 항목 — 상세보기.
    await userEvent.click(screen.getByRole('menuitem', { name: '상세보기' }));
    expect(onSelect).toHaveBeenCalledWith('detail', article);

    // 비활성 항목 — 삭제요청(R 권한) → disabled, 클릭해도 onSelect 호출 안 됨.
    const del = screen.getByRole('menuitem', { name: '삭제요청' });
    expect(del).toBeDisabled();
    await userEvent.click(del);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
