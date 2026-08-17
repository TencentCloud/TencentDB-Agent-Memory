import { createHash } from "node:crypto";
//#region src/adapters/gateway-client/errors.ts
var GatewayMemoryClientError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = new.target.name;
	}
};
var GatewayConfigurationError = class extends GatewayMemoryClientError {};
var GatewayTransportError = class extends GatewayMemoryClientError {
	url;
	constructor(url, cause) {
		super(`Gateway request failed: ${url}`, { cause });
		this.url = url;
	}
};
var GatewayTimeoutError = class extends GatewayTransportError {
	timeoutMs;
	constructor(url, timeoutMs, cause) {
		super(url, cause);
		this.timeoutMs = timeoutMs;
		this.message = `Gateway request timed out after ${timeoutMs}ms: ${url}`;
	}
};
/**
* The Gateway attempted to redirect the request.
*
* Redirects are deliberately rejected so a trusted loopback URL cannot move a
* request (and its Bearer token) to an unvalidated destination.
*/
var GatewayRedirectError = class extends GatewayMemoryClientError {
	url;
	status;
	location;
	constructor(url, status, location) {
		super(`Gateway redirect rejected${location ? ` to ${location}` : ""}: ${url}`);
		this.url = url;
		this.status = status;
		this.location = location;
	}
};
var GatewayHttpError = class extends GatewayMemoryClientError {
	status;
	responseBody;
	url;
	constructor(url, status, responseBody) {
		super(`Gateway returned HTTP ${status}: ${url}`);
		this.url = url;
		this.status = status;
		this.responseBody = responseBody;
	}
};
var GatewayResponseError = class extends GatewayMemoryClientError {
	url;
	responseBody;
	reason;
	constructor(url, responseBody, cause, reason) {
		super(`Gateway returned an invalid response${reason ? ` (${reason})` : ""}: ${url}`, { cause });
		this.url = url;
		this.responseBody = responseBody;
		this.reason = reason;
	}
};
/** The Gateway returned a successful HTTP response that was not valid JSON. */
var GatewayParseError = class extends GatewayResponseError {
	constructor(url, responseBody, cause) {
		super(url, responseBody, cause, "malformed JSON");
	}
};
//#endregion
//#region src/adapters/gateway-client/client.ts
const DEFAULT_BASE_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 1e4;
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function isNonNegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0;
}
function isHealthResponse(value) {
	if (!isRecord(value) || !isRecord(value.stores)) return false;
	return (value.status === "ok" || value.status === "degraded") && typeof value.version === "string" && isNonNegativeInteger(value.uptime) && typeof value.stores.vectorStore === "boolean" && typeof value.stores.embeddingService === "boolean";
}
function isRecallResponse(value) {
	return isRecord(value) && typeof value.context === "string" && (value.prepend_context === void 0 || typeof value.prepend_context === "string") && (value.append_system_context === void 0 || typeof value.append_system_context === "string") && (value.strategy === void 0 || typeof value.strategy === "string") && (value.memory_count === void 0 || isNonNegativeInteger(value.memory_count));
}
function isCaptureResponse(value) {
	return isRecord(value) && isNonNegativeInteger(value.l0_recorded) && typeof value.scheduler_notified === "boolean";
}
function isMemorySearchResponse(value) {
	return isRecord(value) && typeof value.results === "string" && isNonNegativeInteger(value.total) && typeof value.strategy === "string";
}
function isConversationSearchResponse(value) {
	return isRecord(value) && typeof value.results === "string" && isNonNegativeInteger(value.total);
}
function isSessionEndResponse(value) {
	return isRecord(value) && typeof value.flushed === "boolean";
}
function isLoopbackHostname(hostname) {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1";
}
function normalizeBaseUrl(raw, allowRemote) {
	let parsed;
	try {
		parsed = new URL(raw);
	} catch (cause) {
		throw new GatewayConfigurationError(`Invalid Gateway base URL: ${raw}`, { cause });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new GatewayConfigurationError("Gateway base URL must use http: or https:");
	if (parsed.username || parsed.password) throw new GatewayConfigurationError("Gateway base URL must not contain credentials");
	if (parsed.search || parsed.hash) throw new GatewayConfigurationError("Gateway base URL must not contain a query or fragment");
	if (!allowRemote && !isLoopbackHostname(parsed.hostname)) throw new GatewayConfigurationError(`Remote Gateway host "${parsed.hostname}" requires allowRemote: true`);
	return parsed.toString().replace(/\/+$/, "");
}
function requireText(value, field) {
	const text = value?.trim();
	if (!text) throw new GatewayConfigurationError(`${field} must be a non-empty string`);
	return text;
}
function optionalText(value, field) {
	return value === void 0 ? void 0 : requireText(value, field);
}
function optionalLimit(value) {
	if (value === void 0) return void 0;
	if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new GatewayConfigurationError("limit must be an integer between 1 and 50");
	return value;
}
function normalizeMessages(messages) {
	if (messages === void 0) return void 0;
	if (!Array.isArray(messages) || messages.length === 0) throw new GatewayConfigurationError("messages must be a non-empty array when provided");
	return messages.map((message, index) => {
		if (!isRecord(message)) throw new GatewayConfigurationError(`messages[${index}] must be an object`);
		const role = requireText(message.role, `messages[${index}].role`);
		const content = requireText(message.content, `messages[${index}].content`);
		if (message.timestamp !== void 0 && (!Number.isSafeInteger(message.timestamp) || message.timestamp <= 0)) throw new GatewayConfigurationError(`messages[${index}].timestamp must be a positive safe integer`);
		return {
			...message,
			role,
			content
		};
	});
}
var GatewayMemoryClient = class {
	baseUrl;
	apiKey;
	timeoutMs;
	fetchImpl;
	constructor(options = {}) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL, options.allowRemote ?? false);
		this.apiKey = options.apiKey?.trim() || void 0;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new GatewayConfigurationError("timeoutMs must be a positive finite number");
		const fetchImpl = options.fetch ?? globalThis.fetch;
		if (typeof fetchImpl !== "function") throw new GatewayConfigurationError("A fetch implementation is required");
		this.fetchImpl = fetchImpl.bind(globalThis);
	}
	health() {
		return this.request("GET", "/health", void 0, isHealthResponse);
	}
	recall(input) {
		const userId = optionalText(input.userId, "userId");
		return this.request("POST", "/recall", {
			query: requireText(input.query, "query"),
			session_key: requireText(input.sessionKey, "sessionKey"),
			...userId ? { user_id: userId } : {}
		}, isRecallResponse);
	}
	capture(input) {
		const sessionId = optionalText(input.sessionId, "sessionId");
		const userId = optionalText(input.userId, "userId");
		const messages = normalizeMessages(input.messages);
		return this.request("POST", "/capture", {
			user_content: requireText(input.userContent, "userContent"),
			assistant_content: requireText(input.assistantContent, "assistantContent"),
			session_key: requireText(input.sessionKey, "sessionKey"),
			...sessionId ? { session_id: sessionId } : {},
			...userId ? { user_id: userId } : {},
			...messages ? { messages } : {}
		}, isCaptureResponse);
	}
	searchMemories(input) {
		const limit = optionalLimit(input.limit);
		const type = optionalText(input.type, "type");
		const scene = optionalText(input.scene, "scene");
		return this.request("POST", "/search/memories", {
			query: requireText(input.query, "query"),
			...limit !== void 0 ? { limit } : {},
			...type ? { type } : {},
			...scene ? { scene } : {}
		}, isMemorySearchResponse);
	}
	searchConversations(input) {
		const limit = optionalLimit(input.limit);
		const sessionKey = optionalText(input.sessionKey, "sessionKey");
		return this.request("POST", "/search/conversations", {
			query: requireText(input.query, "query"),
			...limit !== void 0 ? { limit } : {},
			...sessionKey ? { session_key: sessionKey } : {}
		}, isConversationSearchResponse);
	}
	endSession(input) {
		const userId = optionalText(input.userId, "userId");
		return this.request("POST", "/session/end", {
			session_key: requireText(input.sessionKey, "sessionKey"),
			...userId ? { user_id: userId } : {}
		}, isSessionEndResponse);
	}
	async request(method, path, body, validate) {
		const url = `${this.baseUrl}${path}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let encodedBody;
		try {
			encodedBody = body === void 0 ? void 0 : JSON.stringify(body);
		} catch (cause) {
			clearTimeout(timer);
			throw new GatewayConfigurationError("Gateway request body must be JSON-serializable", { cause });
		}
		let response;
		try {
			const headers = {};
			if (body !== void 0) headers["Content-Type"] = "application/json";
			if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
			response = await this.fetchImpl(url, {
				method,
				headers,
				body: encodedBody,
				signal: controller.signal,
				redirect: "manual"
			});
		} catch (cause) {
			clearTimeout(timer);
			if (controller.signal.aborted) throw new GatewayTimeoutError(url, this.timeoutMs, cause);
			throw new GatewayTransportError(url, cause);
		}
		if (response.redirected || response.status >= 300 && response.status < 400) {
			clearTimeout(timer);
			throw new GatewayRedirectError(url, response.status, (response.headers.get("location") ?? response.url) || void 0);
		}
		let responseBody;
		try {
			responseBody = await response.text();
		} catch (cause) {
			if (controller.signal.aborted) throw new GatewayTimeoutError(url, this.timeoutMs, cause);
			throw new GatewayTransportError(url, cause);
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) throw new GatewayHttpError(url, response.status, responseBody);
		let parsed;
		try {
			parsed = JSON.parse(responseBody);
		} catch (cause) {
			throw new GatewayParseError(url, responseBody, cause);
		}
		if (!isRecord(parsed)) throw new GatewayResponseError(url, responseBody, void 0, "expected JSON object");
		if (validate && !validate(parsed)) throw new GatewayResponseError(url, responseBody, void 0, "unexpected schema");
		return parsed;
	}
};
//#endregion
//#region src/adapters/gateway-client/platform-adapter.ts
function createGatewayPlatformAdapter(binding, client) {
	return {
		client,
		async beforePrompt(event) {
			const identity = binding.getSessionIdentity(event);
			const response = await client.recall({
				query: binding.getRecallQuery(event),
				sessionKey: identity.sessionKey,
				userId: identity.userId
			});
			return binding.formatRecall(response, event);
		},
		async turnCommitted(event) {
			const turn = binding.getCompletedTurn(event);
			if (!turn) return null;
			const identity = binding.getSessionIdentity(event);
			return client.capture({
				...turn,
				sessionKey: identity.sessionKey,
				sessionId: identity.sessionId,
				userId: identity.userId
			});
		},
		async sessionEnd(event) {
			const identity = binding.getSessionIdentity(event);
			return client.endSession({
				sessionKey: identity.sessionKey,
				userId: identity.userId
			});
		}
	};
}
//#endregion
//#region src/adapters/gateway-client/environment.ts
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
function gatewayClientOptionsFromEnv(env = process.env) {
	const timeoutRaw = env.TDAI_GATEWAY_TIMEOUT_MS?.trim();
	const timeoutMs = timeoutRaw ? Number(timeoutRaw) : void 0;
	return {
		baseUrl: env.TDAI_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL,
		apiKey: env.TDAI_GATEWAY_API_KEY,
		timeoutMs,
		allowRemote: /^(1|true|yes)$/i.test(env.TDAI_GATEWAY_ALLOW_REMOTE?.trim() ?? "")
	};
}
//#endregion
//#region src/adapters/gateway-client/identity.ts
function required(value, name) {
	const normalized = value?.trim();
	if (!normalized) throw new GatewayConfigurationError(`Missing TencentDB Agent Memory identity: ${name}`);
	return normalized;
}
function optional(value) {
	return value?.trim() || void 0;
}
function deriveTdaiSessionKey(identity) {
	const canonical = JSON.stringify([
		identity.serviceId,
		identity.instanceId,
		identity.teamId,
		identity.agentId,
		identity.userId,
		identity.taskId ?? null,
		identity.sessionId
	]);
	return `codex:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}
/**
* Validate an identity supplied by an embedding caller such as the MCP
* server. TypeScript types do not protect runtime/plugin boundaries, so the
* derived session key is checked instead of trusting caller-controlled state.
*/
function assertTdaiIdentity(identity) {
	if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new GatewayConfigurationError("Invalid TencentDB Agent Memory identity: expected an object");
	const candidate = identity;
	const fields = [
		["serviceId", candidate.serviceId],
		["instanceId", candidate.instanceId],
		["teamId", candidate.teamId],
		["agentId", candidate.agentId],
		["userId", candidate.userId],
		["sessionId", candidate.sessionId]
	];
	for (const [name, value] of fields) if (typeof value !== "string" || !value.trim()) throw new GatewayConfigurationError(`Invalid TencentDB Agent Memory identity: ${name} must be a non-empty string`);
	if (candidate.taskId !== void 0 && (typeof candidate.taskId !== "string" || !candidate.taskId.trim())) throw new GatewayConfigurationError("Invalid TencentDB Agent Memory identity: taskId must be a non-empty string when provided");
	if (typeof candidate.sessionKey !== "string" || !candidate.sessionKey.trim()) throw new GatewayConfigurationError("Invalid TencentDB Agent Memory identity: sessionKey must be a non-empty string");
	const typedIdentity = {
		serviceId: candidate.serviceId.trim(),
		instanceId: candidate.instanceId.trim(),
		teamId: candidate.teamId.trim(),
		agentId: candidate.agentId.trim(),
		userId: candidate.userId.trim(),
		...candidate.taskId === void 0 ? {} : { taskId: candidate.taskId.trim() },
		sessionId: candidate.sessionId.trim(),
		sessionKey: candidate.sessionKey.trim()
	};
	const expectedSessionKey = deriveTdaiSessionKey(typedIdentity);
	if (typedIdentity.sessionKey !== expectedSessionKey) throw new GatewayConfigurationError("Invalid TencentDB Agent Memory identity: sessionKey does not match the derived identity");
	return typedIdentity;
}
/**
* Resolve the strict identity shared by Codex hooks and MCP.
*
* Team, agent, and user deliberately have no fabricated defaults. The caller
* decides whether a configuration error is fail-open (hooks) or user-visible
* (MCP).
*/
function resolveTdaiIdentity(options = {}) {
	const env = options.env ?? process.env;
	const base = {
		serviceId: required(env.TDAI_SERVICE_ID, "TDAI_SERVICE_ID"),
		instanceId: required(env.TDAI_INSTANCE_ID, "TDAI_INSTANCE_ID"),
		teamId: required(env.TDAI_TEAM_ID, "TDAI_TEAM_ID"),
		agentId: required(env.TDAI_AGENT_ID, "TDAI_AGENT_ID"),
		userId: required(env.TDAI_USER_ID, "TDAI_USER_ID"),
		taskId: optional(env.TDAI_TASK_ID),
		sessionId: required(options.sessionId ?? env.TDAI_SESSION_ID, "session_id")
	};
	return assertTdaiIdentity({
		...base,
		sessionKey: deriveTdaiSessionKey(base)
	});
}
//#endregion
export { GatewayConfigurationError, GatewayHttpError, GatewayMemoryClient, GatewayMemoryClientError, GatewayParseError, GatewayRedirectError, GatewayResponseError, GatewayTimeoutError, GatewayTransportError, assertTdaiIdentity, createGatewayPlatformAdapter, deriveTdaiSessionKey, gatewayClientOptionsFromEnv, resolveTdaiIdentity };
