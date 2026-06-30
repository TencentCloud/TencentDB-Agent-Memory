/**
 * ConfigValidator — Configuration validation with JSON Schema-like rules.
 *
 * Features:
 * - Type checking
 * - Required field validation
 * - Default value injection
 * - Custom validation rules
 * - Detailed error messages
 */

import type { AdapterConfig } from "./platform-adapter.interface.js";

// ============================
// Types
// ============================

export interface ValidationRule {
  /** Field path (e.g., 'embedding.provider') */
  path: string;
  /** Field type */
  type?: "string" | "number" | "boolean" | "array" | "object";
  /** Whether the field is required */
  required?: boolean;
  /** Default value if not provided */
  defaultValue?: unknown;
  /** Minimum value (for numbers) */
  min?: number;
  /** Maximum value (for numbers) */
  max?: number;
  /** Minimum length (for strings/arrays) */
  minLength?: number;
  /** Maximum length (for strings/arrays) */
  maxLength?: number;
  /** Allowed values */
  enum?: unknown[];
  /** Custom validator function */
  validate?: (value: unknown) => boolean | string;
  /** Description for error messages */
  description?: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  value: AdapterConfig;
}

export interface ConfigValidatorOptions {
  /** Custom rules for validation */
  rules?: ValidationRule[];
  /** Whether to apply defaults */
  applyDefaults?: boolean;
  /** Whether to collect warnings */
  collectWarnings?: boolean;
}

// ============================
// DefaultConfigValidator
// ============================

export class DefaultConfigValidator implements ConfigValidator {
  private rules: ValidationRule[];
  private applyDefaults: boolean;
  private collectWarnings: boolean;

  constructor(opts: ConfigValidatorOptions = {}) {
    this.rules = opts.rules ?? this.getDefaultRules();
    this.applyDefaults = opts.applyDefaults ?? true;
    this.collectWarnings = opts.collectWarnings ?? true;
  }

  /** @implements ConfigValidator */
  validate(config: unknown, _schema?: Record<string, unknown>): Promise<ValidationResult> {
    return Promise.resolve(this.validateSync(config));
  }

  /** @implements ConfigValidator */
  validateSync(config: unknown, _schema?: Record<string, unknown>): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const result: AdapterConfig = { ...(config as AdapterConfig) };

    if (typeof config !== "object" || config === null) {
      return {
        valid: false,
        errors: [{ field: "$root", message: "Configuration must be an object" }],
        warnings: [],
        value: {},
      };
    }

    // Apply defaults and validate
    for (const rule of this.rules) {
      const value = this.getNestedValue(result, rule.path);
      const isMissing = value === undefined;

      // Check required
      if (rule.required && isMissing) {
        errors.push({
          field: rule.path,
          message: `${rule.path} is required${rule.description ? ` (${rule.description})` : ""}`,
        });
        continue;
      }

      // Skip validation if missing and not required
      if (isMissing) {
        if (rule.defaultValue !== undefined && this.applyDefaults) {
          this.setNestedValue(result, rule.path, rule.defaultValue);
          if (this.collectWarnings) {
            warnings.push({
              field: rule.path,
              message: `${rule.path} not provided, using default: ${JSON.stringify(rule.defaultValue)}`,
            });
          }
        }
        continue;
      }

      // Type checking
      if (rule.type && typeof value !== rule.type) {
        errors.push({
          field: rule.path,
          message: `${rule.path} must be of type ${rule.type}, got ${typeof value}`,
        });
        continue;
      }

      // Min/max for numbers
      if (rule.type === "number" && typeof value === "number") {
        if (rule.min !== undefined && value < rule.min) {
          errors.push({
            field: rule.path,
            message: `${rule.path} must be >= ${rule.min}, got ${value}`,
          });
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push({
            field: rule.path,
            message: `${rule.path} must be <= ${rule.max}, got ${value}`,
          });
        }
      }

      // Min/max length for strings/arrays
      if ((rule.type === "string" || rule.type === "array") && typeof value !== "boolean") {
        const len = Array.isArray(value) ? value.length : String(value).length;
        if (rule.minLength !== undefined && len < rule.minLength) {
          errors.push({
            field: rule.path,
            message: `${rule.path} length must be >= ${rule.minLength}, got ${len}`,
          });
        }
        if (rule.maxLength !== undefined && len > rule.maxLength) {
          errors.push({
            field: rule.path,
            message: `${rule.path} length must be <= ${rule.maxLength}, got ${len}`,
          });
        }
      }

      // Enum validation
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push({
          field: rule.path,
          message: `${rule.path} must be one of: ${rule.enum.join(", ")}, got ${value}`,
        });
      }

      // Custom validation
      if (rule.validate) {
        const customResult = rule.validate(value);
        if (customResult === false) {
          errors.push({
            field: rule.path,
            message: `${rule.path} validation failed${rule.description ? `: ${rule.description}` : ""}`,
          });
        } else if (typeof customResult === "string") {
          errors.push({
            field: rule.path,
            message: `${rule.path}: ${customResult}`,
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      value: result,
    };
  }

  /** @implements ConfigValidator */
  addRule(rule: ValidationRule): void {
    this.rules.push(rule);
  }

  /** @implements ConfigValidator */
  removeRule(path: string): void {
    this.rules = this.rules.filter(r => r.path !== path);
  }

  /** @implements ConfigValidator */
  getRules(): ValidationRule[] {
    return [...this.rules];
  }

  // ============================
  // Private helpers
  // ============================

  private getDefaultRules(): ValidationRule[] {
    return [
      {
        path: "enabled",
        type: "boolean",
        defaultValue: true,
        description: "Whether memory is enabled",
      },
      {
        path: "dataDir",
        type: "string",
        description: "Data directory for memory storage",
      },
      {
        path: "excludeAgents",
        type: "array",
        defaultValue: [],
        description: "Agent patterns to exclude from memory",
      },
    ];
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split(".").reduce((current: unknown, key: string) => {
      if (current && typeof current === "object") {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  private setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split(".");
    const lastKey = keys.pop()!;
    const target = keys.reduce((current: unknown, key: string) => {
      if (!current || typeof current !== "object") {
        const newObj: Record<string, unknown> = {};
        (obj as Record<string, unknown>)[key] = newObj;
        return newObj;
      }
      if (!(key in (current as Record<string, unknown>))) {
        (current as Record<string, unknown>)[key] = {};
      }
      return (current as Record<string, unknown>)[key];
    }, obj);
    (target as Record<string, unknown>)[lastKey] = value;
  }
}

// ============================
// ConfigValidator interface
// ============================

export interface ConfigValidator {
  /**
   * Validate configuration asynchronously.
   */
  validate(config: unknown, schema?: Record<string, unknown>): Promise<ValidationResult>;

  /**
   * Validate configuration synchronously.
   */
  validateSync(config: unknown, schema?: Record<string, unknown>): ValidationResult;

  /**
   * Add a validation rule.
   */
  addRule(rule: ValidationRule): void;

  /**
   * Remove a validation rule.
   */
  removeRule(path: string): void;

  /**
   * Get all validation rules.
   */
  getRules(): ValidationRule[];
}
