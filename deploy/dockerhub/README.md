# Docker Hub 镜像发布

把三件套镜像构建并推送到 Docker Hub 的
[`agentmemory`](https://hub.docker.com/u/agentmemory) namespace。

`publish.sh` 是自包含的：只依赖各组件自己的 Dockerfile、
`deploy/panel-knowledge-combined/build.sh` 和 `MemoryPanel/scripts/secret-scan.sh`。

## 组件与镜像名

| 组件 | 构建上下文 | 镜像 |
|---|---|---|
| `memory-core` | `MemoryCore/` | `agentmemory/memory-core` |
| `memory-proxy` | `MemoryProxy/`（rsync 到临时 context） | `agentmemory/memory-proxy` |
| `memory-hub` | `MemoryPanel/` + `MemoryKnowledge/` 合并 | `agentmemory/memory-hub` |

## 前置

```bash
docker login docker.io          # 账号需有 agentmemory 推送权限
docker buildx version           # 需要 buildx（脚本会自动创建 builder）
```

## 使用

```bash
cd deploy/dockerhub

# 三件套一次发布
VERSION=1.0.0 ./publish.sh all

# 单个组件
VERSION=1.0.0 ./publish.sh memory-core
VERSION=1.0.0 ./publish.sh memory-proxy
VERSION=1.0.0 ./publish.sh memory-hub

# 干跑：只做 secret-scan 和 context 准备，不构建不推送
DRY_RUN=1 VERSION=1.0.0 ./publish.sh all

# 本地单架构构建并抽查镜像内容，不推送
PUSH=0 VERSION=1.0.0 ./publish.sh memory-core

# 同时更新 :latest
ALSO_LATEST=1 VERSION=1.0.0 ./publish.sh all
```

`VERSION` 必填，且不接受 `dev-` 开头的值，避免把开发 tag 推上公网。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VERSION` | 无（必填） | 镜像 tag |
| `NAMESPACE` | `agentmemory` | Docker Hub namespace |
| `REGISTRY` | `docker.io` | 目标 registry |
| `PLATFORMS` | `linux/amd64,linux/arm64` | 多架构构建目标 |
| `ALSO_LATEST` | `0` | 是否同时推 `:latest` |
| `PUSH` | `1` | 置 `0` 则本地 `--load` 单架构，不推送 |
| `DRY_RUN` | `0` | 置 `1` 只跑扫描与 context 准备 |
| `LOAD_PLATFORM` | `linux/amd64` | `PUSH=0` 时本地构建的架构 |
| `KEEP_CTX` | `0` | 置 `1` 复用上次的临时 context |
| `APT_MIRROR` | `deb.debian.org` | 构建期 apt 源，内网可设为加速镜像 |

## 构建期 apt 加速

四个 Dockerfile 都通过 `APT_MIRROR` build-arg 控制 apt 源，默认走 Debian 官方，
公网环境开箱可用。内网构建想加速时统一传一个变量即可，镜像产物本身不受影响：

```bash
APT_MIRROR=<your-debian-mirror> VERSION=1.0.0 ./publish.sh all
```

## 关于可选私有模块

- `MemoryProxy/packages/cost-guard` 是可选扩展，不进公开镜像。`publish.sh` 会在
  临时 context 里生成一个 stub 包让依赖图能解析；运行时 `src/guard-adapter.ts`
  的动态 import 失败后自动降级为直通转发。
- `MemoryCore/src/integrations` 同理，已在 `MemoryCore/.dockerignore` 中排除，
  运行时走 fallback。

## 验证

```bash
docker pull agentmemory/memory-core:1.0.0
docker buildx imagetools inspect agentmemory/memory-core:1.0.0
```
