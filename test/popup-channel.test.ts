import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PopupClosedError,
  openTrustedPopup,
} from '../src/client/popup-channel';
import { createPopupMessage } from '../src/shared/popup-protocol';

interface FakePopup {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

describe('openTrustedPopup', () => {
  let fakePopup: FakePopup;
  let openSpy: ReturnType<typeof vi.spyOn>;
  let messageHandler: ((event: MessageEvent) => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    fakePopup = {
      closed: false,
      close: vi.fn(() => {
        fakePopup.closed = true;
      }),
      postMessage: vi.fn(),
    };
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => fakePopup as unknown as Window);
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, handler: EventListener) => {
      if (type === 'message') messageHandler = handler as unknown as (e: MessageEvent) => void;
    }) as typeof window.addEventListener);
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    messageHandler = null;
  });

  function emit(event: { origin: string; source: unknown; data: unknown }) {
    messageHandler?.(event as unknown as MessageEvent);
  }

  function launch() {
    return openTrustedPopup<{ token: string }>('https://github.com/login/oauth', {
      provider: 'github',
      allowedOrigins: ['https://github.com', 'https://community.example'],
      timeoutMs: 1000,
      closePollMs: 50,
      closeGraceMs: 0,
      broadcast: false,
      announce: false,
    });
  }

  it('打开时不使用 noopener（必须保留 opener 通信）', () => {
    launch();
    const features = String(openSpy.mock.calls[0]?.[2] ?? '');
    expect(features).not.toContain('noopener');
  });

  it('origin 不匹配的消息被忽略', async () => {
    const channel = launch();
    emit({
      origin: 'https://github.com.evil.com',
      source: fakePopup,
      data: createPopupMessage(channel.channelId, 'success', { token: 'stolen' }),
    });
    await vi.advanceTimersByTimeAsync(200);
    // 仍然 pending：轮询未关闭、未超时
    const state = vi.fn();
    channel.result.then(state, state);
    await Promise.resolve();
    expect(state).not.toHaveBeenCalled();
    channel.close();
  });

  it('source 不是弹窗窗口的消息被忽略（防止其他标签/iframe 伪造）', async () => {
    const channel = launch();
    emit({
      origin: 'https://github.com',
      source: { fake: 'not-the-popup' },
      data: createPopupMessage(channel.channelId, 'success', { token: 'x' }),
    });
    await Promise.resolve();
    const state = vi.fn();
    channel.result.then(state, state);
    await Promise.resolve();
    expect(state).not.toHaveBeenCalled();
    channel.close();
  });

  it('channelId 不匹配的消息被忽略', async () => {
    const channel = launch();
    emit({
      origin: 'https://github.com',
      source: fakePopup,
      data: createPopupMessage('other-channel', 'success', { token: 'x' }),
    });
    await Promise.resolve();
    const state = vi.fn();
    channel.result.then(state, state);
    await Promise.resolve();
    expect(state).not.toHaveBeenCalled();
    channel.close();
  });

  it('三重校验通过后 success 解析并关闭弹窗', async () => {
    const channel = launch();
    emit({
      origin: 'https://community.example',
      source: fakePopup,
      data: createPopupMessage(channel.channelId, 'success', { token: 'oauth-code' }),
    });
    await expect(channel.result).resolves.toEqual({ token: 'oauth-code' });
    expect(fakePopup.close).toHaveBeenCalled();
  });

  it('用户直接关闭弹窗时以 PopupClosedError 拒绝', async () => {
    const channel = launch();
    // 必须在推进假定时器之前挂好 rejection 处理，否则会产生 unhandled rejection。
    const rejection = expect(channel.result).rejects.toBeInstanceOf(PopupClosedError);
    fakePopup.closed = true;
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
  });

  it('window.open 返回 null（被拦截）时抛 PopupBlockedError', () => {
    openSpy.mockImplementation(() => null);
    expect(() => launch()).toThrowError(/拦截/);
  });
});
