import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig — git storage fields", () => {
  it("defaults fileStorageBackend to auto and applies git defaults", () => {
    const cfg = parseConfig({});
    expect(cfg.fileStorageBackend).toBe("auto");
    expect(cfg.git.localRootDir).toBe("./data/git-storage");
    expect(cfg.git.authMethod).toBe("http-token");
    expect(cfg.git.recoveryMode).toBe("manual");
    expect(cfg.git.batchWindowMs).toBe(2000);
  });

  it("parses an explicit git config block", () => {
    const cfg = parseConfig({
      fileStorageBackend: "git",
      git: {
        remoteUrl: "https://example.com/org/repo.git",
        credentialRef: "vault:git-token",
        authMethod: "ssh",
        sshKeyPath: "/keys/id_ed25519",
        batchWindowMs: 500,
        recoveryMode: "auto-wal-only",
      },
    });
    expect(cfg.fileStorageBackend).toBe("git");
    expect(cfg.git.remoteUrl).toBe("https://example.com/org/repo.git");
    expect(cfg.git.credentialRef).toBe("vault:git-token");
    expect(cfg.git.authMethod).toBe("ssh");
    expect(cfg.git.sshKeyPath).toBe("/keys/id_ed25519");
    expect(cfg.git.batchWindowMs).toBe(500);
    expect(cfg.git.recoveryMode).toBe("auto-wal-only");
  });

  it("rejects an unrecognized fileStorageBackend value by falling back to auto", () => {
    const cfg = parseConfig({ fileStorageBackend: "s3" });
    expect(cfg.fileStorageBackend).toBe("auto");
  });
});
