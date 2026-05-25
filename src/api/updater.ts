// 自动升级 API 封装：checkForUpdate + installUpdate

import { check, type Update } from '@tauri-apps/plugin-updater';

export interface UpdateInfo {
  version: string;
  notes: string;
  date: string;
  /** 留给 installUpdate 用 — 不要序列化 */
  raw: Update;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const u = await check();
  if (!u) return null;
  return {
    version: u.version,
    notes: u.body ?? '',
    date: u.date ?? '',
    raw: u,
  };
}

export async function installUpdate(
  info: UpdateInfo,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  let downloaded = 0;
  let total = 0;
  await info.raw.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0;
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      // 'Finished' 不需特殊处理，plugin 装完会自动 process::exit
    }
  });
}
