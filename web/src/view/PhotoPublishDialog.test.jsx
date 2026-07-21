import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhotoPublishDialog } from './PhotoPublishDialog.jsx';

// 사진발행/DB등록 다이얼로그 — 순수 선택/입력 폼 컴포넌트(ADR-003).
// 이미지 임베드 목록(imageEmbeds)은 props로만 받고, 등록(model.publishPhoto)은 부모(WriterPage)가 한다.
const EMBEDS = [
  { src: '/uploads/a.png', alt: '첫 사진' },
  { src: '/uploads/b.png', alt: '둘째 사진' },
];

function baseProps(overrides = {}) {
  return {
    open: true,
    imageEmbeds: EMBEDS,
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('PhotoPublishDialog — 사진발행/DB등록 다이얼로그', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<PhotoPublishDialog {...baseProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면 dialog('사진발행/DB등록')·testid photo-publish·yh-editor-dialog 공용 클래스를 가진다", () => {
    render(<PhotoPublishDialog {...baseProps()} />);
    expect(screen.getByRole('dialog', { name: '사진발행/DB등록' })).toBeInTheDocument();
    expect(screen.getByTestId('photo-publish')).toHaveClass('yh-editor-dialog');
  });

  it('imageEmbeds를 주면 썸네일 목록이 렌더되고 첫 항목이 기본 선택된다', () => {
    render(<PhotoPublishDialog {...baseProps()} />);
    const thumbs = screen.getAllByRole('img');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute('src', '/uploads/a.png');
    expect(thumbs[1]).toHaveAttribute('src', '/uploads/b.png');
    expect(screen.getByTestId('photo-publish-choice-0')).toBeChecked();
    expect(screen.getByTestId('photo-publish-choice-1')).not.toBeChecked();
  });

  it("이미지 선택 + 캡션 입력 후 '등록' → onSubmit({src, caption})이 선택 src·입력 캡션으로 호출된다", async () => {
    const onSubmit = vi.fn();
    render(<PhotoPublishDialog {...baseProps({ onSubmit })} />);

    await userEvent.click(screen.getByTestId('photo-publish-choice-1'));
    fireEvent.change(screen.getByTestId('photo-publish-caption'), { target: { value: '현장 스케치' } });
    await userEvent.click(screen.getByTestId('photo-publish-submit'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ src: '/uploads/b.png', caption: '현장 스케치' });
  });

  it("'취소' 클릭 → onClose 호출(onSubmit 미호출), Esc → onClose 호출", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<PhotoPublishDialog {...baseProps({ onSubmit, onClose })} />);

    await userEvent.click(screen.getByTestId('photo-publish-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('imageEmbeds가 비면 빈 상태 안내가 뜨고 등록 버튼이 비활성이라 등록이 불가하다', async () => {
    const onSubmit = vi.fn();
    render(<PhotoPublishDialog {...baseProps({ imageEmbeds: [], onSubmit })} />);

    expect(screen.getByTestId('photo-publish-empty'))
      .toHaveTextContent('본문에 등록할 이미지가 없습니다. 이미지를 먼저 삽입하세요.');
    const submit = screen.getByTestId('photo-publish-submit');
    expect(submit).toBeDisabled();
    await userEvent.click(submit).catch(() => {});
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('onSubmit/onClose 미전달 시 상호작용이 예외를 던지지 않는다(방어적 — 형제 다이얼로그 컨벤션)', () => {
    render(<PhotoPublishDialog open imageEmbeds={EMBEDS} />);
    expect(() => fireEvent.click(screen.getByTestId('photo-publish-submit'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('photo-publish-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });

  // Step 0(27-editor-critical-fixes) 계열: 열림 시 포커스 이전 — 포커스가 에디터 본문에 남으면
  // 캡션 타이핑이 기사 본문에 삽입되고 Esc 닫기가 발화하지 않는다.
  it('open=true로 렌더된 직후 캡션 input이 포커스를 가진다(열림 시 포커스 이전)', () => {
    render(<PhotoPublishDialog {...baseProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('photo-publish-caption'));
  });

  it('재오픈(open false→true) 시 선택/캡션이 초기화된다(이전 입력 미이월 — UrlEmbedDialog 패턴)', async () => {
    const props = baseProps();
    const { rerender } = render(<PhotoPublishDialog {...props} />);
    await userEvent.click(screen.getByTestId('photo-publish-choice-1'));
    fireEvent.change(screen.getByTestId('photo-publish-caption'), { target: { value: '남은 캡션' } });

    rerender(<PhotoPublishDialog {...props} open={false} />);
    rerender(<PhotoPublishDialog {...props} open />);

    expect(screen.getByTestId('photo-publish-choice-0')).toBeChecked();
    expect(screen.getByTestId('photo-publish-caption')).toHaveValue('');
  });
});
