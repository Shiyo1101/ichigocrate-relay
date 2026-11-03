import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";

import { MAX_MESSAGE_BYTES, NAME_PATTERN } from "./limits";

export { Room } from "./room";

type AppEnv = {
  Bindings: Env;
  Variables: { room: string; box: string };
};

const app = new Hono<AppEnv>();

const USAGE = `ichigocrate-relay
POST /r/<ROOM>/<BOX>  push a message (<= ${MAX_MESSAGE_BYTES} bytes) to BOX
GET  /r/<ROOM>/<BOX>  pop the oldest message from BOX (empty if none)
`;

// web 版の ichigocrate は必ず X-Ichigocrate ヘッダを付けて CORS の事前確認を経由する
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["X-Ichigocrate", "Content-Type"],
    maxAge: 600,
  }),
);

app.get("/", (c) => c.text(USAGE));

const MESSAGE_ROUTE = "/r/:room/:box";

// 名前の検査と回数制限。名前は大文字にそろえる (IchigoJam は既定で大文字入力)
app.use(MESSAGE_ROUTE, async (c, next) => {
  const room = c.req.param("room");
  const box = c.req.param("box");
  if (!NAME_PATTERN.test(room) || !NAME_PATTERN.test(box)) {
    return c.text("BAD NAME\n", 400);
  }
  c.set("room", room.toUpperCase());
  c.set("box", box.toUpperCase());

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.RATE_LIMITER.limit({ key: `${ip}:${c.get("room")}` });
  if (!success) {
    return c.text("TOO MANY REQUESTS\n", 429);
  }
  await next();
});

app.post(
  MESSAGE_ROUTE,
  bodyLimit({
    maxSize: MAX_MESSAGE_BYTES,
    onError: (c) => c.text("TOO LARGE\n", 413),
  }),
  async (c) => {
    const body = await c.req.arrayBuffer();
    // 空のメッセージは「まだ届いていない」と区別できないので受け付けない
    if (body.byteLength === 0) {
      return c.text("EMPTY\n", 400);
    }
    const pushed = await c.env.ROOMS.getByName(c.get("room")).push(c.get("box"), body);
    if (!pushed) {
      return c.text("BOX FULL\n", 409);
    }
    return c.body(null, 204);
  },
);

app.get(MESSAGE_ROUTE, async (c) => {
  const message = await c.env.ROOMS.getByName(c.get("room")).pop(c.get("box"));
  // 空なら 0 バイトの本文 (ichigocrate では NET()=0 で「まだ届いていない」とわかる)
  return c.body(message ?? new ArrayBuffer(0), 200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
  });
});

export default app;
