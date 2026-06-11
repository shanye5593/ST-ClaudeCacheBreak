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
- Experimental Tavern backend and browser direct cache tests using the latest converted prompt snapshot
- A live log showing trigger status, skipped reasons, marker counts, injected breakpoints, and changed messages

## Plugin cache tests

The experimental cache tests send the latest converted prompt snapshot twice, then report cache usage fields. They are intended for local diagnosis only.

1. Trigger one normal SillyTavern generation so the extension captures a converted prompt snapshot.
2. Enter Base URL, API Key, Model, and token options in the extension panel.
3. Click **Tavern backend test x2** first. This uses SillyTavern's own `/api/backends/chat-completions/generate` forwarding endpoint, avoiding browser CORS while still being plugin-driven.
4. If needed, click **Browser direct test x2** as a fallback diagnostic. Browser direct calls may fail if the endpoint does not allow CORS.
5. Check the status line or export the test report JSON.

The API key is only kept in the current page session and is not saved to localStorage.

## Local proxy mode

For routes where SillyTavern or the browser does not preserve/send `cache_control`, use the included local proxy in `proxy/`.

1. Run `proxy/start-proxy.bat`.
2. In SillyTavern Chat Completion settings, use:

```text
Base URL: http://127.0.0.1:8788
API Key: your Pioneer API key
Model: claude-opus-4-6 or your Pioneer model name
```

The proxy accepts SillyTavern's normal OpenAI-compatible request, converts `[[CACHE_BREAK]]` markers immediately before forwarding, and sends the request to Pioneer. Keep the proxy terminal window open while using SillyTavern.

See `proxy/README.md` for details.

## Notes

- Runs in SillyTavern's Chat Completion mode, including OpenRouter, custom OpenAI-compatible endpoints, and Claude-compatible reverse proxies.
- Use it only with routes that ultimately reach Claude and preserve Anthropic-style `cache_control` content blocks.
- Claude supports up to 4 prompt-cache breakpoints per request; extra markers are removed but not cached.
- Put markers after large, stable content. Dynamic content before a marker will reduce cache hits.
- Check the panel log or browser console for `[Claude Cache Break]` debug messages.
