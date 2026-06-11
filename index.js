import { eventSource, event_types, main_api } from '../../../../script.js';
import { chat_completion_sources, oai_settings } from '../../../openai.js';

const MARKER = '[[CACHE_BREAK]]';
const MAX_BREAKPOINTS = 4;
const LOG_PREFIX = '[Claude Cache Break]';

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

function isOpenRouterChatCompletion() {
    return main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.OPENROUTER;
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

    for (const message of messages) {
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
            }
        }
    }

    const overflowRemoved = removeOverflowMarkers(messages);
    removed += overflowRemoved;

    return {
        existingBreakpoints,
        injected,
        removed,
        changedMessages,
        overflowRemoved,
    };
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (data) => {
    if (data?.dryRun) {
        return;
    }

    if (!isOpenRouterChatCompletion()) {
        return;
    }

    if (!Array.isArray(data?.chat)) {
        return;
    }

    const result = applyCacheBreaks(data.chat);

    if (result.removed > 0 || result.injected > 0) {
        console.debug(`${LOG_PREFIX} removed ${result.removed} marker(s), injected ${result.injected} cache breakpoint(s), existing ${result.existingBreakpoints}, changed ${result.changedMessages} message(s).`);

        if (result.overflowRemoved > 0) {
            console.warn(`${LOG_PREFIX} removed ${result.overflowRemoved} marker(s) without cache_control because Claude supports at most ${MAX_BREAKPOINTS} cache breakpoints per request.`);
        }
    }
});

console.debug(`${LOG_PREFIX} loaded.`);
