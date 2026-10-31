# tg-sticker-proxy

[![CI](https://github.com/Nachtalb/tg-sticker-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/Nachtalb/tg-sticker-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Nachtalb/tg-sticker-proxy)](LICENSE)
[![Live](https://img.shields.io/website?url=https%3A%2F%2Fs.naa.gg&label=s.naa.gg)](https://s.naa.gg)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Bun](https://img.shields.io/badge/Bun-1.4-000?logo=bun&logoColor=white)](https://bun.sh)

Cloudflare Worker that proxies Telegram sticker packs through the Bot API.
Stickers live only in the Cloudflare edge cache; Workers KV keeps a small summary of
every pack served so far for `/packs.json`. Live at <https://s.naa.gg>.

## Endpoints

`<set>` matches `^[A-Za-z0-9_]{1,64}$`, `<id>` is the sticker's `file_unique_id`
(`^[A-Za-z0-9_-]{1,64}$`; it's base64url so `-` occurs).

| Route | Returns | Cache |
|---|---|---|
| `GET /` | plain-text usage | – |
| `GET /packs.json` | known packs, newest first (shape below) | 60s |
| `GET /<set>.json` | pack info + all stickers (shape below) | 1h, swr 1d |
| `GET /<set>/thumb` | pack thumbnail (webp/tgs/webm, whatever Telegram has) | 1d |
| `GET /<set>/<id>.<webp\|tgs\|webm>` | sticker file; wrong extension → 404 | immutable |
| `GET /<set>/<id>.json` | TGS sticker gunzipped to Lottie JSON (for lottie-web) | immutable |
| `GET /<set>/<id>/thumb` | sticker thumbnail (`.webp`/`.jpg` suffix accepted) | immutable |
| `GET /<set>/<id>/premium` | premium animation, if the sticker has one | immutable |
| `GET /<set>/<id>` | small HTML share page with OpenGraph preview | 1h |
| `GET /_me` | `{username}` of the bot (health check) | 1h |

All GET responses send `Access-Control-Allow-Origin: *` and `X-Cache: HIT|MISS`.

```jsonc
{
  "name": "HotCherry", "title": "Hot Cherry", "format": "tgs",          // webp | tgs | webm, see below
  "sticker_type": "regular",                                             // regular | mask | custom_emoji
  "link": "https://t.me/addstickers/HotCherry",                          // addemoji for custom_emoji
  "thumbnail": "https://s.naa.gg/HotCherry/thumb",                       // or null
  "stickers": [{
    "id": "AgADAQADwDZPEw", "file_unique_id": "AgADAQADwDZPEw",
    "emoji": "😂", "type": "regular", "format": "tgs",                   // webp | tgs | webm
    "is_animated": true, "is_video": false, "width": 512, "height": 512, "file_size": 8244,
    "custom_emoji_id": null, "premium_animation": null, "mask_position": null, "needs_repainting": false,
    "url": "https://s.naa.gg/HotCherry/AgADAQADwDZPEw.tgs",
    "thumb_url": "https://s.naa.gg/HotCherry/AgADAQADwDZPEw/thumb",
    "thumb": { "width": 128, "height": 128, "file_size": 2750 },
    "silhouette": null
  }]
}
```

`silhouette` is always `null`: the vector outline placeholder (`PhotoPathSize`) only
exists in MTProto, not in the Bot API.

Packs are never mixed (all static, all video or all animated), so the pack-level `format`
is the first sticker's format.

`/packs.json` lists every pack served successfully at least once, newest first:

```jsonc
[{ "name": "HotCherry", "title": "Hot Cherry", "format": "tgs", "sticker_type": "regular",
   "link": "https://t.me/addstickers/HotCherry", "thumb_url": "https://s.naa.gg/HotCherry/thumb", "count": 30 }]
```

`thumb_url` is the pack thumbnail, else the first sticker's thumbnail, else `null`. Each pack
is one KV key `pack:<name>` with the summary in its metadata, written only when the pack is
new or its summary changed (so it stays far below the free 1k writes/day), and the list is a
single KV `list` call.

Errors are JSON `{"error": "..."}`: unknown set/sticker → 404, Telegram rate limit → 503
with `Retry-After`, anything else → 502. The bot token and Telegram file paths never leave
the worker.

## Develop

```sh
bun install
bun run lint        # Biome
bun run typecheck   # tsc
bun test
npx wrangler secret put BOT_TOKEN        # once
npx wrangler kv namespace create PACKS   # once, id goes into wrangler.toml
npx wrangler deploy
```

TGS stickers are passed through as Lottie. To turn them into animated WebP or GIF yourself,
[ThorVG](https://github.com/thorvg/thorvg) renders Lottie (and SVG) and has a WebAssembly build.

## License

[MIT](LICENSE) © Nachtalb
