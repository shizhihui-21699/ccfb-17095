import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSecurityHeaders,
  coopByPath,
  securityHeadersMiddleware,
} from '../src/server/security-headers';

describe('buildSecurityHeaders', () => {
  it('默认下发 same-origin-allow-popups（兼容登录/支付弹窗）', () => {
    const h = buildSecurityHeaders();
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('可对敏感路由配置 same-origin', () => {
    const select = coopByPath(['/settings', '/admin']);
    expect(select({ url: '/settings/profile' } as IncomingMessage)).toBe('same-origin');
    expect(select({ url: '/posts/1?x=1' } as IncomingMessage)).toBe('same-origin-allow-popups');
  });

  it('函数形式按请求计算 COOP', () => {
    const h = buildSecurityHeaders({ url: '/settings' } as IncomingMessage, {
      coop: (req) => ((req.url ?? '').startsWith('/settings') ? 'same-origin' : 'same-origin-allow-popups'),
    });
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });

  it('reportOnly 时使用 Report-Only 头并带 report-to', () => {
    const h = buildSecurityHeaders(undefined, {
      reportOnly: true,
      reportTo: 'coop',
      reportingEndpoints: 'coop="https://logs.example/coop"',
    });
    expect(h['Cross-Origin-Opener-Policy-Report-Only']).toContain('same-origin-allow-popups');
    expect(h['Cross-Origin-Opener-Policy-Report-Only']).toContain('report-to="coop"');
    expect(h['Reporting-Endpoints']).toContain('logs.example');
    expect(h['Cross-Origin-Opener-Policy']).toBeUndefined();
  });

  it('中间件把头部写到 res 并调用 next', () => {
    const setHeader = vi.fn();
    const next = vi.fn();
    const res = { setHeader } as unknown as import('node:http').ServerResponse;
    securityHeadersMiddleware()({ url: '/' } as IncomingMessage, res, next);
    expect(setHeader).toHaveBeenCalledWith(
      'Cross-Origin-Opener-Policy',
      'same-origin-allow-popups',
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
