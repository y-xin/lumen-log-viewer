// 8 个远程 SSH 相关 invoke 封装

import { invoke } from '@tauri-apps/api/core';
import type { FileMetadata } from '../types/log';

export type Credential =
  | { type: 'key_file'; path: string; passphrase: string | null }
  | { type: 'password'; password: string };

export interface SshConnectionParams {
  host: string;
  user: string;
  port: number;
  credential: Credential;
}

export interface SshHostConfig {
  user: string;
  key_path: string;
  last_path: string | null;
}

export interface PendingConnectionPayload {
  params: SshConnectionParams;
  path: string;
  tail_lines: number;
}

export async function testSshConnection(params: SshConnectionParams): Promise<void> {
  return invoke('cmd_test_ssh_connection', { params });
}

export async function openRemoteFile(
  params: SshConnectionParams,
  path: string,
  tailLines: number,
): Promise<FileMetadata> {
  return invoke('cmd_open_remote_file', { params, path, tailLines });
}

export async function openRemoteInNewWindow(
  params: SshConnectionParams,
  path: string,
  tailLines: number,
): Promise<void> {
  return invoke('cmd_open_remote_in_new_window', { params, path, tailLines });
}

export async function takePendingConnection(): Promise<PendingConnectionPayload | null> {
  return invoke('cmd_take_pending_connection');
}

export type HostKeyAction = 'trust' | 'session-only';

export async function confirmHostKey(
  host: string,
  port: number,
  fingerprint: string,
  action: HostKeyAction,
): Promise<void> {
  // 后端使用 #[serde(rename_all = "kebab-case")] enum，'trust' / 'session-only' 直接映射 enum variant
  return invoke('cmd_confirm_host_key', { host, port, fingerprint, action });
}

export async function listSshHosts(): Promise<Record<string, SshHostConfig>> {
  return invoke('cmd_list_ssh_hosts');
}

export async function saveSshHost(key: string, cfg: SshHostConfig): Promise<void> {
  return invoke('cmd_save_ssh_host', { key, cfg });
}

export async function deleteSshHost(key: string): Promise<void> {
  return invoke('cmd_delete_ssh_host', { key });
}
