import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackendClient } from "../src/offload/backend-client.js";

const execFileAsync = promisify(execFile);

const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("BackendClient TLS/HTTP verification", () => {
  let httpsServer: https.Server;
  let httpServer: http.Server;
  let httpsUrl: string;
  let httpUrl: string;
  let tmpDir: string;
  let certPath: string;
  let keyPath: string;

  beforeAll(async () => {
    // Generate self-signed cert in tmp dir
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-client-tls-"));
    keyPath = path.join(tmpDir, "test-key.pem");
    certPath = path.join(tmpDir, "test-cert.pem");
    const confPath = path.join(tmpDir, "openssl.cnf");

    // Portable config for LibreSSL
    fs.writeFileSync(confPath, `
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[dn]
CN = localhost

[v3_req]
subjectAltName = DNS:localhost
    `);

    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "1",
      "-config", confPath
    ]);

    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);

    httpsServer = https.createServer({ key, cert }, (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries: [] }));
    });

    httpServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries: [] }));
    });

    await new Promise<void>(resolve => {
      httpsServer.listen(0, "127.0.0.1", () => {
        const addr = httpsServer.address() as any;
        httpsUrl = `https://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    await new Promise<void>(resolve => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address() as any;
        httpUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (httpsServer) {
      await new Promise<void>(resolve => httpsServer.close(() => resolve()));
    }
    if (httpServer) {
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should reject untrusted HTTPS certificate", async () => {
    // using 127.0.0.1 matching the server URL
    const client = new BackendClient(httpsUrl, fakeLogger);
    await expect(client.l1Summarize({ recentMessages: "", toolPairs: [] })).rejects.toMatchObject({
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT'
    });
  });

  it("should reject invalid hostname even with trusted CA", async () => {
    // Write a test script
    const scriptPath = path.join(tmpDir, "test-hostname.ts");
    fs.writeFileSync(scriptPath, `
      import { BackendClient } from "${path.resolve(process.cwd(), "src/offload/backend-client.ts")}";
      const fakeLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
      // 127.0.0.1 is not in SAN, SAN only has localhost
      const client = new BackendClient("${httpsUrl}", fakeLogger);
      client.l1Summarize({ recentMessages: "", toolPairs: [] })
        .then(() => {
          console.log("UNEXPECTED_SUCCESS");
          process.exit(1);
        })
        .catch((e: any) => {
          if (e.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
            console.log("HOSTNAME_MISMATCH_CAUGHT");
            process.exit(0);
          }
          console.error("UNEXPECTED_ERROR:", e.message || e);
          process.exit(1);
        });
    `);

    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", scriptPath], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
      timeout: 5000
    });

    expect(stdout).toContain("HOSTNAME_MISMATCH_CAUGHT");
  });

  it("should accept explicitly trusted certificate using NODE_EXTRA_CA_CERTS", async () => {
    // Replace 127.0.0.1 with localhost in URL to match SAN
    const localhostUrl = httpsUrl.replace("127.0.0.1", "localhost");

    // Write a test script
    const scriptPath = path.join(tmpDir, "test-trusted.ts");
    fs.writeFileSync(scriptPath, `
      import { BackendClient } from "${path.resolve(process.cwd(), "src/offload/backend-client.ts")}";
      // Force IPv4 for localhost to match our 127.0.0.1 server
      import * as dns from "node:dns";
      dns.setDefaultResultOrder('ipv4first');

      const fakeLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
      const client = new BackendClient("${localhostUrl}", fakeLogger);
      client.l1Summarize({ recentMessages: "", toolPairs: [] })
        .then((res) => {
          if (res.entries && res.entries.length === 0) {
            console.log("SUCCESS_EMPTY_ENTRIES");
            process.exit(0);
          }
          console.error("UNEXPECTED_RESPONSE");
          process.exit(1);
        })
        .catch((e: any) => {
          console.error("UNEXPECTED_ERROR:", e.message || e);
          process.exit(1);
        });
    `);

    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", scriptPath], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
      timeout: 5000
    });

    expect(stdout).toContain("SUCCESS_EMPTY_ENTRIES");
  });

  it("should work correctly with plain HTTP", async () => {
    const client = new BackendClient(httpUrl, fakeLogger);
    const res = await client.l1Summarize({ recentMessages: "", toolPairs: [] });
    expect(res.entries).toEqual([]);
  });
});
