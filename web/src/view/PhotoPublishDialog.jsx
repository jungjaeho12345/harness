// 사진발행/DB등록 다이얼로그(도구>사진발행/DB등록) — 순수 선택/입력 폼 컴포넌트(ADR-003).
// 현재 본문의 이미지 임베드 목록(imageEmbeds: [{src, alt}])을 props로만 받아 하나를 골라 캡션과 함께
//   onSubmit({ src, caption })으로 위임한다. 등록(model.publishPhoto)·본문 파생은 부모(WriterPage)가 한다 —
//   이 컴포넌트는 선택/입력 UI만 담당한다(본문/캐럿/임베드 무변경 읽기 액션 — model/fetch/localStorage 없음).
// 캡션은 input value/JSX 텍스트로만 다룬다(자동 이스케이프 — XSS 안전).
// 전용 클래스(yh-photo-publish)·testid(photo-publish)로 형제 다이얼로그(yh-file-info/yh-url-embed 등)와 충돌 방지.

import { useEffect, useRef, useState } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';

export function PhotoPublishDialog({
  open,
  imageEmbeds = [], // [{ src, alt }] — 현재 본문의 이미지 임베드(부모가 blocks에서 파생)
  onSubmit, // ({ src, caption }) => void — '등록' 클릭 시(선택 이미지 src + 입력 캡션)
  onClose, // () => void — '취소'/Esc
}) {
  const [selected, setSelected] = useState(0);
  const [caption, setCaption] = useState('');

  // 새로 열릴 때(open false→true)만 선택/캡션을 초기화한다 — 재오픈 시 이전 입력이 남지 않게(UrlEmbedDialog 패턴).
  // 초기 선택은 첫 항목(있으면).
  useEffect(() => {
    if (open) { setSelected(0); setCaption(''); }
  }, [open]);

  // 열림 시 포커스 이전 — 포커스가 에디터 본문에 남으면 캡션 타이핑이 기사 본문에 삽입되고 Esc 닫기가
  // 발화하지 않는다(Step 0 27-editor-critical-fixes). 논리적 첫 입력=캡션 input, 빈 상태면 '취소' 버튼.
  const focusRef = useRef(null);
  useFocusOnOpen(focusRef, open);

  if (!open) return null;

  const current = imageEmbeds[selected];

  // 선택된 이미지가 없으면(빈 목록/인덱스 이탈) no-op — 버튼 disabled와 이중 방어.
  const submit = () => {
    if (!current) return;
    if (onSubmit) onSubmit({ src: current.src, caption });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-editor-dialog yh-photo-publish"
      role="dialog"
      aria-label="사진발행/DB등록"
      data-testid="photo-publish"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-photo-publish__title">사진발행/DB등록</h2>

      {imageEmbeds.length === 0 ? (
        <p className="yh-photo-publish__empty" data-testid="photo-publish-empty">
          본문에 등록할 이미지가 없습니다. 이미지를 먼저 삽입하세요.
        </p>
      ) : (
        <>
          <ul className="yh-photo-publish__list" data-testid="photo-publish-list">
            {imageEmbeds.map((embed, i) => (
              <li key={`${embed.src}-${i}`} className="yh-photo-publish__item">
                <label className={i === selected ? 'yh-photo-publish__choice is-selected' : 'yh-photo-publish__choice'}>
                  <input
                    type="radio"
                    name="photo-publish-choice"
                    data-testid={`photo-publish-choice-${i}`}
                    checked={i === selected}
                    onChange={() => setSelected(i)}
                  />
                  <img className="yh-photo-publish__thumb" src={embed.src} alt={embed.alt || `이미지 ${i + 1}`} />
                </label>
              </li>
            ))}
          </ul>

          <div className="yh-photo-publish__field">
            <label htmlFor="photo-publish-caption">캡션</label>
            <input
              id="photo-publish-caption"
              data-testid="photo-publish-caption"
              ref={focusRef}
              type="text"
              placeholder="사진 캡션을 입력하세요"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </div>
        </>
      )}

      <div className="yh-photo-publish__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="photo-publish-submit"
          disabled={!current}
          onClick={submit}
        >
          등록
        </button>
        <button
          type="button"
          className="yh-btn"
          data-testid="photo-publish-close"
          ref={imageEmbeds.length === 0 ? focusRef : null}
          onClick={() => onClose && onClose()}
        >
          취소
        </button>
      </div>
    </div>
  );
}

export default PhotoPublishDialog;
