# Upgrade to Phase 2

1. Back up the configured state directory and `.kiro` directory.
2. Run `node scripts/install.mjs --project <project>`. A valid Phase 1 receipt is upgraded to receipt v2; unrelated hook and MCP configuration is preserved.
3. Run `node scripts/status.mjs --project <project>`. If state is legacy, run `node scripts/migrate.mjs --project <project>` and repeat it after interruption until complete.
4. Run `node scripts/doctor.mjs --project <project>` and the documented local tests.

Phase 2 defaults keep capture and recall enabled, skill recall enabled, and bounded MCP output. Explicit project, user, or environment settings override defaults. If Phase 1 explicitly set `TDAI_MEMORY_CONVERSATION_RECALL_ENABLED=false`, keep that environment setting or write `"conversationRecallEnabled": false` in Config v2; do not let the new default silently change the policy. Migration copies and verifies data before publishing State v2; it never rewrites or deletes the source automatically.

Rollback may remove the owned hook/MCP integration with `uninstall.mjs`, but State v2 is not automatically downgraded to v1. Keep the source backup until remote validation is complete.
