// 기사 조회페이지(list.do) 컨트롤러 — 4개 메뉴 필터·부서 드롭다운·페이징(10)·SSE 실시간 재조회와
// 우클릭 액션(편집/고침·포털고침 진입, Lock해제, 삭제요청)을 보유한다. 모든 데이터는 Model 경유(ADR-003).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppContext } from '../app/context.js';

// list.do 우클릭에서 writer.do로 편집 진입할 때 대상 기사·진입 모드를 넘기는 sessionStorage 채널.
// 모드는 URL에 싣지 않는다(편집 탭 주소창엔 기사아이디만) — useWriteController가 읽고 소비한다.
export const PENDING_EDIT_KEY = 'yh.pendingEdit';

export const VIEW_MENUS = Object.freeze(['deskUnsent', 'deptWrite', 'deptSend', 'personal', 'killArticles', 'embargoMgmt']);
export const PAGE_SIZE = 10;

// 메뉴별 조회 필터 (news.md 기사 조회페이지).
// 데스크 미송고: RDS·DDH / 부서별 작성: DPS·RRH 제외 / 부서별 송고: DPS만 / 개인별 수정: 로그인 작성자, RDS·RRK
// / KILL기사: RRK·DDK·EEK(부서 무관 전체 KILL 목록) / 엠바고 관리: EPS(부서 무관 전체 EPS 목록).
// 부서 다중 선택(departments)은 데스크 미송고·부서별 작성·부서별 송고에서 지원하며, 기본값은 '전체'(부서 미지정)다.
export function buildMenuFilter(menu, identity, departments) {
  const depts = (departments && departments.length) ? departments : null; // null/[] = '전체'(부서 미지정)
  switch (menu) {
    case 'killArticles':
      // KILL 결과 상태: R의 RRK, D/Z의 DDK, EPS의 EEK. 부서 무관 전체 목록(부서 키 없이 status만 — personal 패턴).
      return { status: ['RRK', 'DDK', 'EEK'] };
    case 'embargoMgmt':
      // 엠바고 송고 대기(EPS) 목록. 부서 무관 전체 EPS 목록(부서 키 없이 status만 — killArticles 패턴).
      return { status: ['EPS'] };
    case 'deptWrite': {
      const f = { excludeStatus: ['DPS', 'RRH'] };
      if (depts) f.departments = depts;
      return f;
    }
    case 'deptSend': {
      const f = { status: ['DPS'] };
      if (depts) f.departments = depts;
      return f;
    }
    case 'personal':
      return { author: (identity && (identity.name || identity.userId)) || undefined, status: ['RDS', 'RRK'] };
    case 'deskUnsent':
    default: {
      const f = { status: ['RDS', 'DDH'] };
      if (depts) f.departments = depts;
      return f;
    }
  }
}

function canManage(identity) {
  const role = identity && identity.role;
  return role === 'D' || role === 'Z';
}

export function useViewController() {
  const { model, identity, navigate } = useAppContext();
  const [menu, setMenu] = useState('deskUnsent');
  const [departments, setDepartments] = useState(null); // null/[] = '전체'(부서 미지정) — 3개 메뉴 공통 기본값
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [deptOptions, setDeptOptions] = useState([]);
  const [live, setLive] = useState(false); // SSE 실제 연결 상태(ready→true, error/해제→false).

  const filter = useMemo(
    () => buildMenuFilter(menu, identity, departments),
    [menu, identity, departments],
  );

  const refresh = useCallback(async () => {
    const r = await model.queryArticles(filter);
    setItems((r && r.items) || []);
    return r;
  }, [model, filter]);

  // 메뉴/부서 변경 시 재조회 (진입 시 자동 조회 포함).
  useEffect(() => { refresh(); }, [refresh]);

  // 부서 드롭다운 데이터 — 사용자 목록에서 부서명을 도출(중복 제거).
  useEffect(() => {
    let alive = true;
    Promise.resolve(model.queryUsers()).then((r) => {
      if (!alive) return;
      const depts = [...new Set(((r && r.items) || []).map((u) => u.department).filter(Boolean))];
      setDeptOptions(depts);
    });
    return () => { alive = false; };
  }, [model]);

  // SSE 무효화 신호 → 자기 필터로 재조회한다(ADR-005, 행 데이터 push 받지 않음).
  // onStatus로 실제 연결 상태를 받아 live에 반영한다(상태바가 하드코딩이 아니라 진짜 SSE 상태를 보여주게).
  useEffect(() => {
    setLive(false);
    const sub = model.subscribe(filter, () => { refresh(); }, setLive);
    return () => { setLive(false); sub.unsubscribe(); };
  }, [model, filter, refresh]);

  const selectMenu = useCallback((m) => {
    setMenu(m);
    setDepartments(null);
    setPage(1);
  }, []);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));

  // 목록이 축소되면(SSE 재조회·필터 변경 등) page가 [1, totalPages]를 벗어나 빈 페이지에 갇힐 수 있다.
  // items 변경 후 범위를 넘은 page만 끌어내린다. 함수형 업데이트로 동일값이면 React가 리렌더를 생략하므로
  // page를 의존성에 넣지 않아 무한 루프가 없다(selectMenu의 setPage(1) 리셋·정상 페이지 이동은 보존).
  useEffect(() => {
    const max = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    setPage((p) => Math.min(p, max));
  }, [items]);

  const pageItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // 편집 진입 — 이동 전에 편집 잠금을 먼저 획득한다. 다른 세션이 편집 중(locked)이면
  // '편집중입니다.' ALERT만 띄우고 현재(목록) 페이지에 그대로 머문다(writer.do로 이동하지 않음).
  // 잠금에 성공하면 대상·모드를 sessionStorage로 넘기고 writer.do로 이동한다(편집 탭 주소창엔 기사아이디).
  // 고침/포털고침은 lock action으로 구분(서버 editDps D 게이트). 매핑도 전이 없는 'revise' 잠금을 재사용한다.
  // 실제 인가는 서버 POST :id/lock 게이트가 강제한다(신뢰경계=서버, ADR-004) — 여기선 충돌(locked) UX만 담당.
  const enterEditor = useCallback(async (article, mode) => {
    const lockAction = mode === 'portalRevise' ? 'portalRevise' : 'revise';
    const lock = await Promise.resolve(model.lockArticle(article.articleId, lockAction)).catch(() => null);
    if (lock && lock.ok === false && lock.reason === 'locked') {
      globalThis.alert?.('편집중입니다.');
      return null; // 다른 세션이 편집 중 — 이동하지 않고 목록에 그대로 머문다.
    }
    try {
      sessionStorage.setItem(PENDING_EDIT_KEY, JSON.stringify({ article, mode }));
    } catch {
      // sessionStorage 불가 — pendingEdit 없이 이동(writer가 빈 탭으로 시작).
    }
    navigate('writer.do', { articleId: article.articleId });
    return article.articleId;
  }, [model, navigate]);

  const editArticle = useCallback((article) => enterEditor(article, 'edit'), [enterEditor]);
  const reviseArticle = useCallback(
    (article, portal = false) => enterEditor(article, portal ? 'portalRevise' : 'revise'),
    [enterEditor],
  );

  // 매핑(mapping) — 기존 기사를 임베드 전용 제한 편집 모드로 writer.do에 연다(step11).
  // 편집 진입과 동일한 채널(sessionStorage + navigate, 직접 fetch 없음 — ADR-003). 잠금/저장 인가는 서버가 강제.
  const mapArticle = useCallback((article) => enterEditor(article, 'mapping'), [enterEditor]);

  // Lock해제(강제) — D/Z만, '해제하시겠습니까?' 확인 후. 권한 없으면 no-op(서버도 거부).
  const releaseLock = useCallback(async (article) => {
    if (!canManage(identity)) return { ok: false, reason: 'forbidden' };
    if (!globalThis.confirm || !globalThis.confirm('해제하시겠습니까?')) {
      return { ok: false, reason: 'cancelled' };
    }
    return model.forceUnlockArticle(article.articleId);
  }, [model, identity]);

  // 상세보기 — 목록 행은 Contents 전용(본문 markupVersion 없음)이라, 상세보기 직전에
  // model.getArticle(id)로 본문(Article.markupVersion)·제목까지 갖춘 전체 기사를 가져온다(ADR-003).
  // 서버 GET :id는 { ok, article, contents } shape. contents의 공통정보 위에 article을 마지막에 펼쳐
  // markupVersion·title이 Article 값으로 우선되게 한다(본문 첫 줄=제목 렌더가 살아난다).
  const loadDetail = useCallback(async (articleId) => {
    const r = await model.getArticle(articleId);
    if (!r || r.ok === false) return null;
    return { ...(r.contents || {}), ...(r.article || {}) };
  }, [model]);

  // 이력보기/송고이력보기 — 읽기 전용. 확인창 없이 model.queryHistory(ADR-003)로 이력 행을 가져온다.
  // sendOnly면 송고 이력만(서버 도메인 필터). 이력이 없으면 빈 배열을 반환한다(오류 아님 — step0 전제).
  const loadHistory = useCallback(async (article, { sendOnly = false } = {}) => {
    const r = await model.queryHistory(article.articleId, { sendOnly });
    return (r && r.items) || [];
  }, [model]);

  // 후속기사작성 — model.deriveArticle(id, 'followUp')로 새 기사를 만든 뒤 그 새 기사로 편집 진입(ADR-003).
  // 원본은 비변경(서버 deriveArticle이 create 위임으로만 신규 행 생성). 새 기사는 RDS·미잠금이라 잠금 획득이 정상 동작.
  const createFollowUp = useCallback(async (article) => {
    const r = await model.deriveArticle(article.articleId, 'followUp');
    if (r && r.ok && r.articleId) await enterEditor({ articleId: r.articleId }, 'edit');
    return r;
  }, [model, enterEditor]);

  // 계속기사작성 — 동일하되 'continue' 모드(본문 복사). 새 기사로 편집 진입.
  const createContinue = useCallback(async (article) => {
    const r = await model.deriveArticle(article.articleId, 'continue');
    if (r && r.ok && r.articleId) await enterEditor({ articleId: r.articleId }, 'edit');
    return r;
  }, [model, enterEditor]);

  // 재송 — 이미 송고된 DPS 기사를 다시 송고. '재송하시겠습니까?' 확인 후 model.applyAction(id, 'send').
  // role 미전송(ADR-004) — 서버가 DPS+권한·송고 '(끝)' 마커 가드를 강제. 취소 시 아무것도 전송하지 않는다(news.md 140행).
  const resend = useCallback(async (article) => {
    if (!globalThis.confirm || !globalThis.confirm('재송하시겠습니까?')) {
      return { ok: false, reason: 'cancelled' };
    }
    return model.applyAction(article.articleId, 'send');
  }, [model]);

  // 번역 — model.translate(id, targetLang)로 서버가 DB 본문을 조회·번역(ADR-003, 직접 fetch 없음).
  // 외부 실패/키 없음이면 서버가 throw 없이 graceful 객체({ ok:false, reason, translatedText:<원문> })를 준다 —
  // 그대로 반환하고 표시는 View(ListPage)가 원문+안내로 처리한다(news.md degrade). 컨트롤러는 가공/throw하지 않는다.
  const runTranslate = useCallback(async (article, targetLang = 'ko') => {
    return model.translate(article.articleId, targetLang);
  }, [model]);

  // 삭제요청 — DPS 기사 삭제 승인(approveDelete). D/Z만, '정말 삭제하시겠습니까?' 확인 후.
  const requestDelete = useCallback(async (article) => {
    if (!canManage(identity)) return { ok: false, reason: 'forbidden' };
    if (!globalThis.confirm || !globalThis.confirm('정말 삭제하시겠습니까?')) {
      return { ok: false, reason: 'cancelled' };
    }
    return model.applyAction(article.articleId, 'approveDelete');
  }, [model, identity]);

  return {
    menu, selectMenu,
    departments, setDepartments, deptOptions,
    page, setPage, totalPages, pageItems, items,
    live,
    refresh,
    editArticle, reviseArticle, releaseLock, requestDelete, loadHistory, loadDetail,
    createFollowUp, createContinue, resend, runTranslate, mapArticle,
  };
}
