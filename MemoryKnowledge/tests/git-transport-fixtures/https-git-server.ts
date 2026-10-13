import { spawn, spawnSync } from "node:child_process";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

export interface GitServerOptions {
  host: string;
}

export class HttpsGitServer {
  public server: https.Server;
  public port: number = 0;
  public expectedAuthorization?: string;
  public authorizationHeaders: Array<string | undefined> = [];
  public caCert: string;
  public caKey: string;
  public serverCert: string;
  public serverKey: string;
  public repoDir: string;
  private activeSockets = new Set<any>();
  private activeProcesses = new Set<any>();

  constructor(public options: GitServerOptions) {
    this.repoDir = mkdtempSync(path.join(tmpdir(), "git-server-repo-"));
    const keys = this.generateCerts(options.host);
    this.caCert = keys.cert;
    this.caKey = keys.key;
    this.serverCert = keys.cert;
    this.serverKey = keys.key;

    this.server = https.createServer({
      key: this.serverKey,
      cert: this.serverCert,
    }, (req, res) => {
      this.authorizationHeaders.push(req.headers.authorization);
      if (this.expectedAuthorization && req.headers.authorization !== this.expectedAuthorization) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="synthetic-git"' });
        res.end("synthetic authentication required");
        return;
      }
      const reqUrl = new URL(req.url || "/", `https://${req.headers.host}`);
      const env: Record<string, string> = {
        GIT_PROJECT_ROOT: this.repoDir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: reqUrl.pathname,
        REMOTE_USER: "test",
        REMOTE_ADDR: req.socket.remoteAddress || "127.0.0.1",
        CONTENT_TYPE: req.headers["content-type"] || "",
        QUERY_STRING: reqUrl.search ? reqUrl.search.substring(1) : "",
        REQUEST_METHOD: req.method || "GET",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        HOME: "/dev/null"
      };

      const backend = spawn("git", ["http-backend"], { env });
      this.activeProcesses.add(backend);

      backend.on("exit", () => this.activeProcesses.delete(backend));
      backend.on("error", () => {
         this.activeProcesses.delete(backend);
         if (!res.headersSent) res.writeHead(500);
         res.end();
      });

      let headersDone = false;
      let buffer = Buffer.alloc(0);

      backend.stdout.on("data", (data: Buffer) => {
        if (!headersDone) {
          buffer = Buffer.concat([buffer, data]);
          const idx = buffer.indexOf("\r\n\r\n");
          if (idx !== -1) {
            headersDone = true;
            const headersRaw = buffer.subarray(0, idx).toString("latin1").split("\r\n");
            for (const h of headersRaw) {
              const colonIdx = h.indexOf(":");
              if (colonIdx !== -1) {
                const k = h.substring(0, colonIdx).trim();
                const v = h.substring(colonIdx + 1).trim();
                if (k.toLowerCase() === "status") {
                  const match = v.match(/^(\d+)/);
                  if (match) res.statusCode = parseInt(match[1], 10);
                } else {
                  res.setHeader(k, v);
                }
              }
            }
            res.write(buffer.subarray(idx + 4));
            buffer = Buffer.alloc(0);
          }
        } else {
          res.write(data);
        }
      });

      backend.stdout.on("end", () => res.end());

      if (req.method === "POST" || req.method === "PUT") {
        req.pipe(backend.stdin);
      } else {
        backend.stdin.end();
      }
    });

    this.server.on("connection", (socket) => {
      this.activeSockets.add(socket);
      socket.on("close", () => this.activeSockets.delete(socket));
    });
  }

  private generateCerts(host: string) {
    const keyPath = path.join(this.repoDir, "key.pem");
    const certPath = path.join(this.repoDir, "cert.pem");

    // Create self-signed cert using array arguments
    const result = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", `/CN=${host}`,
      "-addext", `subjectAltName=DNS:${host}`
    ]);
    if (result.error || result.status !== 0) {
      throw new Error(`openssl failed: ${result.error?.message || result.stderr?.toString()}`);
    }

    return {
      key: fs.readFileSync(keyPath, "utf-8"),
      cert: fs.readFileSync(certPath, "utf-8"),
    };
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    for (const socket of this.activeSockets) socket.destroy();
    for (const proc of this.activeProcesses) proc.kill("SIGKILL");

    return new Promise((resolve) => {
      this.server.close(() => {
        try { fs.rmSync(this.repoDir, { recursive: true, force: true }); } catch {}
        resolve();
      });
    });
  }

  public createRepoSync(name: string): string {
    const p = path.join(this.repoDir, name);
    fs.mkdirSync(p, { recursive: true });
    const result = spawnSync("git", ["init", "--bare"], {
      cwd: p,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        HOME: "/dev/null"
      }
    });
    if (result.error || result.status !== 0) {
      throw new Error(`git init --bare failed: ${result.error?.message || result.stderr?.toString()}`);
    }
    return p;
  }
}
