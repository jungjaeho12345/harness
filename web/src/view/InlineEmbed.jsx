// 본문 임베드 블록 렌더 — 이미지/영상(유튜브)/기사 참조 카드. 각 임베드에 × 삭제 버튼이 있다.
// 폭: 사진/영상 figure 612px, 기사 참조 카드 480px (clipboardEmbed EMBED_SIZE). transport 비의존(콜백만).

import { EMBED_SIZE } from './clipboardEmbed.js';

export function InlineEmbed({ embed, onRemove, readOnly = false }) {
  if (!embed) return null;
  const type = embed.embedType;
  const figureWidth = type === 'article'
    ? (embed.widthPx ?? EMBED_SIZE.articleCardWidthPx)
    : (embed.figureWidthPx ?? EMBED_SIZE.figureWidthPx);

  let body = null;
  if (type === 'image') {
    body = <img src={embed.src} alt={embed.alt ?? ''} style={{ width: '100%' }} />;
  } else if (type === 'video') {
    body = (
      <iframe
        src={embed.src}
        title={embed.title || '영상'}
        style={{ width: '100%', aspectRatio: '16 / 9', border: 0 }}
        allowFullScreen
      />
    );
  } else if (type === 'article') {
    body = (
      <a className="yh-embed__article" href={`list.do?articleId=${encodeURIComponent(embed.articleId ?? '')}`}>
        {embed.title || embed.articleId || '기사'}
      </a>
    );
  }

  return (
    <figure
      className="yh-embed"
      data-embed-type={type}
      style={{ width: `${figureWidth}px`, maxWidth: '100%', position: 'relative', margin: 0 }}
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
