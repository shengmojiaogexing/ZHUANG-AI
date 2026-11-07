#!/usr/bin/env bash
# 幻梦圆环 · macOS 版打包脚本
#
#   用法：在 Mac 上进入本目录（Package.swift 所在目录），执行
#       bash scripts/build-app.sh
#   产物：dist/HuanmengRing.app（已 ad-hoc 签名，可直接双击运行）
#
# 依赖：Xcode Command Line Tools（xcode-select --install 装过就行）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="HuanmengRing"
DIST_DIR="$ROOT/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"

echo "==> 编译（swift build -c release）"
swift build -c release

BIN_DIR="$(swift build -c release --show-bin-path)"
BIN_PATH="$BIN_DIR/$APP_NAME"
if [ ! -f "$BIN_PATH" ]; then
    echo "!! 找不到编译产物：$BIN_PATH" >&2
    exit 1
fi

echo "==> 组装 $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

cp "$BIN_PATH" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
cp "$ROOT/Resources/Info.plist" "$APP_BUNDLE/Contents/Info.plist"
cp "$ROOT/Resources/presets.json" "$APP_BUNDLE/Contents/Resources/presets.json"
if [ -f "$ROOT/Resources/AppIcon.icns" ]; then
    cp "$ROOT/Resources/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
fi
printf 'APPL????' > "$APP_BUNDLE/Contents/PkgInfo"

# Apple Silicon 上未签名的二进制会被系统直接杀掉，这里统一 ad-hoc 签名。
# 注意：每次重新编译后签名变化，系统「辅助功能」里的授权需要重新勾一次。
echo "==> ad-hoc 签名"
codesign --force --deep --sign - "$APP_BUNDLE"

echo ""
echo "完成：$APP_BUNDLE"
echo "运行：open \"$APP_BUNDLE\"            # 静默常驻菜单栏"
echo "      open \"$APP_BUNDLE\" --args --show   # 启动后直接唤出圆环"
echo ""
echo "首次使用：菜单栏图标 → 「⚠️ 点这里授予辅助功能权限」再打开开关，⌥+右键才能用；"
echo "快捷键 ⌥⌘R 不需要任何系统权限。"
