import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { SafeLink } from '../src/react/SafeLink';

const policy = {
  internalHosts: ['community.example'],
  trustedPopupOrigins: ['https://github.com'],
};

describe('SafeLink (SSR)', () => {
  it('外部链接服务端渲染即带 target/rel', () => {
    const html = renderToStaticMarkup(
      createElement(SafeLink, { href: 'https://evil.example/x', policy }, 'x'),
    );
    expect(html).toContain('href="https://evil.example/x"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('站内链接默认当前标签且无 noopener', () => {
    const html = renderToStaticMarkup(
      createElement(SafeLink, { href: '/posts/1', policy }, 'p'),
    );
    expect(html).not.toContain('target=');
    expect(html).not.toContain('noopener');
  });

  it('危险协议不渲染 href', () => {
    const html = renderToStaticMarkup(
      createElement(SafeLink, { href: 'javascript:alert(1)', policy }, 'hack'),
    );
    expect(html).not.toContain('href=');
    expect(html).toContain('data-safe-navigation-blocked');
  });

  it('受信 preserveOpener 不输出 noopener', () => {
    const html = renderToStaticMarkup(
      createElement(
        SafeLink,
        {
          href: 'https://github.com/login',
          target: 'oauth',
          preserveOpener: true,
          policy,
        },
        'GitHub',
      ),
    );
    expect(html).not.toContain('noopener');
    expect(html).toContain('data-preserve-opener');
  });
});
