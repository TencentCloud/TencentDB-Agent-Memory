/**
 * Unit tests for ConfigValidator
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DefaultConfigValidator } from "../config-validator.js";

describe("DefaultConfigValidator", () => {
  let validator: DefaultConfigValidator;

  beforeEach(() => {
    validator = new DefaultConfigValidator({
      applyDefaults: false,
      rules: [
        { path: "enabled", type: "boolean" },
        { path: "dataDir", type: "string" },
      ],
    });
  });

  describe("validateSync", () => {
    it("should validate a valid configuration", () => {
      const config = {
        enabled: true,
        dataDir: "/tmp/test",
      };

      const result = validator.validateSync(config);

      expect(result.errors).toHaveLength(0);
      expect(result.value).toBeDefined();
    });

    it("should reject non-object configuration", () => {
      const result = validator.validateSync("not an object");

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "$root" })
      );
    });

    it("should validate configuration with defaults", () => {
      const validatorWithDefaults = new DefaultConfigValidator({
        applyDefaults: true,
        rules: [
          { path: "enabled", type: "boolean", defaultValue: true },
        ],
      });

      const config = {};
      const result = validatorWithDefaults.validateSync(config);

      expect(result.value.enabled).toBe(true);
    });

    it("should validate required fields", () => {
      const validatorWithRequired = new DefaultConfigValidator({
        rules: [
          { path: "requiredField", required: true },
        ],
      });

      const result = validatorWithRequired.validateSync({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "requiredField" })
      );
    });

    it("should validate field types", () => {
      const result = validator.validateSync({
        enabled: "not a boolean",
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "enabled" })
      );
    });

    it("should validate number ranges", () => {
      const validatorWithRange = new DefaultConfigValidator({
        rules: [
          { path: "count", type: "number", min: 1, max: 10 },
        ],
      });

      const tooLow = validatorWithRange.validateSync({ count: 0 });
      expect(tooLow.valid).toBe(false);

      const tooHigh = validatorWithRange.validateSync({ count: 11 });
      expect(tooHigh.valid).toBe(false);

      const valid = validatorWithRange.validateSync({ count: 5 });
      expect(valid.valid).toBe(true);
    });

    it("should validate string lengths", () => {
      const validatorWithLength = new DefaultConfigValidator({
        rules: [
          { path: "name", type: "string", minLength: 3, maxLength: 10 },
        ],
      });

      const tooShort = validatorWithLength.validateSync({ name: "ab" });
      expect(tooShort.valid).toBe(false);

      const tooLong = validatorWithLength.validateSync({ name: "abcdefghijk" });
      expect(tooLong.valid).toBe(false);

      const valid = validatorWithLength.validateSync({ name: "valid" });
      expect(valid.valid).toBe(true);
    });

    it("should validate enum values", () => {
      const validatorWithEnum = new DefaultConfigValidator({
        rules: [
          { path: "strategy", type: "string", enum: ["hybrid", "embedding", "fts"] },
        ],
      });

      const invalid = validatorWithEnum.validateSync({ strategy: "invalid" });
      expect(invalid.valid).toBe(false);

      const valid = validatorWithEnum.validateSync({ strategy: "hybrid" });
      expect(valid.valid).toBe(true);
    });

    it("should validate custom rules", () => {
      const validatorWithCustom = new DefaultConfigValidator({
        rules: [
          {
            path: "port",
            type: "number",
            validate: (value) => {
              if (value < 1024) return "Port must be >= 1024";
              return true;
            },
          },
        ],
      });

      const invalid = validatorWithCustom.validateSync({ port: 80 });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors[0].message).toContain(">= 1024");
    });

    it("should validate nested objects", () => {
      const config = {
        embedding: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
        },
      };

      const result = validator.validateSync(config, {
        type: "object",
        properties: {
          embedding: {
            type: "object",
            properties: {
              provider: { type: "string" },
              baseUrl: { type: "string" },
            },
          },
        },
      });

      expect(result.valid).toBe(true);
    });
  });

  describe("addRule/removeRule", () => {
    it("should add custom rules", () => {
      validator.addRule({
        path: "customField",
        type: "string",
        required: true,
      });

      const result = validator.validateSync({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "customField" })
      );
    });

    it("should remove rules", () => {
      validator.addRule({ path: "tempField", required: true });
      validator.removeRule("tempField");

      const result = validator.validateSync({});
      expect(result.valid).toBe(true);
    });

    it("should get all rules", () => {
      validator.addRule({ path: "field1", type: "string" });
      validator.addRule({ path: "field2", type: "number" });

      const rules = validator.getRules();
      expect(rules.length).toBeGreaterThanOrEqual(2);
      expect(rules.some(r => r.path === "field1")).toBe(true);
      expect(rules.some(r => r.path === "field2")).toBe(true);
    });
  });

  describe("validate (async)", () => {
    it("should return same result as validateSync", async () => {
      const config = { enabled: true };
      const syncResult = validator.validateSync(config);
      const asyncResult = await validator.validate(config);

      expect(asyncResult.valid).toBe(syncResult.valid);
      expect(asyncResult.errors).toEqual(syncResult.errors);
    });
  });
});
