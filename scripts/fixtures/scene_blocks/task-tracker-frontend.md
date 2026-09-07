# Task Tracker Frontend

## 技术栈
- 构建工具：Vite
- 框架：React 18 + TypeScript
- 状态管理：Zustand
- 表单：React Hook Form
- 虚拟滚动：react-virtuoso
- UI：自定义 CSS Modules

## 页面
- /login — 登录页
- /tasks — 任务列表（卡片布局 + 状态筛选）
- /tasks/new — 创建任务
- /tasks/:id/edit — 编辑任务

## 组件树
App → AuthProvider → Router → LoginPage | TaskListPage | TaskFormPage

## 状态设计
- authStore: user, token, login(), logout()
- taskStore: tasks, filters, createTask(), updateTask(), deleteTask(), fetchTasks()
