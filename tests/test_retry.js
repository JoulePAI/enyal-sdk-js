/**
 * Tests for retry wrapper + idempotency key handling.
 *
 * Mocks global fetch to capture outgoing requests and simulate failures.
 * Uses Node built-in test runner (node --test).
 *
 * Run: node --test tests/test_retry.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import of the client module (ESM)
const client = await import('../enyal-client.js');

// ── Mock infrastructure ──────────────────────────────────────

let fetchCalls = [];
let fetchResponses = [];
const originalFetch = globalThis.fetch;

function mockFetch(responses) {
    fetchCalls = [];
    fetchResponses = [...responses];
    globalThis.fetch = async (url, opts) => {
        fetchCalls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
        const next = fetchResponses.shift();
        if (next instanceof Error) throw next;
        return {
            ok: next.ok ?? (next.status >= 200 && next.status < 300),
            status: next.status || 200,
            statusText: next.statusText || 'OK',
            headers: { get: (h) => next.headers?.[h] ?? null },
            json: async () => next.body || {},
        };
    };
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
}

function okResponse(body = { ok: true }) {
    return { status: 200, body };
}

function errorResponse(status, detail = `Error ${status}`) {
    return { status, ok: false, body: { detail } };
}

function networkError() {
    return new TypeError('fetch failed');
}

// ── Tests ────────────────────────────────────────────────────

describe('Retry: successful first call', () => {
    afterEach(restoreFetch);

    it('1a. returns immediately, no retries', async () => {
        mockFetch([okResponse()]);
        await client.search('key', { query: 'test', baseUrl: 'http://t' });
        assert.equal(fetchCalls.length, 1);
    });
});

describe('Retry: network error then success', () => {
    afterEach(restoreFetch);

    it('1b. retries on network error', async () => {
        mockFetch([networkError(), okResponse()]);
        const result = await client.search('key', { query: 'test', baseUrl: 'http://t' });
        assert.equal(fetchCalls.length, 2);
        assert.deepEqual(result, { ok: true });
    });
});

describe('Retry: multiple 5xx then success', () => {
    afterEach(restoreFetch);

    it('1c. 500 → 502 → success', async () => {
        mockFetch([errorResponse(500), errorResponse(502), okResponse()]);
        const result = await client.search('key', { query: 'test', baseUrl: 'http://t' });
        assert.equal(fetchCalls.length, 3);
        assert.deepEqual(result, { ok: true });
    });
});

describe('Retry: exhaustion', () => {
    afterEach(restoreFetch);

    it('1d. 500 x maxRetries throws', async () => {
        mockFetch([errorResponse(500), errorResponse(500), errorResponse(500), errorResponse(500)]);
        await assert.rejects(
            () => client.search('key', { query: 'test', baseUrl: 'http://t' }),
            /API call failed \(500\)/
        );
        assert.equal(fetchCalls.length, 4); // 1 + 3 retries
    });
});

describe('Retry: 429 with Retry-After', () => {
    afterEach(restoreFetch);

    it('1e. respects Retry-After header', async () => {
        const r429 = { status: 429, ok: false, body: { detail: 'Rate limited' }, headers: { 'Retry-After': '0.1' } };
        mockFetch([r429, okResponse()]);
        const result = await client.search('key', { query: 'test', baseUrl: 'http://t' });
        assert.equal(fetchCalls.length, 2);
        assert.deepEqual(result, { ok: true });
    });
});

describe('Retry: no retry on 4xx', () => {
    afterEach(restoreFetch);

    it('1f-a. 401 throws immediately', async () => {
        mockFetch([errorResponse(401)]);
        await assert.rejects(
            () => client.search('key', { query: 'test', baseUrl: 'http://t' }),
            /API call failed \(401\)/
        );
        assert.equal(fetchCalls.length, 1);
    });

    it('1f-b. 422 throws immediately', async () => {
        mockFetch([errorResponse(422)]);
        await assert.rejects(
            () => client.search('key', { query: 'test', baseUrl: 'http://t' }),
            /API call failed \(422\)/
        );
        assert.equal(fetchCalls.length, 1);
    });
});

describe('Retry: user-provided idempotencyKey stable', () => {
    afterEach(restoreFetch);

    it('1g. same key on all retry attempts', async () => {
        mockFetch([errorResponse(500), errorResponse(502), okResponse()]);
        await client.prove('key', {
            resourceType: 'test', baseUrl: 'http://t',
            idempotencyKey: 'user-key-abc-123-def-456-ghi-789-jkl',
        });
        assert.equal(fetchCalls.length, 3);
        const keys = new Set(fetchCalls.map(c => c.body?.idempotency_key));
        assert.equal(keys.size, 1);
        assert.equal([...keys][0], 'user-key-abc-123-def-456-ghi-789-jkl');
    });
});

describe('Retry: SDK-generated key stable across retries', () => {
    afterEach(restoreFetch);

    it('1h. auto-generated key identical on all attempts', async () => {
        mockFetch([errorResponse(500), errorResponse(502), okResponse()]);
        await client.prove('key', { resourceType: 'test', baseUrl: 'http://t' });
        assert.equal(fetchCalls.length, 3);
        const keys = new Set(fetchCalls.map(c => c.body?.idempotency_key));
        assert.equal(keys.size, 1);
        const key = [...keys][0];
        assert.ok(key);
        assert.equal(key.length, 36); // UUID format
    });
});

describe('Retry: different calls get different keys', () => {
    afterEach(restoreFetch);

    it('1i. two calls produce two different keys', async () => {
        mockFetch([okResponse(), okResponse()]);
        await client.prove('key', { resourceType: 't1', baseUrl: 'http://t' });
        await client.prove('key', { resourceType: 't2', baseUrl: 'http://t' });
        assert.equal(fetchCalls.length, 2);
        assert.notEqual(fetchCalls[0].body.idempotency_key, fetchCalls[1].body.idempotency_key);
    });
});

describe('Retry: retry=false disables retries', () => {
    afterEach(restoreFetch);

    it('single attempt when retry disabled', async () => {
        mockFetch([errorResponse(500)]);
        await assert.rejects(
            () => client.prove('key', { resourceType: 'test', baseUrl: 'http://t', retry: false }),
            /API call failed \(500\)/
        );
        assert.equal(fetchCalls.length, 1);
    });
});

describe('Idempotency key translation', () => {
    afterEach(restoreFetch);
    const userKey = 'user-key-123456789012345678901234567';

    it('archive sends client_chunk_id', async () => {
        mockFetch([okResponse()]);
        await client.archive('k', { agentId: 'a', chunkType: 't', chunkKey: 'k', data: {}, baseUrl: 'http://t', idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.client_chunk_id, userKey);
        assert.equal(fetchCalls[0].body.idempotency_key, undefined);
    });

    it('timestamp sends client_chunk_id', async () => {
        mockFetch([okResponse()]);
        await client.timestamp('k', { payload: 'p', baseUrl: 'http://t', idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.client_chunk_id, userKey);
        assert.equal(fetchCalls[0].body.idempotency_key, undefined);
    });

    it('createAgreement sends client_chunk_id', async () => {
        mockFetch([okResponse()]);
        await client.createAgreement('k', { terms: 't', parties: ['a'], baseUrl: 'http://t', idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.client_chunk_id, userKey);
        assert.equal(fetchCalls[0].body.idempotency_key, undefined);
    });

    it('complianceAttest sends client_attestation_id', async () => {
        mockFetch([okResponse()]);
        await client.complianceAttest('k', { periodStart: '2026-01', periodEnd: '2026-03', systems: ['s'], baseUrl: 'http://t', idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.client_attestation_id, userKey);
        assert.equal(fetchCalls[0].body.idempotency_key, undefined);
    });

    it('prove sends idempotency_key', async () => {
        mockFetch([okResponse()]);
        await client.prove('k', { resourceType: 'test', baseUrl: 'http://t', idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.idempotency_key, userKey);
    });

    it('disclose sends idempotency_key', async () => {
        mockFetch([okResponse()]);
        await client.disclose('k', { chunkIds: ['c'], recipientPubkeyHex: 'abc', purpose: 'test', baseUrl: 'http://t', idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.idempotency_key, userKey);
    });

    it('requestClientDisclosure sends idempotency_key', async () => {
        mockFetch([okResponse()]);
        await client.requestClientDisclosure('k', 'http://t', ['c'], 'test', { idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.idempotency_key, userKey);
    });

    it('requestShareProof sends idempotency_key', async () => {
        mockFetch([okResponse()]);
        await client.requestShareProof('k', 'http://t', 'deadbeef', null, { idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.idempotency_key, userKey);
    });

    it('sendMessage sends idempotency_key', async () => {
        mockFetch([okResponse()]);
        await client.sendMessage('k', { senderAgentId: 's', threadId: 't', recipientAgentId: 'r', messageType: 'text', payload: {}, baseUrl: 'http://t', idempotencyKey: userKey });
        assert.equal(fetchCalls[0].body.idempotency_key, userKey);
    });
});

describe('synthesiseKnowledge session-auth error', () => {
    afterEach(restoreFetch);

    it('throws without making HTTP call', async () => {
        mockFetch([okResponse()]); // should not be called
        await assert.rejects(
            () => client.synthesiseKnowledge('key', { query: 'q', nodeIds: ['n1'] }),
            /session auth/
        );
        assert.equal(fetchCalls.length, 0);
    });
});

describe('GET endpoints: no idempotency key injected', () => {
    afterEach(restoreFetch);

    it('search GET has no body', async () => {
        mockFetch([okResponse({ results: [] })]);
        await client.search('k', { query: 'test', baseUrl: 'http://t' });
        assert.equal(fetchCalls[0].body, null);
    });
});

describe('Smoke: imports', () => {
    it('EnyalAgent is accessible', async () => {
        const idx = await import('../index.js');
        assert.equal(typeof idx.EnyalAgent, 'function');
        assert.equal(typeof idx.archive, 'function');
        assert.equal(typeof idx.prove, 'function');
    });
});
