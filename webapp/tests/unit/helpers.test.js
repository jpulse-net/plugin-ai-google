/**
 * @name            jPulse Framework / Plugins / AI Google / Tests / Unit / Helpers
 * @tagline         SSE parser, usage map, stop reason, sanitize, verify, prices
 * @file            plugins/ai-google/webapp/tests/unit/helpers.test.js
 * @version         1.0.0
 * @release         2026-09-30
 * @repository      https://github.com/jpulse-net/plugin-ai-google
 * @author          Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @copyright       2026 Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @license         BSL 1.1 -- see LICENSE file; for commercial use: team@jpulse.net
 * @genai           80%, Cursor, Grok 4.7
 */

import { describe, expect, test } from '@jest/globals';
import {
    consumeSse,
    mapStopReason,
    mapUsage,
    mergePriceTable,
    pingModels,
    PRICE_TABLE,
    ratesForModel,
    resolveVerifyApiKey,
    sanitizeError,
    toGoogleInput,
    toGoogleMessages,
    toGoogleTools
} from '../../controller/aiGoogle.js';

describe('consumeSse', () => {
    test('split chunk leaves the incomplete event in the buffer', () => {
        const first = 'data: {"event_type":"a"}\n\ndata: {"event_type":';
        const parsed = consumeSse(first);
        expect(parsed.events).toEqual([{ event_type: 'a' }]);
        expect(parsed.rest).toBe('data: {"event_type":');
        const second = consumeSse(parsed.rest + '"b"}\n\n');
        expect(second.events).toEqual([{ event_type: 'b' }]);
        expect(second.rest).toBe('');
    });

    test('malformed data: line is skipped; rest stays in the buffer', () => {
        const parsed = consumeSse('data: {bad\n\ndata: {"event_type":"ok"}\n\ndata: {"event_type":');
        expect(parsed.events).toEqual([{ event_type: 'ok' }]);
        expect(parsed.rest).toBe('data: {"event_type":');
    });

    test('event: line is ignored and data JSON is kept', () => {
        const block = 'event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"Hi"}}\n\n';
        const parsed = consumeSse(block);
        expect(parsed.events).toEqual([{
            event_type: 'step.delta',
            delta: { type: 'text', text: 'Hi' }
        }]);
        expect(parsed.rest).toBe('');
    });
});

describe('mapUsage', () => {
    test('maps the published interaction.completed usage object', () => {
        expect(mapUsage({
            total_tokens: 346,
            total_input_tokens: 11,
            input_tokens_by_modality: [{ modality: 'text', tokens: 11 }],
            total_cached_tokens: 0,
            total_output_tokens: 90,
            total_tool_use_tokens: 0,
            total_thought_tokens: 245
        })).toEqual({
            tokensIn: 11,
            tokensOut: 335,
            cacheWrite: 0,
            cacheRead: 0
        });
    });

    test('cached tokens are not subtracted from input', () => {
        expect(mapUsage({
            total_input_tokens: 20,
            total_output_tokens: 4,
            total_cached_tokens: 8
        })).toEqual({
            tokensIn: 20,
            tokensOut: 4,
            cacheWrite: 0,
            cacheRead: 8
        });
    });

    test('missing fields are zero', () => {
        expect(mapUsage({})).toEqual({
            tokensIn: 0,
            tokensOut: 0,
            cacheWrite: 0,
            cacheRead: 0
        });
    });
});

describe('mapStopReason', () => {
    test('normalizes the published trio', () => {
        expect(mapStopReason('requires_action')).toBe('tool');
        expect(mapStopReason('function_call')).toBe('tool');
        expect(mapStopReason('incomplete')).toBe('length');
        expect(mapStopReason('budget_exceeded')).toBe('length');
        expect(mapStopReason('max_tokens')).toBe('length');
        expect(mapStopReason('completed')).toBe('end');
        expect(mapStopReason('')).toBe('end');
    });
});

describe('sanitizeError', () => {
    test('redacts AIza keys', () => {
        const out = sanitizeError('invalid key AIzaSyAbc123_xyz-KEY');
        expect(out).toContain('AIza…');
        expect(out).not.toContain('AIzaSyAbc123_xyz-KEY');
    });

    test('never echoes a key from an HTTP error body', () => {
        const body = 'Authentication failed for AIzaSySecretKEY99';
        const out = sanitizeError(body);
        expect(out).not.toMatch(/AIzaSySecretKEY99/);
        expect(out).toContain('AIza…');
    });
});

describe('price table', () => {
    test('built-in table is $/MTok, including cacheWrite 0', () => {
        expect(PRICE_TABLE['gemini-3.8-flash']).toEqual({
            input: 0.75,
            output: 3.75,
            cacheWrite: 0,
            cacheRead: 0.075
        });
        expect(PRICE_TABLE['gemini-3.5-flash-lite']).toEqual({
            input: 0.30,
            output: 2.50,
            cacheWrite: 0,
            cacheRead: 0.03
        });
        expect(PRICE_TABLE['gemini-3.1-pro-preview']).toEqual({
            input: 2,
            output: 12,
            cacheWrite: 0,
            cacheRead: 0.20
        });
        expect(PRICE_TABLE['gemini-2.5-pro']).toBeUndefined();
    });

    test('override JSON merges on top', () => {
        const merged = mergePriceTable(JSON.stringify({
            'gemini-3.8-flash': { input: 1.5 }
        }));
        expect(merged['gemini-3.8-flash'].input).toBe(1.5);
        expect(merged['gemini-3.8-flash'].output).toBe(3.75);
        expect(merged['gemini-3.8-flash'].cacheWrite).toBe(0);
        expect(merged['gemini-3.5-flash-lite'].input).toBe(0.30);
    });

    test('invalid JSON keeps the built-in table', () => {
        expect(mergePriceTable('{')).toEqual(PRICE_TABLE);
        expect(mergePriceTable('not-json')).toEqual(PRICE_TABLE);
    });

    test('unknown model returns null rates', () => {
        expect(ratesForModel('gemini-unknown')).toBeNull();
        expect(ratesForModel('')).toBeNull();
    });

    test('partial row for a new model is ignored', () => {
        const merged = mergePriceTable(JSON.stringify({
            'gemini-next': { input: 5 }
        }));
        expect(merged['gemini-next']).toBeUndefined();
        expect(ratesForModel('gemini-next', JSON.stringify({
            'gemini-next': { input: 5 }
        }))).toBeNull();
    });

    test('a complete new-model row merges', () => {
        const row = { input: 5, output: 15, cacheWrite: 0, cacheRead: 0.5 };
        const merged = mergePriceTable(JSON.stringify({ 'gemini-next': row }));
        expect(merged['gemini-next']).toEqual(row);
    });
});

describe('toGoogleTools', () => {
    test('maps function tools with parameters schema', () => {
        const tools = toGoogleTools([
            { name: 'get_outline', description: 'Outline', schema: { type: 'object', properties: {} } },
            { name: 'get_title', schema: { type: 'object', properties: { q: { type: 'string' } } } }
        ]);
        expect(tools).toHaveLength(2);
        expect(tools[0]).toEqual({
            type: 'function',
            name: 'get_outline',
            description: 'Outline',
            parameters: { type: 'object', properties: {} }
        });
        expect(tools[1].parameters.properties.q).toEqual({ type: 'string' });
    });
});

describe('toGoogleInput', () => {
    test('skips system, maps tool results, and assistant toolCalls', () => {
        const out = toGoogleInput([
            { role: 'system', content: 'ignore' },
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: 'calling',
                toolCalls: [{ id: 'c1', name: 'get_outline', args: { q: 'a' } }]
            },
            { role: 'tool', toolCallId: 'c1', name: 'get_outline', content: { ok: true } }
        ]);
        expect(out).toEqual([
            { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
            { type: 'model_output', content: [{ type: 'text', text: 'calling' }] },
            { type: 'function_call', id: 'c1', name: 'get_outline', arguments: { q: 'a' } },
            {
                type: 'function_result',
                name: 'get_outline',
                call_id: 'c1',
                result: [{ type: 'text', text: JSON.stringify({ ok: true }) }]
            }
        ]);
        expect(toGoogleMessages).toBe(toGoogleInput);
    });

    test('inserts stored thought steps before the matching function_call', () => {
        const thought = { type: 'thought', signature: 'sig-abc' };
        const out = toGoogleInput([
            { role: 'user', content: 'status?' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'get_status', args: {} }]
            }
        ], [{ steps: [thought], callIds: ['c1'] }]);
        expect(out.map((step) => step.type)).toEqual(['user_input', 'thought', 'function_call']);
        expect(out[1]).toEqual(thought);
        expect(out[2].id).toBe('c1');
    });

    test('maps image parts to raw base64 and drops unknown types', () => {
        const out = toGoogleInput([{
            role: 'user',
            content: [
                { type: 'text', text: 'see' },
                { type: 'image', mimeType: 'image/png', data: 'abc' },
                { type: 'file', name: 'skip-me' }
            ]
        }]);
        expect(out[0].content).toEqual([
            { type: 'text', text: 'see' },
            { type: 'image', mime_type: 'image/png', data: 'abc' }
        ]);
    });
});

describe('pingModels', () => {
    test('unsaved non-mask key is sent; empty both is not configured', async () => {
        const missing = await pingModels({
            apiKey: '',
            getSecret: async () => '',
            getConfig: async () => ({}),
            fetch: async () => { throw new Error('should not fetch'); }
        });
        expect(missing).toEqual({
            configured: false,
            valid: false,
            message: 'Gemini API key is not configured.'
        });

        let captured;
        const ok = await pingModels({
            apiKey: 'AIzaSyUnsavedKey',
            endpoint: 'https://generativelanguage.googleapis.com/',
            getSecret: async () => 'AIzaSyStoredKey',
            getConfig: async () => ({}),
            fetch: async (url, opts) => {
                captured = { url, opts };
                return { ok: true, status: 200 };
            }
        });
        expect(ok.valid).toBe(true);
        expect(captured.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
        expect(captured.url).not.toContain('AIza');
        expect(captured.opts.headers['x-goog-api-key']).toBe('AIzaSyUnsavedKey');
    });

    test('401 is configured but invalid', async () => {
        const result = await pingModels({
            apiKey: 'AIzaSyBadKey',
            getSecret: async () => '',
            getConfig: async () => ({}),
            fetch: async () => ({ ok: false, status: 401 })
        });
        expect(result).toEqual({
            configured: true,
            valid: false,
            message: 'Google rejected the API key.'
        });
    });
});

describe('resolveVerifyApiKey', () => {
    test('unsaved non-mask wins', () => {
        expect(resolveVerifyApiKey('AIzaSyNew', 'AIzaSyStored')).toBe('AIzaSyNew');
    });

    test('mask or empty falls back to getSecret', () => {
        expect(resolveVerifyApiKey('********', 'AIzaSyStored')).toBe('AIzaSyStored');
        expect(resolveVerifyApiKey('', 'AIzaSyStored')).toBe('AIzaSyStored');
    });

    test('empty both is not configured', () => {
        expect(resolveVerifyApiKey('', '')).toBe('');
        expect(resolveVerifyApiKey('********', '')).toBe('');
        expect(resolveVerifyApiKey('********', '********')).toBe('');
    });
});

// EOF plugins/ai-google/webapp/tests/unit/helpers.test.js
