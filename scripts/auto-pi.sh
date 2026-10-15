#!/usr/bin/env bash
set -euo pipefail

# 开发辅助包装脚本：运行此检出版本最近一次 `npm run build` 生成的 pi。
# 默认以 PI_EXPERIMENTAL=1 启动开发版本。传入 --stable 可使用 PATH 中下一个 pi 可执行文件；
# `pi update` 也会使用稳定版本，以便自更新正常工作。
#
# 在仓库根目录运行以下命令进行安装：
#   mkdir -p "$HOME/.local/bin"
#   ln -s "$PWD/scripts/auto-pi.sh" "$HOME/.local/bin/pi"
#
# PATH 中 ~/.local/bin 的位置必须先于稳定版 pi 的安装目录。

# 沿符号链接解析此脚本，使 repo_dir 指向开发检出目录，
# 而不是包含 `pi` 符号链接的目录。
script_path="${BASH_SOURCE[0]}"
while [[ -L "$script_path" ]]; do
	script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
	link_target="$(readlink "$script_path")"
	if [[ "$link_target" == /* ]]; then
		script_path="$link_target"
	else
		script_path="$script_dir/$link_target"
	fi
done
script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

find_stable_pi() {
	local path_entry candidate candidate_dir
	local -a path_entries
	IFS=: read -r -a path_entries <<< "${PATH:-}"
	for path_entry in "${path_entries[@]}"; do
		[[ -n "$path_entry" ]] || path_entry=.
		candidate="$path_entry/pi"
		[[ -x "$candidate" && ! -d "$candidate" ]] || continue
		[[ "$candidate" -ef "$script_path" ]] && continue
		candidate_dir="$(cd -P "$(dirname "$candidate")" && pwd)" || continue
		printf '%s/%s\n' "$candidate_dir" "$(basename "$candidate")"
		return 0
	done
	return 1
}

use_stable=false
args=()
for arg in "$@"; do
	if [[ "$arg" == "--stable" ]]; then
		use_stable=true
	else
		args+=("$arg")
	fi
done

if [[ "${args[0]:-}" == "update" ]]; then
	use_stable=true
fi

if [[ "$use_stable" == true ]]; then
	if ! stable_pi="$(find_stable_pi)"; then
		echo "error: could not find a stable pi executable after the auto-pi wrapper on PATH" >&2
		exit 1
	fi
	exec "$stable_pi" ${args[@]+"${args[@]}"}
fi

dev_pi="$repo_dir/packages/coding-agent/dist/bundle/cli.js"
if [[ ! -x "$dev_pi" ]]; then
	echo "error: development pi build not found; run \`npm run build\` in $repo_dir" >&2
	exit 1
fi

export PI_EXPERIMENTAL="${PI_EXPERIMENTAL:-1}"
exec "$dev_pi" ${args[@]+"${args[@]}"}
