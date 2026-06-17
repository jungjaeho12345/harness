import { describe, it, expect } from 'vitest';
import { renderHistoryHtml } from './historyView.js';

const sample = [
  {
    createdAt: '2026-06-14T03:09:06Z', eventType: 'create',
    actorUserId: 'kim', actorRole: 'R', fromStatus: null, toStatus: 'RDS', title: '첫 기사',
  },
  {
    createdAt: '2026-06-14T04:00:00Z', eventType: 'send',
    actorUserId: 'lee', actorRole: 'D', fromStatus: 'RDS', toStatus: 'DPS', title: '첫 기사',
  },
];

describe('renderHistoryHtml', () => {
  it('renders each history entry (time/event/actor/transition)', () => {
    const html = renderHistoryHtml(sample, { title: '첫 기사', kind: 'history' });
    expect(html).toContain('create');
    expect(html).toContain('send');
    expect(html).toContain('kim');
    expect(html).toContain('lee');
    expect(html).toContain('RDS');
    expect(html).toContain('DPS');
    expect(html).toContain('2026-06-14T03:09:06Z');
  });

  it('includes window title and kind label in the document', () => {
    const html = renderHistoryHtml(sample, { title: '첫 기사', kind: 'history' });
    expect(html).toContain('<title>');
    expect(html).toContain('이력');
    const send = renderHistoryHtml(sample, { title: '첫 기사', kind: 'sendHistory' });
    expect(send).toContain('송고이력');
  });

  it('shows a guidance message for an empty list', () => {
    const html = renderHistoryHtml([], { title: '빈 기사', kind: 'history' });
    expect(html).toContain('이력이 없습니다');
  });

  it('escapes all values (no executable script — XSS defense)', () => {
    const evil = [{
      createdAt: '2026', eventType: '<script>evil()</script>',
      actorUserId: '<b>kim</b>', actorRole: 'R', fromStatus: null, toStatus: 'RDS',
    }];
    const html = renderHistoryHtml(evil, { title: '<script>title()</script>', kind: 'history' });
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;kim&lt;/b&gt;');
    expect(html).not.toContain('<script>title()</script>');
    expect(html).toContain('&lt;script&gt;title()&lt;/script&gt;');
  });
});
