const captureStatuses = new Set([
  'partial_capture_pending',
  'partial_captured',
  'retry_pending',
]);

const isCaptureResult = (result) => (
  result !== null
  && typeof result === 'object'
  && !Array.isArray(result)
  && Object.keys(result).length === 2
  && Object.hasOwn(result, 'captureStatus')
  && Object.hasOwn(result, 'captureId')
  && captureStatuses.has(result.captureStatus)
  && (typeof result.captureId === 'string' || result.captureId === null)
);

export async function handleStop(event, { turnStore, assistantResponseProvider, captureService } = {}) {
  const base = { exitCode: 0, stdout: '' };
  if (event?.eventName !== 'Stop') return { ...base, status: 'invalid_event' };
  try {
    const turn = await turnStore.completeTurn(event.sessionId);
    if (turn === null) return { ...base, status: 'duplicate_or_unmatched_stop' };

    const assistantResponse = await assistantResponseProvider.getAssistantResponse(event, turn);
    let captureStatus;
    let captureId = null;
    if (assistantResponse === null && turn.tool_events.length === 0) {
      captureStatus = 'skipped_no_observable_data';
    } else if (assistantResponse === null) {
      const capture = await captureService.captureObservedToolTrace(turn);
      if (!isCaptureResult(capture)) throw new Error('capture');
      ({ captureStatus, captureId } = capture);
    } else if (typeof assistantResponse === 'string') {
      const capture = await captureService.captureFullTurn(turn, assistantResponse);
      if (!isCaptureResult(capture)) throw new Error('capture');
      ({ captureStatus, captureId } = capture);
    } else {
      throw new Error('assistant response');
    }

    await turnStore.markCaptureStatus(event.sessionId, turn.turn_id, captureStatus, captureId);
    if (await turnStore.clearActiveTurn(event.sessionId, turn.turn_id) !== true) {
      throw new Error('clear active turn');
    }
    return {
      ...base,
      status: captureStatus,
      turnId: turn.turn_id,
      ...(captureId === null ? {} : { captureId }),
    };
  } catch {
    return { ...base, status: 'finalize_error' };
  }
}
