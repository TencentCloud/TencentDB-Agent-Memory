---
type: pitfall
title: "改 .env 后必须重建容器，否则 LLM 仍用旧 key 报 Invalid API-key"
date: 2026-08-08
related_modules: ["deploy", "knowledge"]
related_components: []
tags: ["pitfall"]
aliases: ["Invalid API-key", "env 不生效", "容器环境变量未更新", "docker run -e 注入时机", "MEMORY_LLM_API_KEY"]
severity: high
root_cause: "docker run -e 只在容器创建时注入环境变量；修改 .env 后未重建容器，KS 进程继续使用旧的 LLM_API_KEY/LLM_BASE_URL，被上游供应商拒绝。"
status: stable
generated: { by: codewiki/5.2.1, at: 2026-08-08T13:07:31Z }
stale_after: 2026-11-06
---

## 背景

在 172.53.4.202 部署环境构建 wiki 知识库时报错：`all source documents failed to ingest; first failure: ... AI_APICallError: Invalid API-key provided.`。用户确认 `.env` 中的 key 刚设置过、肯定有效，且 KS 的 llm-binding 列表为空（不存在 binding 覆盖 env 的情况）。

## 根因

`docker run -e` 只在**容器创建时**注入一次环境变量。修改 `deploy/global-images/.env` 的 `MEMORY_LLM_*` 后，若不重跑 `./start-memory-hub.sh`，运行中的 `tdai-memory-hub` 容器仍持有旧值。本次实测：容器内是旧配置（`token-plan` maas 端点 + 旧 key `sk-sp-H***`），磁盘 `.env` 是新配置（`dashscope` + 新 key `sk-e8c9***`）——KS 拿旧 key 请求被上游拒绝。

## 正确做法

1. 改 `.env` 后必须重跑对应启动脚本重建容器（`start-memory-hub.sh` 会幂等移除旧容器并用新 env 重建，volume 数据保留）。
2. 诊断"key 明明改了仍报 Invalid API-key"类问题时，**不要只信磁盘上的 `.env`**，先用 `docker exec <container> printenv | grep LLM_` 看容器内实际生效的值，与 `.env` 对比。
3. 验证 key 本身有效性可用无 body 的 `GET {LLM_BASE_URL}/models`（带 `Authorization: Bearer` 头），200=有效，不消耗 token。

## 适用范围

所有通过 `deploy/global-images/start-*.sh` 部署的容器（memory-core / memory-hub / proxy）。注意 proxy 的上游配置走挂载的 config.yaml 而非 env，但同样需要重建容器才能生效。
