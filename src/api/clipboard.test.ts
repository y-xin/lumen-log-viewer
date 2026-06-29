import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from './clipboard';

// 在 navigator 上装一个可控的 clipboard
function stubClipboard(writeText: ((t: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    stubClipboard(undefined);
  });

  it('navigator.clipboard 成功时返回 true，不走兜底', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    stubClipboard(write);
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    expect(await copyText('hi')).toBe(true);
    expect(write).toHaveBeenCalledWith('hi');
    expect(exec).not.toHaveBeenCalled();
  });

  it('navigator.clipboard reject 时兜底 execCommand("copy")', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('NotAllowed')));
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    expect(await copyText('hi')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('没有 navigator.clipboard 时直接兜底', async () => {
    stubClipboard(undefined);
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    expect(await copyText('hi')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('两条路径都失败时返回 false', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('x')));
    document.execCommand = vi.fn().mockReturnValue(false) as unknown as typeof document.execCommand;
    expect(await copyText('hi')).toBe(false);
  });
});
