export type TdaiOperationMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type TdaiOperationDomain =
  | "gateway"
  | "l0"
  | "l1"
  | "l2"
  | "l3"
  | "meta"
  | "skill"
  | "knowledge"
  | "offload"
  | "admin";

export type TdaiOperationAccess = "read" | "write";

export type TdaiIdentityField =
  | "service"
  | "instance"
  | "team"
  | "agent"
  | "user"
  | "task"
  | "session";

export interface TdaiRouterSchemaReference {
  owner: "router";
  module: string;
}

export interface TdaiOperationDefinition {
  operationId: string;
  method: TdaiOperationMethod;
  route: string;
  requestSchema: TdaiRouterSchemaReference;
  domain: TdaiOperationDomain;
  access: TdaiOperationAccess;
  destructive: boolean;
  requiredIdentity: readonly TdaiIdentityField[];
  permission: string;
  public: true;
  deprecated?: boolean;
}

interface OperationSpec {
  method?: TdaiOperationMethod;
  route: string;
  domain: TdaiOperationDomain;
  access: TdaiOperationAccess;
  destructive?: boolean;
  requiredIdentity: readonly TdaiIdentityField[];
  permission?: string;
  schemaModule: string;
  deprecated?: boolean;
}

const STRICT_MEMORY_IDENTITY = [
  "service",
  "instance",
  "team",
  "agent",
  "user",
] as const satisfies readonly TdaiIdentityField[];

const STRICT_SESSION_IDENTITY = [
  ...STRICT_MEMORY_IDENTITY,
  "session",
] as const satisfies readonly TdaiIdentityField[];

const INSTANCE_IDENTITY = [
  "service",
  "instance",
] as const satisfies readonly TdaiIdentityField[];

// /v2 keeps the legacy isolation behavior: the Gateway authenticates the
// instance and may infer or default tenancy fields. /v3 data-plane routes
// require the strict team/agent/user triad server-side. Session remains an
// optional query dimension for /v3, so it is intentionally not listed here.
const V2_DATA_PLANE_IDENTITY = INSTANCE_IDENTITY;
const V3_DATA_PLANE_IDENTITY = [
  ...INSTANCE_IDENTITY,
  "team",
  "agent",
  "user",
] as const satisfies readonly TdaiIdentityField[];

const V1_SPECS: readonly OperationSpec[] = [
  { method: "GET", route: "/health", domain: "gateway", access: "read", requiredIdentity: [], permission: "gateway:health", schemaModule: "gateway/server" },
  { route: "/recall", domain: "gateway", access: "read", requiredIdentity: STRICT_SESSION_IDENTITY, permission: "memory:read", schemaModule: "gateway/server" },
  { route: "/capture", domain: "gateway", access: "write", requiredIdentity: STRICT_SESSION_IDENTITY, permission: "memory:write", schemaModule: "gateway/server" },
  { route: "/search/memories", domain: "gateway", access: "read", requiredIdentity: STRICT_MEMORY_IDENTITY, permission: "memory:read", schemaModule: "gateway/server" },
  { route: "/search/conversations", domain: "gateway", access: "read", requiredIdentity: STRICT_SESSION_IDENTITY, permission: "memory:read", schemaModule: "gateway/server" },
  { route: "/session/end", domain: "gateway", access: "write", requiredIdentity: STRICT_SESSION_IDENTITY, permission: "memory:write", schemaModule: "gateway/server" },
  { route: "/seed", domain: "admin", access: "write", requiredIdentity: INSTANCE_IDENTITY, permission: "admin:seed", schemaModule: "gateway/server" },
];

const DATA_PLANE_SPECS: readonly OperationSpec[] = [
  ...dataPlaneVersions("/conversation/add", "l0", "write"),
  ...dataPlaneVersions("/conversation/query", "l0", "read"),
  ...dataPlaneVersions("/conversation/search", "l0", "read"),
  ...dataPlaneVersions("/conversation/delete", "l0", "write", true),
  ...dataPlaneVersions("/conversation/count", "l0", "read", false, false),
  ...dataPlaneVersions("/atomic/update", "l1", "write"),
  ...dataPlaneVersions("/atomic/query", "l1", "read"),
  ...dataPlaneVersions("/atomic/search", "l1", "read"),
  ...dataPlaneVersions("/atomic/delete", "l1", "write", true),
  ...dataPlaneVersions("/atomic/count", "l1", "read", false, false),
  ...dataPlaneVersions("/scenario/ls", "l2", "read"),
  ...dataPlaneVersions("/scenario/read", "l2", "read"),
  ...dataPlaneVersions("/scenario/write", "l2", "write"),
  ...dataPlaneVersions("/scenario/rm", "l2", "write", true),
  ...dataPlaneVersions("/scenario/count", "l2", "read", false, false),
  ...dataPlaneVersions("/core/read", "l3", "read"),
  ...dataPlaneVersions("/core/write", "l3", "write"),
  ...dataPlaneVersions("/core/count", "l3", "read", false, false),
];

const DEPRECATED_V2_META_ROUTES = [
  "/v2/team/create",
  "/v2/team/get",
  "/v2/team/update",
  "/v2/team/delete",
  "/v2/user/create",
  "/v2/user/get",
  "/v2/user/update",
  "/v2/user/delete",
  "/v2/agent/create",
  "/v2/agent/get",
  "/v2/agent/update",
  "/v2/agent/delete",
  "/v2/task/create",
  "/v2/task/get",
  "/v2/task/update",
  "/v2/task/delete",
] as const;

const V2_META_SPECS: readonly OperationSpec[] = [
  ...DEPRECATED_V2_META_ROUTES.map((route): OperationSpec => ({
    route,
    domain: "meta",
    access: route.endsWith("/get") ? "read" : "write",
    destructive: route.endsWith("/delete"),
    requiredIdentity: INSTANCE_IDENTITY,
    permission: `meta:${route.endsWith("/get") ? "read" : "write"}`,
    schemaModule: "gateway/v2-schemas",
    deprecated: true,
  })),
  { route: "/v2/pipeline/status", domain: "admin", access: "read", requiredIdentity: INSTANCE_IDENTITY, permission: "admin:pipeline:read", schemaModule: "gateway/v2-router" },
];

const SKILL_ROUTES = [
  "/v3/skill/create",
  "/v3/skill/update",
  "/v3/skill/patch",
  "/v3/skill/delete",
  "/v3/skill/get",
  "/v3/skill/list",
  "/v3/skill/search",
  "/v3/skill/versions",
  "/v3/skill/files/write",
  "/v3/skill/files/remove",
  "/v3/skill/files/read",
  "/v3/skill/listing",
  "/v3/skill/extract",
  "/v3/skill/conversation/add",
  "/v3/skill/conversation/force-archive",
] as const;

const SKILL_SPECS = SKILL_ROUTES.map((route): OperationSpec => {
  const action = route.split("/").at(-1) ?? "";
  const read = ["get", "list", "search", "versions", "read", "listing"].includes(action);
  return {
    route,
    domain: "skill",
    access: read ? "read" : "write",
    destructive: ["delete", "remove", "force-archive"].includes(action),
    requiredIdentity: STRICT_MEMORY_IDENTITY,
    permission: `skill:${read ? "read" : "write"}`,
    schemaModule: "gateway/skill-schemas",
  };
});

const KNOWLEDGE_ROUTES = [
  "/v3/knowledge/create",
  "/v3/knowledge/get",
  "/v3/knowledge/update",
  "/v3/knowledge/delete",
  "/v3/knowledge/list",
] as const;

const KNOWLEDGE_SPECS = KNOWLEDGE_ROUTES.map((route): OperationSpec => {
  const action = route.split("/").at(-1) ?? "";
  const read = action === "get" || action === "list";
  return {
    route,
    domain: "knowledge",
    access: read ? "read" : "write",
    destructive: action === "delete",
    requiredIdentity: STRICT_MEMORY_IDENTITY,
    permission: `knowledge:${read ? "read" : "write"}`,
    schemaModule: "gateway/knowledge-schemas",
  };
});

const V3_META_ROUTES = [
  "/v3/meta/user/create",
  "/v3/meta/user/get",
  "/v3/meta/user/delete",
  "/v3/meta/user/list",
  "/v3/meta/user-key/create",
  "/v3/meta/user-key/list",
  "/v3/meta/user-key/get",
  "/v3/meta/user-key/revoke",
  "/v3/meta/user-key/update",
  "/v3/meta/team/create",
  "/v3/meta/team/get",
  "/v3/meta/team/update",
  "/v3/meta/team/delete",
  "/v3/meta/team/list",
  "/v3/meta/team-member/add",
  "/v3/meta/team-member/remove",
  "/v3/meta/team-member/list",
  "/v3/meta/team-member/get",
  "/v3/meta/agent/create",
  "/v3/meta/agent/get",
  "/v3/meta/agent/update",
  "/v3/meta/agent/delete",
  "/v3/meta/agent/list",
  "/v3/meta/agent/archive",
  "/v3/meta/task/create",
  "/v3/meta/task/get",
  "/v3/meta/task/update",
  "/v3/meta/task/delete",
  "/v3/meta/task/list",
  "/v3/meta/task/archive",
  "/v3/meta/task-agent/link",
  "/v3/meta/task-agent/unlink",
  "/v3/meta/task-agent/list",
  "/v3/meta/participation-log/append",
  "/v3/meta/participation-log/list",
  "/v3/meta/asset/create",
  "/v3/meta/asset/get",
  "/v3/meta/asset/update",
  "/v3/meta/asset/delete",
  "/v3/meta/asset/list",
  "/v3/meta/asset/list-accessible",
  "/v3/meta/asset/touch-usage",
  "/v3/meta/agent-fixed-asset/set",
  "/v3/meta/agent-fixed-asset/list",
  "/v3/meta/agent-fixed-asset/list-with-detail",
  "/v3/meta/agent-fixed-asset/summary-by-agents",
  "/v3/meta/acl/grant",
  "/v3/meta/acl/revoke",
  "/v3/meta/acl/list",
  "/v3/meta/acl/check",
  "/v3/meta/auth/verify",
  "/v3/meta/instance-quota/get",
  "/v3/meta/config/user/get",
  "/v3/meta/config/user/set",
] as const;

const META_READ_ACTIONS = new Set([
  "get",
  "list",
  "list-accessible",
  "list-with-detail",
  "summary-by-agents",
  "check",
  "verify",
]);

const META_DESTRUCTIVE_ACTIONS = new Set([
  "delete",
  "remove",
  "revoke",
  "archive",
  "unlink",
]);

const V3_META_SPECS = V3_META_ROUTES.map((route): OperationSpec => {
  const action = route.split("/").at(-1) ?? "";
  const read = META_READ_ACTIONS.has(action);
  return {
    route,
    domain: "meta",
    access: read ? "read" : "write",
    destructive: META_DESTRUCTIVE_ACTIONS.has(action),
    requiredIdentity: INSTANCE_IDENTITY,
    permission: `meta:${read ? "read" : "write"}`,
    schemaModule: "metadata/router/v3-meta-schemas",
  };
});

const OFFLOAD_SPECS: readonly OperationSpec[] = [
  { route: "/v2/offload/ingest", domain: "offload", access: "write", requiredIdentity: STRICT_SESSION_IDENTITY, permission: "offload:write", schemaModule: "offload_server/schemas" },
  { route: "/v2/offload/query-mmd", domain: "offload", access: "read", requiredIdentity: STRICT_SESSION_IDENTITY, permission: "offload:read", schemaModule: "offload_server/schemas" },
  { route: "/v2/offload/compact", domain: "offload", access: "write", requiredIdentity: STRICT_SESSION_IDENTITY, permission: "offload:write", schemaModule: "offload_server/schemas" },
];

const ADMIN_SPECS: readonly OperationSpec[] = [
  { route: "/v2/instance/destroy", domain: "admin", access: "write", destructive: true, requiredIdentity: INSTANCE_IDENTITY, permission: "admin:instance:destroy", schemaModule: "gateway/server" },
  { route: "/v3/instance/destroy", domain: "admin", access: "write", destructive: true, requiredIdentity: INSTANCE_IDENTITY, permission: "admin:instance:destroy", schemaModule: "gateway/server" },
];

const PUBLIC_OPERATION_SPECS: readonly OperationSpec[] = [
  ...V1_SPECS,
  ...DATA_PLANE_SPECS,
  ...V2_META_SPECS,
  ...SKILL_SPECS,
  ...KNOWLEDGE_SPECS,
  ...V3_META_SPECS,
  ...OFFLOAD_SPECS,
  ...ADMIN_SPECS,
];

function dataPlaneVersions(
  subpath: string,
  domain: "l0" | "l1" | "l2" | "l3",
  access: TdaiOperationAccess,
  destructive = false,
  exposeV2 = true,
): OperationSpec[] {
  const versions = exposeV2 ? ["v2", "v3"] : ["v3"];
  return versions.map((version) => ({
    route: `/${version}${subpath}`,
    domain,
    access,
    destructive,
    requiredIdentity: version === "v3"
      ? V3_DATA_PLANE_IDENTITY
      : V2_DATA_PLANE_IDENTITY,
    permission: `memory:${access}`,
    schemaModule: "gateway/v2-schemas",
  }));
}

function operationIdFor(route: string): string {
  const parts = route.split("/").filter(Boolean);
  const prefix = parts[0]?.match(/^v\d+$/) ? "tdai" : "tdai.gateway";
  return [prefix, ...parts].join(".").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function defineOperation(spec: OperationSpec): TdaiOperationDefinition {
  return Object.freeze({
    operationId: operationIdFor(spec.route),
    method: spec.method ?? "POST",
    route: spec.route,
    requestSchema: Object.freeze({
      owner: "router" as const,
      module: spec.schemaModule,
    }),
    domain: spec.domain,
    access: spec.access,
    destructive: spec.destructive ?? false,
    requiredIdentity: Object.freeze([...spec.requiredIdentity]),
    permission: spec.permission ?? `${spec.domain}:${spec.access}`,
    public: true as const,
    ...(spec.deprecated ? { deprecated: true } : {}),
  });
}

function routeKey(method: TdaiOperationMethod, route: string): string {
  return `${method} ${route}`;
}

function assertPublicRoute(definition: TdaiOperationDefinition): void {
  if (!definition.route.startsWith("/")) {
    throw new Error(`TDAI operation route must be absolute: ${definition.route}`);
  }
  if (/^\/v\d+\/internal(?:\/|$)/.test(definition.route)) {
    throw new Error(`Internal TDAI route cannot be registered: ${definition.route}`);
  }
}

export class TdaiOperationRegistry {
  readonly #byId = new Map<string, TdaiOperationDefinition>();
  readonly #byRoute = new Map<string, TdaiOperationDefinition>();

  constructor(definitions: readonly TdaiOperationDefinition[]) {
    for (const definition of definitions) {
      assertPublicRoute(definition);
      const key = routeKey(definition.method, definition.route);
      if (this.#byId.has(definition.operationId)) {
        throw new Error(`Duplicate TDAI operation id: ${definition.operationId}`);
      }
      if (this.#byRoute.has(key)) {
        throw new Error(`Duplicate TDAI operation route: ${key}`);
      }
      this.#byId.set(definition.operationId, definition);
      this.#byRoute.set(key, definition);
    }
  }

  list(): readonly TdaiOperationDefinition[] {
    return Object.freeze([...this.#byId.values()]);
  }

  describe(operationId: string): TdaiOperationDefinition | undefined {
    return this.#byId.get(operationId);
  }

  findByRoute(
    method: TdaiOperationMethod,
    route: string,
  ): TdaiOperationDefinition | undefined {
    return this.#byRoute.get(routeKey(method, route));
  }
}

export function createTdaiOperationRegistry(): TdaiOperationRegistry {
  return new TdaiOperationRegistry(PUBLIC_OPERATION_SPECS.map(defineOperation));
}
