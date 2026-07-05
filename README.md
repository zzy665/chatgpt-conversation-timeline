<p align="center">
  <img src="public/preview.png" alt="Conversation timeline preview">
</p>

# ChatGPT Conversation Timeline

> Chinese README: [README.zh-CN.md](./README.zh-CN.md)

A browser extension that adds a compact conversation timeline to AI chat pages. This fork is tuned for the ChatGPT web UI and the `mana-x.aizex.net` ChatGPT relay, with a Codex-style right-aligned bar timeline and fast hover feedback.

It is meant for people who read long AI conversations and want a quicker way to scan, preview, mark, and jump between user turns.

## Features

- **Codex-style bar timeline**: user turns are shown as short horizontal bars on the right side of the page.
- **Fast hover expansion**: the nearest bar becomes longest, nearby bars shrink in a staircase pattern, and all bars stay right-aligned.
- **Question and answer preview**: the tooltip shows more of the user question plus part of the assistant response. Thinking-time prefixes such as `思考 8 秒` are highlighted instead of being shown as a generic model label.
- **One-click jumping**: click a timeline bar to jump to that user message.
- **Local starred markers**: long-press a bar to mark an important turn. Stars are saved locally for the current conversation.
- **Per-site controls**: enable or disable the timeline globally or per supported provider from the popup.
- **Theme adaptation**: follows light and dark themes on supported sites.
- **Performance-focused interaction**: hover matching uses cached timeline positions, bounded repaint ranges, and transform-based bar scaling to reduce layout work while moving the mouse.

## Supported Sites

- ChatGPT: `https://chatgpt.com/*`
- Legacy ChatGPT: `https://chat.openai.com/*`
- mana-x ChatGPT relay: `https://mana-x.aizex.net/*`
- DeepSeek: `https://chat.deepseek.com/*`
- Gemini: `https://gemini.google.com/*`

The Codex-style timeline refinements are focused on the ChatGPT/mana-x path. DeepSeek and Gemini support remain available through their existing timeline implementations.

## Install From Source

1. Download or clone this repository.
2. Open Chrome or Edge and go to `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository's `extension/` folder.

After installation, open a supported conversation page. The timeline appears on the right side when the site is enabled in the extension popup.

## Usage

- Move the mouse near the timeline to expand nearby bars.
- Click a bar to jump to that user turn.
- Long-press a bar to star or unstar it.
- Use the extension popup to enable or disable each supported site.

## What Changed In This Build

- Added support for `mana-x.aizex.net`.
- Reworked the ChatGPT/mana-x timeline into a compact bar-based layout inspired by the current ChatGPT/Codex timeline style.
- Changed the hover behavior so the selected bar is longest and adjacent bars decrease by distance.
- Added richer tooltips with separate question and answer preview areas.
- Removed generic assistant prefixes such as "大模型说" and normalized thinking-time text.
- Tuned active and starred marker styling so the current turn, hover state, and starred state can coexist without a bulky outline.
- Optimized hover responsiveness by avoiding per-marker layout reads during pointer movement and repainting only the affected bar range.

## Privacy Notes

This extension runs locally in your browser. It reads the visible conversation DOM to build the timeline and uses browser storage for extension settings and starred marker IDs. This modified build does not add analytics, tracking, or any remote service for conversation content.

## Development Checks

The current lightweight checks are:

```powershell
node --check extension\content-chatgpt.js
node --check extension\chatgpt-initial-jump-utils.js
node --check extension\fiber-bridge-chatgpt.js
.\tests\run-node-tests.ps1
```

## License

MIT License. See [LICENSE](LICENSE).
