// 统一的 Tauri command 调用层
// Rust 端 levels 是 HashSet，serde 会序列化为数组；TS 端用数组传入

import { invoke } from '@tauri-apps/api/core';
import type { FileMetadata, QueryResponse, QuerySpec, LogEntry } from '../types/log';

/** 序列化 QuerySpec 时 levels 由数组转为后端可接受形态 */
function serializeSpec(spec: QuerySpec): unknown {
  return {
    time_range: spec.time_range ?? null,
    levels: spec.levels ?? null,
    scope_filter: spec.scope_filter ?? null,
    text_search: spec.text_search ?? null,
  };
}

export async function openFile(path: string): Promise<FileMetadata> {
  return invoke<FileMetadata>('cmd_open_file', { path });
}

export async function getMetadata(): Promise<FileMetadata> {
  return invoke<FileMetadata>('cmd_get_metadata');
}

export async function query(spec: QuerySpec, page: number, pageSize: number): Promise<QueryResponse> {
  return invoke<QueryResponse>('cmd_query', { spec: serializeSpec(spec), page, pageSize });
}

export async function getPage(spec: QuerySpec, page: number, pageSize: number): Promise<LogEntry[]> {
  return invoke<LogEntry[]>('cmd_get_page', { spec: serializeSpec(spec), page, pageSize });
}
