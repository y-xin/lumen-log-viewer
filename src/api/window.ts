// 多窗口 API 封装：openInNewWindow / openBlankWindow
// 所有"打开文件"入口（菜单 / 拖拽 / 最近文件 / ⌘O）统一走这里

import { invoke } from '@tauri-apps/api/core';

/** 打开文件到新窗口（同路径自动聚焦已有窗口） */
export async function openInNewWindow(path: string): Promise<void> {
  await invoke('cmd_open_in_new_window', { path });
}

/** 弹空白窗口（⌘N / dock reopen） */
export async function openBlankWindow(): Promise<void> {
  await invoke('cmd_open_blank_window');
}
