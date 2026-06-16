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
