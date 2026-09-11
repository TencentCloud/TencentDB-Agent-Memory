#!/bin/bash
# TDAI Memory Hub 一键部署脚本

set -e

echo "🚀 TDAI Memory Hub 一键部署脚本"
echo "=================================="

# 检查Docker是否安装
if ! command -v docker &> /dev/null; then
    echo "❌ Docker 未安装，请先安装 Docker"
    exit 1
fi

# 检查Docker Compose是否可用
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose 未安装，请先安装 Docker Compose"
    exit 1
fi

# 检查.env文件
if [ ! -f .env ]; then
    echo "📝 创建 .env 配置文件..."
    cp .env.example .env
    echo "⚠️  请先编辑 .env 文件，填入你的 LLM_API_KEY"
    echo "编辑完成后，再次运行此脚本继续部署"
    exit 0
fi

# 检查API密钥是否配置
if grep -q "your_api_key_here" .env; then
    echo "❌ 请先在 .env 文件中配置你的 LLM_API_KEY"
    exit 1
fi

echo "✅ 配置检查通过"

# 停止现有容器（如果存在）
echo "🛑 停止现有容器..."
docker-compose down 2>/dev/null || true

# 清理旧的独立容器（如果存在）
echo "🧹 清理旧容器..."
docker stop tdai-memory-core tdai-memory-hub tdai-proxy 2>/dev/null || true
docker rm tdai-memory-core tdai-memory-hub tdai-proxy 2>/dev/null || true

# 创建并启动服务
echo "🚀 启动 TDAI Memory Hub 服务..."
docker-compose up -d

echo "⏳ 等待服务启动..."
sleep 10

# 检查服务状态
echo "🔍 检查服务状态..."
docker-compose ps

# 健康检查
echo "🏥 执行健康检查..."
max_attempts=30
attempt=0

while [ $attempt -lt $max_attempts ]; do
    if curl -sf http://localhost:8420/health > /dev/null && \
       curl -sf http://localhost:8125/health > /dev/null && \
       curl -sf http://localhost:8096/health > /dev/null; then
        echo "✅ 所有服务启动成功！"
        break
    fi

    attempt=$((attempt + 1))
    echo "⏳ 等待服务启动... ($attempt/$max_attempts)"
    sleep 2
done

if [ $attempt -eq $max_attempts ]; then
    echo "❌ 服务启动超时，请检查日志："
    docker-compose logs
    exit 1
fi

echo ""
echo "🎉 部署完成！"
echo ""
echo "📍 访问地址："
echo "  - Web管理界面: http://localhost:8125"
echo "  - 知识库API:   http://localhost:8424"
echo "  - 核心API:     http://localhost:8420"
echo "  - 代理服务:    http://localhost:8096"
echo ""
echo "📊 查看状态："
echo "  docker-compose ps"
echo ""
echo "📋 查看日志："
echo "  docker-compose logs -f"
echo ""
echo "🛑 停止服务："
echo "  docker-compose stop"
echo ""
echo "🔄 重启服务："
echo "  docker-compose restart"