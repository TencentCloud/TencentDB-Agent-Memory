export function buildHealthUrl(baseUrl) {
  return `${baseUrl}/health`;
}

const withTimeout = (fetchImpl, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
};

const errorReason = (error, timeoutMs) => {
  if (error?.name === 'AbortError') {
    return `timed out after ${timeoutMs}ms`;
  }
  return error?.message ?? String(error);
};

export async function getJson(
  url,
  { fetchImpl = fetch, timeoutMs = 5000, headers = {} } = {},
) {
  const { signal, cancel } = withTimeout(fetchImpl, timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, error: 'response is not valid JSON' };
    }
  } catch (error) {
    return { ok: false, error: errorReason(error, timeoutMs) };
  } finally {
    cancel();
  }
}

export async function postChatCompletion({
  baseUrl,
  spaceId,
  model,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 30000,
}) {
  const url = `${baseUrl}/proxy/${spaceId}/v1/chat/completions`;
  const { signal, cancel } = withTimeout(fetchImpl, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tdai-user-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping: tdai-plandex health probe' }],
        max_tokens: 1,
      }),
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, error: 'response is not valid JSON' };
    }
  } catch (error) {
    return { ok: false, error: errorReason(error, timeoutMs) };
  } finally {
    cancel();
  }
}
