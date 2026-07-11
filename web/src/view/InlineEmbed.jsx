// 본문 임베드 블록 렌더 — 이미지/영상(유튜브)/기사 참조 카드. 각 임베드에 × 삭제 버튼이 있다.
// 폭: 영상 figure 612px, 기사 참조 카드 480px (clipboardEmbed EMBED_SIZE). transport 비의존(콜백만).
// 이미지: 제품 결정대로 비율 유지·최대 200×200으로 캡하고 figure는 캡된 이미지에 맞춘다(612px 미예약).

import {
  EMBED_SIZE, parseYouTubeId, isAllowedImageSrc, isAllowedMediaSrc, isAllowedHref,
} from './clipboardEmbed.js';
import { normalizeTableRows } from './tableModel.js';

// 이미지 src 허용 scheme 검사(https:/data:image/·상대경로만)는 임베드 모델 모듈(clipboardEmbed)로 단일화했다.
// 상세보기 렌더(articleDetail)와 같은 규칙을 공유한다. 기존 import 경로 호환을 위해 여기서 재노출한다.
export { isAllowedImageSrc };

// blockIndex: 이 임베드가 차지하는 본문 블록 인덱스(snapshot 기준). figure에 data-embed-key로 박아
//   에디터가 DOM을 다시 읽을 때(readEditorBlocks) 임베드를 '등장 순서'가 아니라 '안정적 키'로 매칭하게 한다
//   (인라인 삭제 등으로 임베드 개수가 어긋나도 살아남은 임베드 데이터가 뒤바뀌지 않게 함).
export function InlineEmbed({ embed, onRemove, readOnly = false, blockIndex }) {
  if (!embed) return null;
  const type = embed.embedType;

  let body = null;
  if (type === 'image') {
    // 16-B: 허용 scheme(https:/data:image/·상대경로)만 렌더. 그 외는 거부.
    if (isAllowedImageSrc(embed.src)) {
      body = (
        <img
          src={embed.src}
          alt={embed.alt ?? ''}
          // 비율 유지 + 긴 변 <= 200px 캡(최대 200×200). width/height auto로 종횡비 보존.
          style={{ maxWidth: '200px', maxHeight: '200px', width: 'auto', height: 'auto' }}
          referrerPolicy="no-referrer"
        />
      );
    }
  } else if (type === 'video') {
    // 16-A: 렌더 시점에 YouTube canonical embed URL로 재구성. id 추출 실패 시 iframe 미렌더.
    const videoId = embed.videoId || parseYouTubeId(embed.src) || parseYouTubeId(embed.url);
    if (videoId) {
      body = (
        <iframe
          src={`https://www.youtube.com/embed/${videoId}`}
          title={embed.title || '영상'}
          style={{ width: '100%', aspectRatio: '16 / 9', border: 0 }}
          sandbox="allow-scripts allow-same-origin allow-presentation"
          allowFullScreen
        />
      );
    }
  } else if (type === 'article') {
    body = (
      <a className="yh-embed__article" href={`list.do?articleId=${encodeURIComponent(embed.articleId ?? '')}`}>
        {embed.title || embed.articleId || '기사'}
      </a>
    );
  } else if (type === 'audio') {
    // 19: 오디오 — 허용 scheme(isAllowedMediaSrc, https:/상대)만 <audio> 렌더. 거부면 빈 figure(크래시 금지).
    if (isAllowedMediaSrc(embed.src)) {
      body = <audio controls src={embed.src} referrerPolicy="no-referrer" />;
    }
  } else if (type === 'localVideo') {
    // 19: 로컬/업로드 영상 — <video> 엘리먼트(유튜브 iframe과 별개 타입). 허용 src만 렌더.
    if (isAllowedMediaSrc(embed.src)) {
      body = <video controls src={embed.src} style={{ width: '100%' }} />;
    }
  } else if (type === 'link') {
    // 19: 링크 — 허용 href만 새 탭 <a>로 렌더. rel="noopener noreferrer"로 탭내빙·referrer 누출 차단.
    if (isAllowedHref(embed.href)) {
      body = (
        <a href={embed.href} rel="noopener noreferrer" target="_blank">
          {embed.title || embed.href}
        </a>
      );
    }
  } else if (type === 'table') {
    // 31: 표 — 읽기 전용 <table>. 셀은 사용자 입력이라 JSX 텍스트로만 렌더(자동 이스케이프 — XSS 차단).
    // 정규화는 tableModel.normalizeTableRows 단일 출처(ragged/비문자열 방어). 빈 rows면 빈 figure.
    const rows = normalizeTableRows(embed.rows);
    if (rows.length > 0) {
      body = (
        <table className="yh-embed__table">
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => <td key={c}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  }

  // 이미지는 figure가 612px를 예약하지 않고 캡된 이미지(<=200px)에 맞춘다(fit-content).
  // 영상(유튜브)·로컬영상은 figureWidthPx(기본 612px), 기사 참조 카드는 widthPx(기본 480px) 유지.
  // 오디오·링크·표는 콘텐츠 폭(fit-content)으로 둔다.
  const figureWidth = type === 'image' || type === 'audio' || type === 'link' || type === 'table'
    ? 'fit-content'
    : type === 'article'
      ? `${embed.widthPx ?? EMBED_SIZE.articleCardWidthPx}px`
      : `${embed.figureWidthPx ?? EMBED_SIZE.figureWidthPx}px`;

  return (
    <figure
      className="yh-embed"
      data-embed-type={type}
      data-embed-key={blockIndex == null ? undefined : String(blockIndex)}
      style={{ width: figureWidth, maxWidth: '100%', position: 'relative', margin: 0 }}
    >
      {!readOnly && (
        <button
          type="button"
          className="yh-embed__remove"
          aria-label="임베드 삭제"
          onClick={onRemove}
        >
          ×
        </button>
      )}
      {body}
    </figure>
  );
}

export default InlineEmbed;
