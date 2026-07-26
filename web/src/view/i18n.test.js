import { describe, it, expect } from 'vitest';
import { UI_LANGUAGES, MESSAGES, createTranslator } from './i18n.js';
import { EDITOR_MENUS } from './EditorMenuBar.jsx';

// EDITOR_MENUS의 모든 메뉴/항목 [id, label] 쌍을 평탄화한다(ko 정답지).
const menuEntries = [];
for (const menu of EDITOR_MENUS) {
  menuEntries.push([menu.id, menu.label]);
  for (const item of menu.items) menuEntries.push([item.id, item.label]);
}

describe('i18n — UI 언어(ko/en) 카탈로그 + 번역 헬퍼', () => {
  it('UI_LANGUAGES는 ko/en 2종이며 frozen이다', () => {
    expect(UI_LANGUAGES).toEqual(['ko', 'en']);
    expect(Object.isFrozen(UI_LANGUAGES)).toBe(true);
  });

  it('MESSAGES와 각 언어 테이블은 frozen이다', () => {
    expect(Object.isFrozen(MESSAGES)).toBe(true);
    expect(Object.isFrozen(MESSAGES.ko)).toBe(true);
    expect(Object.isFrozen(MESSAGES.en)).toBe(true);
  });

  // (a) ko 바이트 동일 불변식 — 최상위 규칙
  it('MESSAGES.ko의 모든 메뉴/항목 값이 EDITOR_MENUS 라벨과 바이트 동일하다', () => {
    for (const [id, label] of menuEntries) {
      expect(MESSAGES.ko[id]).toBe(label);
    }
  });

  // (b) en에 동일 키 집합이 모두 존재 (누락 키 없음)
  it('en 테이블은 ko와 정확히 같은 키 집합을 가진다(누락/잉여 없음)', () => {
    const koKeys = Object.keys(MESSAGES.ko).sort();
    const enKeys = Object.keys(MESSAGES.en).sort();
    expect(enKeys).toEqual(koKeys);
    for (const [id] of menuEntries) {
      expect(MESSAGES.en).toHaveProperty(id);
    }
  });

  it('en의 모든 값은 비어있지 않은 문자열이다', () => {
    for (const key of Object.keys(MESSAGES.en)) {
      expect(typeof MESSAGES.en[key]).toBe('string');
      expect(MESSAGES.en[key].length).toBeGreaterThan(0);
    }
  });

  it('UI 언어 다이얼로그 전용 키가 ko/en 양쪽에 존재한다', () => {
    for (const key of ['ui.dialog.title', 'ui.dialog.langLabel', 'ui.dialog.ko', 'ui.dialog.en', 'common.save', 'common.close']) {
      expect(MESSAGES.ko).toHaveProperty(key);
      expect(MESSAGES.en).toHaveProperty(key);
    }
    // 다이얼로그 라벨의 ko 값 스펙 확인
    expect(MESSAGES.ko['ui.dialog.title']).toBe('UI 언어 설정');
    expect(MESSAGES.ko['common.save']).toBe('저장');
    expect(MESSAGES.ko['common.close']).toBe('닫기');
  });

  // Step 4(44-editor-gap-closeout): 도움말 열기/에디터 정보 다이얼로그 본문 전용 키 — ko/en 대칭 + 비어있지 않음.
  it('도움말/에디터 정보 다이얼로그 본문 키가 ko/en 양쪽에 존재하며 비어있지 않다', () => {
    const keys = [
      'help.dialog.shortcutsTitle', 'help.dialog.overwrite', 'help.dialog.companyCode',
      'help.dialog.nameLabel', 'help.dialog.appName', 'help.dialog.versionLabel',
    ];
    for (const key of keys) {
      expect(MESSAGES.ko).toHaveProperty(key);
      expect(MESSAGES.en).toHaveProperty(key);
      expect(MESSAGES.ko[key].length).toBeGreaterThan(0);
      expect(MESSAGES.en[key].length).toBeGreaterThan(0);
    }
    // ko 값 스펙 확인(본문 텍스트).
    expect(MESSAGES.ko['help.dialog.shortcutsTitle']).toBe('단축키');
    expect(MESSAGES.ko['help.dialog.appName']).toBe('기사 작성기');
  });

  // (c) createTranslator('ko')는 항상 ko 원문 반환
  it("createTranslator('ko')는 모든 id에 대해 ko 원문(EDITOR_MENUS 라벨)을 반환한다", () => {
    const t = createTranslator('ko');
    for (const [id, label] of menuEntries) {
      expect(t(id)).toBe(label);
    }
  });

  it("createTranslator('ko')는 fallback이 주어져도 등록된 키의 ko 원문을 우선한다", () => {
    const t = createTranslator('ko');
    // Step 2의 t(item.id, item.label) 형태 — fallback이 ko 원문이라 이중 보장
    expect(t('file', '무시됨')).toBe('파일');
  });

  // (d) createTranslator('en')는 영문 반환
  it("createTranslator('en')는 등록된 id에 대해 en 값을 반환한다", () => {
    const t = createTranslator('en');
    for (const [id] of menuEntries) {
      expect(t(id)).toBe(MESSAGES.en[id]);
    }
    expect(t('file')).toBe('File');
    expect(t('tools.uiLanguage')).toBe('UI Language');
  });

  // (e) 미지원 언어·미등록 키 안전 저하
  it("미지원 언어(createTranslator('ja'))는 ko 테이블로 저하한다", () => {
    const t = createTranslator('ja');
    expect(t('file')).toBe(MESSAGES.ko['file']);
    expect(t('file')).toBe('파일');
  });

  it('미등록 키는 fallback → ko → key 순으로 안전 저하한다', () => {
    const en = createTranslator('en');
    expect(en('없는키', '원문')).toBe('원문'); // fallback 우선
    expect(en('없는키')).toBe('없는키'); // fallback 없고 ko에도 없음 → key
    // ko에 있는 키를 en이 실수로 누락했다고 가정한 시나리오는 실제로는 없지만,
    // fallback 미지정 시 ko 원문으로 저하하는 사슬을 확인
    const ja = createTranslator('ja');
    expect(ja('없는키')).toBe('없는키');
  });
});
