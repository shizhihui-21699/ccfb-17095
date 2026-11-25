/**
 * Demo 专用策略：模拟一个真实社区站点的配置（同构，可同时被服务端与客户端 bundle 引用）。
 *
 * - 主站 APP        http://localhost:3000   （社区）
 * - 受信第三方      http://127.0.0.1:3100   （模拟 OAuth/支付，在弹窗白名单内）
 * - 不可信外部源    http://127.0.0.1:3200   （模拟任意外部网站/攻击页，不在白名单）
 *
 * localhost 与 127.0.0.1 即使端口相同也是跨源，这里再用不同端口确保跨源。
 */

export const APP_PORT = 3000;
export const PROVIDER_PORT = 3100;
export const EVIL_PORT = 3200;

export const APP_ORIGIN = `http://localhost:${APP_PORT}`;
export const PROVIDER_ORIGIN = `http://127.0.0.1:${PROVIDER_PORT}`;
export const EVIL_ORIGIN = `http://127.0.0.1:${EVIL_PORT}`;

/** @deprecated 使用 PROVIDER_ORIGIN，保留别名减少示例改动 */
export const LAB_ORIGIN = PROVIDER_ORIGIN;

export const demoPolicy = {
  internalHosts: [`localhost:${APP_PORT}`],
  // 只有 OAuth/支付提供方在受信弹窗白名单；EVIL_ORIGIN 刻意不在其中。
  trustedPopupOrigins: [PROVIDER_ORIGIN],
};

/** 弹窗通道允许接收消息的 origin：本站桥接页 + 第三方提供方（直连 postMessage 的支付场景）。 */
export const popupAllowedOrigins = [APP_ORIGIN, PROVIDER_ORIGIN];
