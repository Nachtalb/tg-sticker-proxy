import { beforeEach, expect, test } from "bun:test";
import worker from "./index";

const SET = {
  name: "TestPack",
  title: "Test Pack",
  sticker_type: "regular",
  thumbnail: { file_id: "setthumb", file_unique_id: "st", width: 100, height: 100 },
  stickers: [
    {
      file_id: "f1",
      file_unique_id: "AgAD-1",
      type: "regular",
      is_animated: false,
      is_video: false,
      width: 512,
      height: 512,
      emoji: "😀",
      file_size: 10,
      thumbnail: { file_id: "t1", width: 128, height: 128 },
    },
    {
      file_id: "f2",
      file_unique_id: "AgAD2",
      type: "regular",
      is_animated: false,
      is_video: false,
      width: 512,
      height: 512,
      emoji: "🔥",
    },
  ],
};
const VIDEO = {
  ...SET,
  name: "VidPack",
  thumbnail: undefined,
  stickers: [
    {
      file_id: "f3",
      file_unique_id: "AgAD3",
      type: "regular",
      is_animated: false,
      is_video: true,
      width: 512,
      height: 512,
      emoji: "🎬",
      thumbnail: { file_id: "t3" },
    },
  ],
};
const TGS = { ...SET, name: "TgsPack", stickers: [{ ...SET.stickers[0], is_animated: true }] };

class FakeKV {
  m = new Map<string, { value: string; metadata: any }>();
  writes = 0;
  async getWithMetadata(k: string) {
    const e = this.m.get(k);
    return { value: e?.value ?? null, metadata: e?.metadata ?? null };
  }
  async put(k: string, value: string, o: any = {}) {
    this.writes++;
    this.m.set(k, { value, metadata: o.metadata });
  }
  async list({ prefix = "" } = {}) {
    const keys = [...this.m]
      .filter(([k]) => k.startsWith(prefix))
      .sort()
      .map(([name, e]) => ({ name, metadata: e.metadata }));
    return { keys, list_complete: true };
  }
}

let tgResponse: any;
const calls: string[] = [];
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
let env: any;
const settle = () => Promise.all(pending.splice(0));

beforeEach(() => {
  calls.length = 0;
  tgResponse = { ok: true, result: SET };
  env = { BOT_TOKEN: "SECRET", PACKS: new FakeKV() };
  (globalThis as any).caches = undefined;
  globalThis.fetch = (async (u: string) => {
    calls.push(u);
    if (u.includes("/getStickerSet")) {
      const name = new URL(u).searchParams.get("name");
      if (tgResponse.ok)
        return Response.json({ ok: true, result: { VidPack: VIDEO, TgsPack: TGS }[name ?? ""] ?? tgResponse.result });
      return Response.json(tgResponse);
    }
    if (u.includes("/getFile")) return Response.json({ ok: true, result: { file_path: "stickers/file_1.tgs" } });
    if (u.includes("/file/bot")) return new Response(Buffer.from(Bun.gzipSync('{"v":"5"}')));
    throw new Error(`unexpected ${u}`);
  }) as any;
});

const get = (p: string) => worker.fetch(new Request(`https://s.example${p}`), env, ctx);

test("set json shape", async () => {
  const r = await get("/TestPack.json");
  expect(r.status).toBe(200);
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  const j: any = await r.json();
  expect(j.link).toBe("https://t.me/addstickers/TestPack");
  expect(j.thumbnail).toBe("https://s.example/TestPack/thumb");
  expect(j.format).toBe("webp");
  expect(j.stickers.map((s: any) => s.format)).toEqual(["webp", "webp"]);
  expect(j.stickers[0]).toMatchObject({
    id: "AgAD-1",
    url: "https://s.example/TestPack/AgAD-1.webp",
    thumb_url: "https://s.example/TestPack/AgAD-1/thumb",
    silhouette: null,
    mask_position: null,
    premium_animation: null,
  });
  expect(JSON.stringify(j)).not.toContain("f1"); // no bot-specific file_id
});

test("custom emoji link", async () => {
  tgResponse = { ok: true, result: { ...SET, sticker_type: "custom_emoji" } };
  const j: any = await (await get("/TestPack.json")).json();
  expect(j.link).toBe("https://t.me/addemoji/TestPack");
});

test("validation and unknown routes", async () => {
  expect((await get("/bad-name.json")).status).toBe(404);
  expect((await get("/TestPack/AgAD2.png")).status).toBe(404);
  expect(calls.length).toBe(0);
});

test("errors", async () => {
  tgResponse = { ok: false, error_code: 400, description: "Bad Request: STICKERSET_INVALID" };
  let r = await get("/Nope.json");
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: "sticker set not found" });
  tgResponse = { ok: false, error_code: 429, parameters: { retry_after: 7 } };
  r = await get("/Nope.json");
  expect(r.status).toBe(503);
  expect(r.headers.get("retry-after")).toBe("7");
  tgResponse = { ok: false, error_code: 500, description: "oops" };
  r = await get("/Nope.json");
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain("SECRET");
});

test("file with wrong extension is 404", async () => {
  expect((await get("/TestPack/AgAD2.webm")).status).toBe(404);
  expect((await get("/TestPack/AgAD-1.json")).status).toBe(404);
  expect((await get("/TestPack/AgAD-1.tgs")).status).toBe(404);
  expect((await get("/TestPack/AgAD-1.png")).status).toBe(404);
  expect((await get("/TestPack/missing.webp")).status).toBe(404);
});

test("webm file", async () => {
  const r = await get("/VidPack/AgAD3.webm");
  expect(r.headers.get("content-type")).toBe("video/webm");
  expect(r.headers.get("cache-control")).toContain("immutable");
});

test("tgs file, lottie json and share page", async () => {
  expect(((await (await get("/TgsPack.json")).json()) as any).format).toBe("tgs");
  const r = await get("/TgsPack/AgAD-1.tgs");
  expect(r.headers.get("content-type")).toBe("application/x-tgsticker");
  expect(r.headers.get("cache-control")).toContain("immutable");
  expect(await (await get("/TgsPack/AgAD-1.json")).json()).toEqual({ v: "5" });
  expect(await (await get("/TgsPack/AgAD-1")).text()).toContain('path:"https://s.example/TgsPack/AgAD-1.json"');
  await settle();
  const j: any = await (await get("/packs.json")).json();
  expect(j.map((p: any) => [p.name, p.format])).toEqual([["TgsPack", "tgs"]]);
});

test("packs list: newest first, one write per new or changed pack", async () => {
  await get("/TestPack.json");
  await settle();
  await get("/VidPack/AgAD3");
  await settle();
  await get("/TestPack.json"); // unchanged -> no write
  await settle();
  expect(env.PACKS.writes).toBe(2);
  const old = env.PACKS.m.get("pack:testpack").metadata;
  env.PACKS.m.get("pack:testpack").metadata = { ...old, added: 1 };
  const j: any = await (await get("/packs.json")).json();
  expect(j.map((p: any) => p.name)).toEqual(["VidPack", "TestPack"]);
  expect(j[0]).toEqual({
    name: "VidPack",
    title: "Test Pack",
    format: "webm",
    sticker_type: "regular",
    link: "https://t.me/addstickers/VidPack",
    thumb_url: "https://s.example/VidPack/AgAD3/thumb",
    count: 1,
  });
  expect(j[1].thumb_url).toBe("https://s.example/TestPack/thumb");
  tgResponse = { ok: true, result: { ...SET, title: "Renamed" } };
  await get("/TestPack.json");
  await settle();
  expect(env.PACKS.writes).toBe(3);
  expect(env.PACKS.m.get("pack:testpack").metadata).toMatchObject({ title: "Renamed", added: 1 });
});

test("share page", async () => {
  const r = await get("/VidPack/AgAD3");
  const html = await r.text();
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(html).toContain("<video");
  expect(html).toContain('og:image" content="https://s.example/VidPack/AgAD3/thumb');
});
