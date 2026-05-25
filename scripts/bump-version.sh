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
