#!/usr/bin/env bash
set -euo pipefail

# 将各软件包源码目录中的相对导入路径后缀从 .js 改为 .ts。
# TypeScript 的 rewriteRelativeImportExtensions 选项会在生成输出时将后缀改回 .js。
find packages -mindepth 2 -maxdepth 2 -type d -name src -print0 |
	while IFS= read -r -d '' src_dir; do
		find "$src_dir" -type f -name '*.ts' -print0
	done |
	xargs -0 perl -0pi -e 's/(\b(?:from|import)\b\s*\(?\s*["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27]\s*\)?)/$1$2.ts$3/g; s/(\bdeclare\s+module\s+["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27])/$1$2.ts$3/g; s/(\bimportNodeOnlyProvider\(\s*["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27]\s*\))/$1$2.ts$3/g'
