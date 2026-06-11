import { eventSource, event_types, main_api } from '../../../../script.js';

const MARKER = '[[CACHE_BREAK]]';
const MAX_BREAKPOINTS = 4;
const LOG_PREFIX = '[Claude Cache Break]';
const SETTINGS_KEY = 'ClaudeCacheBreakSettings';
const MAX_LOG_ENTRIES = 100;

const defaultSettings = {
    enabled: true,
    debug: true,
    directBaseUrl: '',
    directModel: '',
    directMaxTokens: '512',
    directTemperature: '',
};

let settings = loadSettings();
let logEntries = [];
let logElement = null;
let lastPromptSnapshot = null;
let lastDirectTestReport = null;
let csrfTokenCache = null;

function loadSettings() {
    try {
        return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
        return { ...defaultSettings };
    }
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function log(level, message, details = null) {
    const entry = {
        time: new Date().toLocaleTimeString(),
        level,
        message,
        details,
    };

    logEntries.push(entry);

    if (logEntries.length > MAX_LOG_ENTRIES) {
        logEntries.shift();
    }

    if (settings.debug || level === 'warn' || level === 'error') {
        const consoleMethod = console[level] || console.log;
        consoleMethod(`${LOG_PREFIX} ${message}`, details || '');
    }

    renderLogs();
}

function formatLogEntries() {
    return logEntries.map((entry) => {
        const details = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
        return `[${entry.time}] ${entry.level.toUpperCase()} ${entry.message}${details}`;
    }).join('\n');
}

function renderLogs() {
    if (!logElement) {
        return;
    }

    logElement.textContent = formatLogEntries();
    logElement.scrollTop = logElement.scrollHeight;
}

function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function exportLogs() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadFile(formatLogEntries(), `claude-cache-break-${timestamp}.txt`, 'text/plain;charset=utf-8');
}

function exportPromptSnapshot() {
    if (!lastPromptSnapshot) {
        log('warn', 'No converted prompt snapshot is available yet.');
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadFile(JSON.stringify(lastPromptSnapshot, null, 2), `claude-cache-break-prompt-${timestamp}.json`, 'application/json;charset=utf-8');
}

function exportDirectTestReport() {
    if (!lastDirectTestReport) {
        log('warn', 'No browser direct test report is available yet.');
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadFile(JSON.stringify(lastDirectTestReport, null, 2), `claude-cache-break-direct-test-${timestamp}.json`, 'application/json;charset=utf-8');
}

function normalizeBaseUrl(baseUrl) {
    return baseUrl.trim().replace(/\/+$/, '');
}

function getApiRoot(baseUrl) {
    return normalizeBaseUrl(baseUrl)
        .replace(/\/v1\/chat\/completions$/i, '')
        .replace(/\/v1\/models$/i, '')
        .replace(/\/v1$/i, '');
}

function buildApiUrl(baseUrl, path) {
    return `${getApiRoot(baseUrl)}${path}`;
}

function getOpenAiBaseUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl)
        .replace(/\/chat\/completions$/i, '')
        .replace(/\/models$/i, '');

    return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

function extractUsage(responseJson) {
    const usage = responseJson?.usage || {};
    const promptTokensDetails = usage.prompt_tokens_details || {};

    return {
        cachedTokens: promptTokensDetails.cached_tokens ?? null,
        cacheReadTokens: usage.cache_read_tokens ?? responseJson?.cache_read_tokens ?? null,
        cacheWriteTokens: promptTokensDetails.cache_write_tokens ?? usage.cache_write_tokens ?? responseJson?.cache_write_tokens ?? null,
        anthropicCacheReadInputTokens: usage.cache_read_input_tokens ?? null,
        anthropicCacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
        rawUsage: usage,
    };
}

function formatUsageLine(label, result) {
    const usage = result?.usage;

    if (!usage) {
        return `${label}: no usage`;
    }

    return `${label}: cached_tokens=${usage.cachedTokens ?? 'null'}, cache_read_tokens=${usage.cacheReadTokens ?? 'null'}, cache_write_tokens=${usage.cacheWriteTokens ?? 'null'}, anthropic_read=${usage.anthropicCacheReadInputTokens ?? 'null'}, anthropic_write=${usage.anthropicCacheCreationInputTokens ?? 'null'}, elapsed=${result.elapsedMs}ms`;
}

function isTextBlock(block) {
    return block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string';
}

function countExistingCacheBreakpoints(messages) {
    let count = 0;

    for (const message of messages) {
        const content = message?.content;

        if (Array.isArray(content)) {
            for (const block of content) {
                if (block?.cache_control) {
                    count++;
                }
            }
        }
    }

    return count;
}

function stripMarkers(value) {
    return value.split(MARKER).join('');
}

function countMarkers(value) {
    return value.split(MARKER).length - 1;
}

function isMarkerOnlyText(text) {
    return text.includes(MARKER) && stripMarkers(text).trim() === '';
}

function isMarkerOnlyContent(content) {
    if (typeof content === 'string') {
        return isMarkerOnlyText(content);
    }

    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }

    return content.every((block) => isTextBlock(block) && stripMarkers(block.text).trim() === '')
        && content.some((block) => block.text.includes(MARKER));
}

function countMarkersInContent(content) {
    if (typeof content === 'string') {
        return countMarkers(content);
    }

    if (!Array.isArray(content)) {
        return 0;
    }

    return content.reduce((total, block) => total + (isTextBlock(block) ? countMarkers(block.text) : 0), 0);
}

function getTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return null;
    }

    if (!content.every(isTextBlock)) {
        return null;
    }

    return content.map((block) => block.text).join('');
}

function findStandaloneMarkerMergeRange(messages, markerIndex) {
    const markerRole = messages[markerIndex]?.role;
    let startIndex = markerIndex;

    for (let index = markerIndex - 1; index >= 0; index--) {
        const message = messages[index];
        const text = getTextContent(message?.content);

        if (message?.role !== markerRole || isMarkerOnlyContent(message?.content) || text === null || !text.trim()) {
            break;
        }

        startIndex = index;
    }

    return startIndex < markerIndex ? { startIndex, endIndex: markerIndex - 1 } : null;
}

function mergeStandaloneMarkerPrefix(messages, markerIndex) {
    const range = findStandaloneMarkerMergeRange(messages, markerIndex);

    if (!range) {
        return null;
    }

    const mergedText = messages
        .slice(range.startIndex, range.endIndex + 1)
        .map((message) => getTextContent(message.content))
        .join('\n');

    messages.splice(range.startIndex, markerIndex - range.startIndex + 1, {
        role: messages[range.startIndex].role,
        content: [{
            type: 'text',
            text: mergedText,
            cache_control: { type: 'ephemeral' },
        }],
    });

    return {
        targetIndex: range.startIndex,
        mergedMessageCount: range.endIndex - range.startIndex + 1,
        cachedBlockTextLength: mergedText.length,
    };
}

function getMessageTextLength(message) {
    const content = message?.content;

    if (typeof content === 'string') {
        return content.length;
    }

    if (!Array.isArray(content)) {
        return 0;
    }

    return content.reduce((total, block) => total + (isTextBlock(block) ? block.text.length : 0), 0);
}

function summarizeCacheTarget(messages, index) {
    const message = messages[index];
    const content = message?.content;
    const contentType = Array.isArray(content) ? 'array' : typeof content;
    const blocks = Array.isArray(content) ? content : [];
    const textBlocks = blocks.filter(isTextBlock);
    const cachedBlockIndex = blocks.findIndex((block) => isTextBlock(block) && block.cache_control);
    const cachedBlock = cachedBlockIndex >= 0 ? blocks[cachedBlockIndex] : null;
    const text = cachedBlock?.text || '';
    const prefixMessages = messages.slice(0, index);
    const prefixMessageTextLength = prefixMessages.reduce((total, item) => total + getMessageTextLength(item), 0);
    const targetPrefixTextLength = cachedBlockIndex >= 0
        ? blocks.slice(0, cachedBlockIndex + 1).reduce((total, block) => total + (isTextBlock(block) ? block.text.length : 0), 0)
        : 0;

    return {
        index,
        role: message?.role,
        contentType,
        blockCount: blocks.length,
        textBlockCount: textBlocks.length,
        cachedBlockIndex,
        hasCacheControl: Boolean(cachedBlock),
        cacheControl: cachedBlock?.cache_control || null,
        cachedBlockTextLength: text.length,
        cachedBlockTextPreview: text.slice(0, 160),
        prefixMessageCount: prefixMessages.length,
        prefixMessageTextLength,
        targetPrefixTextLength,
        estimatedCachePrefixTextLength: prefixMessageTextLength + targetPrefixTextLength,
        pioneerShapeOk: Array.isArray(content) && Boolean(cachedBlock),
    };
}

function isChatCompletion() {
    return main_api === 'openai';
}

function transformText(text, remainingBreakpoints) {
    if (!text.includes(MARKER)) {
        return { changed: false, content: text, injected: 0, removed: 0 };
    }

    const parts = text.split(MARKER);
    const markerCount = parts.length - 1;
    const content = [];
    let injected = 0;

    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const hasMarkerAfterPart = index < parts.length - 1;

        if (part) {
            const block = {
                type: 'text',
                text: part,
            };

            if (hasMarkerAfterPart && injected < remainingBreakpoints) {
                block.cache_control = { type: 'ephemeral' };
                injected++;
            }

            content.push(block);
        }

        if (hasMarkerAfterPart && !part && injected < remainingBreakpoints) {
            const previousBlock = content[content.length - 1];

            if (isTextBlock(previousBlock) && !previousBlock.cache_control) {
                previousBlock.cache_control = { type: 'ephemeral' };
                injected++;
            }
        }
    }

    if (content.length === 0) {
        return { changed: true, content: '', injected: 0, removed: markerCount };
    }

    return {
        changed: true,
        content,
        injected,
        removed: markerCount,
    };
}

function transformContentArray(content, remainingBreakpoints) {
    const nextContent = [];
    let changed = false;
    let injected = 0;
    let removed = 0;

    for (const block of content) {
        if (!isTextBlock(block) || !block.text.includes(MARKER)) {
            nextContent.push(block);
            continue;
        }

        const result = transformText(block.text, remainingBreakpoints - injected);
        changed = changed || result.changed;
        injected += result.injected;
        removed += result.removed;

        if (Array.isArray(result.content)) {
            for (const transformedBlock of result.content) {
                nextContent.push({ ...block, ...transformedBlock });
            }
        } else if (result.content) {
            nextContent.push({ ...block, text: result.content });
        }
    }

    return { changed, content: nextContent, injected, removed };
}

function removeOverflowMarkers(messages) {
    let removed = 0;

    for (const message of messages) {
        if (typeof message?.content === 'string' && message.content.includes(MARKER)) {
            const before = message.content;
            message.content = stripMarkers(message.content);
            removed += before.split(MARKER).length - 1;
            continue;
        }

        if (Array.isArray(message?.content)) {
            for (const block of message.content) {
                if (isTextBlock(block) && block.text.includes(MARKER)) {
                    const before = block.text;
                    block.text = stripMarkers(block.text);
                    removed += before.split(MARKER).length - 1;
                }
            }
        }
    }

    return removed;
}

function applyCacheBreaks(messages) {
    const existingBreakpoints = countExistingCacheBreakpoints(messages);
    let remainingBreakpoints = Math.max(0, MAX_BREAKPOINTS - existingBreakpoints);
    let injected = 0;
    let removed = 0;
    let changedMessages = 0;
    const modifiedMessages = [];
    const cacheDiagnostics = [];
    const indexesToRemove = [];

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];

        if (remainingBreakpoints > 0 && isMarkerOnlyContent(message?.content)) {
            const markerCount = countMarkersInContent(message.content);
            const mergeResult = mergeStandaloneMarkerPrefix(messages, index);

            removed += markerCount;
            changedMessages++;

            if (mergeResult) {
                injected++;
                remainingBreakpoints--;
                modifiedMessages.push({
                    index,
                    role: message.role,
                    source: 'merged-standalone-marker',
                    appliedTo: mergeResult.targetIndex,
                    mergedMessageCount: mergeResult.mergedMessageCount,
                    cachedBlockTextLength: mergeResult.cachedBlockTextLength,
                });
                cacheDiagnostics.push(summarizeCacheTarget(messages, mergeResult.targetIndex));
            } else {
                indexesToRemove.push(index);
                modifiedMessages.push({ index, role: message.role, source: 'standalone-marker', appliedTo: null });
            }

            continue;
        }

        if (remainingBreakpoints <= 0) {
            continue;
        }

        if (typeof message?.content === 'string') {
            const result = transformText(message.content, remainingBreakpoints);

            if (result.changed) {
                message.content = result.content;
                injected += result.injected;
                removed += result.removed;
                remainingBreakpoints -= result.injected;
                changedMessages++;
                modifiedMessages.push({ index, role: message.role, source: 'string' });

                if (result.injected > 0) {
                    cacheDiagnostics.push(summarizeCacheTarget(messages, index));
                }
            }

            continue;
        }

        if (Array.isArray(message?.content)) {
            const result = transformContentArray(message.content, remainingBreakpoints);

            if (result.changed) {
                message.content = result.content;
                injected += result.injected;
                removed += result.removed;
                remainingBreakpoints -= result.injected;
                changedMessages++;
                modifiedMessages.push({ index, role: message.role, source: 'content-array' });

                if (result.injected > 0) {
                    cacheDiagnostics.push(summarizeCacheTarget(messages, index));
                }
            }
        }
    }

    for (let index = indexesToRemove.length - 1; index >= 0; index--) {
        messages.splice(indexesToRemove[index], 1);
    }

    const overflowRemoved = removeOverflowMarkers(messages);
    removed += overflowRemoved;

    return {
        existingBreakpoints,
        injected,
        removed,
        changedMessages,
        modifiedMessages,
        cacheDiagnostics,
        overflowRemoved,
    };
}

async function parseResponse(response, startedAt) {
    const text = await response.text();
    let json = null;

    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }

    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        elapsedMs: Math.round(performance.now() - startedAt),
        response: json ?? text,
        usage: json ? extractUsage(json) : null,
    };
}

async function sendDirectChatCompletion({ url, apiKey, body }) {
    const startedAt = performance.now();
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    return parseResponse(response, startedAt);
}

function buildChatCompletionsBody({ model, maxTokens, temperature }) {
    if (!lastPromptSnapshot?.chat?.length) {
        throw new Error('No converted prompt snapshot is available yet. Trigger one SillyTavern generation first.');
    }

    const requestBody = {
        model,
        messages: JSON.parse(JSON.stringify(lastPromptSnapshot.chat)),
        max_tokens: Number(maxTokens) || 512,
    };

    if (temperature !== '' && temperature !== null && temperature !== undefined) {
        requestBody.temperature = Number(temperature);
    }

    return requestBody;
}

function buildCacheTestReport({ transport, request, first, second }) {
    return {
        exportedAt: new Date().toISOString(),
        transport,
        request,
        promptSnapshot: lastPromptSnapshot,
        first,
        second,
        verdict: {
            secondCachedTokens: second.usage?.cachedTokens,
            secondCacheReadTokens: second.usage?.cacheReadTokens,
            secondAnthropicCacheReadInputTokens: second.usage?.anthropicCacheReadInputTokens,
            likelyCacheHit: Boolean(
                (second.usage?.cachedTokens ?? 0) > 0
                || (second.usage?.cacheReadTokens ?? 0) > 0
                || (second.usage?.anthropicCacheReadInputTokens ?? 0) > 0
            ),
        },
    };
}

async function runDirectCacheTest({ baseUrl, apiKey, model, maxTokens, temperature }) {
    const url = buildApiUrl(baseUrl, '/v1/chat/completions');
    const requestBody = buildChatCompletionsBody({ model, maxTokens, temperature });
    const first = await sendDirectChatCompletion({ url, apiKey, body: requestBody });
    const second = await sendDirectChatCompletion({ url, apiKey, body: requestBody });

    return buildCacheTestReport({
        transport: 'browser-direct',
        request: {
            url,
            body: requestBody,
        },
        first,
        second,
    });
}

function tryWindowGetRequestHeaders() {
    const fn = window.getRequestHeaders;

    if (typeof fn !== 'function') {
        return null;
    }

    try {
        return fn();
    } catch {
        return null;
    }
}

function tryContextGetRequestHeaders() {
    const context = window.SillyTavern?.getContext?.();

    if (typeof context?.getRequestHeaders !== 'function') {
        return null;
    }

    try {
        return context.getRequestHeaders();
    } catch {
        return null;
    }
}

async function fetchCsrfToken() {
    if (csrfTokenCache) {
        return csrfTokenCache;
    }

    try {
        const response = await fetch('/csrf-token', { method: 'GET', credentials: 'same-origin' });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();

        if (data?.token) {
            csrfTokenCache = data.token;
            return csrfTokenCache;
        }
    } catch {}

    return null;
}

async function getTavernRequestHeaders() {
    const headerSources = [tryWindowGetRequestHeaders, tryContextGetRequestHeaders];

    for (const getHeaders of headerSources) {
        const headers = getHeaders();

        if (headers && typeof headers === 'object') {
            return { ...headers, 'Content-Type': 'application/json' };
        }
    }

    const token = await fetchCsrfToken();

    if (token) {
        return { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    }

    throw new Error('Could not get SillyTavern request headers or CSRF token.');
}

async function sendTavernBackendChatCompletion({ baseUrl, apiKey, body }) {
    const startedAt = performance.now();
    const headers = await getTavernRequestHeaders();
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: getOpenAiBaseUrl(baseUrl),
            model: body.model,
            messages: body.messages,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            stream: false,
            custom_include_headers: JSON.stringify({
                Authorization: `Bearer ${apiKey}`,
            }),
        }),
    });

    return parseResponse(response, startedAt);
}

async function runTavernBackendCacheTest({ baseUrl, apiKey, model, maxTokens, temperature }) {
    const requestBody = buildChatCompletionsBody({ model, maxTokens, temperature });
    const request = {
        url: '/api/backends/chat-completions/generate',
        upstreamBaseUrl: getOpenAiBaseUrl(baseUrl),
        body: requestBody,
    };
    const first = await sendTavernBackendChatCompletion({ baseUrl, apiKey, body: requestBody });
    const second = await sendTavernBackendChatCompletion({ baseUrl, apiKey, body: requestBody });

    return buildCacheTestReport({
        transport: 'tavern-backend',
        request,
        first,
        second,
    });
}

function createSettingsPanel() {
    if (document.getElementById('claude_cache_break_panel')) {
        return;
    }

    const parent = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.querySelector('#extensionsMenu');

    if (!parent) {
        log('warn', 'Could not find an extension settings container; conversion still works.');
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'claude_cache_break_panel';
    panel.className = 'claude-cache-break-panel';
    panel.innerHTML = `
        <div class="claude-cache-break-title">Claude Cache Break</div>
        <label class="checkbox_label claude-cache-break-row">
            <input id="claude_cache_break_enabled" type="checkbox">
            <span>Enable marker conversion</span>
        </label>
        <label class="checkbox_label claude-cache-break-row">
            <input id="claude_cache_break_debug" type="checkbox">
            <span>Mirror logs to browser console</span>
        </label>
        <div class="claude-cache-break-direct">
            <div class="claude-cache-break-subtitle">Plugin cache tests</div>
            <label class="claude-cache-break-field">
                <span>Base URL</span>
                <input id="claude_cache_break_direct_base_url" class="text_pole" type="text" placeholder="https://api.pioneer.ai or https://api.pioneer.ai/v1">
            </label>
            <label class="claude-cache-break-field">
                <span>API Key</span>
                <input id="claude_cache_break_direct_api_key" class="text_pole" type="password" placeholder="Only kept in this page session">
            </label>
            <label class="claude-cache-break-field">
                <span>Model</span>
                <input id="claude_cache_break_direct_model" class="text_pole" type="text" placeholder="claude-opus-4-6">
            </label>
            <div class="claude-cache-break-grid">
                <label class="claude-cache-break-field">
                    <span>Max tokens</span>
                    <input id="claude_cache_break_direct_max_tokens" class="text_pole" type="number" min="1" step="1">
                </label>
                <label class="claude-cache-break-field">
                    <span>Temperature</span>
                    <input id="claude_cache_break_direct_temperature" class="text_pole" type="number" step="0.01" placeholder="optional">
                </label>
            </div>
            <div class="claude-cache-break-actions">
                <button id="claude_cache_break_tavern_backend_test" class="menu_button">Tavern backend test x2</button>
                <button id="claude_cache_break_direct_test" class="menu_button">Browser direct test x2</button>
                <button id="claude_cache_break_export_direct" class="menu_button">Export test report</button>
            </div>
            <div id="claude_cache_break_direct_status" class="claude-cache-break-status">Trigger one normal generation first, then test the latest converted prompt. Try Tavern backend first; browser direct may fail from CORS.</div>
        </div>
        <div class="claude-cache-break-actions">
            <button id="claude_cache_break_export_prompt" class="menu_button">Export prompt JSON</button>
            <button id="claude_cache_break_export_log" class="menu_button">Export log txt</button>
            <button id="claude_cache_break_clear_log" class="menu_button">Clear log</button>
        </div>
        <pre id="claude_cache_break_log" class="claude-cache-break-log"></pre>
    `;

    parent.appendChild(panel);

    const enabledInput = panel.querySelector('#claude_cache_break_enabled');
    const debugInput = panel.querySelector('#claude_cache_break_debug');
    const directBaseUrlInput = panel.querySelector('#claude_cache_break_direct_base_url');
    const directApiKeyInput = panel.querySelector('#claude_cache_break_direct_api_key');
    const directModelInput = panel.querySelector('#claude_cache_break_direct_model');
    const directMaxTokensInput = panel.querySelector('#claude_cache_break_direct_max_tokens');
    const directTemperatureInput = panel.querySelector('#claude_cache_break_direct_temperature');
    const tavernBackendTestButton = panel.querySelector('#claude_cache_break_tavern_backend_test');
    const directTestButton = panel.querySelector('#claude_cache_break_direct_test');
    const exportDirectButton = panel.querySelector('#claude_cache_break_export_direct');
    const directStatusElement = panel.querySelector('#claude_cache_break_direct_status');
    const exportPromptButton = panel.querySelector('#claude_cache_break_export_prompt');
    const exportButton = panel.querySelector('#claude_cache_break_export_log');
    const clearButton = panel.querySelector('#claude_cache_break_clear_log');
    logElement = panel.querySelector('#claude_cache_break_log');

    enabledInput.checked = settings.enabled;
    debugInput.checked = settings.debug;
    directBaseUrlInput.value = settings.directBaseUrl;
    directModelInput.value = settings.directModel;
    directMaxTokensInput.value = settings.directMaxTokens;
    directTemperatureInput.value = settings.directTemperature;

    enabledInput.addEventListener('change', () => {
        settings.enabled = enabledInput.checked;
        saveSettings();
        log('info', `Conversion ${settings.enabled ? 'enabled' : 'disabled'}.`);
    });

    debugInput.addEventListener('change', () => {
        settings.debug = debugInput.checked;
        saveSettings();
        log('info', `Console logging ${settings.debug ? 'enabled' : 'disabled'}.`);
    });

    const saveDirectSettings = () => {
        settings.directBaseUrl = directBaseUrlInput.value;
        settings.directModel = directModelInput.value;
        settings.directMaxTokens = directMaxTokensInput.value;
        settings.directTemperature = directTemperatureInput.value;
        saveSettings();
    };

    directBaseUrlInput.addEventListener('input', saveDirectSettings);
    directModelInput.addEventListener('input', saveDirectSettings);
    directMaxTokensInput.addEventListener('input', saveDirectSettings);
    directTemperatureInput.addEventListener('input', saveDirectSettings);

    const runPanelCacheTest = async ({ label, runningText, button, test }) => {
        saveDirectSettings();

        if (!directBaseUrlInput.value || !directApiKeyInput.value || !directModelInput.value) {
            directStatusElement.textContent = 'Base URL, API Key, and Model are required.';
            log('warn', `${label} skipped because required fields are missing.`);
            return;
        }

        tavernBackendTestButton.disabled = true;
        directTestButton.disabled = true;
        directStatusElement.textContent = runningText;
        log('info', `Starting ${label}.`);

        try {
            lastDirectTestReport = await test({
                baseUrl: directBaseUrlInput.value,
                apiKey: directApiKeyInput.value,
                model: directModelInput.value,
                maxTokens: directMaxTokensInput.value,
                temperature: directTemperatureInput.value,
            });

            const lines = [
                formatUsageLine('First', lastDirectTestReport.first),
                formatUsageLine('Second', lastDirectTestReport.second),
            ];
            directStatusElement.textContent = `${lastDirectTestReport.verdict.likelyCacheHit ? 'Likely cache hit.' : 'No clear cache hit.'} ${lines.join(' | ')}`;
            log('info', `${label} finished.`, {
                transport: lastDirectTestReport.transport,
                verdict: lastDirectTestReport.verdict,
                first: lastDirectTestReport.first?.usage,
                second: lastDirectTestReport.second?.usage,
            });
        } catch (error) {
            directStatusElement.textContent = `${label} failed: ${error.message}`;
            log('error', `${label} failed.`, { message: error.message, name: error.name });
        } finally {
            button.disabled = false;
            tavernBackendTestButton.disabled = false;
            directTestButton.disabled = false;
        }
    };

    tavernBackendTestButton.addEventListener('click', () => runPanelCacheTest({
        label: 'Tavern backend cache test',
        runningText: 'Sending two requests through SillyTavern backend...',
        button: tavernBackendTestButton,
        test: runTavernBackendCacheTest,
    }));

    directTestButton.addEventListener('click', () => runPanelCacheTest({
        label: 'Browser direct cache test',
        runningText: 'Sending two browser direct requests...',
        button: directTestButton,
        test: runDirectCacheTest,
    }));

    exportDirectButton.addEventListener('click', exportDirectTestReport);
    exportPromptButton.addEventListener('click', exportPromptSnapshot);
    exportButton.addEventListener('click', exportLogs);

    clearButton.addEventListener('click', () => {
        logEntries = [];
        renderLogs();
    });

    renderLogs();
    log('info', 'Settings panel ready.');
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (data) => {
    if (data?.dryRun) {
        log('info', 'Skipped dry run.');
        return;
    }

    if (!settings.enabled) {
        log('info', 'Skipped because conversion is disabled.');
        return;
    }

    if (!isChatCompletion()) {
        log('info', 'Skipped because current API mode is not Chat Completion.', { main_api });
        return;
    }

    if (!Array.isArray(data?.chat)) {
        log('warn', 'Skipped because prompt data.chat is not an array.');
        return;
    }

    const result = applyCacheBreaks(data.chat);
    lastPromptSnapshot = {
        exportedAt: new Date().toISOString(),
        mainApi: main_api,
        result: JSON.parse(JSON.stringify(result)),
        chat: JSON.parse(JSON.stringify(data.chat)),
    };

    if (result.removed > 0 || result.injected > 0) {
        log('info', 'Converted cache break markers.', result);

        if (result.overflowRemoved > 0) {
            log('warn', `Removed ${result.overflowRemoved} marker(s) without cache_control because Claude supports at most ${MAX_BREAKPOINTS} cache breakpoints per request.`);
        }

        return;
    }

    log('info', 'No cache break markers found.', { messages: data.chat.length });
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createSettingsPanel);
} else {
    createSettingsPanel();
}

eventSource.on(event_types.APP_READY, createSettingsPanel);

log('info', 'Loaded.');
