const HOST_STABLE = [
  "# Host instructions",
  "Answer with exactly OK.",
  "Keep tool schemas and provider settings byte-identical.",
].join("\n");

const STABLE_MEMORY = [
  "<user-persona>",
  "The user expects cache-stable implementation guidance. ".repeat(180),
  "</user-persona>",
  "<memory-tools-guide>",
  "Use memory search only when injected context is insufficient.",
  "</memory-tools-guide>",
].join("\n");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "benchmark_echo",
      description: "Return deterministic benchmark content.",
      parameters: {
        type: "object",
        properties: { turn: { type: "integer" } },
        required: ["turn"],
        additionalProperties: false,
      },
    },
  },
];

export const DEFAULT_VARIANTS = [
  {
    id: "head-prepend-strip",
    stablePlacement: "after-volatile",
    dynamicPlacement: "prepend",
    persistRecall: false,
  },
  {
    id: "stable-before-prepend-strip",
    stablePlacement: "before-volatile",
    dynamicPlacement: "prepend",
    persistRecall: false,
  },
  {
    id: "stable-before-append-strip",
    stablePlacement: "before-volatile",
    dynamicPlacement: "append",
    persistRecall: false,
  },
  {
    id: "stable-before-prepend-preserve",
    stablePlacement: "before-volatile",
    dynamicPlacement: "prepend",
    persistRecall: true,
  },
];

export function dynamicRecall(turn) {
  return [
    "<relevant-memories>",
    `Turn-specific recalled fact ${turn}. ${"dynamic ".repeat(120)}`,
    "</relevant-memories>",
  ].join("\n");
}

function originalUserPrompt(turn) {
  return `Confirm benchmark turn ${turn} with exactly OK.`;
}

function systemPrompt(variant, turn, experimentId) {
  const marker = `<experiment>${experimentId}</experiment>`;
  const volatileTail = `# Runtime\nrequest=${turn}\nchannel=benchmark`;
  if (variant.stablePlacement === "before-volatile") {
    return [marker, STABLE_MEMORY, HOST_STABLE, volatileTail].join("\n\n");
  }
  if (variant.stablePlacement === "after-volatile") {
    return [marker, HOST_STABLE, volatileTail, STABLE_MEMORY].join("\n\n");
  }
  throw new Error(`Unsupported stablePlacement: ${variant.stablePlacement}`);
}

function currentUserContent(variant, turn) {
  const user = originalUserPrompt(turn);
  const recall = dynamicRecall(turn);
  if (variant.dynamicPlacement === "prepend") {
    return `${recall}\n\n${user}`;
  }
  if (variant.dynamicPlacement === "append") {
    return `${user}\n\n${recall}`;
  }
  throw new Error(`Unsupported dynamicPlacement: ${variant.dynamicPlacement}`);
}

export function buildRequest({
  variant,
  turn,
  experimentId,
  history = [],
  model = "benchmark-model",
}) {
  const originalUser = originalUserPrompt(turn);
  const effectiveUser = currentUserContent(variant, turn);
  return {
    body: {
      model,
      messages: [
        { role: "system", content: systemPrompt(variant, turn, experimentId) },
        ...history,
        { role: "user", content: effectiveUser },
      ],
      tools: TOOLS,
      temperature: 0,
      max_tokens: 8,
      stream: false,
    },
    originalUser,
    effectiveUser,
    recall: dynamicRecall(turn),
  };
}
export function appendCompletedTurn(history, request, persistRecall) {
  return [
    ...history,
    {
      role: "user",
      content: persistRecall ? request.effectiveUser : request.originalUser,
    },
    { role: "assistant", content: "OK" },
  ];
}

export function serializeRequest(body) {
  return JSON.stringify(body);
}

export function commonPrefixBytes(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const limit = Math.min(leftBytes.length, rightBytes.length);
  let index = 0;
  while (index < limit && leftBytes[index] === rightBytes[index]) index += 1;
  return index;
}

export function countPersistedRecall(history) {
  return history.reduce((count, message) => {
    if (message.role !== "user" || typeof message.content !== "string") return count;
    return count + (message.content.includes("<relevant-memories>") ? 1 : 0);
  }, 0);
}

export function runSyntheticSession(variant, turns = 6) {
  const experimentId = `offline-${variant.id}`;
  let history = [];
  let previousSerialized;
  const samples = [];

  for (let turn = 1; turn <= turns; turn += 1) {
    const request = buildRequest({ variant, turn, experimentId, history });
    const serialized = serializeRequest(request.body);
    samples.push({
      turn,
      requestBytes: Buffer.byteLength(serialized),
      commonPrefixBytes: previousSerialized
        ? commonPrefixBytes(previousSerialized, serialized)
        : null,
      historyBytes: Buffer.byteLength(JSON.stringify(history)),
      persistedRecallBlocks: countPersistedRecall(history),
    });
    history = appendCompletedTurn(history, request, variant.persistRecall);
    previousSerialized = serialized;
  }

  return {
    variant,
    syntheticOnly: true,
    turns,
    samples,
    finalPersistedRecallBlocks: countPersistedRecall(history),
    finalHistoryBytes: Buffer.byteLength(JSON.stringify(history)),
  };
}
