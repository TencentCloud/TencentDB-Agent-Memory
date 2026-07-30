#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/../../.." && pwd)"
openclaw_version="${OPENCLAW_BENCH_VERSION:-2026.5.28}"
run_root="${PROMPT_CACHE_BENCH_RESULT_DIR:-${repository_root}/benchmark-runs/issue-120}"
openclaw_env_dir="${run_root}/env/openclaw-${openclaw_version}"
openclaw_instance_dir="${run_root}/instances/openclaw-${openclaw_version}-current-source"
openclaw_home_dir="${openclaw_instance_dir}/home"
openclaw_state_dir="${openclaw_instance_dir}/state"
openclaw_config_path="${openclaw_state_dir}/openclaw.json"
openclaw_bin="${openclaw_env_dir}/node_modules/.bin/openclaw"

run_openclaw() {
  env \
    OPENCLAW_HOME="${openclaw_home_dir}" \
    OPENCLAW_STATE_DIR="${openclaw_state_dir}" \
    OPENCLAW_CONFIG_PATH="${openclaw_config_path}" \
    "${openclaw_bin}" "$@"
}

mkdir -p "${openclaw_env_dir}" "${openclaw_home_dir}" "${openclaw_state_dir}"

npm install \
  --prefix "${openclaw_env_dir}" \
  --no-save \
  --omit=optional \
  "openclaw@${openclaw_version}"

(
  cd "${repository_root}"
  npm run build
)

run_openclaw --version
run_openclaw plugins install --link "${repository_root}"
run_openclaw plugins inspect memory-tencentdb
run_openclaw plugins doctor

echo "OpenClaw environment: ${openclaw_env_dir}"
echo "OpenClaw isolated home: ${openclaw_home_dir}"
echo "OpenClaw isolated state: ${openclaw_state_dir}"
