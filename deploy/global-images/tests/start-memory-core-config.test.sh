#!/usr/bin/env bash
# Regression for the memory-core gateway config lifecycle (issue #992).
# Runs deploy/global-images/start-memory-core.sh with docker and the
# network stubbed. Does not start containers.
#
#   bash deploy/global-images/tests/start-memory-core-config.test.sh
#
# Bash 3.2 compatible (macOS /bin/bash): no associative arrays, no
# ${var,,}, empty arrays expanded with ${arr[@]+"${arr[@]}"}.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CORE_SCRIPT="${REPO_DIR}/deploy/global-images/start-memory-core.sh"
ORIG_PATH="${PATH}"

fail() {
  echo "FAIL: $*" >&2
  if [[ -n "${WORKDIR:-}" ]]; then
    echo "----- script output -----" >&2
    cat "${WORKDIR}/out.txt" >&2 2>/dev/null || true
    echo "----- docker log -----" >&2
    cat "${WORKDIR}/docker.log" >&2 2>/dev/null || true
  fi
  exit 1
}

WORKDIR="$(mktemp -d)"
cleanup() {
  if [[ -n "${WORKDIR:-}" && -d "${WORKDIR}" ]]; then
    chmod -R u+rwx "${WORKDIR}" 2>/dev/null || true
    rm -rf "${WORKDIR}"
  fi
}
trap cleanup EXIT

STUB_BIN="${WORKDIR}/bin"
mkdir -p "${STUB_BIN}" "${WORKDIR}/home"

# Absolute /usr/bin/curl cannot be PATH-stubbed. Success-path runs enter a
# user namespace and bind-mount this script over it so init-admin does not
# abort the real launcher (set -e + curl -o file missing on ECONNREFUSED).
cat > "${STUB_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
set -eu
outfile=""
prev=""
for arg in "$@"; do
  if [[ "${prev}" == "-o" ]]; then
    outfile="${arg}"
  fi
  prev="${arg}"
done
if [[ -n "${outfile}" && "${outfile}" != "/dev/null" ]]; then
  printf '{}\n' > "${outfile}"
fi
printf '200'
exit 0
STUB
chmod +x "${STUB_BIN}/curl"

cat > "${STUB_BIN}/docker" <<'STUB'
#!/usr/bin/env bash
set -eu
log="${DOCKER_LOG:?}"
{
  printf 'CMD'
  printf ' %q' "$@"
  printf '\n'
} >> "${log}"

arg=""
for arg in "$@"; do
  case "${arg}" in
    *:/data/config/tdai-gateway.yaml:ro)
      printf 'MOUNT %s\n' "${arg}" >> "${log}"
      ;;
  esac
done

if [[ "${1:-}" == "inspect" ]]; then
  fmt=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f)
        fmt="${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  case "${fmt}" in
    *Health*) printf 'none\n' ;;
    *Status*) printf 'running\n' ;;
  esac
fi
exit 0
STUB
chmod +x "${STUB_BIN}/docker"

cat > "${WORKDIR}/.env" <<'EOF'
MEMORY_CORE_IMAGE=example/memory-core:test
MEMORY_CORE_PORT=9
MEMORY_CORE_VOLUME=tdai-memory-core-data-test
MEMORY_CORE_GATEWAY_API_KEY=
MEMORY_LLM_BASE_URL=http://llm.example/v1
MEMORY_LLM_API_KEY=sk-test
MEMORY_LLM_MODEL=test-model
MEMORY_PROMPT_MODE=code
EOF

# run_core [--raw] [KEY=VAL ...] -- [script args]
# Sets RUN_CODE and writes combined output to ${WORKDIR}/out.txt.
# --raw keeps the real /usr/bin/curl (permission and early-fail cases).
run_core() {
  local use_curl_stub=1
  if [[ "${1:-}" == "--raw" ]]; then
    use_curl_stub=0
    shift
  fi
  local assigns=()
  local script_args=()
  local parsing_env=1
  local item
  for item in "$@"; do
    if [[ "${parsing_env}" -eq 1 && "${item}" == "--" ]]; then
      parsing_env=0
      continue
    fi
    if [[ "${parsing_env}" -eq 1 ]]; then
      assigns+=("${item}")
    else
      script_args+=("${item}")
    fi
  done
  : > "${WORKDIR}/docker.log"
  rm -f "${WORKDIR}/admin-key"
  set +e
  if [[ "${use_curl_stub}" -eq 1 ]]; then
    OUT=$(
      env \
        -u MEMORY_CORE_CONFIG_FILE \
        -u MEMORY_CORE_REGENERATE_CONFIG \
        PATH="${STUB_BIN}:${ORIG_PATH}" \
        ENV_FILE="${WORKDIR}/.env" \
        MEMORY_CORE_CONFIG_DIR="${WORKDIR}/cfg" \
        MEMORY_CORE_ADMIN_KEY_FILE="${WORKDIR}/admin-key" \
        DOCKER_LOG="${WORKDIR}/docker.log" \
        HOME="${WORKDIR}/home" \
        ${assigns[@]+"${assigns[@]}"} \
        unshare --user --map-root-user --mount \
          bash -c 'mount --bind "$1" /usr/bin/curl && shift && exec "$@"' \
          _ "${STUB_BIN}/curl" \
          bash "${CORE_SCRIPT}" ${script_args[@]+"${script_args[@]}"} \
        2>&1
    )
  else
    OUT=$(
      env \
        -u MEMORY_CORE_CONFIG_FILE \
        -u MEMORY_CORE_REGENERATE_CONFIG \
        PATH="${STUB_BIN}:${ORIG_PATH}" \
        ENV_FILE="${WORKDIR}/.env" \
        MEMORY_CORE_CONFIG_DIR="${WORKDIR}/cfg" \
        MEMORY_CORE_ADMIN_KEY_FILE="${WORKDIR}/admin-key" \
        DOCKER_LOG="${WORKDIR}/docker.log" \
        HOME="${WORKDIR}/home" \
        ${assigns[@]+"${assigns[@]}"} \
        bash "${CORE_SCRIPT}" ${script_args[@]+"${script_args[@]}"} \
        2>&1
    )
  fi
  RUN_CODE=$?
  set -e
  printf '%s\n' "${OUT}" > "${WORKDIR}/out.txt"
}

assert_ok() {
  [[ "${RUN_CODE}" -eq 0 ]] || fail "$1 (exit ${RUN_CODE})"
}

assert_fail() {
  [[ "${RUN_CODE}" -ne 0 ]] || fail "$1 (expected non-zero exit)"
}

assert_mount() {
  local expected="$1"
  grep -F -q "MOUNT ${expected}" "${WORKDIR}/docker.log" \
    || fail "expected read-only mount of ${expected}"
}

assert_no_docker() {
  if [[ -s "${WORKDIR}/docker.log" ]]; then
    fail "docker was invoked; validation should fail first"
  fi
}

cfg_file() {
  printf '%s\n' "${WORKDIR}/cfg/tdai-gateway.yaml"
}

write_base_env() {
  cat > "${WORKDIR}/.env" <<'EOF'
MEMORY_CORE_IMAGE=example/memory-core:test
MEMORY_CORE_PORT=9
MEMORY_CORE_VOLUME=tdai-memory-core-data-test
MEMORY_CORE_GATEWAY_API_KEY=
MEMORY_LLM_BASE_URL=http://llm.example/v1
MEMORY_LLM_API_KEY=sk-test
MEMORY_LLM_MODEL=test-model
MEMORY_PROMPT_MODE=code
EOF
}

if command -v unshare >/dev/null 2>&1 \
  && unshare --user --map-root-user --mount true >/dev/null 2>&1; then
  UNSHARE_OK=1
else
  UNSHARE_OK=0
  echo "SKIP: unshare --user --map-root-user --mount is unavailable; skipping success-path cases (generate, reuse, regenerate, and config mounts). Those cases bind-mount a curl stub over /usr/bin/curl."
fi

if [[ "${UNSHARE_OK}" -eq 1 ]]; then
echo "1. missing default config is generated once"
rm -rf "${WORKDIR}/cfg"
write_base_env
run_core --
assert_ok "first start should succeed"
[[ -f "$(cfg_file)" ]] || fail "default config was not created"
grep -F -q 'deployMode: standalone' "$(cfg_file)" || fail "template lost deployMode"
grep -F -q 'provider: none' "$(cfg_file)" || fail "template lost embedding provider"
grep -F -q 'baseUrl: "http://llm.example/v1"' "$(cfg_file)" || fail "template lost llm baseUrl"
grep -F -q 'model: "test-model"' "$(cfg_file)" || fail "template lost llm model"
grep -F -q 'promptMode: code' "$(cfg_file)" || fail "template lost promptMode"
if grep -F -q '每次启动覆盖' "$(cfg_file)"; then
  fail "generated header still says the file is overwritten every start"
fi
grep -F -q 'MEMORY_CORE_REGENERATE_CONFIG' "$(cfg_file)" \
  || fail "generated header should say how to regenerate"
grep -F -q -- '--force-regenerate-config' "$(cfg_file)" \
  || fail "generated header should mention --force-regenerate-config"
grep -F -q '只在生成或重新生成时写入' "$(cfg_file)" \
  || fail "generated comment should say .env LLM values apply only on generate"
if find "${WORKDIR}/cfg" -name 'tdai-gateway.yaml.tmp.*' -print | grep -q .; then
  fail "config temp file was left beside the destination"
fi
assert_mount "$(cfg_file):/data/config/tdai-gateway.yaml:ro"
grep -F -q '生成 gateway config' "${WORKDIR}/out.txt" || fail "missing generate info"
if grep -F -q '复用已有' "${WORKDIR}/out.txt"; then
  fail "first start should not say it reused a config"
fi
if grep -F -q '不会写入已有 YAML' "${WORKDIR}/out.txt"; then
  fail "first start should not warn that an existing YAML was left unchanged"
fi

echo "2. existing default config is reused when env and the file change"
printf '\nuser-edit-marker: preserve-me\n' >> "$(cfg_file)"
before_sum="$(cksum "$(cfg_file)")"
cat > "${WORKDIR}/.env" <<'EOF'
MEMORY_CORE_IMAGE=example/memory-core:test
MEMORY_CORE_PORT=9
MEMORY_CORE_VOLUME=tdai-memory-core-data-test
MEMORY_CORE_GATEWAY_API_KEY=
MEMORY_LLM_BASE_URL=http://llm.example/v1
MEMORY_LLM_API_KEY=sk-test
MEMORY_LLM_MODEL=other-model
MEMORY_PROMPT_MODE=chat
EOF
run_core MEMORY_CORE_REGENERATE_CONFIG=0 --
assert_ok "restart should succeed"
after_sum="$(cksum "$(cfg_file)")"
[[ "${before_sum}" == "${after_sum}" ]] || fail "existing config was modified"
grep -F -q 'user-edit-marker: preserve-me' "$(cfg_file)" || fail "user edit disappeared"
grep -F -q 'model: "test-model"' "$(cfg_file)" || fail "original generated model disappeared"
if grep -F -q 'other-model' "$(cfg_file)"; then
  fail "restart rewrote config from the new env"
fi
grep -F -q '复用已有' "${WORKDIR}/out.txt" || fail "missing reuse info"
grep -F -q -- '--force-regenerate-config' "${WORKDIR}/out.txt" \
  || fail "reuse info should explain --force-regenerate-config"
grep -F -q 'MEMORY_CORE_REGENERATE_CONFIG' "${WORKDIR}/out.txt" \
  || fail "reuse info should explain MEMORY_CORE_REGENERATE_CONFIG=1"
grep -F -q '[warn]' "${WORKDIR}/out.txt" \
  || fail "reuse should warn"
grep -F -q '.env、交互式 LLM、prompt-mode 和 persona 的变更不会写入已有 YAML，直到 --force-regenerate-config' "${WORKDIR}/out.txt" \
  || fail "reuse should warn that .env, interactive LLM, prompt-mode, and persona changes are not applied until --force-regenerate-config"
assert_mount "$(cfg_file):/data/config/tdai-gateway.yaml:ro"

echo "3. --force-regenerate-config rewrites the default from the current env"
run_core -- --force-regenerate-config
assert_ok "force regenerate should succeed"
grep -F -q 'model: "other-model"' "$(cfg_file)" || fail "force regenerate ignored new model"
grep -F -q 'promptMode: chat' "$(cfg_file)" || fail "force regenerate ignored new promptMode"
if grep -F -q 'user-edit-marker' "$(cfg_file)"; then
  fail "force regenerate kept the previous user edit"
fi
if grep -F -q '每次启动覆盖' "$(cfg_file)"; then
  fail "regenerated header still says the file is overwritten every start"
fi
grep -F -q '重新生成 gateway config' "${WORKDIR}/out.txt" || fail "missing regenerate info"
if grep -F -q '不会写入已有 YAML' "${WORKDIR}/out.txt"; then
  fail "force regenerate should not warn that changes were skipped"
fi
assert_mount "$(cfg_file):/data/config/tdai-gateway.yaml:ro"

echo "4. MEMORY_CORE_REGENERATE_CONFIG=1 also rewrites the default"
printf '\nuser-edit-marker: again\n' >> "$(cfg_file)"
cat > "${WORKDIR}/.env" <<'EOF'
MEMORY_CORE_IMAGE=example/memory-core:test
MEMORY_CORE_PORT=9
MEMORY_CORE_VOLUME=tdai-memory-core-data-test
MEMORY_CORE_GATEWAY_API_KEY=
MEMORY_LLM_BASE_URL=http://llm.example/v1
MEMORY_LLM_API_KEY=sk-test
MEMORY_LLM_MODEL=third-model
MEMORY_PROMPT_MODE=code
EOF
run_core MEMORY_CORE_REGENERATE_CONFIG=1 --
assert_ok "env regenerate should succeed"
grep -F -q 'model: "third-model"' "$(cfg_file)" || fail "MEMORY_CORE_REGENERATE_CONFIG=1 did not rewrite"
if grep -F -q 'user-edit-marker' "$(cfg_file)"; then
  fail "MEMORY_CORE_REGENERATE_CONFIG=1 kept the previous user edit"
fi
grep -F -q '重新生成 gateway config' "${WORKDIR}/out.txt" || fail "missing env regenerate info"

echo "5. MEMORY_CORE_CONFIG_FILE is mounted read-only and never modified"
ext_dir="${WORKDIR}/my config"
mkdir -p "${ext_dir}"
ext_file="${ext_dir}/tdai-gateway.yaml"
printf 'owned: yes\nmodel: "do-not-touch"\n' > "${ext_file}"
ext_sum="$(cksum "${ext_file}")"
rm -rf "${WORKDIR}/cfg"
run_core "MEMORY_CORE_CONFIG_FILE=${ext_file}" --
assert_ok "external config start should succeed"
[[ "$(cksum "${ext_file}")" == "${ext_sum}" ]] || fail "external config was modified"
[[ ! -e "$(cfg_file)" ]] || fail "default config was written while MEMORY_CORE_CONFIG_FILE is set"
grep -F -q '只读挂载' "${WORKDIR}/out.txt" || fail "missing external-config info"
assert_mount "${ext_file}:/data/config/tdai-gateway.yaml:ro"
if grep -F -q '生成 gateway config' "${WORKDIR}/out.txt"; then
  fail "external config path should not generate a config"
fi

echo "5b. MEMORY_CORE_CONFIG_FILE without a slash is mounted as an absolute path"
rel_name="gateway-noslash.yaml"
rel_file="${WORKDIR}/${rel_name}"
printf 'owned: relative\n' > "${rel_file}"
rel_sum="$(cksum "${rel_file}")"
prev_pwd="$(pwd)"
cd "${WORKDIR}"
run_core "MEMORY_CORE_CONFIG_FILE=${rel_name}" --
cd "${prev_pwd}"
assert_ok "relative external config without a slash should succeed"
[[ "$(cksum "${rel_file}")" == "${rel_sum}" ]] || fail "relative external config was modified"
assert_mount "${rel_file}:/data/config/tdai-gateway.yaml:ro"
if grep -F -q "MOUNT ${rel_name}:/data/config/tdai-gateway.yaml:ro" "${WORKDIR}/docker.log"; then
  fail "docker -v received the relative config path (named volume)"
fi

echo "5c. CDPATH does not redirect a relative MEMORY_CORE_CONFIG_FILE"
real_root="${WORKDIR}/real-tree"
decoy_root="${WORKDIR}/cdpath-decoy"
mkdir -p "${real_root}/subdir" "${decoy_root}/subdir"
real_file="${real_root}/subdir/gateway.yaml"
decoy_file="${decoy_root}/subdir/gateway.yaml"
printf 'marker: REAL\n' > "${real_file}"
printf 'marker: DECOY\n' > "${decoy_file}"
real_sum="$(cksum "${real_file}")"
decoy_sum="$(cksum "${decoy_file}")"
prev_pwd="$(pwd)"
cd "${real_root}"
run_core "CDPATH=${decoy_root}" "MEMORY_CORE_CONFIG_FILE=subdir/gateway.yaml" --
cd "${prev_pwd}"
assert_ok "CDPATH relative config should succeed"
[[ "$(cksum "${real_file}")" == "${real_sum}" ]] || fail "CDPATH case modified the real config"
[[ "$(cksum "${decoy_file}")" == "${decoy_sum}" ]] || fail "CDPATH case modified the decoy config"
if grep -F -q "MOUNT ${decoy_file}:/data/config/tdai-gateway.yaml:ro" "${WORKDIR}/docker.log"; then
  fail "CDPATH made docker -v mount the decoy config"
fi
assert_mount "${real_file}:/data/config/tdai-gateway.yaml:ro"
mount_line="$(grep -F 'MOUNT ' "${WORKDIR}/docker.log")"
mount_spec="${mount_line#MOUNT }"
mount_src="${mount_spec%:/data/config/tdai-gateway.yaml:ro}"
[[ -n "${mount_src}" && "${mount_src}" -ef "${real_file}" ]] || fail "mounted path is not the file [[ -f ]] accepted"

echo "5d. logical .. from a symlink cwd mounts the physical file"
phys_parent="${WORKDIR}/physical-parent"
logical_parent="${WORKDIR}/logical-parent"
mkdir -p "${phys_parent}/real-dir" "${logical_parent}"
phys_file="${phys_parent}/gateway.yaml"
logical_file="${logical_parent}/gateway.yaml"
printf 'marker: PHYSICAL\n' > "${phys_file}"
printf 'marker: LOGICAL\n' > "${logical_file}"
phys_sum="$(cksum "${phys_file}")"
logical_sum="$(cksum "${logical_file}")"
ln -s "${phys_parent}/real-dir" "${logical_parent}/link"
prev_pwd="$(pwd)"
cd "${logical_parent}/link"
[[ -f ../gateway.yaml ]] || fail "setup: ../gateway.yaml is not a file from the symlink cwd"
[[ "../gateway.yaml" -ef "${phys_file}" ]] || fail "setup: [[ -f ]] did not accept the physical file"
[[ ! "../gateway.yaml" -ef "${logical_file}" ]] || fail "setup: symlink parents are not distinct"
run_core "MEMORY_CORE_CONFIG_FILE=../gateway.yaml" --
cd "${prev_pwd}"
assert_ok "symlink cwd relative config should succeed"
[[ "$(cksum "${phys_file}")" == "${phys_sum}" ]] || fail "symlink case modified the physical config"
[[ "$(cksum "${logical_file}")" == "${logical_sum}" ]] || fail "symlink case modified the logical config"
if grep -F -q "MOUNT ${logical_file}:/data/config/tdai-gateway.yaml:ro" "${WORKDIR}/docker.log"; then
  fail "logical cd .. made docker -v mount the logical parent config"
fi
assert_mount "${phys_file}:/data/config/tdai-gateway.yaml:ro"
mount_line="$(grep -F 'MOUNT ' "${WORKDIR}/docker.log")"
mount_spec="${mount_line#MOUNT }"
mount_src="${mount_spec%:/data/config/tdai-gateway.yaml:ro}"
[[ -n "${mount_src}" && "${mount_src}" -ef "${logical_parent}/link/../gateway.yaml" ]] || fail "mounted path is not the file [[ -f ]] accepted from the symlink cwd"

echo "5e. relative MEMORY_CORE_CONFIG_DIR is mounted as an absolute path"
rel_cfg_root="${WORKDIR}/rel-cfg-cwd"
mkdir -p "${rel_cfg_root}"
prev_pwd="$(pwd)"
cd "${rel_cfg_root}"
run_core MEMORY_CORE_CONFIG_DIR=.memory-core-config --
cd "${prev_pwd}"
assert_ok "relative MEMORY_CORE_CONFIG_DIR should succeed"
rel_cfg_file="${rel_cfg_root}/.memory-core-config/tdai-gateway.yaml"
[[ -f "${rel_cfg_file}" ]] || fail "relative config dir was not created in the working directory"
rel_cfg_abs="$(CDPATH= cd -P -- "${rel_cfg_root}/.memory-core-config" >/dev/null && pwd -P)/tdai-gateway.yaml"
assert_mount "${rel_cfg_abs}:/data/config/tdai-gateway.yaml:ro"
if grep -F -q "MOUNT .memory-core-config/tdai-gateway.yaml:/data/config/tdai-gateway.yaml:ro" "${WORKDIR}/docker.log"; then
  fail "docker -v received the relative config directory"
fi
mount_line="$(grep -F 'MOUNT ' "${WORKDIR}/docker.log")"
mount_spec="${mount_line#MOUNT }"
mount_src="${mount_spec%:/data/config/tdai-gateway.yaml:ro}"
[[ "${mount_src}" == /* ]] || fail "MEMORY_CORE_CONFIG_DIR mount is not absolute"
[[ "${mount_src}" -ef "${rel_cfg_file}" ]] || fail "relative config dir mount is not the generated file"

echo "5f. CDPATH does not redirect a relative MEMORY_CORE_CONFIG_DIR"
real_root="${WORKDIR}/dir-real"
decoy_root="${WORKDIR}/dir-cdpath-decoy"
mkdir -p "${real_root}" "${decoy_root}/cfgdir"
decoy_file="${decoy_root}/cfgdir/tdai-gateway.yaml"
printf 'marker: DECOY-DIR\n' > "${decoy_file}"
decoy_sum="$(cksum "${decoy_file}")"
prev_pwd="$(pwd)"
cd "${real_root}"
run_core "CDPATH=${decoy_root}" MEMORY_CORE_CONFIG_DIR=cfgdir --
cd "${prev_pwd}"
assert_ok "CDPATH config dir should succeed"
real_file="${real_root}/cfgdir/tdai-gateway.yaml"
[[ -f "${real_file}" ]] || fail "CDPATH config dir was not created in the working directory"
[[ "$(cksum "${decoy_file}")" == "${decoy_sum}" ]] || fail "CDPATH config dir modified the decoy"
if grep -F -q "MOUNT ${decoy_file}:/data/config/tdai-gateway.yaml:ro" "${WORKDIR}/docker.log"; then
  fail "CDPATH made docker -v mount the decoy config dir"
fi
mount_line="$(grep -F 'MOUNT ' "${WORKDIR}/docker.log")"
mount_spec="${mount_line#MOUNT }"
mount_src="${mount_spec%:/data/config/tdai-gateway.yaml:ro}"
[[ "${mount_src}" == /* && "${mount_src}" -ef "${real_file}" ]] || fail "CDPATH config dir mount is not the working-directory file"

echo "5g. logical .. config dir from a symlink cwd mounts the physical directory"
phys_parent="${WORKDIR}/dir-physical-parent"
logical_parent="${WORKDIR}/dir-logical-parent"
mkdir -p "${phys_parent}/real-dir" "${logical_parent}"
mkdir -p "${phys_parent}/core-cfg" "${logical_parent}/core-cfg"
phys_file="${phys_parent}/core-cfg/tdai-gateway.yaml"
logical_file="${logical_parent}/core-cfg/tdai-gateway.yaml"
printf 'marker: PHYSICAL-DIR\n' > "${phys_file}"
printf 'marker: LOGICAL-DIR\n' > "${logical_file}"
phys_sum="$(cksum "${phys_file}")"
logical_sum="$(cksum "${logical_file}")"
ln -s "${phys_parent}/real-dir" "${logical_parent}/link"
prev_pwd="$(pwd)"
cd "${logical_parent}/link"
[[ -d ../core-cfg ]] || fail "setup: ../core-cfg is not a directory from the symlink cwd"
[[ "../core-cfg/tdai-gateway.yaml" -ef "${phys_file}" ]] || fail "setup: kernel path is not the physical config"
[[ ! "../core-cfg/tdai-gateway.yaml" -ef "${logical_file}" ]] || fail "setup: symlink parents are not distinct"
run_core MEMORY_CORE_CONFIG_DIR=../core-cfg --
cd "${prev_pwd}"
assert_ok "symlink cwd config dir should succeed"
[[ "$(cksum "${phys_file}")" == "${phys_sum}" ]] || fail "symlink config dir modified the physical file"
[[ "$(cksum "${logical_file}")" == "${logical_sum}" ]] || fail "symlink config dir modified the logical file"
if grep -F -q "MOUNT ${logical_file}:/data/config/tdai-gateway.yaml:ro" "${WORKDIR}/docker.log"; then
  fail "logical cd .. made docker -v mount the logical config dir"
fi
mount_line="$(grep -F 'MOUNT ' "${WORKDIR}/docker.log")"
mount_spec="${mount_line#MOUNT }"
mount_src="${mount_spec%:/data/config/tdai-gateway.yaml:ro}"
[[ "${mount_src}" == /* && "${mount_src}" -ef "${phys_file}" ]] || fail "symlink config dir mount is not the physical file"
fi

echo "6. missing MEMORY_CORE_CONFIG_FILE fails before docker"
run_core --raw "MEMORY_CORE_CONFIG_FILE=${WORKDIR}/missing-gateway.yaml" --
assert_fail "missing external config should fail"
grep -F -q '不存在或不可读' "${WORKDIR}/out.txt" || fail "missing-file error should name the problem"
assert_no_docker
[[ ! -e "${WORKDIR}/missing-gateway.yaml" ]] || fail "script created the missing external file"

if [[ "${EUID}" -eq 0 ]]; then
  echo "SKIP: unreadable MEMORY_CORE_CONFIG_FILE case (running as root; chmod 000 is still readable)"
else
  echo "7. unreadable MEMORY_CORE_CONFIG_FILE fails and is left unchanged"
  secret="${WORKDIR}/secret-gateway.yaml"
  printf 'secret: keep\n' > "${secret}"
  secret_sum="$(cksum "${secret}")"
  chmod 000 "${secret}"
  run_core --raw "MEMORY_CORE_CONFIG_FILE=${secret}" --
  assert_fail "unreadable external config should fail"
  grep -F -q '不存在或不可读' "${WORKDIR}/out.txt" || fail "unreadable-file error should name the problem"
  assert_no_docker
  chmod u+r "${secret}"
  [[ "$(cksum "${secret}")" == "${secret_sum}" ]] || fail "unreadable external config was modified"
fi

echo "8. force-regenerate refuses to touch MEMORY_CORE_CONFIG_FILE"
ext_dir="${WORKDIR}/my config"
mkdir -p "${ext_dir}"
ext_file="${ext_dir}/tdai-gateway.yaml"
printf 'owned: yes\nmodel: "do-not-touch"\n' > "${ext_file}"
ext_sum="$(cksum "${ext_file}")"
run_core --raw "MEMORY_CORE_CONFIG_FILE=${ext_file}" -- --force-regenerate-config
assert_fail "flag must not rewrite an external config"
[[ "$(cksum "${ext_file}")" == "${ext_sum}" ]] || fail "flag modified the external config"
assert_no_docker
grep -F -q 'MEMORY_CORE_CONFIG_FILE' "${WORKDIR}/out.txt" || fail "conflict error should name MEMORY_CORE_CONFIG_FILE"

run_core --raw "MEMORY_CORE_CONFIG_FILE=${ext_file}" MEMORY_CORE_REGENERATE_CONFIG=1 --
assert_fail "MEMORY_CORE_REGENERATE_CONFIG=1 must not rewrite an external config"
[[ "$(cksum "${ext_file}")" == "${ext_sum}" ]] || fail "env regenerate modified the external config"
assert_no_docker

echo "9. unknown arguments fail before docker"
run_core --raw -- --not-a-real-flag
assert_fail "unknown flag should fail"
grep -F -q '未知参数' "${WORKDIR}/out.txt" || fail "unknown flag should be reported"
assert_no_docker

echo "10. default config path that is not a regular file fails before docker"
rm -rf "${WORKDIR}/cfg"
mkdir -p "${WORKDIR}/cfg/tdai-gateway.yaml"
printf 'sentinel\n' > "${WORKDIR}/cfg/tdai-gateway.yaml/keep.txt"
run_core --raw --
assert_fail "directory destination should fail"
grep -F -q '不是普通文件' "${WORKDIR}/out.txt" || fail "directory destination should explain it is not a regular file"
assert_no_docker
[[ -d "${WORKDIR}/cfg/tdai-gateway.yaml" ]] || fail "directory destination was replaced"
[[ -f "${WORKDIR}/cfg/tdai-gateway.yaml/keep.txt" ]] || fail "directory destination contents changed"
if find "${WORKDIR}/cfg" -name 'tdai-gateway.yaml.tmp.*' -print | grep -q .; then
  fail "temp config was written for a directory destination"
fi
run_core --raw -- --force-regenerate-config
assert_fail "force-regenerate into a directory destination should fail"
assert_no_docker
[[ -d "${WORKDIR}/cfg/tdai-gateway.yaml" ]] || fail "force-regenerate replaced the directory destination"
grep -F -q 'sentinel' "${WORKDIR}/cfg/tdai-gateway.yaml/keep.txt" || fail "force-regenerate changed directory contents"

echo "PASS: memory-core gateway config lifecycle"
