type FieldRule =
  | { kind: "string"; required?: boolean }
  | { kind: "stringEnum"; required?: boolean; values: string[]; passthrough?: boolean; default?: string }
  | { kind: "boolean"; required?: boolean; default?: boolean }
  | { kind: "int"; required?: boolean; min?: number; max?: number; default?: number };

interface QuerySpec {
  fields: Record<string, FieldRule>;
}

const QUERY_SPECS: Record<string, QuerySpec> = {
  search: {
    fields: {
      query: { kind: "string", required: true },
      kind: {
        kind: "stringEnum",
        values: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
        passthrough: true,
      },
      limit: { kind: "int", min: 1, max: 100, default: 10 },
    },
  },
  explore: {
    fields: {
      query: { kind: "string", required: true },
      maxFiles: { kind: "int", min: 1, max: 200, default: 12 },
    },
  },
  callers: {
    fields: {
      symbol: { kind: "string", required: true },
      limit: { kind: "int", min: 1, max: 200, default: 20 },
    },
  },
  callees: {
    fields: {
      symbol: { kind: "string", required: true },
      limit: { kind: "int", min: 1, max: 200, default: 20 },
    },
  },
  impact: {
    fields: {
      symbol: { kind: "string", required: true },
      depth: { kind: "int", min: 1, max: 10, default: 2 },
    },
  },
  node: {
    fields: {
      symbol: { kind: "string", required: true },
      includeCode: { kind: "boolean", default: false },
      file: { kind: "string" },
      line: { kind: "int", min: 1 },
    },
  },
  status: {
    fields: {},
  },
  files: {
    fields: {
      path: { kind: "string" },
      pattern: { kind: "string" },
      format: { kind: "stringEnum", values: ["tree", "flat", "grouped"], default: "tree", passthrough: true } as FieldRule,
      includeMetadata: { kind: "boolean", default: true },
      maxDepth: { kind: "int", min: 1 },
    },
  },
};

/** Validate query params against spec whitelist + defaults. Returns toolParams or error string. */
export function buildCodeGraphToolParams(
  action: string,
  body: Record<string, unknown>,
  allowRoutingKey = false,
): { params: Record<string, unknown> } | { error: string } {
  const spec = Object.hasOwn(QUERY_SPECS, action) ? QUERY_SPECS[action] : undefined;
  if (!spec) return { error: `unknown action: ${action}` };

  // Dedicated HTTP routes may carry a resource routing key. Never forward it
  // to the SDK; generic tool arguments and direct bridge callers cannot set it.
  const allowed = new Set([...(allowRoutingKey ? ["code_graph_id"] : []), ...Object.keys(spec.fields)]);

  // Reject undeclared fields
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) {
      return { error: `unexpected field: ${k}` };
    }
  }

  const params: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(spec.fields)) {
    const raw = body[name];
    const present = raw !== undefined && raw !== null;

    if (!present) {
      if (rule.required) return { error: `${name} is required` };
      if ("default" in rule && rule.default !== undefined) {
        const passthrough = rule.kind !== "stringEnum" || rule.passthrough !== false;
        if (passthrough) params[name] = rule.default;
      }
      continue;
    }

    switch (rule.kind) {
      case "string": {
        if (typeof raw !== "string" || !raw) return { error: `${name} must be non-empty string` };
        params[name] = raw;
        break;
      }
      case "stringEnum": {
        if (typeof raw !== "string" || !rule.values.includes(raw)) {
          return { error: `${name} must be one of ${rule.values.join(", ")}` };
        }
        if (rule.passthrough !== false) params[name] = raw;
        break;
      }
      case "boolean": {
        if (typeof raw !== "boolean") return { error: `${name} must be boolean` };
        params[name] = raw;
        break;
      }
      case "int": {
        if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
          return { error: `${name} must be integer` };
        }
        if (rule.min !== undefined && raw < rule.min) return { error: `${name} must be >= ${rule.min}` };
        if (rule.max !== undefined && raw > rule.max) return { error: `${name} must be <= ${rule.max}` };
        params[name] = raw;
        break;
      }
    }
  }

  return { params };
}
