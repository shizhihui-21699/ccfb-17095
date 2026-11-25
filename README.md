# safe-navigation-kit

统一治理全站所有"打开新窗口 / 新标签"的入口，切断新页面对原页面的 `window.opener` 反向引用，
并用 `Cross-Origin-Opener-Policy`（COOP）隔离浏览上下文；同时保证第三方登录、支付等
**依赖弹窗与原页面通信的流程不被弄坏**。

技术栈：TypeScript（同构核心，浏览器 / Node 均可用）、Express 中间件、React 组件/Hook、
Vitest + happy-dom（66 个单测）、Playwright + 真实 Chromium（8 个端到端验证）。

---

## 1. 漏洞原理：反向标签劫持（Reverse Tabnabbing）

社区帖子里有一个外链：

```html
<a href="https://evil.example" target="_blank">外部链接</a>
```

如果没有 `rel="noopener"`，外部页面能拿到 `window.opener`：

```js
// evil.example 上的脚本
if (window.opener) {
  // 跨源时不能读 opener.location，但可以“写”——这是关键
  window.opener.location = 'https://evil.example/login-clone';
}
```

用户原标签被静默跳到仿冒登录页，切回来以为"登录过期"，于是输入账号密码。
站内的分享小窗、各种 `window.open` 入口都有同样问题。

> 现代浏览器对 `target="_blank"` 隐式补 `noopener`，但：旧 WebView / 旧浏览器、
> 显式 `rel="opener"`、命名 target、以及大量裸 `window.open(url, name, features)`
> 仍然保留 opener。安全响应头还能提供独立于代码的第二道防线。

---

## 2. 设计：三种开窗语义，区别对待

关键认知是**不能一刀切 noopener**。登录 / 支付弹窗必须保留 opener 才能 `postMessage`。

| 场景 | API | opener | 安全机制 |
| --- | --- | --- | --- |
| 不可信外链、分享窗 | `openExternal()` / `<SafeLink>` / UGC 重写 | **切断** | `noopener,noreferrer` + 协议白名单 |
| 遗留代码 / 第三方 SDK 裸调 `window.open` | `installWindowOpenGuard()` | 外链切断，受信源保留 | origin 白名单 + features 强制改写 |
| OAuth / 支付弹窗 | `openTrustedPopup()` / `useTrustedPopup()` | **刻意保留**（或用 BC） | origin + source + channelId 三重校验，BroadcastChannel 兜底 |

外加两层与业务代码无关的兜底：

- **DOM 层**：`installAnchorGuard()` 用捕获阶段事件委托 + MutationObserver，
  覆盖首屏、异步渲染、UGC、点击前一瞬等所有时间窗。
- **响应头层**：COOP 按路由下发，做浏览器进程级的浏览上下文组隔离。
- **CI 层**：`scripts/audit-navigation.mjs` 用 TypeScript AST 阻止新的裸 `window.open`
  和不安全的 `<a target="_blank">` 合入。

```
                       ┌─────────────────────────────────────────────┐
  写代码的正道          │ openExternal / SafeLink / openTrustedPopup    │
                       └───────────────┬─────────────────────────────┘
                                       │ 遗漏 / 第三方脚本
                       ┌───────────────▼─────────────────────────────┐
  运行时兜底            │ anchorGuard(点击+DOM) · windowOpenGuard       │
                       └───────────────┬─────────────────────────────┘
                                       │ 仍有裸调用 / 0-day
                       ┌───────────────▼─────────────────────────────┐
  浏览器/服务端兜底      │ COOP same-origin(-allow-popups) + Referrer-Policy │
                       └─────────────────────────────────────────────┘
```

---

## 3. 快速开始

```bash
npm install
npm test          # 66 个单元测试
npm run typecheck # tsc 严格类型检查
npm run audit     # AST 静态审计：是否有未授权的开窗调用
npm run verify    # typecheck + audit + test + 构建 demo  bundle

# 端到端（会自动拉起 3 个源；首次需 npx playwright install chromium）
npm run verify:e2e

# 手动体验
npm run demo
#   社区主站      http://localhost:3000
#   受信第三方    http://127.0.0.1:3100  （模拟 OAuth / 收银台）
#   不可信外部源  http://127.0.0.1:3200  （攻击实验页）
```

打开首页可以：检查被服务端重写的帖子链接、点"遗留 window.open"看守卫改写、
走完整 GitHub 风格登录和支付弹窗；再打开 `/legacy`（无防护对照组，可真实复现劫持）
和 `/strict`（仅靠 COOP `same-origin` 即使裸 `window.open` 也安全）对比。

---

## 4. 核心用法

### 4.1 同构策略核心 `src/shared/url-policy.ts`

前后端唯一的决策事实来源，不依赖 DOM：

```ts
import { decideAnchorSecurity, classifyUrl, mergeRel } from './src/shared';

decideAnchorSecurity(
  { href: 'https://evil.example', target: '_blank', rel: 'nofollow' },
  { internalHosts: ['community.example'] },
);
// { safe: true, needsNoopener: true, rel: 'nofollow noopener noreferrer', ... }

classifyUrl('java\tscript:alert(1)'); // WHATWG URL 会剥 TAB → 正确识别为 javascript:
// { ok: false, reason: 'blocked-protocol' }
```

默认拦截 `javascript:` / `vbscript:` / `data:` / `file:`，允许 `http(s)` / `mailto` / `tel`。

### 4.2 普通外链：`openExternal`

```ts
import { openExternal } from './src/client';

openExternal(post.sourceUrl, { internalHosts: ['community.example'] });
// 内部等价于 window.open(url, '_blank', 'noopener,noreferrer,...')，并按规范返回 null
```

### 4.3 全局守卫（应用入口安装一次）

```ts
import { installAnchorGuard, installWindowOpenGuard } from './src/client';

const policy = {
  internalHosts: ['community.example', '.internal.example'],
  trustedPopupOrigins: ['https://accounts.google.com', 'https://api.pay.example'],
};

installAnchorGuard({ ...policy, preserveOpenerOrigins: policy.trustedPopupOrigins });
installWindowOpenGuard({ ...policy });
```

`window.open` 守卫的判定顺序（`src/client/safe-open.ts`）：

1. 受信弹窗 origin → **原样保留 opener**（不能弄坏登录/支付 SDK）；
2. `http(s)` 其它地址 → features 强制补 `noopener`，对外返回 `null`；
3. `''` / `about:blank` → 默认放行（很多支付 SDK 会先开空白窗再提交表单到该窗口）；
4. `javascript:` / `data:` 等 → 直接抛 `UnsafeUrlError`，不调用原生 `open`。

### 4.4 OAuth / 支付弹窗：`openTrustedPopup`

```ts
const channel = openTrustedPopup<{ token: string }>(
  (channelId) =>
    `https://provider.example/oauth?state=${channelId}&redirect_uri=${location.origin}/popup-bridge`,
  {
    provider: 'provider',
    // 同源桥接页 + （如果提供方直接跨源 postMessage）提供方 origin
    allowedOrigins: [location.origin, 'https://provider.example'],
    timeoutMs: 120_000,
  },
);

const credential = await channel.result; // { token }
```

安全保证：

- `channelId` 是随机 UUID，写进 OAuth `state` / URL；
- `message` 事件必须同时满足 `event.origin ∈ allowedOrigins`、
  `event.source === 本次 popupWindow`、`channelId` 一致、消息形状合法；
- 任何一项不符都被静默忽略；带超时、关闭检测（含 COOP 误报宽限）、完整清理。

React 中使用 `useTrustedPopup<T>()`，组件卸载自动关闭弹窗。

### 4.5 服务端 UGC 重写（首屏 HTML 即安全）

```ts
import { rewriteAnchorHtml } from './src/server';

const { html, stats } = rewriteAnchorHtml(post.contentHtml, {
  base: 'https://community.example',
  internalHosts: ['community.example'],
  trustedPopupOrigins: ['https://accounts.google.com'],
});
res.send(renderPost(html));
```

它会：外链补 `target="_blank"` 与合并后的 `rel="noopener noreferrer"`；
站内已有的 `target="_blank"` 补 `noopener`（不额外加 `noreferrer`，避免丢站内 referrer）；
摘除危险协议的 `href`（保留文本）；非白名单的 `data-preserve-opener` 被降级。
**幂等**，可安全重复执行。

> 这一层只解决导航安全。完整的 UGC XSS 防护仍应使用 DOMPurify 等做白名单消毒。

### 4.6 React SSR：`<SafeLink>`

```tsx
<SafeLink href={url} policy={policy} newTab>{title}</SafeLink>
```

服务端渲染出的 HTML 就带好 `target` / `rel`，不依赖 hydration；危险 URL 不输出 `href`。

---

## 5. COOP 响应头与"不能弄坏弹窗"的关键细节

### 5.1 推荐头策略

```ts
import { securityHeadersMiddleware, coopByPath } from './src/server';

app.use(
  securityHeadersMiddleware({
    // 含登录/支付弹窗的页面默认 allow-popups
    coop: coopByPath(['/settings', '/admin', '/account']), // 这些路由升级为 same-origin
  }),
);
// 实际下发：
// Cross-Origin-Opener-Policy: same-origin-allow-popups   （默认）
// Referrer-Policy: strict-origin-when-cross-origin
// X-Content-Type-Options: nosniff
```

- `same-origin-allow-popups`（默认）：隔离本站上下文，同时允许本站主动打开的、
  自身不设 COOP（即默认 `unsafe-none`）的第三方弹窗保留 `window.opener`。
  **这是兼顾 OAuth/支付的主力值。**
- `same-origin`：最强。跨源弹窗与本站不在同一浏览上下文组，opener 为 `null`。
  用在不发起弹窗的敏感页面（文章页、设置/后台）。即使代码裸调 `window.open` 也安全。
- 建议先上 `Cross-Origin-Opener-Policy-Report-Only` + `report-to` 观察，再切强制。

### 5.2 一个真实的坑：OAuth 跳回同源桥接页时 opener 会消失

端到端实验观察到的完整过程：

1. 主站（COOP `same-origin-allow-popups`）`window.open` 打开跨源提供方（无 COOP）：
   **此时提供方页面里 `window.opener` 还在**，支付页可以直接
   `window.opener.postMessage(..., targetOrigin)`。
2. 提供方授权后跳回本站 `/popup-bridge`。如果桥接页也发 `same-origin-allow-popups`
   或 `same-origin`，其 COOP 与弹窗当前的跨源 `unsafe-none` 文档不匹配，
   触发**浏览上下文组切换，`window.opener` 变成 `null`**，桥接页无法再用 opener 回传。

本仓库给出两种已在真实 Chromium 验证的解法（可同时使用）：

- **解法 A（最简单）**：让 `/popup-bridge` 下发 `Cross-Origin-Opener-Policy: unsafe-none`
  （覆盖全局头），不发生组切换，继续用 `window.opener.postMessage`。该页瞬时存在、立即关闭。
- **解法 B（最强，demo 默认）**：桥接页照常发 `same-origin`，opener 被切断也没关系，
  改用 **BroadcastChannel** 回传。BC 按同源隔离、不引用 window、**能穿越 COOP 组切换**，
  打开方的 `openTrustedPopup` 同时监听 message 与 BC。已用 E2E 验证：
  桥接页 `same-origin` 下 OAuth 依然成功。

桥接页 `demo/bridge.ts` 两种传输都会尝试。注意 BroadcastChannel 是同源通道，
跨源的支付页不能用它——那种"提供方直接 postMessage"的流程依赖解法 A 中的
`same-origin-allow-popups`（在提供方阶段 opener 尚未被切断），同样已 E2E 验证。

### 5.3 为什么 COOP `same-origin` 下攻击页 opener 是 null

COOP 让顶层文档独占一个浏览上下文组；跨源打开的页面被放进另一个组，
浏览器直接不提供 opener 引用。E2E 中 `/strict` 页面故意裸调
`window.open(evilUrl, '_blank')` 且不加 noopener，攻击页仍报告 `opener === null`。

---

## 6. 静态审计 / CI 卡点

`scripts/audit-navigation.mjs` 用项目自带的 TypeScript 编译器扫描 `src`、`demo`：

- 未豁免的 `window.open(...)` / `globalThis.open(...)` 调用；
- 字面量 `<a target="_blank">` 但 `rel` 不含 `noopener`。

统一封装实现文件内置白名单；个别确需裸调用的地方，在上一行或行尾写明原因：

```ts
// safe-navigation-allow: 这里是遗留 SDK 适配层，已用 origin 白名单约束
window.open(url, name, features);
```

在装了 `typescript-eslint` 的仓库，等价的 ESLint 方向是开启
`react/jsx-no-target-blank`（`allowReferrer: false`）并用 `no-restricted-properties`
限制 `window.open` 只能来自导航模块。

---

## 7. 迁移 Checklist

1. 服务端给所有 HTML 响应加 COOP，先 `same-origin-allow-popups`
   （可先 Report-Only）+ `Referrer-Policy`。
2. UGC / Markdown / 富文本输出统一过 `rewriteAnchorHtml`；历史数据可跑一次性脚本批量重写。
3. 全站 `<a target="_blank">` 替换为 `<SafeLink>` 或保证
   `rel="noopener"`（外链再加 `noreferrer`）。
4. 所有 `window.open` 收口到 `openExternal` / `openTrustedPopup`；
   暂时无法改造的第三方脚本，用 `installWindowOpenGuard` 兜底并配置受信 origin。
5. 梳理所有弹窗回调页：支付类（提供方直接 postMessage）保留
   `same-origin-allow-popups`；OAuth 桥接页选择 5.2 的 A 或 B。
6. 把 `npm run audit` 接入 CI，禁止新增未授权开窗点。
7. 用 `/legacy`、`/strict` 两个对照页和 `npm run verify:e2e` 做回归。

---

## 8. 目录结构

```
src/
  shared/url-policy.ts       # 同构：URL 分类、rel 决策、features 构造、策略类型
  shared/popup-protocol.ts   # 弹窗消息协议 + origin/source/channel 校验（同构）
  client/safe-open.ts        # openExternal/openSameTab + window.open 守卫
  client/popup-channel.ts    # openTrustedPopup + BroadcastChannel 兜底
  client/anchor-guard.ts     # 事件委托 + MutationObserver 全局链接守卫
  react/SafeLink.tsx         # SSR 安全链接
  react/useTrustedPopup.ts   # React 弹窗 Hook
  server/security-headers.ts # COOP 等响应头 + Express 中间件 + coopByPath
  server/html-rewrite.ts     # UGC HTML 锚点重写（node-html-parser）
scripts/audit-navigation.mjs # TS AST 静态审计
test/                        # 66 个 Vitest 单测
e2e/verify.mjs               # 8 个真实 Chromium 端到端验证
demo/server.ts               # 三源演示服务
demo/client.ts demo/bridge.ts
```

---

## 9. 边界说明

- 本套件解决的是 `window.opener` 反向引用与浏览上下文隔离，**不替代 XSS 消毒、
  CSP、Cookie SameSite、CSRF 防护**。建议同时部署严格 CSP 与
  `SameSite=Lax/Strict` 的会话 Cookie。
- COOP 与跨源隔离相关的 `Cross-Origin-Embedder-Policy: require-corp` 是两件事；
  若站点需要 `SharedArrayBuffer` 等才需要 COEP，贸然开启会拦截未授权跨源子资源。
- `noopener` 会使 `window.open` 按规范返回 `null`，依赖该返回值操作新窗口的旧代码
  必须迁移到无 opener 的方案或受信弹窗通道。

---

## 10. 验证结果

- `npm run verify`：typecheck ✅、audit ✅、66/66 单测 ✅、demo 构建 ✅。
- `npm run verify:e2e`（Chromium，三真实源）：8/8 ✅，覆盖
  服务端 rel、守卫切断 opener、对照组劫持成功、COOP same-origin 独立隔离、
  OAuth 桥接（含 BC 穿越 same-origin COOP）、支付跨源 postMessage。
