/**
 * /popup-bridge 页面脚本（打包为 /demo/public/bridge.js）。
 *
 * OAuth 提供方授权后重定向回这个同源页面，由它把结果通过 window.opener.postMessage
 * 发回主窗口。targetOrigin 固定为当前 origin（主站），绝不使用 '*'。
 */

import {
  createPopupMessage,
  POPUP_BROADCAST_CHANNEL,
} from '../src/shared/popup-protocol';

const statusEl = document.getElementById('bridge-status');

function setStatus(text: string, ok = false) {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.style.color = ok ? '#047857' : '#b45309';
    statusEl.style.fontWeight = '600';
  }
}

const params = new URLSearchParams(location.search);
const channelId = params.get('channelId');
const type = (params.get('type') ?? 'success') as 'success' | 'error';
const token = params.get('token');

if (!channelId) {
  setStatus('缺少 channelId，无法回传结果。');
} else {
  const payload = token ? { token } : { code: params.get('code') };
  const message = createPopupMessage(
    channelId,
    type,
    type === 'success' ? payload : params.get('message') ?? '授权失败',
  );

  // 传输 1：window.opener.postMessage。targetOrigin 显式指定为当前同源 origin，绝不用 '*'。
  let openerDelivered = false;
  if (window.opener) {
    try {
      window.opener.postMessage(message, location.origin);
      openerDelivered = true;
    } catch {
      openerDelivered = false;
    }
  }

  // 传输 2：BroadcastChannel。同源可达，且即使 COOP 切换导致 opener=null 也能送达。
  let broadcastDelivered = false;
  try {
    const bc = new BroadcastChannel(POPUP_BROADCAST_CHANNEL);
    bc.postMessage(message);
    broadcastDelivered = true;
    setTimeout(() => bc.close(), 100);
  } catch {
    broadcastDelivered = false;
  }

  if (openerDelivered || broadcastDelivered) {
    setStatus(
      `结果已安全传回原页面（opener: ${openerDelivered ? '✓' : '—'}，广播: ${
        broadcastDelivered ? '✓' : '—'
      }），窗口即将关闭…`,
      true,
    );
    setTimeout(() => window.close(), 500);
  } else {
    setStatus('无法回传结果：window.opener 不可用且 BroadcastChannel 失败。');
  }
}
