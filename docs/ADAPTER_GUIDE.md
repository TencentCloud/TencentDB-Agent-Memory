# Platform Adapter Integration Guide

> How to implement a new platform adapter for TencentDB Agent Memory

---

## Table of Contents

- [Overview](#overview)
- [Why the SDK?](#why-the-sdk)
- [Quick Start](#quick-start)
- [Interface Reference](#interface-reference)
- [Implementation Examples](#implementation-examples)
- [Best Practices](#best-practices)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Overview

This guide walks you through implementing a new platform adapter for TencentDB Agent Memory. The **Adapter SDK** provides a unified interface that handles 80% of the boilerplate, letting you focus on platform-specific integration logic.

**What is a Platform Adapter?**

A platform adapter is a bridge between an agent platform (OpenClaw, Hermes, Claude Code, etc.) and the TdaiCore memory engine. It translates platform-specific events into memory operations and vice versa.

---

## Why the SDK?

### Before: Manual Integration

```typescript
// Without SDK: Each platform needs custom implementation
class MyPlatform {
  async onBeforePrompt() {
    // Recreate recall logic from scratch
    const memories = await this.queryVectors();
    const formatted = this.formatInjection(memories);
    this.injectContext(formatted);
  }

  async onAgentEnd(turn) {
    // Recreate capture logic from scratch
    await this.saveToL0(turn);
    await this.extractL1(turn);
    await this.updateL2(turn);
  }
}
```

### After: SDK-based Integration

```typescript
// With SDK: Only implement what's unique to your platform
class MyPlatformAdapter extends BaseAdapter {
  readonly platform = {
    name: 'my-platform',
    version: '1.0.0',
    description: 'My custom agent platform',
    capabilities: ['memory-recall', 'memory-capture'],
  };

  getRuntimeContext() {
    return {
      userId: this.getUserId(),
      sessionKey: this.getSessionId(),
      workspaceDir: process.cwd(),
      dataDir: './.my-platform/memory',
    };
  }

  createLLMRunnerFactory() {
    // Platform-specific LLM setup
    return new MyLLMFactory();
  }

  initialize() { /* Platform-specific init */ }
  shutdown() { /* Platform-specific cleanup */ }
}
```

### Benefits

| Benefit | Description |
|---------|-------------|
| **Less Code** | ~80% reduction in boilerplate |
| **Consistency** | All adapters follow the same patterns |
| **Maintainability** | SDK updates benefit all adapters |
| **Testability** | Shared test utilities |

---

## Quick Start

### 5 Steps to a New Adapter

#### Step 1: Set Up Directory Structure

```bash
mkdir -p src/adapters/my-platform
touch src/adapters/my-platform/index.ts
```

#### Step 2: Import SDK Base Classes

```typescript
import {
  BaseAdapter,
  type PlatformAdapter,
  type PlatformInfo,
  type RuntimeContext,
  type LLMRunnerFactory,
  type ToolRegistry,
  type MemoryTdaiConfig,
} from '../sdk/index.js';
```

#### Step 3: Extend BaseAdapter

```typescript
export class MyPlatformAdapter extends BaseAdapter {
  // Step 4: Define platform metadata (see Step 4 below)
  // Step 5: Implement abstract methods (see Step 5 below)
}
```

#### Step 4: Define Platform Metadata

```typescript
readonly platform: PlatformInfo = {
  name: 'my-platform',
  version: '1.0.0',
  description: 'My custom agent platform integration',
  capabilities: [
    'memory-recall',        // Pre-turn memory injection
    'memory-capture',       // Turn capture
    'memory-search',        // On-demand search
    'conversation-search',   // Historical search
    'session-management',   // Session lifecycle
  ],
};
```

#### Step 5: Implement Required Methods

```typescript
getRuntimeContext(): RuntimeContext {
  return {
    userId: 'default',           // User identifier
    sessionKey: this.sessionId,   // Current session
    platform: 'my-platform',
    workspaceDir: this.projectPath,
    dataDir: this.getDataDir(),
  };
}

createLLMRunnerFactory(): LLMRunnerFactory {
  return new MyLLMFactory({
    model: this.config.llm?.model ?? 'gpt-4o',
    apiKey: process.env.MY_PLATFORM_API_KEY,
  });
}

initialize(): Promise<void> {
  this.sessionId = this.generateSessionId();
  return Promise.resolve();
}

shutdown(): Promise<void> {
  this.cleanup();
  return Promise.resolve();
}
```

#### Step 6: Register with TdaiCore

```typescript
import { createTdaiCore } from '../../core/index.js';
import { MyPlatformAdapter } from './index.js';

async function main() {
  const adapter = new MyPlatformAdapter({ config: {} });
  
  const core = await createTdaiCore({
    adapter,
    config: memoryConfig,
  });
  
  // Hooks and tools are auto-registered
  await adapter.initialize();
}
```

---

## Interface Reference

### PlatformAdapter Interface

```typescript
interface PlatformAdapter {
  /** Metadata about this adapter */
  readonly platform: PlatformInfo;

  /** Get current runtime environment */
  getRuntimeContext(): RuntimeContext;

  /** Create LLM runner factory for memory operations */
  createLLMRunnerFactory(): LLMRunnerFactory;

  /** Register event hooks with TdaiCore */
  registerHooks(core: TdaiCore): void;

  /** Register agent tools via ToolRegistry */
  registerTools(core: TdaiCore, registry: ToolRegistry): void;

  /** Initialize adapter resources */
  initialize(): MaybePromise<void>;

  /** Cleanup adapter resources */
  shutdown(): MaybePromise<void>;
}
```

### PlatformInfo Type

```typescript
interface PlatformInfo {
  /** Unique platform identifier (kebab-case) */
  name: string;
  
  /** Adapter version following semver */
  version: string;
  
  /** Human-readable description */
  description: string;
  
  /** Supported memory capabilities */
  capabilities: Capability[];
}

type Capability =
  | 'memory-recall'        // handleBeforeRecall support
  | 'memory-capture'       // handleTurnCommitted support
  | 'memory-search'        // searchMemories support
  | 'conversation-search'  // searchConversations support
  | 'session-management';  // Session lifecycle events
```

### RuntimeContext Type

```typescript
interface RuntimeContext {
  /** Current user identifier */
  userId: string;
  
  /** Current session key */
  sessionKey: string;
  
  /** Platform name */
  platform: string;
  
  /** Workspace root directory */
  workspaceDir: string;
  
  /** Memory data directory */
  dataDir: string;
}
```

---

## Implementation Examples

### Example: Event Hook Registration

The default `BaseAdapter.registerHooks()` provides common event mappings:

```typescript
// Default behavior (usually sufficient)
class MyAdapter extends BaseAdapter {
  registerHooks(core: TdaiCore): void {
    // This registers:
    // - before_prompt_build -> handleBeforeRecall
    // - agent_end -> handleTurnCommitted
    // Simply call super.registerHooks(core)
    super.registerHooks(core);
  }
}
```

For custom event mapping:

```typescript
class MyAdapter extends BaseAdapter {
  registerHooks(core: TdaiCore): void {
    // Map platform events to TdaiCore methods
    this.platform.on('pre_response', async () => {
      await core.handleBeforeRecall();
    });
    
    this.platform.on('post_response', async (turn) => {
      await core.handleTurnCommitted(turn);
    });
  }
}
```

### Example: Tool Registration

Default tools provided by `BaseAdapter`:

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `tdai_memory_search` | Search memories semantically | `{ query, limit?, session_key? }` |
| `tdai_conversation_search` | Search conversation history | `{ query, limit?, start_date?, end_date? }` |

Custom tool registration:

```typescript
class MyAdapter extends BaseAdapter {
  registerTools(core: TdaiCore, registry: ToolRegistry): void {
    // Always call parent first
    super.registerTools(core, registry);
    
    // Add platform-specific tools
    registry.register('my_platform_specific_tool', async (params) => {
      // Custom tool implementation
      return { result: '...' };
    });
  }
}
```

### Example: LLM Factory

```typescript
import { createLLMRunner } from '@ai-sdk/openai';

class MyLLMFactory implements LLMRunnerFactory {
  constructor(private options: MyLLMOptions) {}

  create() {
    return createLLMRunner({
      model: this.options.model,
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
    });
  }
}
```

---

## Best Practices

### 1. Error Handling

Always wrap async operations with proper error handling:

```typescript
async initialize(): Promise<void> {
  try {
    await this.validateConfig();
    await this.setupDirectories();
    await this.connectToPlatform();
  } catch (error) {
    throw new AdapterError('Failed to initialize MyPlatform adapter', {
      cause: error,
    });
  }
}
```

### 2. Logging

Use the SDK logger for consistency:

```typescript
class MyAdapter extends BaseAdapter {
  initialize(): Promise<void> {
    this.logger.info('Initializing MyPlatform adapter');
    // ...
  }
}
```

### 3. Graceful Shutdown

Implement proper cleanup:

```typescript
async shutdown(): Promise<void> {
  this.logger.info('Shutting down MyPlatform adapter');
  
  await this.flushPendingOperations();
  await this.closeConnections();
  await this.saveState();
  
  this.logger.info('Shutdown complete');
}
```

### 4. Session Management

Track session lifecycle:

```typescript
getRuntimeContext(): RuntimeContext {
  return {
    ...super.getRuntimeContext(),
    sessionKey: this.currentSession?.id ?? 'unknown',
  };
}
```

---

## Testing

### Unit Testing

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MyPlatformAdapter } from './index.js';

describe('MyPlatformAdapter', () => {
  it('should implement PlatformAdapter interface', () => {
    const adapter = new MyPlatformAdapter({ config: {} });
    expect(adapter.platform.name).toBe('my-platform');
  });

  it('should return correct runtime context', () => {
    const adapter = new MyPlatformAdapter({ config: {} });
    const context = adapter.getRuntimeContext();
    expect(context.platform).toBe('my-platform');
    expect(context.dataDir).toBeDefined();
  });
});
```

### Integration Testing

```typescript
import { createTdaiCore } from '../../core/index.js';
import { MyPlatformAdapter } from './index.js';

describe('MyPlatform Integration', () => {
  it('should capture and recall memories', async () => {
    const adapter = new MyPlatformAdapter({ config: {} });
    const core = await createTdaiCore({ adapter });
    
    await adapter.initialize();
    
    // Simulate platform event
    await adapter.simulateTurn('Hello, remember my name is Alice');
    
    // Verify memory was stored
    const memories = await core.searchMemories({ query: 'Alice' });
    expect(memories.length).toBeGreaterThan(0);
    
    await adapter.shutdown();
  });
});
```

### Mock Platform Events

```typescript
// For testing without real platform
class MockPlatform {
  private handlers: Map<string, Function[]> = new Map();
  
  on(event: string, handler: Function) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
  
  async emit(event: string, data: any) {
    const handlers = this.handlers.get(event) ?? [];
    await Promise.all(handlers.map(h => h(data)));
  }
}
```

---

## Troubleshooting

### Common Issues

#### Issue: Adapter not capturing turns

**Symptoms**: Memories not being stored after agent responses.

**Diagnosis**:
1. Check if hooks are registered: `core.eventNames()`
2. Verify event handlers are called
3. Check adapter logs for errors

**Solution**:
```typescript
// Add debug logging
registerHooks(core: TdaiCore): void {
  this.logger.debug('Registering hooks');
  core.on('agentEnd', async (turn) => {
    this.logger.debug('agentEnd event received', { turn });
    await core.handleTurnCommitted(turn);
  });
}
```

#### Issue: Memory recall not working

**Symptoms**: No memories injected before agent response.

**Diagnosis**:
1. Check recall strategy configuration
2. Verify memories exist in storage
3. Check query encoding

**Solution**:
```typescript
// Ensure recall is triggered
registerHooks(core: TdaiCore): void {
  core.on('beforePromptBuild', async (context) => {
    this.logger.debug('beforePromptBuild', { context });
    await core.handleBeforeRecall();
  });
}
```

#### Issue: LLM factory not found

**Symptoms**: `createLLMRunnerFactory()` returns undefined.

**Solution**:
```typescript
createLLMRunnerFactory(): LLMRunnerFactory {
  if (!this.llmFactory) {
    this.llmFactory = new MyLLMFactory(this.config.llm);
  }
  return this.llmFactory;
}
```

### Debug Mode

Enable debug logging:

```typescript
const adapter = new MyPlatformAdapter({
  config: { /* ... */ },
  logger: {
    level: 'debug',
    transport: (msg) => console.log('[DEBUG]', msg),
  },
});
```

### Getting Help

- **GitHub Issues**: [Report bugs](https://github.com/Tencent/TencentDB-Agent-Memory/issues)
- **Discord**: [Ask questions](https://discord.gg/kDtHb5RW2)
- **Discussions**: [Share ideas](https://github.com/Tencent/TencentDB-Agent-Memory/discussions)

---

## Related Documentation

- [Architecture Overview](./ARCHITECTURE.md)
- [Core Engine Documentation](../src/core/README.md)
- [SDK Source Code](../src/adapters/sdk/)
- [Main README](../README.md)
