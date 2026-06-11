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
- Export converted prompt JSON
- Export log txt
- Experimental Tavern backend generation, chat injection, and cache tests using the latest converted prompt snapshot
- A live log showing trigger status, skipped reasons, marker counts, injected breakpoints, and changed messages

## Plugin generation and cache tests

The experimental generation and cache tools use the latest converted prompt snapshot and SillyTavern's own `/api/backends/chat-completions/generate` forwarding endpoint, avoiding browser CORS while still being plugin-driven.

1. Enter Base URL, API Key, Model, and token options in the extension panel.
2. Trigger one normal SillyTavern generation so the extension captures a converted prompt snapshot.
3. Click **Generate as character** to make one non-streaming Tavern-backend request and inject the reply as a character message.
4. Click **Generate as narrator** to inject the reply as a narrator/system message instead.
5. Click **Tavern backend test x2** to send the same converted prompt twice and report cache usage fields.
6. If needed, click **Browser direct test x2** as a fallback diagnostic. Browser direct calls may fail if the endpoint does not allow CORS.

The **Auto generate via Tavern backend and inject as character** option attempts to handle normal SillyTavern generation automatically: after the prompt is prepared, the extension calls the Tavern backend forwarding endpoint, injects the reply as a character message, and stops the original request to avoid double billing. Leave it off while configuring or testing.

The API key is only kept in the current page session and is not saved to localStorage.

## Notes

- Runs in SillyTavern's Chat Completion mode, including OpenRouter, custom OpenAI-compatible endpoints, and Claude-compatible reverse proxies.
- Use it only with routes that ultimately reach Claude and preserve Anthropic-style `cache_control` content blocks.
- Claude supports up to 4 prompt-cache breakpoints per request; extra markers are removed but not cached.
- Put markers after large, stable content. Dynamic content before a marker will reduce cache hits.
- Check the panel log or browser console for `[Claude Cache Break]` debug messages.
