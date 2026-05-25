# App Updater v1 设计文档

- **日期**：2026-05-25
- **状态**：设计已认可，待生成实现计划
- **前置**：Lumen v0.1.0（已含 multi-window v1 + remote-ssh v1 + security hotfix）
- **作用范围**：App 启动时检查 GitHub Release 是否有新版，横幅提示用户更新，并打通 GitHub Actions 自动 build + release 流水线

## 1. 目标

- 用户启动 Lumen 时自动检查 GitHub Releases 有无新版，**5 秒后台静默**进行（不阻塞 UI）
- 有新版 → 顶部横幅显示 `🎉 Lumen v0.x.x 可用 [看 changelog] [现在更新] [稍后] [跳过此版]`
- 用户点"现在更新" → 下载 → ed25519 签名校验 → atomic replace → 重启
- 用户点"跳过此版" → 直到下一个新版前不再提示（localStorage 持久化）
- Settings 加"关于"tab：显示版本 / 构建时间 / commit / [手动检查更新]
- `git push --tags v0.x.x` 触发 GitHub Actions 自动 build macOS aarch64 + x86_64 + Windows x64 三平台 + 自动生成 `latest.json` 上传 Release
- Windows 平台 build 但 **Remote SSH 入口隐藏**（remote-ssh spec 已标 Windows 不支持）

## 2. 非目标

- ❌ Apple Developer 公证（Notarization）—— 用户接受 self-signed cert + 首次右键打开
- ❌ Windows codesigning —— SmartScreen self-signed 仍拦截，付费 EV cert 才免；用户首次看到警告需 "More info → Run anyway"
- ❌ Linux 平台 build（CI 复杂度高、用户面小，留作 v2）
- ❌ Remote SSH 在 Windows 上的实际功能（spec 明示 v2；本期仅做前端入口 platform gate）
- ❌ 自动后台下载新版（"推送式"安装太侵入）
- ❌ 增量更新 / 差分 patch
- ❌ 多版本并存 / 灰度发布 / staged rollout
- ❌ 内置 changelog 完整 markdown 渲染（plain text / 简单 HTML 即可）
- ❌ 启动时定期检查（仅启动一次 + Settings 手动；不做 N 小时 timer）

## 3. 版本号管理

### 3.1 单一真相源

`src-tauri/tauri.conf.json` `version` —— 决定 .app Info.plist 显示版本 + updater 比较的 "当前版本"。

`src-tauri/Cargo.toml` `[package].version` + `package.json` `version` 跟随同步。

### 3.2 bump 脚本

`scripts/bump-version.sh`：

```bash
#!/usr/bin/env bash
# 用法: ./scripts/bump-version.sh 0.3.0
set -e
VER=$1
[ -z "$VER" ] && { echo "usage: $0 0.3.0"; exit 1; }
sed -i '' "s/^version = .*/version = \"$VER\"/" src-tauri/Cargo.toml
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VER\"/" src-tauri/tauri.conf.json
npm version --no-git-tag-version "$VER"
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json package.json package-lock.json
git commit -m "chore(release): bump to v$VER"
git tag "v$VER"
echo "✅ Bumped to v$VER. Push with: git push && git push --tags"
```

`chmod +x scripts/bump-version.sh`。

### 3.3 semver 约定

按 `MAJOR.MINOR.PATCH` (keep-a-changelog)。当前 v0.1.0 → 第一次发是 v0.3.0（含 multi-window + remote-ssh + security hotfix）。

## 4. 后端集成（tauri-plugin-updater）

### 4.1 依赖

```toml
# src-tauri/Cargo.toml
tauri-plugin-updater = "2"
tauri-plugin-os = "2"             # platform 判断（Remote SSH 入口 gate）
```

```json
// package.json
"@tauri-apps/plugin-updater": "^2.0.0",
"@tauri-apps/plugin-os": "^2.0.0"
```

### 4.2 ed25519 签名密钥（一次性 setup）

```bash
npm exec -- @tauri-apps/cli signer generate -w ~/.tauri/lumen.key
```

产物：
- `~/.tauri/lumen.key` —— **私钥，永远不进 git**；CI 走 `TAURI_SIGNING_PRIVATE_KEY` secret
- `~/.tauri/lumen.key.pub` —— 公钥 base64 字符串；**填进 `tauri.conf.json` 的 `plugins.updater.pubkey` 字段**，可 commit（公钥不是 secret）

### 4.3 `tauri.conf.json` updater plugin

```jsonc
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/y-xin/lumen-log-viewer/releases/latest/download/latest.json"
      ],
      "pubkey": "<base64 公钥内容>",
      "dialog": false
    }
  }
}
```

`dialog: false` —— 不用插件内置 native dialog，前端自己出 React 横幅。

### 4.4 capabilities ACL

```jsonc
// src-tauri/capabilities/default.json
{
  "permissions": [
    // ...已有...
    "updater:default",
    "updater:allow-check",
    "updater:allow-download-and-install",
    "os:default",
    "os:allow-platform"
  ]
}
```

### 4.5 Rust 侧注册

```rust
// src-tauri/src/lib.rs
tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_os::init())
    // ...其他 plugin...
```

## 5. 前端

### 5.1 API 封装

`src/api/updater.ts`（新增）：

```ts
import { check, type Update } from '@tauri-apps/plugin-updater';

export interface UpdateInfo {
  version: string;
  notes: string;
  date: string;
  raw: Update;  // 留给 downloadAndInstall 用
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const u = await check();
  if (!u) return null;
  return { version: u.version, notes: u.body ?? '', date: u.date ?? '', raw: u };
}

export async function installUpdate(
  info: UpdateInfo,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  let downloaded = 0;
  let total = 0;
  await info.raw.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':  total = event.data.contentLength ?? 0; break;
      case 'Progress': downloaded += event.data.chunkLength; onProgress?.(downloaded, total); break;
    }
  });
  // 装完插件自动 process::exit；前端走不到这里
}
```

### 5.2 UpdateBanner 组件

`src/components/UpdateBanner.tsx`（新增）：

- 启动后 5s 调 `checkForUpdate()`
- 检测 `localStorage['lv:skip-update-version']`，等于新版号则不显示
- 横幅 JSX：固定在 header 之下 / FilterBar 之上
- 三种状态：idle（隐藏）/ available（横幅）/ downloading（进度条）

```tsx
const [info, setInfo] = useState<UpdateInfo | null>(null);
const [progress, setProgress] = useState<{ d: number; t: number } | null>(null);

useEffect(() => {
  const t = setTimeout(async () => {
    try {
      const u = await checkForUpdate();
      if (!u) return;
      if (localStorage.getItem('lv:skip-update-version') === u.version) return;
      setInfo(u);
    } catch { /* 静默：离线 / 网络受限不打扰 */ }
  }, 5000);
  return () => clearTimeout(t);
}, []);

// 横幅 JSX：[看 changelog] [现在更新] [稍后] [跳过此版]
// "稍后" → setInfo(null)（下次启动还会出）
// "跳过此版" → localStorage.setItem('lv:skip-update-version', info.version) + setInfo(null)
```

### 5.3 SettingsDialog 加 "关于" tab

新增 tab `'about'`。内容：

```
Lumen — 日志查看与分析
当前版本：v{__APP_VERSION__}
构建时间：{__BUILD_TIME__}
Commit:   {__BUILD_COMMIT__}

[检查更新]    ← 点击立刻 check
✅ 已是最新版本 / 🎉 v0.x.x 可用 → [看详情]

源码：https://github.com/y-xin/lumen-log-viewer  ← 点击系统浏览器打开
License：MIT
```

**手动检查不受 `skip-update-version` 影响** —— 即便用户跳过过，手动点也会显示完整信息（这是用户主动行为，应当尊重）。

### 5.4 Remote SSH 入口 platform gate

加 `src/lib/platform.ts`：

```ts
import { platform as tauriPlatform } from '@tauri-apps/plugin-os';

let cached: string | null = null;

export async function getPlatform(): Promise<'macos' | 'windows' | 'linux' | string> {
  if (cached) return cached;
  cached = await tauriPlatform();
  return cached;
}

export async function isSshSupported(): Promise<boolean> {
  return (await getPlatform()) !== 'windows';
}
```

依赖：`@tauri-apps/plugin-os` + 后端 `tauri-plugin-os`。

**改动**：
- `OpenFileMenu.tsx` mount 时调 `isSshSupported()` → state；为 false 时隐藏 "🌐 打开远程文件…" 项
- `SettingsDialog.tsx` tab 列表：Windows 隐藏 "远程" tab
- README "已知限制" 章节明示"Windows 上 Remote SSH 不可用"

### 5.5 Build 元数据注入

`vite.config.ts`：

```ts
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const commit = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'unknown'; }
})();

export default defineConfig({
  // ...
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_COMMIT__: JSON.stringify(commit),
  },
});
```

`src/vite-env.d.ts` 加：

```ts
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_COMMIT__: string;
```

## 6. GitHub Actions 自动 build + release

### 6.1 Workflow

`.github/workflows/release.yml`（新增）：

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
          echo "notes<<EOF" >> $GITHUB_OUTPUT
          echo "$NOTES" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

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
        with: { node-version: '20' }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: ${{ matrix.target }} }

      # Windows 不签 — SmartScreen 接受首次警告（用户走 More info → Run anyway）
      # macOS 走 self-signed cert 临时 keychain
      - if: startsWith(matrix.os, 'macos')
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

### 6.2 GitHub Secrets（一次性 setup）

| Secret | 来源 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `cat ~/.tauri/lumen.key` 内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成 key 时设的密码（可为空字符串） |
| `APPLE_CERTIFICATE` | self-signed cert `.p12` → `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 .p12 时设的密码 |
| `APPLE_SIGNING_IDENTITY` | cert 的 common name（如 `Lumen Self-Signed`） |

仓库 Settings → Actions → General → Workflow permissions: **Read and write permissions**（让 tauri-action 能创建 release）。

### 6.3 Self-signed cert 本地生成步骤

1. **Keychain Access** → 钥匙串访问 → 证书助理 → 创建证书…
   - Name: `Lumen Self-Signed`
   - Identity Type: `Self Signed Root`
   - Certificate Type: `Code Signing`
2. 在 keychain 里右键导出 → Personal Information Exchange (.p12) → 设密码（建议 ≥ 12 字符）
3. 终端：`base64 -i cert.p12 | pbcopy` → 粘到 GitHub Secret `APPLE_CERTIFICATE`

## 7. CHANGELOG / SECURITY

### 7.1 CHANGELOG.md（新建）

Keep-a-changelog 格式：

```markdown
# Changelog

## [Unreleased]

## [0.3.0] - 2026-05-25
### Added
- 多窗口支持
- 远程日志 (SSH tail)
- App 自动升级检测

### Security
- known_hosts 输入校验
- TOFU 流程接通

### Fixed
- dark 模式视觉一致性

## [0.1.0] - 2026-05-22
- 首个内部版本
```

每次发版前手动把 `## [Unreleased]` 改名为 `## [x.y.z] - YYYY-MM-DD`，并新建空白 `## [Unreleased]`。

### 7.2 SECURITY.md（新建）

```markdown
# Security

## 报告漏洞

发邮件到 `<your-email>@example.com`（实施时把它替换为维护者邮箱；如有 PGP 公钥可在此公布）。

## Updater 密钥管理

Lumen 自动升级用 ed25519 签名做完整性校验：
- 公钥嵌在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- 私钥保存在维护者 `~/.tauri/lumen.key` + GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`
- **私钥泄露时**：立即重新 `tauri signer generate`，rotate pubkey 到新版 tauri.conf.json，旧版 release 自然过期（旧公钥不再验签新 release）

## macOS Codesigning

Lumen 用 self-signed cert，不经 Apple Notary 公证 → 用户首次安装需右键打开。
未来如有 Apple Developer 账号将切换为 Developer ID + notarization，不影响 ed25519 updater 校验。
```

## 8. 风险与取舍

| 风险 | 评估 | 处理 |
|---|---|---|
| ed25519 私钥泄露 | 中 | SECURITY.md 警示 + 泄露后 rotate pubkey + 弃旧 release |
| self-signed cert 过期 / rotate | 中 | cert 改 → updater 链断 → 用户需手动重装一次；CHANGELOG 沟通 |
| 用户停留极老版本 | 低 | prefs migration 已有兜底（multi-window v1 建立机制） |
| GitHub Release 流量 / 大小 | 低 | 每个 .dmg ~5MB，公开 repo 流量免费 |
| Windows SmartScreen 拦截首次启动 | 中 | README "下载安装" Windows 节明示"More info → Run anyway"步骤；updater 后续 atomic replace 不再触发警告 |
| Windows 上 Remote SSH 入口必须隐藏 | 中 | 前端 `@tauri-apps/plugin-os` 拿 platform，OpenFileMenu / Settings "远程" tab 在 `platform === 'windows'` 时隐藏；漏掉会暴露不能用的入口 |
| Windows tauri build 首次跑通 | 中 | tauri-action 已支持 windows-latest runner，但首发时人工监督 CI；失败回退仅 macOS |
| 离线启动报 error | 低 | UpdateBanner catch silently，不弹 toast |
| 跳过版本后用户想再看 | 低 | Settings 手动检查不受 skip-version 影响 |
| `latest.json` URL 经 CDN 缓存 | 低 | GitHub Release `download/latest/*` 是直链不缓存 |

## 9. 测试

### 9.1 单元测试

- updater 集成无单测可写（plugin 内部 Tauri 自测）
- 前端 vitest 加 1-2 个测试：UpdateBanner 状态机
  - `localStorage['lv:skip-update-version']` 命中时不显示横幅
  - "稍后" → setInfo(null)，下次 mount 重弹

### 9.2 手动验收清单

- [ ] macOS：装个 v0.2.0 假版本 → 改 tauri.conf.json version 强制低一档 → 启动应 5s 后弹横幅
- [ ] 点"跳过此版" → 关闭横幅 → 重启 → 不再提示
- [ ] Settings → 关于 → [检查更新] 即便跳过过也显示
- [ ] 装更新成功后 → 应用自动重启 → 版本号刷新到新版
- [ ] 模拟离线（关 wifi）→ 启动不应有 error toast
- [ ] CI 跑通整个 workflow → 下载 release .dmg → 装 → 验证 .app 能跑
- [ ] **Windows**：下载 .msi → SmartScreen 警告 → More info → Run anyway → 装成功
- [ ] **Windows**：OpenFileMenu 无"🌐 打开远程文件…"项
- [ ] **Windows**：Settings 无"远程"tab

### 9.3 CI 验证

- 第一次 push v0.3.0 tag 时人工监督整个 workflow 跑完
- 验证 latest.json 内容正确（version / platforms 三平台齐全 / signature 非空）

## 10. 一次性 setup 清单

### 10.1 本地

- [ ] `git remote add origin git@github.com:y-xin/lumen-log-viewer.git`
- [ ] `git push -u origin main`
- [ ] `npm exec @tauri-apps/cli signer generate -w ~/.tauri/lumen.key`
- [ ] 把公钥（`cat ~/.tauri/lumen.key.pub`）填进 `src-tauri/tauri.conf.json` `plugins.updater.pubkey`
- [ ] `git commit -m "feat(updater): bake in updater pubkey"`
- [ ] Keychain Access 创建 self-signed cert "Lumen Self-Signed"
- [ ] 导出 .p12 + `base64 -i cert.p12`

### 10.2 GitHub repo

- [ ] Settings → Secrets → 添加 5 个 secret（见 §6.2 表格）
- [ ] Settings → Actions → General → Workflow permissions: Read and write

### 10.3 首发版（验证整个 pipeline）

- [ ] 写好 `CHANGELOG.md` `## [0.3.0]` section
- [ ] `./scripts/bump-version.sh 0.3.0`
- [ ] `git push && git push --tags`
- [ ] 观察 Actions tab 跑完（约 10-15 分钟）
- [ ] 下载 release .dmg → 装 → 验证 .app 能跑
- [ ] 旧版（手动 build 留一份 v0.2.0 .app）启动 → 应提示 v0.3.0 可用 → 点更新 → 装成功

## 11. 文档改动

- `README.md` 新增章节：
  - "下载安装"：链 GitHub Releases；**macOS** 首次右键打开 + xattr quarantine 说明；**Windows** SmartScreen "More info → Run anyway" 步骤
  - "Updater"：自动检查 / 手动检查 / 跳过版本说明
  - "已知平台限制"：Windows 上 Remote SSH 不可用、Linux 暂无 build
  - "发布流程"（开发者）：bump-version + push tag
- `CHANGELOG.md`（新建）
- `SECURITY.md`（新建）

## 12. 文件结构

```
.github/workflows/
└── release.yml                       (新：CI build + release)

scripts/
└── bump-version.sh                   (新：版本号 bump + tag)

src-tauri/
├── Cargo.toml                        (改：加 tauri-plugin-updater dep)
├── tauri.conf.json                   (改：updater plugin + pubkey)
├── capabilities/default.json         (改：updater ACL)
└── src/lib.rs                        (改：注册 updater plugin)

src/
├── App.tsx                           (改：渲染 UpdateBanner)
├── api/updater.ts                    (新：checkForUpdate / installUpdate)
├── lib/platform.ts                   (新：getPlatform / isSshSupported helper)
├── components/
│   ├── UpdateBanner.tsx              (新)
│   ├── OpenFileMenu.tsx              (改：Windows 隐藏「打开远程文件」项)
│   └── SettingsDialog.tsx            (改：加 about tab + Windows 隐藏 "远程" tab)
└── vite-env.d.ts                     (改：declare __APP_VERSION__ 等)

vite.config.ts                        (改：define __APP_VERSION__/__BUILD_TIME__/__BUILD_COMMIT__)
package.json                          (改：加 @tauri-apps/plugin-updater dep)

CHANGELOG.md                          (新)
SECURITY.md                           (新)
README.md                             (改：3 个新章节)
```
