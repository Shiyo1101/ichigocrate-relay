import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAX_MESSAGE_BYTES, MAX_QUEUED_MESSAGES } from "../src/limits";

const BASE = "https://relay.example";

/** テストごとに別の部屋を使う (状態を持ち越さないように)。 */
let roomCounter = 0;
function newRoom(): string {
  roomCounter += 1;
  return `T${roomCounter}`;
}

function post(path: string, body: BodyInit, ip = "203.0.113.1"): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/octet-stream", "cf-connecting-ip": ip },
  });
}

function get(path: string, ip = "203.0.113.1"): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { "cf-connecting-ip": ip } });
}

async function bytes(response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())];
}

/** 応答の本文を ASCII 文字列として読む (本文の種類はバイト列なので .text() は使わない)。 */
async function ascii(response: Response): Promise<string> {
  return new TextDecoder("ascii").decode(await response.arrayBuffer());
}

describe("受信箱", () => {
  it("積んだメッセージを古い順に 1 件ずつ取り出し、空なら 0 バイトを返す", async () => {
    const room = newRoom();
    expect((await post(`/r/${room}/A`, "D3")).status).toBe(204);
    expect((await post(`/r/${room}/A`, "E4")).status).toBe(204);

    const first = await get(`/r/${room}/A`);
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(await ascii(first)).toBe("D3");
    expect(await ascii(await get(`/r/${room}/A`))).toBe("E4");

    const empty = await get(`/r/${room}/A`);
    expect(empty.status).toBe(200);
    expect(await bytes(empty)).toEqual([]);
  });

  it("本文はバイト列のまま扱う (0 や 255 も含められる)", async () => {
    const room = newRoom();
    await post(`/r/${room}/A`, new Uint8Array([1, 0, 34, 255]));
    expect(await bytes(await get(`/r/${room}/A`))).toEqual([1, 0, 34, 255]);
  });

  it("受信箱・部屋ごとに分かれていて、名前の大文字小文字は区別しない", async () => {
    const room = newRoom();
    const other = newRoom();
    await post(`/r/${room}/a`, "TO A");
    await post(`/r/${room}/B`, "TO B");
    await post(`/r/${other}/A`, "OTHER");
    expect(await ascii(await get(`/r/${room}/B`))).toBe("TO B");
    expect(await ascii(await get(`/r/${room.toLowerCase()}/A`))).toBe("TO A");
    expect(await ascii(await get(`/r/${other}/A`))).toBe("OTHER");
  });

  it(`受信箱には ${MAX_QUEUED_MESSAGES} 件まで積め、それを超えると 409`, async () => {
    const room = newRoom();
    for (let i = 0; i < MAX_QUEUED_MESSAGES; i += 1) {
      expect((await post(`/r/${room}/A`, `M${i}`)).status).toBe(204);
    }
    expect((await post(`/r/${room}/A`, "OVER")).status).toBe(409);
    // 取り出せば空きができる
    await get(`/r/${room}/A`);
    expect((await post(`/r/${room}/A`, "AGAIN")).status).toBe(204);
  });

  it("期限が来ると部屋の中身が消える", async () => {
    const room = newRoom();
    await post(`/r/${room}/A`, "OLD");
    const stub = env.ROOMS.getByName(room);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await bytes(await get(`/r/${room}/A`))).toEqual([]);
  });

  it("期限で消えたあとも、同じ部屋を続けて使える", async () => {
    const room = newRoom();
    await post(`/r/${room}/A`, "OLD");
    await runDurableObjectAlarm(env.ROOMS.getByName(room));
    expect((await post(`/r/${room}/A`, "NEW")).status).toBe(204);
    expect(await ascii(await get(`/r/${room}/A`))).toBe("NEW");
  });

  it("読むだけの問い合わせでは何も保存せず、期限も設定しない", async () => {
    const room = newRoom();
    await get(`/r/${room}/A`);
    expect(await runDurableObjectAlarm(env.ROOMS.getByName(room))).toBe(false);
  });
});

describe("入力の検査", () => {
  it(`本文が ${MAX_MESSAGE_BYTES} バイトを超えると 413、空なら 400`, async () => {
    const room = newRoom();
    expect((await post(`/r/${room}/A`, new Uint8Array(MAX_MESSAGE_BYTES))).status).toBe(204);
    expect((await post(`/r/${room}/A`, new Uint8Array(MAX_MESSAGE_BYTES + 1))).status).toBe(413);
    expect((await post(`/r/${room}/A`, new Uint8Array(0))).status).toBe(400);
  });

  it("使えない文字や長すぎる名前は 400", async () => {
    const paths = ["/r/A.B/C", "/r/ROOM/%20", `/r/${"X".repeat(33)}/A`];
    const statuses = await Promise.all(paths.map(async (path) => (await get(path)).status));
    expect(statuses).toEqual([400, 400, 400]);
  });

  it("経路が違えば 404", async () => {
    expect((await get("/r/ROOM")).status).toBe(404);
    expect((await get("/x/ROOM/A")).status).toBe(404);
  });
});

describe("CORS と回数制限", () => {
  it("web 版の事前確認 (X-Ichigocrate・Content-Type) を許可する", async () => {
    const response = await SELF.fetch(`${BASE}/r/ROOM/A`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-ichigocrate,content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const allowed = response.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowed).toContain("X-Ichigocrate");
    expect(allowed).toContain("Content-Type");
  });

  it("同じ IP・同じ部屋からの問い合わせが多すぎると 429 (別の IP は数えない)", async () => {
    const room = newRoom();
    const statuses: number[] = [];
    for (let i = 0; i < 130; i += 1) {
      statuses.push((await get(`/r/${room}/A`, "198.51.100.7")).status);
    }
    expect(statuses).toContain(429);
    expect((await get(`/r/${room}/A`, "198.51.100.8")).status).toBe(200);
  });
});

describe("使い方", () => {
  it("/ で使い方を返す", async () => {
    expect(await ascii(await get("/"))).toContain("POST /r/<ROOM>/<BOX>");
  });
});
