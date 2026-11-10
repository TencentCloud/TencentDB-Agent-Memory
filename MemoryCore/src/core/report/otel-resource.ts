import type { Resource } from "@opentelemetry/resources";

interface OTelResourcesModule {
  resourceFromAttributes?: (attributes: Record<string, string>) => Resource;
  Resource?: new (attributes: Record<string, string>) => Resource;
}

export function createOTelResource(
  resourcesModule: OTelResourcesModule,
  attributes: Record<string, string>,
): Resource {
  if (typeof resourcesModule.resourceFromAttributes === "function") {
    return resourcesModule.resourceFromAttributes(attributes);
  }
  if (typeof resourcesModule.Resource === "function") {
    return new resourcesModule.Resource(attributes);
  }

  throw new Error(
    "@opentelemetry/resources exposes neither resourceFromAttributes() nor Resource",
  );
}
