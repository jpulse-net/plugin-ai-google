/**
 * @name            jPulse Framework / Plugins / AI Google / WebApp / Controller
 * @tagline         Gemini onAiComplete provider with Interactions SSE
 * @description     Streams Interactions API events into the published ai-core
 *                  contract: array tool_use, four-way usage, $/MTok prices.
 *                  Thought steps stay in memory for one turn.
 * @file            plugins/ai-google/webapp/controller/aiGoogle.js
 * @version         1.0.0
 * @release         2026-09-30
 * @repository      https://github.com/jpulse-net/plugin-ai-google
 * @author          Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @copyright       2026 Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @license         BSL 1.1 -- see LICENSE file; for commercial use: team@jpulse.net
 * @genai           80%, Cursor, Grok 4.7
 */

const PLUGIN_ID = 'ai-google';
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOKENS = 8192;
const API_REVISION = '2026-05-20';
const SENSITIVE_MASK = '********';
const TURN_THOUGHT_TTL_MS = 30 * 60 * 1000;

/** USD per million tokens. Standard paid tier. Verified 2026-09-29 from Gemini API pricing. */
export const PRICE_TABLE = {
    'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheWrite: 0, cacheRead: 0.075 },
    'gemini-3.5-flash-lite': { input: 0.30, output: 2.50, cacheWrite: 0, cacheRead: 0.03 },
    'gemini-3.1-pro-preview': { input: 2, output: 12, cacheWrite: 0, cacheRead: 0.20 }
};

export const DEFAULT_MODELS = [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' }
];

const turnThoughts = new Map();

function isMask(value) {
    if (global.PluginModel && typeof global.PluginModel.isSensitiveMask === 'function') {
        return global.PluginModel.isSensitiveMask(value);
    }
    return value === SENSITIVE_MASK;
}

function isUsableKey(value) {
    return typeof value === 'string' && value !== '' && !isMask(value);
}

function isValidPriceRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return false;
    }
    return ['input', 'output', 'cacheWrite', 'cacheRead'].every((k) => {
        return typeof row[k] === 'number' && Number.isFinite(row[k]);
    });
}

function clonePriceTable(table) {
    const out = {};
    Object.keys(table).forEach((id) => {
        out[id] = { ...table[id] };
    });
    return out;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function nowOf(deps) {
    if (deps && typeof deps.now === 'number') return deps.now;
    if (deps && typeof deps.now === 'function') return deps.now();
    return Date.now();
}

function turnKey(context) {
    if (!context || context.turnId == null) return '';
    const id = String(context.turnId).trim();
    return id;
}

export function resetTurnThoughts() {
    turnThoughts.clear();
}

function pruneTurnThoughts(now) {
    turnThoughts.forEach((entry, id) => {
        if (!entry || now - entry.updatedAt > TURN_THOUGHT_TTL_MS) {
            turnThoughts.delete(id);
        }
    });
}

function roundsForTurn(turnId, now) {
    pruneTurnThoughts(now);
    if (!turnId) return [];
    const entry = turnThoughts.get(turnId);
    return entry && Array.isArray(entry.rounds) ? entry.rounds : [];
}

function appendTurnRound(turnId, steps, callIds, now) {
    pruneTurnThoughts(now);
    if (!turnId) return;
    let entry = turnThoughts.get(turnId);
    if (!entry) {
        entry = { rounds: [], updatedAt: now };
        turnThoughts.set(turnId, entry);
    }
    entry.rounds.push({
        steps: cloneJson(steps || []),
        callIds: (callIds || []).slice()
    });
    entry.updatedAt = now;
}

function deleteTurnThoughts(turnId) {
    if (turnId) turnThoughts.delete(turnId);
}

export function mergePriceTable(overrideJson) {
    const merged = clonePriceTable(PRICE_TABLE);
    if (typeof overrideJson === 'string' && overrideJson.trim()) {
        try {
            const parsed = JSON.parse(overrideJson);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                Object.keys(parsed).forEach((id) => {
                    if (!parsed[id] || typeof parsed[id] !== 'object' || Array.isArray(parsed[id])) {
                        return;
                    }
                    const candidate = { ...(merged[id] || {}), ...parsed[id] };
                    if (isValidPriceRow(candidate)) {
                        merged[id] = candidate;
                    }
                });
            }
        } catch (_err) { /* keep built-in table */ }
    }
    return merged;
}

export function ratesForModel(model, overrideJson) {
    const table = mergePriceTable(overrideJson);
    const row = table[model];
    if (!row || typeof row !== 'object') {
        return null;
    }
    const out = {};
    let known = false;
    ['input', 'output', 'cacheWrite', 'cacheRead'].forEach((k) => {
        if (typeof row[k] === 'number' && Number.isFinite(row[k])) {
            out[k] = row[k];
            known = true;
        }
    });
    return known ? out : null;
}

export function toGoogleTools(tools) {
    const list = Array.isArray(tools) ? tools : [];
    return list.map((t) => {
        const schema = t.schema && typeof t.schema === 'object'
            ? t.schema
            : { type: 'object', properties: {} };
        return {
            type: 'function',
            name: t.name,
            description: t.description || t.name,
            parameters: schema
        };
    });
}

function userContentParts(content) {
    if (Array.isArray(content)) {
        const parts = [];
        content.forEach((part) => {
            if (!part || typeof part !== 'object') return;
            if (part.type === 'image') {
                parts.push({
                    type: 'image',
                    mime_type: part.mimeType || 'image/jpeg',
                    data: String(part.data || '')
                });
                return;
            }
            if (part.type === 'text') {
                parts.push({ type: 'text', text: String(part.text || '') });
            }
        });
        return parts;
    }
    return [{ type: 'text', text: String(content || '') }];
}

function pushThoughtsBefore(out, toolCalls, rounds, used) {
    (toolCalls || []).forEach((tc) => {
        const id = tc && tc.id ? tc.id : '';
        const round = (rounds || []).find((item) => {
            return item && !used.has(item) && Array.isArray(item.callIds) && item.callIds.indexOf(id) !== -1;
        });
        if (round) {
            used.add(round);
            (round.steps || []).forEach((step) => out.push(step));
        }
        const args = tc && tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args)
            ? tc.args
            : {};
        out.push({
            type: 'function_call',
            id: id,
            name: (tc && tc.name) || '',
            arguments: args
        });
    });
}

export function toGoogleInput(messages, rounds) {
    const out = [];
    const used = new Set();
    (messages || []).forEach((m) => {
        if (!m || !m.role) return;
        if (m.role === 'system') return;
        if (m.role === 'tool') {
            const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            out.push({
                type: 'function_result',
                name: m.name || '',
                call_id: m.toolCallId || m.id || '',
                result: [{ type: 'text', text }]
            });
            return;
        }
        if (m.role === 'assistant') {
            if (m.content) {
                out.push({
                    type: 'model_output',
                    content: [{ type: 'text', text: String(m.content) }]
                });
            }
            pushThoughtsBefore(out, m.toolCalls, rounds, used);
            return;
        }
        if (m.role === 'user') {
            const parts = userContentParts(m.content);
            if (parts.length) {
                out.push({ type: 'user_input', content: parts });
            }
        }
    });
    return out;
}

export const toGoogleMessages = toGoogleInput;

export function mapUsage(raw) {
    const u = raw && typeof raw === 'object' ? raw : {};
    const output = u.total_output_tokens || 0;
    const thought = u.total_thought_tokens || 0;
    return {
        tokensIn: u.total_input_tokens || 0,
        tokensOut: output + thought,
        cacheWrite: 0,
        cacheRead: u.total_cached_tokens || 0
    };
}

export function mapStopReason(reason) {
    if (reason === 'requires_action' || reason === 'function_call' || reason === 'tool_calls' || reason === 'tool_use') {
        return 'tool';
    }
    if (reason === 'incomplete' || reason === 'budget_exceeded'
        || reason === 'max_output_tokens' || reason === 'max_tokens' || reason === 'length') {
        return 'length';
    }
    return 'end';
}

export function sanitizeError(text) {
    return String(text || 'Google request failed').replace(
        /AIza[0-9A-Za-z_-]+/g,
        'AIza…'
    );
}

function messageFromErrorBody(body) {
    if (!body || typeof body !== 'object') {
        return '';
    }
    if (body.error && typeof body.error.message === 'string' && body.error.message) {
        return body.error.message;
    }
    if (typeof body.message === 'string') {
        return body.message;
    }
    return '';
}

export function permanentQuota(message) {
    return /limit:\s*0\b/i.test(message) || /upgrade your tier/i.test(message);
}

export async function readProviderError(res) {
    const fallback = (res && res.statusText) || '';
    let raw = '';
    try {
        if (res && typeof res.text === 'function') {
            raw = await res.text();
        } else if (res && typeof res.json === 'function') {
            return messageFromErrorBody(await res.json()) || fallback;
        }
    } catch (_err) {
        return fallback;
    }
    const trimmed = String(raw || '').replace(/^\)\]\}',?\s*/, '').trim();
    if (!trimmed) {
        return fallback;
    }
    try {
        return messageFromErrorBody(JSON.parse(trimmed)) || fallback;
    } catch (_err) {
        if (trimmed.length <= 400 && trimmed.charAt(0) !== '<') {
            return trimmed;
        }
        return fallback;
    }
}

export function retryAfterMs(res) {
    const headers = res && res.headers;
    if (!headers || typeof headers.get !== 'function') {
        return 0;
    }
    const raw = headers.get('retry-after');
    if (raw == null || raw === '') {
        return 0;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.round(seconds * 1000), 30000);
    }
    const when = Date.parse(raw);
    if (Number.isNaN(when)) {
        return 0;
    }
    return Math.min(Math.max(0, when - Date.now()), 30000);
}

const RETRYABLE_CAUSE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT'
]);

function causeCode(error) {
    const cause = error && error.cause;
    if (!cause || typeof cause !== 'object') {
        return '';
    }
    return typeof cause.code === 'string' ? cause.code : '';
}

export function consumeSse(buffer) {
    const normalized = String(buffer || '').replace(/\r\n/g, '\n');
    const parts = normalized.split('\n\n');
    const rest = parts.pop() || '';
    const events = [];
    parts.forEach((block) => {
        let data = '';
        String(block).split('\n').forEach((line) => {
            if (line.indexOf('data:') === 0) {
                const chunk = line.slice(5).trim();
                data = data ? data + '\n' + chunk : chunk;
            }
        });
        if (!data || data === '[DONE]') return;
        try {
            events.push(JSON.parse(data));
        } catch (_err) { /* skip malformed */ }
    });
    return { events, rest };
}

async function loadPluginModel() {
    if (global.PluginModel) return global.PluginModel;
    const mod = await import('../../../../webapp/model/plugin.js');
    return mod.default;
}

async function defaultGetSecret() {
    const PluginModel = await loadPluginModel();
    if (!PluginModel || typeof PluginModel.getSecret !== 'function') return '';
    const value = await PluginModel.getSecret(PLUGIN_ID, 'apiKey');
    return typeof value === 'string' ? value : '';
}

async function defaultGetConfig() {
    const PluginModel = await loadPluginModel();
    if (!PluginModel || typeof PluginModel.getByName !== 'function') return {};
    const doc = await PluginModel.getByName(PLUGIN_ID);
    return (doc && doc.config) || {};
}

function headerMap(apiKey) {
    return {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        'Api-Revision': API_REVISION
    };
}

function endpointOf(config) {
    const raw = (config && config.endpoint) || DEFAULT_ENDPOINT;
    return String(raw).replace(/\/+$/, '');
}

/**
 * Same rule as EmailController._resolveTestSmtpPass: a newly typed (non-empty,
 * non-mask) field value is used as-is so Verify works before Save. Mask or
 * empty falls back to the stored secret.
 * @param {*} submitted - apiKey from the request body
 * @param {*} stored - PluginModel.getSecret value
 * @returns {string}
 */
export function resolveVerifyApiKey(submitted, stored) {
    if (isUsableKey(submitted)) {
        return submitted;
    }
    if (isUsableKey(stored)) {
        return stored;
    }
    return '';
}

export async function buildProviderDescriptor(deps) {
    deps = deps || {};
    const getSecret = deps.getSecret || defaultGetSecret;
    const getConfig = deps.getConfig || defaultGetConfig;
    let maxTokens = DEFAULT_MAX_TOKENS;
    let overrideJson = '';
    try {
        const config = await getConfig();
        const n = parseInt(config.maxTokens, 10);
        if (Number.isFinite(n) && n > 0) maxTokens = n;
        if (typeof config.priceTableOverride === 'string') {
            overrideJson = config.priceTableOverride;
        }
    } catch (_err) { /* tests and first boot have no plugin doc */ }
    let apiKey = '';
    try {
        apiKey = await getSecret();
    } catch (_err) { /* same: no plugin doc yet */ }
    return {
        plugin: PLUGIN_ID,
        label: 'Google',
        models: DEFAULT_MODELS.slice(),
        capabilities: { vision: true },
        priceTable: mergePriceTable(overrideJson),
        maxTokens,
        configured: isUsableKey(apiKey)
    };
}

export async function pingModels(deps) {
    const getSecret = deps.getSecret || defaultGetSecret;
    const getConfig = deps.getConfig || defaultGetConfig;
    const fetchFn = deps.fetch || global.fetch;
    const stored = await getSecret();
    const apiKey = resolveVerifyApiKey(deps.apiKey, stored);
    if (!apiKey) {
        return { configured: false, valid: false, message: 'Gemini API key is not configured.' };
    }
    const config = await getConfig();
    const endpoint = (typeof deps.endpoint === 'string' && deps.endpoint.trim())
        ? String(deps.endpoint).replace(/\/+$/, '')
        : endpointOf(config);
    const url = endpoint + '/v1beta/models';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
        const res = await fetchFn(url, {
            method: 'GET',
            headers: headerMap(apiKey),
            signal: ctrl.signal
        });
        if (res.ok) {
            return { configured: true, valid: true, message: 'Gemini API key is valid.' };
        }
        if (res.status === 401 || res.status === 403) {
            return { configured: true, valid: false, message: 'Google rejected the API key.' };
        }
        return {
            configured: true,
            valid: false,
            message: sanitizeError('Gemini verify failed (' + res.status + ').')
        };
    } catch (error) {
        if (error && error.name === 'AbortError') {
            return { configured: true, valid: false, message: 'Gemini verify timed out.' };
        }
        return { configured: true, valid: false, message: sanitizeError(error && error.message) };
    } finally {
        clearTimeout(t);
    }
}

async function readSse(body, onEvent, signal) {
    if (!body || typeof body.getReader !== 'function') {
        const text = typeof body === 'string' ? body
            : (body && typeof body.text === 'function' ? await body.text() : '');
        const parsed = consumeSse(text + '\n\n');
        parsed.events.forEach(onEvent);
        return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        if (signal && signal.aborted) {
            try { await reader.cancel(); } catch (_err) { /* ignore */ }
            return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = consumeSse(buf);
        buf = parsed.rest;
        parsed.events.forEach(onEvent);
    }
    if (buf.trim()) {
        consumeSse(buf + '\n\n').events.forEach(onEvent);
    }
}

function parseToolArgs(tb) {
    if (!tb.stopped) {
        return { ok: false };
    }
    if (!tb.json) {
        return { ok: true, args: {} };
    }
    try {
        const parsed = JSON.parse(tb.json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, args: parsed };
        }
        return { ok: true, args: {} };
    } catch (_err) {
        return { ok: false };
    }
}

function thoughtStepOf(block) {
    const step = { type: 'thought' };
    if (block.signature) step.signature = block.signature;
    if (block.summary) {
        step.summary = [{ type: 'text', text: block.summary }];
    }
    return step;
}

function noteStatus(current, status) {
    if (status === 'requires_action') return 'requires_action';
    if ((status === 'incomplete' || status === 'budget_exceeded') && current !== 'requires_action') {
        return status;
    }
    return current;
}

function applyStreamEvent(state, ev, emit) {
    if (!ev || !ev.event_type) return;
    const index = typeof ev.index === 'number' ? ev.index : 0;
    if (ev.event_type === 'step.start' && ev.step) {
        if (ev.step.type === 'thought') {
            state.thoughts[index] = { index, signature: '', summary: '', stopped: false };
        } else if (ev.step.type === 'function_call') {
            state.tools[index] = {
                index,
                id: ev.step.id || '',
                name: ev.step.name || '',
                json: '',
                stopped: false
            };
        } else if (ev.step.type === 'model_output') {
            state.outputs[index] = true;
        }
        return;
    }
    if (ev.event_type === 'step.delta' && ev.delta) {
        const delta = ev.delta;
        if (delta.type === 'text' && delta.text && state.outputs[index]) {
            emit({ type: 'text_delta', text: delta.text });
        } else if (delta.type === 'thought_signature' && state.thoughts[index]) {
            state.thoughts[index].signature = typeof delta.signature === 'string' ? delta.signature : '';
        } else if (delta.type === 'thought_summary' && state.thoughts[index]) {
            const bit = delta.content && typeof delta.content.text === 'string' ? delta.content.text : '';
            state.thoughts[index].summary += bit;
        } else if (delta.type === 'arguments_delta' && state.tools[index] && typeof delta.arguments === 'string') {
            state.tools[index].json += delta.arguments;
        }
        return;
    }
    if (ev.event_type === 'step.stop') {
        if (state.thoughts[index]) state.thoughts[index].stopped = true;
        if (state.tools[index]) state.tools[index].stopped = true;
        return;
    }
    if (ev.event_type === 'interaction.status_update') {
        state.stopReason = noteStatus(state.stopReason, ev.status);
        return;
    }
    if (ev.event_type === 'interaction.completed') {
        const interaction = ev.interaction && typeof ev.interaction === 'object' ? ev.interaction : {};
        if (interaction.usage) {
            const u = mapUsage(interaction.usage);
            state.usage.tokensIn = u.tokensIn;
            state.usage.tokensOut = u.tokensOut;
            state.usage.cacheWrite = u.cacheWrite;
            state.usage.cacheRead = u.cacheRead;
        }
        state.stopReason = noteStatus(state.stopReason, interaction.status);
        if (interaction.status === 'failed') state.failed = true;
        return;
    }
    if (ev.event_type === 'error') {
        const message = ev.error && ev.error.message ? ev.error.message : 'Gemini request failed';
        state.streamError = sanitizeError(message);
    }
}

export async function completeGoogle(context, deps) {
    deps = deps || {};
    const getSecret = deps.getSecret || defaultGetSecret;
    const getConfig = deps.getConfig || defaultGetConfig;
    const fetchFn = deps.fetch || global.fetch;
    const emit = typeof context.emit === 'function' ? context.emit : function() {};
    const now = nowOf(deps);
    const turnId = turnKey(context);

    const apiKey = await getSecret();
    if (!isUsableKey(apiKey)) {
        emit({
            type: 'error',
            code: 'AI_NO_API_KEY',
            message: 'Gemini API key is not configured.',
            retryable: false
        });
        return context;
    }

    const config = await getConfig();
    const model = context.model || config.model || DEFAULT_MODEL;
    const timeoutMs = parseInt(config.timeoutMs, 10) || DEFAULT_TIMEOUT_MS;
    const maxTokens = parseInt(config.maxTokens, 10) || DEFAULT_MAX_TOKENS;
    const systemText = typeof context.system === 'string' ? context.system.trim() : '';
    const rounds = turnId ? roundsForTurn(turnId, now) : [];
    const body = {
        model,
        input: toGoogleInput(context.messages, rounds),
        stream: true,
        store: false,
        generation_config: { max_output_tokens: maxTokens }
    };
    if (systemText) body.system_instruction = systemText;
    const tools = toGoogleTools(context.tools);
    if (tools.length) body.tools = tools;

    const ctrl = new AbortController();
    const onAbort = function() { ctrl.abort(); };
    if (context.abortSignal) {
        if (context.abortSignal.aborted) {
            return context;
        }
        context.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const url = endpointOf(config) + '/v1beta/interactions';

    try {
        const res = await fetchFn(url, {
            method: 'POST',
            headers: headerMap(apiKey),
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
        if (!res.ok) {
            const detail = await readProviderError(res);
            const message = sanitizeError(detail || ('HTTP ' + res.status));
            const retryable = (res.status === 429 || res.status === 503) && !permanentQuota(message);
            const event = {
                type: 'error',
                code: retryable ? 'AI_RATE_LIMIT' : 'AI_PROVIDER_ERROR',
                message,
                retryable
            };
            const waitMs = retryAfterMs(res);
            if (retryable && waitMs > 0) {
                event.retryAfterMs = waitMs;
            }
            emit(event);
            return context;
        }

        const state = {
            usage: { tokensIn: 0, tokensOut: 0, cacheWrite: 0, cacheRead: 0 },
            thoughts: {},
            tools: {},
            outputs: {},
            stopReason: '',
            failed: false,
            streamError: ''
        };
        await readSse(res.body, function(ev) {
            applyStreamEvent(state, ev, emit);
        }, context.abortSignal);

        if (context.abortSignal && context.abortSignal.aborted) {
            return context;
        }
        if (state.streamError || state.failed) {
            emit({
                type: 'error',
                code: 'AI_PROVIDER_ERROR',
                message: state.streamError || 'Gemini request failed',
                retryable: false
            });
            return context;
        }

        const calls = [];
        const truncated = [];
        const thoughtSteps = Object.keys(state.thoughts)
            .map((key) => state.thoughts[key])
            .filter((block) => block && block.stopped)
            .sort((a, b) => a.index - b.index)
            .map(thoughtStepOf);
        Object.keys(state.tools)
            .map((key) => state.tools[key])
            .sort((a, b) => a.index - b.index)
            .forEach((tb) => {
                const parsed = parseToolArgs(tb);
                if (parsed.ok) {
                    calls.push({ id: tb.id, name: tb.name, args: parsed.args });
                    return;
                }
                truncated.push({
                    type: 'tool_use_truncated',
                    id: tb.id,
                    name: tb.name,
                    jsonLen: (tb.json || '').length
                });
            });
        if (calls.length) {
            emit({ type: 'tool_use', calls });
            state.stopReason = 'function_call';
            if (turnId) {
                appendTurnRound(turnId, thoughtSteps, calls.map((call) => call.id), now);
            }
        } else if (turnId) {
            deleteTurnThoughts(turnId);
        }
        truncated.forEach((event) => emit(event));

        context.usage = state.usage;
        emit({ type: 'usage', ...state.usage });
        emit({ type: 'done', stopReason: mapStopReason(state.stopReason) });
        return context;
    } catch (error) {
        if (error && error.name === 'AbortError') {
            if (context.abortSignal && context.abortSignal.aborted) {
                return context;
            }
            emit({
                type: 'error',
                code: 'AI_TIMEOUT',
                message: 'Request timed out.',
                retryable: false
            });
            return context;
        }
        const code = causeCode(error);
        const message = sanitizeError(
            code ? ('fetch failed (' + code + ')') : (error && error.message)
        );
        emit({
            type: 'error',
            code: 'AI_PROVIDER_ERROR',
            message,
            retryable: RETRYABLE_CAUSE_CODES.has(code)
        });
        return context;
    } finally {
        clearTimeout(timer);
        if (context.abortSignal) {
            context.abortSignal.removeEventListener('abort', onAbort);
        }
    }
}

class AiGoogleController {
    static hooks = {
        onAiProviderRegister: { handler: 'onAiProviderRegister' },
        onAiComplete: { handler: 'onAiComplete' }
    };

    static routes = [
        { method: 'POST', path: '/api/1/aiGoogle/verify-api-key', handler: 'apiVerifyApiKey', auth: 'admin' }
    ];

    static async onAiProviderRegister(context) {
        if (!Array.isArray(context.providers)) context.providers = [];
        context.providers.push(await buildProviderDescriptor());
        return context;
    }

    static async onAiComplete(context) {
        return completeGoogle(context);
    }

    static async apiVerifyApiKey(req, res) {
        const startTime = Date.now();
        const LogController = global.LogController;
        const CommonUtils = global.CommonUtils;
        const AuthController = global.AuthController;
        const sendError = (status, message, code, extra) => {
            if (CommonUtils?.sendError) {
                return CommonUtils.sendError(req, res, status, message, code, extra);
            }
            return res.status(status).json({ success: false, error: message, code });
        };
        try {
            LogController?.logRequest(req, 'aiGoogle.verifyApiKey', 'verify request');
            const Auth = AuthController || (await import('../../../../webapp/controller/auth.js')).default;
            if (!Auth || !Auth.isAdmin(req)) {
                LogController?.logError(req, 'aiGoogle.verifyApiKey', 'error: admin role required');
                return sendError(403, 'Administrator access required', 'FORBIDDEN');
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const result = await pingModels({
                apiKey: body.apiKey,
                endpoint: body.endpoint
            });
            const elapsed = Date.now() - startTime;
            LogController?.logInfo(req, 'aiGoogle.verifyApiKey',
                `success: configured=${result.configured} valid=${result.valid} completed in ${elapsed}ms`);
            res.json({
                success: true,
                data: { configured: result.configured, valid: result.valid },
                message: result.message,
                elapsed
            });
        } catch (error) {
            LogController?.logError(req, 'aiGoogle.verifyApiKey', 'error: ' + error.message);
            return sendError(500, 'Failed to verify Gemini API key', 'INTERNAL_ERROR', error.message);
        }
    }
}

export default AiGoogleController;

// EOF plugins/ai-google/webapp/controller/aiGoogle.js
