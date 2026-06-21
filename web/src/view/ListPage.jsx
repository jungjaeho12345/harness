// 기사 조회페이지(list.do) — 실시간 SSE 목록(우상단 상태바), 4개 메뉴, 10개 페이징,
// 우클릭 컨텍스트 메뉴, 상태 배지 색, 헤더 우클릭 컬럼 설정 모달, 행 클릭 시 상세보기 새 창(720×800).
// 모든 데이터/액션은 useViewController 경유(transport 직접 호출 금지, ADR-003).

import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../app/context.js';
import { useViewController, VIEW_MENUS } from '../controller/useViewController.js';
import { ContextMenu } from './ContextMenu.jsx';
import { statusBadge } from './statusBadge.js';
import { formatCell } from './listFormat.js';
import {
  COLUMNS, loadColumnConfig, saveColumnConfig, toggleColumn, setGap, visibleColumns,
} from './columnConfig.js';
import { renderDetailHtml } from './articleDetail.js';
import { blocksToText, deserialize } from './editorContent.js';
import { formatDateTime } from './listFormat.js';

const MENU_LABELS = {
  deskUnsent: '데스크 미송고',
  deptWrite: '부서별 작성',
  deptSend: '부서별 송고',
  personal: '개인별 수정',
  killArticles: 'KILL기사',
  embargoMgmt: '엠바고 관리',
};

// 상세보기 — 새 창 720×800에 이스케이프된 HTML을 쓴다(스크립트 실행 불가).
// 목록 행(article)은 Contents 전용이라 본문(markupVersion)이 없어 제목·본문이 안 보인다 →
// loadDetail(컨트롤러)로 본문까지 갖춘 전체 기사를 가져와 렌더한다. 팝업 차단을 피하려
// 클릭 즉시(동기) 빈 창을 먼저 열고, 본문을 받은 뒤 write한다.
async function openDetail(article, loadDetail) {
  const w = window.open('', '_blank', 'width=720,height=800');
  if (!w || !w.document) return;
  let full = article;
  try {
    const f = await loadDetail(article.articleId);
    if (f) full = f;
  } catch { /* 조회 실패 — 목록 행만으로 폴백 렌더 */ }
  w.document.open();
  w.document.write(renderDetailHtml(full));
  w.document.close();
}

function copyText(text) {
  try { navigator.clipboard?.writeText(String(text ?? '')); }
  catch { /* 클립보드 불가 — 무시 */ }
}

export function ListPage() {
  const { identity } = useAppContext();
  const ctrl = useViewController();
  const {
    menu, selectMenu, departments, setDepartments, deptOptions, refresh,
    live,
    page, setPage, totalPages, pageItems,
    editArticle, reviseArticle, releaseLock, requestDelete, loadHistory, loadDetail,
    createFollowUp, createContinue, resend, runTranslate, mapArticle,
  } = ctrl;

  const [ctx, setCtx] = useState(null); // 우클릭 컨텍스트 메뉴 { article, x, y }
  const [colConfig, setColConfig] = useState(() => loadColumnConfig(menu));
  const [showColModal, setShowColModal] = useState(false);
  // 이력보기/송고이력보기 모달 { title, items } — null이면 닫힘. (step8, 컬럼 설정 모달과 동일 패턴)
  const [historyModal, setHistoryModal] = useState(null);
  // 번역 결과 모달 { text, ok, reason } — null이면 닫힘. (step10, in-app 모달 — React 자동 escape, 새 창 아님)
  const [translateModal, setTranslateModal] = useState(null);

  // 메뉴별 컬럼 설정 로드(설정은 메뉴별로 저장 — columnConfig).
  useEffect(() => { setColConfig(loadColumnConfig(menu)); }, [menu]);

  const cols = visibleColumns(colConfig);

  // 이력보기/송고이력보기 — 컨트롤러로 이력을 조회(model.queryHistory 경유, ADR-003)해 모달로 표시.
  // 모달 렌더는 React가 escape하므로 별도 HTML 이스케이프 불필요(새 창이 아닌 in-app 모달).
  const showHistory = async (article, title, sendOnly) => {
    const rows = await loadHistory(article, { sendOnly });
    setHistoryModal({ title, items: rows });
  };

  // 번역 — 컨트롤러로 model.translate(ADR-003)를 호출해 in-app 모달로 표시(이력 모달과 동일 패턴, React 자동 escape).
  // graceful degrade(news.md): 키 없음/외부 실패(ok:false)면 throw·오류 모달이 아니라 원문(translatedText)+안내를 보여준다.
  const showTranslate = async (article) => {
    const r = await runTranslate(article);
    setTranslateModal({ text: (r && r.translatedText) || '', ok: !!(r && r.ok), reason: r && r.reason });
  };

  const onCtxSelect = async (key, article) => {
    switch (key) {
      case 'edit': editArticle(article); break;
      case 'reviseNoPortal': reviseArticle(article, false); break;
      case 'revisePortal': reviseArticle(article, true); break;
      case 'mapping': mapArticle(article); break;
      case 'requestDelete': requestDelete(article); break;
      case 'releaseLock': releaseLock(article); break;
      case 'detail': await openDetail(article, loadDetail); break;
      case 'history': showHistory(article, '이력보기', false); break;
      case 'sendHistory': showHistory(article, '송고이력보기', true); break;
      // 번역 — 결과를 in-app 모달로 표시. 실패해도 throw 없이 원문+안내(showTranslate가 graceful 처리).
      case 'translate': await showTranslate(article); break;
      // 후속/계속기사작성 — deriveArticle이 만든 새 기사로 편집 진입(컨트롤러). 원본 비파괴.
      case 'followUp': createFollowUp(article); break;
      case 'continue': createContinue(article); break;
      // 재송 — 확인 후 send 재송고. 실패 reason(no-end-marker 등)은 서버가 강제하므로 사용자에게 ALERT 안내(news.md 72행).
      case 'resend': {
        const r = await resend(article);
        if (r && !r.ok && r.reason && r.reason !== 'cancelled') {
          globalThis.alert?.(`재송에 실패했습니다: ${r.reason}`);
        }
        break;
      }
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
    if (col.key === 'createdAt' || col.key === 'editedAt' || col.key === 'sentAt') {
      return <span className="yh-col--time">{formatCell(col.key, row[col.key])}</span>;
    }
    return formatCell(col.key, row[col.key]);
  };

  const showDeptSelector = menu === 'deskUnsent' || menu === 'deptWrite' || menu === 'deptSend';

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
        {/* 실시간 상태바 — 컨트롤러의 실제 SSE 연결 상태(live)를 표시한다. 끊기면 EventSource가 자동 재연결(ADR-005). */}
        <span
          className={`yh-live ${live ? 'yh-live--on' : ''}`}
          data-testid="live-status"
          title={live ? '실시간 연결됨' : '실시간 연결 끊김 — 자동 재연결 시도 중'}
        >
          <span className="yh-live__dot" /> {live ? '실시간' : '연결 끊김'}
        </span>
      </div>

      {showDeptSelector && (
        <div className="yh-dept-bar" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <DeptSelector
            options={deptOptions}
            selected={departments}
            onChange={setDepartments}
          />
          {/* 명시적 조회 버튼(news.md 81행) — 선택한 부서로 재조회. 진입/변경 시 자동조회는 컨트롤러가 유지. */}
          <button type="button" className="yh-btn yh-btn--primary" onClick={() => refresh()}>조회</button>
        </div>
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
              onClick={() => openDetail(row, loadDetail)}
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

      {historyModal && (
        <div className="yh-modal__backdrop" onClick={() => setHistoryModal(null)}>
          <div className="yh-modal" role="dialog" aria-label={historyModal.title} onClick={(e) => e.stopPropagation()}>
            <h2>{historyModal.title}</h2>
            {historyModal.items.length === 0 ? (
              <p className="yh-history__empty">이력이 없습니다.</p>
            ) : (
              <table className="yh-table yh-history__table">
                <thead>
                  <tr>
                    <th>시각</th>
                    <th>종류</th>
                    <th>전이</th>
                    <th>작성자</th>
                  </tr>
                </thead>
                <tbody>
                  {historyModal.items.map((h, i) => (
                    <tr key={h.id ?? i}>
                      <td>{formatDateTime(h.createdAt)}</td>
                      <td>{h.eventType ?? h.action ?? ''}</td>
                      <td>{h.fromStatus || h.toStatus ? `${h.fromStatus ?? ''}→${h.toStatus ?? ''}` : ''}</td>
                      <td>{h.actorUserId ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <button type="button" className="yh-btn yh-btn--primary" onClick={() => setHistoryModal(null)}>닫기</button>
          </div>
        </div>
      )}

      {translateModal && (
        <div className="yh-modal__backdrop" onClick={() => setTranslateModal(null)}>
          <div className="yh-modal" role="dialog" aria-label="번역" onClick={(e) => e.stopPropagation()}>
            <h2>번역</h2>
            {/* graceful degrade(news.md): 키 없음/외부 실패면 원문 표시 + 안내(오류 모달/throw 아님). */}
            {!translateModal.ok && (
              <p className="yh-translate__notice">번역을 사용할 수 없습니다(원문 표시).</p>
            )}
            {/* React가 자동 escape하므로 별도 HTML 이스케이프 불필요(새 창이 아닌 in-app 모달). */}
            <pre className="yh-translate__text">{translateModal.text}</pre>
            <button type="button" className="yh-btn yh-btn--primary" onClick={() => setTranslateModal(null)}>닫기</button>
          </div>
        </div>
      )}
    </main>
  );
}

// 부서 선택 — Select 드롭다운 + 내부 체크박스 멀티셀렉트(데스크 미송고·부서별 작성·부서별 송고 공통).
// 트리거 버튼을 누르면 패널이 열리고, '전체' 체크박스는 select-all로 동작한다(누르면 전 부서로 리셋).
// '전체'는 기본 체크(빈 선택=전 부서)다. 빈 선택일 때 모든 부서 박스도 체크로 보인다(select-all 느낌).
// 개별 부서를 끄면 좁혀지고, 모두 다시 켜면 '전체'로 돌아온다. 변경 시 컨트롤러가 자동 재조회한다
// (빈 선택/전 부서 선택 = 부서 미지정 = 전 부서 조회). 바깥 클릭 시 패널을 닫는다.
function DeptSelector({ options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const sel = selected || [];
  // '전체' = 전 부서. 빈 선택(기본) 또는 모든 부서 선택을 똑같이 '전체'로 본다.
  const isAll = sel.length === 0 || (options.length > 0 && options.every((d) => sel.includes(d)));
  const toggle = (dept) => {
    // '전체(빈 선택)'에서 개별 부서를 누르면 전 부서를 출발점으로 그 부서만 토글한다.
    const set = new Set(sel.length === 0 ? options : sel);
    if (set.has(dept)) set.delete(dept); else set.add(dept);
    onChange([...set]);
  };

  // 바깥 클릭 시 닫기 — 패널이 열려 있을 때만 리스너를 단다.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 트리거에 보여줄 현재 선택 요약.
  const summary = isAll ? '전체' : sel.length === 1 ? sel[0] : `${sel.length}개 부서`;

  return (
    <div className="yh-dept-selector" data-testid="dept-selector" ref={ref}>
      <button
        type="button"
        className="yh-dept-select__trigger"
        data-testid="dept-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>부서: {summary}</span>
        <span className="yh-dept-select__caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        // 체크박스 멀티선택 묶음이므로 listbox(option 자식 기대)가 아니라 group으로 둔다.
        <div className="yh-dept-select__panel" role="group" aria-label="부서 선택">
          <label className="yh-dept-select__option">
            <input type="checkbox" checked={isAll} onChange={() => onChange([])} />
            전체
          </label>
          {options.map((d) => (
            <label key={d} className="yh-dept-select__option">
              <input type="checkbox" checked={isAll || sel.includes(d)} onChange={() => toggle(d)} />
              {d}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default ListPage;
