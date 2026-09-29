/**
 * Multi-provider fold tests for loadGatewayConfig (#1396).
 *
 * Feeds yaml fixtures + env into the single seam (loadGatewayConfig) and
 * asserts external behavior only: folded results, fail-fast throws, and
 * warnings — not internal implementation.
 *
 * Coverage: active-entry fold, per-entry overrides falling back to shared
 * llm.* scalars, env switch via TDAI_ACTIVE_PROVIDER, all four fail-fast
 * branches (no match / unset / key env missing / activeProvider without a
 * usable providers[]), shape errors, the models-list warning, the
 * TDAI_LLM_API_KEY global override, and the no-providers backward-compat path.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "./config.js";

const FIXTURE_YAML = `
llm:
  activeProvider: "vendor-a"
  providers:
    - name: vendor-a
      baseUrl: "https://vendor-a.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_A"
      model: "model-a1"
      models: [model-a1, model-a2]
      maxTokens: 2048
    - name: vendor-b
      baseUrl: "https://vendor-b.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_B"
      model: "model-b1"
      models: [model-b1]
  baseUrl: "https://top-level.example/v1"
  model: "top-level-model"
  maxTokens: 8192
  timeoutMs: 60000
`;

const NO_PROVIDERS_YAML = `
llm:
  baseUrl: "https://top-level.example/v1"
  apiKey: "top-level-key"
  model: "top-level-model"
  maxTokens: 4096
`;

// yaml 合法,但 providers 写成了映射而非数组(且未设 activeProvider → 仅告警回落)
const BAD_SHAPE_YAML = `
llm:
  providers:
    vendor-a:
      baseUrl: "https://vendor-a.example/v1"
  baseUrl: "https://top-level.example/v1"
`;

// 设了 activeProvider 却没有可用 providers[](缺失键与空数组同分支)
const ACTIVE_NO_PROVIDERS_YAML = `
llm:
  activeProvider: "vendor-a"
  baseUrl: "https://top-level.example/v1"
`;

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function withFixture(yaml: string, fn: () => void): void {
  const p = path.join(tmpDir, `fixture-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, yaml, "utf-8");
  const prev = process.env.TDAI_GATEWAY_CONFIG;
  process.env.TDAI_GATEWAY_CONFIG = p;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
    else process.env.TDAI_GATEWAY_CONFIG = prev;
    fs.rmSync(p, { force: true });
  }
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-config-providers-test-"));
  // 隔离宿主机的同名 env,避免本机开发环境污染断言
  for (const k of [
    "TDAI_LLM_BASE_URL", "TDAI_LLM_API_KEY", "TDAI_LLM_MODEL",
    "TDAI_LLM_MAX_TOKENS", "TDAI_LLM_TIMEOUT_MS", "TDAI_ACTIVE_PROVIDER",
  ]) setEnv(k, undefined);
  setEnv("TDAI_TEST_KEY_A", "test-key-a-value");
  setEnv("TDAI_TEST_KEY_B", "test-key-b-value");
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadGatewayConfig llm multi-provider fold", () => {
  it("folds the active entry into the single llm object (baseUrl / apiKeyEnv / model / maxTokens)", () => {
    withFixture(FIXTURE_YAML, () => {
      const cfg = loadGatewayConfig();
      expect(cfg.llm.baseUrl).toBe("https://vendor-a.example/v1");
      expect(cfg.llm.apiKey).toBe("test-key-a-value");
      expect(cfg.llm.model).toBe("model-a1");
      expect(cfg.llm.maxTokens).toBe(2048);
      expect(cfg.llm.provider).toBe("openai");
    });
  });

  it("entry scalars override llm-level shared values; entries without a value fall back to shared", () => {
    process.env.TDAI_ACTIVE_PROVIDER = "vendor-b";
    try {
      withFixture(FIXTURE_YAML, () => {
        const cfg = loadGatewayConfig();
        expect(cfg.llm.model).toBe("model-b1");
        expect(cfg.llm.maxTokens).toBe(8192); // vendor-b 未声明 → 回落共享值
        expect(cfg.llm.timeoutMs).toBe(60000);
      });
    } finally {
      delete process.env.TDAI_ACTIVE_PROVIDER;
    }
  });

  it("TDAI_ACTIVE_PROVIDER env switches the selected entry without touching yaml", () => {
    process.env.TDAI_ACTIVE_PROVIDER = "vendor-b";
    try {
      withFixture(FIXTURE_YAML, () => {
        expect(loadGatewayConfig().llm.baseUrl).toBe("https://vendor-b.example/v1");
      });
    } finally {
      delete process.env.TDAI_ACTIVE_PROVIDER;
    }
  });

  it("TDAI_LLM_API_KEY globally overrides the entry's apiKeyEnv (emergency escape)", () => {
    process.env.TDAI_LLM_API_KEY = "global-override-key";
    try {
      withFixture(FIXTURE_YAML, () => {
        expect(loadGatewayConfig().llm.apiKey).toBe("global-override-key");
      });
    } finally {
      delete process.env.TDAI_LLM_API_KEY;
    }
  });

  it("entry apiKeyEnv unset but TDAI_LLM_API_KEY present → global override rescues instead of fail-fast", () => {
    delete process.env.TDAI_TEST_KEY_A;
    process.env.TDAI_LLM_API_KEY = "emergency-global-key";
    try {
      withFixture(FIXTURE_YAML, () => {
        const cfg = loadGatewayConfig();
        expect(cfg.llm.apiKey).toBe("emergency-global-key");
        expect(cfg.llm.baseUrl).toBe("https://vendor-a.example/v1");
      });
    } finally {
      delete process.env.TDAI_LLM_API_KEY;
      process.env.TDAI_TEST_KEY_A = "test-key-a-value";
    }
  });

  it("activeProvider matching no entry → fail-fast at startup", () => {
    process.env.TDAI_ACTIVE_PROVIDER = "no-such-vendor";
    try {
      withFixture(FIXTURE_YAML, () => {
        expect(() => loadGatewayConfig()).toThrow(/未命中 providers/);
      });
    } finally {
      delete process.env.TDAI_ACTIVE_PROVIDER;
    }
  });

  it("providers present but activeProvider unset → fail-fast (no silent default vendor)", () => {
    withFixture(FIXTURE_YAML.replace(`  activeProvider: "vendor-a"\n`, ""), () => {
      expect(() => loadGatewayConfig()).toThrow(/activeProvider="\(未设置\)"/);
    });
  });

  it("activeProvider set but providers missing/empty → fail-fast", () => {
    withFixture(ACTIVE_NO_PROVIDERS_YAML, () => {
      expect(() => loadGatewayConfig()).toThrow(/providers 不是非空数组/);
    });
  });

  it("entry apiKeyEnv pointing at an unset env var → fail-fast", () => {
    delete process.env.TDAI_TEST_KEY_A;
    delete process.env.TDAI_LLM_API_KEY;
    try {
      withFixture(FIXTURE_YAML, () => {
        expect(() => loadGatewayConfig()).toThrow(/环境变量未设置或为空/);
      });
    } finally {
      process.env.TDAI_TEST_KEY_A = "test-key-a-value";
    }
  });

  it("model outside the entry's models list → console.warn but not blocking (checks the post-env value)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TDAI_ACTIVE_PROVIDER = "vendor-b";
    process.env.TDAI_LLM_MODEL = "model-brand-new";
    try {
      withFixture(FIXTURE_YAML, () => {
        const cfg = loadGatewayConfig();
        expect(cfg.llm.model).toBe("model-brand-new");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("不在 models 清单"));
      });
    } finally {
      warn.mockRestore();
      delete process.env.TDAI_ACTIVE_PROVIDER;
      delete process.env.TDAI_LLM_MODEL;
    }
  });

  it("providers with a wrong shape → warn and keep the top-level scalar path alive", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      withFixture(BAD_SHAPE_YAML, () => {
        const cfg = loadGatewayConfig();
        expect(cfg.llm.baseUrl).toBe("https://top-level.example/v1");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("llm.providers 存在但不是数组"));
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("loadGatewayConfig llm without providers — backward compat", () => {
  it("top-level scalars still parse exactly as before the fold existed", () => {
    withFixture(NO_PROVIDERS_YAML, () => {
      const cfg = loadGatewayConfig();
      expect(cfg.llm.baseUrl).toBe("https://top-level.example/v1");
      expect(cfg.llm.apiKey).toBe("top-level-key");
      expect(cfg.llm.model).toBe("top-level-model");
      expect(cfg.llm.maxTokens).toBe(4096);
    });
  });
});
