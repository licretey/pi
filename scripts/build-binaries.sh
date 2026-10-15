#!/usr/bin/env bash
#
# 在本地为所有平台构建 pi 可执行文件。
# 此脚本与 .github/workflows/build-binaries.yml 的流程一致。
#
# 用法：
#   ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# 选项：
#   --skip-install       跳过 npm ci
#   --skip-build         跳过软件包构建
#   --offline-model-data 使用内置模型数据构建，不在线刷新
#   --platform <name>    仅构建指定平台（darwin-arm64、darwin-x64、linux-x64、linux-arm64、windows-x64、windows-arm64）
#   --out <dir>          输出目录（默认为 packages/coding-agent/binaries）
#
# 输出文件：
#   packages/coding-agent/binaries/
#     pi-darwin-arm64.tar.gz
#     pi-darwin-x64.tar.gz
#     pi-linux-x64.tar.gz
#     pi-linux-arm64.tar.gz
#     pi-windows-x64.zip
#     pi-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# 如果指定了平台，则验证其名称。
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        npm run build:offline
    else
        echo "==> Building all packages..."
        npm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
cd packages/coding-agent

# 清理之前的构建产物。
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# 确定要构建的平台。
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # 只有将 worker 脚本作为显式构建入口传入时，Bun 才会把它们嵌入编译后的可执行文件。
    # Bun 会按照这些入口共同目录的相对路径放置脚本，因此主入口必须保留在 dist/ 中，
    # 运行时才能正确解析 worker 的路径。
    #
    # 禁用从当前工作目录自动加载 bunfig.toml，避免项目预加载脚本在 pi 启动前导致独立可执行文件崩溃（见 #7684）。
    # 同时禁用从当前工作目录自动加载 .env，避免项目环境变量泄漏到 pi 的运行环境中（见 #10473）。
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$OUTPUT_DIR/$platform/pi.exe"
    else
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$OUTPUT_DIR/$platform/pi"
    fi
done

echo "==> Creating release archives..."

# 将共用文件复制到各平台目录。
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"

    # 将所选架构的原生平台辅助文件复制到可执行文件旁边。
    native_platform="${platform/windows-/win32-}"
    native_path="native/${native_platform%-*}/prebuilds"
    mkdir -p "$OUTPUT_DIR/$platform/$native_path"
    cp -R "../tui/$native_path/$native_platform" "$OUTPUT_DIR/$platform/$native_path/"
done

# 创建归档文件。
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows 平台使用 zip 格式。
        echo "Creating pi-$platform.zip..."
        (cd "$platform" && zip -r ../pi-$platform.zip .)
    else
        # Unix 平台使用 tar.gz 格式，并添加包装目录以兼容 mise。
        echo "Creating pi-$platform.tar.gz..."
        mv "$platform" pi && tar -czf pi-$platform.tar.gz pi && mv pi "$platform"
    fi
done

# 解压归档文件，便于在本地测试。
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../pi-$platform.zip)
    else
        tar -xzf pi-$platform.tar.gz && mv pi "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/pi.exe"
    else
        echo "  $OUTPUT_DIR/$platform/pi"
    fi
done
