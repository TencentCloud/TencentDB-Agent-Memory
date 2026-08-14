export class L1AgentDomainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class L1AgentValidationError extends L1AgentDomainError {}

export class L1AgentConflictError extends L1AgentDomainError {}

export class L1AgentPersistenceError extends L1AgentDomainError {}

export class L1DispatchError extends L1AgentDomainError {
  constructor(
    readonly kind: import("./l1-agent-types.js").L1DispatchFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
