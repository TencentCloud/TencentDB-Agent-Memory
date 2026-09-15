import { describe, expect, it } from "vitest";
import { KNOWLEDGE_PUBLIC_ROUTES } from "../../gateway/knowledge-handlers.js";
import { GATEWAY_PUBLIC_ROUTES, publicGatewayRouteKey } from "../../gateway/public-routes.js";
import { SKILL_PUBLIC_ROUTES } from "../../gateway/skill-handlers.js";
import { V2_V3_PUBLIC_ROUTES } from "../../gateway/v2-router.js";
import { V3_INTERNAL_ROUTES } from "../../metadata/router/internal-meta-router.js";
import { V3_ROUTES } from "../../metadata/router/v3-meta-router.js";
import {
  createTdaiOperationRegistry,
  TdaiOperationRegistry,
  type TdaiOperationDefinition,
} from "./operation-registry.js";

function postRouteKey(route: string): string {
  return `POST ${route}`;
}

describe("TdaiOperationRegistry", () => {
  it("covers every public Gateway route owned by the current routers", () => {
    const expected = [
      ...GATEWAY_PUBLIC_ROUTES.map(publicGatewayRouteKey),
      ...V2_V3_PUBLIC_ROUTES.map(postRouteKey),
      ...SKILL_PUBLIC_ROUTES.map(postRouteKey),
      ...KNOWLEDGE_PUBLIC_ROUTES.map(postRouteKey),
      ...V3_ROUTES.map(postRouteKey),
    ].sort();
    const actual = createTdaiOperationRegistry()
      .list()
      .map((operation) => `${operation.method} ${operation.route}`)
      .sort();

    expect(actual).toEqual(expected);
  });

  it("describes routes by stable operation id and by method plus route", () => {
    const registry = createTdaiOperationRegistry();
    const operation = registry.describe("tdai.v3.skill.search");

    expect(operation).toMatchObject({
      method: "POST",
      route: "/v3/skill/search",
      domain: "skill",
      access: "read",
      destructive: false,
      permission: "skill:read",
      public: true,
    });
    expect(registry.findByRoute("POST", "/v3/skill/search"))
      .toBe(operation);
  });

  it("marks destructive and deprecated surfaces explicitly", () => {
    const registry = createTdaiOperationRegistry();

    expect(registry.describe("tdai.v3.instance.destroy"))
      .toMatchObject({ domain: "admin", access: "write", destructive: true });
    expect(registry.describe("tdai.v2.team.delete"))
      .toMatchObject({ domain: "meta", destructive: true, deprecated: true });
    expect(registry.describe("tdai.v2.conversation.search")?.requiredIdentity)
      .toEqual(["service", "instance"]);
    expect(registry.describe("tdai.v3.conversation.search")?.requiredIdentity)
      .toEqual(["service", "instance", "team", "agent", "user"]);
  });

  it("does not describe internal routes and rejects attempts to register them", () => {
    const registry = createTdaiOperationRegistry();
    for (const route of V3_INTERNAL_ROUTES) {
      expect(registry.findByRoute("POST", route)).toBeUndefined();
    }

    const internal = {
      operationId: "tdai.v3.internal.meta.user.init-admin",
      method: "POST",
      route: V3_INTERNAL_ROUTES[0]!,
      requestSchema: { owner: "router", module: "metadata/router/internal-meta-router" },
      domain: "admin",
      access: "write",
      destructive: true,
      requiredIdentity: ["service", "instance"],
      permission: "internal:admin",
      public: true,
    } as const satisfies TdaiOperationDefinition;

    expect(() => new TdaiOperationRegistry([internal]))
      .toThrow(/Internal TDAI route cannot be registered/);
  });

  it("rejects duplicate operation ids and duplicate method-route pairs", () => {
    const base = createTdaiOperationRegistry().list()[0];
    expect(base).toBeDefined();

    expect(() => new TdaiOperationRegistry([base!, base!]))
      .toThrow(/Duplicate TDAI operation id/);

    const duplicateRoute = { ...base!, operationId: `${base!.operationId}.duplicate` };
    expect(() => new TdaiOperationRegistry([base!, duplicateRoute]))
      .toThrow(/Duplicate TDAI operation route/);
  });
});
