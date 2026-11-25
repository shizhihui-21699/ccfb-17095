import { describe, expect, it } from 'vitest';
import { anchorAttrs, rewriteAnchorHtml } from '../src/server/html-rewrite';

const opts = {
  base: 'https://community.example',
  internalHosts: ['community.example'],
  trustedPopupOrigins: ['https://github.com'],
};

describe('rewriteAnchorHtml', () => {
  it('给外部链接补 target=_blank 和 rel=noopener noreferrer', () => {
    const { html, stats } = rewriteAnchorHtml(
      '<p>看这个 <a href="https://evil.example/post?id=1">链接</a></p>',
      opts,
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(stats.external).toBe(1);
    expect(stats.hardened).toBe(1);
  });

  it('合并已有 rel 且保留 nofollow ugc 等 token', () => {
    const { html } = rewriteAnchorHtml(
      '<a href="https://evil.example" target="_blank" rel="nofollow ugc">x</a>',
      opts,
    );
    expect(html).toMatch(/rel="nofollow ugc noopener noreferrer"/);
  });

  it('站内链接不新增 target，但已有的 target=_blank 会被加固', () => {
    const internal = rewriteAnchorHtml('<a href="/posts/2">内部</a>', opts);
    expect(internal.html).not.toContain('target=');
    const blank = rewriteAnchorHtml('<a href="/posts/2" target="_blank">内部新窗</a>', opts);
    expect(blank.html).toContain('noopener');
  });

  it('移除 javascript: href 但保留链接文本', () => {
    const { html, stats } = rewriteAnchorHtml(
      '<a href="javascript:alert(document.cookie)">点我领红包</a>',
      opts,
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('点我领红包');
    expect(html).toContain('data-safe-navigation-blocked="blocked-protocol"');
    expect(stats.removedHref).toBe(1);
  });

  it('处理大小写/编码绕过尝试', () => {
    const { html } = rewriteAnchorHtml(
      '<a href="  JaVaScRiPt:alert(1)">x</a>',
      opts,
    );
    expect(html.toLowerCase()).not.toContain('javascript:alert');
    expect(html).toContain('data-safe-navigation-blocked');
  });

  it('受信 data-preserve-opener 被保留且不加 noopener', () => {
    const { html, stats } = rewriteAnchorHtml(
      '<a data-preserve-opener href="https://github.com/login" target="oauth">GitHub</a>',
      opts,
    );
    expect(html).toContain('data-preserve-opener');
    expect(html).not.toContain('noopener');
    expect(stats.preservedOpener).toBe(1);
  });

  it('非受信 data-preserve-opener 被移除属性并降级 noopener', () => {
    const { html } = rewriteAnchorHtml(
      '<a data-preserve-opener href="https://evil.example" target="x">x</a>',
      opts,
    );
    expect(html).not.toContain('data-preserve-opener');
    expect(html).toContain('noopener');
  });

  it('幂等：重写两次结果一致', () => {
    const once = rewriteAnchorHtml('<a href="https://evil.example">x</a>', opts).html;
    const twice = rewriteAnchorHtml(once, opts).html;
    expect(twice).toBe(once);
  });

  it('anchorAttrs 辅助函数输出安全属性', () => {
    expect(anchorAttrs('https://evil.example', opts).rel).toContain('noopener');
    expect(anchorAttrs('javascript:alert(1)', opts)).toEqual({});
  });
});
