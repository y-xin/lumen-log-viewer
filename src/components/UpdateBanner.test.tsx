// src/components/UpdateBanner.test.tsx
/// <reference types="@testing-library/jest-dom" />
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/updater', () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));

import { checkForUpdate } from '../api/updater';
import { UpdateBanner } from './UpdateBanner';

/** 推进 fake timer + flush 所有挂起 promise */
async function flushTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    // 让 promise 链解决
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('UpdateBanner', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(checkForUpdate).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('显示横幅 5s 后 check 到新版', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: '0.3.0', notes: 'changes', date: '', raw: {} as any,
    });
    render(<UpdateBanner />);
    await flushTimers(5000);
    expect(screen.queryByText(/Lumen v0\.3\.0 可用/)).toBeInTheDocument();
  });

  it('跳过版本后下次 mount 不显示', async () => {
    localStorage.setItem('lv:skip-update-version', '0.3.0');
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: '0.3.0', notes: '', date: '', raw: {} as any,
    });
    render(<UpdateBanner />);
    await flushTimers(5000);
    expect(screen.queryByText(/可用/)).not.toBeInTheDocument();
  });

  it('点跳过此版写 localStorage', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: '0.3.0', notes: '', date: '', raw: {} as any,
    });
    render(<UpdateBanner />);
    await flushTimers(5000);
    expect(screen.queryByText(/可用/)).toBeInTheDocument();

    // 切换到真实 timer 再点击（userEvent 内部依赖真实计时）
    vi.useRealTimers();
    await userEvent.click(screen.getByText('跳过此版'));
    expect(localStorage.getItem('lv:skip-update-version')).toBe('0.3.0');
    expect(screen.queryByText(/可用/)).not.toBeInTheDocument();
  });
});
