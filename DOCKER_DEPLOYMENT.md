# TDAI Memory Hub 一键部署指南

## 🚀 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入你的 LLM_API_KEY
```

### 2. 一键启动

```bash
# 创建并启动所有服务
docker-compose up -d

# 查看服务状态
docker-compose ps

# 查看日志
docker-compose logs -f
```

### 3. 验证部署

```bash
# 检查核心服务
curl http://localhost:8420/health

# 检查Web界面
curl http://localhost:8125/health

# 检查代理服务
curl http://localhost:8096/health
```

## 📊 服务架构

```
┌─────────────────┬──────────┬─────────────────┬──────────────────┐
│ 服务             │ 端口      │ 数据卷           │ 功能             │
├─────────────────┼──────────┼─────────────────┼──────────────────┤
│ memory-core     │ 8420     │ tdai-core-data  │ TDAI核心API     │
│ memory-hub      │ 8424/8125│ tdai-hub-data   │ Web管理界面     │  
│ memory-proxy    │ 8096     │ -               │ 代理服务         │
└─────────────────┴──────────┴─────────────────┴──────────────────┘
```

## 🔧 关键修复

### 1. 自动启用数据同步
- **问题**：原配置中 `KNOWLEDGE_LLM_BINDING_SYNC=0`
- **修复**：docker-compose.yml中默认设置为 `1`

### 2. 自动网络配置
- **问题**：需要手动创建Docker网络
- **修复**：docker-compose自动创建和管理网络

### 3. 服务依赖管理
- **问题**：服务启动顺序不确定
- **修复**：使用 `depends_on` 和健康检查确保正确启动顺序

### 4. 数据持久化
- **问题**：容器重启后数据丢失
- **修复**：使用命名卷确保数据持久化

## 🛠️ 常用操作

```bash
# 停止所有服务
docker-compose stop

# 启动所有服务
docker-compose start

# 重启特定服务
docker-compose restart memory-hub

# 查看特定服务日志
docker-compose logs -f memory-core

# 完全清理（包括数据卷）
docker-compose down -v
```

## 🔍 故障排查

### 服务无法启动
```bash
# 检查服务状态
docker-compose ps

# 查看详细日志
docker-compose logs memory-hub
```

### 数据同步问题
```bash
# 检查同步状态
docker exec tdai-memory-hub env | grep SYNC

# 手动触发同步（需要通过API）
curl -X POST http://localhost:8424/api/v1/sync/trigger
```

### 网络连接问题
```bash
# 检查网络
docker network ls | grep tdai

# 测试服务间连接
docker exec tdai-memory-hub ping memory-core
```

## 📝 配置说明

### 环境变量
- `LLM_API_KEY`: 大模型API密钥（必需）
- `LLM_BASE_URL`: API基础URL
- `LLM_MODEL`: 使用的模型名称

### 端口映射
- `8420`: TDAI核心API
- `8424`: 知识库API
- `8125`: Web管理界面
- `8096`: 代理服务

### 数据卷
- `tdai-core-data`: TDAI对话数据
- `tdai-hub-data`: 知识库数据
- `tdai-config-data`: 配置文件

## 🎯 访问地址

- **Web管理界面**: http://localhost:8125
- **知识库API**: http://localhost:8424
- **核心API**: http://localhost:8420
- **代理服务**: http://localhost:8096

## 🔄 与手动部署的对比

| 特性 | 手动部署 | Docker Compose |
|------|----------|-----------------|
| 网络配置 | 手动创建 | 自动创建 |
| 同步功能 | 手动启用 | 默认启用 |
| 服务依赖 | 手动管理 | 自动管理 |
| 数据持久化 | 手动配置 | 自动配置 |
| 部署时间 | ~15分钟 | ~2分钟 |
| 故障排查 | 复杂 | 简单 |