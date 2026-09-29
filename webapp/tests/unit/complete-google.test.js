/**
 * @name            jPulse Framework / Plugins / AI Google / Tests / Unit / Complete
 * @tagline         Fake-fetch completions against the published event contract
 * @file            plugins/ai-google/webapp/tests/unit/complete-google.test.js
 * @version         1.0.0
 * @release         2026-09-30
 * @repository      https://github.com/jpulse-net/plugin-ai-google
 * @author          Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @copyright       2026 Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @license         BSL 1.1 -- see LICENSE file; for commercial use: team@jpulse.net
 * @genai           80%, Cursor, Grok 4.7
 */

import { beforeEach, describe, expect, test } from '@jest/globals';
import { completeGoogle, resetTurnThoughts } from '../../controller/aiGoogle.js';

const SIG = 'sig-TURN-SECRET';

function sse(...events) {
    return events.map((ev) => {
        const name = ev.event_type || 'message';
        return `event: ${name}\ndata: ${JSON.stringify(ev)}\n\n`;
    }).join('');
}

function okFetch(body) {
    return async function fetchFn() {
        return {
            ok: true,
            status: 200,
            body
        };
    };
}

function collect(context, deps) {
    const events = [];
    context.emit = (event) => events.push(event);
    return completeGoogle(context, deps).then(() => events);
}

function fetchFailed(code) {
    return async function fetchFn() {
        const err = new TypeError('fetch failed');
        if (code) {
            err.cause = { code };
        }
        throw err;
    };
}

function textStream() {
    return sse(
        { event_type: 'step.start', index: 0, step: { type: 'thought' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'hidden' } } },
        { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: SIG } },
        { event_type: 'step.stop', index: 0 },
        { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
        { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Hello' } },
        { event_type: 'step.delta', index: 1, delta: { type: 'text', text: ' world' } },
        { event_type: 'step.stop', index: 1 },
        {
            event_type: 'interaction.completed',
            interaction: {
                status: 'completed',
                usage: {
                    total_tokens: 346,
                    total_input_tokens: 11,
                    total_cached_tokens: 0,
                    total_output_tokens: 90,
                    total_thought_tokens: 245
                }
            }
        }
    );
}

function toolStream(calls) {
    const events = [
        { event_type: 'step.start', index: 0, step: { type: 'thought' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: SIG } },
        { event_type: 'step.stop', index: 0 }
    ];
    calls.forEach((call, i) => {
        const index = i + 1;
        events.push({
            event_type: 'step.start',
            index,
            step: { type: 'function_call', id: call.id, name: call.name, arguments: {} }
        });
        if (call.delta) {
            events.push({
                event_type: 'step.delta',
                index,
                delta: { type: 'arguments_delta', arguments: call.delta }
            });
        }
        if (call.stop) {
            events.push({ event_type: 'step.stop', index });
        }
    });
    events.push({
        event_type: 'interaction.completed',
        interaction: {
            status: 'requires_action',
            usage: { total_input_tokens: 4, total_output_tokens: 2, total_thought_tokens: 1, total_cached_tokens: 0 }
        }
    });
    return sse(...events);
}

const storedKey = async () => 'AIzaSyTestKey';
const emptyConfig = async () => ({});

beforeEach(() => {
    resetTurnThoughts();
});

describe('completeGoogle', () => {
    test('text-only stream emits text, four-way usage, and done/end', async () => {
        const events = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: okFetch(textStream())
        });
        expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['Hello', ' world']);
        expect(JSON.stringify(events)).not.toContain(SIG);
        expect(JSON.stringify(events)).not.toContain('hidden');
        const usage = events.find((e) => e.type === 'usage');
        expect(usage).toEqual({
            type: 'usage',
            tokensIn: 11,
            tokensOut: 335,
            cacheWrite: 0,
            cacheRead: 0
        });
        expect(events.find((e) => e.type === 'done')).toEqual({ type: 'done', stopReason: 'end' });
    });

    test('request is stateless Interactions with the key only in the header', async () => {
        let captured;
        await collect({
            system: 'You are helpful.',
            messages: [{ role: 'user', content: 'Hi' }],
            tools: [{ name: 'get_outline', schema: { type: 'object', properties: {} } }]
        }, {
            getSecret: storedKey,
            getConfig: async () => ({
                model: 'gemini-3.5-flash-lite',
                endpoint: 'https://generativelanguage.googleapis.com/',
                maxTokens: 1024
            }),
            fetch: async (url, opts) => {
                captured = { url, opts };
                return { ok: true, status: 200, body: textStream() };
            }
        });
        expect(captured.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
        expect(captured.url).not.toContain('AIza');
        expect(captured.opts.headers['x-goog-api-key']).toBe('AIzaSyTestKey');
        expect(captured.opts.headers['Api-Revision']).toBe('2026-05-20');
        expect(captured.opts.headers.Authorization).toBeUndefined();
        expect(JSON.stringify(captured.opts.body)).not.toContain('AIzaSyTestKey');
        const body = JSON.parse(captured.opts.body);
        expect(body.stream).toBe(true);
        expect(body.store).toBe(false);
        expect(body.previous_interaction_id).toBeUndefined();
        expect(body.model).toBe('gemini-3.5-flash-lite');
        expect(body.system_instruction).toBe('You are helpful.');
        expect(body.generation_config).toEqual({ max_output_tokens: 1024 });
        expect(body.tools[0].type).toBe('function');
        expect(body.tools[0].name).toBe('get_outline');
    });

    test('two function calls emit one calls array', async () => {
        const events = await collect({
            turnId: 'two-calls',
            messages: [{ role: 'user', content: 'outline' }],
            tools: [{ name: 'get_outline' }, { name: 'get_title' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: okFetch(toolStream([
                { id: 'c1', name: 'get_outline', delta: '{"q":"a"}', stop: true },
                { id: 'c2', name: 'get_title', delta: '{}', stop: true }
            ]))
        });
        const toolUse = events.filter((e) => e.type === 'tool_use');
        expect(toolUse).toHaveLength(1);
        expect(toolUse[0].calls).toEqual([
            { id: 'c1', name: 'get_outline', args: { q: 'a' } },
            { id: 'c2', name: 'get_title', args: {} }
        ]);
        expect(JSON.stringify(events)).not.toContain(SIG);
        expect(events.find((e) => e.type === 'done').stopReason).toBe('tool');
    });

    test('truncated tool JSON does not drop a valid sibling', async () => {
        const events = await collect({
            messages: [{ role: 'user', content: 'go' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: okFetch(toolStream([
                { id: 'ok', name: 'get_outline', delta: '{"ok":true}', stop: true },
                { id: 'bad', name: 'get_title', delta: '{"q":', stop: true }
            ]))
        });
        expect(events.find((e) => e.type === 'tool_use').calls).toEqual([
            { id: 'ok', name: 'get_outline', args: { ok: true } }
        ]);
        expect(events.filter((e) => e.type === 'tool_use_truncated')).toEqual([{
            type: 'tool_use_truncated',
            id: 'bad',
            name: 'get_title',
            jsonLen: 5
        }]);
    });

    test('round 2 replays the thought step, and a text round deletes it', async () => {
        const bodies = [];
        const fetchFn = async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            const round = bodies.length;
            if (round === 1) {
                return { ok: true, status: 200, body: toolStream([
                    { id: 'c1', name: 'get_status', delta: '{}', stop: true }
                ]) };
            }
            return { ok: true, status: 200, body: textStream() };
        };
        const deps = { getSecret: storedKey, getConfig: emptyConfig, fetch: fetchFn, now: 1_000 };
        await collect({
            turnId: 't-replay',
            messages: [{ role: 'user', content: 'status?' }]
        }, deps);
        const follow = [
            { role: 'user', content: 'status?' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_status', args: {} }] },
            { role: 'tool', toolCallId: 'c1', name: 'get_status', content: { ok: true } }
        ];
        const events = await collect({ turnId: 't-replay', messages: follow }, deps);
        expect(JSON.stringify(events)).not.toContain(SIG);
        const input = bodies[1].input;
        const thoughtAt = input.findIndex((step) => step.type === 'thought');
        const callAt = input.findIndex((step) => step.type === 'function_call');
        expect(thoughtAt).toBeGreaterThanOrEqual(0);
        expect(callAt).toBe(thoughtAt + 1);
        expect(input[thoughtAt]).toEqual({ type: 'thought', signature: SIG });
        await collect({ turnId: 't-replay', messages: follow }, deps);
        const later = bodies[2].input;
        expect(later.find((step) => step.type === 'thought')).toBeUndefined();
        expect(JSON.stringify(later)).not.toContain(SIG);
    });

    test('a different turnId does not receive the stored thought step', async () => {
        const bodies = [];
        const fetchFn = async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            if (bodies.length === 1) {
                return { ok: true, status: 200, body: toolStream([
                    { id: 'c1', name: 'get_status', delta: '{}', stop: true }
                ]) };
            }
            return { ok: true, status: 200, body: textStream() };
        };
        const deps = { getSecret: storedKey, getConfig: emptyConfig, fetch: fetchFn };
        await collect({
            turnId: 'turn-a',
            messages: [{ role: 'user', content: 'status?' }]
        }, deps);
        await collect({
            turnId: 'turn-b',
            messages: [
                { role: 'user', content: 'status?' },
                { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_status', args: {} }] }
            ]
        }, deps);
        expect(bodies[1].input.find((step) => step.type === 'thought')).toBeUndefined();
    });

    test('an entry older than 30 minutes is dropped', async () => {
        const bodies = [];
        const fetchFn = async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            if (bodies.length === 1) {
                return { ok: true, status: 200, body: toolStream([
                    { id: 'c1', name: 'get_status', delta: '{}', stop: true }
                ]) };
            }
            return { ok: true, status: 200, body: textStream() };
        };
        const start = 5_000;
        await collect({
            turnId: 'turn-old',
            messages: [{ role: 'user', content: 'status?' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFn,
            now: start
        });
        await collect({
            turnId: 'turn-old',
            messages: [
                { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_status', args: {} }] }
            ]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFn,
            now: start + (30 * 60 * 1000) + 1
        });
        expect(bodies[1].input.find((step) => step.type === 'thought')).toBeUndefined();
    });

    test('no turnId stores nothing', async () => {
        const bodies = [];
        const fetchFn = async (url, opts) => {
            bodies.push(JSON.parse(opts.body));
            if (bodies.length === 1) {
                return { ok: true, status: 200, body: toolStream([
                    { id: 'c1', name: 'get_status', delta: '{}', stop: true }
                ]) };
            }
            return { ok: true, status: 200, body: textStream() };
        };
        const deps = { getSecret: storedKey, getConfig: emptyConfig, fetch: fetchFn };
        await collect({
            messages: [{ role: 'user', content: 'status?' }]
        }, deps);
        await collect({
            turnId: 'later',
            messages: [
                { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_status', args: {} }] }
            ]
        }, deps);
        expect(bodies[1].input.find((step) => step.type === 'thought')).toBeUndefined();
    });

    test('fetch failed with ECONNRESET is retryable and names the code', async () => {
        const events = await collect({
            turnId: 'err',
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFailed('ECONNRESET')
        });
        expect(events).toEqual([{
            type: 'error',
            code: 'AI_PROVIDER_ERROR',
            message: 'fetch failed (ECONNRESET)',
            retryable: true
        }]);
    });

    test('ENOTFOUND stays retryable false', async () => {
        const notFound = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFailed('ENOTFOUND')
        });
        expect(notFound).toEqual([{
            type: 'error',
            code: 'AI_PROVIDER_ERROR',
            message: 'fetch failed (ENOTFOUND)',
            retryable: false
        }]);
    });

    test('429 and 503 are retryable and the body key is redacted', async () => {
        const tooMany = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: async () => ({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                json: async () => ({
                    error: { message: 'rate limited for AIzaSyLeakedKEY' }
                })
            })
        });
        expect(tooMany).toEqual([{
            type: 'error',
            code: 'AI_RATE_LIMIT',
            message: 'rate limited for AIza…',
            retryable: true
        }]);
        expect(JSON.stringify(tooMany)).not.toContain('AIzaSyLeakedKEY');
        const overloaded = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: async () => ({
                ok: false,
                status: 503,
                statusText: 'Unavailable',
                json: async () => ({ error: { message: 'overloaded' } })
            })
        });
        expect(overloaded[0].code).toBe('AI_RATE_LIMIT');
        expect(overloaded[0].retryable).toBe(true);

        const fromText = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: async () => ({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: { get: (name) => (name === 'retry-after' ? '4' : null) },
                text: async () => ')]}\'\n{"error":{"message":"gemini-3.8-flash is currently experiencing high demand"}}'
            })
        });
        expect(fromText[0].message).toMatch(/high demand/);
        expect(fromText[0].retryable).toBe(true);
        expect(fromText[0].retryAfterMs).toBe(4000);

        const blocked = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: async () => ({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                json: async () => ({
                    error: {
                        message: 'Rate limit exceeded for model gemini-3.1-pro (limit: 0 input tokens per minute on Free Tier). Please upgrade your tier at https://ai.dev/rate-limit.'
                    }
                })
            })
        });
        expect(blocked[0].retryable).toBe(false);
        expect(blocked[0].code).toBe('AI_PROVIDER_ERROR');
        expect(blocked[0].message).toMatch(/limit: 0/);
    });

    test('missing key emits AI_NO_API_KEY without fetch', async () => {
        let fetched = false;
        const events = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: async () => '',
            getConfig: emptyConfig,
            fetch: async () => {
                fetched = true;
                throw new Error('should not fetch');
            }
        });
        expect(fetched).toBe(false);
        expect(events).toEqual([{
            type: 'error',
            code: 'AI_NO_API_KEY',
            message: 'Gemini API key is not configured.',
            retryable: false
        }]);
    });

    test('abortSignal cancels the in-flight request', async () => {
        const abort = new AbortController();
        let sawSignal = false;
        const fetchFn = (url, opts) => {
            sawSignal = !!(opts && opts.signal);
            return new Promise((resolve, reject) => {
                opts.signal.addEventListener('abort', () => {
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        };
        const events = [];
        const pending = completeGoogle({
            messages: [{ role: 'user', content: 'Hi' }],
            emit: (event) => events.push(event),
            abortSignal: abort.signal
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFn
        });
        await new Promise((resolve) => setImmediate(resolve));
        abort.abort();
        await pending;
        expect(sawSignal).toBe(true);
        expect(events).toEqual([]);
    });

    test('plugin timeout emits AI_TIMEOUT', async () => {
        const fetchFn = (url, opts) => new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
            });
        });
        const events = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: async () => ({ timeoutMs: 20 }),
            fetch: fetchFn
        });
        expect(events).toEqual([{
            type: 'error',
            code: 'AI_TIMEOUT',
            message: 'Request timed out.',
            retryable: false
        }]);
    });
});

// EOF plugins/ai-google/webapp/tests/unit/complete-google.test.js
