#!/usr/bin/env bash
# 启动 issue 分诊服务器。环境变量说明见 README.md。
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node --conditions=source --import ./scripts/issues/register.mjs scripts/issues/main.ts
