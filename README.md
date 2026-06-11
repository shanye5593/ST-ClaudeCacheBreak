# Claude Cache Break

A SillyTavern third-party extension that converts `[[CACHE_BREAK]]` markers in chat-completion prompts into Claude prompt-cache breakpoints.

## Usage

Install this repository from SillyTavern:

1. Open **Extensions**.
2. Choose **Install Extension**.
3. Paste this repository URL.
4. Restart or reload SillyTavern if needed.

Then place `[[CACHE_BREAK]]` in a stable part of your preset or prompt:

```text
Stable character/world/system instructions...
[[CACHE_BREAK]]
Dynamic chat or user-specific content...
```

The marker is removed before the request is sent. When the marker is its own prompt entry, the stable entries before it are merged into one text content block with:

```json
{
  "cache_control": {
    "type": "ephemeral"
  }
}
```

## Panel and logs

The extension adds a **Claude Cache Break** panel to the extensions settings area.

The panel includes:

- Enable marker conversion
- Mirror logs to browser console
- Clear log
- A live log showing trigger status, skipped reasons, marker counts, injected breakpoints, and changed messages

## Notes

- Runs in SillyTavern's Chat Completion mode, including OpenRouter, custom OpenAI-compatible endpoints, and Claude-compatible reverse proxies.
- Use it only with routes that ultimately reach Claude and preserve Anthropic-style `cache_control` content blocks.
- Claude supports up to 4 prompt-cache breakpoints per request; extra markers are removed but not cached.
- Put markers after large, stable content. Dynamic content before a marker will reduce cache hits.
- Check the panel log or browser console for `[Claude Cache Break]` debug messages.
