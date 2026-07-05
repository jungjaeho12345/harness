import { describe, it, expect } from 'vitest';
import {
  parseLocation, resolveRoute, buildPath, ROUTES, Z_ONLY_ROUTES, DEFAULT_ROUTE,
} from './routing.js';

describe('parseLocation', () => {
  it('maps a known .do path to its route', () => {
    expect(parseLocation({ pathname: '/list.do' }).route).toBe('list.do');
    expect(parseLocation({ pathname: '/writer.do' }).route).toBe('writer.do');
  });

  it('falls back to login.do for undefined paths', () => {
    expect(parseLocation({ pathname: '/nope.do' }).route).toBe('login.do');
    expect(parseLocation({ pathname: '/' }).route).toBe('login.do');
    expect(parseLocation({}).route).toBe('login.do');
  });

  it('extracts articleId from the query string', () => {
    expect(parseLocation({ pathname: '/writer.do', search: '?articleId=AKR1' }).articleId).toBe('AKR1');
    expect(parseLocation({ pathname: '/writer.do' }).articleId).toBeNull();
  });
});

describe('resolveRoute (guards)', () => {
  const R = { role: 'R' };
  const Z = { role: 'Z' };

  it('sends unauthenticated users to login.do regardless of target', () => {
    expect(resolveRoute('list.do', null)).toBe('login.do');
    expect(resolveRoute('rcvMgmt.do', null)).toBe('login.do');
  });

  it('redirects a logged-in user off login.do to list.do', () => {
    expect(resolveRoute('login.do', R)).toBe('list.do');
  });

  it('blocks non-Z from Z-only routes (→ list.do)', () => {
    for (const route of Z_ONLY_ROUTES) {
      expect(resolveRoute(route, R)).toBe('list.do');
    }
  });

  it('allows Z into Z-only routes', () => {
    for (const route of Z_ONLY_ROUTES) {
      expect(resolveRoute(route, Z)).toBe(route);
    }
  });

  it('passes through normal routes for logged-in users', () => {
    expect(resolveRoute('writer.do', R)).toBe('writer.do');
    expect(resolveRoute('list.do', R)).toBe('list.do');
  });

  it('logs.do is any-authenticated (not Z-only): logged-out → login.do, R/D/Z → logs.do', () => {
    expect(ROUTES).toContain('logs.do');
    expect(Z_ONLY_ROUTES).not.toContain('logs.do');
    expect(resolveRoute('logs.do', null)).toBe('login.do');
    expect(resolveRoute('logs.do', R)).toBe('logs.do');
    expect(resolveRoute('logs.do', { role: 'D' })).toBe('logs.do');
    expect(resolveRoute('logs.do', Z)).toBe('logs.do');
  });

  it('treats unknown targets as login.do then applies guards', () => {
    expect(resolveRoute('bogus.do', null)).toBe(DEFAULT_ROUTE);
    expect(resolveRoute('bogus.do', R)).toBe('list.do'); // login.do → list.do for logged-in
  });
});

describe('buildPath', () => {
  it('builds a bare path for new article tabs', () => {
    expect(buildPath('writer.do')).toBe('/writer.do');
    expect(buildPath('writer.do', {})).toBe('/writer.do');
  });

  it('appends the articleId query for edit tabs', () => {
    expect(buildPath('writer.do', { articleId: 'AKR1' })).toBe('/writer.do?articleId=AKR1');
  });

  it('exposes the canonical route list', () => {
    expect(ROUTES).toContain('login.do');
    expect(ROUTES).toContain('userMgmt.do');
  });
});
