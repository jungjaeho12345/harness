// URL 직접 임베드 입력 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003).
// URL을 입력해 onSubmit(url)로 위임한다. 임베드 생성(make*Embed)·삽입·URL 검증(parseYouTubeId/isAllowedImageSrc)은
//   부모(Step 3 WriterPage)가 한다 — 이 컴포넌트는 입력 UI만 담당한다.
// kind: 'image' | 'video' | 'audio' | 'link' | 'localVideo'(라벨/placeholder만 다름·동작 분기는 부모).
// model/fetch/localStorage/window/document·clipboardEmbed 호출 없음. 찾기(yh-find-replace)·약물입력(yh-glyph-input)·
//   약물바(yh-editor-glyphbar)와 충돌하지 않게 전용 클래스(yh-url-embed)·testid(url-embed)를 쓴다.

import { useEffect, useRef, useState } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

// kind별 라벨/placeholder만 다르다. 동작 분기(팩토리 선택)는 부모가 한다.
const KIND_META = {
  image: { title: '그림 삽입', placeholder: '이미지 URL (https://...)' },
  video: { title: '유튜브 영상 삽입', placeholder: '유튜브 URL (https://www.youtube.com/...)' },
  audio: { title: '오디오 삽입', placeholder: '오디오 URL (https://...)' },
  link: { title: '링크 삽입', placeholder: '링크 URL (https://...)' },
  localVideo: { title: '로컬영상 삽입', placeholder: '영상 URL (https://...)' },
};

export function UrlEmbedDialog({
  open,
  kind, // 'image' | 'video' | 'audio' | 'link' | 'localVideo' — 라벨/placeholder/aria-label 결정(동작 분기는 부모)
  onSubmit, // (url) => void — '삽입' 클릭 또는 Enter 시(트림한 값)
  onClose, // () => void
}) {
  const [url, setUrl] = useState('');

  // 새로 열릴 때(open false→true)만 입력값을 초기화한다 — 재오픈 시 이전 URL이 남지 않게(FindReplaceDialog 패턴).
  useEffect(() => {
    if (open) setUrl('');
  }, [open]);

  // 열림 시 포커스를 URL input(논리적 첫 입력)으로 이전 — 포커스가 에디터 본문에 남으면
  // URL 타이핑이 기사 본문에 삽입되고 Esc 닫기가 발화하지 않는다(Step 0 27-editor-critical-fixes).
  const urlRef = useRef(null);
  useFocusOnOpen(urlRef, open);

  if (!open) return null;

  const meta = KIND_META[kind] || KIND_META.image;

  // 트림 후 빈 값이면 no-op — 부모가 빈 임베드를 만들지 않게 onSubmit('')을 부르지 않는다.
  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (onSubmit) onSubmit(trimmed);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
    else if (e.key === 'Enter') submit();
  };

  return (
    <div
      className="yh-url-embed"
      role="dialog"
      aria-label={meta.title}
      data-testid="url-embed"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-url-embed__title">{meta.title}</h2>

      <div className="yh-url-embed__field">
        <label htmlFor="url-embed-input">URL</label>
        <input
          id="url-embed-input"
          data-testid="url-embed-input"
          ref={urlRef}
          type="text"
          aria-label={meta.title}
          placeholder={meta.placeholder}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div className="yh-url-embed__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="url-embed-submit"
          onClick={submit}
        >
          삽입
        </button>
        <button
          type="button"
          className="yh-btn"
          data-testid="url-embed-close"
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default UrlEmbedDialog;
