/**
 * 端到端演示服务器（零第三方框架依赖，仅用 node:http）。
 *
 * 启动：npm run start:demo
 * 访问：http://localhost:8787/
 *
 * 演示三条链路：
 * 1. 帖子外链 -> 新标签页无 opener，外站无法反向跳转
 * 2. 第三方登录弹窗 -> 命中白名单保留 opener，postMessage 正常通信
 * 3. /redirect?to= -> 服务端白名单校验，开放重定向被拦截
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createSecurityMiddleware } from "../server/middleware.js";
import { buildReferrerMeta } from "../server/headers.js";
import type { GuardPolicy } from "../shared/policy.js";

const policy: Partial<GuardPolicy> = {
  // 受信任的登录/支付源：只有它们的弹窗保留 opener
  trustedPopupOrigins: [
    "https://login.trusted-partner.example",
    "https://pay.trusted-partner.example",
  ],
  allowedRedirectOrigins: ["https://docs.example.com"],
  coop: "same-origin-allow-popups",
  coopExemptPathPrefixes: ["/oauth/callback"],
  referrerPolicy: "strict-origin-when-cross-origin",
};

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tabnabbing 防护演示</title>
${buildReferrerMeta()}
<style>
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
  section { border: 1px solid #ccc; border-radius: 10px; padding: 16px 20px; margin: 16px 0; }
  a, button { color: #0b57d0; }
  button { padding: 6px 14px; border-radius: 6px; border: 1px solid #0b57d0; background: #fff; cursor: pointer; }
  code { background: #f1f3f4; padding: 2px 6px; border-radius: 4px; }
  #status { font-weight: 600; }
</style>
</head>
<body>
<h1>反向 Tabnabbing 防护演示</h1>

<section>
  <h2>1. 帖子外链（默认 noopener）</h2>
  <p>用户帖子里的外部链接，点击后新标签页拿不到 <code>window.opener</code>：</p>
  <a href="https://example.com/" target="_blank">打开外部文章（恶意页尝试 location 跳转也碰不到本页）</a>
</section>

<section>
  <h2>2. 第三方登录弹窗（白名单保留 opener）</h2>
  <button id="loginBtn">打开受信任登录弹窗</button>
  <p>状态：<span id="status">未发起</span></p>
</section>

<section>
  <h2>3. 分享/任意 window.open（被守卫接管）</h2>
  <button id="shareBtn">JS 调用 window.open 分享</button>
</section>

<section>
  <h2>4. 服务端开放重定向</h2>
  <ul>
    <li><a href="/redirect?to=https://docs.example.com/guide" target="_blank">白名单内跳转（放行）</a></li>
    <li><a href="/redirect?to=https://evil.example/phish" target="_blank">白名单外跳转（被拦回首页）</a></li>
  </ul>
</section>

<script src="/lib/browser.js"></script>
<script>
  const { installTabnabbingGuard, waitForPopupMessage } = window.TabnabbingGuard;

  const guard = installTabnabbingGuard({
    policy: ${JSON.stringify(policy)},
  });

  document.querySelector("#loginBtn").addEventListener("click", () => {
    // 演示环境用本地路由模拟第三方登录弹窗
    const { win } = guard.openTrustedPopup(
      "/oauth/mock-login",
      "oauth-login",
      "popup,width=480,height=720"
    );
    document.querySelector("#status").textContent = "等待弹窗回消息…";

    // 真实环境 expectedOrigin 应为 https://login.trusted-partner.example
    waitForPopupMessage(win, {
      expectedOrigin: location.origin,
      messageType: "oauth-result",
      timeoutMs: 60000,
      validate: (d) =>
        typeof d === "object" && d !== null && d.type === "oauth-result",
    })
      .then((data) => {
        document.querySelector("#status").textContent =
          "收到受信任弹窗消息：" + JSON.stringify(data);
      })
      .catch((err) => {
        document.querySelector("#status").textContent = "失败：" + err.message;
      });
  });

  document.querySelector("#shareBtn").addEventListener("click", () => {
    // 即便业务代码直接调 window.open，守卫包装也会强制 noopener
    window.open("https://example.com/share", "_blank", "popup,width=600");
  });
</script>
</body>
</html>`;

const MOCK_LOGIN = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>模拟第三方登录</title></head>
<body>
<p>这是模拟的受信任第三方登录页（命中白名单，保留了 opener）。</p>
<button id="done">模拟登录成功，回传消息</button>
<script src="/lib/browser.js"></script>
<script>
  const { postToOpener } = window.TabnabbingGuard;
  document.querySelector("#done").addEventListener("click", () => {
    postToOpener(
      { type: "oauth-result", token: "demo-token-123" },
      // targetOrigin 精确指定父页面源，禁止 "*"
      location.origin
    );
  });
</script>
</body>
</html>`;

const middleware = createSecurityMiddleware({ policy });

const server = createServer((req, res) => {
  if (middleware(req, res)) return; // /redirect 已处理

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (pathname === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(PAGE);
    return;
  }
  if (pathname === "/oauth/mock-login") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(MOCK_LOGIN);
    return;
  }
  if (pathname === "/lib/browser.js") {
    // 演示用：返回 esbuild 打的自包含 IIFE（window.TabnabbingGuard）
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(readFileSync(new URL("../browser.bundle.js", import.meta.url)));
    return;
  }

  res.statusCode = 404;
  res.end("Not Found");
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  console.log(`演示服务器: http://localhost:${port}/`);
});
