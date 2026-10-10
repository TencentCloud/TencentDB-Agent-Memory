const MAX_LIST_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 3000;

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid metadata client configuration: ${field}`);
  }
  return value.trim();
}

function positiveInteger(value, field, defaultValue) {
  const resolved = value === undefined ? defaultValue : value;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`Invalid metadata client configuration: ${field}`);
  }
  return resolved;
}

function validListPage(data, { limit, offset, total }) {
  if (
    data === null || typeof data !== "object" || Array.isArray(data) ||
    !Array.isArray(data.items) ||
    !Number.isInteger(data.total) || data.total < 0 ||
    !Number.isInteger(data.limit) || data.limit !== limit ||
    !Number.isInteger(data.offset) || data.offset !== offset ||
    data.items.length > limit ||
    data.total < offset + data.items.length ||
    (total !== null && data.total !== total)
  ) {
    throw new Error("Invalid Metadata API list response");
  }

  const nextOffset = offset + data.items.length;
  if (nextOffset < data.total && (data.items.length === 0 || data.items.length < limit)) {
    throw new Error("Invalid Metadata API list response");
  }
  return data;
}

export class MetadataClient {
  constructor({ endpoint, apiKey, serviceId, userKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.endpoint = requiredString(endpoint, "endpoint").replace(/\/+$/, "");
    this.apiKey = requiredString(apiKey, "apiKey");
    this.serviceId = requiredString(serviceId, "serviceId");
    this.userKey = requiredString(userKey, "userKey");
    this.timeoutMs = positiveInteger(timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS);
  }

  async verifyCurrentUser() {
    const data = await this.#post("/v3/meta/auth/verify", { user_key: this.userKey });
    if (data === null || typeof data !== "object" || Array.isArray(data) || data.valid !== true) {
      throw new Error("Metadata authentication was not accepted");
    }
    return data.user;
  }

  async listTeams({ userId, name }) {
    return this.#listAll("/v3/meta/team/list", { user_id: userId, name });
  }

  async createTeam({ name, ownerUserId }) {
    return this.#post("/v3/meta/team/create", { name, owner_user_id: ownerUserId });
  }

  async listAgents({ teamId, name }) {
    return this.#listAll("/v3/meta/agent/list", { team_id: teamId, name });
  }

  async createAgent({ teamId, ownerUserId, name, visibility = "team" }) {
    return this.#post("/v3/meta/agent/create", {
      team_id: teamId,
      owner_user_id: ownerUserId,
      name,
      visibility
    });
  }

  async listTasks({ teamId, title }) {
    return this.#listAll("/v3/meta/task/list", { team_id: teamId, title });
  }

  async createTask({ teamId, creatorUserId, title, agentId }) {
    return this.#post("/v3/meta/task/create", {
      team_id: teamId,
      creator_user_id: creatorUserId,
      title,
      linked_agents: [{ agent_id: agentId }]
    });
  }

  async listTaskAgents({ taskId }) {
    return this.#listAll("/v3/meta/task-agent/list", { task_id: taskId });
  }

  async getUser(userId) { return this.#post("/v3/meta/user/get", { user_id: userId }); }
  async getTeam(teamId) { return this.#post("/v3/meta/team/get", { team_id: teamId }); }
  async getAgent(agentId) { return this.#post("/v3/meta/agent/get", { agent_id: agentId }); }
  async getTask(taskId) { return this.#post("/v3/meta/task/get", { task_id: taskId }); }
  async getAsset(assetId) { return this.#post("/v3/meta/asset/get", { asset_id: assetId }); }

  async listChatMemoryAssets({ teamId }) {
    return this.#listAll("/v3/meta/asset/list", {
      team_id: teamId,
      asset_type: "chat_memory"
    });
  }

  async #listAll(path, body) {
    const items = [];
    let offset = 0;
    let total = null;
    for (;;) {
      const page = validListPage(
        await this.#post(path, { ...body, limit: MAX_LIST_LIMIT, offset }),
        { limit: MAX_LIST_LIMIT, offset, total }
      );
      total ??= page.total;
      items.push(...page.items);
      if (items.length === total) return items;
      offset += page.items.length;
    }
  }

  async #post(path, body) {
    let response;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "x-tdai-service-id": this.serviceId,
          "x-tdai-user-key": this.userKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error("Metadata API unavailable");
    }
    if (!response.ok) throw new Error("Metadata API rejected the request");
    let envelope;
    try {
      envelope = JSON.parse(await response.text());
    } catch {
      throw new Error("Invalid Metadata API response");
    }
    if (
      envelope === null || typeof envelope !== "object" || Array.isArray(envelope) ||
      typeof envelope.code !== "number" || typeof envelope.message !== "string" ||
      typeof envelope.request_id !== "string" || !Object.hasOwn(envelope, "data") || envelope.code !== 0
    ) {
      throw new Error("Invalid Metadata API response");
    }
    return envelope.data;
  }
}
