/**
 * 服务端 UGC HTML 重写器。
 *
 * 社区帖子 / 评论里的外链是反向标签劫持的主要入口。无论内容来自 Markdown 渲染、
 * 富文本编辑器还是旧数据，在输出到页面前统一经过 rewriteAnchorHtml()：
 *
 * - 外部 http(s) 链接：target="_blank" + rel="noopener noreferrer"（合并已有 rel，去重）
 * - 站内链接：保持当前标签；若编辑者已写 target="_blank"，同样补 noopener
 * - javascript:/data:/vbscript: 等危险 href：直接移除 href（保留文本节点）
 * - data-preserve-opener 仅当 origin 命中受信弹窗白名单时保留，否则降级 noopener
 *
 * 这一层与客户端 MutationObserver 守卫互为兜底：首屏 HTML 即安全，且不依赖 JS 执行。
 */

import { parse } from 'node-html-parser';
import {
  decideAnchorSecurity,
  PRESERVE_OPENER_ATTRIBUTE,
  type NavigationPolicy,
} from '../shared/url-policy';

export interface RewriteHtmlOptions extends NavigationPolicy {
  /** 是否为外部 http(s) 链接补 target="_blank"，默认 true（符合社区站外链新标签打开的约定）。 */
  externalTargetBlank?: boolean;
  /** 自定义 base（用于解析相对/协议相对 URL），通常传站点 canonical origin。 */
  base?: string;
}

export interface RewriteStats {
  anchors: number;
  hardened: number;
  external: number;
  removedHref: number;
  preservedOpener: number;
}

export interface RewriteResult {
  html: string;
  stats: RewriteStats;
}

/** 重写一段 HTML 字符串，返回新字符串与统计信息。 */
export function rewriteAnchorHtml(input: string, options: RewriteHtmlOptions = {}): RewriteResult {
  const root = parse(input ?? '');
  const anchors = root.querySelectorAll('a');
  const stats: RewriteStats = {
    anchors: anchors.length,
    hardened: 0,
    external: 0,
    removedHref: 0,
    preservedOpener: 0,
  };

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') ?? null;
    const target = anchor.getAttribute('target');
    const rel = anchor.getAttribute('rel');
    const wantsPreserve = anchor.hasAttribute(PRESERVE_OPENER_ATTRIBUTE);

    let preserveOpener = false;
    if (wantsPreserve) {
      try {
        const url = new URL(href ?? '', options.base);
        preserveOpener = (options.trustedPopupOrigins ?? []).includes(url.origin);
      } catch {
        preserveOpener = false;
      }
      if (!preserveOpener) anchor.removeAttribute(PRESERVE_OPENER_ATTRIBUTE);
    }

    const preliminary = decideAnchorSecurity(
      { href, target, rel, preserveOpener },
      { ...options, base: options.base },
    );

    if (!preliminary.safe) {
      anchor.removeAttribute('href');
      anchor.setAttribute('data-safe-navigation-blocked', preliminary.reason ?? 'unsafe');
      stats.removedHref++;
      continue;
    }

    // 外部链接按站点约定补 target="_blank"。必须先确定最终 target，
    // 再计算 noopener 决策（没有 target 时策略不会主动加 noopener）。
    let effectiveTarget = target ?? undefined;
    if (
      !effectiveTarget &&
      options.externalTargetBlank !== false &&
      preliminary.external
    ) {
      effectiveTarget = '_blank';
      anchor.setAttribute('target', '_blank');
    }

    const decision = decideAnchorSecurity(
      { href, target: effectiveTarget, rel, preserveOpener },
      { ...options, base: options.base },
    );

    if (decision.external) stats.external++;
    if (preserveOpener) stats.preservedOpener++;

    // 任何会打开新上下文的链接都写入合并后的 rel。
    if (decision.rel && decision.rel !== (rel ?? '')) {
      anchor.setAttribute('rel', decision.rel);
      stats.hardened++;
    }

    // 安全加固：防止一些老浏览器 / 编辑器写入 target 大小写变体。
    if (target && target.toLowerCase() !== target) {
      anchor.setAttribute('target', target.toLowerCase());
    }
  }

  return { html: root.toString(), stats };
}

/** 模板渲染辅助：返回可直接展开到 <a> 的安全属性（服务端模板 / React 之外的场景）。 */
export function anchorAttrs(
  href: string,
  options: RewriteHtmlOptions = {},
): { href?: string; target?: '_blank'; rel?: string } {
  const decision = decideAnchorSecurity({ href, target: '_blank' }, { ...options, base: options.base });
  if (!decision.safe) return {};
  return {
    href,
    target: '_blank',
    ...(decision.rel ? { rel: decision.rel } : {}),
  };
}
