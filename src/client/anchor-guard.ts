/**
 * 全局锚点守卫：确保页面上【所有】会打开新浏览上下文的 <a> 都带 noopener。
 *
 * 两层机制：
 * 1. 捕获阶段 click 委托 —— 即使链接是点击前一瞬才插入 / 改写的也能拦住；
 *    对危险协议直接 preventDefault。
 * 2. MutationObserver + 启动扫描 —— 给已渲染链接补齐 rel，让用户长按/中键/
 *    “在新标签页打开”等不走 click 的路径同样安全。
 *
 * 例外（需要保留 opener 的极少数场景）：
 * - 元素带 data-preserve-opener 属性且在 allowPreserveOpener 选择器/名单内；
 *   守卫会为其保留 opener，但会校验 href 必须命中 trustedPopupOrigins。
 */

import { decideAnchorSecurity, PRESERVE_OPENER_ATTRIBUTE, type NavigationPolicy } from '../shared/url-policy';

export interface AnchorGuardOptions extends NavigationPolicy {
  /** 是否用 MutationObserver 自动修补 DOM，默认 true。 */
  observeDom?: boolean;
  /** 是否在启动时扫描全文档，默认 true。 */
  scanOnStart?: boolean;
  /** 允许带 data-preserve-opener 保留 opener 的 origin（通常与 trustedPopupOrigins 相同）。 */
  preserveOpenerOrigins?: readonly string[];
  /** 无法修补 / 危险链接被拦截时的回调，可用于上报。 */
  onBlocked?: (info: { anchor: HTMLAnchorElement; reason: string }) => void;
  /** 自定义 document（测试用）。 */
  targetDocument?: Document;
}

export interface AnchorGuard {
  /** 立即扫描一个根节点（默认整个文档）。 */
  scan(root?: ParentNode): number;
  destroy(): void;
}

function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest('a[href]');
}

/** 修补单个锚点，返回是否做了修改。 */
export function hardenAnchor(anchor: HTMLAnchorElement, options: AnchorGuardOptions = {}): boolean {
  const href = anchor.getAttribute('href');
  const target = anchor.getAttribute('target');
  const rel = anchor.getAttribute('rel');
  const wantsPreserve = anchor.hasAttribute(PRESERVE_OPENER_ATTRIBUTE);

  // 显式要求保留 opener：只有受信 origin 才允许，否则降级为 noopener。
  let preserveOpener = false;
  if (wantsPreserve) {
    try {
      const url = new URL(href ?? '', anchor.ownerDocument?.baseURI ?? window.location.href);
      const allow = options.preserveOpenerOrigins ?? options.trustedPopupOrigins ?? [];
      preserveOpener = allow.includes(url.origin);
    } catch {
      preserveOpener = false;
    }
    if (!preserveOpener) anchor.removeAttribute(PRESERVE_OPENER_ATTRIBUTE);
  }

  const decision = decideAnchorSecurity(
    { href, target, rel, preserveOpener },
    { ...options, base: anchor.ownerDocument?.baseURI },
  );

  if (!decision.safe) {
    // 危险协议：移除 href，使其不可导航（保留文本与样式由调用方决定）。
    anchor.removeAttribute('href');
    anchor.setAttribute('data-safe-navigation-blocked', decision.reason ?? 'unsafe');
    anchor.setAttribute('aria-disabled', 'true');
    anchor.classList.add('safe-navigation-blocked');
    return true;
  }

  if (decision.rel && decision.rel !== (rel ?? '')) {
    anchor.setAttribute('rel', decision.rel);
    return true;
  }
  return false;
}

export function installAnchorGuard(options: AnchorGuardOptions = {}): AnchorGuard {
  const doc = options.targetDocument ?? document;
  let observer: MutationObserver | null = null;

  const scan = (root: ParentNode = doc): number => {
    let changed = 0;
    const anchors = root.querySelectorAll?.('a[href], a[data-preserve-opener]');
    anchors?.forEach((a) => {
      if (a instanceof HTMLAnchorElement && hardenAnchor(a, options)) changed++;
    });
    return changed;
  };

  const onClick = (event: MouseEvent) => {
    const anchor = closestAnchor(event.target);
    if (!anchor || !doc.contains(anchor)) return;

    // 修饰键 / 中键不会触发普通 click 导航，但 DOM 修补层已覆盖这些路径。
    if (event.defaultPrevented) return;

    // 点击瞬间同步加固一次（关键：不能直接信任 data-preserve-opener，
    // hardenAnchor 会重新校验其 origin 白名单并处理危险协议），
    // 覆盖节点插入后 MutationObserver 尚未回调的时间窗。
    hardenAnchor(anchor, options);

    const blockedReason = anchor.getAttribute('data-safe-navigation-blocked');
    if (blockedReason || anchor.getAttribute('href') == null) {
      event.preventDefault();
      event.stopPropagation();
      options.onBlocked?.({ anchor, reason: blockedReason ?? 'unsafe' });
    }
  };

  // 捕获阶段，早于业务自己的冒泡处理器，避免业务先 window.open。
  doc.addEventListener('click', onClick, true);

  if (options.scanOnStart !== false) {
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', () => scan(), { once: true });
    } else {
      scan();
    }
  }

  if (options.observeDom !== false && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target instanceof HTMLAnchorElement) {
          hardenAnchor(mutation.target, options);
          continue;
        }
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node instanceof HTMLAnchorElement) hardenAnchor(node, options);
          node.querySelectorAll?.('a[href], a[data-preserve-opener]').forEach((a) => {
            if (a instanceof HTMLAnchorElement) hardenAnchor(a, options);
          });
        });
      }
    });
    observer.observe(doc.documentElement ?? doc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'target', 'rel', PRESERVE_OPENER_ATTRIBUTE],
    });
  }

  return {
    scan,
    destroy() {
      doc.removeEventListener('click', onClick, true);
      observer?.disconnect();
      observer = null;
    },
  };
}
