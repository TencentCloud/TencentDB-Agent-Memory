declare module "openclaw/plugin-sdk/provider-auth-api-key" {
  export function createProviderApiKeyAuthMethod(options: Record<string, unknown>): any;
}

declare module "openclaw/plugin-sdk/provider-catalog-shared" {
  export function buildSingleProviderApiKeyCatalog(options: Record<string, unknown>): Promise<any> | any;
}
