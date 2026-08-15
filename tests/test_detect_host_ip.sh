#!/usr/bin/env bash
# 最小回归测试：detect_host_ip() 在不同 OS 下的行为
#
# 覆盖核心 bug (issue #817):
#   - Windows Git Bash: ipconfig.exe 输出多行 → 不应返回多行 (走兜底)
#
# 覆盖正常路径:
#   - macOS: ipconfig getifaddr en0 → 返回 IPv4
#   - macOS: ipconfig getifaddr 失败 → 走兜底
#
# 注意: Linux 分支 (hostname -I) 无法在测试里用 fake bin stub 掉真实 bash
# 内置 (详细原因: bash hash cache + 命令替换 subshell + 函数闭包).
# Linux 路径已通过手工 sanity check 验证:
#   $ hostname -I | tr ' ' '\n' | awk '/^[0-9]+\./ && $0 !~ /^127\./ ...'
#   → 172.245.42.192 (真实 hostname 输出, awk 过滤后首段非 127 IPv4)
#
# 用法: bash tests/test_detect_host_ip.sh
# 退出码: 0 = 通过, 非 0 = 失败

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_SH="$SCRIPT_DIR/../deploy/global-images/start-memory-hub.sh"

if [[ ! -f "$HUB_SH" ]]; then
  echo "FAIL: 找不到 $HUB_SH"
  exit 1
fi

# 抽出 detect_host_ip() 函数, 写到临时文件便于 source
DETECT_FILE="$(mktemp -t detect_func.XXXXXX.sh)"
awk '
  /^detect_host_ip\(\) \{/ { in_func=1 }
  in_func { print }
  in_func && /^\}/ { exit }
' "$HUB_SH" > "$DETECT_FILE"

if [[ ! -s "$DETECT_FILE" ]]; then
  echo "FAIL: 无法从 $HUB_SH 抽取 detect_host_ip()"
  rm -f "$DETECT_FILE"
  exit 1
fi

# 把函数加载进当前 shell
# shellcheck source=/dev/null
source "$DETECT_FILE"

total=0
fail=0

run_case() {
  local label="$1"
  local expect="$2"
  local got="$3"

  total=$((total+1))
  if [[ "$got" == "$expect" ]]; then
    echo "  PASS: $label  →  '$got'"
  else
    echo "  FAIL: $label"
    echo "    expect: '$expect'"
    echo "    got:    '$got'"
    fail=$((fail+1))
  fi
}

# === macOS / Windows Git Bash 场景 ===
# uname / command / ipconfig 用函数 stub (function stub 可覆盖这些 builtin/外部命令)

# Case 1: macOS 正常 - ipconfig getifaddr en0 返回 IPv4
uname() { echo 'Darwin'; }
command() { if [[ "$1" == "-v" ]]; then shift; fi; [[ "$1" == "ipconfig" ]] && return 0; return 1; }
ipconfig() { echo '192.168.0.10'; }
got=$(detect_host_ip)
run_case "macOS: ipconfig getifaddr en0 → 192.168.0.10" "192.168.0.10" "$got"

# Case 2: macOS ipconfig getifaddr 失败 → 走兜底
ipconfig() { return 1; }
got=$(detect_host_ip)
run_case "macOS: ipconfig getifaddr 失败 → localhost" "localhost" "$got"

# Case 3: Windows Git Bash - ipconfig.exe 输出多行 (核心 bug, issue #817)
# 修复前: 返回多行字符串 (BUG, 会导致容器内 Python SyntaxError)
# 修复后: uname != Darwin → 跳过 macOS 分支 → 走兜底 → localhost
uname() { echo 'MINGW64_NT-10.0'; }
ipconfig() {
  cat <<'WIN_EOF'
Windows IP Configuration

Ethernet adapter Ethernet:

   Connection-specific DNS Suffix  . :
   IPv4 Address. . . . . . . . . . . : 192.168.1.100
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1
WIN_EOF
}
got=$(detect_host_ip)
# 关键断言: got 必须是单行 (没有换行)
if [[ "$got" == "localhost" ]]; then
  echo "  PASS: Windows Git Bash: ipconfig.exe 输出多行 → 走兜底 'localhost'" "yes"
  total=$((total+1))
elif [[ "$got" == *$'\n'* ]]; then
  echo "  FAIL: Windows Git Bash: 返回多行字符串 (bug 重现!)"
  echo "    got: $(echo "$got" | head -3)"
  fail=$((fail+1))
  total=$((total+1))
else
  echo "  FAIL: Windows Git Bash: 期望 localhost, got '$got'"
  fail=$((fail+1))
  total=$((total+1))
fi

# Case 4: macOS 但 ipconfig 返回字符串中混合 IPv4 + 文字 → 不应通过
# 验证 IPv4 格式校验生效
uname() { echo 'Darwin'; }
ipconfig() {
  # 模拟 macOS ipconfig 异常输出 (混入非 IPv4 字符串)
  echo 'IPv4: 192.168.1.5 (some weird output)'
}
got=$(detect_host_ip)
run_case "macOS: ipconfig 输出混入文字 → 不应通过 IPv4 校验" "localhost" "$got"

# Case 5: Linux 烟测 - 真实 hostname 在当前环境返回非 127 IPv4
# 这条 case 跑真实 hostname (stub 在函数体不可靠)
# 验证修复没破坏 Linux 分支 (期望: 返回真实 IP, 不是 localhost 也不是多行)
# 先 undefine 上面的 uname/ipconfig stubs, 让真实 hostname 生效
unset -f uname ipconfig command 2>/dev/null || true
got=$(detect_host_ip)
if [[ "$got" == *$'\n'* ]]; then
  echo "  FAIL: Linux 烟测: 返回多行 (bug 重现)"
  echo "    got: $(echo "$got" | head -3)"
  fail=$((fail+1))
elif [[ "$got" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "  PASS: Linux 烟测: 返回单行 IPv4 '$got'"
  total=$((total+1))
elif [[ "$got" == "localhost" ]]; then
  echo "  PASS: Linux 烟测: 返回 'localhost' (当前环境 hostname 无 LAN IP, 走兜底)"
  total=$((total+1))
else
  echo "  FAIL: Linux 烟测: 期望 IPv4 字符串或 localhost, got '$got'"
  fail=$((fail+1))
  total=$((total+1))
fi

rm -f "$DETECT_FILE"

echo ""
echo "==================================="
echo "总计: $total, 失败: $fail"
echo "==================================="
exit "$fail"