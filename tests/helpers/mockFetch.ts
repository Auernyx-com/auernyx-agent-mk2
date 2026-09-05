// Shared fetch-mocking helper, extracted from the pattern already proven in
// tests/analyzeDependency.test.ts, reused across every capability that calls
// an external Worker endpoint directly via global fetch (Kennr's 3, Skadi's
// 1). Queues a sequence of responses, consumed one per fetch() call.

export type MockResponse = { ok: boolean; status: number; body: unknown; text?: string };

export function mockFetchSequence(sequence: MockResponse[]): { restore: () => void; calls: Array<{ url: string; init?: any }> } {
  const original = globalThis.fetch;
  let index = 0;
  const calls: Array<{ url: string; init?: any }> = [];

  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const current = sequence[index++];
    if (!current) throw new Error(`Unexpected fetch call #${index}: ${url}`);
    return {
      ok: current.ok,
      status: current.status,
      statusText: `status-${current.status}`,
      async json() {
        return current.body;
      },
      async text() {
        return current.text ?? JSON.stringify(current.body);
      },
    } as Response;
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

export function mockFetchNetworkFailure(): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network unreachable (mocked)");
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
