# tg-sticker-proxy

Cloudflare Worker that proxies Telegram sticker packs through the Bot API.
Stickers live only in the Cloudflare edge cache; Workers KV keeps a small summary of
every pack served so far for `/packs.json`. Live at <https://s.naa.gg>.

Packs are never mixed: a pack is all static (`webp`), all video (`webm`) or all animated
(`tgs`). **Animated (TGS) packs are not supported**: `/<set>.json` and every `/<set>/...`
route answer `415 {"error": "animated (TGS) sticker packs are not supported"}`.

## Endpoints

`<set>` matches `^[A-Za-z0-9_]{1,64}$`, `<id>` is the sticker's `file_unique_id`
(`^[A-Za-z0-9_-]{1,64}$`; it's base64url so `-` occurs).

| Route | Returns | Cache |
|---|---|---|
| `GET /` | plain-text usage | – |
| `GET /packs.json` | known packs, newest first (shape below) | 60s |
| `GET /<set>.json` | pack info + all stickers (shape below) | 1h, swr 1d |
| `GET /<set>/thumb` | pack thumbnail (webp/webm, whatever Telegram has) | 1d |
| `GET /<set>/<id>.<webp\|webm>` | sticker file; wrong extension → 404 | immutable |
| `GET /<set>/<id>/thumb` | sticker thumbnail (`.webp`/`.jpg` suffix accepted) | immutable |
| `GET /<set>/<id>/premium` | premium animation, if the sticker has one | immutable |
| `GET /<set>/<id>` | small HTML share page with OpenGraph preview | 1h |
| `GET /_me` | `{username}` of the bot (health check) | 1h |

All GET responses send `Access-Control-Allow-Origin: *` and `X-Cache: HIT|MISS`.

```jsonc
{
  "name": "Animals", "title": "Animals", "format": "webp",           // webp | webm
  "sticker_type": "regular",                                         // regular | mask | custom_emoji
  "link": "https://t.me/addstickers/Animals",                        // addemoji for custom_emoji
  "thumbnail": "https://s.naa.gg/Animals/thumb",                     // or null
  "stickers": [{
    "id": "AgADAQADwDZPEw", "file_unique_id": "AgADAQADwDZPEw",
    "emoji": "😂", "type": "regular", "format": "webp",              // same as the pack
    "is_animated": false, "is_video": false, "width": 512, "height": 512, "file_size": 8244,
    "custom_emoji_id": null, "premium_animation": null, "mask_position": null, "needs_repainting": false,
    "url": "https://s.naa.gg/Animals/AgADAQADwDZPEw.webp",
    "thumb_url": "https://s.naa.gg/Animals/AgADAQADwDZPEw/thumb",
    "thumb": { "width": 128, "height": 128, "file_size": 2750 },
    "silhouette": null
  }]
}
```

`silhouette` is always `null`: the vector outline placeholder (`PhotoPathSize`) only
exists in MTProto, not in the Bot API.

`/packs.json` lists every pack served successfully at least once (TGS never), newest first:

```jsonc
[{ "name": "Animals", "title": "Animals", "format": "webp", "sticker_type": "regular",
   "link": "https://t.me/addstickers/Animals", "thumb_url": "https://s.naa.gg/Animals/thumb", "count": 30 }]
```

`thumb_url` is the pack thumbnail, else the first sticker's thumbnail, else `null`. Each pack
is one KV key `pack:<name>` with the summary in its metadata, written only when the pack is
new or its summary changed (so it stays far below the free 1k writes/day), and the list is a
single KV `list` call.

Errors are JSON `{"error": "..."}`: unknown set/sticker → 404, TGS pack → 415, Telegram rate limit → 503
with `Retry-After`, anything else → 502. The bot token and Telegram file paths never leave
the worker.

## Develop

```sh
bun install
bun test
npx wrangler secret put BOT_TOKEN   # once
npx wrangler kv namespace create PACKS   # once, id goes into wrangler.toml
npx wrangler deploy
```
