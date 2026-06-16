// 기사 조회페이지(list.do) 컨트롤러 — 4개 메뉴 필터·부서 드롭다운·페이징(10)·SSE 실시간 재조회와
// 우클릭 액션(편집/고침·포털고침 진입, Lock해제, 삭제요청)을 보유한다. 모든 데이터는 Model 경유(ADR-003).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppContext } from '../app/context.js';

// list.do 우클릭에서 writer.do로 편집 진입할 때 대상 기사·진입 모드를 넘기는 sessionStorage 채널.
// 모드는 URL에 싣지 않는다(편집 탭 주소창엔 기사아이디만) — useWriteController가 읽고 소비한다.
export const PENDING_EDIT_KEY = 'yh.pendingEdit';

export const VIEW_MENUS = Object.freeze(['deskUnsent', 'deptWrite', 'deptSend', 'personal']);
export const PAGE_SIZE = 10;

// 메뉴별 조회 필터 (news.md 기사 조회페이지).
// 데스크 미송고: RDS·DDH / 부서별 작성: 해당 부서, DPS·RRH 제외 / 부서별 송고: DPS만, 부서 다중 /
// 개인별 수정: 로그인 작성자, RDS·RRK.
export function buildMenuFilter(menu, identity, departments) {
  const myDept = identity && identity.department;
  switch (menu) {
    case 'deptWrite': {
      const sel = (departments && departments.length) ? departments : (myDept ? [myDept] : []);
      const f = { excludeStatus: ['DPS', 'RRH'] };
      if (sel.length) f.departments = sel;
      return f;
    }
    case 'deptSend': {
      const f = { status: ['DPS'] };
      if (departments && departments.length) f.departments = departments; // '전체'면 부서 미지정
      return f;
    }
    case 'personal':
      return { author: (identity && (identity.name || identity.userId)) || undefined, status: ['RDS', 'RRK'] };
    case 'deskUnsent':
    default:
      return { status: ['RDS', 'DDH'] };
  }
}

function canManage(identity) {
  const role = identity && identity.role;
  return role === 'D' || role === 'Z';
}

export function useViewController() {
  const { model, identity, navigate } = useAppContext();
  const [menu, setMenu] = useState('deskUnsent');
  const [departments, setDepartments] = useState(null); // null = 메뉴 기본값(부서별 작성=내 부서)
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [deptOptions, setDeptOptions] = useState([]);

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
  useEffect(() => {
    const sub = model.subscribe(filter, () => { refresh(); });
    return () => sub.unsubscribe();
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

  // 편집 진입 — 대상 기사·모드를 sessionStorage로 넘기고 writer.do로 이동(편집 탭 주소창엔 기사아이디).
  const enterEditor = useCallback((article, mode) => {
    try {
      sessionStorage.setItem(PENDING_EDIT_KEY, JSON.stringify({ article, mode }));
    } catch {
      // sessionStorage 불가 — pendingEdit 없이 이동(writer가 빈 탭으로 시작).
    }
    navigate('writer.do', { articleId: article.articleId });
  }, [navigate]);

  const editArticle = useCallback((article) => enterEditor(article, 'edit'), [enterEditor]);
  const reviseArticle = useCallback(
    (article, portal = false) => enterEditor(article, portal ? 'portalRevise' : 'revise'),
    [enterEditor],
  );

  // Lock해제(강제) — D/Z만, '해제하시겠습니까?' 확인 후. 권한 없으면 no-op(서버도 거부).
  const releaseLock = useCallback(async (article) => {
    if (!canManage(identity)) return { ok: false, reason: 'forbidden' };
    if (!globalThis.confirm || !globalThis.confirm('해제하시겠습니까?')) {
      return { ok: false, reason: 'cancelled' };
    }
    return model.forceUnlockArticle(article.articleId);
  }, [model, identity]);

  // 삭제요청 — DPS 기사 삭제 승인(approveDelete). D/Z만, '정말 삭제하시겠습니까?' 확인 후.
  const requestDelete = useCallback(async (article) => {
    if (!canManage(identity)) return { ok: false, reason: 'forbidden' };
    if (!globalThis.confirm || !globalThis.confirm('정말 삭제하시겠습니까?')) {
      return { ok: false, reason: 'cancelled' };
    }
    return model.applyAction(article.articleId, 'approveDelete');
  }, [model, identity]);

  // 이력보기/송고이력보기 — Model 계약 경유로 이력을 조회한다(직접 fetch 금지, ADR-003).
  // 반환은 Model 응답({ ok, items })을 그대로 — ListPage가 새 창에 렌더한다.
  const viewHistory = useCallback(
    (article) => model.getArticleHistory(article.articleId),
    [model],
  );
  const viewSendHistory = useCallback(
    (article) => model.getSendHistory(article.articleId),
    [model],
  );

  return {
    menu, selectMenu,
    departments, setDepartments, deptOptions,
    page, setPage, totalPages, pageItems, items,
    refresh,
    editArticle, reviseArticle, releaseLock, requestDelete,
    viewHistory, viewSendHistory,
  };
}
