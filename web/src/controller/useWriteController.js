// 기사 작성페이지(writer.do) 컨트롤러 — 다중 작성 탭(sessionStorage 보존)·편집 진입 컨텍스트·
// 매핑(편집가능/읽기전용)·편집 잠금 수명·송고/보류/KILL/삭제승인을 보유한다. 모든 데이터는 Model 경유.
//
// 편집 잠금 수명(news.md): 편집 탭을 열면 lock 획득, list.do로 이동해도 해제하지 않는다.
// 해제 시점 = 탭 닫기(×)/송고·보류·KILL·삭제승인 성공/브라우저 탭 닫힘(pagehide·beforeunload).
// 강제 해제(force-unlock) 수신 시 해당 편집 탭은 자동 종료한다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '../app/context.js';
import { PENDING_EDIT_KEY } from './useViewController.js';
// 잠금 실패 문구는 목록(useViewController)과 공유한다 — 새 사유 토큰이 한쪽에만 반영되는 드리프트를 막는다.
import { lockFailMessage } from './lockMessages.js';

const TABS_KEY = 'yh.writer.tabs';

// 후속/계속(원본에서 파생한 신규 기사 작성)을 list.do→writer.do로 넘기는 sessionStorage 채널.
// 페이로드 shape: { article, mode }(mode ∈ 'followUp'|'continue'). 편집 채널(PENDING_EDIT_KEY)과 분리한다
// — 원본 잠금·편집 탭 오인을 막기 위함이다. useViewController(step2)가 쓰고, 여기서 마운트 시 1회 소비한다.
export const PENDING_NEW_KEY = 'yh.pendingNew';

// 편집 진입 시 입력란에 채우는(편집 가능) 필드 vs 읽기전용으로 보존하는 필드 (news.md 매핑).
// 공통정보 확장(공동작성/지역/내용(category — 분류 택소노미)/속성/키워드/내부·외부코멘트)
// + 첨부파일/자료파일(업로드 후 path 문자열 보관).
const EDITABLE_FIELDS = [
  'title', 'body', 'author', 'embargoAt', 'secondEmbargoAt',
  'coAuthor', 'region', 'category', 'attribute', 'keyword', 'internalComment', 'externalComment',
  'attachmentFile', 'referenceFile',
];
const READONLY_FIELDS = [
  'articleId', 'modifier', 'sender', 'department', 'departmentCode',
  'createdAt', 'editedAt', 'sentAt',
];

let tabSeq = 0;
function nextTabId() {
  tabSeq += 1;
  return `tab-${tabSeq}`;
}

// 편집 탭(EDIT TAB)별 고유 clientId — 잠금/저장/해제 시 x-edit-client 헤더로 실어 서버가
// "한 세션 1탭만 편집"(같은 세션 다른 탭 차단)·같은 탭 새로고침 재획득·같은 사용자 재로그인 takeover를
// 식별하게 한다(편집 잠금 계약). crypto.randomUUID 우선, 없으면 Math 없는 폴백(시간+카운터)으로 충돌을 피한다.
let clientSeq = 0;
function nextClientId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `c-${uuid}`;
  } catch { /* crypto 불가 — 폴백 */ }
  clientSeq += 1;
  return `c-${Date.now().toString(36)}-${clientSeq}`;
}

// takeover(다른 사용자가 잠금을 가져감)로 편집 탭을 닫을 때의 안내. 무음 종료는 금지다 —
// 이 탭의 미저장 편집분은 사라지고(자동저장 기본 off, 컨트롤러는 초안을 저장하지 않는다) 되돌릴 수 없으므로
// "저장되지 않은 변경은 반영되지 않았다"는 사실을 반드시 알린다.
function takeoverMessage(articleIds) {
  const ids = articleIds.filter(Boolean).join(', ');
  return `다른 사용자가 편집 잠금을 가져가 편집 탭${ids ? `(${ids})` : ''}이 닫혔습니다.`
    + ' 저장되지 않은 변경은 반영되지 않았습니다.';
}

function pick(src, keys) {
  const out = {};
  for (const k of keys) if (src && src[k] !== undefined && src[k] !== null) out[k] = src[k];
  return out;
}

// 탭 편집 필드 → 서버 영속 dto. 본문은 서버가 저장하는 키(markupVersion)로 싣고 body 키는 보내지 않는다
// (server ARTICLE_FIELDS와 일치 — body로 보내면 본문이 통째로 유실된다). role은 어디서도 싣지 않는다(ADR-004).
// override(선택): 뷰가 저장/송고 직전에 만든 본문 교체 값. shape은 { body, title }(phase43·45·49).
//   body  — markupVersion으로 실린다. commitBody의 setState는 같은 tick에 tabsRef에 반영되지 않아(effect 지연)
//           save/submit이 stale 본문을 읽으므로, 자동 기업코드 변환 본문은 오버라이드로 직접 싣는다.
//   title — 그 본문에서 뷰가 bodyTitle(단일 출처)로 파생한 제목. 미전달이면 tab.fields.title 유지(문서화된 폴백).
// 제목 파생은 뷰의 bodyTitle 단일 출처가 담당한다 — 컨트롤러는 뷰를 import하지 않는다(의존 방향 View ← Controller ← Model).
// 계약 위반은 "전부 아니면 전무"로 수렴한다: 객체가 아닌 오버라이드(옛 문자열 계약 등)는 통째로 무시하고
// (문자열을 body로 받아들이면 본문만 바뀌고 제목은 stale인 무음 반쪽 적용이 된다), body 없는 title-only도
// title을 싣지 않는다(본문 stale + 제목만 교체 = 자기모순 기사). title=''은 유효한 제목(본문 첫 줄이 빈 줄)이므로
// != null 판정만 쓴다(truthy 체크 금지).
function toSaveDto(tab, override) {
  const { body, ...rest } = tab.fields;
  const ov = override && typeof override === 'object' ? override : null;
  const dto = { ...rest, markupVersion: ov?.body ?? body };
  if (ov && ov.body != null && ov.title != null) dto.title = ov.title;
  if (tab.articleId) dto.articleId = tab.articleId;
  return dto;
}

// 편집 가능 필드의 빈 시드(blankTab) — EDITABLE_FIELDS를 단일 출처로 삼아 새 공통정보 필드도 자동 포함된다.
// author는 로그인 사용자 이름으로 미리 채운다(신규 작성 시 작성자 미입력 방지). 비우면 ''.
function blankFields(author = '') {
  const out = {};
  for (const k of EDITABLE_FIELDS) out[k] = '';
  out.author = author ?? '';
  return out;
}

// 원본 기사(article)에서 편집 가능 필드를 채운다 — 본문은 서버 영속 키(markupVersion) 우선, 작성자는 폴백.
function fieldsFromArticle(article, fallbackAuthor) {
  const out = blankFields();
  for (const k of EDITABLE_FIELDS) {
    if (article[k] !== undefined && article[k] !== null) out[k] = article[k];
  }
  out.body = article.markupVersion ?? article.body ?? article.content ?? '';
  out.author = article.author ?? fallbackAuthor ?? '';
  return out;
}

function blankTab(author = '') {
  return {
    id: nextTabId(),
    mode: 'new', // 편집 진입 컨텍스트: new / edit / revise / portalRevise (버튼 표시 규칙이 의존 — step12)
    articleId: null,
    status: null, // 진입 상태(RDS/DDH/DPS…) — 송고/보류/KILL 버튼 표시 규칙이 사용한다(writerButtons).
    clientId: null, // 편집 잠금을 획득한 탭만 채워진다(편집 탭 식별자, x-edit-client).
    fields: blankFields(author), // 작성자는 로그인 사용자로 미리 채운다(신규 작성 작성자 자동 입력).
    readOnly: {},
  };
}

// 편집 진입 — 제목/본문/작성자/엠바고/2차엠바고는 입력란에 채우고, 나머지 메타는 읽기전용으로 보존한다.
// clientId: 이 편집 탭의 잠금을 획득할 때 쓴 식별자를 탭에 보관해 저장(PUT)·해제(unlock)에서 같은 값을 보낸다.
function tabFromArticle(article, mode, fallbackAuthor, clientId) {
  return {
    id: nextTabId(),
    mode,
    articleId: article.articleId,
    status: article.status ?? null,
    clientId: clientId ?? null,
    // 편집 가능 필드(제목/본문/작성자/엠바고/공통정보 확장/첨부·자료파일)를 모두 채운다.
    fields: fieldsFromArticle(article, fallbackAuthor),
    readOnly: pick(article, READONLY_FIELDS),
  };
}

// 후속/계속 진입 — 원본에서 파생한 신규 기사 탭. 복사(입력란): 제목/본문/작성자/엠바고/2차엠바고.
// 초기화(비움): articleId(신규 발번 유도)/status(서버 RDS)/송고자·송고시간·수정자 등 원본 메타는
// 끌어오지 않는다(새 기사는 미송고·미발번 draft). 잠금은 획득하지 않는다 — 신규 생성이지 원본 편집이 아니다.
function tabFromSource(article, mode, fallbackAuthor) {
  const t = blankTab();
  t.mode = mode; // 'followUp' | 'continue' — articleId가 null이라 writerButtons는 이미 신규로 분류.
  // 원본의 편집 가능 필드(공통정보 확장·첨부/자료파일 포함)를 신규 탭으로 복사한다.
  t.fields = fieldsFromArticle(article, fallbackAuthor);
  return t; // articleId:null / status:null / readOnly:{} 는 blankTab 기본값 유지.
}

// sessionStorage에서 탭 목록을 복원한다(페이지 이동 후에도 유지). 비어 있으면 빈 새 기사 탭 1개.
// author: 새로 만드는 빈 탭의 작성자 시드(로그인 사용자 이름).
function loadTabs(author = '') {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(TABS_KEY));
    if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length) {
      // 복원된 id와 새 탭 id 충돌 방지 — 카운터를 최대 suffix 이상으로 올린다.
      for (const t of parsed.tabs) {
        const n = Number(String(t.id).replace(/^tab-/, ''));
        if (Number.isFinite(n) && n > tabSeq) tabSeq = n;
      }
      return parsed;
    }
  } catch {
    // 저장된 탭 없음/파싱 불가 — 빈 새 기사 탭으로 시작.
  }
  const first = blankTab(author);
  return { tabs: [first], activeTabId: first.id };
}

export function useWriteController() {
  const { model, identity, replace } = useAppContext();

  // 신규 빈 탭의 작성자 시드 — 로그인 사용자 이름. 콜백(addTab/resetTabToBlank)이 항상 최신 값을
  // 보도록 ref로 미러링한다(블록 팩토리는 모듈 함수라 identity에 직접 접근하지 못한다).
  const authorSeed = (identity && identity.name) || '';
  const authorRef = useRef(authorSeed);
  useEffect(() => { authorRef.current = authorSeed; }, [authorSeed]);

  // 로그인 사용자 아이디 — takeover(보유자 변경) 판정의 유일한 내 쪽 신호. SSE 핸들러는 마운트 시 클로저가
  // 고정되므로 authorRef와 같은 ref 미러링으로 최신 값을 본다(구독 effect 의존성을 늘리면 재구독이 잦아져
  // 신호 유실 창이 생긴다). 클라이언트가 스스로 정한 값이 아니라 세션에서 복원된 신원만 쓴다(ADR-004 규율).
  const userIdSeed = (identity && identity.userId) || '';
  const userIdRef = useRef(userIdSeed);
  useEffect(() => { userIdRef.current = userIdSeed; }, [userIdSeed]);

  const seed = useRef(null);
  if (seed.current === null) seed.current = loadTabs(authorSeed);

  const [tabs, setTabs] = useState(seed.current.tabs);
  const [activeTabId, setActiveTabId] = useState(seed.current.activeTabId);

  // 콜백이 항상 최신 탭/활성탭을 보도록 ref로 미러링(SSE·언로드 핸들러는 마운트 시 클로저 고정).
  const tabsRef = useRef(tabs);
  const activeRef = useRef(activeTabId);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeRef.current = activeTabId; }, [activeTabId]);

  // 탭 목록/활성탭 보존 — 바뀔 때마다 sessionStorage에 저장.
  useEffect(() => {
    try { sessionStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeTabId })); }
    catch { /* sessionStorage 불가 — 이번 세션은 보존 없이 진행 */ }
  }, [tabs, activeTabId]);

  const activeArticleId = (tabs.find((t) => t.id === activeTabId) || {}).articleId || null;

  // 탭 전환 시 주소창을 활성 탭에 맞게 갱신(편집 탭=기사아이디 쿼리, 새 기사 탭=제거)하고
  // 브라우저 탭 제목을 활성 편집 탭의 기사아이디로 표시한다.
  useEffect(() => {
    replace('writer.do', { articleId: activeArticleId });
    try { document.title = activeArticleId || '기사 작성기'; }
    catch { /* document.title 불가 — 무시 */ }
  }, [activeArticleId, replace]);

  // 탭 제거(공통) — ids(1개 이상)를 한 번에 닫는다. unlock=true면 각 편집 탭의 잠금 해제를 요청한다.
  // 마지막 탭을 닫으면 빈 새 기사 탭 1개를 유지한다.
  // 여러 탭을 한 번에 받는 이유(리뷰 반영): 종전 removeTab은 tabsRef 스냅샷으로 setTabs(next) 통째 교체라
  // 같은 tick에 두 번 호출하면 첫 호출의 제거가 덮어써져 좀비 탭이 살아남았다(SSE 잠금 신호 하나가 여러
  // 편집 탭을 닫는 경우 — 그런데 안내는 "닫혔습니다"라고 단언해 사용자에게 거짓을 말했다).
  // 방어는 두 겹이다: (1) setTabs는 함수형 업데이터로만 갱신하고, (2) 다음 스냅샷을 tabsRef/activeRef에
  // 동기 반영해 같은 tick 연속 호출이 서로를 덮어쓰지 않게 한다(상태 반영 effect보다 앞선다).
  // 반환: 실제로 제거된 탭 목록 — 호출부가 안내 문구를 사실대로 쓰게 한다(닫지 않은 탭을 닫혔다고 말하지 않는다).
  const removeTabs = useCallback((ids, { unlock = true } = {}) => {
    const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
    const removed = tabsRef.current.filter((t) => idSet.has(t.id));
    if (removed.length === 0) return [];
    if (unlock) {
      for (const t of removed) {
        if (t.articleId) Promise.resolve(model.unlockArticle(t.articleId, t.clientId)).catch(() => {});
      }
    }
    const keep = (list) => list.filter((t) => !idSet.has(t.id)); // 스냅샷·업데이터 양쪽이 같은 규칙을 쓴다.
    let next = keep(tabsRef.current);
    if (next.length === 0) next = [blankTab()]; // 기존 동작 그대로(작성자 시드 없음 — 이번 수정 범위 밖)
    tabsRef.current = next;
    setTabs((prev) => {
      const rest = keep(prev);
      return rest.length ? rest : next;
    });
    if (idSet.has(activeRef.current)) {
      const nextActiveId = next[next.length - 1].id;
      activeRef.current = nextActiveId;
      setActiveTabId(nextActiveId);
    }
    return removed;
  }, [model]);

  const removeTab = useCallback((id, opts) => removeTabs([id], opts), [removeTabs]);

  const closeTab = useCallback((id) => removeTab(id, { unlock: true }), [removeTab]);

  // 편집 탭을 빈 새 기사 탭으로 전환(같은 자리·같은 탭 id 유지) — 송고/보류/KILL/삭제승인 성공 후.
  const resetTabToBlank = useCallback((id) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...blankTab(authorRef.current), id: t.id } : t)));
  }, []);

  const addTab = useCallback(() => {
    const t = blankTab(authorRef.current);
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
    return t.id;
  }, []);

  const selectTab = useCallback((id) => setActiveTabId(id), []);

  // 편집 진입 — 이미 열린 기사면 새 탭을 만들지 않고 그 탭을 활성화(dedup). 아니면 새 탭 + 잠금 획득.
  const openArticle = useCallback(async (article, mode = 'edit') => {
    const existing = tabsRef.current.find((t) => t.articleId === article.articleId);
    if (existing) { setActiveTabId(existing.id); return existing.id; }

    // 목록행(Contents)에는 본문이 없다 — 단건 재조회로 본문(markupVersion)·공통정보를 채운다.
    // 조회 실패 시 넘어온 목록행으로 폴백한다(탭 열기를 막지 않는다).
    let full = article;
    try {
      const r = await model.getArticle(article.articleId);
      if (r && r.ok) full = { ...article, ...r.article, ...r.contents };
    } catch { /* 조회 실패 — 폴백 */ }

    // 잠금 획득 — 다른 세션이 편집 중(lockYN='Y')이면 서버가 { ok:false, reason:'locked' }를 돌려준다.
    // 이때는 편집 탭을 열지 않고 '편집중입니다.'로 안내한다(데스크 미송고 등 편집 진입 공통).
    // 고침/포털고침은 lock action으로 구분(서버 editDps D 게이트). 단순 편집 진입이며 전이 없음.
    // 매핑(mapping)도 임베드 전용 편집이므로 전이 없는 잠금('revise')을 재사용한다 — 별도 분기 불필요.
    // 서버 POST :id/lock 게이트(DPS는 D 전용)가 실제 인가를 강제한다(신뢰경계=서버, ADR-004).
    const lockAction = mode === 'portalRevise' ? 'portalRevise' : 'revise';
    // 이 편집 탭의 고유 clientId를 발급해 잠금 획득에 실어 보낸다(이후 저장/해제도 같은 값을 사용).
    const clientId = nextClientId();
    const lock = await Promise.resolve(model.lockArticle(article.articleId, lockAction, clientId)).catch(() => null);
    // fail-closed — 잠금을 얻지 못하면(사유 불문: locked/네트워크 단절/401/403/404/비JSON/예외) 편집 탭을 열지 않는다.
    // 무잠금 편집 진입은 동시 편집을 허용하고, 사용자는 한참 편집한 뒤 저장에서 거부당해(phase51·52가 저장 인가를
    // 강화했다) 편집분을 잃는다. 성공 판정은 ok === true(truthy 금지 — 모델/서버 이상값에 조용히 진입 금지).
    if (!lock || lock.ok !== true) {
      globalThis.alert?.(lockFailMessage(lock && lock.reason));
      return null;
    }

    const tab = tabFromArticle(full, mode, identity && identity.name, clientId);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab.id;
  }, [identity, model]);

  // 목록/검색 passthrough — view(문서열기 피커)는 transport를 controller 경유로만 접근한다(ADR-003). model 계약을
  // 그대로 얇게 위임한다(shape 미가공 — { ok, items }). 편집 진입은 openArticle(잠금/dedup/locked 단일 경로)이 담당한다.
  const queryArticles = useCallback((filters) => model.queryArticles(filters), [model]);
  const searchArticles = useCallback((q) => model.searchArticles(q), [model]);

  // 후속/계속 진입 — 원본에서 파생한 신규 기사 탭을 push+활성화한다. 잠금은 획득하지 않는다(원본 미잠금).
  // 목록행에는 본문이 없으므로 model.getArticle로 단건 재조회해 markupVersion을 본문으로 채운다(조회 실패 시 폴백).
  const openFromSource = useCallback(async (article, mode) => {
    let full = article;
    try {
      const r = await model.getArticle(article.articleId);
      if (r && r.ok) full = { ...article, ...r.article, ...r.contents };
    } catch { /* 조회 실패 — 폴백 */ }

    const tab = tabFromSource(full, mode, identity && identity.name);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab.id; // 잠금 획득 없음 — 신규 생성이며 원본은 손대지 않는다.
  }, [identity, model]);

  // 편집 가능 필드만 갱신한다(읽기전용 매핑 필드는 변경 불가).
  // 매핑(mapping) 모드는 임베드 전용 제한 편집 — 공통정보(title/author/embargoAt/secondEmbargoAt)는 거부하고
  // 'body' 갱신만 허용한다(임베드 추가/삭제가 이 경로로 흐른다 — 본문 텍스트 타이핑은 WriterPage가 onTextChange 미연결로 별도 차단).
  const updateField = useCallback((field, value) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== activeRef.current) return t;
      const allowed = t.mode === 'mapping' ? ['body'] : EDITABLE_FIELDS;
      if (!allowed.includes(field)) return t;
      return { ...t, fields: { ...t.fields, [field]: value } };
    }));
  }, []);

  // 저장 — 신규는 생성(POST), 편집은 잠금 보유자 부분 수정(PUT). Model이 articleId 유무로 분기한다.
  // override(선택): 뷰가 만든 { body, title } 오버라이드(toSaveDto 계약 참조).
  const save = useCallback(async (override) => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    if (!tab) return { ok: false, reason: 'no-tab' };
    const r = await model.saveArticle(toSaveDto(tab, override), tab.clientId);
    if (r && r.ok && r.articleId && !tab.articleId) {
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, articleId: r.articleId } : t)));
    }
    return r;
  }, [model]);

  // 다른이름으로 저장 — 현재 활성 탭 본문/공통정보를 articleId 없이 POST해 새 AKR 복제본을 만든다.
  // save가 신규 POST 성공 시 탭에 articleId를 바인딩하는 것과 달리, 현재 탭의 articleId/clientId는
  // 절대 재바인딩하지 않는다(복제본 생성이지 현재 문서 정체성 전환이 아님 — 원본 편집 세션/잠금을 그대로 유지).
  // 편집 잠금 clientId도 넘기지 않는다(새 기사는 잠금 대상이 아님). 결과 { ok, articleId }를 그대로 반환(호출자 피드백용).
  const saveAsNew = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    if (!tab) return { ok: false, reason: 'no-tab' };
    const { articleId, ...dto } = toSaveDto(tab); // eslint-disable-line no-unused-vars -- articleId 제거 → POST(새 발번)
    return model.saveArticle(dto); // clientId 미전달 — 원본 잠금과 무관한 신규 생성.
  }, [model]);

  // 매핑 저장 — 본문 텍스트는 그대로(readOnly) 두고 추가된 임베드만 PUT으로 저장한다. 생애주기 전이가 없으므로
  // applyAction을 호출하지 않는다(전이는 submit 전용). 저장(PUT, articleId 포함) 성공 시 잠금 해제 + 빈 새 기사 탭으로 전환.
  // body는 toSaveDto가 tab.fields.body를 그대로 markupVersion으로 싣는다 — 텍스트 블록 재조립 없음(appendEmbedToBody로 들어온 값 보존).
  const saveMapping = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    if (!tab) return { ok: false, reason: 'no-tab' };
    const r = await model.saveArticle(toSaveDto(tab), tab.clientId); // PUT(articleId 포함) — 원본 미삭제(DB 비파괴).
    if (r && r.ok) {
      if (tab.articleId) await Promise.resolve(model.unlockArticle(tab.articleId, tab.clientId)).catch(() => {});
      resetTabToBlank(tab.id);
    }
    return r;
  }, [model, resetTabToBlank]);

  // 송고/보류/KILL/삭제승인. 신규(편집 컨텍스트 아님)는 전이 없이 RDS로 저장만 한다(news.md).
  // 편집 컨텍스트는 현재 편집 내용을 저장(PUT)한 뒤 생애주기 전이 → 성공 시 잠금 해제 + 빈 새 기사 탭으로 전환.
  // override(선택): 뷰가 만든 { body, title } 오버라이드(toSaveDto 계약 참조).
  const submit = useCallback(async (action, override) => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    if (!tab) return { ok: false, reason: 'no-tab' };

    if (!tab.articleId) {
      // 신규(create)는 누른 의도 action(send/hold)을 함께 넘긴다 — 서버 initialStatus가 Z+hold만 DDH로,
      // 그 외/송고는 RDS로 저장한다(전이 없음). 편집 경로(아래)는 action을 PUT에 싣지 않는다.
      const r = await model.saveArticle(toSaveDto(tab, override), tab.clientId, action);
      if (r && r.ok) resetTabToBlank(tab.id); // 작성 페이지 초기화.
      return r;
    }

    // 저장(PUT)이 실패하면 전이를 중단한다 — 저장 결과를 보지 않고 applyAction으로 넘어가면
    // (1) 방금 고친 본문이 서버에 없는 채로 옛 본문이 송고·배부되고(ADR-008 — 송고 성공 훅이 즉시
    // 스풀 파일을 쓰므로 되돌릴 수단이 없다), (2) 전이 성공 처리로 잠금 해제 + 탭 리셋이 일어나고
    // 호출부(WriterPage.onAction)가 clearDraft까지 실행해 편집분이 초안째 영구 소실된다.
    // 성공 판정은 ok === true(truthy 금지) — 모델/서버가 이상값을 줄 때 조용히 전이하면 안 된다.
    // 자동 재시도는 하지 않는다: not-holder/forbidden은 재시도해도 영구 실패이고, network-error 재시도는
    // 중복 저장(중복 이력·중복 배부 후보)을 만든다. 사용자 안내는 View 책임이라 사유 토큰만 돌려준다.
    // reject도 값으로 흡수한다(.catch(() => null)) — 그러지 않으면 submit이 그대로 reject해 호출부의 실패 안내
    // 결선이 통째로 건너뛰어지고("실패는 반드시 알린다" 계약 위반) 사용자는 아무 반응 없는 버튼만 본다.
    // 같은 파일의 lockArticle 획득과 같은 규율이다(모델 계약상 reject는 없지만 규율을 갈라 두지 않는다).
    const saved = await Promise.resolve(model.saveArticle(toSaveDto(tab, override), tab.clientId))
      .catch(() => null);
    if (!saved || saved.ok !== true) {
      return { ok: false, reason: 'save-failed', saveReason: (saved && saved.reason) ?? null };
    }
    const r = await model.applyAction(tab.articleId, action);
    if (r && r.ok) {
      await Promise.resolve(model.unlockArticle(tab.articleId, tab.clientId)).catch(() => {});
      resetTabToBlank(tab.id);
    }
    return r;
  }, [model, resetTabToBlank]);

  // 마운트 시 1회 — list.do에서 넘어온 pendingEdit(편집/고침/포털고침)를 소비해 편집 탭을 연다.
  useEffect(() => {
    let raw = null;
    try { raw = sessionStorage.getItem(PENDING_EDIT_KEY); }
    catch { raw = null; }
    if (!raw) return;
    try { sessionStorage.removeItem(PENDING_EDIT_KEY); }
    catch { /* 무시 */ }
    let req = null;
    try { req = JSON.parse(raw); }
    catch { req = null; }
    if (req && req.article && req.article.articleId) {
      openArticle(req.article, req.mode || 'edit');
    }
  }, [openArticle]);

  // 마운트 시 1회 — list.do에서 넘어온 pendingNew(후속/계속)를 소비해 원본 파생 신규 탭을 연다.
  // 편집 채널과 분리된 별도 채널 — 원본 잠금/편집 오인 없이 신규 생성 경로로 진입한다.
  useEffect(() => {
    let raw = null;
    try { raw = sessionStorage.getItem(PENDING_NEW_KEY); }
    catch { raw = null; }
    if (!raw) return;
    try { sessionStorage.removeItem(PENDING_NEW_KEY); }
    catch { /* 무시 */ }
    let req = null;
    try { req = JSON.parse(raw); }
    catch { req = null; }
    if (req && req.article && req.article.articleId
      && (req.mode === 'followUp' || req.mode === 'continue')) {
      openFromSource(req.article, req.mode);
    }
  }, [openFromSource]);

  // SSE 무효화(lock) 수신 → 내 편집 탭이 강제 해제(force-unlock)됐거나 다른 사용자에게 넘어갔는지(takeover)
  // 확인 후 자동 종료한다. 어느 경로든 해제 요청은 보내지 않는다(내 잠금이 아니거나 이미 해제됐다).
  useEffect(() => {
    const sub = model.subscribe({ scope: 'writer' }, async (signal) => {
      if (signal && signal.kind && signal.kind !== 'lock') return;
      const editTabs = tabsRef.current.filter((t) => t.articleId);
      if (editTabs.length === 0) return;
      const r = await model.queryArticles({});
      const list = (r && r.items) || [];
      const myUserId = userIdRef.current;
      const closing = []; // 닫을 탭 id — 강제 해제 + takeover를 모아 removeTabs 1회로 닫는다.
      const takenOver = [];
      for (const t of editTabs) {
        const a = list.find((x) => x.articleId === t.articleId);
        if (!a) continue; // 목록에 없으면 판단하지 않는다.
        // 강제 해제 — news.md가 정의한 기존 무음 자동 종료 계약(안내 없음).
        if (a.lockYN === 'N') { closing.push(t.id); continue; }
        // takeover — 잠금은 유지(lockYN='Y')되는데 보유자가 남이다. 이 탭의 입력은 어차피 저장될 수 없으므로
        // (서버가 not-holder로 거부한다) 좀비로 남기지 않고 닫되, 미저장 편집분이 사라진다는 사실을 안내한다.
        // 판정은 lockerUserId ↔ 내 userId 단독이다: lockerSessionId·lockerClientId는 phase51 step0이 응답
        // 투영에서 제거해 프로덕션 응답에 없고, lockedAt 변화는 같은 사람의 F5·재획득까지 오탐해 미저장 탭을
        // 닫는다. 같은 userId(내 다른 탭/재로그인)는 닫지 않는다 — 오탐의 대가가 편집분 소실이라 되돌릴 수 없다.
        // 신원 미상(내 userId 없음·레거시 NULL 잠금 행)도 닫지 않는다(fail-safe).
        if (myUserId && a.lockerUserId && a.lockerUserId !== myUserId) {
          closing.push(t.id);
          takenOver.push(t);
        }
      }
      // 한 번에 닫는다 — 탭마다 따로 호출하면 같은 tick 스냅샷 교체로 마지막 호출만 반영돼 좀비 탭이 남는다.
      const removed = new Set(removeTabs(closing, { unlock: false }).map((t) => t.id));
      // 안내는 takeover 경로에서만, 여러 탭이 걸려도 1회. 문구에는 "실제로 닫힌" 탭만 넣는다 —
      // 닫지 않은 탭까지 닫혔다고 말하면 사용자가 미저장 편집분을 잃은 줄 알고 그 탭을 버린다.
      // (removeTabs가 요청한 탭을 전부 닫는 지금은 항상 takenOver 전체지만, 문구의 출처를 "실제 제거 결과"로
      //  고정해 둔다 — 제거가 부분 성공으로 바뀌어도 안내가 사실에서 어긋나지 않는다.)
      const announce = takenOver.filter((t) => removed.has(t.id)).map((t) => t.articleId);
      if (announce.length) globalThis.alert?.(takeoverMessage(announce));
    });
    return () => sub.unsubscribe();
  }, [model, removeTabs]);

  // 브라우저(탭) 닫힘 → 열려 있는 편집 탭들의 잠금 해제 요청(news.md 편집 잠금 수명).
  useEffect(() => {
    const onUnload = () => {
      for (const t of tabsRef.current) {
        if (t.articleId) {
          try { model.unlockArticle(t.articleId, t.clientId); }
          catch { /* 언로드 중 — 실패는 무시 */ }
        }
      }
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [model]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  return {
    tabs, activeTabId, activeTab,
    addTab, closeTab, selectTab, openArticle, openFromSource,
    updateField, save, saveAsNew, submit, saveMapping,
    queryArticles, searchArticles,
  };
}
