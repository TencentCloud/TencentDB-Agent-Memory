export type PublicGatewayMethod = "GET" | "POST";

export interface PublicGatewayRoute {
  method: PublicGatewayMethod;
  route: string;
}

/** Legacy v1 routes that remain public through GatewayMemoryClient. */
export const GATEWAY_V1_PUBLIC_ROUTES = Object.freeze([
  { method: "GET", route: "/health" },
  { method: "POST", route: "/recall" },
  { method: "POST", route: "/capture" },
  { method: "POST", route: "/search/memories" },
  { method: "POST", route: "/search/conversations" },
  { method: "POST", route: "/session/end" },
  { method: "POST", route: "/seed" },
] satisfies readonly PublicGatewayRoute[]);

/** Authenticated offload routes exposed by the Gateway. */
export const OFFLOAD_V2_PUBLIC_ROUTES = Object.freeze([
  { method: "POST", route: "/v2/offload/ingest" },
  { method: "POST", route: "/v2/offload/query-mmd" },
  { method: "POST", route: "/v2/offload/compact" },
] satisfies readonly PublicGatewayRoute[]);

/** Explicit admin routes. They are public HTTP surfaces, but never default MCP tools. */
export const GATEWAY_ADMIN_PUBLIC_ROUTES = Object.freeze([
  { method: "POST", route: "/v2/instance/destroy" },
  { method: "POST", route: "/v3/instance/destroy" },
] satisfies readonly PublicGatewayRoute[]);

export const GATEWAY_PUBLIC_ROUTES = Object.freeze([
  ...GATEWAY_V1_PUBLIC_ROUTES,
  ...OFFLOAD_V2_PUBLIC_ROUTES,
  ...GATEWAY_ADMIN_PUBLIC_ROUTES,
]);

export function publicGatewayRouteKey(route: PublicGatewayRoute): string {
  return `${route.method} ${route.route}`;
}

export const GATEWAY_ROUTE_KEYS = Object.freeze({
  health: "GET /health",
  recall: "POST /recall",
  capture: "POST /capture",
  memorySearch: "POST /search/memories",
  conversationSearch: "POST /search/conversations",
  sessionEnd: "POST /session/end",
  seed: "POST /seed",
  instanceDestroyV2: "POST /v2/instance/destroy",
  instanceDestroyV3: "POST /v3/instance/destroy",
  offloadIngest: "POST /v2/offload/ingest",
  offloadQueryMmd: "POST /v2/offload/query-mmd",
  offloadCompact: "POST /v2/offload/compact",
});
