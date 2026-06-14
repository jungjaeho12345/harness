import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineEmbed, isAllowedImageSrc } from './InlineEmbed.jsx';

describe('InlineEmbed', () => {
  it('renders an image embed with a remove (×) button at 612px', () => {
    render(<InlineEmbed embed={{ embedType: 'image', src: 'x.png', alt: '사진', figureWidthPx: 612 }} onRemove={() => {}} />);
    expect(screen.getByRole('img', { name: '사진' })).toBeInTheDocument();
    const fig = screen.getByRole('img', { name: '사진' }).closest('figure');
    expect(fig).toHaveStyle({ width: '612px' });
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
});
