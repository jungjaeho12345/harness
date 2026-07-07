import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UrlEmbedDialog } from './UrlEmbedDialog.jsx';

// URL 직접 임베드 입력 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003). URL을 입력해 onSubmit(url)로 위임한다.
// 임베드 생성(make*Embed)·삽입·URL 검증은 부모(Step 3 WriterPage)가 한다 — 이 컴포넌트는 입력 UI만 담당한다.
// noop 콜백 묶음 — 각 테스트가 관심 있는 콜백만 vi.fn()으로 덮어쓴다.
function noopProps(overrides = {}) {
  return {
    open: true,
    kind: 'image',
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('UrlEmbedDialog — URL 직접 임베드 다이얼로그', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    const { container } = render(<UrlEmbedDialog {...noopProps({ open: false })} />);
    expect(container.firstChild).toBeNull();
  });

  it("열리면(kind=image) dialog('그림 삽입')와 URL 입력·삽입·닫기 버튼을 보여준다", () => {
    render(<UrlEmbedDialog {...noopProps({ kind: 'image' })} />);
    expect(screen.getByRole('dialog', { name: '그림 삽입' })).toBeInTheDocument();
    expect(screen.getByTestId('url-embed')).toBeInTheDocument();
    expect(screen.getByTestId('url-embed-input')).toBeInTheDocument();
    expect(screen.getByTestId('url-embed-submit')).toBeInTheDocument();
    expect(screen.getByTestId('url-embed-close')).toBeInTheDocument();
  });

  it("URL 입력 후 '삽입' 클릭 시 onSubmit이 그 URL(트림)로 호출된다", () => {
    const onSubmit = vi.fn();
    render(<UrlEmbedDialog {...noopProps({ onSubmit })} />);
    fireEvent.change(screen.getByTestId('url-embed-input'), {
      target: { value: '  https://example.com/a.jpg  ' },
    });
    fireEvent.click(screen.getByTestId('url-embed-submit'));
    expect(onSubmit).toHaveBeenCalledWith('https://example.com/a.jpg');
  });

  it('URL 입력 후 Enter 시에도 onSubmit이 호출된다', () => {
    const onSubmit = vi.fn();
    render(<UrlEmbedDialog {...noopProps({ onSubmit })} />);
    const input = screen.getByTestId('url-embed-input');
    fireEvent.change(input, { target: { value: 'https://example.com/b.jpg' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('https://example.com/b.jpg');
  });

  it("빈 URL(공백만)에서 '삽입'은 onSubmit을 호출하지 않는다(no-op)", () => {
    const onSubmit = vi.fn();
    render(<UrlEmbedDialog {...noopProps({ onSubmit })} />);
    fireEvent.change(screen.getByTestId('url-embed-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('url-embed-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('빈 URL에서 Enter도 onSubmit을 호출하지 않는다(no-op)', () => {
    const onSubmit = vi.fn();
    render(<UrlEmbedDialog {...noopProps({ onSubmit })} />);
    const input = screen.getByTestId('url-embed-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("kind='video'면 dialog 라벨이 유튜브용으로 바뀐다", () => {
    render(<UrlEmbedDialog {...noopProps({ kind: 'video' })} />);
    expect(screen.getByRole('dialog', { name: '유튜브 영상 삽입' })).toBeInTheDocument();
  });

  it("kind별 placeholder가 다르다(image vs video)", () => {
    const { rerender } = render(<UrlEmbedDialog {...noopProps({ kind: 'image' })} />);
    const imagePlaceholder = screen.getByTestId('url-embed-input').getAttribute('placeholder');
    rerender(<UrlEmbedDialog {...noopProps({ kind: 'video' })} />);
    const videoPlaceholder = screen.getByTestId('url-embed-input').getAttribute('placeholder');
    expect(imagePlaceholder).not.toBe(videoPlaceholder);
  });

  // 19-step1: 오디오/링크/로컬영상 kind 라벨 추가(news.md L180 메뉴 명칭과 일치).
  it("kind='audio'면 dialog 라벨이 '오디오 삽입'이고 placeholder도 오디오용이다", () => {
    render(<UrlEmbedDialog {...noopProps({ kind: 'audio' })} />);
    expect(screen.getByRole('dialog', { name: '오디오 삽입' })).toBeInTheDocument();
    expect(screen.getByTestId('url-embed-input').getAttribute('placeholder')).toMatch(/오디오/);
  });

  it("kind='link'면 dialog 라벨이 '링크 삽입'이다", () => {
    render(<UrlEmbedDialog {...noopProps({ kind: 'link' })} />);
    expect(screen.getByRole('dialog', { name: '링크 삽입' })).toBeInTheDocument();
  });

  it("kind='localVideo'면 dialog 라벨이 '로컬영상 삽입'이다", () => {
    render(<UrlEmbedDialog {...noopProps({ kind: 'localVideo' })} />);
    expect(screen.getByRole('dialog', { name: '로컬영상 삽입' })).toBeInTheDocument();
  });

  it("Esc 키 또는 '닫기' 버튼으로 onClose가 호출된다", () => {
    const onClose = vi.fn();
    render(<UrlEmbedDialog {...noopProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('url-embed-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('open false→true 재전환 시 입력값이 초기화된다(이전 URL 미잔존)', () => {
    const { rerender } = render(<UrlEmbedDialog {...noopProps({ open: true })} />);
    fireEvent.change(screen.getByTestId('url-embed-input'), {
      target: { value: 'https://example.com/old.jpg' },
    });
    expect(screen.getByTestId('url-embed-input')).toHaveValue('https://example.com/old.jpg');

    rerender(<UrlEmbedDialog {...noopProps({ open: false })} />);
    rerender(<UrlEmbedDialog {...noopProps({ open: true })} />);
    expect(screen.getByTestId('url-embed-input')).toHaveValue('');
  });

  it('onSubmit 미전달 시 삽입/Enter가 예외를 던지지 않는다', () => {
    render(<UrlEmbedDialog open kind="image" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('url-embed-input'), {
      target: { value: 'https://example.com/c.jpg' },
    });
    expect(() => fireEvent.click(screen.getByTestId('url-embed-submit'))).not.toThrow();
    expect(() =>
      fireEvent.keyDown(screen.getByTestId('url-embed-input'), { key: 'Enter' }),
    ).not.toThrow();
  });

  it('onClose 미전달 시 닫기/Esc가 예외를 던지지 않는다', () => {
    render(<UrlEmbedDialog open kind="video" onSubmit={vi.fn()} />);
    expect(() => fireEvent.click(screen.getByTestId('url-embed-close'))).not.toThrow();
    expect(() =>
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }),
    ).not.toThrow();
  });

  // Step 0(27-editor-critical-fixes): 열림 시 포커스 이전 — 논리적 첫 텍스트 입력(URL input)으로 포커스한다.
  // 포커스가 에디터 본문에 남으면 URL 타이핑이 기사 본문에 삽입되고 Esc 닫기도 발화하지 않는다.
  it('open=true로 렌더된 직후 document.activeElement가 URL 입력이다(열림 시 포커스 이전)', () => {
    render(<UrlEmbedDialog {...noopProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('url-embed-input'));
  });

  it('닫힘→열림(open false→true) 전이에서도 포커스가 URL 입력으로 이동한다', () => {
    const { rerender } = render(<UrlEmbedDialog {...noopProps({ open: false })} />);
    rerender(<UrlEmbedDialog {...noopProps({ open: true })} />);
    expect(document.activeElement).toBe(screen.getByTestId('url-embed-input'));
  });
});
