import { describe, expect, it } from 'vitest';
import {
  buildWindowFeatures,
  classifyUrl,
  decideAnchorSecurity,
  isTrustedPopupOrigin,
  mergeRel,
  secureAnchorProps,
} from '../src/shared/url-policy';

const policy = {
  internalHosts: ['community.example', 'localhost:3000', '.internal.example'],
  trustedPopupOrigins: ['https://github.com', 'https://pay.example.com'],
  base: 'https://community.example/post/1',
};

describe('classifyUrl', () => {
  it('把外部 http 链接识别为 external', () => {
    const r = classifyUrl('https://evil.example/phish', policy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.external).toBe(true);
      expect(r.isWeb).toBe(true);
    }
  });

  it('站内 host 与子域后缀不算外部', () => {
    const main = classifyUrl('https://community.example/x', policy);
    expect(main.ok && main.external).toBe(false);
    const sub = classifyUrl('https://bbs.internal.example/x', policy);
    expect(sub.ok && sub.external).toBe(false);
  });

  it('识别受信弹窗 origin', () => {
    expect(isTrustedPopupOrigin('https://github.com/login/oauth', policy.trustedPopupOrigins!)).toBe(true);
    expect(isTrustedPopupOrigin('https://github.com.evil.com/', policy.trustedPopupOrigins!)).toBe(false);
  });

  it.each([
    ['javascript:alert(1)', 'blocked-protocol'],
    ['  JavaScript:alert(document.cookie)', 'blocked-protocol'],
    // WHATWG URL 会剥离 tab/换行，java\tscript: 必须仍被识别为 javascript:
    ['java\tscript:alert(1)', 'blocked-protocol'],
    ['\njavascript:alert(1)', 'blocked-protocol'],
    ['data:text/html,<script>alert(1)</script>', 'blocked-protocol'],
    ['vbscript:msgbox(1)', 'blocked-protocol'],
    ['file:///etc/passwd', 'blocked-protocol'],
  ])('拦截危险协议 %s', (href, reason) => {
    const r = classifyUrl(href, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('允许相对路径与 mailto/tel', () => {
    expect(classifyUrl('/posts/2', policy).ok).toBe(true);
    expect(classifyUrl('#comment-3', policy).ok).toBe(true);
    expect(classifyUrl('mailto:a@example.com', policy).ok).toBe(true);
    expect(classifyUrl('tel:+8613800000000', policy).ok).toBe(true);
  });

  it('拦截协议相对 URL 指向的外域并标记 external', () => {
    const r = classifyUrl('//evil.example/x', policy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.external).toBe(true);
  });
});

describe('mergeRel', () => {
  it('去重并合并 token', () => {
    expect(mergeRel('nofollow noopener', ['noopener', 'noreferrer'])).toBe(
      'nofollow noopener noreferrer',
    );
  });

  it('加入 noopener 时移除冲突的 opener', () => {
    const rel = mergeRel('opener nofollow', ['noopener']);
    const tokens = rel.split(/\s+/);
    expect(tokens).toContain('noopener');
    expect(tokens).toContain('nofollow');
    expect(tokens).not.toContain('opener');
  });
});

describe('decideAnchorSecurity', () => {
  it('target=_blank 外链得到 noopener+noreferrer', () => {
    const d = decideAnchorSecurity(
      { href: 'https://evil.example', target: '_blank', rel: 'nofollow' },
      policy,
    );
    expect(d.safe).toBe(true);
    expect(d.needsNoopener).toBe(true);
    expect(d.rel).toBe('nofollow noopener noreferrer');
  });

  it('自定义命名 target 也会被加固（不只 _blank）', () => {
    const d = decideAnchorSecurity(
      { href: 'https://evil.example', target: 'share-window' },
      policy,
    );
    expect(d.needsNoopener).toBe(true);
    expect(d.rel).toContain('noopener');
  });

  it('站内 target=_blank 同样补 noopener', () => {
    const d = decideAnchorSecurity({ href: '/other', target: '_blank' }, policy);
    expect(d.needsNoopener).toBe(true);
  });

  it('普通当前标签链接不需要 noopener', () => {
    const d = decideAnchorSecurity({ href: '/other' }, policy);
    expect(d.needsNoopener).toBe(false);
  });

  it('危险协议判定 unsafe', () => {
    const d = decideAnchorSecurity({ href: 'javascript:alert(1)', target: '_blank' }, policy);
    expect(d.safe).toBe(false);
  });

  it('preserveOpener 时不追加 noopener（受信白名单由调用方保证）', () => {
    const d = decideAnchorSecurity(
      { href: 'https://github.com/login', target: 'oauth', preserveOpener: true },
      policy,
    );
    expect(d.needsNoopener).toBe(false);
    expect(d.rel).toBe('');
  });

  it('secureAnchorProps 对危险 URL 不返回 href', () => {
    const props = secureAnchorProps({ href: 'javascript:alert(1)' }, policy);
    expect(props.href).toBeUndefined();
  });
});

describe('buildWindowFeatures', () => {
  it('字符串特性中剥离调用方的 noopener 并按策略追加', () => {
    const out = buildWindowFeatures('width=400,noopener,height=300', { noopener: true });
    expect(out).toBe('width=400,height=300,noopener');
  });

  it('对象特性序列化', () => {
    const out = buildWindowFeatures({ width: 500, popup: true, toolbar: false }, { noopener: true });
    expect(out).toContain('width=500');
    expect(out).toContain('popup');
    expect(out).toContain('toolbar=no');
    expect(out.endsWith('noopener')).toBe(true);
  });
});
