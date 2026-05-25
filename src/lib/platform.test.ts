import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(),
}));

import { platform as mockedPlatform } from '@tauri-apps/plugin-os';
import { getPlatform, isSshSupported, _resetPlatformCache } from './platform';

describe('platform helper', () => {
  beforeEach(() => {
    _resetPlatformCache();
    vi.mocked(mockedPlatform).mockReset();
  });

  it('returns macos and caches', async () => {
    vi.mocked(mockedPlatform).mockResolvedValue('macos');
    expect(await getPlatform()).toBe('macos');
    expect(await getPlatform()).toBe('macos');
    expect(mockedPlatform).toHaveBeenCalledTimes(1); // 缓存生效
  });

  it('isSshSupported true on macos', async () => {
    vi.mocked(mockedPlatform).mockResolvedValue('macos');
    expect(await isSshSupported()).toBe(true);
  });

  it('isSshSupported false on windows', async () => {
    vi.mocked(mockedPlatform).mockResolvedValue('windows');
    expect(await isSshSupported()).toBe(false);
  });

  it('isSshSupported true on linux', async () => {
    vi.mocked(mockedPlatform).mockResolvedValue('linux');
    expect(await isSshSupported()).toBe(true);
  });
});
