// 기사 조회페이지(list.do) — 실시간 SSE 목록(우상단 상태바), 4개 메뉴, 10개 페이징,
// 우클릭 컨텍스트 메뉴, 상태 배지 색, 헤더 우클릭 컬럼 설정 모달, 행 클릭 시 상세보기 새 창(720×800).
// 모든 데이터/액션은 useViewController 경유(transport 직접 호출 금지, ADR-003).

import { useEffect, useState } from 'react';
import { useAppContext } from '../app/context.js';
import { useViewController, VIEW_MENUS } from '../controller/useViewController.js';
import { ContextMenu } from './ContextMenu.jsx';
import { statusBadge } from './statusBadge.js';
import { formatCell } from './listFormat.js';
import {
  COLUMNS, loadColumnConfig, saveColumnConfig, toggleColumn, setGap, visibleColumns,
} from './columnConfig.js';
import { renderDetailHtml } from './articleDetail.js';
import { renderHistoryHtml } from './historyView.js';
import { blocksToText, deserialize } from './editorContent.js';

const MENU_LABELS = {
  deskUnsent: '데스크 미송고',
  deptWrite: '부서별 작성',
  deptSend: '부서별 송고',
  personal: '개인별 수정',
};

// 상세보기 — 새 창 720×800에 이스케이프된 HTML을 쓴다(스크립트 실행 불가).
function openDetail(article) {
  const w = window.open('', '_blank', 'width=720,height=800');
  if (!w || !w.document) return;
  w.document.write(renderDetailHtml(article));
  w.document.close();
}

// 이력보기/송고이력보기 — 상세보기와 같은 새 창 패턴(720×800).
// 팝업 차단 회피: window.open은 클릭 핸들러 안에서 동기적으로 먼저 호출해 창 핸들을 얻은 뒤,
// async 조회(load)가 끝나면 그 창에 write한다(await 후 open 금지 — 사용자 제스처 컨텍스트 소실).
function openHistory(article, kind, load) {
  const w = window.open('', '_blank', 'width=720,height=800');
  if (!w || !w.document) return;
  Promise.resolve(load(article)).then((res) => {
    const items = (res && res.items) || [];
    w.document.write(renderHistoryHtml(items, { title: article.title, kind }));
    w.document.close();
  }).catch(() => {
    w.document.write(renderHistoryHtml([], { title: article.title, kind }));
    w.document.close();
  });
}

function copyText(text) {
  try { navigator.clipboard?.writeText(String(text ?? '')); }
  catch { /* 클립보드 불가 — 무시 */ }
}

export function ListPage() {
  const { identity } = useAppContext();
  const ctrl = useViewController();
  const {
    menu, selectMenu, departments, setDepartments, deptOptions,
    page, setPage, totalPages, pageItems,
    editArticle, reviseArticle, releaseLock, requestDelete,
    viewHistory, viewSendHistory,
  } = ctrl;

  const [ctx, setCtx] = useState(null); // 우클릭 컨텍스트 메뉴 { article, x, y }
  const [colConfig, setColConfig] = useState(() => loadColumnConfig(menu));
  const [showColModal, setShowColModal] = useState(false);

  // 메뉴별 컬럼 설정 로드(설정은 메뉴별로 저장 — columnConfig).
  useEffect(() => { setColConfig(loadColumnConfig(menu)); }, [menu]);

  const cols = visibleColumns(colConfig);

  const onCtxSelect = (key, article) => {
    switch (key) {
      case 'edit': editArticle(article); break;
      case 'reviseNoPortal': reviseArticle(article, false); break;
      case 'revisePortal': reviseArticle(article, true); break;
      case 'requestDelete': requestDelete(article); break;
      case 'releaseLock': releaseLock(article); break;
      case 'detail': openDetail(article); break;
      case 'history': openHistory(article, 'history', viewHistory); break;
      case 'sendHistory': openHistory(article, 'sendHistory', viewSendHistory); break;
      case 'copyBody': copyText(blocksToText(deserialize(article.markupVersion ?? article.body ?? article.content ?? ''))); break;
      case 'copyTitle': copyText(article.title); break;
      default: break; // 비활성(표시만) 항목은 onSelect로 오지 않는다.
    }
  };

  const toggleCol = (key) => {
    const next = toggleColumn(colConfig, key);
    setColConfig(next);
    saveColumnConfig(menu, next);
  };

  const changeGap = (gap) => {
    const next = setGap(colConfig, gap);
    setColConfig(next);
    saveColumnConfig(menu, next);
  };

  const renderCell = (col, row) => {
    if (col.key === 'status') {
      const b = statusBadge(row.status);
      return (
        <span className="yh-badge" data-testid="status-badge" style={{ background: b.bg, color: b.fg }}>
          {b.label}
        </span>
      );
    }
    if (col.key === 'createdAt' || col.key === 'editedAt') {
      return <span className="yh-col--time">{formatCell(col.key, row[col.key])}</span>;
    }
    return formatCell(col.key, row[col.key]);
  };

  const showDeptSelector = menu === 'deptWrite' || menu === 'deptSend';

  return (
    <main className="yh-page">
      <div className="yh-list-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="yh-menubar" data-testid="menubar">
          {VIEW_MENUS.map((m) => (
            <button
              key={m}
              type="button"
              className={`yh-btn ${menu === m ? 'yh-btn--primary' : ''}`}
              onClick={() => selectMenu(m)}
            >
              {MENU_LABELS[m]}
            </button>
          ))}
        </div>
        {/* 실시간 상태바 — SSE 구독(컨트롤러). 끊기면 EventSource가 자동 재연결(ADR-005). */}
        <span className="yh-live yh-live--on" data-testid="live-status">
          <span className="yh-live__dot" /> 실시간
        </span>
      </div>

      {showDeptSelector && (
        <DeptSelector
          menu={menu}
          options={deptOptions}
          selected={departments}
          onChange={setDepartments}
        />
      )}

      <table className="yh-table">
        <thead>
          <tr onContextMenu={(e) => { e.preventDefault(); setShowColModal(true); }}>
            {cols.map((c) => <th key={c.key} style={{ paddingLeft: colConfig.gap, paddingRight: colConfig.gap }}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {pageItems.map((row) => (
            <tr
              key={row.articleId}
              onClick={() => openDetail(row)}
              onContextMenu={(e) => { e.preventDefault(); setCtx({ article: row, x: e.clientX, y: e.clientY }); }}
            >
              {cols.map((c) => (
                <td key={c.key} style={{ paddingLeft: colConfig.gap, paddingRight: colConfig.gap }}>
                  {renderCell(c, row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="yh-pager" data-testid="pager">
        <button type="button" className="yh-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>이전</button>
        <span>{page} / {totalPages}</span>
        <button type="button" className="yh-btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>다음</button>
      </div>

      {ctx && (
        <ContextMenu
          menu={menu}
          article={ctx.article}
          identity={identity}
          position={{ x: ctx.x, y: ctx.y }}
          onSelect={onCtxSelect}
          onClose={() => setCtx(null)}
        />
      )}

      {showColModal && (
        <div className="yh-modal__backdrop" onClick={() => setShowColModal(false)}>
          <div className="yh-modal" role="dialog" aria-label="컬럼 설정" onClick={(e) => e.stopPropagation()}>
            <h2>컬럼 설정</h2>
            {COLUMNS.map((c) => (
              <label key={c.key} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={!!colConfig.visible[c.key]}
                  onChange={() => toggleCol(c.key)}
                />
                {c.label}
              </label>
            ))}
            <div className="yh-field">
              <label htmlFor="col-gap">컬럼 간격(px)</label>
              <input
                id="col-gap"
                type="number"
                value={colConfig.gap}
                onChange={(e) => changeGap(e.target.value)}
              />
            </div>
            <button type="button" className="yh-btn yh-btn--primary" onClick={() => setShowColModal(false)}>닫기</button>
          </div>
        </div>
      )}
    </main>
  );
}

// 부서 선택 — '전체' 토글 + 체크박스 멀티셀렉트(부서별 송고/작성). 변경 시 컨트롤러가 자동 재조회.
function DeptSelector({ menu, options, selected, onChange }) {
  const sel = selected || [];
  const isAll = sel.length === 0;
  const toggle = (dept) => {
    const set = new Set(sel);
    if (set.has(dept)) set.delete(dept); else set.add(dept);
    onChange([...set]);
  };
  return (
    <div className="yh-dept-selector" data-testid="dept-selector">
      <label>
        <input
          type="checkbox"
          checked={isAll}
          onChange={() => onChange(menu === 'deptSend' ? [] : null)}
        />
        전체
      </label>
      {options.map((d) => (
        <label key={d}>
          <input type="checkbox" checked={sel.includes(d)} onChange={() => toggle(d)} />
          {d}
        </label>
      ))}
    </div>
  );
}

export default ListPage;
