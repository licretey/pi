#!/usr/bin/env bash
#
# 将会话从 ~/.pi/agent/*.jsonl 迁移到对应的会话目录。
# 此脚本用于修复 v0.30.0 中的缺陷：当时会话被保存到 ~/.pi/agent/，
# 而不是 ~/.pi/agent/sessions/<encoded-cwd>/。
#
# 用法：./migrate-sessions.sh [--dry-run]
#

set -e

AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
DRY_RUN=false

if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "试运行模式：不会移动任何文件"
    echo
fi

# 查找 agent 目录直属的所有 .jsonl 文件（不包括子目录中的文件）。
shopt -s nullglob
files=("$AGENT_DIR"/*.jsonl)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
    echo "No session files found in $AGENT_DIR"
    exit 0
fi

echo "Found ${#files[@]} session file(s) to migrate"
echo

migrated=0
failed=0

for file in "${files[@]}"; do
    filename=$(basename "$file")
    
    # 读取首行，并使用 jq 提取 cwd。
    if ! first_line=$(head -1 "$file" 2>/dev/null); then
        echo "SKIP: $filename - cannot read file"
        ((failed++))
        continue
    fi
    
    # 解析 JSON 并提取 cwd。
    if ! cwd=$(echo "$first_line" | jq -r '.cwd // empty' 2>/dev/null); then
        echo "SKIP: $filename - invalid JSON"
        ((failed++))
        continue
    fi
    
    if [[ -z "$cwd" ]]; then
        echo "SKIP: $filename - no cwd in session header"
        ((failed++))
        continue
    fi
    
    # 编码 cwd：移除开头的斜杠，将斜杠替换为连字符，并在两侧加上 --。
    encoded=$(echo "$cwd" | sed 's|^/||' | sed 's|[/:\\]|-|g')
    encoded="--${encoded}--"
    
    target_dir="$AGENT_DIR/sessions/$encoded"
    target_file="$target_dir/$filename"
    
    if [[ -e "$target_file" ]]; then
        echo "SKIP: $filename - target already exists"
        ((failed++))
        continue
    fi
    
    echo "MIGRATE: $filename"
    echo "    cwd: $cwd"
    echo "    to:  $target_dir/"
    
    if [[ "$DRY_RUN" == false ]]; then
        mkdir -p "$target_dir"
        mv "$file" "$target_file"
    fi
    
    ((migrated++))
    echo
done

echo "---"
echo "Migrated: $migrated"
echo "Skipped:  $failed"

if [[ "$DRY_RUN" == true && $migrated -gt 0 ]]; then
    echo
    echo "如需执行迁移，请去掉 --dry-run 参数后重新运行。"
fi
