export async function handlePromptSubmit(event, { turnStore, recallService, flushOutbox } = {}) {
  const base = { exitCode: 0, stdout: '' };
  if (event?.eventName !== 'UserPromptSubmit') return { ...base, status: 'invalid_event' };

  if (flushOutbox !== undefined) {
    try {
      await flushOutbox();
    } catch {
      // Outbox flushing must not block prompt processing.
    }
  }

  let turn;
  try {
    turn = await turnStore.createTurn({
      sessionId: event.sessionId,
      cwd: event.cwd,
      prompt: event.prompt,
    });
  } catch {
    turn = null;
  }

  let stdout = '';
  try {
    const recalled = await recallService.recall(event.prompt);
    if (typeof recalled === 'string') stdout = recalled;
  } catch {
    // Recall is best effort.
  }

  if (turn === null) return { ...base, stdout, status: 'state_error' };
  return { ...base, stdout, status: 'turn_created', turnId: turn.turn_id };
}
