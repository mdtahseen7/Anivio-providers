# Anivio Stream Providers

Official stream provider plugin repository for the [Anivio](https://github.com/mdtahseen7/Anivio) streaming application.

All plugins execute natively inside Anivio's embedded **QuickJS** runtime with zero compilation, zero bundling, and full `async`/`await` support.

---

## Installation in Anivio

1. Open the **Anivio** app.
2. Navigate to **Settings → Content & Discovery → Plugins**.
3. Tap **Add Repository** and enter:
   ```
   https://raw.githubusercontent.com/mdtahseen7/Anivio-providers/main/manifest.json
   ```
4. Tap **Install / Refresh**. All available providers will appear with their icons and descriptions.
5. Enable your desired providers and tap **Test** to verify connectivity.

---

## Available Providers

| Provider | Content Type | Stream Format | Highlights & Features | Status |
|---|---|---|---|:---:|
| **Torrentio** | Anime / Series / Movies | Torrent (P2P) | Saikou-style torrent engine, AniZip ID mapping, Nyaa/TokyoTosho trackers, infoHash, seeders (👤), sizes (💾), Real-Debrid support | ✅ Active |
| **KickAssAnime** | Anime | HLS (m3u8) | Direct 1080p master HLS streams via CatStream Astro player with embedded subtitles | ✅ Active |
| **MKissa** | Anime | HLS / MP4 | Fast SUB & DUB streams via Anivexa API with configurable mirror URL | ✅ Active |
| **AniBD** | Anime | HLS (m3u8) | Multi-server stream resolution and fallback support for anime series & movies | ✅ Active |
| **MegaPlay** | Anime | HLS (m3u8) | High-speed SUB and DUB streams with multi-audio and subtitle tracks | ✅ Active |
| **Anikoto** | Anime | HLS (m3u8) | Multi-server extraction (Vidstream-2, HD-1), SUB & DUB, multi-language subtitles | ✅ Active |
| **AniWaves** | Anime | HLS / MP4 | Vidplay, DatSaV, MyCloud server resolution with subtitle tracks | ✅ Active |
| **AniZone** | Anime | HLS (m3u8) | Dual-audio (Japanese & English), episode library, multi-language subtitles | ✅ Active |
| **AniNeko** | Anime | HLS (m3u8) | StreamHG & Earnvids server extraction with high-speed HLS playback | ✅ Active |
| **OppaiStream** | Hentai / Adult | MP4 / WebM | Direct 4K, 1080p, 720p stream extraction bypassing Cloudflare watch challenges | ✅ Active |
| **Hentaigasm** | Hentai / Adult | MP4 | Direct high-speed JWPlayer video sources with range-request support | ✅ Active |
| **WatchHentai** | Hentai / Adult | MP4 / HLS | Direct 1080p video streams with XOR video URL decryption | ✅ Active |

---

## Repository Structure

```
Anivio-anime-provider/
├── manifest.json            # Repository manifest listing all 12 providers with logos & settings
├── icons/                   # Local provider icon assets (PNG / ICO)
├── providers/
│   ├── anibd.js             # AniBD anime provider
│   ├── anikoto.js           # Anikoto anime provider
│   ├── anineko.js           # AniNeko anime provider
│   ├── aniwaves.js          # AniWaves anime provider
│   ├── anizone.js           # AniZone anime provider
│   ├── hentaigasm.js        # Hentaigasm provider
│   ├── kickassanime.js      # KickAssAnime provider
│   ├── megaplay.js          # MegaPlay provider
│   ├── mkissa.js            # MKissa provider
│   ├── oppaistream.js       # OppaiStream provider
│   ├── torrentio.js         # Torrentio (P2P / Stremio) provider
│   └── watchhentai.js       # WatchHentai provider
└── README.md
```

---

## Development

All plugins are written in modern JavaScript and executed by Anivio using QuickJS.
* Must be self-contained in a single file (no external npm dependencies or import statements).
* Native support for `async`/`await`, `fetch()`, `URL`, and standard web APIs provided by Anivio's runtime.
* Expose `getStreams(id, type, season, episode)` and optional `onSettings()`.
