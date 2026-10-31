export interface Env {
  BOT_TOKEN: string;
  PACKS: KVNamespace;
}

interface KVNamespace {
  getWithMetadata<M>(key: string): Promise<{ value: string | null; metadata: M | null }>;
  put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void>;
  list<M>(opts?: { prefix?: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: M }[]; list_complete: boolean; cursor?: string }>;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

type Tg = Record<string, any>;

const SET = "([A-Za-z0-9_]{1,64})";
// file_unique_id is base64url, so it can contain "-"
const ID = "([A-Za-z0-9_-]{1,64})";
const ROUTES: [RegExp, string][] = [
  [new RegExp(`^/${SET}\\.json$`), "set"],
  [new RegExp(`^/${SET}/thumb(?:\\.(?:webp|jpg|webm))?$`), "setthumb"],
  [new RegExp(`^/${SET}/${ID}/(thumb|premium)(?:\\.(?:webp|jpg|webm))?$`), "sub"],
  [new RegExp(`^/${SET}/${ID}\\.(webp|webm)$`), "file"],
  [new RegExp(`^/${SET}/${ID}$`), "page"],
];

const MIME: Record<string, string> = {
  webp: "image/webp",
  webm: "video/webm",
  jpg: "image/jpeg",
  png: "image/png",
};

const SET_TTL = "public, max-age=3600, stale-while-revalidate=86400";
const FOREVER = "public, max-age=31536000, immutable";

const USAGE = `Telegram sticker proxy

GET /packs.json                 known packs, newest first
GET /<set>.json                 pack info + stickers
GET /<set>/thumb                pack thumbnail
GET /<set>/<id>.<webp|webm>     sticker file (id = file_unique_id)
GET /<set>/<id>/thumb           sticker thumbnail
GET /<set>/<id>/premium         premium animation (if any)
GET /<set>/<id>                 share page

Animated (TGS) packs are not supported.
`;

class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

const cors = { "Access-Control-Allow-Origin": "*" };

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...headers },
  });
}

// packs are never mixed, so the first sticker decides the pack format
export function formatOf(s: Tg): "webp" | "tgs" | "webm" {
  return s.is_video ? "webm" : s.is_animated ? "tgs" : "webp";
}

async function tg(env: Env, method: string, params: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}?${new URLSearchParams(params)}`);
  } catch {
    throw new HttpError(502, "telegram unreachable");
  }
  const body: Tg = await res.json().catch(() => ({}));
  if (body.ok) return body.result;
  if (body.error_code === 429) throw new HttpError(503, "rate limited", body.parameters?.retry_after ?? 30);
  if (method === "getStickerSet" && body.error_code === 400) throw new HttpError(404, "sticker set not found");
  throw new HttpError(502, "telegram error");
}

// Cache API wrapper: returns cached response or builds, stores and returns a fresh one.
// bump to drop everything cached by older deployments
const CACHE_VERSION = "2";

async function cached(key: string, ctx: Ctx, build: () => Promise<Response>): Promise<Response> {
  key += `?v=${CACHE_VERSION}`;
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const hit = await cache?.match(key);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set("X-Cache", "HIT");
    return r;
  }
  const res = await build();
  if (cache && res.ok) ctx.waitUntil(cache.put(key, res.clone()));
  res.headers.set("X-Cache", "MISS");
  return res;
}

async function rawSet(env: Env, ctx: Ctx, origin: string, name: string): Promise<Tg> {
  const res = await cached(`${origin}/__raw/${name.toLowerCase()}`, ctx, async () => {
    const set = await tg(env, "getStickerSet", { name });
    if (formatOf(set.stickers[0] ?? {}) !== "tgs") ctx.waitUntil(remember(env, summary(set, origin)));
    return new Response(JSON.stringify(set), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    });
  });
  const set: Tg = await res.json();
  if (formatOf(set.stickers[0] ?? {}) === "tgs") throw new HttpError(415, "animated (TGS) sticker packs are not supported");
  return set;
}

export function summary(set: Tg, origin: string) {
  const first: Tg = set.stickers[0] ?? {};
  return {
    name: set.name as string,
    title: set.title as string,
    format: formatOf(first),
    sticker_type: set.sticker_type as string,
    link: linkOf(set),
    thumb_url: set.thumbnail
      ? `${origin}/${set.name}/thumb`
      : first.thumbnail
        ? `${origin}/${set.name}/${first.file_unique_id}/thumb`
        : null,
    count: set.stickers.length as number,
  };
}

type Summary = ReturnType<typeof summary> & { added?: number };

// one KV write per new or changed pack; the summary lives in the key metadata so listing needs no gets
export async function remember(env: Env, sum: Summary): Promise<void> {
  const key = `pack:${sum.name.toLowerCase()}`;
  const { metadata: old } = await env.PACKS.getWithMetadata<Summary>(key);
  const added = old?.added ?? Date.now();
  if (old && JSON.stringify({ ...old, added: 0 }) === JSON.stringify({ ...sum, added: 0 })) return;
  const meta = { ...sum, added };
  await env.PACKS.put(key, JSON.stringify(meta), { metadata: meta });
}

async function packs(env: Env): Promise<Summary[]> {
  const out: Summary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PACKS.list<Summary>({ prefix: "pack:", cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (b.added ?? 0) - (a.added ?? 0)).map(({ added, ...p }) => p);
}

const linkOf = (set: Tg) =>
  `https://t.me/${set.sticker_type === "custom_emoji" ? "addemoji" : "addstickers"}/${set.name}`;

export function shapeSet(set: Tg, origin: string) {
  const base = `${origin}/${set.name}`;
  return {
    name: set.name,
    title: set.title,
    format: formatOf(set.stickers[0] ?? {}),
    sticker_type: set.sticker_type,
    link: linkOf(set),
    thumbnail: set.thumbnail ? `${base}/thumb` : null,
    stickers: (set.stickers as Tg[]).map((s) => ({
      id: s.file_unique_id,
      file_unique_id: s.file_unique_id,
      emoji: s.emoji ?? null,
      type: s.type,
      format: formatOf(s),
      is_animated: s.is_animated,
      is_video: s.is_video,
      width: s.width,
      height: s.height,
      file_size: s.file_size ?? null,
      custom_emoji_id: s.custom_emoji_id ?? null,
      premium_animation: s.premium_animation ? `${base}/${s.file_unique_id}/premium` : null,
      mask_position: s.mask_position ?? null,
      needs_repainting: s.needs_repainting ?? false,
      url: `${base}/${s.file_unique_id}.${formatOf(s)}`,
      thumb_url: s.thumbnail ? `${base}/${s.file_unique_id}/thumb` : null,
      thumb: s.thumbnail
        ? { width: s.thumbnail.width, height: s.thumbnail.height, file_size: s.thumbnail.file_size ?? null }
        : null,
      silhouette: null, // MTProto-only (PhotoPathSize), not exposed by the Bot API
    })),
  };
}

async function download(env: Env, fileId: string, type?: string): Promise<Response> {
  const { file_path } = await tg(env, "getFile", { file_id: fileId });
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file_path}`);
  } catch {
    throw new HttpError(502, "telegram unreachable");
  }
  if (!res.ok) throw new HttpError(502, "telegram error");
  const ext = String(file_path).split(".").pop()!.toLowerCase();
  return new Response(res.body, {
    headers: { "Content-Type": type ?? MIME[ext] ?? "application/octet-stream", "Cache-Control": FOREVER, ...cors },
  });
}

function find(set: Tg, id: string): Tg {
  const s = (set.stickers as Tg[]).find((x) => x.file_unique_id === id);
  if (!s) throw new HttpError(404, "sticker not found");
  return s;
}

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(set: ReturnType<typeof shapeSet>, s: ReturnType<typeof shapeSet>["stickers"][number]): string {
  const title = `${s.emoji ?? ""} ${set.title}`.trim();
  const image = s.format === "webp" ? s.url : s.thumb_url ?? s.url;
  const media =
    s.format === "webm"
      ? `<video src="${esc(s.url)}" autoplay loop muted playsinline></video>`
      : `<img src="${esc(s.url)}" alt="${esc(s.emoji ?? "sticker")}">`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="Sticker from ${esc(set.title)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:type" content="website">
<meta name="twitter:card" content="summary"><meta name="twitter:image" content="${esc(image)}">
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#17191c;color:#ddd;font:16px system-ui,sans-serif}img,video{width:256px;height:256px;object-fit:contain}p{margin:.5em}a{color:#6cb6ff}</style>
</head><body>${media}<p style="font-size:2em">${esc(s.emoji ?? "")}</p><p><a href="${esc(set.link)}">${esc(set.title)}</a></p></body></html>`;
}

async function route(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const { origin, pathname } = url;
  const key = origin + pathname;
  if (pathname === "/") return new Response(USAGE, { headers: { "Content-Type": "text/plain; charset=utf-8", ...cors } });
  if (pathname === "/_me")
    return cached(key, ctx, async () =>
      json({ username: (await tg(env, "getMe", {})).username }, 200, { "Cache-Control": SET_TTL }),
    );

  if (pathname === "/packs.json")
    return cached(key, ctx, async () => json(await packs(env), 200, { "Cache-Control": "public, max-age=60" }));

  for (const [re, kind] of ROUTES) {
    const m = pathname.match(re);
    if (!m) continue;
    const [, name, id, arg] = m;

    if (kind === "set")
      return cached(key, ctx, async () =>
        json(shapeSet(await rawSet(env, ctx, origin, name), origin), 200, { "Cache-Control": SET_TTL }),
      );

    if (kind === "setthumb")
      return cached(`${origin}/${name.toLowerCase()}/thumb`, ctx, async () => {
        const set = await rawSet(env, ctx, origin, name);
        if (!set.thumbnail) throw new HttpError(404, "set has no thumbnail");
        // set thumbnails change when the owner edits them, so don't mark immutable
        const r = await download(env, set.thumbnail.file_id);
        r.headers.set("Cache-Control", "public, max-age=86400");
        return r;
      });

    if (kind === "sub")
      return cached(`${origin}/${name}/${id}/${arg}`, ctx, async () => {
        const s = find(await rawSet(env, ctx, origin, name), id);
        const f = arg === "thumb" ? s.thumbnail : s.premium_animation;
        if (!f) throw new HttpError(404, `sticker has no ${arg}`);
        return download(env, f.file_id);
      });

    if (kind === "file")
      return cached(key, ctx, async () => {
        const s = find(await rawSet(env, ctx, origin, name), id);
        const fmt = formatOf(s);
        if (fmt !== arg) throw new HttpError(404, `sticker is ${fmt}, not ${arg}`);
        return download(env, s.file_id, MIME[fmt]);
      });

    if (kind === "page")
      return cached(key, ctx, async () => {
        const set = shapeSet(await rawSet(env, ctx, origin, name), origin);
        const s = set.stickers.find((x) => x.id === id);
        if (!s) throw new HttpError(404, "sticker not found");
        return new Response(page(set, s), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": SET_TTL },
        });
      });
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, HEAD" } });
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError)
        return json({ error: e.message }, e.status, e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {});
      return json({ error: "upstream error" }, 502);
    }
  },
};
