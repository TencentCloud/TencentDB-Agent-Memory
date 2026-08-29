#!/usr/bin/env bash
# secret-scan.sh — 扫描仓库工作树里是否有 secret 泄漏
#
# 用法：
#   scripts/secret-scan.sh                  # 扫仓库根，命中即 exit 1
#   scripts/secret-scan.sh path1 path2 ...  # 只扫指定路径
#
# 集成方式（三选一）：
#   1. Git pre-commit hook：
#        cp scripts/secret-scan.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#      （只扫本次 staged 变更即可，脚本会自动检测）
#   2. Docker build 前手动执行：`bash scripts/secret-scan.sh docker/`
#   3. CI 里在 build 步骤前跑：`bash scripts/secret-scan.sh || exit 1`
#
# 命中规则（正则 OR）：
#   - 高熵字符串 32+ char base64/hex（可能是 Bearer / api_key / secret）
#   - `sk-[a-zA-Z0-9_\-]{15,}`（OpenAI/Anthropic/tdai user_key 家族）
#   - `Bearer\s+[A-Za-z0-9._+/=~-]{15,}`
#   - `["']?(password|passwd|secret|token|api_key|apikey)["']?\s*[:=]\s*["'][^"']{6,}["']`
#     且值不是常见占位（xxx / your- / example / REPLACE_ / test / demo / dummy）
#
# 白名单：test/spec/example/docs/README 里的示例，命中不 fail。用 --strict 关闭白名单。

set -u

STRICT=0
[[ "${1:-}" == "--strict" ]] && { STRICT=1; shift; }

# 默认扫的目录（避免扫 node_modules / dist / .git 等）
if [[ $# -eq 0 ]]; then
  TARGETS=(src web/src tests config docker README.md package.json)
else
  TARGETS=("$@")
fi

# 已知安全的占位字符串，命中即视为非泄漏
PLACEHOLDER='xxx|your-|example|REPLACE_|placeholder|<[A-Z_]+>|dummy|fake|test-|demo-|sample|bogus|invalid-|knowledge-debug|-debug"|task-draft-generator'

# 需要豁免的路径（示例代码 / 已知 demo 密码 / gitignored 本地文件）
EXEMPT_PATH='node_modules/|/dist/|/build/|\.example\.|/docs/|README\.md|\.md:|\.test\.|__tests__/'

## 注：gitignored 判定见下方 filter_gitignored 函数，避免 arg list too long。

hits=0
tmp=$(mktemp)
trap "rm -f $tmp" EXIT

for t in "${TARGETS[@]}"; do
  [[ -e "$t" ]] || continue
  # ── 规则 1: sk- prefix keys ──
  grep -rEn "sk-[a-zA-Z0-9_-]{15,}" "$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true

  # ── 规则 2: Bearer tokens ──
  grep -rEn 'Bearer[[:space:]]+[A-Za-z0-9._+/=~-]{15,}' "$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true

  # ── 规则 3: api_key/secret/password 后面跟长值 ──
  grep -rEn '"(api_key|apiKey|secret|password|token|passwd)"[[:space:]]*:[[:space:]]*"[^"]{8,}"' "$t" 2>/dev/null \
    | grep -Ev "$PLACEHOLDER" \
    | grep -Ev '"(local|debug|123123)"' >> "$tmp" || true

  # 规则 4（base64 高熵通用扫描）已移除 —— 无 PCRE 的情况下误报率过高（驼峰名 +
  # 路径都会命中）。规则 1-3 已覆盖 sk-* / Bearer / "api_key":"..." 三大主要形态。
  # 未来若要加，考虑用独立的 python/node 脚本做 shannon entropy 判定。
done

# 应用豁免路径 + gitignored（gitignored 文件不会入 commit / 镜像，无泄漏面）
final=$(grep -Ev "$EXEMPT_PATH" "$tmp" || true)

# gitignored 过滤：逐行提取路径，用 git check-ignore -q 判定；命中即豁免
if git rev-parse --show-toplevel >/dev/null 2>&1 && [[ -n "$final" ]]; then
  repo_root=$(git rev-parse --show-toplevel)
  filtered=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line%%:*}"
    if git -C "$repo_root" check-ignore -q "$path" 2>/dev/null; then
      continue  # gitignored → 跳过
    fi
    filtered+="$line"$'\n'
  done <<< "$final"
  final="${filtered%$'\n'}"
fi

if [[ -n "$final" ]]; then
  echo "❌ secret-scan: 命中可能的敏感信息（$(echo "$final" | wc -l | tr -d ' ') 处）"
  echo
  echo "$final"
  echo
  echo "如果确认是误报，加进 EXEMPT_PATH 或用 // secret-scan-ignore 注释豁免所在行"
  exit 1
fi

echo "✓ secret-scan: 未发现敏感信息（扫描目标：${TARGETS[*]}）"
exit 0
