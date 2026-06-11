import { eventSource, event_types, main_api } from '../../../../script.js';

const MARKER = '[[CACHE_BREAK]]';
const MAX_BREAKPOINTS = 4;
const LOG_PREFIX = '[Claude Cache Break]';
const SETTINGS_KEY = 'ClaudeCacheBreakSettings';
const MAX_LOG_ENTRIES = 100;

const defaultSettings = {
    enabled: true,
    debug: true,
};

let settings = loadSettings();
let logEntries = [];
let logElement = null;
let lastPromptSnapshot = null;

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
    const exportPromptButton = panel.querySelector('#claude_cache_break_export_prompt');
    const exportButton = panel.querySelector('#claude_cache_break_export_log');
    const clearButton = panel.querySelector('#claude_cache_break_clear_log');
    logElement = panel.querySelector('#claude_cache_break_log');

    enabledInput.checked = settings.enabled;
    debugInput.checked = settings.debug;

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
