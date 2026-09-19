export type ForgetCandidateKind = "memory-prompt" | "skill";

export interface ForgetCandidate {
  key: string;
  kind: ForgetCandidateKind;
  name: string;
  preview: string;
  detail: string;
  impact: string;
}

export interface ForgetDiscovery {
  state: "select";
  candidates: ForgetCandidate[];
}

export interface ForgetPrepared {
  state: "pending";
  actionId: string;
  candidate: ForgetCandidate;
}

export type ForgetPreviewResult = ForgetDiscovery | ForgetPrepared;

export interface ForgetConfirmResult {
  state: "completed";
  alreadyCompleted: boolean;
  candidate: Pick<ForgetCandidate, "kind" | "name">;
}

export interface ForgetCancelResult {
  state: "cancelled" | "already-completed" | "missing";
}

export interface ForgetClient {
  preview(keyword: string, candidateKey?: string): Promise<ForgetPreviewResult>;
  confirm(actionId: string): Promise<ForgetConfirmResult>;
  cancel(actionId: string): Promise<ForgetCancelResult>;
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

  preview(keyword: string, candidateKey?: string): Promise<ForgetPreviewResult> {
    return this.post<ForgetPreviewResult>("preview", {
      keyword,
      ...(candidateKey ? { candidate_key: candidateKey } : {}),
    });
  }

  confirm(actionId: string): Promise<ForgetConfirmResult> {
    return this.post<ForgetConfirmResult>("confirm", { action_id: actionId });
  }

  cancel(actionId: string): Promise<ForgetCancelResult> {
    return this.post<ForgetCancelResult>("cancel", { action_id: actionId });
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
