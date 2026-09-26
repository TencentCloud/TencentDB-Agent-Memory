export type ForgetCandidateKind = "memory-prompt" | "skill";

export interface ForgetCandidate {
  actionId: string;
  kind: ForgetCandidateKind;
  name: string;
  preview: string;
  detail: string;
}

export interface ForgetDiscovery {
  state: "select";
  candidates: ForgetCandidate[];
}

export interface ForgetClient {
  preview(keyword: string): Promise<ForgetDiscovery>;
  confirm(actionId: string): Promise<void>;
}

interface ForgetClientOptions {
  proxyBase: string;
  spaceId: string;
  userKey: string;
  conversationId: string;
  fetcher?: typeof fetch;
}

export class ProxyForgetClient implements ForgetClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;

  constructor(options: ForgetClientOptions) {
    this.baseUrl = `${options.proxyBase.replace(/\/$/, "")}/v3/pi/memory-forget`;
    this.headers = {
      Authorization: `Bearer ${options.userKey}`,
      "Content-Type": "application/json",
      "x-tdai-service-id": options.spaceId,
      "x-conversation-id": options.conversationId,
    };
    this.fetcher = options.fetcher ?? fetch;
  }

  preview(keyword: string): Promise<ForgetDiscovery> {
    return this.post<ForgetDiscovery>("preview", { keyword });
  }

  async confirm(actionId: string): Promise<void> {
    try {
      await this.post("confirm", { action_id: actionId });
    } catch {
      throw new Error("memory deletion could not be confirmed; run a fresh preview");
    }
  }

  private async post<T>(path: string, body: Record<string, string>): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`memory forget request failed (${response.status})`);
    }

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") {
      throw new Error("memory forget response was malformed");
    }
    const record = payload as Record<string, unknown>;
    if (record.code === 0 && record.data && typeof record.data === "object") {
      return record.data as T;
    }
    if ("state" in record) return record as T;
    throw new Error("memory forget request was rejected");
  }
}
