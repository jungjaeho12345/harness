// 이력보기/송고이력보기 모달의 컬럼 카탈로그 + 표시/숨김 영속 + 셀 텍스트 변환 (news.md 114~115행).
// 기본 5열은 수정시간/제목/수정자/상태/버전(스펙 고정)이고, 나머지는 우클릭 '이력 목록설정'에서 추가/제거한다.
// 설정 스코프는 이력 종류('history'=이력보기 | 'sendHistory'=송고이력보기)별 localStorage 영속 —
// 목록 페이지 columnConfig("메뉴별 저장")와 동형이되 저장 키는 분리한다(yh.historyColumnConfig).
// 순수 뷰 모듈: React/DOM/transport 비의존(ADR-003), 저장소는 globalThis.localStorage뿐이다.
// title/version/status는 서버가 파생해 주는 값이라 여기서는 표시만 한다(계산 금지 — 단일 출처는 백엔드).

import { formatDateTime } from './listFormat.js';

// 카탈로그 — group 'history'는 이력 이벤트 필드(13), 'article'은 우클릭한 기사 자체의 메타데이터(4).
// 기사 그룹 key에 article 접두어를 붙이는 이유: 이력 행의 createdAt(이벤트 시각=수정시간)과
// 기사의 createdAt(작성시간)이 같은 이름 다른 의미라서 접두어 없이는 충돌한다.
export const HISTORY_COLUMNS = Object.freeze([
  { key: 'createdAt', label: '수정시간', group: 'history' },
  { key: 'title', label: '제목', group: 'history' },
  { key: 'actorUserId', label: '수정자', group: 'history' },
  { key: 'status', label: '상태', group: 'history' },
  { key: 'version', label: '버전', group: 'history' },
  { key: 'eventType', label: '종류', group: 'history' },
  { key: 'action', label: '동작', group: 'history' },
  { key: 'transition', label: '전이', group: 'history' },
  { key: 'fromStatus', label: '이전상태', group: 'history' },
  { key: 'toStatus', label: '이후상태', group: 'history' },
  { key: 'articleId', label: '기사아이디', group: 'history' },
  { key: 'id', label: '이력번호', group: 'history' },
  { key: 'hasSnapshot', label: '본문스냅샷', group: 'history' },
  { key: 'articleAuthor', label: '작성자', group: 'article' },
  { key: 'articleDepartment', label: '부서', group: 'article' },
  { key: 'articleCreatedAt', label: '작성시간', group: 'article' },
  { key: 'articleSentAt', label: '송고시간', group: 'article' },
].map(Object.freeze));

// 빈 값 표기(news.md 111행 관례 — historyView.js의 EMPTY_FIELD와 동일 표기).
export const HISTORY_EMPTY = '—';

// 기본 표시 5열(news.md 114~115행 스펙 순서 그대로 — 카탈로그 정의 순서도 이와 일치).
const DEFAULT_VISIBLE_KEYS = ['createdAt', 'title', 'actorUserId', 'status', 'version'];

// 목록 페이지(yh.columnConfig)와 분리된 저장 키 — 컬럼 집합도 스코프 의미(이력 종류 vs 메뉴)도 다르다.
const STORAGE_KEY = 'yh.historyColumnConfig';

export function defaultHistoryColumnConfig() {
  const visible = {};
  for (const c of HISTORY_COLUMNS) visible[c.key] = DEFAULT_VISIBLE_KEYS.includes(c.key);
  return { visible };
}

function readAll() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// 이력 종류별 설정 로드(없으면 기본값). 저장된 visible은 기본값 위에 병합해
// 나중에 카탈로그에 추가된 키도 기본값(표시/숨김)을 따르게 한다.
export function loadHistoryColumnConfig(kind) {
  const base = defaultHistoryColumnConfig();
  const saved = readAll()[kind];
  if (!saved || typeof saved !== 'object') return base;
  return { visible: { ...base.visible, ...(saved.visible || {}) } };
}

export function saveHistoryColumnConfig(kind, config) {
  const all = readAll();
  all[kind] = { visible: { ...config.visible } };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage 불가(quota/접근 불가) — 이번 세션은 저장 없이 진행(graceful no-op).
  }
  return config;
}

export function toggleHistoryColumn(config, key) {
  return { ...config, visible: { ...config.visible, [key]: !config.visible[key] } };
}

// 현재 설정에서 표시할 컬럼 목록(카탈로그 정의 순서 유지). 전부 꺼져 있으면 빈 배열.
export function visibleHistoryColumns(config) {
  return HISTORY_COLUMNS.filter((c) => config.visible[c.key]);
}

function text(v) {
  return (v === undefined || v === null || v === '') ? HISTORY_EMPTY : String(v);
}

// 셀 표시 문자열 변환 — 이력 그룹 key는 row만, 기사 그룹 key는 세 번째 인자(article)만 읽는다
// (두 소스가 섞이면 값 출처를 추적할 수 없다). 빈 값은 항상 HISTORY_EMPTY, 알 수 없는 key도 throw 없이 동일.
export function historyCellText(key, row, article) {
  const r = row || {};
  switch (key) {
    case 'createdAt': return text(formatDateTime(r.createdAt));
    case 'title': return text(r.title);
    case 'actorUserId': return text(r.actorUserId);
    case 'status': return text(r.status);
    case 'version': return Number.isFinite(r.version) ? `v${r.version}` : HISTORY_EMPTY;
    case 'eventType': return text(r.eventType);
    case 'action': return text(r.action);
    case 'transition': {
      // 둘 다 있으면 from→to, 한쪽만 있으면 그 값만('RDS→' 같은 잘린 형태 금지), 둘 다 없으면 —.
      const from = (r.fromStatus === undefined || r.fromStatus === null) ? '' : String(r.fromStatus);
      const to = (r.toStatus === undefined || r.toStatus === null) ? '' : String(r.toStatus);
      if (from && to) return `${from}→${to}`;
      return text(from || to);
    }
    case 'fromStatus': return text(r.fromStatus);
    case 'toStatus': return text(r.toStatus);
    case 'articleId': return text(r.articleId);
    case 'id': return text(r.id);
    case 'hasSnapshot': return r.hasSnapshot ? 'Y' : 'N';
    case 'articleAuthor': return text(article?.author);
    case 'articleDepartment': return text(article?.department);
    case 'articleCreatedAt': return text(formatDateTime(article?.createdAt));
    case 'articleSentAt': return text(formatDateTime(article?.sentAt));
    default: return HISTORY_EMPTY;
  }
}
