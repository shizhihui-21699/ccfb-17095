/**
 * 真实 Chromium 端到端验证（可选）：
 *   1. 另开终端执行 npm run demo
 *   2. node e2e/verify.mjs
 *
 * 也可以让脚本自己拉起服务：node e2e/verify.mjs --spawn
 *
 * 验证四件单测无法证明的事：
 *  - noopener 链路下攻击页 window.opener === null
 *  - 未防护旧页面确实可被反向标签劫持（对照组，证明测试有效）
 *  - COOP: same-origin 下即使裸 window.open 也拿不到 opener
 *  - OAuth 桥接与支付跨源 postMessage 在真实浏览器里完整走通
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const APP = 'http://localhost:3000';
const LAB = 'http://127.0.0.1:3100';

let serverProcess = null;
if (process.argv.includes('--spawn')) {
  // detached 让 npm 成为新进程组组长，结束时 kill 整个进程组（含 tsx 子进程），避免端口残留。
  serverProcess = spawn('npm', ['run', 'demo'], { stdio: 'inherit', detached: true });
  await new Promise((resolve) => setTimeout(resolve, 3500));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  /* ---------- 1. 首页：服务端渲染的 rel ---------- */
  const home = await context.newPage();
  await home.goto(`${APP}/`, { waitUntil: 'networkidle' });
  const rel = await home
    .locator('.post a[href="https://example.com/article/1"]')
    .getAttribute('rel');
  check('服务端 UGC 外链带 noopener noreferrer', rel === 'noopener noreferrer', rel ?? 'null');

  /* ---------- 2. window.open 守卫：攻击页 opener 为 null ---------- */
  {
    const popupPromise = context.waitForEvent('page');
    await home.click('#btn-legacy-open');
    const attacker = await popupPromise;
    await attacker.waitForLoadState('domcontentloaded');
    await attacker.waitForSelector('#opener-state');
    const text = (await attacker.locator('#opener-state').textContent()) ?? '';
    check('window.open 守卫后攻击页 opener=null', text.includes('null'), text);
    await attacker.close();
  }

  /* ---------- 3. 对照组：/legacy 裸 window.open 可被 tabnab ---------- */
  {
    const legacy = await context.newPage();
    await legacy.goto(`${APP}/legacy`, { waitUntil: 'domcontentloaded' });
    const popupPromise = context.waitForEvent('page');
    await legacy.click('button.danger');
    const attacker = await popupPromise;
    await attacker.waitForLoadState('domcontentloaded');
    const openerText = (await attacker.locator('#opener-state').textContent()) ?? '';
    check('对照组旧页面 opener 引用存在（漏洞可复现）', openerText.includes('window 对象存在'), openerText);

    await attacker.click('#tabnab');
    await legacy.waitForURL('**/phishing', { timeout: 5000 });
    check('对照组原标签确实被跳转到钓鱼页', legacy.url().includes('/phishing'), legacy.url());
    await attacker.close().catch(() => {});
    await legacy.close().catch(() => {});
  }

  /* ---------- 4. /strict：COOP same-origin 独立生效 ---------- */
  {
    const strict = await context.newPage();
    await strict.goto(`${APP}/strict`, { waitUntil: 'domcontentloaded' });
    const coop = await strict.evaluate(() =>
      fetch(location.href, { method: 'HEAD' }).then((r) =>
        r.headers.get('cross-origin-opener-policy'),
      ),
    );
    check('/strict 下发 COOP same-origin', coop === 'same-origin', coop ?? 'null');

    const popupPromise = context.waitForEvent('page');
    await strict.click('button.danger');
    const attacker = await popupPromise;
    await attacker.waitForLoadState('domcontentloaded');
    const text = (await attacker.locator('#opener-state').textContent()) ?? '';
    check('COOP same-origin 下裸 window.open 仍 opener=null', text.includes('null'), text);
    await attacker.close().catch(() => {});
    await strict.close().catch(() => {});
  }

  /* ---------- 5. OAuth 弹窗 + 同源桥接 ---------- */
  {
    const popupPromise = context.waitForEvent('page');
    await home.click('#btn-oauth');
    const oauth = await popupPromise;
    await oauth.waitForLoadState('domcontentloaded');
    await oauth.waitForSelector('#allow');
    await oauth.click('#allow');
    await home.waitForFunction(
      () => document.getElementById('popup-log')?.textContent?.includes('登录成功'),
      null,
      { timeout: 8000 },
    );
    const log = (await home.locator('#popup-log').textContent()) ?? '';
    check('OAuth 弹窗经 /popup-bridge 完成 postMessage 登录', log.includes('demo-oauth-code'), log.slice(0, 120));
  }

  /* ---------- 6. 支付：第三方页面跨源直接 postMessage ---------- */
  {
    const popupPromise = context.waitForEvent('page');
    await home.click('#btn-payment');
    const pay = await popupPromise;
    await pay.waitForLoadState('domcontentloaded');
    await pay.waitForSelector('#ok');
    await pay.click('#ok');
    await home.waitForFunction(
      () => document.getElementById('popup-log')?.textContent?.includes('支付成功'),
      null,
      { timeout: 8000 },
    );
    const log = (await home.locator('#popup-log').textContent()) ?? '';
    check('支付弹窗跨源 postMessage 成功且未被安全策略破坏', log.includes('交易号'), log.slice(0, 120));
  }
} catch (err) {
  check('E2E 执行未抛出异常', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  await browser.close();
  if (serverProcess?.pid) {
    try {
      process.kill(-serverProcess.pid, 'SIGTERM');
    } catch {
      serverProcess.kill('SIGTERM');
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项验证通过`);
process.exit(failed.length ? 1 : 0);
