import { beforeEach, expect, test } from "bun:test";
import worker from "./index";

const SET = {
  name: "TestPack",
  title: "Test Pack",
  sticker_type: "regular",
  thumbnail: { file_id: "setthumb", file_unique_id: "st", width: 100, height: 100 },
  stickers: [
    { file_id: "f1", file_unique_id: "AgAD-1", type: "regular", is_animated: false, is_video: false, width: 512, height: 512, emoji: "😀", file_size: 10, thumbnail: { file_id: "t1", width: 128, height: 128 } },
    { file_id: "f2", file_unique_id: "AgAD2", type: "regular", is_animated: true, is_video: false, width: 512, height: 512, emoji: "🔥" },
    { file_id: "f3", file_unique_id: "AgAD3", type: "regular", is_animated: false, is_video: true, width: 512, height: 512, emoji: "🎬" },
  ],
};

let tgResponse: any;
const calls: string[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void p };
const env = { BOT_TOKEN: "SECRET" };

beforeEach(() => {
  calls.length = 0;
  tgResponse = { ok: true, result: SET };
  (globalThis as any).caches = undefined;
  globalThis.fetch = (async (u: string) => {
    calls.push(u);
    if (u.includes("/getStickerSet")) return Response.json(tgResponse);
    if (u.includes("/getFile")) return Response.json({ ok: true, result: { file_path: "stickers/file_1.tgs" } });
    if (u.includes("/file/bot")) return new Response(Bun.gzipSync(new TextEncoder().encode('{"v":"5"}')));
    throw new Error("unexpected " + u);
  }) as any;
});

const get = (p: string) => worker.fetch(new Request("https://s.example" + p), env, ctx);

test("set json shape", async () => {
  const r = await get("/TestPack.json");
  expect(r.status).toBe(200);
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  const j: any = await r.json();
  expect(j.link).toBe("https://t.me/addstickers/TestPack");
  expect(j.thumbnail).toBe("https://s.example/TestPack/thumb");
  expect(j.stickers.map((s: any) => s.format)).toEqual(["webp", "tgs", "webm"]);
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
  expect((await get("/TestPack/AgAD2.webp")).status).toBe(404);
  expect((await get("/TestPack/AgAD-1.json")).status).toBe(404);
  expect((await get("/TestPack/missing.webp")).status).toBe(404);
});

test("tgs file and lottie json", async () => {
  const r = await get("/TestPack/AgAD2.tgs");
  expect(r.headers.get("content-type")).toBe("application/x-tgsticker");
  expect(r.headers.get("cache-control")).toContain("immutable");
  const j = await get("/TestPack/AgAD2.json");
  expect(await j.json()).toEqual({ v: "5" });
});

test("share page", async () => {
  const r = await get("/TestPack/AgAD3");
  const html = await r.text();
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(html).toContain("<video");
  expect(html).toContain('og:image" content="https://s.example/TestPack/AgAD3.webm');
});
