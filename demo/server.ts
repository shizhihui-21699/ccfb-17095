/**
 * 可运行的端到端演示：
 *   npm run demo
 *
 * 主站（社区）      http://localhost:3000
 * 第三方/攻击实验源  http://127.0.0.1:3100
 *
 * 主站所有响应经过 COOP 等安全头中间件；首页 UGC 帖子经过服务端 HTML 重写；
 * 客户端 bundle 再安装 anchor/window.open 守卫。
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  coopByPath,
  rewriteAnchorHtml,
  securityHeadersMiddleware,
} from '../src/server/index';
import {
  APP_ORIGIN,
  APP_PORT,
  EVIL_ORIGIN,
  EVIL_PORT,
  PROVIDER_ORIGIN,
  PROVIDER_PORT,
  demoPolicy,
} from './policy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

function layout(title: string, body: string, opts: { script?: string } = {}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
         background:#f4f6fa; color:#1c2430; }
  header { background:#1f3a8a; color:#fff; padding:16px 24px; }
  header h1 { margin:0; font-size:18px; }
  header .badges { margin-top:6px; display:flex; gap:8px; flex-wrap:wrap; }
  .badge { font-size:12px; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.18); }
  main { max-width: 880px; margin: 24px auto; padding: 0 16px; display:grid; gap:16px; }
  .card { background:#fff; border:1px solid #e3e8f0; border-radius:12px; padding:18px 20px;
          box-shadow:0 1px 2px rgba(16,24,40,.05); }
  .card h2 { margin:0 0 10px; font-size:16px; }
  .post { border:1px solid #eef1f6; border-radius:10px; padding:14px 16px; background:#fbfcfe; }
  .post a { color:#1d4ed8; }
  .row { display:flex; flex-wrap:wrap; gap:10px; margin:10px 0; }
  button, .btn { appearance:none; border:1px solid #c6cfdd; background:#fff; color:#1c2430;
          padding:8px 14px; border-radius:8px; font-size:14px; cursor:pointer; text-decoration:none;
          display:inline-flex; align-items:center; gap:6px; }
  button:hover, .btn:hover { border-color:#1d4ed8; color:#1d4ed8; }
  button.primary { background:#1d4ed8; border-color:#1d4ed8; color:#fff; }
  button.danger { background:#b91c1c; border-color:#b91c1c; color:#fff; }
  button.good { background:#047857; border-color:#047857; color:#fff; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background:#0d1424; color:#d7e2ff; padding:12px 14px; border-radius:8px; overflow:auto;
        font-size:12.5px; line-height:1.55; }
  .log { min-height: 44px; border-radius:8px; padding:10px 12px; background:#0d1424; color:#9ef0c8;
         font-family: ui-monospace, Menlo, monospace; font-size:12.5px; white-space:pre-wrap; }
  .muted { color:#667085; font-size:13px; }
  .ok { color:#047857; font-weight:600; }
  .bad { color:#b91c1c; font-weight:600; }
  table { border-collapse: collapse; width:100%; font-size:13.5px; }
  th, td { border:1px solid #e3e8f0; padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#f8fafc; }
  .phish { max-width:420px; margin:60px auto; background:#fff; border-radius:14px; padding:28px;
           box-shadow:0 20px 60px rgba(0,0,0,.25); }
  .phish input { width:100%; padding:10px 12px; margin:8px 0; border:1px solid #c6cfdd; border-radius:8px; }
  .warn-strip { background:#fef3c7; border:1px solid #f59e0b; color:#92400e; padding:10px 14px;
                border-radius:10px; font-size:13.5px; }
</style>
</head>
<body>
<header>
  <h1>🔒 社区站 · 安全导航演示（safe-navigation-kit）</h1>
  <div class="badges">
    <span class="badge">COOP: same-origin-allow-popups（本页）</span>
    <span class="badge">外链: rel="noopener noreferrer"</span>
    <span class="badge">window.open 守卫已启用</span>
    <span class="badge">OAuth/支付弹窗: opener 保留 + postMessage 校验</span>
  </div>
</header>
<main>${body}</main>
${opts.script ? `<script src="${opts.script}" defer></script>` : ''}
</body></html>`;
}

/* ---------------- 主站 ---------------- */

const app = express();

// 全站安全头：/settings、/admin、/strict 等不使用弹窗的敏感路由升级为 same-origin。
app.use(
  securityHeadersMiddleware({
    coop: coopByPath(['/settings', '/admin', '/strict']),
  }),
);

app.use(express.static(publicDir));

const UGC_POST = `
<p>大家看看这个 <a href="https://example.com/article/1">外部技术文章</a>，写得不错。</p>
<p>这个链接已经带了 rel：<a href="https://developer.mozilla.org/" target="_blank" rel="nofollow">MDN</a></p>
<p>福利：<a href="javascript:alert(document.cookie)">点击领取会员</a></p>
<p>站内讨论：<a href="/settings">我的设置</a> ｜ <a href="/legacy" target="_blank">旧版页面（新窗）</a></p>
<p>伪装成登录的保留 opener 链接：<a data-preserve-opener href="https://sso.evil-example.test/auth" target="x">可疑的 SSO 跳转</a>（origin 不在白名单，会被降级）</p>
`;

app.get('/', (_req, res) => {
  const { html: safePost, stats } = rewriteAnchorHtml(UGC_POST, {
    ...demoPolicy,
    base: APP_ORIGIN,
  });

  const body = `
  <section class="card">
    <h2>📝 帖子详情（服务端已重写 UGC 中的链接）</h2>
    <div class="post">${safePost}</div>
    <p class="muted">重写统计：共 ${stats.anchors} 个链接，加固 ${stats.hardened}，外部 ${stats.external}，移除危险 href ${stats.removedHref}。
    打开 DevTools 检查上面的 &lt;a&gt;，或点击“可疑的 SSO 跳转”——它的 data-preserve-opener 因 origin 不受信已被降级。</p>
  </section>

  <section class="card">
    <h2>🧪 统一打开入口</h2>
    <div class="row">
      <button id="btn-external" class="primary">openExternal() 打开外部文章</button>
      <button id="btn-legacy-open">遗留代码 window.open(外链)</button>
      <button id="btn-share">分享到微博（小窗 + noopener）</button>
      <button id="btn-js">尝试打开 javascript: URL</button>
    </div>
    <div id="safe-log" class="log">等待操作…</div>
  </section>

  <section class="card">
    <h2>🔑 第三方登录 / 💳 支付（必须保留弹窗通信，不能修坏）</h2>
    <p class="muted">
      弹窗 <strong>不带 noopener</strong>，但通道会校验 <code>event.origin</code> +
      <code>event.source === 弹窗</code> + <code>channelId</code>。
      OAuth 走“第三方授权 → 同源 /popup-bridge → postMessage”；支付演示第三方页面直接跨源 postMessage。
    </p>
    <div class="row">
      <button id="btn-oauth" class="good">使用 GitHub 风格账号登录（弹窗）</button>
      <button id="btn-payment" class="good">支付 ¥99.00（弹窗）</button>
    </div>
    <div id="popup-log" class="log">尚未登录 / 支付。</div>
  </section>

  <section class="card">
    <h2>🧨 攻击对照实验</h2>
    <table>
      <tr><th>场景</th><th>入口</th><th>为什么安全 / 不安全</th></tr>
      <tr>
        <td>未防护的旧代码（对照）</td>
        <td><a class="btn" href="/legacy" target="_blank">打开 /legacy</a></td>
        <td class="bad">无 rel、无守卫；COOP 为 allow-popups，攻击页可拿到 opener 并跳转原标签。</td>
      </tr>
      <tr>
        <td>仅靠 COOP same-origin</td>
        <td><a class="btn" href="/strict" target="_blank">打开 /strict</a></td>
        <td class="ok">即使代码里裸调 window.open 且不加 noopener，COOP: same-origin 也会让跨源弹窗的 opener 为 null。</td>
      </tr>
      <tr>
        <td>仿冒登录页长什么样</td>
        <td><a class="btn" href="/phishing" target="_blank">打开演示钓鱼页</a></td>
        <td class="muted">明确标注为本地教学模拟，不会收集任何输入。</td>
      </tr>
    </table>
  </section>

  <section class="card">
    <h2>响应头（本页实际下发）</h2>
    <pre id="headers-pre">Cross-Origin-Opener-Policy: same-origin-allow-popups
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff</pre>
  </section>`;

  res.send(layout('社区首页 · 安全导航 Kit', body, { script: '/app.js' }));
});

app.get('/legacy', (_req, res) => {
  const body = `
  <section class="card">
    <h2>☠️ 未做任何防护的旧页面（对照组）</h2>
    <p>这个页面不加载安全守卫，按钮直接调用裸 <code>window.open</code>，链接也没有 rel。
    由于整站默认 COOP 是 <code>same-origin-allow-popups</code>，而攻击实验页不设置 COOP，
    浏览器会保留 opener 关系 —— 反向标签劫持可以成功。</p>
    <div class="row">
      <button class="danger" onclick="window.open('${EVIL_ORIGIN}/attacker?back=${encodeURIComponent(
        APP_ORIGIN + '/phishing',
      )}', '_blank')">裸 window.open 打开外部页</button>
      <a class="btn danger" href="${EVIL_ORIGIN}/attacker?back=${encodeURIComponent(
        APP_ORIGIN + '/phishing',
      )}" target="_blank" rel="opener">带 rel="opener" 的链接</a>
    </div>
    <p class="muted">在攻击页点击“把原标签跳到钓鱼页”，然后切回本标签查看。</p>
    <p><a href="${APP_ORIGIN}/">← 返回安全首页</a></p>
  </section>`;
  res.send(layout('旧版未防护页面', body));
});

app.get('/strict', (_req, res) => {
  // 该路径由 coopByPath 下发 COOP: same-origin。
  const body = `
  <section class="card">
    <h2>🛡️ COOP: same-origin 严格隔离页</h2>
    <div class="warn-strip">本页响应头为 <code>Cross-Origin-Opener-Policy: same-origin</code>。
    下面的按钮仍然是<strong>裸 window.open 且故意不加 noopener</strong>，用于证明响应头这一层独立生效。</div>
    <div class="row" style="margin-top:14px">
      <button class="danger" onclick="window.open('${EVIL_ORIGIN}/attacker?back=${encodeURIComponent(
        APP_ORIGIN + '/phishing',
      )}', '_blank')">裸 window.open 打开攻击页</button>
    </div>
    <p class="muted">攻击页会检测到 <code>window.opener === null</code>，无法跳转本标签。</p>
  </section>`;
  res.send(layout('严格 COOP 页面', body));
});

app.get('/phishing', (_req, res) => {
  res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>登录已过期 - 仿冒页教学模拟</title>
  <style>body{background:#eef2ff;font-family:-apple-system,"PingFang SC",sans-serif}.tag{background:#b91c1c;color:#fff;
  text-align:center;padding:8px;font-size:13px}.phish{max-width:400px;margin:40px auto;background:#fff;border-radius:14px;padding:28px;
  box-shadow:0 20px 60px rgba(0,0,0,.2)}input{width:100%;padding:11px;margin:8px 0;border:1px solid #c6cfdd;border-radius:8px}
  button{width:100%;padding:12px;background:#2563eb;color:#fff;border:0;border-radius:8px;font-size:15px}</style></head>
  <body><div class="tag">⚠️ 这是本地安全教学用的【仿冒登录页模拟】，不会提交或记录任何信息</div>
  <form class="phish" onsubmit="event.preventDefault();alert('演示：真实攻击中你的账号密码已被发送给攻击者。\\n\\n防护生效时根本到不了这一步。')">
    <h2>社区账号登录</h2>
    <p class="muted" style="color:#667085;font-size:13px">登录状态已过期，请重新登录</p>
    <input placeholder="手机号 / 邮箱" autocomplete="off" />
    <input type="password" placeholder="密码" autocomplete="off" />
    <button type="submit">登 录</button>
  </form></body></html>`);
});

// 同源弹窗桥接页：第三方授权完跳回这里回传结果。
// 这里刻意使用最强的 COOP: same-origin。此时期望的 window.opener 会被切断，
// 但 bridge.js 会通过 BroadcastChannel（同源、按 origin 隔离、可穿越 COOP 组切换）
// 把结果送回 openTrustedPopup()。已用真实 Chromium E2E 验证。
// 若只想用 window.opener.postMessage，则把本路由改成 unsafe-none 即可。
app.get('/popup-bridge', (_req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  const body = `
  <section class="card" style="text-align:center">
    <h2>🔄 正在返回社区…</h2>
    <p id="bridge-status">桥接页加载中，正在通过 window.opener.postMessage 传递结果。</p>
    <p class="muted">如果你看到本页没有自动关闭，说明弹窗通信可能被拦截。</p>
  </section>
  <script src="/bridge.js" defer></script>`;
  res.send(layout('登录桥接中', body));
});

/* ---------------- 不可信外部源（攻击实验） ---------------- */

const evil = express();

evil.get('/attacker', (req, res) => {
  const back = typeof req.query.back === 'string' ? req.query.back : `${APP_ORIGIN}/phishing`;
  res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>外部页面 / 攻击实验页</title>
  <style>body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:720px;margin:40px auto;padding:0 16px}
  .box{border:1px solid #ddd;border-radius:12px;padding:20px;margin:14px 0}
  button{padding:10px 16px;border-radius:8px;border:0;background:#b91c1c;color:#fff;cursor:pointer}
  code{background:#f1f5f9;padding:2px 6px;border-radius:4px}</style></head><body>
  <h1>🌐 外部不可信页面（${EVIL_ORIGIN}）</h1>
  <div class="box">
    <p>本页相当于用户从社区点开的任意外部网站。下面是浏览器反向引用检测结果：</p>
    <p>window.opener：<code id="opener-state">检测中…</code></p>
    <p>document.referrer：<code id="referrer-state"></code></p>
  </div>
  <div class="box" id="attack-box">
    <h2>反向标签劫持尝试</h2>
    <p>如果 opener 可用，跨源页面虽然不能读 <code>opener.location</code>，但<strong>可以写</strong>，
    从而把原标签导航到仿冒登录页。</p>
    <button id="tabnab">把原标签跳转到仿冒登录页</button>
    <p id="attack-result"></p>
  </div>
  <script>
    var back = ${JSON.stringify(back)};
    var openerState = document.getElementById('opener-state');
    var referrerState = document.getElementById('referrer-state');
    referrerState.textContent = document.referrer || '(空 —— noreferrer 生效)';
    var hasOpener = false;
    try { hasOpener = window.opener != null; } catch (e) { hasOpener = false; }
    if (hasOpener) {
      openerState.textContent = 'window 对象存在 ❌（opener 引用未切断）';
      openerState.style.color = '#b91c1c';
    } else {
      openerState.textContent = 'null ✅（noopener 或 COOP same-origin 已隔离）';
      openerState.style.color = '#047857';
      document.getElementById('attack-box').style.opacity = '.55';
    }
    document.getElementById('tabnab').addEventListener('click', function () {
      try {
        if (!window.opener) throw new Error('opener is null');
        window.opener.location = back;
        document.getElementById('attack-result').textContent =
          '已写入 opener.location。请切回原标签查看（它现在应该显示仿冒登录页）。';
      } catch (e) {
        document.getElementById('attack-result').textContent =
          '攻击失败：' + e.message + ' —— 浏览上下文已被隔离。';
      }
    });
  </script></body></html>`);
});

/* ---------------- 受信第三方（模拟 OAuth / 支付提供方） ---------------- */

const provider = express();

provider.get('/oauth', (req, res) => {
  const channelId = String(req.query.channelId ?? '');
  res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>模拟第三方授权</title>
  <style>body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:420px;margin:60px auto;padding:0 16px}
  .card{border:1px solid #ddd;border-radius:14px;padding:26px;text-align:center}
  button{padding:12px 22px;border-radius:8px;border:0;background:#16a34a;color:#fff;font-size:15px;cursor:pointer}</style></head>
  <body><div class="card">
    <h2>🟣 ThirdID 授权（模拟）</h2>
    <p>社区站请求获取你的昵称和邮箱。</p>
    <button id="allow">同意授权</button>
    <p class="muted" style="color:#888;font-size:12px;margin-top:16px">channel: ${channelId.slice(0, 8)}…</p>
  </div>
  <script>
    document.getElementById('allow').addEventListener('click', function () {
      // 真实 OAuth 中这里会 302 到 redirect_uri；演示直接用 location 跳到主站桥接页。
      var bridge = ${JSON.stringify(`${APP_ORIGIN}/popup-bridge`)};
      var params = new URLSearchParams({
        channelId: new URLSearchParams(location.search).get('channelId'),
        type: 'success',
        token: 'demo-oauth-code-' + Date.now()
      });
      window.location.href = bridge + '?' + params.toString();
    });
  </script></body></html>`);
});

provider.get('/payment', (_req, res) => {
  res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>模拟收银台</title>
  <style>body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:420px;margin:60px auto;padding:0 16px}
  .card{border:1px solid #ddd;border-radius:14px;padding:26px}
  button{width:100%;padding:12px;border-radius:8px;border:0;color:#fff;font-size:15px;cursor:pointer;margin-top:10px}
  .pay{background:#047857}.cancel{background:#6b7280}</style></head>
  <body><div class="card">
    <h2>💳 模拟收银台</h2>
    <p>商品：社区年会员 × 1<br>金额：<strong>¥99.00</strong></p>
    <button class="pay" id="ok">支付成功（跨源 postMessage 给 opener）</button>
    <button class="cancel" id="cancel">取消支付</button>
  </div>
  <script>
    var qs = new URLSearchParams(location.search);
    var channelId = qs.get('channelId');
    var APP_ORIGIN = ${JSON.stringify(APP_ORIGIN)};
    function msg(type, payload) {
      return { source: 'safe-navigation-kit/popup', version: 1, channelId: channelId, type: type, payload: payload };
    }
    document.getElementById('ok').addEventListener('click', function () {
      // 第三方页面直接跨源发消息；主站通道会校验 event.origin === ${PROVIDER_ORIGIN} 与 source。
      window.opener && window.opener.postMessage(msg('success', { paid: true, amount: 99, tradeNo: 'T' + Date.now() }), APP_ORIGIN);
      window.close();
    });
    document.getElementById('cancel').addEventListener('click', function () {
      window.opener && window.opener.postMessage(msg('error', '用户取消了支付'), APP_ORIGIN);
      window.close();
    });
  </script></body></html>`);
});

app.listen(APP_PORT, () => {
  console.log(`✅ 社区主站:   ${APP_ORIGIN}`);
  console.log(`   首页/帖子:  ${APP_ORIGIN}/`);
  console.log(`   未防护对照: ${APP_ORIGIN}/legacy`);
  console.log(`   COOP 严格:  ${APP_ORIGIN}/strict`);
});

provider.listen(PROVIDER_PORT, () => {
  console.log(`🔑 受信第三方源: ${PROVIDER_ORIGIN} (oauth / payment)`);
});

evil.listen(EVIL_PORT, () => {
  console.log(`🧨 不可信外部源: ${EVIL_ORIGIN} (attacker)`);
});
