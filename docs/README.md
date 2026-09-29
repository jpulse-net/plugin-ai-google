# jPulse Docs / Installed Plugins / Google Gemini AI Provider Plugin v1.0.0

The Google plugin is a Gemini backend for the site AI agent. It does not add a panel of its own. Enable it, save an API key, then set **Site Configuration → AI** to Google (default provider / model, or the allowed list).

This page is at `/jpulse-docs/installed-plugins/ai-google/README`. A trailing slash is rewritten to `index.shtml` before markdown routing and 404s.

## Features

- **Gemini completions** — streams the Interactions API into the `ai-core` turn loop (text, parallel tool use, usage, done).
- **Four-way token accounting** — input, output, cache write, and cache read, in USD per million tokens.
- **Password API key** — bulk config reads return a mask; completions use the stored secret on the server.
- **Verify** — GET `/v1beta/models` with the key in the form field. The button never receives the stored-only value.

## Setup

1. Install: `npx jpulse plugin install @jpulse-net/plugin-ai-google` (pulls `ai-core` if needed).
2. Enable **ai-google** under **Admin → Plugins** if it is not already enabled, and restart.
3. Open **Plugins → ai-google → Configure**.
4. Paste the API key on the **Provider** tab.
5. Click **Verify API key** — it uses the value in the field, so you do not need to Save first. Then **Save Changes**.
6. On **Site Configuration → AI**, set the default provider / model or the allowed list.

Start a thread and a turn over HTTP, or use the chat panel:

```
POST /api/1/ai/thread          { "scopeType": "doc", "scopeId": "<id>" }
POST /api/1/ai/thread/:id/turn { "text": "Summarize this." }
```

The second call is Server-Sent Events.

## Provider tab

| Field | Default | Notes |
|-------|---------|-------|
| API key | empty | `AIza…`. Masked in GET config. Reveal on this form is audited. |
| Verify API key | — | Calls GET `{endpoint}/v1beta/models` with the key in the field (unsaved is fine). Never returns the key. |
| Default model | Gemini 3.8 Flash | Used when Site Configuration → AI does not pick a model. |
| API endpoint | `https://generativelanguage.googleapis.com` | No trailing path. Completions POST `{endpoint}/v1beta/interactions`. |
| Request timeout (ms) | 60000 | Abort one HTTP request after this many milliseconds. |
| Max output tokens | 8192 | Cap on a single completion. |

Models in the list: Gemini 3.8 Flash, Gemini 3.5 Flash-Lite, Gemini 3.1 Pro.

## Pricing tab

Leave the override empty to use the built-in prices (USD per million tokens, Standard paid tier, verified 2026-09-29 from the Gemini API pricing page). Gemini 3.8 Flash uses the introductory rate through 2026-12-31: input 0.75, output 3.75, cache read 0.075. From 2027-01-01 the standard rate is input 1.50, output 7.50, cache read 0.15. Put that rate in the override, or install a later plugin release that ships it. Cache write is 0 because Google bills cache storage per hour, not as a per-request write token. An unknown model stores cost `null` — it must not cost $0.

To override, paste a JSON object. Keys are model ids. Each value needs four numbers — `input`, `output`, `cacheWrite`, `cacheRead` — in $/MTok:

```json
{ "gemini-3.8-flash": { "input": 0.75, "output": 3.75, "cacheWrite": 0, "cacheRead": 0.075 } }
```

Invalid JSON is ignored and the built-in table stays in effect.

## Security

- The key is `type: "password"`. Completions read it with `PluginModel.getSecret`.
- Verify and error messages never include the key.
- The Verify button posts only the form field (mask or newly typed). It does not read the stored secret in the browser.

## Technical details

- **JavaScript**: `webapp/controller/aiGoogle.js` — `onAiProviderRegister` / `onAiComplete`; `webapp/view/jpulse-common.js` — Verify button (`jPulse.plugins.aiGoogle.verifyApiKey`).
- **Hooks**: `onAiProviderRegister` (continue) and `onAiComplete` (abort), defined by `ai-core`. This plugin only handles them. It does not import from `plugins/ai-core/`.
- **Depends on**: `ai-core` (`@jpulse-net/plugin-ai-core` >= 1.0.0). jPulse >= 2.0.2.

## Plugin releases

- **1.0.0**, 2026-09-30: First release: published `ai-core` contract (array `tool_use`, four-way usage, $/MTok price table), Interactions API stream, password key, unsaved Verify, Pricing tab override.
