// 배부 대상 관리페이지(distMgmt.do, 권한 Z 전용) — 배부 수신처(언론사/비언론사) 조회/등록/수정/비활성 (ADR-008).
// 삭제 없음 — 비활성(soft delete)만 있다. 비활성 행도 목록에 남고, 수정 폼의 활성 select로 되돌린다(DB 비파괴).
// spoolDir는 문자열 저장일 뿐 — 이 화면은 폴더를 만들거나 파일을 다루지 않는다(스풀 쓰기는 phase 47 — ADR-008).
// 비-Z 접근은 App 라우트 가드가 list.do로 보내지만, 실제 인가 강제는 서버 Z 게이트다(ADR-004 — 프론트 가드는 UX).

import { useEffect, useState } from 'react';
import { useDistMgmtController } from '../controller/useDistMgmtController.js';
import { createReasonMessage } from './mgmtMessages.js';
import { formatDateTime } from './listFormat.js';

const BLANK = { name: '', kind: 'press', spoolDir: '', active: 'Y' };

// 유형 표시 라벨 — 미지의 값은 원문 그대로 보여준다(서버가 진실이고, 화면이 값을 숨기지 않는다).
const KIND_LABEL = { press: '언론사', nonpress: '비언론사' };

// 서버 거부 사유(distributionTargetService) → 사용자 문구. 검증의 진실은 서버이며 여기서는 안내만 한다.
// 공통 토큰(unauthenticated·internal-error·network-error·invalid-response)은 mgmtMessages가 갖고,
// 여기서는 이 화면 전용 문구만 얹는다. 모듈 스코프에서 1회 생성한다(렌더마다 재생성 금지).
const reasonMessage = createReasonMessage({
  forbidden: '권한이 없습니다. 배부 대상 관리는 관리자(Z) 전용입니다.',
  'not-found': '대상을 찾을 수 없습니다. 목록을 새로 조회해 주세요.',
  'invalid-name': '수신처명을 확인해 주세요(1~100자).',
  'invalid-kind': '유형은 언론사 또는 비언론사만 가능합니다.',
  'invalid-spool-dir': '스풀 폴더명을 확인해 주세요(소문자 영문·숫자로 시작, 영문·숫자와 - _ 만, 1~64자).',
  'duplicate-spool-dir': '이미 사용 중인 스풀 폴더명입니다. 다른 이름을 입력해 주세요.',
  'invalid-active': '활성 값은 Y 또는 N만 가능합니다.',
  // 배부 실패 재전송·수동 tick(phase 57 MVP-4) — 판정의 진실은 서버(distributionRetryService·tickService).
  'no-failure': '이미 처리된 실패입니다. 목록을 새로 조회해 주세요.',
  'kind-changed': '수신처 유형이 실패 당시와 달라졌습니다. 유형을 되돌린 뒤 재전송하거나 새로 배부해 주세요.',
  'status-changed': '기사 상태가 배부할 수 없는 상태로 바뀌었습니다(KILL·보류·삭제 승인).',
  'spool-write-failed': '스풀 기록에 실패했습니다. 서버 스풀 설정을 확인해 주세요.',
  'spool-disabled': '배부 스풀이 설정되지 않았습니다(DIST_SPOOL_DIR).',
  'tick-failed': '배부 실행 중 서버 오류가 발생했습니다.',
  inactive: '비활성 수신처입니다. 먼저 활성화한 뒤 재전송해 주세요.',
});

// 재전송 버튼을 누를 수 없는 사유(행 텍스트로도 보여준다 — 왜 못 누르는지 알 수 없는 버튼 금지).
// 서버가 진실이며(inactive·kind-changed 거부) 이 판정은 이중 방어 UX일 뿐이다(ADR-004).
// targetKind가 null이면 대상 행 자체가 사라진 방어 분기다 — 유형 변경 오안내가 되지 않게 먼저 가른다.
function retryDisableReason(f) {
  if (f.targetKind === null || f.targetKind === undefined) {
    return '수신처 정보를 찾을 수 없습니다. 목록을 새로 조회해 주세요.';
  }
  if (f.targetActive !== 'Y') return '비활성 수신처입니다. 먼저 활성화한 뒤 재전송해 주세요.';
  if (f.targetKind !== f.kind) {
    return '수신처 유형이 실패 당시와 달라졌습니다. 유형을 되돌린 뒤 재전송하거나 새로 배부해 주세요.';
  }
  return '';
}

export function DistMgmtPage() {
  const {
    targets, refresh, createTarget, updateTarget, deactivateTarget,
    failures, refreshFailures, retryTarget, runTick,
  } = useDistMgmtController();
  const [form, setForm] = useState(BLANK);
  // 수정 대상 id — 폼 입력이 아니라 행 객체에서 받는다(문자열화 없이 숫자 그대로 서버·계약의 엄격 비교에 맞춘다).
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');
  // 제출 in-flight 가드 — 더블클릭이 같은 폼으로 두 번 POST해 중복 행을 만드는 것을 막는다(서버 유일성 검사 없음).
  const [submitting, setSubmitting] = useState(false);
  // 실패 섹션 전용 메시지 — 대상 폼의 error와 분리한다(한쪽 실패가 다른 쪽 표시를 덮지 않게).
  const [failError, setFailError] = useState('');
  // 재전송 in-flight 가드(historyId) — 스풀에 나간 파일은 회수할 수 없으므로 연타 중복 전송을 막는다.
  const [retryingId, setRetryingId] = useState(null);
  // 수동 tick — 실행 중 가드 + 결과 요약(건수 중심)/오류 문구.
  const [ticking, setTicking] = useState(false);
  const [tickResult, setTickResult] = useState(null);
  const [tickError, setTickError] = useState('');

  // 진입 시 조회 실패도 표시한다 — 이 refresh만 조회 실패 메시지를 띄운다. 쓰기 핸들러의 내부
  // 재조회 결과는 관찰하지 않는다(관찰하면 성공한 재조회가 쓰기 실패 메시지를 지우는 회귀가 생긴다).
  useEffect(() => {
    let alive = true; // 언마운트(cleanup) 후 setState 금지.
    (async () => {
      const r = await refresh();
      if (alive && (!r || r.ok !== true)) setError(reasonMessage(r && r.reason));
    })();
    return () => { alive = false; };
  }, [refresh]);

  // 진입 시 실패 목록도 함께 조회한다(진입 조회 정책은 View 소유 — 컨트롤러에 자동 조회 없음).
  // 주기 재조회·폴링은 두지 않는다(ADR-008 (3)) — 갱신은 재전송/tick 후 컨트롤러의 직접 재조회뿐이다.
  useEffect(() => {
    let alive = true; // 언마운트(cleanup) 후 setState 금지.
    (async () => {
      const r = await refreshFailures();
      if (alive && (!r || r.ok !== true)) setFailError(reasonMessage(r && r.reason));
    })();
    return () => { alive = false; };
  }, [refreshFailures]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const editing = editingId !== null;

  const startEdit = (t) => {
    setEditingId(t.id);
    setForm({
      name: t.name ?? '', kind: t.kind ?? 'press', spoolDir: t.spoolDir ?? '', active: t.active ?? 'Y',
    });
    setError('');
  };

  const reset = () => { setForm(BLANK); setEditingId(null); setError(''); };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      // id는 body에 싣지 않는다 — 대상 식별은 URL(PUT /:id)이 하고, 서버는 id를 수정 대상 필드로 받지 않는다.
      const r = editing ? await updateTarget(editingId, form) : await createTarget(form);
      if (r && r.ok) { reset(); return; }
      setError(reasonMessage(r && r.reason)); // 실패 시 입력값을 유지해 고쳐서 재제출할 수 있게 한다.
    } finally {
      setSubmitting(false); // 실패해도 반드시 푼다 — 가드는 in-flight 동안만 유효하다.
    }
  };

  // 확인 대화상자를 두지 않는다 — 비활성은 되돌릴 수 있는 조작이다(행이 남고 '수정' 폼의 활성 select로 재활성화).
  const onDeactivate = async (t) => {
    const r = await deactivateTarget(t.id);
    setError(r && r.ok ? '' : reasonMessage(r && r.reason));
  };

  // 재전송은 되돌릴 수 없다(스풀 파일이 나가면 회수 수단이 없다) — 위 '비활성'과 달리 confirm을 둔다.
  // 중복 배부 경고는 서버 파생 플래그(kindDistributed)만 근거로 쓴다 — 화면이 배부 여부를 계산하지 않는다.
  const onRetry = async (f) => {
    if (retryingId !== null) return; // in-flight 가드 — disabled 우회 경로까지 막는다.
    const warn = f.kindDistributed === false
      ? '\n주의: 이 종류는 아직 미배부로 기록돼 있어 다음 배부 실행(tick)이 전 대상에 배부할 수 있습니다. 지금 재전송하면 이 수신처만 두 번 받을 수 있습니다.'
      : '';
    const target = f.targetName ?? f.targetId;
    if (!globalThis.confirm(`'${f.articleId}' 기사를 '${target}' 수신처로 재전송할까요? 스풀에 나간 파일은 회수할 수 없습니다.${warn}`)) return;
    setRetryingId(f.historyId);
    try {
      const r = await retryTarget(f.articleId, f.targetId);
      setFailError(r && r.ok ? '' : reasonMessage(r && r.reason));
    } finally {
      setRetryingId(null); // 실패해도 반드시 푼다 — 가드는 in-flight 동안만 유효하다.
    }
  };

  // 수동 tick도 실제 배부를 유발한다 — confirm을 둔다. 결과는 건수 중심 요약만 표시한다.
  const onTick = async () => {
    if (ticking) return; // in-flight 가드.
    if (!globalThis.confirm('배부를 지금 실행할까요? 엠바고가 도래한 기사가 실제로 배부됩니다.')) return;
    setTicking(true);
    try {
      const r = await runTick();
      if (r && r.ok) {
        setTickResult(r);
        setTickError('');
      } else {
        setTickResult(null);
        setTickError(reasonMessage(r && r.reason));
      }
    } finally {
      setTicking(false); // 실패해도 반드시 푼다.
    }
  };

  return (
    <main className="yh-page">
      <h1>배부 대상 관리</h1>

      <form className="yh-card" onSubmit={onSubmit} data-testid="dist-form">
        <div className="yh-field">
          <label htmlFor="dist-name">수신처명</label>
          <input id="dist-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="dist-kind">유형</label>
          <select id="dist-kind" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="press">언론사</option>
            <option value="nonpress">비언론사</option>
          </select>
        </div>
        <div className="yh-field">
          <label htmlFor="dist-spool">스풀 폴더</label>
          <input
            id="dist-spool"
            value={form.spoolDir}
            onChange={(e) => set('spoolDir', e.target.value)}
            placeholder="예: gana-ilbo"
          />
          <small>소문자 영문·숫자로 시작 · 영문·숫자와 - _ 만 · 1~64자 (배부 스풀 하위 폴더명)</small>
        </div>
        <div className="yh-field">
          <label htmlFor="dist-active">활성</label>
          <select id="dist-active" value={form.active} onChange={(e) => set('active', e.target.value)}>
            <option value="Y">Y</option>
            <option value="N">N</option>
          </select>
        </div>
        <button type="submit" className="yh-btn yh-btn--primary" disabled={submitting}>{editing ? '수정' : '생성'}</button>
        {editing && (
          <button type="button" className="yh-btn" onClick={reset}>취소</button>
        )}
        {error && <p role="alert" data-testid="dist-error">{error}</p>}
      </form>

      <table className="yh-table">
        <thead>
          <tr><th>수신처명</th><th>유형</th><th>스풀 폴더</th><th>활성</th><th></th></tr>
        </thead>
        <tbody>
          {targets.map((t) => (
            <tr key={t.id} data-testid={`dist-row-${t.id}`}>
              <td>{t.name}</td>
              <td>{KIND_LABEL[t.kind] ?? t.kind}</td>
              <td>{t.spoolDir}</td>
              <td>{t.active}</td>
              <td>
                <button type="button" className="yh-btn" onClick={() => startEdit(t)}>수정</button>
                {t.active === 'Y' && (
                  <button type="button" className="yh-btn" onClick={() => onDeactivate(t)}>비활성</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 수동 tick(ADR-008 (3)) — 실행 트리거는 외부 cron과 Z의 이 명시 조작뿐이다(타이머·자동 폴링 금지). */}
      <section className="yh-card" data-testid="dist-tick-section">
        <h2>배부 실행</h2>
        <button type="button" className="yh-btn yh-btn--primary" onClick={onTick} disabled={ticking}>
          배부 실행(tick)
        </button>
        {tickResult && (
          <p data-testid="dist-tick-summary">
            {tickResult.skipped === 'in-progress'
              ? '이미 실행 중입니다. 잠시 후 다시 확인해 주세요.'
              : `스캔 ${tickResult.scanned}건 · 배부 ${tickResult.distributed.length}건 · 실패 ${tickResult.failed.length}건`}
          </p>
        )}
        {tickError && <p role="alert" data-testid="dist-tick-error">{tickError}</p>}
      </section>

      {/* 미해소 배부 실패 — 목록·해소 판정의 단일 출처는 서버 파생이다(화면 필터·중복 제거·해소 판정 금지).
          spoolDir·파일 경로는 서버가 주지 않으며 화면에서도 만들어 내지 않는다(응답 위생). */}
      <section className="yh-card" data-testid="dist-fail-section">
        <h2>미해소 배부 실패</h2>
        {failError && <p role="alert" data-testid="dist-fail-error">{failError}</p>}
        {failures.length === 0 ? (
          <p>배부 실패가 없습니다.</p>
        ) : (
          <table className="yh-table">
            <thead>
              <tr><th>기사아이디</th><th>수신처</th><th>유형</th><th>사유</th><th>실패시각</th><th></th></tr>
            </thead>
            <tbody>
              {failures.map((f) => {
                const hint = retryDisableReason(f);
                return (
                  <tr key={f.historyId} data-testid={`dist-fail-row-${f.historyId}`}>
                    <td>{f.articleId}</td>
                    <td>{f.targetName ?? f.targetId}</td>
                    <td>{KIND_LABEL[f.kind] ?? f.kind}</td>
                    <td>{f.reason}</td>
                    <td>{formatDateTime(f.failedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="yh-btn"
                        disabled={retryingId !== null || hint !== ''}
                        onClick={() => onRetry(f)}
                      >
                        재전송
                      </button>
                      {hint && <small>{hint}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

export default DistMgmtPage;
