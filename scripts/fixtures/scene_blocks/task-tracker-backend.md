# Task Tracker Backend

## 架构
- 框架：FastAPI
- ORM：SQLAlchemy (async)
- 数据库：PostgreSQL
- 认证：JWT (OAuth2PasswordBearer)

## API 端点
- POST /api/auth/register — 用户注册
- POST /api/auth/login — 用户登录
- GET /api/tasks — 任务列表（分页 + 状态筛选）
- POST /api/tasks — 创建任务
- GET /api/tasks/{id} — 任务详情
- PATCH /api/tasks/{id} — 部分更新任务
- DELETE /api/tasks/{id} — 软删除任务

## 数据模型
Task: id, title, description, status(enum), priority(enum), created_at, due_date, is_deleted, user_id
User: id, email, username, hashed_password, created_at
