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
    expect(find(items, 'history').enabled).toBe(true); // 활성(새 창 이력 표시)
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

  it('translate/mapping are always disabled (표시만, 다음 phase)', () => {
    const items = buildContextMenuItems('deptWrite', { status: 'DPS' }, { role: 'D' });
    for (const k of ['translate', 'mapping']) {
      expect(find(items, k).enabled).toBe(false);
    }
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
