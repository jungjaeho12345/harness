// 본문 임베드 블록 렌더 — 이미지/영상(유튜브)/기사 참조 카드. 각 임베드에 × 삭제 버튼이 있다.
// 폭: 영상 figure 612px, 기사 참조 카드 480px (clipboardEmbed EMBED_SIZE). transport 비의존(콜백만).
// 이미지: 제품 결정대로 비율 유지·최대 200×200으로 캡하고 figure는 캡된 이미지에 맞춘다(612px 미예약).

import { EMBED_SIZE, parseYouTubeId } from './clipboardEmbed.js';

// 이미지 src 허용 scheme 검사 — https:/data:image/ 와 scheme 없는 상대경로만 허용.
// javascript:/data:text/.../http: 등은 거부(트래킹·스푸핑 완화).
export function isAllowedImageSrc(src) {
  if (typeof src !== 'string' || src === '') return false;
  const m = src.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) return true; // scheme 없음 = 상대경로 → 허용
  const scheme = m[1].toLowerCase();
  if (scheme === 'https') return true;
  if (scheme === 'data') return /^data:image\//i.test(src);
  return false;
}

export function InlineEmbed({ embed, onRemove, readOnly = false }) {
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
  }

  // 이미지는 figure가 612px를 예약하지 않고 캡된 이미지(<=200px)에 맞춘다(fit-content).
  // 영상은 figureWidthPx(기본 612px), 기사 참조 카드는 widthPx(기본 480px) 유지.
  const figureWidth = type === 'image'
    ? 'fit-content'
    : type === 'article'
      ? `${embed.widthPx ?? EMBED_SIZE.articleCardWidthPx}px`
      : `${embed.figureWidthPx ?? EMBED_SIZE.figureWidthPx}px`;

  return (
    <figure
      className="yh-embed"
      data-embed-type={type}
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
