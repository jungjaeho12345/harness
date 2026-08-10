import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HISTORY_COLUMNS, HISTORY_EMPTY, defaultHistoryColumnConfig, loadHistoryColumnConfig,
  saveHistoryColumnConfig, toggleHistoryColumn, visibleHistoryColumns, historyCellText,
} from './historyColumns.js';
import { setDateFormat, DEFAULT_DATE_FORMAT } from './listFormat.js';

const DEFAULT_KEYS = ['createdAt', 'title', 'actorUserId', 'status', 'version'];

// 서버(/history)가 주는 이력 행 shape 그대로(step2 계약) — title/version/status는 서버 파생.
const ROW = {
  id: 3,
  articleId: 'AKR9',
  eventType: 'status',
  action: 'send',
  fromStatus: 'RDS',
  toStatus: 'DPS',
  actorUserId: '김기자',
  createdAt: '2026-06-14T03:09:06Z',
  hasSnapshot: 1,
  title: '헤드라인',
  version: 3,
  status: 'DPS',
};

const ARTICLE = {
  author: 'kim', department: '정치', createdAt: '2026-06-14T01:00:00Z', sentAt: '2026-06-14T03:09:06Z',
};

describe('historyColumns — 이력보기 컬럼 카탈로그/영속/셀 텍스트', () => {
  beforeEach(() => { localStorage.clear(); });
  // 날짜형식은 module-level 가변이라 케이스 간 누수를 막기 위해 기본으로 복원(ListPage.test.jsx 관례).
  afterEach(() => { setDateFormat(DEFAULT_DATE_FORMAT); vi.restoreAllMocks(); });

  // 케이스 1 — 카탈로그: 17개 key 표 순서, { key, label, group } shape, frozen, 그룹 13+4.
  it('HISTORY_COLUMNS는 17개 key를 표 순서 그대로 담고 각 원소가 { key, label, group }이며 frozen이다', () => {
    expect(HISTORY_COLUMNS.map((c) => c.key)).toEqual([
      'createdAt', 'title', 'actorUserId', 'status', 'version',
      'eventType', 'action', 'transition', 'fromStatus', 'toStatus',
      'articleId', 'id', 'hasSnapshot',
      'articleAuthor', 'articleDepartment', 'articleCreatedAt', 'articleSentAt',
    ]);
    expect(Object.isFrozen(HISTORY_COLUMNS)).toBe(true);
    for (const c of HISTORY_COLUMNS) {
      expect(Object.keys(c).sort()).toEqual(['group', 'key', 'label']);
      expect(Object.isFrozen(c)).toBe(true);
    }
    expect(HISTORY_COLUMNS.filter((c) => c.group === 'history')).toHaveLength(13);
    expect(HISTORY_COLUMNS.filter((c) => c.group === 'article')).toHaveLength(4);
  });

  it('라벨은 스펙/합의 표기를 따른다(수정시간·제목·수정자·상태·버전 + 이력/기사 그룹)', () => {
    expect(Object.fromEntries(HISTORY_COLUMNS.map((c) => [c.key, c.label]))).toEqual({
      createdAt: '수정시간', title: '제목', actorUserId: '수정자', status: '상태', version: '버전',
      eventType: '종류', action: '동작', transition: '전이', fromStatus: '이전상태', toStatus: '이후상태',
      articleId: '기사아이디', id: '이력번호', hasSnapshot: '본문스냅샷',
      articleAuthor: '작성자', articleDepartment: '부서', articleCreatedAt: '작성시간', articleSentAt: '송고시간',
    });
  });

  // 케이스 2 — 기본 표시 5열(스펙 news.md 114~115행)·순서 포함, 나머지는 false.
  it('기본 표시 컬럼은 정확히 수정시간/제목/수정자/상태/버전(순서 포함)이고 나머지는 false다', () => {
    const cfg = defaultHistoryColumnConfig();
    expect(visibleHistoryColumns(cfg).map((c) => c.key)).toEqual(DEFAULT_KEYS);
    for (const c of HISTORY_COLUMNS) {
      expect(cfg.visible[c.key]).toBe(DEFAULT_KEYS.includes(c.key));
    }
  });

  // 케이스 3 — 저장 없으면 기본값.
  it('저장이 없으면 loadHistoryColumnConfig가 기본값을 반환한다', () => {
    expect(loadHistoryColumnConfig('history')).toEqual(defaultHistoryColumnConfig());
    expect(loadHistoryColumnConfig('sendHistory')).toEqual(defaultHistoryColumnConfig());
  });

  // 케이스 4 — 저장 후 로드하면 복원.
  it('saveHistoryColumnConfig 후 다시 로드하면 그 설정이 복원된다', () => {
    const cfg = toggleHistoryColumn(toggleHistoryColumn(defaultHistoryColumnConfig(), 'version'), 'eventType');
    saveHistoryColumnConfig('history', cfg);
    const loaded = loadHistoryColumnConfig('history');
    expect(loaded.visible.version).toBe(false);
    expect(loaded.visible.eventType).toBe(true);
    expect(loaded.visible.title).toBe(true);
  });

  // 케이스 5 — 이력 종류별 스코프('history' vs 'sendHistory').
  it("'history'에 저장해도 'sendHistory'는 기본값이다(그 반대도)", () => {
    saveHistoryColumnConfig('history', toggleHistoryColumn(defaultHistoryColumnConfig(), 'version'));
    expect(loadHistoryColumnConfig('sendHistory')).toEqual(defaultHistoryColumnConfig());

    saveHistoryColumnConfig('sendHistory', toggleHistoryColumn(defaultHistoryColumnConfig(), 'title'));
    // 각자 자기 저장값만 본다.
    expect(loadHistoryColumnConfig('history').visible.version).toBe(false);
    expect(loadHistoryColumnConfig('history').visible.title).toBe(true);
    expect(loadHistoryColumnConfig('sendHistory').visible.title).toBe(false);
    expect(loadHistoryColumnConfig('sendHistory').visible.version).toBe(true);
  });

  // 케이스 6 — 저장 키 격리: 목록 페이지의 yh.columnConfig를 오염시키지 않는다.
  it("저장 키는 yh.historyColumnConfig이며 목록 페이지의 yh.columnConfig를 오염시키지 않는다", () => {
    const listCfg = JSON.stringify({ deskUnsent: { visible: { title: false }, gap: 16 } });
    localStorage.setItem('yh.columnConfig', listCfg);

    saveHistoryColumnConfig('history', toggleHistoryColumn(defaultHistoryColumnConfig(), 'version'));

    expect(localStorage.getItem('yh.columnConfig')).toBe(listCfg);
    expect(localStorage.getItem('yh.historyColumnConfig')).not.toBeNull();
  });

  // 케이스 7 — 병합: 저장값에 없는(나중에 추가된) 키는 기본값을 따른다.
  it('저장된 visible에 없는 키는 기본값을 따른다(기본 숨김은 숨김 유지·기본 표시는 표시 유지)', () => {
    // 일부 키만 담긴 저장값(과거 버전 카탈로그로 저장된 상황 모사).
    saveHistoryColumnConfig('history', { visible: { version: false } });
    const loaded = loadHistoryColumnConfig('history');
    expect(loaded.visible.version).toBe(false); // 저장값 우선
    expect(loaded.visible.title).toBe(true); // 기본 표시 유지
    expect(loaded.visible.eventType).toBe(false); // 기본 숨김 유지
    expect(loaded.visible.articleAuthor).toBe(false); // 기사 그룹도 기본 숨김 유지
  });

  // 케이스 8 — 손상된 저장값에서 throw 없이 기본값.
  it('손상된 저장값에서 throw 없이 기본값을 반환한다', () => {
    for (const bad of ['{{{', JSON.stringify(['a']), JSON.stringify('str'), JSON.stringify(null)]) {
      localStorage.setItem('yh.historyColumnConfig', bad);
      expect(() => loadHistoryColumnConfig('history')).not.toThrow();
      expect(loadHistoryColumnConfig('history')).toEqual(defaultHistoryColumnConfig());
    }
  });

  // 케이스 9 — setItem throw(quota/접근 불가) 시 graceful no-op(abbrevStore 선례).
  it('localStorage.setItem이 throw해도 saveHistoryColumnConfig가 예외 없이 설정 객체를 반환한다', () => {
    const spy = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    try {
      const cfg = toggleHistoryColumn(defaultHistoryColumnConfig(), 'version');
      expect(() => saveHistoryColumnConfig('history', cfg)).not.toThrow();
      expect(saveHistoryColumnConfig('history', cfg)).toBe(cfg);
    } finally {
      spy.mockRestore();
    }
  });

  // 케이스 10 — toggle은 새 객체를 반환하고 원본 불변.
  it('toggleHistoryColumn은 새 객체를 반환하고 원본을 변형하지 않는다', () => {
    const cfg = defaultHistoryColumnConfig();
    const next = toggleHistoryColumn(cfg, 'eventType');
    expect(next).not.toBe(cfg);
    expect(next.visible).not.toBe(cfg.visible);
    expect(next.visible.eventType).toBe(true);
    expect(cfg.visible.eventType).toBe(false); // 원본 불변
  });

  // 케이스 11 — 표시 컬럼은 카탈로그 정의 순서 유지, 전부 끄면 빈 배열(throw 금지).
  it('visibleHistoryColumns는 카탈로그 정의 순서를 유지하고, 모두 끄면 빈 배열을 반환한다', () => {
    let cfg = defaultHistoryColumnConfig();
    // 기본 숨김 컬럼(hasSnapshot·eventType)을 켜도 표시 순서는 카탈로그 정의 순서다.
    cfg = toggleHistoryColumn(toggleHistoryColumn(cfg, 'hasSnapshot'), 'eventType');
    expect(visibleHistoryColumns(cfg).map((c) => c.key))
      .toEqual(['createdAt', 'title', 'actorUserId', 'status', 'version', 'eventType', 'hasSnapshot']);

    for (const c of HISTORY_COLUMNS) {
      if (cfg.visible[c.key]) cfg = toggleHistoryColumn(cfg, c.key);
    }
    expect(() => visibleHistoryColumns(cfg)).not.toThrow();
    expect(visibleHistoryColumns(cfg)).toEqual([]);
  });

  // 케이스 12 — 이력 그룹 셀 텍스트 변환.
  it('historyCellText: createdAt은 현재 날짜형식, 값이 없으면 —', () => {
    expect(historyCellText('createdAt', ROW)).toBe('2026-06-14 03:09');
    expect(historyCellText('createdAt', {})).toBe(HISTORY_EMPTY);
  });

  it('historyCellText: createdAt 셀은 날짜형식 설정을 따른다(listFormat.formatDateTime 재사용)', () => {
    setDateFormat('YYYY.MM.DD');
    expect(historyCellText('createdAt', ROW)).toBe('2026.06.14');
  });

  it("historyCellText: version은 v{n}, 없으면 —", () => {
    expect(historyCellText('version', ROW)).toBe('v3');
    expect(historyCellText('version', {})).toBe(HISTORY_EMPTY);
  });

  it("historyCellText: hasSnapshot은 1→Y, 0/없음→N", () => {
    expect(historyCellText('hasSnapshot', ROW)).toBe('Y');
    expect(historyCellText('hasSnapshot', { hasSnapshot: 0 })).toBe('N');
    expect(historyCellText('hasSnapshot', {})).toBe('N');
  });

  it("historyCellText: transition은 from→to, 한쪽만 있으면 그 쪽만(화살표 없음), 둘 다 없으면 —", () => {
    expect(historyCellText('transition', ROW)).toBe('RDS→DPS');
    // 한쪽만 있으면 'RDS→' 같은 잘린 형태 대신 있는 값만 보여준다(규칙 고정).
    expect(historyCellText('transition', { fromStatus: 'RDS' })).toBe('RDS');
    expect(historyCellText('transition', { toStatus: 'DPS' })).toBe('DPS');
    expect(historyCellText('transition', {})).toBe(HISTORY_EMPTY);
  });

  it("historyCellText: title은 빈 문자열이면 —, 값이 있으면 그대로", () => {
    expect(historyCellText('title', { title: '' })).toBe(HISTORY_EMPTY);
    expect(historyCellText('title', ROW)).toBe('헤드라인');
  });

  it('historyCellText: 원값 컬럼(eventType/action/상태들/id)과 알 수 없는 key', () => {
    expect(historyCellText('eventType', ROW)).toBe('status');
    expect(historyCellText('action', ROW)).toBe('send');
    expect(historyCellText('action', { action: null })).toBe(HISTORY_EMPTY); // edit 행은 action null
    expect(historyCellText('fromStatus', ROW)).toBe('RDS');
    expect(historyCellText('toStatus', ROW)).toBe('DPS');
    expect(historyCellText('status', ROW)).toBe('DPS');
    expect(historyCellText('actorUserId', ROW)).toBe('김기자');
    expect(historyCellText('articleId', ROW)).toBe('AKR9');
    expect(historyCellText('id', ROW)).toBe('3');
    expect(() => historyCellText('unknownKey', ROW)).not.toThrow();
    expect(historyCellText('unknownKey', ROW)).toBe(HISTORY_EMPTY);
  });

  // 케이스 12-1 — 기사 그룹 셀은 세 번째 인자(article)에서 읽는다.
  it('historyCellText: 기사 그룹 셀은 article 인자에서 값을 읽는다', () => {
    expect(historyCellText('articleAuthor', ROW, ARTICLE)).toBe('kim');
    expect(historyCellText('articleDepartment', ROW, ARTICLE)).toBe('정치');
    expect(historyCellText('articleCreatedAt', ROW, ARTICLE)).toBe('2026-06-14 01:00');
    expect(historyCellText('articleSentAt', ROW, ARTICLE)).toBe('2026-06-14 03:09');
  });

  // 케이스 12-2 — 기사 미주입/필드 없음이면 — (throw 금지).
  it('historyCellText: article 미주입이거나 필드가 비면 기사 그룹 셀은 —', () => {
    for (const key of ['articleAuthor', 'articleDepartment', 'articleCreatedAt', 'articleSentAt']) {
      expect(() => historyCellText(key, ROW)).not.toThrow();
      expect(historyCellText(key, ROW)).toBe(HISTORY_EMPTY);
      expect(historyCellText(key, ROW, {})).toBe(HISTORY_EMPTY);
    }
  });

  // 케이스 12-3 — 키 충돌 없음: 수정시간(이력 행) vs 작성시간(기사)은 서로 다른 소스/값.
  it('historyCellText: createdAt(수정시간)과 articleCreatedAt(작성시간)은 서로 다른 값을 낸다', () => {
    expect(historyCellText('createdAt', ROW, ARTICLE)).toBe('2026-06-14 03:09');
    expect(historyCellText('articleCreatedAt', ROW, ARTICLE)).toBe('2026-06-14 01:00');
    expect(historyCellText('createdAt', ROW, ARTICLE))
      .not.toBe(historyCellText('articleCreatedAt', ROW, ARTICLE));
  });

  // 케이스 13 — 순수성: 입력 불변 + 같은 입력 같은 출력.
  it('historyCellText는 입력 행·기사 객체를 변형하지 않고 같은 입력에 같은 출력을 낸다', () => {
    const row = { ...ROW };
    const article = { ...ARTICLE };
    const before = { row: JSON.stringify(row), article: JSON.stringify(article) };

    const first = HISTORY_COLUMNS.map((c) => historyCellText(c.key, row, article));
    const second = HISTORY_COLUMNS.map((c) => historyCellText(c.key, row, article));

    expect(second).toEqual(first);
    expect(JSON.stringify(row)).toBe(before.row);
    expect(JSON.stringify(article)).toBe(before.article);
  });

  // --- phase 57 MVP-4: 배부 계열 어휘 한글 라벨(distribute·distribute-failed·distribute-retry) ---
  // 라벨 범위는 배부 계열뿐이다 — status·edit·send 등 기존 어휘와 미지의 값은 원값 그대로
  // (DistMgmtPage KIND_LABEL 선례 — 화면이 값을 숨기지 않는다. 전체 어휘 한글화는 별도 백로그).
  describe('배부 계열 이력 라벨', () => {
    it("eventType: distribute → '배부'", () => {
      expect(historyCellText('eventType', { eventType: 'distribute' })).toBe('배부');
    });

    it("eventType: distribute-failed → '배부실패'", () => {
      expect(historyCellText('eventType', { eventType: 'distribute-failed' })).toBe('배부실패');
    });

    it("eventType: distribute-retry → '배부재전송'", () => {
      expect(historyCellText('eventType', { eventType: 'distribute-retry' })).toBe('배부재전송');
    });

    it("eventType: status는 원값 유지(배부 밖 어휘 한글화 금지)", () => {
      expect(historyCellText('eventType', { eventType: 'status' })).toBe('status');
    });

    it('미지의 eventType은 원값 그대로다(운영자가 새 서버 어휘를 발견할 단서)', () => {
      expect(historyCellText('eventType', { eventType: 'wire' })).toBe('wire');
    });

    it("action: 배부 행에서 press → '언론사', nonpress → '비언론사'", () => {
      expect(historyCellText('action', { eventType: 'distribute', action: 'press' })).toBe('언론사');
      expect(historyCellText('action', { eventType: 'distribute', action: 'nonpress' })).toBe('비언론사');
    });

    it('action: 실패·재전송 행도 동일하게 kind 라벨을 씌운다', () => {
      expect(historyCellText('action', { eventType: 'distribute-failed', action: 'press' })).toBe('언론사');
      expect(historyCellText('action', { eventType: 'distribute-retry', action: 'nonpress' })).toBe('비언론사');
    });

    // 행 인지(row-aware) 잠금 — 다른 이벤트가 같은 문자열을 쓰면 오역이 되므로 배부 계열 행에서만 라벨.
    it("action: eventType이 배부 계열이 아니면 press도 원값 그대로다(행 인지)", () => {
      expect(historyCellText('action', { eventType: 'status', action: 'press' })).toBe('press');
    });

    it("action: 기존 어휘 회귀 — status 행의 send는 'send' 그대로다", () => {
      expect(historyCellText('action', { eventType: 'status', action: 'send' })).toBe('send');
    });

    it('빈 action은 배부 계열 행에서도 HISTORY_EMPTY다', () => {
      expect(historyCellText('action', { eventType: 'distribute', action: null })).toBe(HISTORY_EMPTY);
      expect(historyCellText('action', { eventType: 'distribute-failed', action: '' })).toBe(HISTORY_EMPTY);
    });

    it('row가 undefined여도 throw하지 않는다(기존 방어 유지)', () => {
      expect(() => historyCellText('eventType', undefined)).not.toThrow();
      expect(historyCellText('eventType', undefined)).toBe(HISTORY_EMPTY);
      expect(() => historyCellText('action', undefined)).not.toThrow();
      expect(historyCellText('action', undefined)).toBe(HISTORY_EMPTY);
    });

    it("프로토타입 체인 키(toString)는 라벨로 새지 않는다(원값 그대로)", () => {
      expect(historyCellText('eventType', { eventType: 'toString' })).toBe('toString');
      expect(historyCellText('action', { eventType: 'toString', action: 'toString' })).toBe('toString');
    });
  });
});
