/**
 * SafeLink —— React / SSR 场景下唯一推荐使用的链接组件。
 *
 * 渲染结果在服务端就带好 target/rel，不依赖客户端 hydration，
 * 因此即使 JS 加载失败，反向标签劫持防护依然存在。
 *
 * 第三方登录 / 支付这类需要 opener 通信的“弹窗”不要用 target="_blank" 的
 * SafeLink，而应当用 useTrustedPopup() + 按钮点击调用 openTrustedPopup()。
 */

import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react';
import {
  decideAnchorSecurity,
  PRESERVE_OPENER_ATTRIBUTE,
  type NavigationPolicy,
} from '../shared/url-policy';

export interface SafeLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  /** 强制新标签打开；未显式传 target 时，外部 http 链接默认新标签打开。 */
  newTab?: boolean;
  /**
   * 极少数需要保留 opener 的受信链接。仅当 href 的 origin 命中
   * preserveOpenerOrigins / policy.trustedPopupOrigins 时才会生效。
   */
  preserveOpener?: boolean;
  preserveOpenerOrigins?: readonly string[];
  policy?: NavigationPolicy;
  children?: ReactNode;
}

function originOf(href: string): string | null {
  try {
    return new URL(href, 'https://safe-navigation.local').origin;
  } catch {
    return null;
  }
}

export const SafeLink = forwardRef<HTMLAnchorElement, SafeLinkProps>(function SafeLink(
  { href, newTab, preserveOpener, preserveOpenerOrigins, policy, rel, target, ...rest },
  ref,
) {
  // 外部 http(s) 链接默认新标签打开（与 UGC 重写器行为一致）。
  const preliminary = decideAnchorSecurity({ href, rel }, policy ?? {});
  const finalTarget =
    target ?? (newTab === true || (preliminary.safe && preliminary.external) ? '_blank' : undefined);

  const trustedOrigins = preserveOpenerOrigins ?? policy?.trustedPopupOrigins ?? [];
  const isTrustedPreserve =
    preserveOpener === true && originOf(href) != null && trustedOrigins.includes(originOf(href)!);

  const decision = decideAnchorSecurity(
    {
      href,
      target: finalTarget,
      rel,
      preserveOpener: isTrustedPreserve,
    },
    policy ?? {},
  );

  if (!decision.safe) {
    // 不输出 href，避免 javascript: 等协议执行。
    return <a ref={ref} {...rest} data-safe-navigation-blocked={decision.reason} />;
  }

  return (
    <a
      ref={ref}
      href={href}
      target={finalTarget}
      rel={decision.rel || undefined}
      {...(isTrustedPreserve ? { [PRESERVE_OPENER_ATTRIBUTE]: '' } : {})}
      {...rest}
    />
  );
});
