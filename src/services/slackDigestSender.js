// Slack 다이제스트 전송 어댑터 — 다이제스트를 #harness Incoming Webhook으로 전송한다 (26-realtime-log-viewer step3).
// (CLAUDE.md: "각 작업이 끝날 때마다 slack의 harness 채널로 내용 전달".)
//
// 무의존: @slack/* 등 라이브러리 없이 Node 내장 전역 fetch만 쓴다(ADR 최소 의존성).
// 시크릿(webhook URL)은 코드에 하드코딩하지 않고 런타임 env로만 주입한다.
//   - webhookUrl 미설정 → no-op으로 안전 완결(throw 금지 — URL/토큰 없이도 코드가 돈다).
//   - 설정 시 fetchFn(기본 전역 fetch)으로 { text } POST. 전송 실패는 삼켜서 스케줄러를 방해하지 않는다.

// 순수 포맷터: 다이제스트 → 사람이 읽을 텍스트. Slack 마크다운은 최소로.
//   대상 날짜·total·레벨별 카운트 요약 + 최근 라인 일부를 담는다.
export function formatDigest(digest = {}) {
  const date = digest.date ?? '';
  const total = digest.total ?? 0;
  const byLevel = digest.byLevel ?? {};
  const lines = Array.isArray(digest.lines) ? digest.lines : [];

  const levelSummary = Object.keys(byLevel).length
    ? Object.entries(byLevel).map(([lvl, n]) => `${lvl}: ${n}`).join(', ')
    : '(없음)';

  // 미리보기는 최근 20개 라인만(전송 페이로드 비대 방지 — total/byLevel이 전수 요약을 제공).
  const preview = lines.slice(-20);
  const header = `:page_facing_up: 로그 다이제스트 ${date} — 총 ${total}건 (${levelSummary})`;
  const body = preview.length ? `\n\`\`\`\n${preview.join('\n')}\n\`\`\`` : '';
  return header + body;
}

export function createSlackDigestSender({
  webhookUrl,
  fetchFn = globalThis.fetch,
  formatDigest: fmt = formatDigest,
  log, // 선택: 관측용 로거(예: logService.log). 미주입 시 조용히 no-op.
} = {}) {
  // 다이제스트 하나를 전송한다. 항상 { ok } 결과를 반환하고 절대 throw하지 않는다(스케줄러 격리).
  return async function sendDigest(digest) {
    if (!webhookUrl) {
      // no-op 완결 — webhook URL 미설정 시 라이브 배달은 건너뛴다(코드는 정상 완료).
      if (log) log('INFO', 'digest: Slack webhook 미설정 — 전송 생략(no-op)');
      return { ok: false, reason: 'no-webhook' };
    }
    try {
      const res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fmt(digest) }),
      });
      return { ok: true, status: res && res.status };
    } catch (e) {
      // 전송 실패를 삼킨다 — Slack 장애가 스케줄러를 죽이면 안 된다.
      if (log) log('WARN', `digest: Slack 전송 실패 — ${e && e.message}`);
      return { ok: false, reason: 'send-failed' };
    }
  };
}
