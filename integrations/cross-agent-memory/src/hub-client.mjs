const DEFAULT_TIMEOUT_MS = 1200;

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid Hub client configuration: ${field}`);
  }
  return value.trim();
}

function positiveInteger(value, field, defaultValue) {
  const resolved = value === undefined ? defaultValue : value;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`Invalid Hub client configuration: ${field}`);
  }
  return resolved;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validLayerCounts(value) {
  return isObject(value) && ["L0_messages", "L1", "L2", "L3"].every((field) => nonNegativeInteger(value[field]));
}

function validBlock(block) {
  return isObject(block) &&
    typeof block.id === "string" && block.id !== "" &&
    typeof block.title === "string" &&
    typeof block.summary === "string" &&
    typeof block.uploaded_by_user_id === "string" && block.uploaded_by_user_id !== "" &&
    typeof block.updated_at_ms === "number" && Number.isFinite(block.updated_at_ms) && block.updated_at_ms >= 0 &&
    validLayerCounts(block.layer_counts) &&
    (block.scope === "team" || block.scope === "private") &&
    typeof block.agent_id === "string" && block.agent_id !== "";
}

function validLayerItem(item) {
  return isObject(item) && typeof item.id === "string" && typeof item.title === "string" && typeof item.body === "string" &&
    (item.role === undefined || typeof item.role === "string") &&
    (item.tags === undefined || Array.isArray(item.tags)) &&
    (item.refs === undefined || Array.isArray(item.refs)) &&
    (item.created_at === undefined || typeof item.created_at === "string");
}

export class HubClient {
  constructor({ endpoint, serviceId, userKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.endpoint = requiredString(endpoint, "endpoint").replace(/\/+$/, "");
    this.serviceId = requiredString(serviceId, "serviceId");
    this.userKey = requiredString(userKey, "userKey");
    this.timeoutMs = positiveInteger(timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS);
  }

  async listMyAgents({ teamId }) {
    const data = await this.#post("/api/v1/chat-memory/my-agents", { team_id: teamId });
    if (!isObject(data) || !Array.isArray(data.items) || !nonNegativeInteger(data.total) ||
      data.total !== data.items.length || !data.items.every(validBlock)) {
      throw new Error("Invalid Memory Hub block response");
    }
    return data;
  }

  async readLayer({ blockId, layer, limit, offset }) {
    const data = await this.#post("/api/v1/chat-memory/layer", {
      block_id: blockId,
      layer,
      limit,
      offset
    });
    if (!isObject(data) || data.layer !== layer || !Array.isArray(data.items) || !data.items.every(validLayerItem) ||
      !nonNegativeInteger(data.total) || data.limit !== limit || data.offset !== offset || data.items.length > limit ||
      data.total < offset + data.items.length ||
      (offset === 0 && ((data.total === 0) !== (data.items.length === 0)))) {
      throw new Error("Invalid Memory Hub layer response");
    }
    return data;
  }

  async #post(path, body) {
    let response;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "X-Tdai-Service-Id": this.serviceId,
          "X-Tdai-User-Key": this.userKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error("Memory Hub API unavailable");
    }
    if (!response.ok) throw new Error("Memory Hub API rejected the request");
    let envelope;
    try {
      envelope = JSON.parse(await response.text());
    } catch {
      throw new Error("Invalid Memory Hub API response");
    }
    if (!isObject(envelope) || typeof envelope.code !== "number" || typeof envelope.message !== "string" ||
      typeof envelope.request_id !== "string" || !Object.hasOwn(envelope, "data")) {
      throw new Error("Invalid Memory Hub API response");
    }
    if (envelope.code !== 0) throw new Error("Memory Hub API rejected the request");
    return envelope.data;
  }
}
