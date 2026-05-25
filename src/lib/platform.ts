// src/lib/platform.ts
import { platform as tauriPlatform } from '@tauri-apps/plugin-os';

let cached: string | null = null;

/**
 * 拿当前 OS 平台，结果缓存（webview 生命周期内不会变）
 */
export async function getPlatform(): Promise<string> {
  if (cached !== null) return cached;
  cached = await tauriPlatform();
  return cached;
}

/**
 * Remote SSH 仅支持 macOS / Linux；Windows 上隐藏入口
 * (remote-ssh spec 已定 Windows v2 处理)
 */
export async function isSshSupported(): Promise<boolean> {
  return (await getPlatform()) !== 'windows';
}

/**
 * 仅测试用：清缓存
 */
export function _resetPlatformCache(): void {
  cached = null;
}
