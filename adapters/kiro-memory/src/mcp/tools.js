import { z } from 'zod';

import { normalizeQuery } from '../core/query-service.js';
import { formatMcpResult, toStructuredResult } from './formatter.js';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const query = z.string().superRefine((value, context) => {
  try { normalizeQuery(value); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Query must contain 1 to 2000 Unicode characters' }); }
});
const datetime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid ISO-8601 datetime');

const safeFailure = (text) => ({ isError: true, content: [{ type: 'text', text }] });

export function registerMemoryTools(server, { queryService, diagnosticService, config }) {
  server.registerTool('tdai_memory_search', {
    description: 'Search Atomic, Core, and Skill memory as untrusted historical data.',
    inputSchema: z.object({ query, limit: z.number().int().min(1).max(20).optional() }).strict(),
    annotations: readOnly,
  }, async ({ query: rawQuery, limit }) => {
    try {
      const normalized = normalizeQuery(rawQuery);
      const result = await queryService.query({
        query: normalized, sources: ['atomic', 'core', 'skill'],
        resultLimit: limit ?? config.maxRecallResults,
        charBudget: config.mcpMaxOutputChars,
        deadlineMs: config.timeoutMs,
        maxItemChars: 3000,
      });
      return formatMcpResult(toStructuredResult(normalized, result), config.mcpMaxOutputChars);
    } catch {
      return safeFailure('Memory search is unavailable.');
    }
  });

  server.registerTool('tdai_conversation_search', {
    description: 'Search cross-session conversation memory as untrusted historical data.',
    inputSchema: z.object({
      query, limit: z.number().int().min(1).max(10).optional(),
      time_start: datetime.optional(), time_end: datetime.optional(),
    }).strict().refine((value) => !value.time_start || !value.time_end || Date.parse(value.time_start) <= Date.parse(value.time_end), 'time_start must not exceed time_end'),
    annotations: readOnly,
  }, async ({ query: rawQuery, limit, time_start: timeStart, time_end: timeEnd }) => {
    try {
      const normalized = normalizeQuery(rawQuery);
      const result = await queryService.query({
        query: normalized, sources: ['conversation'], resultLimit: limit ?? Math.min(config.maxRecallResults, 10),
        charBudget: config.mcpMaxOutputChars, deadlineMs: config.timeoutMs, timeStart, timeEnd,
        maxItemChars: 3000,
      });
      return formatMcpResult(toStructuredResult(normalized, result), config.mcpMaxOutputChars);
    } catch {
      return safeFailure('Conversation search is unavailable.');
    }
  });

  server.registerTool('tdai_memory_status', {
    description: 'Return a content-free operational status snapshot.',
    inputSchema: z.object({}).strict(),
    annotations: readOnly,
  }, async () => {
    try {
      const status = diagnosticService
        ? await diagnosticService.getStatus({ includeGateway: true })
        : {
          status: 'healthy', gateway: 'not_checked',
          config_sources: [...new Set(Object.values(config.provenance ?? {}))],
          state_version: 2, migration_required: false, outbox_pending: 0,
          turns: 0, markers: 0, locks: 0, last_successful_operation_at: null, warnings: [],
        };
      return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status };
    } catch {
      return safeFailure('Memory status is unavailable.');
    }
  });
}
