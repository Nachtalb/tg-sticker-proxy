# tg-sticker-proxy

Stateless Cloudflare Worker that proxies Telegram sticker packs through the Bot API.
Nothing is stored except the Cloudflare edge cache. Live at <https://s.naa.gg>.

## Endpoints

`<set>` matches `^[A-Za-z0-9_]{1,64}$`, `<id>` is the sticker's `file_unique_id`
(`^[A-Za-z0-9_-]{1,64}$`; it's base64url so `-` occurs).

| Route | Returns | Cache |
|---|---|---|
| `GET /` | plain-text usage | – |
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
  "name": "HotCherry", "title": "Hot Cherry", "sticker_type": "regular", // regular | mask | custom_emoji
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

Errors are JSON `{"error": "..."}`: unknown set/sticker → 404, Telegram rate limit → 503
with `Retry-After`, anything else → 502. The bot token and Telegram file paths never leave
the worker.

## Develop

```sh
bun install
bun test
npx wrangler secret put BOT_TOKEN   # once
npx wrangler deploy
```
