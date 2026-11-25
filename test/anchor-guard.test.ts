import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAnchorGuard, type AnchorGuard } from '../src/client/anchor-guard';

const options = {
  internalHosts: ['community.example'],
  trustedPopupOrigins: ['https://github.com'],
  preserveOpenerOrigins: ['https://github.com'],
};

describe('installAnchorGuard', () => {
  let guard: AnchorGuard | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    guard?.destroy();
    guard = null;
    document.body.innerHTML = '';
  });

  it('启动时修补已存在的 target=_blank 外链', () => {
    document.body.innerHTML =
      '<a id="x" href="https://evil.example" target="_blank" rel="nofollow">x</a>';
    guard = installAnchorGuard(options);
    const a = document.querySelector<HTMLAnchorElement>('#x')!;
    expect(a.getAttribute('rel')).toBe('nofollow noopener noreferrer');
  });

  it('没有 target 的外链在仅扫描模式下不被强加 rel（由渲染层决定 target）', () => {
    document.body.innerHTML = '<a id="x" href="https://evil.example">x</a>';
    guard = installAnchorGuard(options);
    const a = document.querySelector<HTMLAnchorElement>('#x')!;
    expect(a.getAttribute('rel')).toBeNull();
  });

  it('MutationObserver 修补动态插入的链接', async () => {
    document.body.innerHTML = '<div id="post"></div>';
    guard = installAnchorGuard(options);
    document.querySelector('#post')!.insertAdjacentHTML(
      'beforeend',
      '<a id="dyn" href="https://evil.example" target="_blank">dyn</a>',
    );
    await vi.waitFor(() => {
      const a = document.querySelector<HTMLAnchorElement>('#dyn')!;
      expect(a.getAttribute('rel')).toContain('noopener');
    });
  });

  it('动态修改 href/target 属性后重新加固', async () => {
    document.body.innerHTML = '<a id="a" href="/internal">a</a>';
    guard = installAnchorGuard(options);
    const a = document.querySelector<HTMLAnchorElement>('#a')!;
    a.setAttribute('target', '_blank');
    a.setAttribute('href', 'https://evil.example');
    await vi.waitFor(() => expect(a.getAttribute('rel')).toContain('noopener'));
  });

  it('移除 UGC 中 javascript: 链接的 href', async () => {
    document.body.innerHTML = '<a id="x" href="javascript:alert(1)">x</a>';
    guard = installAnchorGuard(options);
    await vi.waitFor(() => {
      const a = document.querySelector<HTMLAnchorElement>('#x')!;
      expect(a.hasAttribute('href')).toBe(false);
      expect(a.getAttribute('data-safe-navigation-blocked')).toBeTruthy();
    });
  });

  it('点击危险链接时阻止默认导航', () => {
    guard = installAnchorGuard({ ...options, observeDom: false });
    const a = document.createElement('a');
    a.setAttribute('href', 'javascript:alert(1)');
    document.body.appendChild(a);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('点击瞬间同步校验未受信 data-preserve-opener（observer 尚未处理的时间窗）', () => {
    guard = installAnchorGuard({ ...options, observeDom: false, scanOnStart: false });
    const a = document.createElement('a');
    a.setAttribute('data-preserve-opener', '');
    a.setAttribute('href', 'https://evil.example');
    a.setAttribute('target', 'x');
    document.body.appendChild(a);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);

    expect(a.hasAttribute('data-preserve-opener')).toBe(false);
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('受信 origin 的 data-preserve-opener 在点击路径也不被加 noopener', () => {
    guard = installAnchorGuard({ ...options, observeDom: false, scanOnStart: false });
    const a = document.createElement('a');
    a.setAttribute('data-preserve-opener', '');
    a.setAttribute('href', 'https://github.com/login');
    a.setAttribute('target', 'oauth');
    document.body.appendChild(a);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);

    expect(a.getAttribute('rel') ?? '').not.toContain('noopener');
    expect(a.hasAttribute('data-preserve-opener')).toBe(true);
  });

  it('受信 origin 的 data-preserve-opener 不被加 noopener', async () => {
    document.body.innerHTML =
      '<a id="gh" data-preserve-opener href="https://github.com/login" target="oauth">gh</a>';
    guard = installAnchorGuard(options);
    await vi.waitFor(() => {
      const a = document.querySelector<HTMLAnchorElement>('#gh')!;
      expect(a.getAttribute('rel') ?? '').not.toContain('noopener');
    });
  });

  it('非受信 origin 的 data-preserve-opener 被降级为 noopener', async () => {
    document.body.innerHTML =
      '<a id="evil" data-preserve-opener href="https://evil.example" target="x">e</a>';
    guard = installAnchorGuard(options);
    await vi.waitFor(() => {
      const a = document.querySelector<HTMLAnchorElement>('#evil')!;
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.hasAttribute('data-preserve-opener')).toBe(false);
    });
  });
});
