// 기사 조회페이지(list.do) — 실시간 SSE 목록(우상단 상태바), 4개 메뉴, 10개 페이징,
// 우클릭 컨텍스트 메뉴, 상태 배지 색, 헤더 우클릭 컬럼 설정 모달, 행 클릭 시 상세보기 새 창(720×800).
// 모든 데이터/액션은 useViewController 경유(transport 직접 호출 금지, ADR-003).

import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../app/context.js';
import { useViewController, visibleMenus } from '../controller/useViewController.js';
import { ContextMenu } from './ContextMenu.jsx';
import { statusBadge } from './statusBadge.js';
import { formatCell, rangeInstant, setDateFormat } from './listFormat.js';
import { loadEditorPrefs } from './editorPrefs.js';
import {
  COLUMNS, loadColumnConfig, saveColumnConfig, toggleColumn, setGap, visibleColumns,
} from './columnConfig.js';
import { renderDetailHtml } from './articleDetail.js';
import { blocksToText, deserialize } from './editorContent.js';
import {
  HISTORY_COLUMNS, loadHistoryColumnConfig, saveHistoryColumnConfig,
  toggleHistoryColumn, visibleHistoryColumns, historyCellText,
} from './historyColumns.js';

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
  // 날짜형식 적용과 동일한 call-site prefs 패턴 — 뷰어 브라우저의 byline(작성자 부가 라인)을 주입한다.
  w.document.write(renderDetailHtml(full, loadEditorPrefs().byline));
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
    live, setDistributedRange,
    page, setPage, totalPages, pageItems,
    editArticle, reviseArticle, releaseLock, requestDelete, loadHistory, loadDetail,
    createFollowUp, createContinue, resend, runTranslate, mapArticle,
  } = ctrl;

  const [ctx, setCtx] = useState(null); // 우클릭 컨텍스트 메뉴 { article, x, y }
  const [colConfig, setColConfig] = useState(() => loadColumnConfig(menu));
  const [showColModal, setShowColModal] = useState(false);
  // 이력보기/송고이력보기 모달 { title, kind, article, items } — null이면 닫힘. (컬럼 설정 모달과 동일 패턴)
  // kind('history'|'sendHistory')는 컬럼 설정 저장 스코프, article은 우클릭한 목록 행 객체 그대로
  // (기사 그룹 컬럼 값의 출처 — 추가 조회 없음, phase 56 news.md 114~115행).
  const [historyModal, setHistoryModal] = useState(null);
  // 이력 모달의 컬럼 설정 — 모달을 '열 때' loadHistoryColumnConfig(kind)로 세팅한다(이력 종류별 영속).
  const [histColConfig, setHistColConfig] = useState(null);
  // '이력 목록설정' 모달 열림 여부 — 이력 모달 콘텐츠 우클릭으로 연다.
  const [showHistoryColModal, setShowHistoryColModal] = useState(false);
  // 번역 결과 모달 { text, ok, reason } — null이면 닫힘. (step10, in-app 모달 — React 자동 escape, 새 창 아님)
  const [translateModal, setTranslateModal] = useState(null);
  // 배부시간 범위 조회조건 입력(news.md 12행, phase 57 MVP-4) — 로컬 state가 진실이다(컨트롤러는
  // setDistributedRange만 노출한다: 저장값은 ISO, 입력값은 datetime-local로 형이 다르다).
  // 반영은 '배부시간 조회' 클릭 시에만 — 타이핑마다 컨트롤러 상태를 갱신하면 필터 정체성이 바뀔 때마다
  // 재조회+SSE 재구독이 폭주한다. 메뉴 전환은 언마운트가 아니라 입력값이 화면에 유지된다(step10 유지 계약).
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  // 직전에 '적용한' ISO 범위(rangeInstant 출력 그대로 — 문자열 또는 undefined). 값이 실제로 바뀌면
  // filter 변경 → 기존 재조회 effect가 조회를 수행하므로 여기서 refresh()를 부르면 이전 filter
  // 클로저로 조회가 1건 더 나간다(중복 요청). 값이 그대로면 effect가 돌지 않으므로 그때만 명시
  // 재조회한다('배부시간 조회' 버튼의 재조회 보장 계약 — 서버 상태 캐시가 아니라 입력값 기록일 뿐이다).
  const appliedRangeRef = useRef({ from: undefined, to: undefined });

  // 메뉴별 컬럼 설정 로드(설정은 메뉴별로 저장 — columnConfig).
  useEffect(() => { setColConfig(loadColumnConfig(menu)); }, [menu]);

  // 저장된 날짜형식을 적용한다(환경설정 모달은 저장만, 적용은 여기서 — news.md 에디터 환경설정 > 날짜형식).
  useEffect(() => { setDateFormat(loadEditorPrefs().dateFormat); }, []);

  const cols = visibleColumns(colConfig);

  // 이력보기/송고이력보기 — 컨트롤러로 이력을 조회(model.queryHistory 경유, ADR-003)해 모달로 표시.
  // 모달 렌더는 React가 escape하므로 별도 HTML 이스케이프 불필요(새 창이 아닌 in-app 모달).
  // title/version/status는 서버 파생 값을 표시만 한다(뷰에서 계산 금지 — 단일 출처는 백엔드 historyMeta).
  const showHistory = async (article, title, kind) => {
    const rows = await loadHistory(article, { sendOnly: kind === 'sendHistory' });
    setHistColConfig(loadHistoryColumnConfig(kind));
    setShowHistoryColModal(false);
    setHistoryModal({ title, kind, article, items: rows });
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
      case 'history': showHistory(article, '이력보기', 'history'); break;
      case 'sendHistory': showHistory(article, '송고이력보기', 'sendHistory'); break;
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

  // 이력 모달 컬럼 토글 — state 갱신 + 이력 종류(kind)별 즉시 저장(toggleCol과 동일 패턴).
  const toggleHistCol = (key) => {
    const next = toggleHistoryColumn(histColConfig, key);
    setHistColConfig(next);
    saveHistoryColumnConfig(historyModal.kind, next);
  };

  // 이력 모달을 닫는 모든 경로에서 설정 모달도 함께 닫는다(고아 모달 금지).
  const closeHistoryModal = () => {
    setHistoryModal(null);
    setShowHistoryColModal(false);
  };

  const histCols = historyModal && histColConfig ? visibleHistoryColumns(histColConfig) : [];

  const renderCell = (col, row) => {
    if (col.key === 'status') {
      const b = statusBadge(row.status);
      return (
        <span className="yh-badge" data-testid="status-badge" style={{ background: b.bg, color: b.fg }}>
          {b.label}
        </span>
      );
    }
    if (col.key === 'createdAt' || col.key === 'editedAt' || col.key === 'sentAt' || col.key === 'distributedAt') {
      return <span className="yh-col--time">{formatCell(col.key, row[col.key])}</span>;
    }
    return formatCell(col.key, row[col.key]);
  };

  const showDeptSelector = menu === 'deskUnsent' || menu === 'deptWrite' || menu === 'deptSend'
    || menu === 'killArticles' || menu === 'embargoMgmt';

  // 조회조건 — 배부시간 범위 적용(값 변환은 listFormat.rangeInstant 단일 출처 — 화면에서 문자열을
  // 직접 이어 붙이지 않는다). 입력을 비우고 조회하면 rangeInstant가 undefined를 돌려줘 조건이 필터에서
  // 빠진다(해제 경로). 비교는 from·to 둘 다 본다 — 한쪽만 보면 to만 바뀐 클릭이 잘못 분기된다.
  const applyDistributedRange = () => {
    const from = rangeInstant(fromInput, 'from');
    const to = rangeInstant(toInput, 'to');
    const applied = appliedRangeRef.current;
    const changed = applied.from !== from || applied.to !== to;
    appliedRangeRef.current = { from, to };
    setDistributedRange(from, to);
    // 값이 바뀌면 refresh()를 부르지 않는다 — 이 시점의 refresh는 이전 filter 클로저라 범위가 빠진
    // 필터로 조회 1건이 낭비되고, 새 필터 조회는 filter 변경 → 기존 effect가 수행한다.
    // 값이 같으면 effect가 돌지 않으므로 명시 재조회한다(조회 버튼의 재조회 보장 — L849 계약).
    if (!changed) refresh();
  };

  return (
    <main className="yh-page">
      <div className="yh-list-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="yh-menubar" data-testid="menubar">
          {/* 엠바고 관리는 권한 D, Z에게만 노출(visibleMenus) — TopBar의 Z 전용 링크와 동일 패턴. */}
          {visibleMenus(identity).map((m) => (
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

      {/* 조회조건 — 배부시간 범위(news.md 12행). 전 메뉴 공통 노출(개인별 수정 포함 — 12행은 메뉴를 한정하지
          않는다). 입력은 로컬 state, 반영은 '배부시간 조회' 클릭 시에만(타이핑마다 필터가 바뀌면 재조회·SSE
          재구독이 폭주한다). 값 변환은 listFormat.rangeInstant 단일 출처. */}
      <div className="yh-dept-bar" data-testid="dist-range-bar" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label htmlFor="dist-range-from">배부시간 시작</label>
        <input
          id="dist-range-from"
          type="datetime-local"
          value={fromInput}
          onChange={(e) => setFromInput(e.target.value)}
        />
        <label htmlFor="dist-range-to">배부시간 종료</label>
        <input
          id="dist-range-to"
          type="datetime-local"
          value={toInput}
          onChange={(e) => setToInput(e.target.value)}
        />
        <button type="button" className="yh-btn yh-btn--primary" onClick={applyDistributedRange}>배부시간 조회</button>
      </div>

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
        <div className="yh-modal__backdrop" onClick={closeHistoryModal}>
          {/* 우클릭 진입점은 콘텐츠 컨테이너 전체 — 이력 0건/컬럼 0개로 표가 없어도 목록설정에 진입할 수 있다. */}
          <div
            className="yh-modal"
            role="dialog"
            aria-label={historyModal.title}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => { e.preventDefault(); setShowHistoryColModal(true); }}
          >
            <h2>{historyModal.title}</h2>
            {historyModal.items.length === 0 ? (
              <p className="yh-history__empty">이력이 없습니다.</p>
            ) : histCols.length === 0 ? (
              <p className="yh-history__empty">표시할 컬럼이 없습니다 — 우클릭 목록설정에서 선택하세요.</p>
            ) : (
              <table className="yh-table yh-history__table">
                <thead>
                  <tr>
                    {histCols.map((c) => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {historyModal.items.map((h, i) => (
                    <tr key={h.id ?? i}>
                      {/* 상태는 배지가 아니라 텍스트 — 목록 테이블의 status-badge 단수 조회와 충돌하지 않는다. */}
                      {histCols.map((c) => <td key={c.key}>{historyCellText(c.key, h, historyModal.article)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <button type="button" className="yh-btn yh-btn--primary" onClick={closeHistoryModal}>닫기</button>
          </div>
        </div>
      )}

      {/* 이력 목록설정 — 이력 모달의 '형제'로, JSX상 이력 모달 '뒤'에 둔다: 백드롭 z-index가 60 단일 값이라
          형제 중 DOM 뒤쪽이 위에 그려진다(CSS 무변경 — DOM 순서로만 해결). 자식으로 넣으면 백드롭 클릭이
          이력 모달 백드롭으로 버블링돼 함께 닫히고, 설정 모달 안 우클릭이 부모 onContextMenu를 재발화시킨다. */}
      {historyModal && showHistoryColModal && (
        <div className="yh-modal__backdrop" onClick={() => setShowHistoryColModal(false)}>
          <div className="yh-modal" role="dialog" aria-label="이력 목록설정" onClick={(e) => e.stopPropagation()}>
            <h2>이력 목록설정</h2>
            {HISTORY_COLUMNS.map((c) => (
              <label key={c.key} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={!!histColConfig.visible[c.key]}
                  onChange={() => toggleHistCol(c.key)}
                />
                {c.label}
              </label>
            ))}
            <button type="button" className="yh-btn yh-btn--primary" onClick={() => setShowHistoryColModal(false)}>닫기</button>
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
