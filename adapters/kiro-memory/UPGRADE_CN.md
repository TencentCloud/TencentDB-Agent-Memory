# 升级到 Phase 2

1. 备份已配置的状态目录和 `.kiro` 目录。
2. 运行 `node scripts/install.mjs --project <project>`。合法 Phase 1 receipt 会升级为 receipt v2，其他 hook 与 MCP 配置保持不变。
3. 运行 `node scripts/status.mjs --project <project>`。若状态为 legacy，运行 `node scripts/migrate.mjs --project <project>`；中断后可重复执行直至完成。
4. 运行 `node scripts/doctor.mjs --project <project>` 及文档列出的本地测试。

Phase 2 默认开启 capture、recall 和 skill recall，并限制 MCP 输出；显式的项目、用户或环境设置覆盖默认值。如果 Phase 1 明确设置了 `TDAI_MEMORY_CONVERSATION_RECALL_ENABLED=false`，请保留该环境变量或在 Config v2 写入 `"conversationRecallEnabled": false`，避免新默认值静默改变策略。迁移先复制和校验数据，最后才发布 State v2；不会自动改写或删除源数据。

回滚时可用 `uninstall.mjs` 移除本适配器拥有的 hook/MCP 集成，但 State v2 不会自动降级到 v1。远程验证完成前请保留源备份。
