// 기사 작성페이지(writer.do) 컨트롤러 — 다중 작성 탭(sessionStorage 보존)·편집 진입 컨텍스트·
// 매핑(편집가능/읽기전용)·편집 잠금 수명·송고/보류/KILL/삭제승인을 보유한다. 모든 데이터는 Model 경유.
//
// 편집 잠금 수명(news.md): 편집 탭을 열면 lock 획득, list.do로 이동해도 해제하지 않는다.
// 해제 시점 = 탭 닫기(×)/송고·보류·KILL·삭제승인 성공/브라우저 탭 닫힘(pagehide·beforeunload).
// 강제 해제(force-unlock) 수신 시 해당 편집 탭은 자동 종료한다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '../app/context.js';
import { PENDING_EDIT_KEY } from './useViewController.js';

const TABS_KEY = 'yh.writer.tabs';

// 후속/계속(원본에서 파생한 신규 기사 작성)을 list.do→writer.do로 넘기는 sessionStorage 채널.
// 페이로드 shape: { article, mode }(mode ∈ 'followUp'|'continue'). 편집 채널(PENDING_EDIT_KEY)과 분리한다
// — 원본 잠금·편집 탭 오인을 막기 위함이다. useViewController(step2)가 쓰고, 여기서 마운트 시 1회 소비한다.
export const PENDING_NEW_KEY = 'yh.pendingNew';

// 편집 진입 시 입력란에 채우는(편집 가능) 필드 vs 읽기전용으로 보존하는 필드 (news.md 매핑).
// 공통정보 확장(공동작성/지역/속성/키워드/내부·외부코멘트) + 첨부파일/자료파일(업로드 후 path 문자열 보관).
const EDITABLE_FIELDS = [
  'title', 'body', 'author', 'embargoAt', 'secondEmbargoAt',
  'coAuthor', 'region', 'attribute', 'keyword', 'internalComment', 'externalComment',
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

function pick(src, keys) {
  const out = {};
  for (const k of keys) if (src && src[k] !== undefined && src[k] !== null) out[k] = src[k];
  return out;
}

// 탭 편집 필드 → 서버 영속 dto. 본문은 서버가 저장하는 키(markupVersion)로 싣고 body 키는 보내지 않는다
// (server ARTICLE_FIELDS와 일치 — body로 보내면 본문이 통째로 유실된다). role은 어디서도 싣지 않는다(ADR-004).
function toSaveDto(tab) {
  const { body, ...rest } = tab.fields;
  const dto = { ...rest, markupVersion: body };
  if (tab.articleId) dto.articleId = tab.articleId;
  return dto;
}

// 편집 가능 필드의 빈 시드(blankTab) — EDITABLE_FIELDS를 단일 출처로 삼아 새 공통정보 필드도 자동 포함된다.
function blankFields() {
  const out = {};
  for (const k of EDITABLE_FIELDS) out[k] = '';
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

function blankTab() {
  return {
    id: nextTabId(),
    mode: 'new', // 편집 진입 컨텍스트: new / edit / revise / portalRevise (버튼 표시 규칙이 의존 — step12)
    articleId: null,
    status: null, // 진입 상태(RDS/DDH/DPS…) — 송고/보류/KILL 버튼 표시 규칙이 사용한다(writerButtons).
    fields: blankFields(),
    readOnly: {},
  };
}

// 편집 진입 — 제목/본문/작성자/엠바고/2차엠바고는 입력란에 채우고, 나머지 메타는 읽기전용으로 보존한다.
function tabFromArticle(article, mode, fallbackAuthor) {
  return {
    id: nextTabId(),
    mode,
    articleId: article.articleId,
    status: article.status ?? null,
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
function loadTabs() {
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
  const first = blankTab();
  return { tabs: [first], activeTabId: first.id };
}

export function useWriteController() {
  const { model, identity, replace } = useAppContext();

  const seed = useRef(null);
  if (seed.current === null) seed.current = loadTabs();

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

  // 탭 제거(공통) — unlock=true면 편집 탭 잠금 해제 요청. 마지막 탭을 닫으면 빈 새 기사 탭 1개를 유지.
  const removeTab = useCallback((id, { unlock = true } = {}) => {
    const cur = tabsRef.current;
    const closing = cur.find((t) => t.id === id);
    if (unlock && closing && closing.articleId) {
      Promise.resolve(model.unlockArticle(closing.articleId)).catch(() => {});
    }
    let next = cur.filter((t) => t.id !== id);
    if (next.length === 0) next = [blankTab()];
    setTabs(next);
    if (activeRef.current === id) setActiveTabId(next[next.length - 1].id);
  }, [model]);

  const closeTab = useCallback((id) => removeTab(id, { unlock: true }), [removeTab]);

  // 편집 탭을 빈 새 기사 탭으로 전환(같은 자리·같은 탭 id 유지) — 송고/보류/KILL/삭제승인 성공 후.
  const resetTabToBlank = useCallback((id) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...blankTab(), id: t.id } : t)));
  }, []);

  const addTab = useCallback(() => {
    const t = blankTab();
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
    const lock = await Promise.resolve(model.lockArticle(article.articleId, lockAction)).catch(() => null);
    if (lock && lock.ok === false && lock.reason === 'locked') {
      globalThis.alert?.('편집중입니다.');
      return null; // 다른 세션이 편집 중 — 탭을 열지 않는다.
    }

    const tab = tabFromArticle(full, mode, identity && identity.name);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab.id;
  }, [identity, model]);

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
  const save = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    if (!tab) return { ok: false, reason: 'no-tab' };
    const r = await model.saveArticle(toSaveDto(tab));
    if (r && r.ok && r.articleId && !tab.articleId) {
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, articleId: r.articleId } : t)));
    }
    return r;
  }, [model]);

  // 매핑 저장 — 본문 텍스트는 그대로(readOnly) 두고 추가된 임베드만 PUT으로 저장한다. 생애주기 전이가 없으므로
  // applyAction을 호출하지 않는다(전이는 submit 전용). 저장(PUT, articleId 포함) 성공 시 잠금 해제 + 빈 새 기사 탭으로 전환.
  // body는 toSaveDto가 tab.fields.body를 그대로 markupVersion으로 싣는다 — 텍스트 블록 재조립 없음(appendEmbedToBody로 들어온 값 보존).
  const saveMapping = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    if (!tab) return { ok: false, reason: 'no-tab' };
    const r = await model.saveArticle(toSaveDto(tab)); // PUT(articleId 포함) — 원본 미삭제(DB 비파괴).
    if (r && r.ok) {
      if (tab.articleId) await Promise.resolve(model.unlockArticle(tab.articleId)).catch(() => {});
      resetTabToBlank(tab.id);
    }
    return r;
  }, [model, resetTabToBlank]);

  // 송고/보류/KILL/삭제승인. 신규(편집 컨텍스트 아님)는 전이 없이 RDS로 저장만 한다(news.md).
  // 편집 컨텍스트는 현재 편집 내용을 저장(PUT)한 뒤 생애주기 전이 → 성공 시 잠금 해제 + 빈 새 기사 탭으로 전환.
  const submit = useCallback(async (action) => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    if (!tab) return { ok: false, reason: 'no-tab' };

    if (!tab.articleId) {
      const r = await model.saveArticle(toSaveDto(tab));
      if (r && r.ok) resetTabToBlank(tab.id); // 작성 페이지 초기화.
      return r;
    }

    await model.saveArticle(toSaveDto(tab));
    const r = await model.applyAction(tab.articleId, action);
    if (r && r.ok) {
      await Promise.resolve(model.unlockArticle(tab.articleId)).catch(() => {});
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

  // SSE 무효화(lock) 수신 → 내 편집 탭이 강제 해제됐는지 확인 후 자동 종료(잠금 해제 요청은 보내지 않음).
  useEffect(() => {
    const sub = model.subscribe({ scope: 'writer' }, async (signal) => {
      if (signal && signal.kind && signal.kind !== 'lock') return;
      const editTabs = tabsRef.current.filter((t) => t.articleId);
      if (editTabs.length === 0) return;
      const r = await model.queryArticles({});
      const list = (r && r.items) || [];
      for (const t of editTabs) {
        const a = list.find((x) => x.articleId === t.articleId);
        if (a && a.lockYN === 'N') removeTab(t.id, { unlock: false });
      }
    });
    return () => sub.unsubscribe();
  }, [model, removeTab]);

  // 브라우저(탭) 닫힘 → 열려 있는 편집 탭들의 잠금 해제 요청(news.md 편집 잠금 수명).
  useEffect(() => {
    const onUnload = () => {
      for (const t of tabsRef.current) {
        if (t.articleId) {
          try { model.unlockArticle(t.articleId); }
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
    updateField, save, submit, saveMapping,
  };
}
