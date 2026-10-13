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

## Available Providers (36 Active)

| Provider | Content Type | Stream Format | Highlights & Features | Status |
|---|---|---|---|:---:|
| **AnimeLok (Hindi Dub)** | Anime | HLS (m3u8) | Native Multi-Audio HLS (Hindi, Tamil, Telugu, English, Japanese) up to 1080p via direct JSON API | ✅ Active |
| **AniHub (Hindi Dub)** | Anime | HLS (m3u8) | Multi-Audio HLS (Hindi, Tamil, Telugu, English, Japanese) up to 1080p via Ravok extractor | ✅ Active |
| **MMani** | Anime | HLS (m3u8) | Anime BD streams via MMani.com (formerly AniBD) with 1080p/720p HLS & WebVTT subtitles | ✅ Active |
| **AniLab** | Anime | HLS (m3u8) | AniLab catalog + KYOTO/anidb backend, Sub/Dub servers, multi-quality HLS, season-aware matching | ✅ Active |
| **AniBD** | Anime | HLS (m3u8) | Multi-server stream resolution and fallback support for anime series & movies | ✅ Active |
| **MegaPlay** | Anime | HLS (m3u8) | High-speed SUB and DUB streams with multi-audio and subtitle tracks | ✅ Active |
| **Torrentio** | Anime / Movies | Torrent (P2P) | Saikou-style torrent engine, AniZip ID mapping, Nyaa/TokyoTosho trackers, infoHash, seeders (👤), sizes (💾), Real-Debrid support | ✅ Active |
| **KickAssAnime** | Anime | HLS (m3u8) | Direct 1080p master HLS streams via CatStream Astro player with embedded subtitles | ✅ Active |
| **HiAnime** | Anime | HLS (m3u8) | ZokoAnime 1080p HLS streams, Sub and Dub audio, WebVTT subtitles, and intro/outro skip metadata | ✅ Active |
| **KissKH** | Anime / Drama | HLS / MP4 | Direct HD video sources and multi-language subtitles via KissKH API | ✅ Active |
| **MeguAnime** | Anime | HLS (m3u8) | Native AniList IDs & unified proxy API (Miruro) for multi-source HLS streams | ✅ Active |
| **AnimePahe** | Anime | HLS (m3u8) | Direct Kwik HLS stream extraction with Cloudflare challenge persistence | ✅ Active |
| **MKissa** | Anime | HLS / MP4 | Fast SUB & DUB streams via Anivexa API with configurable mirror URL | ✅ Active |
| **Anikoto** | Anime | HLS (m3u8) | Multi-server extraction (Vidstream-2, HD-1), SUB & DUB, multi-language subtitles | ✅ Active |
| **AniWaves** | Anime | HLS / MP4 | Vidplay, DatSaV, MyCloud server resolution with subtitle tracks | ✅ Active |
| **AniWave** | Anime | HLS (m3u8) | Sub and Dub HLS streams via MegaPlay extraction and multi-language subtitles | ✅ Active |
| **AniZone** | Anime | HLS (m3u8) | Dual-audio (Japanese & English), episode library, multi-language subtitles | ✅ Active |
| **AnimeOnsen** | Anime | DASH (mpd) | Multi-audio DASH streams, 12+ language ASS subtitles, and intro/outro skip metadata | ✅ Active |
| **AnimeGG** | Anime | HLS / MP4 | Sub and Dub multi-quality MP4/HLS streams via multi-server extraction | ✅ Active |
| **AnimeStream** | Anime | HLS (m3u8) | Direct Sub/Dub HLS streams and multi-language WebVTT subtitles via UniqueStream API | ✅ Active |
| **AniNeko** | Anime | HLS (m3u8) | StreamHG & Earnvids server extraction with high-speed HLS playback | ✅ Active |
| **AniChi** | Anime | HLS (m3u8) | Sub and Dub HLS streams via MegaPlay extraction and multi-language subtitles | ✅ Active |
| **Anikage** | Anime | HLS / MP4 | Sub and Dub HLS/MP4 streams, multi-quality variants, and subtitles | ✅ Active |
| **AnimeParadise** | Anime | HLS (m3u8) | Direct HLS streams and subtitle tracks | ✅ Active |
| **Anixo** | Anime | HLS (m3u8) | Stream relay (MegaPlay/AniNeko/Zoko) with intro/outro skip markers and subtitles | ✅ Active |
| **Senshi** | Anime | HLS (m3u8) | Decrypted 1080p HLS streams via Senshi.to with dual-audio and subtitle tracks | ✅ Active |
| **AnimeHeaven** | Anime | MP4 | Direct standalone 1080p MP4 anime stream extraction from AnimeHeaven.me CDNs | ✅ Active |
| **AniWatch** | Anime | HLS (m3u8) | Standalone HLS master streams via ZokoAnime / AniWatch.lu with SUB/DUB & proxied subtitles | ✅ Active |
| **AnimeKai** | Anime | HLS (m3u8) | Multi-node high-speed HLS streams (Zuna, Yuki, Sora, Loli) via AnimeKai.ro / MegaVid with dual audio | ✅ Active |
| **BabaStream** | Anime | MP4 / HLS | Direct MP4 & HLS stream extraction via BabaStream.top with PoW resolution & dual audio | ✅ Active |
| **KotoTV** | Anime | HLS (m3u8) | Decrypted HLS streams via custom XOR obfuscation and dual-audio (Sub & Dub) | ✅ Active |
| **Nyaa** | Anime | Torrent (P2P) | Direct torrent provider searching nyaa.si for high-seed anime releases | ✅ Active |
| **OppaiStream** | Adult / Hentai | MP4 / WebM | Direct 4K, 1080p, 720p stream extraction bypassing Cloudflare watch challenges | ✅ Active |
| **Hentaigasm** | Adult / Hentai | MP4 | Direct high-speed JWPlayer video sources with range-request support | ✅ Active |
| **WatchHentai** | Adult / Hentai | MP4 / HLS | Direct 1080p video streams with XOR video URL decryption | ✅ Active |
| **HahoMoe** | Adult / Hentai | MP4 | Multi-quality direct MP4 streams | ✅ Active |

---

## Repository Structure

```
Anivio-providers/
├── manifest.json            # Repository manifest listing all 35 available providers
├── icons/                   # Local provider icon assets (PNG / ICO)
├── providers/
│   ├── anibd.js             # AniBD anime provider
│   ├── anichi.js            # AniChi provider
│   ├── anihub.js            # AniHub (Hindi Dub) provider
│   ├── anikage.js           # Anikage provider
│   ├── anikoto.js           # Anikoto anime provider
│   ├── anilab.js            # AniLab catalog + KYOTO/anidb provider
│   ├── animelok.js          # AnimeLok (Hindi Dub) provider
│   ├── animegg.js           # AnimeGG provider
│   ├── animeheaven.js       # Standalone AnimeHeaven provider
│   ├── animekai.js          # Standalone AnimeKai provider
│   ├── animeonsen.js        # AnimeOnsen DASH provider
│   ├── animepahe.js         # AnimePahe Kwik provider
│   ├── animeparadise.js     # AnimeParadise provider
│   ├── anineko.js           # AniNeko anime provider
│   ├── aniwatch.js          # Standalone AniWatch provider
│   ├── aniwave.js           # AniWave provider
│   ├── aniwaves.js          # AniWaves anime provider
│   ├── anixo.js             # Anixo relay provider
│   ├── anizone.js           # AniZone anime provider
│   ├── babastream.js        # Standalone BabaStream provider
│   ├── hahomoe.js           # HahoMoe provider
│   ├── hentaigasm.js        # Hentaigasm provider
│   ├── hianime.js           # HiAnime provider
│   ├── kickassanime.js      # KickAssAnime provider
│   ├── kototv.js            # KotoTV XOR provider
│   ├── megaplay.js          # MegaPlay provider
│   ├── meguanime.js         # MeguAnime Miruro provider
│   ├── mkissa.js            # MKissa provider
│   ├── mmani.js             # Standalone MMani (Anime BD) provider
│   ├── nyaa.js              # Nyaa direct torrent provider
│   ├── oppaistream.js       # OppaiStream provider
│   ├── senshi.js            # Senshi anime provider
│   ├── torrentio.js         # Torrentio (P2P / Stremio) provider
│   ├── uniquestream.js      # AnimeStream (UniqueStream) provider
│   └── watchhentai.js       # WatchHentai provider
└── README.md
```

---

## Development & Plugin Contract

All plugins are written in JavaScript and executed by Anivio using embedded **QuickJS**.

- **Self-contained:** A single file per provider with no external npm packages or `import`/`export` syntax.
- **Runtime Features:** Native support for `async`/`await`, `fetch()`, `URL`, `Set`, `Map`, `btoa`/`atob`, and standard Web APIs.
- **Contract Functions:**
  - `getStreams(tmdbId, mediaType, season, episode)`: Primary stream resolver returning an array of stream objects.
  - `onSettings()`: Optional settings schema for custom user preferences in the Anivio UI.
- **Supported ID Formats:** `anilist:<id>`, `mal:<id>`, numeric TMDB ID, and `"603"` (built-in Anivio Test button).
