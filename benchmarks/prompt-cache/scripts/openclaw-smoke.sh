#!/usr/bin/env bash
set -euo pipefail

expected_version="2026.5.28"
openclaw_home_dir="${OPENCLAW_HOME:-/state/home}"
openclaw_state_dir="${OPENCLAW_STATE_DIR:-/state/runtime}"
openclaw_config_path="${OPENCLAW_CONFIG_PATH:-${openclaw_state_dir}/openclaw.json}"

export OPENCLAW_HOME="${openclaw_home_dir}"
export OPENCLAW_STATE_DIR="${openclaw_state_dir}"
export OPENCLAW_CONFIG_PATH="${openclaw_config_path}"

mkdir -p "${openclaw_home_dir}" "${openclaw_state_dir}"

actual_version="$(openclaw --version)"
echo "openclaw_version=${actual_version}"

if [[ "${actual_version}" != *"${expected_version}"* ]]; then
  echo "expected OpenClaw ${expected_version}" >&2
  exit 1
fi

openclaw plugins install --link /opt/memory-tencentdb
openclaw plugins inspect memory-tencentdb --json

if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
  openclaw onboard \
    --non-interactive \
    --mode local \
    --auth-choice deepseek-api-key \
    --deepseek-api-key "${DEEPSEEK_API_KEY}" \
    --skip-health \
    --accept-risk
  openclaw models list --provider deepseek
  echo "deepseek_provider_setup=passed"
else
  echo "deepseek_provider_setup=skipped_missing_key"
fi

echo "openclaw_plugin_smoke=passed"
