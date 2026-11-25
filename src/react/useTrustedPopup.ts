/**
 * useTrustedPopup —— React 中承接第三方登录 / 支付弹窗的 Hook。
 *
 * 与 openExternal 不同，这里刻意保留 opener；安全依赖 origin 白名单与
 * postMessage 校验（见 popup-channel.ts）。组件卸载时自动关闭弹窗并清理监听。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  openTrustedPopup,
  type PopupChannel,
  type PopupChannelOptions,
} from '../client/popup-channel';

export type PopupStatus = 'idle' | 'opening' | 'pending' | 'success' | 'error';

export interface UseTrustedPopupState<T> {
  status: PopupStatus;
  data: T | null;
  error: Error | null;
  /** 打开弹窗并等待结果。 */
  launch: (url: string, options: Omit<PopupChannelOptions<T>, 'targetWindow'>) => Promise<T>;
  /** 关闭弹窗、重置状态。 */
  close: () => void;
  reset: () => void;
}

export function useTrustedPopup<T = unknown>(): UseTrustedPopupState<T> {
  const channelRef = useRef<PopupChannel<T> | null>(null);
  const [status, setStatus] = useState<PopupStatus>('idle');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const close = useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    setStatus('idle');
  }, []);

  const reset = useCallback(() => {
    channelRef.current?.dispose();
    channelRef.current = null;
    setStatus('idle');
    setData(null);
    setError(null);
  }, []);

  const launch = useCallback(
    async (url: string, options: Omit<PopupChannelOptions<T>, 'targetWindow'>): Promise<T> => {
      channelRef.current?.close();
      setStatus('opening');
      setError(null);
      try {
        const channel = openTrustedPopup<T>(url, options);
        channelRef.current = channel;
        setStatus('pending');
        const result = await channel.result;
        setData(result);
        setStatus('success');
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus('error');
        throw e;
      } finally {
        channelRef.current = null;
      }
    },
    [],
  );

  useEffect(() => () => channelRef.current?.close(), []);

  return { status, data, error, launch, close, reset };
}
