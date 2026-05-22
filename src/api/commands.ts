// 统一的 Tauri command 调用层
// Rust 端 levels 是 HashSet，serde 会序列化为数组；TS 端用数组传入

import { invoke } from '@tauri-apps/api/core';
import type {
  FileMetadata,
  QueryResponse,
  QuerySpec,
  LogEntry,
  TemplateInfo,
  CustomTemplate,
  TestResult,
} from '../types/log';

/** 序列化 QuerySpec 时 levels / scope_in 由数组转为后端可接受形态 */
function serializeSpec(spec: QuerySpec): unknown {
  return {
    time_range: spec.time_range ?? null,
    levels: spec.levels ?? null,
    scope_filter: spec.scope_filter ?? null,
    scope_in: spec.scope_in ?? null,
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

export async function listTemplates(): Promise<TemplateInfo[]> {
  return invoke<TemplateInfo[]>('cmd_list_templates');
}

export async function reparseWithTemplate(templateId: string): Promise<FileMetadata> {
  return invoke<FileMetadata>('cmd_reparse_with_template', { templateId });
}

export async function saveCustomTemplate(tpl: CustomTemplate): Promise<void> {
  return invoke<void>('cmd_save_custom_template', { tpl });
}

export async function deleteCustomTemplate(id: string): Promise<void> {
  return invoke<void>('cmd_delete_custom_template', { id });
}

export async function testTemplate(tpl: CustomTemplate, limit: number): Promise<TestResult> {
  return invoke<TestResult>('cmd_test_template', { tpl, limit });
}

export async function startFollow(): Promise<void> {
  return invoke<void>('cmd_start_follow');
}

export async function stopFollow(): Promise<void> {
  return invoke<void>('cmd_stop_follow');
}
