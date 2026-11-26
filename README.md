# Tabnabbing Guard —— 统一的反向 tabnabbing 防护（TypeScript）

## 它解决什么问题

社区站允许用户在帖子里发外部链接，点击后在新标签页打开。被打开的外部页面可以通过
浏览器保留的 `window.opener` 反向引用原标签页，执行
`window.opener.location = "https://login.仿冒站"`，把用户原来那个标签页悄悄跳转到
仿冒登录页。用户切回来看到“登录过期”，就把账号密码交给了攻击者。站内的弹窗、分享等
所有“打开新窗口”的入口都有同样的问题。

本库用一份 TypeScript 策略，在**前端和服务端统一收口所有打开新窗口的路径**，分层切断
这条攻击链，同时为真正依赖弹窗通信的第三方登录/支付保留一条受控的窄门。

## 三层防御（互补，任一层被绕过其余仍兜底）

| 层 | 机制 | 切断什么 |
| --- | --- | --- |
| 前端 | `rel="noopener noreferrer"` / `window.open` 的 `noopener` feature | 新页面对原页面的 `window.opener` 引用 |
| 前端 | `Referrer-Policy` + `noreferrer` | 原页面 URL（含会话参数）经 `Referer` 泄露给外站 |
| 服务端 | `Cross-Origin-Opener-Policy` 响应头 | 浏览器层面把跨源文档隔离进独立浏览上下文组 |
| 服务端 | 开放重定向白名单校验 | `/redirect?to=` 被利用做站内可信跳转钓鱼 |

## 目录结构

```
src/
  shared/            前后端共用：URL/源判断、白名单匹配、rel 分词、统一策略类型
    url.ts           源解析与白名单（精确源 + 子域通配，默认拒绝）
    policy.ts        GuardPolicy 统一配置与目标归类
    rel.ts           rel token 的合并/剔除（按集合处理，去重）
  browser/
    safeOpen.ts      安全开窗原语 + 弹窗 postMessage 收发（强校验 origin/source）
    dom.ts           TabnabbingGuard：DOM 加固、事件委托、window.open 劫持、MutationObserver
  server/
    headers.ts       COOP / Referrer-Policy 响应头生成与豁免路由
    redirect.ts      开放重定向白名单校验（含 CRLF/协议白名单）
    middleware.ts    原生 node:http 适配（Express/Koa/Fastify 可薄封装）
  examples/server.ts 可运行的端到端演示
test/                63 个 node:test 单元/集成测试（happy-dom 模拟浏览器）
scripts/             esbuild 浏览器打包
```

## 核心设计：默认 noopener，受信任弹窗走窄门

第三方登录（OAuth）和支付依赖 `window.opener` + `postMessage` 在弹窗与父页面间通信，
不能一刀切。本库的规则是：

- **默认一切新窗口 `noopener`**，新页面拿不到原页面引用。
- 只有目标源**显式命中 `trustedPopupOrigins` 白名单**时才保留 opener。
- 白名单同时约束三条路径：静态 `<a target=_blank>`、`<form target=_blank>`、JS `window.open`。
- 弹窗回消息时，`waitForPopupMessage` 同时校验 `event.source === popup` 与
  `event.origin === 精确源`，禁止 `"*"`；回消息的 `postToOpener` 强制精确 `targetOrigin`。
- 配置错误（对非白名单目标调用 `openTrustedPopup`）直接抛错，让问题在测试期暴露，
  而不是静默降级。

```ts
const guard = installTabnabbingGuard({
  policy: {
    trustedPopupOrigins: [
      "https://login.trusted-partner.example",
      "https://*.pay.example", // 通配仅匹配子域，不含裸域
    ],
  },
});

// 受信任登录弹窗：命中白名单，保留 opener 用于 postMessage
const { win } = guard.openTrustedPopup("https://login.trusted-partner.example/oauth");
const result = await waitForPopupMessage<{ token: string }>(win, {
  expectedOrigin: "https://login.trusted-partner.example", // 禁止 "*"
  messageType: "oauth-result",
  validate: (d) => typeof d === "object" && d !== null && "token" in d,
});

// 评论外链/分享：强制 noopener，攻击者页面碰不到本标签页
guard.openExternal("https://任意外站.example/p");
```

## 前端的四条防线（`dom.ts`）

1. **安装时全量加固** + **MutationObserver 持续加固**所有 `target=_blank` 的
   `a` / `area` / `form`，覆盖框架动态渲染。
2. **捕获阶段点击/提交事件委托**，在元素未被 Observer 及时处理时同步补 `rel`。
3. **包装 `window.open`**，让包括第三方 SDK 在内的所有 JS 开窗路径默认 `noopener`。
4. **重入保护**：写 `rel` 触发的 mutation 用 `WeakSet` 标记并忽略，避免 Observer 自激循环。

同源 `target=_blank` 默认也切断 opener——同源页面一旦存在 XSS 被攻破，同样能反向跳转。
若确有同源弹窗通信需求，设 `sameOriginKeepsOpener: true` 显式放开。

## 服务端

```ts
const middleware = createSecurityMiddleware({
  policy: {
    coop: "same-origin-allow-popups", // 默认：隔离但保留受信任弹窗通信
    coopExemptPathPrefixes: ["/oauth/callback"], // 回跳落地页显式 unsafe-none
    allowedRedirectOrigins: ["https://docs.example.com"],
  },
});
// http.createServer((req, res) => { if (middleware(req, res)) return; ... })
```

- `same-origin-allow-popups` 是推荐默认：得到上下文隔离，又不破坏白名单弹窗。
  只有完全不需要弹窗通信的页面才用更强的 `same-origin`。
- 豁免路由返回显式 `unsafe-none`，用于覆盖浏览器可能已缓存的强策略头。
- `planRedirect` 拒绝非 http(s) 协议、控制字符（CRLF 注入）、白名单外源；
  跨站 302 额外下发 `Referrer-Policy: no-referrer`。

## 接入与命令

```bash
npm install
npm run typecheck   # tsc 严格类型检查
npm test            # 63 个测试
npm run build       # tsc 产出 dist/ + esbuild 产出 dist/browser.bundle.js
npm run start:demo  # http://localhost:8787/ 端到端演示
```

浏览器侧直接加载自包含 bundle（挂 `window.TabnabbingGuard`），或把 `src/browser`
交给现有打包器。框架项目（Express/Koa/Fastify/React/Vue）复用 `src/shared` 与
`src/server` 的纯函数，按各自中间件/组件签名薄封装即可——**策略类型前后端共用一份，
白名单口径不会两端漂移**。

## 安全边界与注意事项

- 白名单是这套机制的信任根，应只放真正需要弹窗通信的源，并优先用精确源而非通配。
- `noopener` 是主路径；老浏览器走“开窗后置空 `opener`”兼容路径，此时 COOP 响应头兜底。
- COOP 必须是真实 HTTP 响应头，`<meta>` 无法表达；`Referrer-Policy` 才有 meta 兜底。
- 本库聚焦反向 tabnabbing 与开窗/跳转收口，不替代 CSP、XSS 防护等其它控制措施。
