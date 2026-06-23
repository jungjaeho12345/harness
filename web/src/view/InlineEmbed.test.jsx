import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineEmbed, isAllowedImageSrc } from './InlineEmbed.jsx';
import { makeAudioEmbed, makeLocalVideoEmbed, makeLinkEmbed } from './clipboardEmbed.js';

describe('InlineEmbed', () => {
  it('renders an image embed capped to a 200x200 box (not 612px) with a remove (×) button', () => {
    // 제품 결정: 비율 유지, 최대 200×200, 모든 이미지 임베드.
    // figureWidthPx가 와도 이미지 figure는 612px를 예약하지 않는다(fit-content/200px).
    render(<InlineEmbed embed={{ embedType: 'image', src: 'x.png', alt: '사진', figureWidthPx: 612 }} onRemove={() => {}} />);
    const img = screen.getByRole('img', { name: '사진' });
    expect(img).toBeInTheDocument();
    // 이미지: 긴 변 <= 200px, 비율 유지(width/height auto + max 200).
    expect(img).toHaveStyle({ maxWidth: '200px', maxHeight: '200px', width: 'auto', height: 'auto' });
    const fig = img.closest('figure');
    // figure는 612px를 예약하지 않고 캡된 이미지에 맞춘다.
    expect(fig).not.toHaveStyle({ width: '612px' });
    expect(fig).toHaveStyle({ width: 'fit-content' });
    expect(screen.getByRole('button', { name: '임베드 삭제' })).toBeInTheDocument();
  });

  it('calls onRemove when the × button is clicked', async () => {
    const onRemove = vi.fn();
    render(<InlineEmbed embed={{ embedType: 'image', src: 'x.png' }} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: '임베드 삭제' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('renders an article reference card at 480px and hides × in readOnly', () => {
    render(<InlineEmbed embed={{ embedType: 'article', articleId: 'AKR1', title: '참조기사', widthPx: 480 }} readOnly />);
    const card = screen.getByText('참조기사').closest('figure');
    expect(card).toHaveStyle({ width: '480px' });
    expect(screen.queryByRole('button', { name: '임베드 삭제' })).toBeNull();
  });

  // 16-A video iframe src allowlist + sandbox
  describe('video embed security', () => {
    it('does not render an iframe for a forged cross-origin https src', () => {
      render(<InlineEmbed embed={{ embedType: 'video', src: 'https://evil.example.com/x' }} onRemove={() => {}} />);
      expect(document.querySelector('iframe')).toBeNull();
    });

    it('does not render an iframe for a data:text/html src', () => {
      render(<InlineEmbed embed={{ embedType: 'video', src: 'data:text/html,<script>alert(1)</script>' }} onRemove={() => {}} />);
      expect(document.querySelector('iframe')).toBeNull();
    });

    it('renders a canonical YouTube embed iframe with sandbox from videoId', () => {
      render(<InlineEmbed embed={{ embedType: 'video', videoId: 'dQw4w9WgXcQ', src: 'https://evil.example.com/x' }} onRemove={() => {}} />);
      const iframe = document.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
      expect(iframe.hasAttribute('sandbox')).toBe(true);
    });

    it('reconstructs a canonical embed src from a youtube watch url', () => {
      render(<InlineEmbed embed={{ embedType: 'video', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }} onRemove={() => {}} />);
      const iframe = document.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });

    it('reconstructs a canonical embed src from a youtu.be short url', () => {
      render(<InlineEmbed embed={{ embedType: 'video', src: 'https://youtu.be/dQw4w9WgXcQ' }} onRemove={() => {}} />);
      expect(document.querySelector('iframe').getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });

    it('prefers videoId over a conflicting youtube src', () => {
      // src holds a different valid youtube id; videoId must win.
      render(<InlineEmbed embed={{ embedType: 'video', videoId: 'aaaaaaaaaaa', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }} onRemove={() => {}} />);
      expect(document.querySelector('iframe').getAttribute('src')).toBe('https://www.youtube.com/embed/aaaaaaaaaaa');
    });

    it('falls back to url when src has no extractable id', () => {
      render(<InlineEmbed embed={{ embedType: 'video', src: 'https://evil.example.com/x', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }} onRemove={() => {}} />);
      expect(document.querySelector('iframe').getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });

    it('does not render an iframe when video src/url/videoId are all missing', () => {
      render(<InlineEmbed embed={{ embedType: 'video' }} onRemove={() => {}} />);
      expect(document.querySelector('iframe')).toBeNull();
    });

    it('does not render an iframe for an empty video src', () => {
      render(<InlineEmbed embed={{ embedType: 'video', src: '' }} onRemove={() => {}} />);
      expect(document.querySelector('iframe')).toBeNull();
    });

    it('restricts the sandbox to the minimum YouTube-playback permissions', () => {
      render(<InlineEmbed embed={{ embedType: 'video', videoId: 'dQw4w9WgXcQ' }} onRemove={() => {}} />);
      const sandbox = document.querySelector('iframe').getAttribute('sandbox');
      // must not grant top-level navigation / popups / form submission.
      expect(sandbox).not.toMatch(/allow-top-navigation/);
      expect(sandbox).not.toMatch(/allow-popups/);
      expect(sandbox).not.toMatch(/allow-forms/);
    });
  });

  // 16-B image src scheme allowlist
  describe('isAllowedImageSrc', () => {
    it('allows https: and data:image/ schemes', () => {
      expect(isAllowedImageSrc('https://cdn.example.com/a.png')).toBe(true);
      expect(isAllowedImageSrc('data:image/png;base64,AAAA')).toBe(true);
    });

    it('allows relative paths (no scheme)', () => {
      expect(isAllowedImageSrc('x.png')).toBe(true);
      expect(isAllowedImageSrc('/assets/a.jpg')).toBe(true);
    });

    it('rejects disallowed schemes', () => {
      expect(isAllowedImageSrc('javascript:alert(1)')).toBe(false);
      expect(isAllowedImageSrc('data:text/html,<b>x</b>')).toBe(false);
      expect(isAllowedImageSrc('http://insecure.example.com/a.png')).toBe(false);
      expect(isAllowedImageSrc('')).toBe(false);
      expect(isAllowedImageSrc(null)).toBe(false);
    });
  });

  describe('image embed security', () => {
    it('does not render an img for a disallowed scheme', () => {
      render(<InlineEmbed embed={{ embedType: 'image', src: 'javascript:alert(1)', alt: '나쁜' }} onRemove={() => {}} />);
      expect(document.querySelector('img')).toBeNull();
    });

    it('renders an img for an allowed https src', () => {
      render(<InlineEmbed embed={{ embedType: 'image', src: 'https://cdn.example.com/a.png', alt: '좋은' }} onRemove={() => {}} />);
      expect(screen.getByRole('img', { name: '좋은' })).toBeInTheDocument();
    });

    it('renders an img for a data:image/ src', () => {
      render(<InlineEmbed embed={{ embedType: 'image', src: 'data:image/png;base64,AAAA', alt: '데이터이미지' }} onRemove={() => {}} />);
      expect(screen.getByRole('img', { name: '데이터이미지' })).toBeInTheDocument();
    });

    it('does not render an img for a data:text/html src', () => {
      render(<InlineEmbed embed={{ embedType: 'image', src: 'data:text/html,<b>x</b>', alt: '나쁜데이터' }} onRemove={() => {}} />);
      expect(document.querySelector('img')).toBeNull();
    });

    it('does not render an img for an http: src', () => {
      render(<InlineEmbed embed={{ embedType: 'image', src: 'http://insecure.example.com/a.png', alt: '비보안' }} onRemove={() => {}} />);
      expect(document.querySelector('img')).toBeNull();
    });

    it('does not render an img for a missing or empty src', () => {
      const { rerender } = render(<InlineEmbed embed={{ embedType: 'image', alt: '없음' }} onRemove={() => {}} />);
      expect(document.querySelector('img')).toBeNull();
      rerender(<InlineEmbed embed={{ embedType: 'image', src: '', alt: '빈' }} onRemove={() => {}} />);
      expect(document.querySelector('img')).toBeNull();
    });

    it('sets referrerPolicy=no-referrer on rendered images', () => {
      render(<InlineEmbed embed={{ embedType: 'image', src: 'https://cdn.example.com/a.png', alt: '참조' }} onRemove={() => {}} />);
      expect(screen.getByRole('img', { name: '참조' }).getAttribute('referrerpolicy')).toBe('no-referrer');
    });
  });

  // 19-step0: 오디오 임베드 — isAllowedMediaSrc 가드 후 <audio controls>. 악성 src는 미렌더.
  describe('audio embed security', () => {
    it('renders an <audio controls> for an allowed https src', () => {
      render(<InlineEmbed embed={{ embedType: 'audio', src: 'https://cdn.example.com/a.mp3' }} onRemove={() => {}} />);
      const audio = document.querySelector('audio');
      expect(audio).not.toBeNull();
      expect(audio.hasAttribute('controls')).toBe(true);
      expect(audio.getAttribute('src')).toBe('https://cdn.example.com/a.mp3');
      expect(audio.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('does not render <audio> for a javascript: src', () => {
      render(<InlineEmbed embed={{ embedType: 'audio', src: 'javascript:alert(1)' }} onRemove={() => {}} />);
      expect(document.querySelector('audio')).toBeNull();
    });

    it('does not render <audio> for a data:audio src (media disallows data:)', () => {
      render(<InlineEmbed embed={{ embedType: 'audio', src: 'data:audio/mp3;base64,AAAA' }} onRemove={() => {}} />);
      expect(document.querySelector('audio')).toBeNull();
    });

    it('does not render <audio> for an http: src', () => {
      render(<InlineEmbed embed={{ embedType: 'audio', src: 'http://insecure/a.mp3' }} onRemove={() => {}} />);
      expect(document.querySelector('audio')).toBeNull();
    });

    it('shows the × remove button (editable) and hides it in readOnly', () => {
      const { rerender } = render(<InlineEmbed embed={{ embedType: 'audio', src: 'https://cdn.example.com/a.mp3' }} onRemove={() => {}} />);
      expect(screen.getByRole('button', { name: '임베드 삭제' })).toBeInTheDocument();
      rerender(<InlineEmbed embed={{ embedType: 'audio', src: 'https://cdn.example.com/a.mp3' }} readOnly />);
      expect(screen.queryByRole('button', { name: '임베드 삭제' })).toBeNull();
    });
  });

  // 19-step0: 로컬영상 임베드 — <video controls>(유튜브 iframe 아님). 악성 src 미렌더.
  describe('localVideo embed security', () => {
    it('renders a <video controls> (not an <iframe>) for an allowed https src', () => {
      render(<InlineEmbed embed={{ embedType: 'localVideo', src: 'https://cdn.example.com/a.webm', figureWidthPx: 612 }} onRemove={() => {}} />);
      const video = document.querySelector('video');
      expect(video).not.toBeNull();
      expect(video.hasAttribute('controls')).toBe(true);
      expect(video.getAttribute('src')).toBe('https://cdn.example.com/a.webm');
      expect(document.querySelector('iframe')).toBeNull();
    });

    it('uses the 612px figure width for localVideo', () => {
      render(<InlineEmbed embed={{ embedType: 'localVideo', src: 'https://cdn.example.com/a.webm', figureWidthPx: 612 }} onRemove={() => {}} />);
      expect(document.querySelector('video').closest('figure')).toHaveStyle({ width: '612px' });
    });

    it('does not render <video> for a javascript: src', () => {
      render(<InlineEmbed embed={{ embedType: 'localVideo', src: 'javascript:alert(1)' }} onRemove={() => {}} />);
      expect(document.querySelector('video')).toBeNull();
    });

    it('does not render <video> for an http: src', () => {
      render(<InlineEmbed embed={{ embedType: 'localVideo', src: 'http://insecure/a.webm' }} onRemove={() => {}} />);
      expect(document.querySelector('video')).toBeNull();
    });
  });

  // 19-step0: 링크 임베드 — <a rel="noopener noreferrer" target="_blank">. 악성 href 미렌더.
  describe('link embed security', () => {
    it('renders an <a> with href, rel=noopener noreferrer, target=_blank for an allowed https href', () => {
      render(<InlineEmbed embed={{ embedType: 'link', href: 'https://example.com/article', title: '원문' }} onRemove={() => {}} />);
      const a = screen.getByRole('link', { name: '원문' });
      expect(a.getAttribute('href')).toBe('https://example.com/article');
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.getAttribute('rel')).toContain('noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
    });

    it('falls back to href as link text when title is missing', () => {
      render(<InlineEmbed embed={{ embedType: 'link', href: 'https://example.com/x' }} onRemove={() => {}} />);
      expect(screen.getByRole('link', { name: 'https://example.com/x' })).toBeInTheDocument();
    });

    it('does not render an <a href> for a javascript: href', () => {
      render(<InlineEmbed embed={{ embedType: 'link', href: 'javascript:alert(1)', title: '나쁜링크' }} onRemove={() => {}} />);
      expect(document.querySelector('a')).toBeNull();
    });

    it('does not render an <a> for an empty/missing href', () => {
      render(<InlineEmbed embed={{ embedType: 'link', title: '없음' }} onRemove={() => {}} />);
      expect(document.querySelector('a')).toBeNull();
    });
  });

  // 19-step1: 팩토리 필드명이 렌더가 읽는 키와 일치하는지(빈 figure 회귀 가드) 통합 단언.
  describe('factory ↔ render field-name parity', () => {
    it('makeAudioEmbed(allowed) renders an <audio>', () => {
      render(<InlineEmbed embed={makeAudioEmbed('https://cdn.example.com/a.mp3')} onRemove={() => {}} />);
      expect(document.querySelector('audio')).not.toBeNull();
    });

    it('makeLocalVideoEmbed(allowed) renders a <video>', () => {
      render(<InlineEmbed embed={makeLocalVideoEmbed('https://cdn.example.com/a.webm')} onRemove={() => {}} />);
      expect(document.querySelector('video')).not.toBeNull();
    });

    it('makeLinkEmbed(allowed) renders an <a href>', () => {
      render(<InlineEmbed embed={makeLinkEmbed('https://example.com/x', { title: '원문' })} onRemove={() => {}} />);
      expect(screen.getByRole('link', { name: '원문' }).getAttribute('href')).toBe('https://example.com/x');
    });
  });
});
