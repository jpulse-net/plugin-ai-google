/*
 * @name            jPulse Framework / Plugins / AI Google / View / jPulse Common
 * @tagline         Verify button for the Gemini API key
 * @description     Plugin-config Verify callback. POSTs the form field
 *                  (and endpoint); the response never includes the key.
 * @file            plugins/ai-google/webapp/view/jpulse-common.js
 * @version         1.0.0
 * @release         2026-09-30
 * @repository      https://github.com/jpulse-net/plugin-ai-google
 * @author          Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @copyright       2026 Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @license         BSL 1.1 -- see LICENSE file; for commercial use: team@jpulse.net
 * @genai           80%, Cursor, Grok 4.7
 */

if (!window.jPulse) {
    window.jPulse = {};
}
if (!window.jPulse.plugins) {
    window.jPulse.plugins = {};
}

window.jPulse.plugins.aiGoogle = {
    verifyApiKey: async function(btn) {
        try {
            if (btn) {
                btn.disabled = true;
                btn.classList.add('jp-btn-loading');
            }
            const form = (btn && btn.closest && btn.closest('form'))
                || document.getElementById('pluginConfigForm');
            const values = (form && jPulse.UI && jPulse.UI.input
                && typeof jPulse.UI.input.getAllValues === 'function')
                ? jPulse.UI.input.getAllValues(form)
                : {};
            const provider = (values && values.provider) || {};
            const response = await jPulse.api.post('/api/1/aiGoogle/verify-api-key', {
                apiKey: provider.apiKey || '',
                endpoint: provider.endpoint || ''
            });
            const data = response && response.data ? response.data : {};
            if (data.configured && data.valid) {
                jPulse.UI.toast.success(response.message || 'Gemini API key is valid.');
            } else if (data.configured) {
                jPulse.UI.toast.warning(response.message || 'Google rejected the API key.');
            } else {
                jPulse.UI.toast.info(response.message || 'Gemini API key is not configured.');
            }
        } catch (error) {
            jPulse.UI.toast.error((error && error.message) || 'Verify failed');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('jp-btn-loading');
            }
        }
    }
};

// EOF plugins/ai-google/webapp/view/jpulse-common.js
