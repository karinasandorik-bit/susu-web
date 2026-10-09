import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiRequest, apiRequestPage, apiRequestPageBody } from './client';
import { ApiError, apiErrorMessage, isRetryableApiError } from './errors';

/**
 * The HTTP client.
 *
 * `fetch` is stubbed rather than pointed at a server, so the cases worth testing
 * are reachable: a 502 from a proxy that returns HTML, a 204 with no body, a 2xx
 * that is not the documented envelope, and a request that never arrives. Those
 * are the paths a happy-path integration test never sees.
 */

const ENV = {
  VITE_APP_URL: 'http://localhost:5173',
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'test-key',
  VITE_STELLAR_NETWORK: 'testnet',
  VITE_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  VITE_FACTORY_CONTRACT_ID: '',
  VITE_USDC_CONTRACT_ID: '',
  VITE_EXPLORER_BASE_URL: 'https://stellar.expert/explorer/testnet',
  VITE_API_BASE_URL: 'https://api.example.test/api/v1',
};

vi.mock('../env', () => ({
  getEnv: () => ENV,
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('unwraps the data envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { code: 'abc' } }));

    const result = await apiRequest<{ code: string }>('invites');

    expect(result).toEqual({ code: 'abc' });
  });

  it('builds the URL from the base and path without doubling the slash', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: null }));

    await apiRequest('/invites/redeem');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/invites/redeem',
      expect.anything(),
    );
  });

  it('sends the token as a bearer header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: null }));

    await apiRequest('me', { token: 'a-session-token' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer a-session-token',
    );
  });

  it('sends no authorization header without a token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: null }));

    await apiRequest('groups');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('serialises a body and declares it JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: null }));

    await apiRequest('invites/redeem', { method: 'POST', body: { code: 'abc' } });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"code":"abc"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('resolves with nothing for a 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    // A 204 has no body by definition; requiring an envelope would fail on the
    // one response shape that cannot have one.
    await expect(apiRequest('notifications/x/read', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('reports the API’s error code', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'invite_not_found' }));

    await expect(apiRequest('invites/redeem', { method: 'POST', body: {} })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'invite_not_found',
    });
  });

  it('reports a non-JSON failure by its status', async () => {
    // A 502 from a proxy is HTML, and parsing it would throw a SyntaxError that
    // says nothing about what happened.
    fetchMock.mockResolvedValue(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(apiRequest('groups')).rejects.toMatchObject({ status: 502, code: undefined });
  });

  it('reports a request that never arrived as status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiRequest('groups')).rejects.toMatchObject({ status: 0 });
  });

  it('re-throws an abort unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValue(abort);

    // A cancellation is not a failure, and React Query needs to recognise it as
    // one to avoid reporting an error to the user.
    await expect(apiRequest('groups')).rejects.toBe(abort);
  });

  it('refuses a 2xx that is not the documented envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { unexpected: true }));

    // Returning `undefined` here would make a contract mismatch look like a
    // successful call that produced nothing.
    await expect(apiRequest('groups')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('apiRequestPage', () => {
  it('returns the rows and the page position together', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ contractId: 'C1' }, { contractId: 'C2' }],
        page: { limit: 20, offset: 0, hasMore: true },
      }),
    );

    const page = await apiRequestPage<{ contractId: string }>('groups');

    expect(page.items).toEqual([{ contractId: 'C1' }, { contractId: 'C2' }]);
    expect(page.hasMore).toBe(true);
    expect(page.limit).toBe(20);
    expect(page.offset).toBe(0);
  });

  it('reports the end of a list', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [], page: { limit: 20, offset: 40, hasMore: false } }),
    );

    const page = await apiRequestPage('groups');

    // An empty page is a definite answer, not an error: it is what the last page
    // of a list looks like.
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('refuses a list body with no page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ contractId: 'C1' }] }));

    // Treating this as a complete list would render one row and no way to reach
    // the rest, which reads as "that is everything".
    await expect(apiRequestPage('groups')).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a page whose hasMore is not a boolean', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [], page: { limit: 20, offset: 0, hasMore: 'false' } }),
    );

    // A stringified boolean would make `hasMore === true` false and silently
    // present the first page as the last.
    await expect(apiRequestPage('groups')).rejects.toBeInstanceOf(ApiError);
  });

  it('reports the API’s error code for a refusal', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'group_not_found' }));

    await expect(apiRequestPage('groups/nope')).rejects.toMatchObject({
      status: 404,
      code: 'group_not_found',
    });
  });

  it('reports an unreachable server as status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiRequestPage('groups')).rejects.toMatchObject({ status: 0 });
  });
});

describe('apiErrorMessage', () => {
  it('explains an unknown code without quoting the code', () => {
    const message = apiErrorMessage(new ApiError(404, 'invite_not_found', 'raw'));

    expect(message).toBe('This invite link is not valid any more.');
    expect(message).not.toContain('invite_not_found');
  });

  it('falls back for a code it does not know', () => {
    expect(apiErrorMessage(new ApiError(400, 'something_new', 'raw'))).toBe(
      'Something went wrong. Try again.',
    );
  });

  it('distinguishes an unreachable server from a refusal', () => {
    expect(apiErrorMessage(new ApiError(0, undefined, 'raw'))).toContain('reach the server');
  });

  it('passes through a plain Error’s message', () => {
    expect(apiErrorMessage(new Error('Connect a wallet first.'))).toBe('Connect a wallet first.');
  });

  it('says something for a non-Error', () => {
    expect(apiErrorMessage('a string')).toBe('Something went wrong. Try again.');
  });
});

describe('isRetryableApiError', () => {
  it('retries a server fault, a rate limit, and an unreachable server', () => {
    expect(isRetryableApiError(new ApiError(500, undefined, 'x'))).toBe(true);
    expect(isRetryableApiError(new ApiError(503, undefined, 'x'))).toBe(true);
    expect(isRetryableApiError(new ApiError(429, undefined, 'x'))).toBe(true);
    expect(isRetryableApiError(new ApiError(0, undefined, 'x'))).toBe(true);
  });

  it('does not retry a considered refusal', () => {
    // Repeating a 4xx unchanged produces the same answer.
    expect(isRetryableApiError(new ApiError(400, undefined, 'x'))).toBe(false);
    expect(isRetryableApiError(new ApiError(404, undefined, 'x'))).toBe(false);
    expect(isRetryableApiError(new ApiError(409, undefined, 'x'))).toBe(false);
    expect(isRetryableApiError(new ApiError(401, undefined, 'x'))).toBe(false);
  });

  it('does not treat a cancellation as retryable', () => {
    expect(isRetryableApiError(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

describe('runtime schema validation', () => {
  const itemSchema = z.object({
    id: z.string(),
    count: z.number(),
  });

  it('validates apiRequest payload with provided schema', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: 'test-1', count: 42 } }));

    const result = await apiRequest('test', { schema: itemSchema });
    expect(result.id).toBe('test-1');
    expect(result.count).toBe(42);
  });

  it('throws ApiError when apiRequest payload violates schema', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { id: 'test-1', count: 'not-a-number' } }),
    );

    await expect(apiRequest('test', { schema: itemSchema })).rejects.toBeInstanceOf(ApiError);
  });

  it('validates each page item with item schema in apiRequestPage', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ id: 'test-1', count: 1 }],
        page: { limit: 10, offset: 0, hasMore: false },
      }),
    );

    const page = await apiRequestPage('test', { schema: itemSchema });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.count).toBe(1);
  });

  it('throws ApiError when an item in apiRequestPage violates schema', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ id: 'test-1', count: 'invalid' }],
        page: { limit: 10, offset: 0, hasMore: false },
      }),
    );

    await expect(apiRequestPage('test', { schema: itemSchema })).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects missing or malformed unreadCount when an extra schema is supplied', async () => {
    const extraSchema = z.object({ unreadCount: z.number().int().nonnegative() }).passthrough();
    for (const extra of [{}, { unreadCount: '3' }, { unreadCount: -1 }]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {
        data: [], page: { limit: 10, offset: 0, hasMore: false }, ...extra,
      }));
      await expect(apiRequestPageBody('notifications', {}, undefined, extraSchema))
        .rejects.toBeInstanceOf(ApiError);
    }
  });

  it('preserves a valid unreadCount and page with extra schema', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      data: [{ id: 'a' }], page: { limit: 10, offset: 0, hasMore: false }, unreadCount: 4,
    }));
    const extraSchema = z.object({ unreadCount: z.number().int().nonnegative() }).passthrough();
    const result = await apiRequestPageBody('notifications', {}, undefined, extraSchema);
    expect(result.body.unreadCount).toBe(4);
    expect(result.page.items).toEqual([{ id: 'a' }]);
  });

  it('validates page items in apiRequestPageBody with schema', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ id: 'test-1', count: 5 }],
        page: { limit: 10, offset: 0, hasMore: false },
        extraField: 'hello',
      }),
    );

    const { page, body } = await apiRequestPageBody('test', { schema: itemSchema });
    expect(page.items[0]?.id).toBe('test-1');
    expect(body.extraField).toBe('hello');
  });
});
