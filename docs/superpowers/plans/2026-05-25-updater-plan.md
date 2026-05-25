# App Updater v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Lumen 加 App 自动升级（启动横幅 + Settings 手动检查）+ GitHub Actions 多平台自动 build/release（macOS aarch64/x86_64 + Windows x64），Windows 上隐藏 Remote SSH 入口。

**Architecture:** `tauri-plugin-updater` 接 GitHub Release `latest.json`；ed25519 签名做完整性校验；前端 `UpdateBanner` 5s 后台检查 + 跳过版本 localStorage；`tauri-plugin-os` 判断平台让 OpenFileMenu / Settings 隐藏 Windows 上不可用的 Remote SSH 入口；`.github/workflows/release.yml` 由 git tag 触发，矩阵 3 平台，self-signed macOS cert + 无 Windows 签名。

**Tech Stack:** `tauri-plugin-updater` 2 + `tauri-plugin-os` 2 + `@tauri-apps/plugin-updater` / `@tauri-apps/plugin-os` + `tauri-apps/tauri-action@v0` (CI)。

**Spec:** [2026-05-25-updater-design.md](../specs/2026-05-25-updater-design.md)

---

## 文件结构

```
.github/workflows/
└── release.yml                       (新：CI build + release matrix)

scripts/
└── bump-version.sh                   (新：sed 同步 3 处版本号 + git tag)

src-tauri/
├── Cargo.toml                        (改：加 tauri-plugin-updater + tauri-plugin-os)
├── tauri.conf.json                   (改：plugins.updater + 三平台 bundle.targets)
├── capabilities/default.json         (改：加 updater + os ACL)
└── src/lib.rs                        (改：注册 plugin_updater + plugin_os)

src/
├── App.tsx                           (改：渲染 UpdateBanner)
├── api/updater.ts                    (新：checkForUpdate / installUpdate 封装)
├── lib/platform.ts                   (新：getPlatform / isSshSupported)
├── lib/platform.test.ts              (新：mock plugin-os 验 isSshSupported)
├── components/
│   ├── UpdateBanner.tsx              (新：5s 后台 check + 4 按钮 + 跳过)
│   ├── UpdateBanner.test.tsx         (新：skip-version 状态机)
│   ├── OpenFileMenu.tsx              (改：Windows 隐藏远程入口)
│   └── SettingsDialog.tsx            (改：加 about tab + Windows 隐藏远程 tab)
├── vite-env.d.ts                     (改：declare __APP_VERSION__/__BUILD_TIME__/__BUILD_COMMIT__)
└── package.json                      (改：加 @tauri-apps/plugin-updater + plugin-os)

vite.config.ts                        (改：define 3 个 build 元数据)

CHANGELOG.md                          (新)
SECURITY.md                           (新)
README.md                             (改：3 个新章节)
```

---

## Phase 1：依赖 + 版本管理基础

### Task 1.1：加 Rust + npm 依赖

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`

- [ ] **Step 1: src-tauri/Cargo.toml `[dependencies]` 末尾加**

```toml
tauri-plugin-updater = "2"
tauri-plugin-os = "2"
```

- [ ] **Step 2: package.json `dependencies` 加**

```json
"@tauri-apps/plugin-updater": "^2.0.0",
"@tauri-apps/plugin-os": "^2.0.0"
```

跑 `npm install` 同步 package-lock.json。

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: `Finished` 无错误（首次会 compile 这两个 plugin，约 30-90 秒）

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock package.json package-lock.json
git commit -m "deps: tauri-plugin-updater + tauri-plugin-os v2"
```

### Task 1.2：生成 ed25519 keypair + tauri.conf.json updater 配置

**Files:** Modify `src-tauri/tauri.conf.json`

- [ ] **Step 1: 生成 keypair（本地一次性）**

先检查 `~/.tauri/lumen.key` 是否存在：

```bash
if [ -f "$HOME/.tauri/lumen.key" ]; then
  echo "已有 ~/.tauri/lumen.key，跳过生成"
else
  mkdir -p "$HOME/.tauri"
  # 跑生成命令；提示设密码（也可空 Enter 跳过）
  npm exec -- @tauri-apps/cli signer generate -w "$HOME/.tauri/lumen.key"
fi
```

注意：私钥**永远不进 git**。pubkey 存在 `~/.tauri/lumen.key.pub` 文本里。

- [ ] **Step 2: 在 tauri.conf.json 加 plugins.updater**

读 pubkey：`cat "$HOME/.tauri/lumen.key.pub"`，把 base64 字符串填进配置：

```jsonc
// 在 tauri.conf.json 顶层加（与 "app"、"bundle" 同级）
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/y-xin/lumen-log-viewer/releases/latest/download/latest.json"
    ],
    "pubkey": "<把 ~/.tauri/lumen.key.pub 内容粘到这里>",
    "dialog": false
  }
}
```

如果 tauri.conf.json 已有 `"plugins": {}` 则在内部加 `"updater": { ... }`。

- [ ] **Step 3: 在 tauri.conf.json bundle.targets 加 3 平台 bundle 类型**

找到 `"bundle"` section（应该已有），加 / 改：

```jsonc
"bundle": {
  // ...existing...
  "targets": ["dmg", "app", "msi", "nsis"],
  "macOS": { /* existing */ },
  "windows": {}
}
```

`dmg`/`app` macOS 用；`msi`/`nsis` Windows 用。CI 会按 `--target` 自动只生成对应平台的产物。

- [ ] **Step 4: 编译验证（dev 模式）**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(updater): bake in updater pubkey + endpoint + multi-platform bundle targets"
```

### Task 1.3：bump-version.sh 脚本

**Files:** Create `scripts/bump-version.sh`

- [ ] **Step 1: 新建脚本**

```bash
#!/usr/bin/env bash
# 同步 src-tauri/Cargo.toml + tauri.conf.json + package.json 三处版本号
# 用法: ./scripts/bump-version.sh 0.3.0

set -e
VER=$1
[ -z "$VER" ] && { echo "usage: $0 0.3.0"; exit 1; }

# 校验 semver 格式
if ! [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ version 必须是 semver MAJOR.MINOR.PATCH（如 0.3.0）"
  exit 1
fi

# macOS BSD sed 用 sed -i ''；Linux GNU sed 用 sed -i
if [[ "$OSTYPE" == "darwin"* ]]; then
  SED_INPLACE=(sed -i '')
else
  SED_INPLACE=(sed -i)
fi

"${SED_INPLACE[@]}" "s/^version = .*/version = \"$VER\"/" src-tauri/Cargo.toml
"${SED_INPLACE[@]}" "s/\"version\": \"[^\"]*\"/\"version\": \"$VER\"/" src-tauri/tauri.conf.json
npm version --no-git-tag-version "$VER"

git add src-tauri/Cargo.toml src-tauri/tauri.conf.json package.json package-lock.json
git commit -m "chore(release): bump to v$VER"
git tag "v$VER"

echo "✅ Bumped to v$VER. Push with: git push && git push --tags"
```

- [ ] **Step 2: 加可执行权限**

```bash
chmod +x scripts/bump-version.sh
```

- [ ] **Step 3: 试跑（不真 bump，看 sed regex 命中）**

可以临时把版本号 sed pattern 改成只 echo 不替换的方式测试，或直接信赖 sed 语法正确性。这里 skip 真跑（避免污染 git history）。

- [ ] **Step 4: Commit**

```bash
git add scripts/bump-version.sh
git commit -m "feat(release): bump-version.sh 同步 3 处版本号 + git tag"
```

---

## Phase 2：updater plugin 注册 + capabilities ACL

### Task 2.1：lib.rs 注册 plugin_updater + plugin_os

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] **Step 1: 加 plugin 注册**

找到 `tauri::Builder::default()` 链，在其他 `.plugin(...)` 之后加：

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 3: 全测试不破坏**

Run: `cd src-tauri && cargo test --lib 2>&1 | grep "test result" | tail -3`
Expected: 现有 162 测试仍 PASS。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(updater): register plugin_updater + plugin_os in main builder"
```

### Task 2.2：capabilities/default.json 加 ACL

**Files:** Modify `src-tauri/capabilities/default.json`

- [ ] **Step 1: 在 permissions 数组末尾加**

```json
"permissions": [
  "core:default",
  "dialog:default",
  "updater:default",
  "updater:allow-check",
  "updater:allow-download-and-install",
  "os:default",
  "os:allow-platform"
]
```

- [ ] **Step 2: 编译验证（capability JSON schema 错会让 cargo build 失败）**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/capabilities/default.json
git commit -m "feat(capability): grant updater + os permissions"
```

---

## Phase 3：前端 platform helper + Remote SSH 入口 gate

### Task 3.1：src/lib/platform.ts + 单测

**Files:**
- Create: `src/lib/platform.ts`
- Create: `src/lib/platform.test.ts`

- [ ] **Step 1: 写 helper**

```ts
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
```

- [ ] **Step 2: 写测试**

```ts
// src/lib/platform.test.ts
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
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run src/lib/platform.test.ts 2>&1 | tail -5`
Expected: 4 passed

- [ ] **Step 4: tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误

- [ ] **Step 5: Commit**

```bash
git add src/lib/platform.ts src/lib/platform.test.ts
git commit -m "feat(fe): platform helper + isSshSupported (Windows 上 false)"
```

### Task 3.2：OpenFileMenu 加 Windows 隐藏远程入口

**Files:** Modify `src/components/OpenFileMenu.tsx`

先 read 现有 OpenFileMenu.tsx 找到"打开远程文件…" 按钮代码位置。

- [ ] **Step 1: 加 state + effect**

在组件顶部 import 加：

```tsx
import { useState, useEffect } from 'react';
import { isSshSupported } from '../lib/platform';
```

如果 useState/useEffect 已 import 不重复。

在组件函数顶部加：

```tsx
const [sshSupported, setSshSupported] = useState(true);  // 默认 true，避免初始 flash 隐藏
useEffect(() => {
  isSshSupported().then(setSshSupported).catch(() => setSshSupported(true));
}, []);
```

- [ ] **Step 2: 包"打开远程文件…"按钮**

找到含 "🌐 打开远程文件…" 的 button JSX，外面加条件：

```tsx
{sshSupported && (
  <button
    /* 原有 className / onClick 不变 */
  >
    🌐 打开远程文件…
  </button>
)}
```

- [ ] **Step 3: 验证**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -5`
Expected: 0 tsc 错误 / 测试全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/components/OpenFileMenu.tsx
git commit -m "feat(fe): hide 「打开远程文件…」on Windows"
```

### Task 3.3：SettingsDialog 加 Windows 隐藏 "远程" tab

**Files:** Modify `src/components/SettingsDialog.tsx`

- [ ] **Step 1: 加 state + effect**

在组件顶部 import 加（如未有）：

```tsx
import { isSshSupported } from '../lib/platform';
```

在 SettingsDialog 函数顶部加：

```tsx
const [sshSupported, setSshSupported] = useState(true);
useEffect(() => {
  isSshSupported().then(setSshSupported).catch(() => setSshSupported(true));
}, []);
```

- [ ] **Step 2: 在 tab 列表渲染处包"远程"按钮**

找到现有 tab 列表（含 `tab === 'remote'` 的按钮）：

```tsx
{sshSupported && (
  <button className={tab === 'remote' ? '<active>' : '<inactive>'}
          onClick={() => setTab('remote')}>远程</button>
)}
```

- [ ] **Step 3: tab 内容渲染处加 sshSupported 守卫**

找到 `{tab === 'remote' && <RemoteSettingsTab />}` 改为：

```tsx
{tab === 'remote' && sshSupported && <RemoteSettingsTab />}
```

防御性：若用户在 Windows 上之前用过 macOS 装的 prefs（不太可能跨平台同步，但保险）。

- [ ] **Step 4: 如果当前 tab 是 'remote' 且 Windows 上加载到，要自动切回 'general'**

在 `useEffect` 之后加：

```tsx
useEffect(() => {
  if (!sshSupported && tab === 'remote') setTab('general');
}, [sshSupported, tab]);
```

- [ ] **Step 5: 验证**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -5`
Expected: 0 tsc 错误 / 测试全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsDialog.tsx
git commit -m "feat(fe): hide 「远程」tab on Windows + auto-fallback to general"
```

---

## Phase 4：前端 updater API + UpdateBanner

### Task 4.1：vite.config.ts 注入 build 元数据 + vite-env.d.ts

**Files:**
- Modify: `vite.config.ts`
- Modify: `src/vite-env.d.ts`

- [ ] **Step 1: vite.config.ts 顶部 import + define**

```ts
// vite.config.ts 顶部
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const commit = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'unknown'; }
})();
```

在 `defineConfig({ ... })` 加 `define`：

```ts
export default defineConfig({
  // ...existing plugins/server...
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
});
```

如果 defineConfig 里已有 `define`，合并。

- [ ] **Step 2: src/vite-env.d.ts 加 declare**

```ts
/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_COMMIT__: string;
```

如果文件已有内容，追加 declare 行。

- [ ] **Step 3: 验证**

Run: `npm run build 2>&1 | tail -5`
Expected: vite build 成功，dist/ 内 .js 含编译后的 `"0.1.0"` / commit hash / 时间戳。

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误（declare 起作用，未来引用不报错）。

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts src/vite-env.d.ts
git commit -m "feat(fe): inject __APP_VERSION__/__BUILD_TIME__/__BUILD_COMMIT__ at build"
```

### Task 4.2：src/api/updater.ts

**Files:** Create `src/api/updater.ts`

- [ ] **Step 1: 新建文件**

```ts
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
```

- [ ] **Step 2: tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/api/updater.ts
git commit -m "feat(fe): src/api/updater.ts — checkForUpdate + installUpdate"
```

### Task 4.3：UpdateBanner 组件 + 单测

**Files:**
- Create: `src/components/UpdateBanner.tsx`
- Create: `src/components/UpdateBanner.test.tsx`

- [ ] **Step 1: 写组件**

```tsx
// src/components/UpdateBanner.tsx
import { useEffect, useState } from 'react';
import { checkForUpdate, installUpdate, type UpdateInfo } from '../api/updater';

const SKIP_KEY = 'lv:skip-update-version';

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<{ d: number; t: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showChangelog, setShowChangelog] = useState(false);

  // 启动 5s 后台 check
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const u = await checkForUpdate();
        if (!u) return;
        if (localStorage.getItem(SKIP_KEY) === u.version) return;
        setInfo(u);
      } catch {
        // 离线 / 网络受限静默；Settings 手动检查时才报错
      }
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  if (!info) return null;

  const handleInstall = async () => {
    setError(null);
    setProgress({ d: 0, t: 0 });
    try {
      await installUpdate(info, (d, t) => setProgress({ d, t }));
      // 装完 plugin 自动 process::exit，前端走不到
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setProgress(null);
    }
  };

  const handleSkip = () => {
    localStorage.setItem(SKIP_KEY, info.version);
    setInfo(null);
  };

  return (
    <>
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center gap-3 text-sm">
        <span>🎉 Lumen v{info.version} 可用</span>
        {progress ? (
          <span className="text-slate-600">
            下载中 {progress.t > 0
              ? `${Math.round((progress.d / progress.t) * 100)}%`
              : '...'}
          </span>
        ) : (
          <>
            <button className="ctl" onClick={() => setShowChangelog(true)}>看 changelog</button>
            <button className="ctl ctl-primary" onClick={handleInstall}>现在更新</button>
            <button className="ctl" onClick={() => setInfo(null)}>稍后</button>
            <button className="ctl text-slate-500" onClick={handleSkip}>跳过此版</button>
          </>
        )}
        {error && <span className="text-red-600">❌ {error}</span>}
      </div>
      {showChangelog && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
             onClick={() => setShowChangelog(false)}>
          <div className="bg-white rounded shadow-xl p-5 max-w-2xl max-h-[70vh] overflow-auto"
               onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-3">v{info.version} 更新日志</h3>
            <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans">{info.notes || '（无 changelog）'}</pre>
            <div className="flex justify-end mt-3">
              <button className="ctl" onClick={() => setShowChangelog(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: 写单测**

```tsx
// src/components/UpdateBanner.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/updater', () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));

import { checkForUpdate } from '../api/updater';
import { UpdateBanner } from './UpdateBanner';

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
    vi.advanceTimersByTime(5000);
    await waitFor(() => expect(screen.queryByText(/Lumen v0\.3\.0 可用/)).toBeInTheDocument());
  });

  it('跳过版本后下次 mount 不显示', async () => {
    localStorage.setItem('lv:skip-update-version', '0.3.0');
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: '0.3.0', notes: '', date: '', raw: {} as any,
    });
    render(<UpdateBanner />);
    vi.advanceTimersByTime(5000);
    // 等异步 promise 解决一轮
    await Promise.resolve();
    expect(screen.queryByText(/可用/)).not.toBeInTheDocument();
  });

  it('点跳过此版写 localStorage', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: '0.3.0', notes: '', date: '', raw: {} as any,
    });
    render(<UpdateBanner />);
    vi.advanceTimersByTime(5000);
    await waitFor(() => expect(screen.queryByText(/可用/)).toBeInTheDocument());

    vi.useRealTimers(); // userEvent 需要真 timer
    await userEvent.click(screen.getByText('跳过此版'));
    expect(localStorage.getItem('lv:skip-update-version')).toBe('0.3.0');
    expect(screen.queryByText(/可用/)).not.toBeInTheDocument();
  });
});
```

依赖 `@testing-library/react` + `@testing-library/user-event` + `jsdom`（vitest 配置应已含 jsdom env，如果没有需在 vitest.config.ts 加 `test.environment = 'jsdom'`）。

- [ ] **Step 3: 安装 testing-library 依赖**（如未有）

```bash
npm install -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

如已是 dev deps 跳过。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/components/UpdateBanner.test.tsx 2>&1 | tail -10`
Expected: 3 passed

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误

- [ ] **Step 5: Commit**

```bash
git add src/components/UpdateBanner.tsx src/components/UpdateBanner.test.tsx package.json package-lock.json
git commit -m "feat(fe): UpdateBanner — 5s 后台 check + 跳过此版 + changelog modal"
```

### Task 4.4：App.tsx 渲染 UpdateBanner

**Files:** Modify `src/App.tsx`

- [ ] **Step 1: import + 渲染**

文件顶部 import 加：

```tsx
import { UpdateBanner } from './components/UpdateBanner';
```

在 App return 内、header 之下（FilterBar 之上）插入：

```tsx
<UpdateBanner />
```

具体位置：找到 `<header ...>...</header>` 那行，在它的关闭标签之后立刻插入。

- [ ] **Step 2: 验证**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -5`
Expected: 0 tsc 错误 / 测试全 PASS。

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(fe): render UpdateBanner above FilterBar"
```

---

## Phase 5：Settings 关于 tab

### Task 5.1：SettingsDialog 加 "关于" tab

**Files:** Modify `src/components/SettingsDialog.tsx`

- [ ] **Step 1: tab union 加 `'about'`**

找到 SettingsTab type 定义（如 `type SettingsTab = 'general' | 'colors' | ...`），加 `'about'`。

- [ ] **Step 2: tab 列表加按钮**

在 tab 列表 JSX 末尾加（保持跟其他 tab 同 className）：

```tsx
<button className={tab === 'about' ? '<active>' : '<inactive>'}
        onClick={() => setTab('about')}>关于</button>
```

- [ ] **Step 3: tab 内容渲染处加**

```tsx
{tab === 'about' && <AboutTab />}
```

- [ ] **Step 4: 在文件末尾加 AboutTab 组件**

```tsx
import { useState as useStateForAbout } from 'react';
// 注：如果文件顶部已有 useState 复用即可
import { checkForUpdate } from '../api/updater';

function AboutTab() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const onCheck = async () => {
    setChecking(true);
    setResult(null);
    try {
      const u = await checkForUpdate();
      setResult(u
        ? `🎉 v${u.version} 可用（关闭设置 → 顶部横幅有"现在更新"按钮）`
        : '✅ 已是最新版本'
      );
    } catch (e: any) {
      setResult(`❌ 检查失败：${e?.message ?? String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  const openRepoUrl = async () => {
    try {
      // 调系统浏览器；Tauri 2 走 @tauri-apps/plugin-shell open
      const { open } = await import('@tauri-apps/plugin-shell');
      await open('https://github.com/y-xin/lumen-log-viewer');
    } catch {
      // 装这个 plugin 之前 fallback：什么也不做
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="border rounded p-3 space-y-1.5">
        <div className="font-semibold">Lumen — 日志查看与分析</div>
        <div className="text-xs text-slate-600">
          <div>当前版本：<span className="font-mono">v{__APP_VERSION__}</span></div>
          <div>构建时间：<span className="font-mono">{__BUILD_TIME__}</span></div>
          <div>Commit：<span className="font-mono">{__BUILD_COMMIT__}</span></div>
        </div>
      </div>

      <div>
        <button className="ctl ctl-primary" disabled={checking} onClick={onCheck}>
          {checking ? '检查中…' : '检查更新'}
        </button>
        {result && <div className="mt-2 text-xs">{result}</div>}
      </div>

      <div className="text-xs text-slate-500">
        源码：<button className="underline" onClick={openRepoUrl}>https://github.com/y-xin/lumen-log-viewer</button>
        <br />License：MIT
      </div>
    </div>
  );
}
```

注：上面的 `useStateForAbout` import 是 placeholder — 直接用文件顶部已 import 的 `useState`，删 alias 行。

`@tauri-apps/plugin-shell` 可能未装；如果没装，open 按钮按钮 fallback 没行为。要加：

```bash
npm install @tauri-apps/plugin-shell
```

并在 Cargo.toml / capabilities / lib.rs 启用 `tauri-plugin-shell`，capability 加 `"shell:allow-open"`。**这是个 small dep 添加，是否做看依赖意愿**：

- 简单做法：暂时不加 plugin-shell，"源码：" 那行改成显示纯文本 URL（不可点击）
- 完整做法：加 plugin-shell + ACL，按钮真打开浏览器

**默认选简单做法**：去掉 openRepoUrl button，改为显示纯文本：

```tsx
<div className="text-xs text-slate-500">
  源码：<span className="font-mono">https://github.com/y-xin/lumen-log-viewer</span>
  <br />License：MIT
</div>
```

- [ ] **Step 5: 验证**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -5`
Expected: 0 tsc 错误 / 测试全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsDialog.tsx
git commit -m "feat(fe): Settings 加 「关于」tab — 版本号 / 构建信息 / 手动检查更新"
```

---

## Phase 6：CHANGELOG + SECURITY + CI workflow + README

### Task 6.1：CHANGELOG.md（新建）

**Files:** Create `CHANGELOG.md`

- [ ] **Step 1: 新建文件**

```markdown
# Changelog

All notable changes to Lumen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-25

### Added
- 多窗口支持：每个文件独立窗口、同路径自动聚焦、⌘N 新窗
- 远程日志（SSH tail）：私钥 / 密码认证、known_hosts TOFU、自动退避重连
- App 自动升级检测：启动横幅 + Settings 手动检查
- Settings 加 "关于" tab：显示版本 / 构建时间 / commit

### Security
- known_hosts append/lookup 输入校验：拒绝换行 / shell metachar 注入
- TOFU "仅本次" session bypass：让 HostKeyDialog "仅本次"按钮真生效
- HostKeyUnknown 单独 emit 事件（不再被压成 Auth 错误）
- Credential Debug impl 屏蔽 passphrase / password

### Fixed
- dark 模式选中态 / chip / slider / datepicker 一致性

### Limits
- Windows 上 Remote SSH 入口隐藏（v2 适配）
- macOS .app 用 self-signed cert，首次需右键打开
- Windows .msi/.exe 不签，首次 SmartScreen 警告需 "More info → Run anyway"

## [0.1.0] - 2026-05-22
- 首个内部版本
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG.md keep-a-changelog format"
```

### Task 6.2：SECURITY.md（新建）

**Files:** Create `SECURITY.md`

- [ ] **Step 1: 新建文件**

```markdown
# Security

## 报告漏洞

发邮件到 `<your-email>@example.com`（**实施时替换为维护者邮箱**；如有 PGP 公钥可在此公布）。

我们承诺：
- 72 小时内确认收到
- 30 天内给出修复或 mitigation 方案
- 不会因善意安全研究起诉报告者

## Updater 密钥管理

Lumen 自动升级用 ed25519 签名做完整性校验：

- **公钥** 嵌在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` —— 可 commit，不是 secret
- **私钥** 保存在维护者本机 `~/.tauri/lumen.key` + GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` —— 永远不进 git
- **私钥泄露应急**：
  1. 立即重新生成：`npm exec -- @tauri-apps/cli signer generate -w ~/.tauri/lumen.key`
  2. 把新公钥 commit 到 `tauri.conf.json`，标记 changelog `BREAKING: updater pubkey rotated`
  3. 旧 release 的 `latest.json` 自然过期（旧公钥不再被任何已发布版本认可）
  4. 用户必须**手动重新下载**最新版（updater 链断）

## macOS Codesigning

Lumen 用 self-signed cert（本机 Keychain 生成），不经 Apple Notary 公证：
- 用户首次打开 .app 会被 Gatekeeper 拦截，需右键 → 打开 → 允许
- updater 后续 atomic replace 不再触发警告（用户已为该 cert 一次性 trust）
- 未来如有 Apple Developer 账号将切换为 Developer ID + notarization，**不影响 ed25519 updater 校验**

## Windows Codesigning

Lumen Windows .msi/.exe **不做 codesigning**：
- 用户首次跑 .msi 会被 SmartScreen 拦截，需 "More info → Run anyway"
- self-signed Windows cert 对 SmartScreen 无效（需付费 EV cert，性价比低）
```

- [ ] **Step 2: Commit**

```bash
git add SECURITY.md
git commit -m "docs: add SECURITY.md — 漏洞报告 + ed25519 key rotation + codesigning 现状"
```

### Task 6.3：.github/workflows/release.yml

**Files:** Create `.github/workflows/release.yml`

- [ ] **Step 1: 新建文件**

```yaml
name: release
on:
  push:
    tags: ['v*.*.*']

jobs:
  extract-changelog:
    runs-on: ubuntu-latest
    outputs:
      notes: ${{ steps.x.outputs.notes }}
    steps:
      - uses: actions/checkout@v4
      - id: x
        run: |
          VER="${GITHUB_REF_NAME#v}"
          NOTES=$(awk "/^## \[$VER\]/{flag=1; next} /^## \[/{flag=0} flag" CHANGELOG.md)
          if [ -z "$NOTES" ]; then
            NOTES="(CHANGELOG.md 内无 [$VER] 章节)"
          fi
          {
            echo "notes<<EOF"
            echo "$NOTES"
            echo "EOF"
          } >> "$GITHUB_OUTPUT"

  build:
    needs: extract-changelog
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-14,       target: aarch64-apple-darwin }
          - { os: macos-13,       target: x86_64-apple-darwin }
          - { os: windows-latest, target: x86_64-pc-windows-msvc }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      # macOS 走 self-signed cert 临时 keychain；Windows 不签
      - name: Setup macOS keychain
        if: startsWith(matrix.os, 'macos')
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
        run: |
          KEYCHAIN_PATH="$RUNNER_TEMP/build.keychain-db"
          KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"
          security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          echo "$APPLE_CERTIFICATE" | base64 --decode > "$RUNNER_TEMP/cert.p12"
          security import "$RUNNER_TEMP/cert.p12" -k "$KEYCHAIN_PATH" \
            -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple:,codesign: \
            -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
          security list-keychains -d user -s "$KEYCHAIN_PATH" \
            $(security list-keychains -d user | tr -d '"')

      - run: npm ci

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
        with:
          args: --target ${{ matrix.target }}
          tagName: ${{ github.ref_name }}
          releaseName: 'Lumen ${{ github.ref_name }}'
          releaseBody: ${{ needs.extract-changelog.outputs.notes }}
          releaseDraft: false
          prerelease: false
          includeUpdaterJson: true
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: GitHub Actions release workflow (macOS aarch64/x86_64 + Windows)"
```

### Task 6.4：README 加三个新章节

**Files:** Modify `README.md`

先 read README.md 看现有结构（章节顺序）。

- [ ] **Step 1: "核心能力" 列表加一项**

在能力列表合适位置（与"远程日志"等同级）插入：

```markdown
- **App 自动升级**：启动 5s 后台检查 GitHub Releases；有新版顶部横幅提示，点击下载装 → atomic replace + 重启
```

- [ ] **Step 2: 在 "已知 MVP 限制" 之前插入 "下载安装" 章节**

```markdown
## 下载安装

到 [Releases](https://github.com/y-xin/lumen-log-viewer/releases) 下载对应平台：

### macOS

下载 `Lumen_x.y.z_aarch64.dmg`（Apple Silicon）或 `Lumen_x.y.z_x64.dmg`（Intel）。

**首次安装**：双击 .dmg → 拖 Lumen.app 到 Applications → 双击启动会被 Gatekeeper 拦截（"无法打开，因为无法验证开发者"）。

解决：
1. **右键** Lumen.app → **打开** → 弹窗里点 **打开** —— 一次后永远 trust
2. 或终端：`xattr -d com.apple.quarantine /Applications/Lumen.app`

之后版本通过 App 内 updater 自动装无障碍。

### Windows

下载 `Lumen_x.y.z_x64-setup.exe` 或 `Lumen_x.y.z_x64_en-US.msi`。

**首次安装**：双击会被 SmartScreen 拦截（"Windows protected your PC"）。

解决：点 **More info** → **Run anyway** → 安装正常进行。

> **Windows 上的限制**：Remote SSH 功能在 Windows 上**不可用**（v2 适配），OpenFileMenu 不显示"打开远程文件"项。
```

- [ ] **Step 3: "下载安装" 之后插入 "自动升级" 章节**

```markdown
## 自动升级

Lumen 启动 5s 后静默检查 GitHub Releases 有无新版：

- 有新版 → 顶部横幅 `🎉 Lumen v0.x.x 可用` + 4 按钮：
  - **看 changelog** — 弹窗显示 release notes
  - **现在更新** — 下载 → ed25519 签名校验 → atomic replace → 重启
  - **稍后** — 关闭横幅，下次启动还会出
  - **跳过此版** — 写 localStorage，直到下一个更新前不再提示

- 也可在 **Settings → 关于 → [检查更新]** 手动触发（不受"跳过此版"影响）

离线 / 网络受限时静默不报错。
```

- [ ] **Step 4: 在 "未实现" / 文末附近 插入 "发布流程"（开发者）章节**

```markdown
## 发布流程（开发者）

1. 更新 `CHANGELOG.md` 把 `## [Unreleased]` 重命名为 `## [x.y.z] - YYYY-MM-DD`，新建空白 `## [Unreleased]`
2. `./scripts/bump-version.sh 0.3.0` —— 同步 3 处版本号 + commit + tag
3. `git push && git push --tags` —— 触发 GitHub Actions
4. 等 Actions 跑完（约 10-15 分钟），Release 自动出
5. 现存用户 5 秒后看到 updater 横幅

### 首次发布前 setup

见 [`docs/superpowers/specs/2026-05-25-updater-design.md`](docs/superpowers/specs/2026-05-25-updater-design.md) §10 章节 —— 需配置：
- ed25519 keypair (`~/.tauri/lumen.key`)
- self-signed macOS cert 导出为 .p12
- GitHub Secrets × 5
- repo Actions 权限：Read and write
```

- [ ] **Step 5: 更新"当前状态"那行加 Updater**

找到 README 顶部 `## 当前状态：` 那行，末尾加：

```markdown
## 当前状态：... + Multi-Window + Remote-SSH + Updater (16 features) 已完成
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): 下载安装 / 自动升级 / 发布流程 三个新章节"
```

---

## Phase 7：验证

### Task 7.1：全测试 + tsc + 本地 build 验证

- [ ] **Step 1: 跑全测试**

Run: `cd src-tauri && cargo test 2>&1 | grep "test result" | tail -10`
Expected: 全 PASS（162 lib + 集成测试）。

Run: `cd /Users/kimyeung/Personal\ Projects/log-viewer && npx vitest run 2>&1 | tail -5`
Expected: 全 PASS（之前 36 + 4 platform + 3 UpdateBanner ≈ 43）。

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误。

- [ ] **Step 2: 本地 build app 验证**

Run: `npm run tauri build -- --bundles app 2>&1 | tail -10`
Expected: `Built application at: .../Lumen.app`，无错误。

- [ ] **Step 3: 跑出来的 Lumen.app 启动**

```bash
open src-tauri/target/release/bundle/macos/Lumen.app
```

观察：
- App 能启动，header 显示 Lumen
- Settings → 关于 tab 存在，显示版本 v0.1.0（或 bump 之后）+ 当前 commit + build 时间
- Settings → 关于 → [检查更新] 点击会真去 fetch GitHub（要先 push 过 tag）
  - 没 release 时显示 "✅ 已是最新版本"
  - 有 release 时显示 "🎉 v..." 提示

如果触发 CI 跑 release 之前，[检查更新] 应该返回"已是最新版本"或 "endpoint 404"。本地验证可跳过。

### Task 7.2：手动验收清单（本地 + 真发版后）

**本地验证**（开发期间）：

- [ ] OpenFileMenu 在 macOS 上仍显示 "🌐 打开远程文件…"
- [ ] Settings → 关于 tab 显示版本号 / 构建时间 / commit
- [ ] Settings → 关于 → [检查更新] 不 crash（首次会返回"已是最新"，因为还没真 release）

**真发版后验证**（按 README §发布流程跑完 v0.3.0 后）：

- [ ] CI Actions tab 三 job 全绿
- [ ] Release 页面有 6 个 asset：`Lumen_0.3.0_aarch64.dmg` / `Lumen_0.3.0_x64.dmg` / `Lumen_0.3.0_x64-setup.exe` / `Lumen_0.3.0_x64_en-US.msi` / `*.app.tar.gz` / `latest.json`
- [ ] `curl https://github.com/y-xin/lumen-log-viewer/releases/latest/download/latest.json` 返回正确 JSON（含三平台 url + signature）
- [ ] 装个老版本（手动 build v0.1.0 .app 留一份）→ 启动 → 5s 后弹横幅 → 点 [现在更新] → 装成功 → 自动重启 → 新版生效
- [ ] 点 [跳过此版] → 下次启动不再提示
- [ ] Settings → 关于 → [检查更新] 仍能看到（即使跳过过）
- [ ] 模拟离线（关 wifi）→ 启动不弹 error
- [ ] **Windows 验证**：装 .msi → SmartScreen 拦截 → More info → Run anyway → 装成功
- [ ] **Windows 验证**：OpenFileMenu 无"打开远程文件"项
- [ ] **Windows 验证**：Settings 无 "远程" tab

如清单全过，进入 finishing-a-development-branch。
