import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsafeUrlError, installWindowOpenGuard, openExternal } from '../src/client/safe-open';

/**
 * happy-dom 把 window.open 实现为访问器属性，vi.spyOn 之后再赋值会被 spy 包装干扰，
 * 因此这里统一用“保存原引用 + 直接替换 + 手动还原”的方式打桩。
 */
let originalOpen: typeof window.open;
let openMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalOpen = window.open;
  openMock = vi.fn(() => ({ tag: 'popup' }) as unknown as Window);
  window.open = openMock as unknown as typeof window.open;
});

afterEach(() => {
  window.open = originalOpen;
  delete (window as unknown as Record<string, unknown>).__safeOpenGuardInstalled;
  vi.restoreAllMocks();
});

describe('openExternal', () => {
  it('以 noopener,noreferrer 打开外部链接并返回 null', () => {
    const result = openExternal('https://evil.example/x', {
      internalHosts: ['community.example'],
    });
    expect(result).toBeNull();
    expect(openMock).toHaveBeenCalledTimes(1);
    const [url, target, features] = openMock.mock.calls[0]!;
    expect(url).toBe('https://evil.example/x');
    expect(target).toBe('_blank');
    expect(String(features)).toContain('noopener');
    expect(String(features)).toContain('noreferrer');
  });

  it('拒绝 javascript: URL', () => {
    expect(() => openExternal('javascript:alert(1)')).toThrow(UnsafeUrlError);
  });
});

describe('installWindowOpenGuard', () => {
  it('非受信外链被强制补 noopener 且对外返回 null', () => {
    const guard = installWindowOpenGuard({
      trustedPopupOrigins: ['https://github.com'],
    });
    const ret = window.open('https://evil.example/', '_blank', 'width=400');
    expect(ret).toBeNull();
    const [url, target, features] = openMock.mock.calls[0]!;
    expect(url).toBe('https://evil.example/');
    expect(target).toBe('_blank');
    expect(String(features)).toContain('noopener');
    guard.restore();
  });

  it('受信登录 origin 原样保留 opener（不加 noopener）', () => {
    const guard = installWindowOpenGuard({
      trustedPopupOrigins: ['https://github.com'],
    });
    window.open('https://github.com/login/oauth', 'github-oauth', 'width=500');
    const [url, name, features] = openMock.mock.calls[0]!;
    expect(url).toBe('https://github.com/login/oauth');
    expect(name).toBe('github-oauth');
    expect(String(features)).not.toContain('noopener');
    guard.restore();
  });

  it('about:blank 空白弹窗默认放行（支付 SDK 先开窗后提交表单的模式）', () => {
    const guard = installWindowOpenGuard({ trustedPopupOrigins: [] });
    window.open('', 'payment-window');
    expect(openMock).toHaveBeenCalledWith('', 'payment-window', undefined);
    guard.restore();
  });

  it('javascript: URL 直接拒绝且不调用原生 open', () => {
    const guard = installWindowOpenGuard();
    expect(() => window.open('javascript:alert(1)')).toThrow(UnsafeUrlError);
    expect(openMock).not.toHaveBeenCalled();
    guard.restore();
  });

  it('restore 后精确恢复原始 window.open', () => {
    const before = window.open; // 当前是 openMock
    const guard = installWindowOpenGuard();
    expect(window.open).not.toBe(before);
    guard.restore();
    expect(window.open).toBe(before);
  });

  it('重复安装是幂等的，restore 一次即可还原', () => {
    const before = window.open;
    const g1 = installWindowOpenGuard();
    const g2 = installWindowOpenGuard();
    expect(window.open).not.toBe(before);
    g2.restore(); // 幂等安装返回的空 restore
    expect(window.open).not.toBe(before);
    g1.restore();
    expect(window.open).toBe(before);
  });
});
