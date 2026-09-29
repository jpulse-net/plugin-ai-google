/**
 * @name            jPulse Framework / Plugins / AI Google / Tests / Unit / Descriptor
 * @tagline         Published onAiProviderRegister shape and configured flag
 * @file            plugins/ai-google/webapp/tests/unit/descriptor.test.js
 * @version         1.0.0
 * @release         2026-09-30
 * @repository      https://github.com/jpulse-net/plugin-ai-google
 * @author          Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @copyright       2026 Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @license         BSL 1.1 -- see LICENSE file; for commercial use: team@jpulse.net
 * @genai           80%, Cursor, Grok 4.7
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import AiGoogleController, {
    buildProviderDescriptor,
    PRICE_TABLE
} from '../../controller/aiGoogle.js';

describe('provider descriptor', () => {
    test('plugin, vision capability, and $/MTok prices', async () => {
        const desc = await buildProviderDescriptor({
            getSecret: async () => 'AIzaSyPresent',
            getConfig: async () => ({})
        });
        expect(desc.plugin).toBe('ai-google');
        expect(desc.id).toBeUndefined();
        expect(desc.label).toBe('Google');
        expect(desc.capabilities).toEqual({ vision: true });
        expect(desc.supportsVision).toBeUndefined();
        expect(desc.configured).toBe(true);
        expect(desc.priceTable['gemini-3.8-flash']).toEqual(PRICE_TABLE['gemini-3.8-flash']);
        expect(desc.priceTable['gemini-3.8-flash'].cacheWrite).toBe(0);
        expect(desc.models.map((m) => m.id)).toEqual([
            'gemini-3.8-flash',
            'gemini-3.5-flash-lite',
            'gemini-3.1-pro-preview'
        ]);
    });

    test('configured follows the stored key', async () => {
        const withKey = await buildProviderDescriptor({
            getSecret: async () => 'AIzaSyPresent',
            getConfig: async () => ({})
        });
        const empty = await buildProviderDescriptor({
            getSecret: async () => '',
            getConfig: async () => ({})
        });
        const mask = await buildProviderDescriptor({
            getSecret: async () => '********',
            getConfig: async () => ({})
        });
        expect(withKey.configured).toBe(true);
        expect(empty.configured).toBe(false);
        expect(mask.configured).toBe(false);
    });

    test('override JSON is merged on the registered table', async () => {
        const desc = await buildProviderDescriptor({
            getSecret: async () => '',
            getConfig: async () => ({
                priceTableOverride: JSON.stringify({
                    'gemini-3.8-flash': { output: 99 }
                })
            })
        });
        expect(desc.priceTable['gemini-3.8-flash'].output).toBe(99);
        expect(desc.priceTable['gemini-3.8-flash'].input).toBe(0.75);
        expect(desc.priceTable['gemini-3.8-flash'].cacheWrite).toBe(0);
    });

    test('invalid override JSON keeps the built-in table', async () => {
        const desc = await buildProviderDescriptor({
            getSecret: async () => '',
            getConfig: async () => ({ priceTableOverride: '{' })
        });
        expect(desc.priceTable).toEqual(PRICE_TABLE);
    });

    test('maxTokens from config is on the descriptor', async () => {
        const desc = await buildProviderDescriptor({
            getSecret: async () => 'AIzaSyPresent',
            getConfig: async () => ({ maxTokens: 4096 })
        });
        expect(desc.maxTokens).toBe(4096);
    });

    test('onAiProviderRegister pushes one descriptor', async () => {
        const ctx = { providers: [] };
        await AiGoogleController.onAiProviderRegister(ctx);
        expect(ctx.providers).toHaveLength(1);
        expect(ctx.providers[0].plugin).toBe('ai-google');
        expect(ctx.providers[0].capabilities.vision).toBe(true);
    });

    test('imports PluginModel by path and never assigns global.PluginModel', () => {
        const src = fs.readFileSync(
            path.resolve(process.cwd(), 'plugins/ai-google/webapp/controller/aiGoogle.js'),
            'utf8'
        );
        expect(src).toMatch(/webapp\/model\/plugin\.js/);
        expect(src).not.toMatch(/global\.PluginModel\s*=/);
        expect(src).not.toMatch(/from ['"].*plugins\/ai-core/);
        const dest = path.resolve(
            process.cwd(),
            'plugins/ai-google/webapp/controller',
            '../../../../webapp/model/plugin.js'
        );
        expect(fs.existsSync(dest)).toBe(true);
    });
});

// EOF plugins/ai-google/webapp/tests/unit/descriptor.test.js
