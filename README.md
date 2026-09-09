# Anivio Anime Providers

Collection of anime stream providers for the [Anivio](https://github.com/mdtahseen7/Anivio) streaming application.

## Installation in Anivio

1. Open **Anivio** app.
2. Go to **Settings → Content & Discovery → Plugins**.
3. Add this repository URL:
   ```
   https://raw.githubusercontent.com/mdtahseen7/Anivio-providers/main/manifest.json
   ```
4. Enable **AniBD**.
5. Tap **Test** to verify.

## Available Providers

| Provider | Type | Content | Formats | Status |
|---|---|---|---|---|
| **AniBD** | TV & Movies | Anime (Sub/Dub) | HLS (`.m3u8`) | ✅ Active |

## Development

All plugins run directly inside Anivio's QuickJS engine and use native `async`/`await`. No transpilation is needed.
