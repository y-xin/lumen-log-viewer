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
  ExportFormat,
  ExportResult,
  SavedFilter,
  NeighborDir,
  NeighborResponse,
  PositionResponse,
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

export async function listRecentFiles(): Promise<string[]> {
  return invoke<string[]>('cmd_list_recent_files');
}

export async function clearRecentFiles(): Promise<void> {
  return invoke<void>('cmd_clear_recent_files');
}

export async function exportToFile(
  spec: QuerySpec,
  format: ExportFormat,
  path: string,
): Promise<ExportResult> {
  return invoke<ExportResult>('cmd_export', {
    spec: serializeSpec(spec),
    format,
    path,
  });
}

// ─── Saved Filters ───

export async function listSavedFilters(filePath: string): Promise<SavedFilter[]> {
  return invoke<SavedFilter[]>('cmd_list_saved_filters', { filePath });
}

export async function saveFilter(filePath: string, filter: SavedFilter): Promise<SavedFilter[]> {
  return invoke<SavedFilter[]>('cmd_save_filter', { filePath, filter });
}

export async function deleteSavedFilter(filePath: string, id: string): Promise<SavedFilter[]> {
  return invoke<SavedFilter[]>('cmd_delete_saved_filter', { filePath, id });
}

export async function renameSavedFilter(
  filePath: string,
  id: string,
  newName: string,
): Promise<SavedFilter[]> {
  return invoke<SavedFilter[]>('cmd_rename_saved_filter', { filePath, id, newName });
}

// ─── Cross-page Detail Nav ───

export async function getNeighbor(
  spec: QuerySpec,
  lineNo: number,
  dir: NeighborDir,
): Promise<NeighborResponse | null> {
  return invoke<NeighborResponse | null>('cmd_get_neighbor', {
    spec: serializeSpec(spec), lineNo, dir,
  });
}

export async function getPosition(
  spec: QuerySpec,
  lineNo: number,
): Promise<PositionResponse | null> {
  return invoke<PositionResponse | null>('cmd_get_position', {
    spec: serializeSpec(spec), lineNo,
  });
}

// ─── UI 偏好 ───

export async function getColumnWidths(): Promise<Record<string, number> | null> {
  return invoke<Record<string, number> | null>('cmd_get_column_widths');
}

export async function saveColumnWidths(widths: Record<string, number>): Promise<void> {
  return invoke<void>('cmd_save_column_widths', { widths });
}
