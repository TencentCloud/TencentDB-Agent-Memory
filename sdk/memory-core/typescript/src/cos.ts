/**
 * Memory file reader — direct read of memory pipeline artifacts (persona.md,
 * scene_blocks/*.md) from object storage with STS credential management.
 *
 * Usage:
 *   const reader = createMemoryFileReader({ endpoint, apiKey, serviceId });
 *   const content = await reader.read("scene_blocks/cooking-recipes.md");
 *
 * Under the hood:
 *   1. Fetches STS temporary credentials from the platform (POST /v2/cos/secret)
 *   2. Caches credentials until they expire (auto-refresh with 2-min buffer)
 *   3. Signs a COS V5 GET request with the STS credentials
 *   4. Returns the file content as a string
 *
 * Storage backend (currently COS) is an implementation detail — the public
 * API is intentionally storage-agnostic.
 */

import { TDAMError } from "./errors.js";
import { createHmac, createHash } from "node:crypto";

// ============================
// Platform response types
// ============================

/** Raw response from platform `POST /v2/cos/secret`. */
export interface CosSecretResponse {
  CosUrl: string;
  TmpSecretId: string;
  TmpSecretKey: string;
  TmpToken: string;
  ExpirationTime: string;
  PathPrefix: string;
}

// ============================
// COS URL parser
// ============================

/**
 * Parse CosUrl → { bucket, region, host }.
 *
 * Supports:
 *   - Public:   https://bucket.cos.region.myqcloud.com
 *   - Internal: https://bucket.cos-internal.region.tencentcos.cn
 */
function parseCosUrl(cosUrl: string): { bucket: string; region: string; host: string } {
  let host: string;
  try {
    host = new URL(cosUrl).hostname;
  } catch {
    throw new TDAMError(-1, `Invalid CosUrl: ${cosUrl}`);
  }
  // Public: {bucket}.cos.{region}.myqcloud.com
  const pub = host.match(/^(.+?)\.cos\.(.+?)\.myqcloud\.com$/);
  if (pub) return { bucket: pub[1]!, region: pub[2]!, host };
  // Internal: {bucket}.cos-internal.{region}.tencentcos.cn
  const priv = host.match(/^(.+?)\.cos-internal\.(.+?)\.tencentcos\.cn$/);
  if (priv) return { bucket: priv[1]!, region: priv[2]!, host };
  throw new TDAMError(-1, `Cannot parse CosUrl: ${cosUrl}`);
}

// ============================
// STS Credential
// ============================

export class StsCredential {
  readonly tmpSecretId: string;
  readonly tmpSecretKey: string;
  readonly token: string;
  readonly bucket: string;
  readonly region: string;
  readonly prefix: string;
  readonly expiresAtMs: number;
  private readonly _host: string;

  constructor(data: CosSecretResponse) {
    this.tmpSecretId = data.TmpSecretId;
    this.tmpSecretKey = data.TmpSecretKey;
    this.token = data.TmpToken || "";
    const parsed = parseCosUrl(data.CosUrl);
    this.bucket = parsed.bucket;
    this.region = parsed.region;
    this._host = parsed.host;
    // Ensure trailing slash for key concatenation
    const pfx = data.PathPrefix || "";
    this.prefix = pfx.endsWith("/") ? pfx : `${pfx}/`;
    this.expiresAtMs = data.ExpirationTime
      ? new Date(data.ExpirationTime).getTime()
      : Date.now() + 30 * 60 * 1000;
  }

  isValid(bufferMs = 120_000): boolean {
    return Date.now() < this.expiresAtMs - bufferMs;
  }

  get cosHost(): string {
    return this._host;
  }
}

// ============================
// STS Credential Manager
// ============================

export interface MemoryFileReaderConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  timeout?: number;
}

export class StsCredentialManager {
  private credential: StsCredential | null = null;
  private fetchPromise: Promise<StsCredential> | null = null;
  private readonly bufferMs: number;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly serviceId: string;
  private readonly timeout: number;

  constructor(
    config: MemoryFileReaderConfig,
    bufferMs = 120_000,
  ) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.serviceId = config.serviceId;
    this.timeout = config.timeout ?? 30_000;
    this.bufferMs = bufferMs;
  }

  async getCredential(): Promise<StsCredential> {
    if (this.credential?.isValid(this.bufferMs)) {
      return this.credential;
    }
    // Coalesce concurrent requests
    if (!this.fetchPromise) {
      this.fetchPromise = this.refresh();
    }
    try {
      return await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }

  invalidate(): void {
    this.credential = null;
    this.fetchPromise = null;
  }

  private async refresh(): Promise<StsCredential> {
    const url = `${this.endpoint}/v2/cos/secret`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "x-tdai-service-id": this.serviceId,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new TDAMError(resp.status, `COS secret fetch failed: HTTP ${resp.status}: ${text}`);
      }

      const data = (await resp.json()) as CosSecretResponse;
      const cred = new StsCredential(data);
      this.credential = cred;
      return cred;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================
// COS V5 Signature (GET only)
// ============================

/**
 * Generate COS V5 Authorization header for a GET request.
 * Uses Node.js crypto.
 */
export function cosV5Sign(
  secretId: string,
  secretKey: string,
  method: string,
  path: string,
  host: string,
  startTime?: number,
  endTime?: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const qSignTime = `${startTime ?? now - 60};${endTime ?? now + 600}`;
  const qKeyTime = qSignTime;

  // Step 1: SignKey = HMAC-SHA1(SecretKey, q-key-time)
  const signKey = hmacSha1Hex(secretKey, qKeyTime);

  // Step 2: HttpString
  const httpString = `${method.toLowerCase()}\n${path}\n\nhost=${host}\n`;

  // Step 3: StringToSign
  const sha1HttpString = sha1Hex(httpString);
  const stringToSign = `sha1\n${qSignTime}\n${sha1HttpString}\n`;

  // Step 4: Signature
  const signature = hmacSha1Hex(signKey, stringToSign);

  return (
    `q-sign-algorithm=sha1` +
    `&q-ak=${secretId}` +
    `&q-sign-time=${qSignTime}` +
    `&q-key-time=${qKeyTime}` +
    `&q-header-list=host` +
    `&q-url-param-list=` +
    `&q-signature=${signature}`
  );
}

// Node.js crypto helpers
function hmacSha1Hex(key: string, data: string): string {
  return createHmac("sha1", key).update(data).digest("hex");
}

function sha1Hex(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

// ============================
// Memory File Reader
// ============================

export class MemoryFileReader {
  constructor(
    private readonly stsManager: StsCredentialManager,
    private readonly timeout = 30_000,
  ) {}

  /**
   * Read a memory file (persona.md, scene_blocks/*.md, …) by relative path.
   *
   * @param path Relative path within the memory space,
   *   e.g. "scene_blocks/cooking-recipes.md" or "persona.md".
   * @returns File content as UTF-8 string.
   */
  async read(path: string): Promise<string> {
    let cred = await this.stsManager.getCredential();
    let result = await this.doGet(cred, path);

    // 403 → invalidate and retry once
    if (result.status === 403) {
      this.stsManager.invalidate();
      cred = await this.stsManager.getCredential();
      result = await this.doGet(cred, path);
    }

    if (result.status === 404) {
      throw new TDAMError(404, `File not found: ${path}`);
    }

    if (result.status !== 200) {
      throw new TDAMError(
        result.status,
        `COS GET failed: HTTP ${result.status} — ${result.body.slice(0, 200)}`,
      );
    }

    return result.body;
  }

  private async doGet(
    cred: StsCredential,
    path: string,
  ): Promise<{ status: number; body: string }> {
    const fullKey = `${cred.prefix}${path}`;
    const cosPath = `/${fullKey}`;
    const host = cred.cosHost;

    const auth = cosV5Sign(
      cred.tmpSecretId,
      cred.tmpSecretKey,
      "GET",
      cosPath,
      host,
    );

    const headers: Record<string, string> = {
      Host: host,
      Authorization: auth,
    };
    if (cred.token) {
      headers["x-cos-security-token"] = cred.token;
    }

    // Encode the transport path without changing the object key used for signing.
    const encodedPath = cosPath.split("/").map(encodeURIComponent).join("/");
    const url = `https://${host}${encodedPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const body = await resp.text();
      return { status: resp.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Convenience factory: create a MemoryFileReader that fetches STS credentials
 * directly from the platform's `POST /v2/cos/secret` endpoint.
 */
export function createMemoryFileReader(
  config: MemoryFileReaderConfig,
  opts?: { bufferMs?: number; timeout?: number },
): MemoryFileReader {
  const mgr = new StsCredentialManager(config, opts?.bufferMs);
  return new MemoryFileReader(mgr, opts?.timeout);
}
