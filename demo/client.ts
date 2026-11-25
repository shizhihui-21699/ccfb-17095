/**
 * 演示站前端入口（esbuild 打包为 IIFE /demo/public/app.js）。
 * 真实项目中这个文件就是应用初始化代码：安装两层全局守卫 + 绑定业务按钮。
 */

import {
  installAnchorGuard,
  installWindowOpenGuard,
  openExternal,
  openTrustedPopup,
  UnsafeUrlError,
} from '../src/client/index';
import { EVIL_ORIGIN, PROVIDER_ORIGIN, demoPolicy } from './policy';

function log(elId: string, message: string, kind: 'info' | 'ok' | 'bad' = 'info') {
  const el = document.getElementById(elId);
  if (!el) return;
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  line.style.color = kind === 'ok' ? '#9ef0c8' : kind === 'bad' ? '#fda4af' : '#c7d2fe';
  el.prepend(line);
}

/* ---------- 安装全局兜底守卫 ---------- */

installAnchorGuard({
  ...demoPolicy,
  preserveOpenerOrigins: demoPolicy.trustedPopupOrigins,
  onBlocked: ({ reason }) => log('safe-log', `拦截危险链接：${reason}`, 'bad'),
});

installWindowOpenGuard({
  ...demoPolicy,
  onRewrite: ({ url, addedNoopener, trusted }) => {
    if (trusted) {
      log('safe-log', `window.open 受信弹窗，保留 opener：${String(url)}`, 'ok');
    } else if (addedNoopener) {
      log('safe-log', `window.open 已被守卫强制 noopener：${String(url)}`, 'info');
    }
  },
});

/* ---------- 普通外链 / 分享 ---------- */

document.getElementById('btn-external')?.addEventListener('click', () => {
  openExternal('https://example.com/security-article', demoPolicy);
  log('safe-log', 'openExternal() 已以 noopener,noreferrer 打开 example.com', 'ok');
});

document.getElementById('btn-legacy-open')?.addEventListener('click', () => {
  // 模拟没改造完的遗留代码：直接调 window.open。全局守卫会接管并补 noopener。
  // safe-navigation-allow: 故意保留裸调用以演示 installWindowOpenGuard 的兜底改写
  window.open(`${EVIL_ORIGIN}/attacker?back=${encodeURIComponent(location.origin + '/phishing')}`, '_blank');
});

document.getElementById('btn-share')?.addEventListener('click', () => {
  // 分享小窗不需要与原页面通信：noopener + 尺寸特性。
  openExternal('https://service.weibo.com/share/share.php?title=安全导航Kit', {
    ...demoPolicy,
    features: 'width=640,height=520',
  });
  log('safe-log', '分享窗口已以 noopener 小窗打开（无 opener 引用）', 'ok');
});

document.getElementById('btn-js')?.addEventListener('click', () => {
  try {
    openExternal('javascript:alert(document.cookie)');
  } catch (err) {
    log('safe-log', err instanceof UnsafeUrlError ? err.message : String(err), 'bad');
  }
});

/* ---------- 第三方登录（OAuth：授权后跳同源桥接页） ---------- */

document.getElementById('btn-oauth')?.addEventListener('click', async () => {
  const popupLog = 'popup-log';
  log(popupLog, '打开 OAuth 弹窗（保留 opener，origin 白名单校验）…');
  try {
    const channel = openTrustedPopup<{ token: string }>(
      (channelId) => `${PROVIDER_ORIGIN}/oauth?channelId=${encodeURIComponent(channelId)}`,
      {
        provider: 'thirdid',
        // OAuth 授权后跳回同源 /popup-bridge，消息 origin 是主站自身。
        allowedOrigins: [location.origin],
        announce: false,
      },
    );
    log(popupLog, `channel ${channel.channelId.slice(0, 8)}… 等待授权回调`);
    const data = await channel.result;
    log(popupLog, `登录成功，收到授权码：${data.token}`, 'ok');
  } catch (err) {
    log(popupLog, `登录失败/取消：${(err as Error).message}`, 'bad');
  }
});

/* ---------- 支付（第三方页面直接跨源 postMessage） ---------- */

document.getElementById('btn-payment')?.addEventListener('click', async () => {
  const popupLog = 'popup-log';
  log(popupLog, '打开收银台弹窗…');
  try {
    const channel = openTrustedPopup<{ paid: boolean; amount: number; tradeNo: string }>(
      (channelId) => `${PROVIDER_ORIGIN}/payment?channelId=${encodeURIComponent(channelId)}`,
      {
        provider: 'mockpay',
        // 支付页直接从 PROVIDER_ORIGIN 发消息，因此白名单必须包含它。
        allowedOrigins: [PROVIDER_ORIGIN, location.origin],
        announce: false,
      },
    );
    const data = await channel.result;
    log(popupLog, `支付成功：¥${data.amount}，交易号 ${data.tradeNo}`, 'ok');
  } catch (err) {
    log(popupLog, `支付未完成：${(err as Error).message}`, 'bad');
  }
});
