/**
 * 同构的导航安全策略核心（浏览器 / Node 均可运行，不依赖任何 DOM API）。
 *
 * 这里是全站“打开新窗口”决策的唯一事实来源：
 * - 哪些协议允许导航（拦截 javascript:/data:/vbscript: 等）
 * - 链接是否属于外部站点
 * - 锚点 / window.open 应当使用怎样的 rel / noopener 策略
 * - 哪些 origin 是被信任、允许保留 opener 通信的弹窗提供方
 */

/** 默认允许通过安全封装打开的协议。 */
export const DEFAULT_ALLOWED_PROTOCOLS: readonly string[] = [
  'http:',
  'https:',
  'mailto:',
  'tel:',
] as const;

/** 会渲染成网页、需要考虑反向标签劫持的协议。 */
export const WEB_PROTOCOLS: readonly string[] = ['http:', 'https:'] as const;

/** 明确危险、任何情况下都不允许进入 href / window.open 的协议。 */
export const BLOCKED_PROTOCOLS: readonly string[] = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
] as const;

/** 不会产生新浏览上下文的 target。 */
const SAME_CONTEXT_TARGETS = new Set(['_self', '_top', '_parent']);

/** 显式声明“此链接需要保留 opener”的数据属性，作为少数例外的逃生舱。 */
export const PRESERVE_OPENER_ATTRIBUTE = 'data-preserve-opener';

export interface NavigationPolicy {
  /**
   * 本站 host 列表（`host[:port]` 形式，例如 `community.example`、`localhost:3000`）。
   * 以 `.` 开头时按域名后缀匹配子域，例如 `.example.com` 匹配 `a.example.com`。
   */
  internalHosts?: readonly string[];
  /**
   * 受信任的弹窗提供方 origin 白名单（精确匹配，含协议与端口），
   * 例如 `https://accounts.google.com`、`https://api-m.sandbox.paypal.com`。
   * 只有这些目标允许以“保留 window.opener”的方式打开。
   */
  trustedPopupOrigins?: readonly string[];
  /** 允许导航的协议，默认 {@link DEFAULT_ALLOWED_PROTOCOLS}。 */
  allowedProtocols?: readonly string[];
  /** 外部链接是否额外加 noreferrer（老浏览器上 noreferrer 也能切断 opener），默认 true。 */
  externalNoreferrer?: boolean;
  /**
   * 哪些 target 需要 noopener：
   * - `new-context`（默认）：`_blank` 以及任何自定义命名 target
   * - `external-only`：仅跨域外链
   */
  noopenerScope?: 'new-context' | 'external-only';
}

export interface ResolvedPolicy extends Required<Omit<NavigationPolicy, 'internalHosts' | 'trustedPopupOrigins'>> {
  internalHosts: readonly string[];
  trustedPopupOrigins: readonly string[];
}

export function resolvePolicy(policy: NavigationPolicy = {}): ResolvedPolicy {
  return {
    internalHosts: policy.internalHosts ?? [],
    trustedPopupOrigins: policy.trustedPopupOrigins ?? [],
    allowedProtocols: policy.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS,
    externalNoreferrer: policy.externalNoreferrer ?? true,
    noopenerScope: policy.noopenerScope ?? 'new-context',
  };
}

export type UrlClassifyFailureReason = 'unparseable' | 'blocked-protocol' | 'protocol-not-allowed';

export type ClassifiedUrl =
  | {
      ok: true;
      /** 规范化后的绝对 URL；相对链接在缺少 base 时为 null。 */
      url: URL | null;
      /** 最终协议（带冒号，小写）；无法解析的相对链接为空字符串。 */
      protocol: string;
      /** 是否为 http/https 网页链接。 */
      isWeb: boolean;
      external: boolean;
      trustedPopup: boolean;
    }
  | { ok: false; reason: UrlClassifyFailureReason; protocol: string };

const SCHEME_RE = /^[\s\u0000-\u001f]*([a-z][a-z0-9+.-]*):/i;

/** 提取字符串里显式写出的协议（若有），小写并带冒号。 */
export function extractProtocol(rawHref: string): string {
  const match = SCHEME_RE.exec(rawHref);
  return match ? `${match[1].toLowerCase()}:` : '';
}

/**
 * 安全地解析 URL。
 *
 * 注意：WHATWG URL 会像浏览器一样忽略 URL 中的 TAB / 换行，因此
 * `java\tscript:alert(1)` 会被正确识别为 `javascript:` 并拒绝。
 */
export function classifyUrl(
  rawHref: string | null | undefined,
  options: NavigationPolicy & { base?: string | URL } = {},
): ClassifiedUrl {
  if (rawHref == null) {
    return { ok: false, reason: 'unparseable', protocol: '' };
  }
  const href = String(rawHref);
  const explicitProtocol = extractProtocol(href);
  const allowed = options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;

  if (explicitProtocol && !(allowed as readonly string[]).includes(explicitProtocol)) {
    const reason: UrlClassifyFailureReason = BLOCKED_PROTOCOLS.includes(
      explicitProtocol as (typeof BLOCKED_PROTOCOLS)[number],
    )
      ? 'blocked-protocol'
      : 'protocol-not-allowed';
    return { ok: false, reason, protocol: explicitProtocol };
  }

  let url: URL | null = null;
  try {
    url = options.base ? new URL(href, options.base) : new URL(href);
  } catch {
    // 无法构造绝对 URL：可能是没有 base 的相对链接。只要没有显式危险协议就按内部相对路径处理。
    if (explicitProtocol) {
      return { ok: false, reason: 'unparseable', protocol: explicitProtocol };
    }
    return {
      ok: true,
      url: null,
      protocol: '',
      isWeb: false,
      external: false,
      trustedPopup: false,
    };
  }

  const protocol = url.protocol;
  if (!(allowed as readonly string[]).includes(protocol)) {
    return {
      ok: false,
      reason: BLOCKED_PROTOCOLS.includes(protocol as (typeof BLOCKED_PROTOCOLS)[number])
        ? 'blocked-protocol'
        : 'protocol-not-allowed',
      protocol,
    };
  }

  const external = isExternalHost(url, options.internalHosts ?? []);
  const trustedPopup = (options.trustedPopupOrigins ?? []).includes(url.origin);

  return {
    ok: true,
    url,
    protocol,
    isWeb: (WEB_PROTOCOLS as readonly string[]).includes(protocol),
    external,
    trustedPopup,
  };
}

/** 判断 URL 是否不属于本站。没有配置 internalHosts 时，所有绝对 http(s) 链接都视为外部。 */
export function isExternalHost(url: URL, internalHosts: readonly string[]): boolean {
  if (!(WEB_PROTOCOLS as readonly string[]).includes(url.protocol)) return false;
  if (internalHosts.length === 0) return true;
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return !internalHosts.some((entryRaw) => {
    const entry = entryRaw.toLowerCase();
    if (entry.startsWith('.')) {
      const suffix = entry.slice(1);
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return host === entry || hostname === entry;
  });
}

/** origin 是否在受信弹窗白名单中。 */
export function isTrustedPopupOrigin(
  rawUrl: string | URL,
  trustedPopupOrigins: readonly string[],
  base?: string | URL,
): boolean {
  try {
    const url = typeof rawUrl === 'string' ? new URL(rawUrl, base) : rawUrl;
    return trustedPopupOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

/** 合并 rel token：去重、去除冲突的 opener、按需补 noopener/noreferrer。 */
export function mergeRel(existingRel: string | null | undefined, add: readonly string[]): string {
  const tokens = new Set(
    (existingRel ?? '')
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean),
  );
  if (add.includes('noopener')) tokens.delete('opener');
  for (const token of add) tokens.add(token.toLowerCase());
  return Array.from(tokens).join(' ');
}

export interface AnchorDecisionInput {
  href?: string | null;
  target?: string | null;
  rel?: string | null;
  /** 显式要求保留 opener（对应 data-preserve-opener），默认 false。 */
  preserveOpener?: boolean;
}

export interface AnchorDecision {
  /** 是否允许保留该 href；false 时渲染层应当移除/清空 href。 */
  safe: boolean;
  /** 最终应写入的 rel（可能为空字符串）。 */
  rel: string;
  /** 是否必须加 noopener。 */
  needsNoopener: boolean;
  /** 是否外部网页链接。 */
  external: boolean;
  /** 分类失败原因（safe=false 时）。 */
  reason?: UrlClassifyFailureReason;
}

function opensNewContext(target: string | null | undefined): boolean {
  if (!target) return false;
  return !SAME_CONTEXT_TARGETS.has(target.toLowerCase());
}

/**
 * 给定一个锚点的 href/target/rel，计算安全的 rel 决策。
 * 这是 SSR 渲染、HTML 重写器、客户端兜底守卫共享的核心逻辑。
 */
export function decideAnchorSecurity(
  input: AnchorDecisionInput,
  policy: NavigationPolicy & { base?: string | URL } = {},
): AnchorDecision {
  const resolved = resolvePolicy(policy);
  const classified = classifyUrl(input.href, { ...resolved, base: policy.base });

  if (!classified.ok) {
    // 危险协议：不输出 href，仅保留原有 rel（渲染层可自行决定）。
    return {
      safe: false,
      rel: input.rel ?? '',
      needsNoopener: false,
      external: false,
      reason: classified.reason,
    };
  }

  const external = classified.external;
  const newContext = opensNewContext(input.target);
  const scopeMatches =
    resolved.noopenerScope === 'external-only' ? external && classified.isWeb : newContext;

  // mailto:/tel: 等不会产生网页窗口，不需要 noopener。
  let needsNoopener =
    scopeMatches && classified.isWeb && !input.preserveOpener ? true : false;

  // 受信弹窗提供方如果通过 <a> 而非弹窗管理器打开，也不需要在这里切断，
  // 但常规最佳实践仍然是 noopener；真正的弹窗通信走 openTrustedPopup。
  if (input.preserveOpener) needsNoopener = false;

  const add: string[] = [];
  if (needsNoopener) add.push('noopener');
  if (needsNoopener && external && resolved.externalNoreferrer) add.push('noreferrer');

  // 即使没有 target，如果原 rel 已写 noopener，mergeRel 也会规范化冲突。
  const rel = add.length > 0 ? mergeRel(input.rel, add) : (input.rel ?? '').trim();

  return { safe: true, rel, needsNoopener, external };
}

/** 供 SSR / React 使用：直接返回应当展开到 `<a>` 上的安全属性。 */
export function secureAnchorProps(
  input: AnchorDecisionInput,
  policy: NavigationPolicy & { base?: string | URL } = {},
): {
  href: string | undefined;
  rel: string | undefined;
  'data-navigation'?: string;
} {
  const decision = decideAnchorSecurity(input, policy);
  if (!decision.safe) {
    return { href: undefined, rel: decision.rel || undefined };
  }
  return {
    href: input.href ?? undefined,
    rel: decision.rel || undefined,
    ...(decision.external ? { 'data-navigation': 'external' as const } : {}),
  };
}

/**
 * 计算 window.open 的 features 字符串。
 * 当 noopener=true 时强制加入 noopener（并不再需要任何 opener 通信）。
 */
export function buildWindowFeatures(
  features: string | Record<string, string | number | boolean | undefined> | undefined,
  opts: { noopener: boolean; noreferrer?: boolean },
): string {
  const parts: string[] = [];
  if (typeof features === 'string') {
    for (const piece of features.split(',')) {
      const key = piece.split('=')[0]?.trim().toLowerCase();
      if (!key) continue;
      // 丢弃调用方自己写的 noopener/noreferrer，稍后按策略统一追加，避免重复/冲突。
      if (key === 'noopener' || key === 'noreferrer') continue;
      parts.push(piece.trim());
    }
  } else if (features) {
    for (const [key, value] of Object.entries(features)) {
      if (value === undefined) continue;
      if (key.toLowerCase() === 'noopener' || key.toLowerCase() === 'noreferrer') continue;
      parts.push(value === true ? key : value === false ? `${key}=no` : `${key}=${String(value)}`);
    }
  }
  if (opts.noopener) parts.push('noopener');
  if (opts.noreferrer) parts.push('noreferrer');
  return parts.join(',');
}
